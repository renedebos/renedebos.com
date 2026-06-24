#!/usr/bin/env python3
"""Create lossy MP3 stream proxies for the lossless full-show recordings.

For every WAV/FLAC recording in data/recordings.json that lacks a `stream`
key, this downloads the lossless file from R2, transcodes it to a 192 kbps
MP3, uploads the MP3 back to R2 under `MP3/Full/<original path>.mp3`, and then
records the MP3 key in `stream` so build.py streams the lossy proxy for free
while the lossless original stays behind the password/download gate.

Idempotent + resumable: skips recordings that already have `stream`, reuses an
MP3 already present in R2, and saves recordings.json after each file. Safe to
re-run after an interruption.

Usage:
  python3 scripts/make_stream_mp3.py            # process all remaining
  python3 scripts/make_stream_mp3.py <slug> ... # only the named show slug(s)
  python3 scripts/make_stream_mp3.py --limit 1  # process at most N recordings
"""
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "recordings.json")
BUCKET = "r2:hannan-audio"
R2_FLAGS = ["--s3-no-check-bucket"]
BITRATE = "320k"
MP3_PREFIX = "MP3/Full/"


def mp3_key_for(file):
    base = file.rsplit(".", 1)[0]
    return f"{MP3_PREFIX}{base}.mp3"


def r2_exists(key):
    r = subprocess.run(
        ["rclone", "lsf", f"{BUCKET}/{key}", *R2_FLAGS],
        capture_output=True, text=True,
    )
    return r.returncode == 0 and r.stdout.strip() != ""


def run(cmd):
    print("  $", " ".join(cmd[:2]), "...", flush=True)
    subprocess.run(cmd, check=True)


def lossless_recordings(data, slugs):
    for show in data["shows"]:
        if slugs and show["slug"] not in slugs:
            continue
        for rec in show["recordings"]:
            f = rec["file"].lower()
            if f.endswith(".wav") or f.endswith(".flac"):
                yield show, rec


def main():
    args = [a for a in sys.argv[1:]]
    limit = None
    if "--limit" in args:
        i = args.index("--limit")
        limit = int(args[i + 1])
        del args[i:i + 2]
    slugs = set(args)

    data = json.load(open(DATA))
    todo = [(s, r) for s, r in lossless_recordings(data, slugs) if not r.get("stream")]
    if limit is not None:
        todo = todo[:limit]

    print(f"{len(todo)} recording(s) to process\n")
    done = 0
    for show, rec in todo:
        wav_key = rec["file"]
        mp3_key = mp3_key_for(wav_key)
        print(f"[{show['slug']}] {wav_key}")

        if r2_exists(mp3_key):
            print("  MP3 already in R2 — linking only")
        else:
            with tempfile.TemporaryDirectory(dir="/home/renedebos") as tmp:
                local_wav = os.path.join(tmp, os.path.basename(wav_key))
                local_mp3 = os.path.splitext(local_wav)[0] + ".mp3"
                run(["rclone", "copyto", f"{BUCKET}/{wav_key}", local_wav, *R2_FLAGS])
                run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                     "-i", local_wav, "-b:a", BITRATE, "-map_metadata", "-1",
                     local_mp3])
                run(["rclone", "copyto", local_mp3, f"{BUCKET}/{mp3_key}", *R2_FLAGS])

        rec["stream"] = mp3_key
        json.dump(data, open(DATA, "w"), ensure_ascii=False, indent=2)
        done += 1
        print(f"  done ({done}/{len(todo)})\n", flush=True)

    print(f"Finished. {done} recording(s) now have stream proxies.")


if __name__ == "__main__":
    main()
