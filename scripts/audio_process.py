#!/usr/bin/env python3
"""Committed engine for the AUDIO_PROCESSING.md workflow.

Replaces the previously ad-hoc, re-typed-each-run scripts so Phase 1/2 are a
versioned, reproducible tool. The doc remains the how/why; this is the what.

Subcommands
-----------
  diagnose <input-folder> [--artist ID] [--target LUFS]
      Phase 1. Probe every lossless file (loudness, peak, dynamics, DC, stereo,
      predicted true peak at target) and run the second-tier clipping check
      (clipcheck.py) on any file whose peak reaches full scale. MP3 sources are
      reported and skipped (lossless-only rule). Writes diagnostic_report.txt.

  process <input-folder> <output-folder> --target LUFS [--hpf] [--lpf] [--notch]
          [--slug SLUG]
      Phase 2. Two-pass loudnorm to target / -1 dBTP, output mirrors the input
      container, plus a derived 320k MP3 and an audio MD5 per track. Re-measures
      the output (Pass 3) and VERIFIES it (flags TP over ceiling or LUFS drift).
      Resumable: skips tracks whose outputs already exist. With --slug, writes
      the provenance sidecar to data/processing/<slug>.json.

  verify <slug> [--drive "gdrive:.../Processed"]
      Re-read each track's published copy (R2, and Drive if given), recompute the
      audio MD5, and confirm it matches the provenance sidecar — closing the
      integrity / drift-detection loop.

Lossless-only, per the workflow: only *.flac / *.wav are processed; the served
MP3 is always derived from the processed lossless master.
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys

import clipcheck  # second-tier run-length clipping check (same dir)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUCKET = "r2:hannan-audio"
ARTIST_TARGET = {"jerry": -20, "sean": -20, "seanjerry": -20, "mad": -20}
TP_CEILING = -1.0
TP_TOL = 0.1      # warn if achieved TP exceeds the ceiling by more than this
LUFS_TOL = 0.5    # warn if achieved LUFS drifts from target by more than this

# ── workflow versioning ───────────────────────────────────────────────────────
# Bump WORKFLOW_VERSION whenever the processing *functionality* changes (a new
# filter option, a limiter, different target logic, …) and add a registry entry
# describing it. Each processed track records its `ver` and the literal `chain`
# applied, so you can later tell exactly which workflow generation — and which
# concrete processes — touched any given track (even a single track of a show
# re-run later with a newer version). The registry is the human-readable decode
# of a version number; the per-track `chain` is the self-contained ground truth;
# the `md5` proves the live audio is that exact output.
WORKFLOW_VERSION = 3
WORKFLOW_VERSIONS = {
    1: {
        "desc": "Two-pass ffmpeg loudnorm to the per-artist target "
                "(all artists -20 LUFS; Mad moved -16 -> -20 after A/B testing showed "
                "-16 forced non-linear processing on band masters with no audible gain), "
                "-1 dBTP ceiling, linear; "
                "optional high-pass 80 Hz / low-pass 18 kHz / 60 Hz hum notch; a 320k "
                "MP3 derived from the processed lossless master. Recommend-only: no "
                "automatic limiter/compressor/denoise.",
        "loudnorm": "I=<target>:LRA=11:TP=-1:linear=true",
        "targets": dict(ARTIST_TARGET),
        "optional_filters": ["highpass=f=80", "lowpass=f=18000", "60Hz notch"],
    },
    2: {
        "desc": "As v1, plus an optional literal corrective-EQ chain via --eq "
                "(prepended before loudnorm) for restoring poor source recordings "
                "(e.g. de-mud + presence + air shelf on a muffled tape). The exact "
                "EQ is recorded in each track's `chain`; only tracks processed with "
                "--eq differ from v1. Still recommend-only (no auto compressor/limiter).",
        "loudnorm": "I=<target>:LRA=11:TP=-1:linear=true",
        "targets": dict(ARTIST_TARGET),
        "optional_filters": ["--eq <literal ffmpeg filter chain>", "highpass=f=80",
                             "lowpass=f=18000", "60Hz notch"],
    },
    3: {
        "desc": "As v2 (audio processing unchanged), plus: embedded metadata tags "
                "(title/artist/album/track/date/comment from recordings.json) written "
                "into both the FLAC master and the MP3, and a true-peak measurement "
                "of the encoded MP3 (lossy encoding overshoots peaks; warn above "
                "0 dBTP, recorded per-track as mp3_tp). `retag` retro-fits tags onto "
                "already-published shows via a container rewrite (-c copy) that "
                "leaves the audio stream — and therefore the provenance MD5 — intact.",
        "loudnorm": "I=<target>:LRA=11:TP=-1:linear=true",
        "targets": dict(ARTIST_TARGET),
        "optional_filters": ["--eq <literal ffmpeg filter chain>", "highpass=f=80",
                             "lowpass=f=18000", "60Hz notch"],
    },
}


def show_tags(slug):
    """Per-show tag context from recordings.json: (artist name, album string).
    None if the slug isn't in the catalog (tags are then skipped)."""
    try:
        data = json.load(open(os.path.join(ROOT, "data", "recordings.json")))
        show = next(s for s in data["shows"] if s["slug"] == slug)
        artist = next((a["name"] for a in data["artists"] if a["id"] == show["artist"]),
                      show["artist"].title())
        venue = show.get("venue_short") or show.get("venue") or ""
        when = show.get("date_display") or show.get("date") or ""
        album = f"{venue} — {when}" if venue and when else (venue or when or slug)
        year = (show.get("date") or "")[:4]
        return {"artist": artist, "album": album, "year": year}
    except (StopIteration, FileNotFoundError, json.JSONDecodeError):
        return None


