"""Analysis/measurement primitives: ffmpeg/ffprobe-backed loudness
measurement, DAT-defect detection, and small filename/folder helpers shared
by diagnose, DSP planning, and rendering alike. Moved out of
audio_process.py 2026-08-22 verbatim.
"""
import json
import os
import re
import subprocess

import clipcheck  # second-tier run-length clipping check (same dir)

from engine_constants import ARTIST_TARGET, TP_CEILING


def ff_err(args):
    return subprocess.run(["ffmpeg", "-hide_banner"] + args,
                          capture_output=True, text=True).stderr


def lossless_files(folder):
    return sorted(f for f in os.listdir(folder) if f.lower().endswith((".flac", ".wav")))


def mp3_sources(folder):
    return sorted(f for f in os.listdir(folder) if f.lower().endswith(".mp3"))


def lead_num(name):
    m = re.match(r"\s*(\d+)", os.path.basename(name))
    return int(m.group(1)) if m else None


def preflight_track_files(files):
    """Reject a batch before any rendering happens rather than let it corrupt
    output silently: a missing leading track number, or two files sharing one
    (e.g. a stray WAV export left alongside its FLAC), both collide on the
    same out_mp3 filename and the same provenance key (str(num)) — the second
    file processed would silently overwrite the first's audio and provenance
    entry."""
    missing = [f for f in files if lead_num(f) is None]
    if missing:
        raise SystemExit("no leading track number in: " + ", ".join(missing))

    by_num = {}
    for f in files:
        by_num.setdefault(lead_num(f), []).append(f)
    dupe_nums = {n: fs for n, fs in by_num.items() if len(fs) > 1}
    if dupe_nums:
        detail = "; ".join(f"{n}: {', '.join(fs)}" for n, fs in sorted(dupe_nums.items()))
        raise SystemExit(f"duplicate track number(s) — {detail}")


def probe(path):
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams",
         "-show_format", path], capture_output=True, text=True)
    j = json.loads(r.stdout)
    st = j["streams"][0]
    bits = st.get("bits_per_raw_sample")
    if not bits and st.get("sample_fmt") == "s32":
        bits = "24"
    return {
        "sr": st.get("sample_rate"),
        "ch": int(st.get("channels", 0)),
        "bits": bits or st.get("bits_per_sample"),
        "sample_fmt": st.get("sample_fmt"),
        "dur": float(j["format"]["duration"]),
    }


