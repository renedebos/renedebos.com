#!/usr/bin/env python3
"""Second-tier clipping check for the audio_processing workflow.

The Phase 1 `astats` screen flags any file whose peak reaches full scale, but a
raw count of full-scale samples can't tell an isolated transient peak (benign,
inaudible) from real, audible clipping. This decodes the audio and measures the
**longest consecutive run** of full-scale samples per channel — the signature
that separates the two:

  - a few isolated samples at the ceiling  -> benign transient peaks
  - sustained flat tops (many in a row)    -> clipping you can actually hear

Decoding to normalised float (-1..1) makes the full-scale test bit-depth- and
container-independent, so it works on FLAC and WAV alike.

Usage:
  python3 scripts/clipcheck.py FILE [FILE ...]      # check specific files
  python3 scripts/clipcheck.py FOLDER               # all *.flac/*.wav in folder

Exit status is non-zero if any file is classified CLIPPING (likely audible) or
fails to decode at all (ERROR — never silently read as clean).
"""
import argparse
import array
import os
import subprocess
import sys

FS = 0.9999          # |sample| at/above this (of full scale) counts as clipped
EVENT_RUN = 3        # a "clip event" is >= this many consecutive full-scale samples
MANY_EVENTS = 10     # this many clip events = pervasive clipping, even if each is short


def probe(path):
    # Parse by field name: ffprobe emits fields in its own order, not the
    # order requested, so a positional CSV split would swap them.
    out = subprocess.run(
        ["ffprobe", "-v", "quiet", "-select_streams", "a:0", "-show_entries",
         "stream=channels,sample_rate", "-of", "default=noprint_wrappers=1", path],
        capture_output=True, text=True).stdout
    d = dict(line.split("=", 1) for line in out.strip().splitlines() if "=" in line)
    return int(d["channels"]), int(d["sample_rate"])


def decode_f32(path):
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "pipe:1"],
        capture_output=True)
    # A failed decode (corrupt/truncated file, unsupported codec, etc.) must not
    # fall through as empty samples: analyse_channel would then see nothing to
    # loop over and classify() would read that as longest_run == 0 — i.e. "NONE",
    # indistinguishable from an actually clean track. Fail loudly instead.
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError(f"ffmpeg decode failed for {path}: "
                           f"{r.stderr.decode(errors='replace').strip()[-300:]}")
    a = array.array("f")
    a.frombytes(r.stdout)
    return a


def analyse_channel(samples):
    """Return (full_scale_count, longest_run, clip_events) for one channel."""
    cnt = run = best = events = 0
    for s in samples:
        if s >= FS or s <= -FS:
            cnt += 1
            run += 1
            if run == EVENT_RUN:
                events += 1
            best = max(best, run)
        else:
            run = 0
    return cnt, best, events


def classify(longest_run, sr, events):
    ms = longest_run / sr * 1000 if sr else 0
    if longest_run == 0:
        return "NONE", ms                      # peak never reaches full scale
    if ms >= 1.0 or events >= MANY_EVENTS:
        return "CLIPPING", ms                  # sustained or pervasive — likely audible
    if ms < 0.1 and events <= 2:
        return "benign", ms                    # a few isolated samples — inaudible
    return "minor", ms                         # a few short clips — probably inaudible


def check_file(path):
    ch, sr = probe(path)
    try:
        a = decode_f32(path)
    except RuntimeError as e:
        name = os.path.basename(path)
        print(f"{'ERROR':8s} | {name}")
        print(f"           {e}")
        return "ERROR"
    worst_run = worst_cnt = total_events = 0
    per_ch = []
    for c in range(ch):
        cnt, run, events = analyse_channel(a[c::ch])
        per_ch.append((cnt, run, events))
        worst_run = max(worst_run, run)
        worst_cnt += cnt
        total_events += events
    verdict, ms = classify(worst_run, sr, total_events)
    name = os.path.basename(path)
    print(f"{verdict:8s} | {name}")
    print(f"           full-scale samples={worst_cnt} · longest run={worst_run} "
          f"({ms:.2f} ms) · clip events={total_events}")
    return verdict


def gather(paths):
    files = []
    for p in paths:
        if os.path.isdir(p):
            files += [os.path.join(p, f) for f in sorted(os.listdir(p))
                      if f.lower().endswith((".flac", ".wav"))]
        else:
            files.append(p)
    return files


def main():
    ap = argparse.ArgumentParser(description="Run-length clipping check (FLAC/WAV).")
    ap.add_argument("paths", nargs="+", help="files or a folder")
    args = ap.parse_args()
    failed = False
    for f in gather(args.paths):
        if check_file(f) in ("CLIPPING", "ERROR"):
            failed = True
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