def tag_args(ctx, filename, num, total, target, title=None):
    """ffmpeg -metadata args for one track. Works for FLAC (vorbis comments)
    and MP3 (id3v2) alike — ffmpeg maps the generic keys per container.
    `title` overrides the filename-derived title: retag passes the catalog
    title so a `make edit` retitle flows into the files; at process time the
    catalog entry doesn't exist yet, so the filename is the only source."""
    if ctx is None:
        return []
    title = title or re.sub(r"^\d+\s+", "", os.path.splitext(filename)[0])
    pairs = {
        "title": title, "artist": ctx["artist"], "album_artist": ctx["artist"],
        "album": ctx["album"],
        "track": f"{num}/{total}" if num is not None else None,
        "date": ctx["year"] or None,
        "comment": f"The Hannan Tapes (renedebos.com) — loudness-normalized "
                   f"to {int(target)} LUFS",
    }
    out = []
    for k, v in pairs.items():
        if v:
            out += ["-metadata", f"{k}={v}"]
    return out


def ffmpeg_version():
    try:
        out = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True).stdout
        return out.split("\n", 1)[0].replace("ffmpeg version ", "").split()[0]
    except Exception:
        return "unknown"


# ── shared helpers ────────────────────────────────────────────────────────────

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


def audio_md5(path):
    out = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path,
                          "-map", "0:a", "-f", "md5", "-"],
                         capture_output=True, text=True).stdout.strip()
    return out.replace("MD5=", "")


def output_codec(bits, sample_fmt, container):
    """Return ffmpeg output args for the target container, preserving bit depth."""
    b = str(bits or "")
    if container == "flac":
        if b == "16":
            return ["-c:a", "flac", "-sample_fmt", "s16"]
        if b == "24":
            return ["-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24"]
        return ["-c:a", "flac", "-sample_fmt", "s32"]
    # WAV
    if b == "16":
        return ["-c:a", "pcm_s16le"]
    if b == "24":
        return ["-c:a", "pcm_s24le"]
    if sample_fmt in ("flt", "fltp"):
        return ["-c:a", "pcm_f32le"]
    return ["-c:a", "pcm_s32le"]


def target_for(artist, override):
    if override is not None:
        return override
    if artist in ARTIST_TARGET:
        return ARTIST_TARGET[artist]
    raise SystemExit("Pass --target (no/unknown --artist; expected jerry/sean/seanjerry/mad)")


# ── diagnose (Phase 1) ────────────────────────────────────────────────────────