def measure(path, target, pre=""):
    # `pre` is an optional filter chain (e.g. corrective EQ) applied BEFORE the
    # loudnorm analysis. When processing prepends an EQ, loudnorm must be measured
    # on the post-EQ signal, or the gain calc is wrong and the output drifts off
    # target (the EQ changes the loudness it's normalizing).
    af = ((pre + ",") if pre else "") + \
        f"loudnorm=I={target}:LRA=11:TP={TP_CEILING}:print_format=json"
    err = ff_err(["-i", path, "-af", af, "-f", "null", "-"])
    return json.loads(re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", err, re.S).group(0))


def max_short_term_momentary(path):
    """Peak of the 3s short-term (S) and 400ms momentary (M) loudness curves,
    via one ebur128 analysis pass. Two full-track tracks can share the same
    integrated loudness (and pass the same QA gates) while one has a much
    hotter chorus or a long loud passage the integrated average smooths
    over — this is what actually predicts 'sounds louder in a playlist',
    which integrated loudness alone can miss (v6)."""
    err = ff_err(["-i", path, "-af", "ebur128", "-f", "null", "-"])
    ms = [float(x) for x in re.findall(r"\bM:\s*(-?[\d.]+)", err)]
    ss = [float(x) for x in re.findall(r"\bS:\s*(-?[\d.]+)", err)]
    return (round(max(ms), 1) if ms else None, round(max(ss), 1) if ss else None)


def astats_field(path, field):
    err = ff_err(["-i", path, "-af", "astats=measure_perchannel=0", "-f", "null", "-"])
    m = re.search(rf"{re.escape(field)}:\s*([-\d.]+|inf|-inf)", err)
    return m.group(1) if m else None


def astats_channels(path):
    """One astats pass: per-channel RMS (dB) plus overall peak and DC offset."""
    err = ff_err(["-i", path, "-af", "astats", "-f", "null", "-"])
    section, rms, peak, dc = None, [], None, None
    for line in err.splitlines():
        if re.search(r"Channel:\s*\d+", line):
            section = "ch"
        elif "Overall" in line:
            section = "all"
        m = re.search(r"RMS level dB:\s*([-\d.]+|-inf|inf)", line)
        if m and section == "ch":
            rms.append(float(m.group(1)) if "inf" not in m.group(1) else None)
        if section == "all":
            m = re.search(r"Peak level dB:\s*([-\d.]+|inf|-inf)", line)
            if m:
                peak = m.group(1)
            m = re.search(r"DC offset:\s*([-\d.]+)", line)
            if m:
                dc = m.group(1)
    return rms, peak, dc


def fmt_ts(sec):
    m, s = divmod(sec, 60)
    return f"{int(m)}:{s:06.3f}"


def defect_scan(path, sr, ch, min_ms=2.0, edge_s=2.0):
    """DAT-defect detector, one decode pass. Returns (dropouts, clicks):

    dropouts — [(time_s, run_ms)]: runs of IDENTICAL sample values (any level,
    including digital zero) of >= min_ms, ignoring edge_s at each end where
    fades legitimately sit at zero. Error concealment on a failing DAT holds
    or mutes samples — a different defect from clipping, which only lives at
    full scale. Skip-sampled for speed; runs are confirmed exactly.

    clicks — [(time_s, step, ratio)]: single-sample spikes and waveform
    discontinuities (corrupted samples / skipped samples). Candidates come
    from a per-window ffmpeg astats Max_difference pass (C speed); each is
    then confirmed in Python against its local context — a step is a defect
    when it dwarfs the surrounding RMS, which separates digital clicks from
    legitimate transients like claps (loud surroundings -> low ratio)."""
    a = clipcheck.decode_f32(path)
    n = len(a) // ch

    dropouts = []
    N = max(32, int(sr * min_ms / 1000))
    M = max(16, N // 3)
    for c in range(ch):
        s = a[c::ch]
        lo, hi = int(edge_s * sr), n - int(edge_s * sr)
        p = lo
        while p < hi - M:
            if s[p] == s[p + M]:
                v, j, k = s[p], p, p + M
                while j > lo and s[j - 1] == v:
                    j -= 1
                while k < hi - 1 and s[k + 1] == v:
                    k += 1
                run = k - j + 1
                if run >= N and s[j:k + 1].count(v) == run:
                    dropouts.append((j / sr, round(run * 1000 / sr, 1)))
                p = k + M
            else:
                p += M
    dropouts.sort()

    # click/discontinuity candidates: windowed max sample-to-sample difference
    win = 512
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path,
         "-af", f"asetnsamples=n={win},astats=metadata=1:reset=1,"
                "ametadata=mode=print:key=lavfi.astats.Overall.Max_difference:file=-",
         "-f", "null", "-"], capture_output=True, text=True)
    cands, t = [], None
    for line in r.stdout.splitlines():
        m = re.search(r"pts_time:([\d.]+)", line)
        if m:
            t = float(m.group(1))
        m = re.search(r"Max_difference=([\d.eE+-]+)", line)
        if m and t is not None and float(m.group(1)) > 0.18:
            cands.append(t)

    # Confirmation thresholds, calibrated on 34 real audience tracks
    # (2026-07-10): raw step size is useless there — loud strums/claps hit
    # sample steps of 0.6-1.1 routinely, and a lone clap in a quiet moment
    # reached 18.9x its surroundings. So: a SPIKE only counts when it dwarfs
    # its context by >= 25x (context excludes the defect itself), and a
    # SPLICE (skipped samples / hold offset) is detected by the DC mean-shift
    # between the audio before and after the step — claps are pure AC and
    # can't shift the mean. Clicks buried in loud music stay undetectable
    # statistically (and are masked anyway).
    clicks = []
    chans = [a[c::ch] for c in range(ch)]
    # splice mean-shift windows must exceed a bass period (30 ms covers 33 Hz
    # and up) or low-frequency phase reads as a DC jump — 17 false splices on
    # the calibration tracks came from 5 ms windows straddling bass notes
    ctx, guard, half = int(0.05 * sr), int(0.002 * sr), int(0.030 * sr)
    for t in cands:
        w0, w1 = int(t * sr), min(n - 1, int(t * sr) + win + 1)
        for s in chans:
            best, bi = 0.0, None
            for i in range(max(1, w0), w1):
                d = abs(s[i] - s[i - 1])
                if d > best:
                    best, bi = d, i
            if bi is None or best < 0.18:
                continue
            seg = (list(s[max(0, bi - ctx):max(0, bi - guard)])
                   + list(s[bi + guard:min(n, bi + ctx)]))
            rms = (sum(x * x for x in seg) / max(len(seg), 1)) ** 0.5
            ratio = best / max(rms, 1e-9)
            pre = s[max(0, bi - half):bi]
            post = s[bi:min(n, bi + half)]
            shift = abs(sum(post) / max(len(post), 1) - sum(pre) / max(len(pre), 1))
            if ratio >= 25:
                clicks.append((bi / sr, round(best, 2), round(ratio, 1), "spike"))
            elif shift > 0.08:
                clicks.append((bi / sr, round(best, 2), round(shift, 2), "splice"))
    # de-dup events within 5 ms of each other (stereo pairs, window overlaps)
    clicks.sort()
    deduped = []
    for e in clicks:
        if not deduped or e[0] - deduped[-1][0] > 0.005:
            deduped.append(e)
    return dropouts, deduped


def mean_vol(path, af):
    err = ff_err(["-i", path, "-af", af + ",volumedetect", "-f", "null", "-"])
    m = re.search(r"mean_volume:\s*([-\d.]+) dB", err)
    return float(m.group(1)) if m else None


def fmt_dur(s):
    return f"{int(s) // 60}:{int(round(s)) % 60:02d}"


def target_for(artist, override):
    if override is not None:
        return override
    if artist in ARTIST_TARGET:
        return ARTIST_TARGET[artist]
    raise SystemExit("Pass --target (no/unknown --artist; expected jerry/sean/seanjerry/mad)")
