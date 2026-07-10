#!/usr/bin/env python3
"""Materialize raw, unedited per-song files from a show's archival pieces.

The raw archive of every show is the untouched whole-show WAV plus the
Audacity label export (labels.txt: start<TAB>end<TAB>title per line). This
tool cuts the WAV at those boundaries into lossless per-song FLACs —
sample-accurate, no fades, no clip fixes, no processing whatsoever. Raw
splits are derivable, so they are generated on demand, never stored.

Usage:
  python3 scripts/split_raw.py "<work folder>" [--out DIR]
  python3 scripts/split_raw.py --wav show.wav --labels labels.txt [--out DIR]

<work folder> is a local copy of a Drive Work Folder (e.g. under
~/gdrive-mount): the whole-show .wav is found at its root next to
labels.txt. Output defaults to <work folder>/Raw Splits (or ./Raw Splits).
"""
import argparse
import os
import re
import subprocess
import sys


def find_pieces(folder):
    wavs = [f for f in os.listdir(folder) if f.lower().endswith(".wav")]
    if len(wavs) != 1:
        raise SystemExit(f"expected exactly one whole-show .wav in {folder}, "
                         f"found {len(wavs)}: {wavs}")
    labels = os.path.join(folder, "labels.txt")
    if not os.path.exists(labels):
        raise SystemExit(f"no labels.txt in {folder} — export it from the Audacity "
                         "project first (File > Export > Labels)")
    return os.path.join(folder, wavs[0]), labels


def read_labels(path):
    """Audacity label export: start<TAB>end<TAB>title. Ignores the frequency
    lines ('\\') that Audacity appends for spectral selections."""
    out = []
    for line in open(path, encoding="utf-8"):
        line = line.rstrip("\n")
        if not line or line.startswith("\\"):
            continue
        parts = line.split("\t")
        if len(parts) < 3:
            raise SystemExit(f"malformed label line: {line!r}")
        out.append((float(parts[0]), float(parts[1]), parts[2].strip()))
    if not out:
        raise SystemExit(f"no labels found in {path}")
    return out


def safe_name(title):
    return re.sub(r'[\\/:*?"<>|]', "_", title).strip() or "untitled"


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", nargs="?", help="local Work Folder copy")
    ap.add_argument("--wav", help="whole-show WAV (instead of a folder)")
    ap.add_argument("--labels", help="labels.txt (instead of a folder)")
    ap.add_argument("--out", help="output dir (default: <folder>/Raw Splits)")
    args = ap.parse_args()

    if args.folder:
        wav, labels = find_pieces(args.folder)
        out = args.out or os.path.join(args.folder, "Raw Splits")
    elif args.wav and args.labels:
        wav, labels = args.wav, args.labels
        out = args.out or "Raw Splits"
    else:
        ap.error("give a work folder, or both --wav and --labels")

    cuts = read_labels(labels)
    os.makedirs(out, exist_ok=True)
    print(f"{os.path.basename(wav)} -> {len(cuts)} raw song(s) -> {out}")
    for i, (start, end, title) in enumerate(cuts, 1):
        dest = os.path.join(out, f"{i:02d} {safe_name(title)}.flac")
        # decode+re-encode (PCM decode is identity, FLAC is lossless), which is
        # sample-accurate where stream-copy of PCM chunks is not guaranteed to be
        cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y",
               "-i", wav, "-ss", f"{start:.6f}", "-to", f"{end:.6f}",
               "-map", "0:a", "-c:a", "flac", dest]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            raise SystemExit(f"ffmpeg failed on {title!r}: {r.stderr.strip()}")
        print(f"  [{i:02d}/{len(cuts)}] {title}  ({end - start:.1f}s)")
    print("done — raw, unedited audio; regenerate any time, do not archive")


if __name__ == "__main__":
    main()