def cmd_diagnose(args):
    folder = args.input
    target = target_for(args.artist, args.target)
    files = lossless_files(folder)
    if not files:
        raise SystemExit(f"no .flac/.wav files in {folder}")

    skipped = mp3_sources(folder)
    if skipped:
        print(f"Skipping {len(skipped)} MP3 source(s) (lossless-only rule): "
              + ", ".join(skipped[:4]) + (" ..." if len(skipped) > 4 else ""))

    rows, flags = [], []
    for f in files:
        p = os.path.join(folder, f)
        info = probe(p)
        sr, nch = int(info["sr"]), 2
        j = measure(p, target)
        I, LRA, TP = float(j["input_i"]), float(j["input_lra"]), float(j["input_tp"])
        ch_rms, peak_db, dc = astats_channels(p)
        nch = len(ch_rms) or 2
        pred = TP + (target - I)
        maxlin = I - TP - 1
        # clipping: astats screen, then run-length verdict only if peak at ceiling
        clip = "NONE"
        if peak_db is not None and peak_db not in ("inf", "-inf") and float(peak_db) >= -0.1:
            ch, srp = clipcheck.probe(p)
            a = clipcheck.decode_f32(p)
            worst_run = events = 0
            for c in range(ch):
                _, run, ev = clipcheck.analyse_channel(a[c::ch])
                worst_run = max(worst_run, run)
                events += ev
            clip, _ = clipcheck.classify(worst_run, srp, events)
        dc_bad = dc is not None and abs(float(dc)) > 0.01

        # DAT defect scan: dropouts (identical-sample runs) + clicks/steps
        dropouts, clicks = defect_scan(p, sr, nch)
        drops, drop_ms = len(dropouts), max((ms for _, ms in dropouts), default=0)
        # effective bandwidth vs container rate (catches mislabelled sample
        # rates and lossy-sourced files): high-band mean vs full-band mean
        cut = int(0.43 * sr)
        # 6 chained poles ≈ 36 dB/oct: steep enough that LF energy can't leak
        # through and mask a genuine null above the cutoff (a 2-pole highpass
        # measured a true 32k→48k upsample at only -37 dB; 6-pole: -63 dB)
        hp6 = ",".join([f"highpass=f={cut}"] * 6)
        full_v, hp_v = mean_vol(p, "anull"), mean_vol(p, hp6)
        # hp_v None with a measurable full band = literally nothing above the
        # cutoff (volumedetect can't say "-inf") — maximally deficient
        bw_delta = ((hp_v - full_v) if hp_v is not None else -99.0) \
            if full_v is not None else None
        bw_bad = bw_delta is not None and bw_delta < -55
        # channel health: L/R balance and mid/side relationship (phase)
        bal = (abs(ch_rms[0] - ch_rms[1])
               if nch == 2 and None not in ch_rms[:2] else None)
        sm = None
        if nch == 2:
            mid_v = mean_vol(p, "pan=mono|c0=0.5*c0+0.5*c1")
            side_v = mean_vol(p, "pan=mono|c0=0.5*c0-0.5*c1")
            if mid_v is not None and side_v is not None:
                sm = side_v - mid_v

        rows.append((f, info, I, LRA, TP, pred, maxlin, clip, dc_bad,
                     drops, drop_ms, bw_delta, bal, sm))
        if clip == "CLIPPING":
            flags.append(f"CLIPPING: {f} — likely audible; review/declip in Audacity.")
        if pred > -1:
            flags.append(f"PRED_TP: {f} — predicted {pred:+.1f} dBTP > -1 at {target}; "
                         f"max linear target {maxlin:+.1f} LUFS.")
        if LRA > 15:
            flags.append(f"HIGH_LRA: {f} — LRA {LRA:.1f} (very dynamic).")
        if dc_bad:
            flags.append(f"DC: {f} — DC offset {dc}.")
        if drops:
            where = ", ".join(f"{fmt_ts(t)} ({ms} ms)" for t, ms in dropouts[:5])
            more = f" +{drops - 5} more" if drops > 5 else ""
            flags.append(f"DROPOUT: {f} — {drops} identical-sample run(s) mid-track "
                         f"at {where}{more} (DAT error concealment?). Listen there.")
        if clicks:
            where = ", ".join(f"{fmt_ts(t)} ({kind}, step {st}, {m})"
                              for t, st, m, kind in clicks[:5])
            more = f" +{len(clicks) - 5} more" if len(clicks) > 5 else ""
            flags.append(f"CLICK: {f} — {len(clicks)} suspected digital defect(s) "
                         f"at {where}{more}. Listen there.")
        if bw_bad:
            flags.append(f"BANDWIDTH: {f} — energy above {cut/1000:.1f} kHz is "
                         f"{bw_delta:.0f} dB below full-band: content doesn't fill the "
                         f"{sr//1000} kHz container (mislabelled rate or lossy source?).")
        if bal is not None and bal > 4:
            flags.append(f"BALANCE: {f} — L/R RMS differs by {bal:.1f} dB.")
        if sm is not None and sm > 3:
            flags.append(f"PHASE: {f} — side energy {sm:+.1f} dB above mid: channels "
                         "largely out of phase (inverted channel?).")
        print(f"  {f}: in {I:.1f} LUFS, LRA {LRA:.1f}, TP {TP:.1f}, pred@{target} "
              f"{pred:+.1f}, clip {clip}, drops {drops}, clicks {len(clicks)}", flush=True)

        if getattr(args, "spectrograms", False):
            sdir = os.path.join(folder, "spectrograms")
            os.makedirs(sdir, exist_ok=True)
            png = os.path.join(sdir, os.path.splitext(f)[0] + ".png")
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                            "-i", p, "-lavfi",
                            "showspectrumpic=s=2048x512:legend=1:gain=5",
                            png], capture_output=True)

    out = os.path.join(folder, "diagnostic_report.txt")
    L = ["DIAGNOSTIC REPORT",
         f"Generated: {datetime.datetime.now().isoformat(timespec='seconds')}",
         f"Files analyzed: {len(rows)}",
         f"Loudness target: {target} LUFS / {TP_CEILING} dBTP",
         "=" * 43, "",
         f"{'File':40s}|{'LUFS':7s}|{'LRA':5s}|{'TruePk':8s}|{'Pred':7s}|{'Clip':9s}|"
         f"{'DC':6s}|{'Drop':5s}|{'HiBand':7s}|{'Bal':5s}|S-M",
         "-" * 118]
    for f, info, I, LRA, TP, pred, maxlin, clip, dc_bad, drops, drop_ms, bw, bal, sm in rows:
        L.append(f"{f[:40]:40s}|{I:7.1f}|{LRA:5.1f}|{TP:7.1f}T|{pred:+6.1f}|{clip:9s}|"
                 + ("OFFSET" if dc_bad else "OK    ").ljust(6)
                 + f"|{drops:5d}|"
                 + (f"{bw:+6.1f} " if bw is not None else "   --  ") + "|"
                 + (f"{bal:4.1f} " if bal is not None else "  -- ") + "|"
                 + (f"{sm:+.1f}" if sm is not None else "--"))
    L += ["", "FLAGS", "-----"]
    L += ["⚠ " + x for x in flags] if flags else ["(none)"]
    open(out, "w").write("\n".join(L) + "\n")
    print(f"\n[report -> {out}]  target {target} LUFS, {len(flags)} flag(s)")


