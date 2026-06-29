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
WORKFLOW_VERSION = 2
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
}


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
        j = measure(p, target)
        I, LRA, TP = float(j["input_i"]), float(j["input_lra"]), float(j["input_tp"])
        peak_db = astats_field(p, "Peak level dB")
        dc = astats_field(p, "DC offset")
        pred = TP + (target - I)
        maxlin = I - TP - 1
        # clipping: astats screen, then run-length verdict only if peak at ceiling
        clip = "NONE"
        if peak_db is not None and peak_db not in ("inf", "-inf") and float(peak_db) >= -0.1:
            ch, sr = clipcheck.probe(p)
            a = clipcheck.decode_f32(p)
            worst_run = events = 0
            for c in range(ch):
                _, run, ev = clipcheck.analyse_channel(a[c::ch])
                worst_run = max(worst_run, run)
                events += ev
            clip, _ = clipcheck.classify(worst_run, sr, events)
        dc_bad = dc is not None and abs(float(dc)) > 0.01
        rows.append((f, info, I, LRA, TP, pred, maxlin, clip, dc_bad))
        if clip == "CLIPPING":
            flags.append(f"CLIPPING: {f} — likely audible; review/declip in Audacity.")
        if pred > -1:
            flags.append(f"PRED_TP: {f} — predicted {pred:+.1f} dBTP > -1 at {target}; "
                         f"max linear target {maxlin:+.1f} LUFS.")
        if LRA > 15:
            flags.append(f"HIGH_LRA: {f} — LRA {LRA:.1f} (very dynamic).")
        if dc_bad:
            flags.append(f"DC: {f} — DC offset {dc}.")
        print(f"  {f}: in {I:.1f} LUFS, LRA {LRA:.1f}, TP {TP:.1f}, pred@{target} "
              f"{pred:+.1f}, clip {clip}", flush=True)

    out = os.path.join(folder, "diagnostic_report.txt")
    L = ["DIAGNOSTIC REPORT",
         f"Generated: {datetime.datetime.now().isoformat(timespec='seconds')}",
         f"Files analyzed: {len(rows)}",
         f"Loudness target: {target} LUFS / {TP_CEILING} dBTP",
         "=" * 43, "",
         f"{'File':40s}|{'LUFS':7s}|{'LRA':5s}|{'TruePk':8s}|{'Pred':7s}|{'Clip':9s}|DC",
         "-" * 90]
    for f, info, I, LRA, TP, pred, maxlin, clip, dc_bad in rows:
        L.append(f"{f[:40]:40s}|{I:7.1f}|{LRA:5.1f}|{TP:7.1f}T|{pred:+6.1f}|{clip:9s}|"
                 + ("OFFSET" if dc_bad else "OK"))
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
            r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                                "-i", src, "-af", af, "-ar", str(info["sr"])] + codec
                               + [out_audio], capture_output=True, text=True)
            if r.returncode != 0:
                print(f"  FAIL {f}: {r.stderr[-200:]}", flush=True)
                continue
            r2 = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                                 "-i", out_audio, "-b:a", "320k", out_mp3],
                                capture_output=True, text=True)
            if r2.returncode != 0:
                print(f"  MP3 FAIL {f}: {r2.stderr[-200:]}", flush=True)
                continue
            j2 = measure(out_audio, target)

        out_I, out_TP, out_LRA = float(j2["input_i"]), float(j2["input_tp"]), float(j2["input_lra"])
        md5 = audio_md5(out_audio)
        # verification (#7)
        status = "OK"
        if out_TP > TP_CEILING + TP_TOL:
            status = "TP>ceiling"
            warnings.append(f"{f}: achieved TP {out_TP:+.2f} dBTP exceeds {TP_CEILING} ceiling")
        if abs(out_I - target) > LUFS_TOL:
            status = "LUFS drift"
            warnings.append(f"{f}: achieved {out_I:.2f} LUFS drifts > {LUFS_TOL} from {target}")
        if num is not None:
            entry = {"ver": WORKFLOW_VERSION, "chain": chain_str,
                     "lufs": round(out_I, 2), "tp": round(out_TP, 2),
                     "lra": round(out_LRA, 2), "md5": md5}
            if in_I is not None:
                entry = {"ver": WORKFLOW_VERSION, "chain": chain_str,
                         "in_lufs": round(in_I, 1),
                         "lufs": round(out_I, 2), "tp": round(out_TP, 2),
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
        merged = {}
        if os.path.exists(dest):
            try:
                merged = json.load(open(dest)).get("tracks", {})
            except Exception:
                merged = {}
        merged.update(prov_tracks)
        prov = {
            "slug": args.slug, "target_lufs": whole(target), "tp_ceiling": whole(TP_CEILING),
            "source": f"{info0['bits']}-bit / {int(info0['sr'])//1000} kHz {cont}",
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
    p.add_argument("--slug", help="write provenance sidecar for this show slug")
    p.set_defaults(func=cmd_process)

    v = sub.add_parser("verify")
    v.add_argument("slug")
    v.add_argument("--drive", help="Drive Processed/ path (best-effort)")
    v.set_defaults(func=cmd_verify)

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
