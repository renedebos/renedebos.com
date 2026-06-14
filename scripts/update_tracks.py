#!/usr/bin/env python3
"""Re-upload re-exported (e.g. normalized/louder) track files for a show.

Usage:
  python3 scripts/update_tracks.py <slug> <src-folder>

Matches local MP3/FLAC files to the show's existing tracks by their leading
track number, overwrites the matching keys in R2, and refreshes each track's
size and duration in data/recordings.json.

The site streams directly from R2 with no caching, so the louder versions are
live the moment the upload finishes. Run `python3 scripts/build.py` and commit
afterward only to refresh the *displayed* file sizes.

Only tracks found in <src-folder> are touched, so partial updates are fine.
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "recordings.json")
BUCKET = "r2:hannan-audio"


def lead_num(name):
    m = re.match(r"\s*(\d+)", os.path.basename(name))
    return int(m.group(1)) if m else None


def index_by_num(folder, ext):
    out = {}
    for f in sorted(os.listdir(folder)):
        if f.lower().endswith(ext):
            n = lead_num(f)
            if n is not None:
                out[n] = os.path.join(folder, f)
    return out


def duration(path):
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
         "-of", "csv=p=0", path], capture_output=True, text=True)
    s = float(r.stdout.strip())
    return f"{int(s) // 60}:{int(round(s)) % 60:02d}"


def rclone_put(local, key):
    subprocess.run(["rclone", "copyto", local, f"{BUCKET}/{key}",
                    "--s3-no-check-bucket"], check=True)


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: update_tracks.py <slug> <src-folder>")
    slug, src = sys.argv[1], sys.argv[2]
    if not os.path.isdir(src):
        sys.exit(f"source folder not found: {src}")

    M = json.load(open(DATA))
    show = next((s for s in M["shows"] if s["slug"] == slug), None)
    if not show or not show.get("tracks"):
        sys.exit(f"no show with tracks for slug {slug!r}")

    mp3s = index_by_num(src, ".mp3")
    flacs = index_by_num(src, ".flac")
    if not mp3s and not flacs:
        sys.exit(f"no .mp3/.flac files with leading track numbers in {src}")

    updated = 0
    for t in show["tracks"]:
        n = t["num"]
        if n in mp3s:
            rclone_put(mp3s[n], t["file"])
            t["size_mb"] = round(os.path.getsize(mp3s[n]) / 1048576)
            t["duration"] = duration(mp3s[n])
            print(f"  {n:02d} mp3  -> {t['file']}")
            updated += 1
        if n in flacs and t.get("flac"):
            rclone_put(flacs[n], t["flac"])
            t["flac_size_mb"] = round(os.path.getsize(flacs[n]) / 1048576)
            print(f"  {n:02d} flac -> {t['flac']}")

    json.dump(M, open(DATA, "w"), indent=2, ensure_ascii=False)
    open(DATA, "a").write("\n")
    print(f"\nUpdated {updated} track(s) for {slug}.")
    print("Streaming is live now. To refresh displayed sizes:")
    print("  python3 scripts/build.py && git add -A && git commit && git push")


if __name__ == "__main__":
    main()