# ── process (Phase 2) ─────────────────────────────────────────────────────────

def build_filters(args):
    chain = []
    if getattr(args, "eq", None):
        chain.append(args.eq)              # literal corrective-EQ chain (v2), applied first
    if args.hpf:
        chain.append("highpass=f=80")
    if args.lpf:
        chain.append("lowpass=f=18000")
    if args.notch:
        chain.append("equalizer=f=60:width_type=o:width=2:g=-20,"
                     "equalizer=f=120:width_type=o:width=2:g=-10,"
                     "equalizer=f=180:width_type=o:width=2:g=-6")
    return ",".join(chain)


def cmd_process(args):
    infolder, outfolder = args.input, args.output
    target = args.target
    os.makedirs(outfolder, exist_ok=True)
    files = lossless_files(infolder)
    if not files:
        raise SystemExit(f"no .flac/.wav files in {infolder}")
    filt = build_filters(args)

    # literal process chain applied to every track in THIS run (filters + the
    # loudnorm step). Stored per-track so a later, single-track re-run with a new
    # filter (e.g. a noise-floor pass on just track 4) is individually recoverable.
    _w = lambda x: int(x) if float(x) == int(x) else x
    chain_str = ((filt + ",") if filt else "") + \
        f"loudnorm=I={_w(target)}:LRA=11:TP={_w(TP_CEILING)}:linear=true"

    tag_ctx = show_tags(args.slug) if args.slug else None
    if args.slug and tag_ctx is None:
        print(f"note: {args.slug} not in recordings.json — no tags embedded")

    prov_tracks, report, warnings = {}, [], []
    for i, f in enumerate(files, 1):
        src = os.path.join(infolder, f)
        container = "flac" if f.lower().endswith(".flac") else "wav"
        out_audio = os.path.join(outfolder, f)
        out_mp3 = os.path.join(outfolder, os.path.splitext(f)[0] + ".mp3")
        num = lead_num(f)

        if os.path.exists(out_audio) and os.path.exists(out_mp3):
            print(f"[{i:02d}/{len(files)}] {f} — exists, skipping (resume)", flush=True)
            # still record provenance from the existing output
            j2 = measure(out_audio, target)
            in_I = float(measure(src, target)["input_i"]) if os.path.exists(src) else None
        else:
            info = probe(src)
            # loudnorm values measured on the post-EQ signal (so the gain is right);
            # in_I is the RAW input loudness, kept for provenance/display.
            j = measure(src, target, pre=filt)
            in_I = float(measure(src, target)["input_i"]) if filt else float(j["input_i"])
            pre = (filt + ",") if filt else ""
            af = (f"{pre}loudnorm=I={target}:LRA=11:TP={TP_CEILING}:"
                  f"measured_I={j['input_i']}:measured_LRA={j['input_lra']}:"
                  f"measured_tp={j['input_tp']}:measured_thresh={j['input_thresh']}:"
                  f"offset={j['target_offset']}:linear=true:print_format=summary")
            codec = output_codec(info["bits"], info["sample_fmt"], container)
            tags = tag_args(tag_ctx, f, num, len(files), target)
            r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                                "-i", src, "-af", af, "-ar", str(info["sr"])] + codec
                               + tags + [out_audio], capture_output=True, text=True)
            if r.returncode != 0:
                print(f"  FAIL {f}: {r.stderr[-200:]}", flush=True)
                continue
            r2 = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                                 "-i", out_audio, "-b:a", "320k", "-id3v2_version", "3"]
                                + tags + [out_mp3],
                                capture_output=True, text=True)
            if r2.returncode != 0:
                print(f"  MP3 FAIL {f}: {r2.stderr[-200:]}", flush=True)
                continue
            j2 = measure(out_audio, target)

        out_I, out_TP, out_LRA = float(j2["input_i"]), float(j2["input_tp"]), float(j2["input_lra"])
        md5 = audio_md5(out_audio)
        # the lossy encode can overshoot the FLAC's peaks — measure the MP3's
        # true peak too and warn if it would clip on decode
        mp3_tp = float(measure(out_mp3, target)["input_tp"])
        # verification (#7)
        status = "OK"
        if out_TP > TP_CEILING + TP_TOL:
            status = "TP>ceiling"
            warnings.append(f"{f}: achieved TP {out_TP:+.2f} dBTP exceeds {TP_CEILING} ceiling")
        if abs(out_I - target) > LUFS_TOL:
            status = "LUFS drift"
            warnings.append(f"{f}: achieved {out_I:.2f} LUFS drifts > {LUFS_TOL} from {target}")
        if mp3_tp > 0.0:
            status = "MP3 clips"
            warnings.append(f"{f}: MP3 true peak {mp3_tp:+.2f} dBTP — lossy overshoot "
                            "clips on decode (FLAC is fine; consider re-encode headroom)")
        if num is not None:
            entry = {"ver": WORKFLOW_VERSION, "chain": chain_str,
                     "lufs": round(out_I, 2), "tp": round(out_TP, 2),
                     "mp3_tp": round(mp3_tp, 2),
                     "lra": round(out_LRA, 2), "md5": md5}
            if in_I is not None:
                entry = {"ver": WORKFLOW_VERSION, "chain": chain_str,
                         "in_lufs": round(in_I, 1),
                         "lufs": round(out_I, 2), "tp": round(out_TP, 2),
                         "mp3_tp": round(mp3_tp, 2),
                         "lra": round(out_LRA, 2), "md5": md5}
            prov_tracks[str(num)] = entry
        report.append((f, in_I, out_I, out_TP, status))
        print(f"[{i:02d}/{len(files)}] {f} -> {out_I:.2f} LUFS, TP {out_TP:.2f} "
              f"[{status}] md5 {md5[:8]}", flush=True)

    # processing report
    rp = ["PROCESSING REPORT",
          f"Generated: {datetime.datetime.now().isoformat(timespec='seconds')}",
          f"Filters: {filt or 'none'}", f"Target: {target} LUFS / {TP_CEILING} dBTP",
          "=" * 43, "",
          f"{'File':40s}|{'In LUFS':8s}|{'Out LUFS':8s}|{'Out TP':8s}|Status",
          "-" * 82]
    for f, in_I, out_I, out_TP, status in report:
        rp.append(f"{f[:40]:40s}|{('%.1f' % in_I) if in_I is not None else '--':>8s}|"
                  f"{out_I:8.2f}|{out_TP:8.2f}|{status}")
    if warnings:
        rp += ["", "WARNINGS", "--------"] + ["⚠ " + w for w in warnings]
    open(os.path.join(outfolder, "processing_report.txt"), "w").write("\n".join(rp) + "\n")

    if args.slug:
        info0 = probe(os.path.join(infolder, files[0]))
        cont = "FLAC" if files[0].lower().endswith(".flac") else "WAV"
        whole = lambda x: int(x) if float(x) == int(x) else x
        dest = os.path.join(ROOT, "data", "processing", f"{args.slug}.json")
        # MERGE: keep any tracks not touched this run (possibly from an older
        # workflow version) and overlay the ones we just processed. This is what
        # lets one show hold a mix of versions — e.g. 29 tracks on v1 and a single
        # track later re-run on v2 with an added filter.
        merged, prev = {}, {}
        if os.path.exists(dest):
            try:
                prev = json.load(open(dest))
                merged = prev.get("tracks", {})
            except Exception:
                merged, prev = {}, {}
        merged.update(prov_tracks)
        # manual Audacity work beyond the standard fades/clip-fixes (e.g. whole-show
        # noise reduction); sticky across re-runs unless overridden on the CLI.
        pre_edits = getattr(args, "pre_edits", None) or prev.get("pre_edits")
        prov = {
            "slug": args.slug, "target_lufs": whole(target), "tp_ceiling": whole(TP_CEILING),
            "source": f"{info0['bits']}-bit / {int(info0['sr'])//1000} kHz {cont}",
            **({"pre_edits": pre_edits} if pre_edits else {}),
            "filters": filt or "none", "tool": "ffmpeg loudnorm",
            # last-run context; the per-track `ver`/`chain` are the authoritative
            # record for mixed-version shows.
            "workflow_version": WORKFLOW_VERSION, "ffmpeg": ffmpeg_version(),
            "date": datetime.date.today().isoformat(),
            "tracks": {k: merged[k] for k in sorted(merged, key=int)},
        }
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        json.dump(prov, open(dest, "w"), indent=2, ensure_ascii=False)
        open(dest, "a").write("\n")
        print(f"provenance -> {dest} (workflow v{WORKFLOW_VERSION}, "
              f"{len(prov_tracks)} track(s) this run, {len(merged)} total)")

    print(f"\nProcessed {len(report)} file(s). "
          + (f"{len(warnings)} warning(s) — see report." if warnings else "All within spec."))
    if warnings:
        sys.exit(2)


