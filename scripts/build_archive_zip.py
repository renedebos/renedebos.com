#!/usr/bin/env python3
"""Build the "complete archive" ZIP — every curated per-track FLAC across the
whole site (~25 GB / ~680 tracks), bundled into one snapshot and uploaded to
R2 for a single password-gated download via the site's existing single-file
/auth + /download flow (see fragments.dl_button). Curated tracks only — the
raw whole-show WAV/FLAC masters are not included (would add ~100 GB more).

This is a manual, occasional step — not part of CI or publish_show.py. Run it
after a batch of new shows if you want the site's "Download the complete
archive" link to reflect them:

  python3 scripts/build_archive_zip.py [--dry-run]

Needs ~50 GB of free local disk (staging copy + the zip itself, held at the
same time) and can take a long time on a slow connection — that's expected
for a one-off snapshot, not a bug.

Folder/file naming inside the ZIP reuses show_zip_entries() (sitegen/core.py)
— the exact same helper the live per-show "Download all tracks" button uses —
so the offline snapshot and the site can never drift apart on naming.
"""
import argparse
import datetime
import json
import os
import shutil
import subprocess
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sitegen.core import M, show_zip_entries  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK_ROOT = os.path.expanduser("~/work/archive-zip")
R2 = "r2:hannan-audio"
R2_KEY = "Downloads/Hannan Tapes - Complete Archive.zip"
ZIP_NAME = "Hannan Tapes - Complete Archive.zip"
META_PATH = os.path.join(ROOT, "data", "archive_zip_meta.json")

DRY = False


def run(cmd, **kw):
    if DRY:
        print("  DRY:", " ".join(cmd) if isinstance(cmd, list) else cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
    return subprocess.run(cmd, text=True, **kw)


def remote_size(r2_key):
    """Size in bytes of one R2 object, or None if it isn't there yet — used
    to confirm an upload actually landed rather than trusting rclone's exit
    code alone (per CLAUDE.md: rclone uploads of large files can stall)."""
    parent = "/".join(r2_key.split("/")[:-1])
    name = r2_key.split("/")[-1]
    r = subprocess.run(["rclone", "lsjson", f"{R2}/{parent}"], capture_output=True, text=True)
    if r.returncode != 0:
        return None
    try:
        for item in json.loads(r.stdout):
            if item.get("Name") == name:
                return item.get("Size")
    except (ValueError, KeyError):
        pass
    return None


def upload_with_retry(local_path, r2_key, attempts=10):
    expected = os.path.getsize(local_path)
    for attempt in range(1, attempts + 1):
        got = remote_size(r2_key)
        print(f"  [upload attempt {attempt}] R2 has {got} / expected {expected} bytes")
        if got == expected:
            return
        run(["timeout", "3600", "rclone", "copyto", local_path, f"{R2}/{r2_key}",
             "--s3-no-check-bucket", "--progress"])
    raise SystemExit(f"upload of {r2_key!r} did not complete after {attempts} attempts")


def stage_show(show, staging_dir):
    folder, entries = show_zip_entries(show)
    if not entries:
        return folder, []
    r2_folder = os.path.dirname(entries[0]["key"])
    dest_dir = os.path.join(staging_dir, folder)
    os.makedirs(dest_dir, exist_ok=True)
    run(["rclone", "copy", f"{R2}/{r2_folder}", dest_dir, "--include", "*.flac", "--transfers", "4"])
    if not DRY:
        for e in entries:
            src = os.path.join(dest_dir, os.path.basename(e["key"]))
            dst = os.path.join(dest_dir, os.path.basename(e["name"]))
            if src != dst and os.path.exists(src):
                os.rename(src, dst)
    return folder, entries


def main():
    global DRY
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    DRY = args.dry_run

    shows = [s for s in M["shows"] if s.get("tracks")]
    staging = os.path.join(WORK_ROOT, "staging")
    zip_path = os.path.join(WORK_ROOT, ZIP_NAME)
    os.makedirs(staging, exist_ok=True)

    print(f"[1/4] staging curated FLACs from {len(shows)} shows -> {staging}")
    all_entries = []
    for show in shows:
        folder, entries = stage_show(show, staging)
        all_entries.extend(entries)
        print(f"  {folder}: {len(entries)} tracks")

    n_tracks = len(all_entries)
    print(f"\n[2/4] zipping {n_tracks} tracks -> {zip_path}")
    if not DRY:
        if os.path.exists(zip_path):
            os.remove(zip_path)
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as zf:
            for root, _dirs, files in os.walk(staging):
                for fn in files:
                    full = os.path.join(root, fn)
                    arcname = os.path.relpath(full, staging)
                    zf.write(full, arcname)

    size_bytes = os.path.getsize(zip_path) if not DRY and os.path.exists(zip_path) else 0
    print(f"\n[3/4] uploading to {R2}/{R2_KEY}")
    if not DRY:
        upload_with_retry(zip_path, R2_KEY)

    meta = {
        "generated": datetime.datetime.now().isoformat(),
        "n_shows": len(shows),
        "n_tracks": n_tracks,
        "size_mb": round(size_bytes / 1_000_000),
        "r2_key": R2_KEY,
    }
    print(f"\n[4/4] writing {META_PATH}")
    if not DRY:
        json.dump(meta, open(META_PATH, "w"), indent=2)
        shutil.rmtree(staging)
        os.remove(zip_path)

    print(f"\ndone — {n_tracks} tracks, {meta['size_mb']} MB. "
          f"Run scripts/build.py to render the download link on /archive/.")


if __name__ == "__main__":
    main()
