#!/usr/bin/env python3
"""Pre-compute waveform peaks for the wavesurfer.js track players.

For every split track of every track-listed show (or just one show with --slug),
stream the track's MP3 straight from R2, decode to mono 8 kHz PCM with ffmpeg, bucket
into ~400 peaks (max-abs per bucket, normalized 0-1), and derive the duration from the
sample count. Writes data/peaks/<slug>.json keyed by track number:
{ "1": {"d": secs, "p": [..400 floats..]}, ... }.

These peaks let wavesurfer render each waveform without downloading the audio (avoids
the streaming Worker's CORS scope and a flood of page-load fetches); playback still
streams lazily through a native media element on play.

Usage:
  python3 scripts/gen_peaks.py                 # all track-listed shows
  python3 scripts/gen_peaks.py --slug <slug>   # one show
"""
import argparse
import array
import json
import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PEAKS_DIR = os.path.join(ROOT, "data", "peaks")
BUCKET = "r2:hannan-audio"
N_PEAKS = 400
SR = 8000


def pcm_from_r2(key):
    """Stream an R2 object through ffmpeg, returning mono 8 kHz s16 samples."""
    rc = subprocess.Popen(
        ["rclone", "cat", f"{BUCKET}/{key}", "--s3-no-check-bucket"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    ff = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", "pipe:0", "-ac", "1", "-ar", str(SR),
         "-f", "s16le", "pipe:1"],
        stdin=rc.stdout, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    rc.stdout.close()
    raw = ff.communicate()[0]
    rc.wait()
    if ff.returncode != 0 or not raw:
        raise SystemExit(f"decode failed for: {key}")
    a = array.array("h")
    a.frombytes(raw)
    return a


def peaks(samples, n=N_PEAKS):
    total = len(samples)
    if total == 0:
        return [0.0] * n
    step = total / n
    out = []
    for i in range(n):
        lo = int(i * step)
        hi = max(lo + 1, int((i + 1) * step))
        chunk = samples[lo:hi]
        m = max((abs(s) for s in chunk), default=0)
        out.append(round(m / 32768.0, 3))
    return out


def gen_show(show):
    data = {}
    for t in show["tracks"]:
        a = pcm_from_r2(t["file"])
        d = round(len(a) / SR)
        data[str(t["num"])] = {"d": d, "p": peaks(a)}
        print(f"  [{t['num']:02d}] {t['title']}  d={d}s  peaks={len(data[str(t['num'])]['p'])}",
              flush=True)
    os.makedirs(PEAKS_DIR, exist_ok=True)
    out = os.path.join(PEAKS_DIR, f"{show['slug']}.json")
    json.dump(data, open(out, "w"))
    print(f"wrote {out} ({len(data)} tracks)\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slug", help="limit to one show slug")
    args = ap.parse_args()

    M = json.load(open(os.path.join(ROOT, "data", "recordings.json")))
    shows = [s for s in M["shows"] if s.get("tracks")]
    if args.slug:
        shows = [s for s in shows if s["slug"] == args.slug]
        if not shows:
            raise SystemExit(f"no track-listed show with slug: {args.slug}")

    for show in shows:
        print(f"{show['slug']} ({len(show['tracks'])} tracks)")
        gen_show(show)


if __name__ == "__main__":
    main()