# ── verify (#8 integrity / drift) ─────────────────────────────────────────────

def r2_md5(key):
    rc = subprocess.Popen(["rclone", "cat", f"{BUCKET}/{key}", "--s3-no-check-bucket"],
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    ff = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
                         "-map", "0:a", "-f", "md5", "-"],
                        stdin=rc.stdout, capture_output=True, text=True)
    rc.wait()
    return ff.stdout.strip().replace("MD5=", "")


def cmd_verify(args):
    data = json.load(open(os.path.join(ROOT, "data", "recordings.json")))
    show = next((s for s in data["shows"] if s["slug"] == args.slug), None)
    if not show:
        raise SystemExit(f"no show with slug {args.slug}")
    prov = json.load(open(os.path.join(ROOT, "data", "processing", f"{args.slug}.json")))
    by_num = {str(t["num"]): t for t in show["tracks"]}
    bad = 0
    for num, pt in prov["tracks"].items():
        want = pt.get("md5")
        key = by_num[num].get("flac") or by_num[num]["file"]
        got = r2_md5(key)
        ok = got == want
        bad += not ok
        print(f"  track {num}: R2 {'OK ' if ok else 'MISMATCH'} ({got[:8]} vs {want[:8]})")
        if args.drive:
            # Drive copy: filename mirrors the local processed name; compare by track num.
            import glob  # noqa
            print(f"           (drive check: pass {args.drive!r} keys not auto-mapped — "
                  "skipping unless filename known)")
    print(f"\n{len(prov['tracks'])} track(s) checked, {bad} mismatch(es).")
    sys.exit(1 if bad else 0)


def cmd_retag(args):
    """Retro-fit embedded metadata tags onto already-published shows: download
    each FLAC+MP3 from R2, rewrite the container with tags (-c copy — the audio
    stream and its provenance MD5 are untouched), verify, and upload back.
    Records `tags_embedded` in the sidecar. Drive Processed/ backups are NOT
    refreshed here (slow, stall-prone) — do that separately per show."""
    data = json.load(open(os.path.join(ROOT, "data", "recordings.json")))
    if args.slug:
        shows = [s for s in data["shows"] if s["slug"] == args.slug]
    elif args.all:
        shows = [s for s in data["shows"] if s.get("tracks")]
    else:
        raise SystemExit("give a slug or --all")

    for show in shows:
        slug = show["slug"]
        prov_path = os.path.join(ROOT, "data", "processing", f"{slug}.json")
        prov = json.load(open(prov_path)) if os.path.exists(prov_path) else {}
        if prov.get("tags_embedded") and not args.force:
            print(f"{slug}: already tagged ({prov['tags_embedded']}) — skipping "
                  "(--force to re-tag, e.g. after a make-edit retitle)")
            continue
        ctx = show_tags(slug)
        tracks = show["tracks"]
        work = os.path.expanduser(f"~/work/retag/{slug}")
        os.makedirs(work, exist_ok=True)
        print(f"\n{slug}: {len(tracks)} track(s)")
        bad = 0
        for t in tracks:
            for key in filter(None, (t.get("flac"), t.get("file"))):
                name = key.split("/")[-1]
                local = os.path.join(work, name)
                tmp = os.path.join(work, "tagged_" + name)
                if subprocess.run(["rclone", "copyto", f"{BUCKET}/{key}", local,
                                   "--s3-no-check-bucket"]).returncode != 0:
                    print(f"  DOWNLOAD FAIL {key}"); bad += 1; continue
                tags = tag_args(ctx, name, t["num"], len(tracks),
                                prov.get("target_lufs", -20), title=t.get("title"))
                extra = ["-id3v2_version", "3"] if name.lower().endswith(".mp3") else []
                r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                                    "-i", local, "-map", "0", "-c", "copy"]
                                   + extra + tags + [tmp],
                                   capture_output=True, text=True)
                if r.returncode != 0:
                    print(f"  RETAG FAIL {key}: {r.stderr[-120:]}"); bad += 1; continue
                if audio_md5(tmp) != audio_md5(local):
                    print(f"  AUDIO CHANGED (refusing) {key}"); bad += 1; continue
                os.replace(tmp, local)
                if subprocess.run(["rclone", "copyto", local, f"{BUCKET}/{key}",
                                   "--s3-no-check-bucket"]).returncode != 0:
                    print(f"  UPLOAD FAIL {key}"); bad += 1; continue
            print(f"  [{t['num']:02d}] {t['title']} ok", flush=True)
        if bad:
            print(f"{slug}: {bad} failure(s) — NOT marking tagged")
        else:
            prov["tags_embedded"] = datetime.date.today().isoformat()
            json.dump(prov, open(prov_path, "w"), indent=2, ensure_ascii=False)
            open(prov_path, "a").write("\n")
            print(f"{slug}: done, sidecar marked tags_embedded")
        # local copies are per-show scratch — drop them immediately or a long
        # --all run fills the disk (learned 2026-07-10: 5 shows died on ENOSPC)
        import shutil
        shutil.rmtree(work, ignore_errors=True)


def cmd_versions(args):
    """Decode the workflow-version registry: what each version's processing did."""
    print(f"Current workflow version: {WORKFLOW_VERSION}\n")
    for v in sorted(WORKFLOW_VERSIONS):
        meta = WORKFLOW_VERSIONS[v]
        print(f"v{v}: {meta['desc']}")
        for k, val in meta.items():
            if k == "desc":
                continue
            print(f"     {k}: {val}")
        print()


def cmd_history(args):
    """Show, per track, which workflow version and exact process chain was applied
    — including a single track re-run later on a newer version."""
    path = os.path.join(ROOT, "data", "processing", f"{args.slug}.json")
    if not os.path.exists(path):
        raise SystemExit(f"no provenance for {args.slug} (not processed via the engine)")
    prov = json.load(open(path))
    print(f"{args.slug}  —  last run: workflow v{prov.get('workflow_version','?')}, "
          f"ffmpeg {prov.get('ffmpeg','?')}, {prov.get('date','?')}")
    vers = {}
    for num in sorted(prov["tracks"], key=int):
        t = prov["tracks"][num]
        v = t.get("ver", "?")
        vers[v] = vers.get(v, 0) + 1
        if args.chains:
            print(f"  track {num:>2}: v{v}  {t.get('chain','(unknown)')}")
        else:
            print(f"  track {num:>2}: v{v}")
    summary = ", ".join(f"v{k}: {n} track(s)" for k, n in sorted(vers.items(), key=lambda x: str(x[0])))
    print(f"\n  {len(prov['tracks'])} track(s) — {summary}")


# ── processing status (which shows/tracks are done / need work) ────────────────
# Statuses:
#   done             — track-listed show, every track has a sidecar entry
#   partial          — track-listed show, some (not all) tracks processed
#   needs-processing — never processed (track-listed with no sidecar, OR a
#                      whole-show-only show — those have no split tracks for the
#                      engine to act on yet, so they need splitting first)
#   redo             — normalized off the books (e.g. an old manual pass at the
#                      wrong target, no sidecar). Sticky: stays `redo` until a real
#                      sidecar exists, then auto-upgrades to done/partial.
# Shows known to have been normalized outside the engine (no provenance) — flagged
# for a re-run through the engine to get on-standard + verifiable:
REDO_SLUGS = {"jerry-19-broadway-2001-01-15"}


def show_status(show):
    slug = show["slug"]
    tracks = show.get("tracks") or []
    if not tracks:
        return "needs-processing"  # whole-show-only: nothing split to process yet
    path = os.path.join(ROOT, "data", "processing", f"{slug}.json")
    if os.path.exists(path):
        pt = json.load(open(path)).get("tracks", {})
        done = sum(1 for t in tracks if str(t["num"]) in pt)
        if done >= len(tracks):
            return "done"
        if done > 0:
            return "partial"
    if slug in REDO_SLUGS:
        return "redo"
    return "needs-processing"


def cmd_status(args):
    """Compute each show's processing status (and per-track `processed`) from the
    sidecars. With --write, persist `processing_status` per show and `processed`
    per track into recordings.json so the data is browsable/checkable without drift
    (re-run after any processing). Without --write, just print the report."""
    data_path = os.path.join(ROOT, "data", "recordings.json")
    data = json.load(open(data_path))
    order = {"needs-processing": 0, "redo": 1, "partial": 2, "done": 3}
    rows, tally = [], {}
    for show in sorted(data["shows"], key=lambda s: order.get(show_status(s), 9)):
        st = show_status(show)
        tally[st] = tally.get(st, 0) + 1
        tracks = show.get("tracks") or []
        path = os.path.join(ROOT, "data", "processing", f"{show['slug']}.json")
        pt = json.load(open(path)).get("tracks", {}) if os.path.exists(path) else {}
        ndone = sum(1 for t in tracks if str(t["num"]) in pt)
        kind = "tracks" if tracks else "whole-show"
        rows.append((st, show["slug"], kind, ndone, len(tracks)))
        if args.write:
            show["processing_status"] = st
            for t in tracks:
                if str(t["num"]) in pt:
                    t["processed"] = True
                else:
                    t.pop("processed", None)  # keep it accurate, no stale flags
    print(f"{'STATUS':17s} {'KIND':10s} {'DONE':>7s}  SLUG")
    print("-" * 70)
    for st, slug, kind, nd, nt in rows:
        cnt = f"{nd}/{nt}" if nt else "—"
        print(f"{st:17s} {kind:10s} {cnt:>7s}  {slug}")
    print("\n" + "  ".join(f"{k}: {v}" for k, v in sorted(tally.items(), key=lambda x: order.get(x[0], 9))))
    if args.write:
        json.dump(data, open(data_path, "w"), indent=2, ensure_ascii=False)
        open(data_path, "a").write("\n")
        print(f"\nwrote processing_status (+ per-track processed) to {data_path}")
    else:
        print("\n(report only — pass --write to persist into recordings.json)")


def main():
    ap = argparse.ArgumentParser(description="Audio processing workflow engine.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("diagnose")
    d.add_argument("input")
    d.add_argument("--artist", choices=list(ARTIST_TARGET))
    d.add_argument("--target", type=float)
    d.add_argument("--spectrograms", action="store_true",
                   help="also write a spectrogram PNG per track (visual QA for "
                        "suspect tapes: dropouts show as vertical stripes)")
    d.set_defaults(func=cmd_diagnose)

    p = sub.add_parser("process")
    p.add_argument("input")
    p.add_argument("output")
    p.add_argument("--target", type=float, required=True)
    p.add_argument("--hpf", action="store_true", help="high-pass 80 Hz")
    p.add_argument("--lpf", action="store_true", help="low-pass 18 kHz")
    p.add_argument("--notch", action="store_true", help="60 Hz hum notch")
    p.add_argument("--eq", help="literal ffmpeg corrective-EQ chain applied before "
                                "loudnorm (e.g. de-mud + presence + air for a muffled tape); "
                                "recorded per-track in provenance")
    p.add_argument("--pre-edits", dest="pre_edits",
                   help="non-standard manual edits already applied in Audacity before "
                        "this run (e.g. 'noise reduction (Audacity, whole show)'); "
                        "recorded show-level in provenance and shown on the site")
    p.add_argument("--slug", help="write provenance sidecar for this show slug")
    p.set_defaults(func=cmd_process)

    v = sub.add_parser("verify")
    v.add_argument("slug")
    v.add_argument("--drive", help="Drive Processed/ path (best-effort)")
    v.set_defaults(func=cmd_verify)

    rt = sub.add_parser("retag", help="retro-fit embedded tags onto published shows "
                                      "(container rewrite, audio MD5 preserved)")
    rt.add_argument("slug", nargs="?")
    rt.add_argument("--all", action="store_true", help="every track-listed show")
    rt.add_argument("--force", action="store_true",
                    help="re-tag even if already tags_embedded (after catalog edits)")
    rt.set_defaults(func=cmd_retag)

    vs = sub.add_parser("versions", help="describe what each workflow version does")
    vs.set_defaults(func=cmd_versions)

    h = sub.add_parser("history", help="per-track workflow version + process chain for a show")
    h.add_argument("slug")
    h.add_argument("--chains", action="store_true", help="also print the literal filter chain")
    h.set_defaults(func=cmd_history)

    st = sub.add_parser("status", help="per-show processing status (done/partial/redo/needs-processing)")
    st.add_argument("--write", action="store_true",
                    help="persist processing_status (+ per-track processed) into recordings.json")
    st.set_defaults(func=cmd_status)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
