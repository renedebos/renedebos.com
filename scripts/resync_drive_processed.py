#!/usr/bin/env python3
"""Bring a show's Drive `Processed/` backup back in step with R2.

R2 is what the site serves; Drive `Work Folder/<folder>/Processed/` is the
backup of the same processed FLAC + MP3 files. The two drifted (found
2026-08-22 by the first honest `audio_process.py verify --drive`): a
republish's backup poll used to count files, so same-named leftovers of an
older render satisfied it and the newer files never landed. This script is
the repair, and the periodic check.

    python3 scripts/resync_drive_processed.py --sweep          # list-only: which shows differ (no audio read)
    python3 scripts/resync_drive_processed.py <slug> [...]     # copy the named files R2 -> Drive, then rclone check by hash
    python3 scripts/resync_drive_processed.py <slug> --delete-orphans   # also delete Processed/ FLAC/MP3 not named by the catalog
    python3 scripts/resync_drive_processed.py --all            # every show the sweep flags
    --dry-run prints every rclone command instead of running it.

Rules it keeps:
  - Only the files recordings.json names for the show move (`--files-from`),
    never a whole prefix: R2 show prefixes can hold orphaned duplicates
    (CLAUDE.md), and they must not be copied into the backup.
  - Pushes to gdrive: can stall mid-file and `--timeout` does not catch it
    (CLAUDE.md), so every copy runs under `--max-duration` and repeats until
    `rclone check` (MD5 on both sides: Drive keeps one, and R2's ETag is the
    MD5 for these single-part objects) reports nothing missing or differing.
  - Orphan deletion is opt-in, limited to *.flac / *.mp3 directly under
    Processed/ whose basename the catalog does not name, and listed before it
    runs. processing_report.txt and anything else there is left alone.
  - Nothing here touches R2 or the Drive source masters.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R2 = "r2:hannan-audio"
DRIVE_WORK = "gdrive:DAT Tapes/Work Folder"
MAX_DURATION = "15m"
ATTEMPTS = 6
DRY = False


def run(cmd, **kw):
    print("  $", " ".join(f'"{c}"' if " " in c else c for c in cmd), flush=True)
    if DRY:
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
    return subprocess.run(cmd, text=True, **kw)


def load_shows():
    d = json.load(open(os.path.join(ROOT, "data", "recordings.json")))
    return [s for s in d["shows"] if s.get("tracks") and not s.get("hidden")]


def folder_of(show):
    return show["tracks"][0]["file"].split("/")[1]


def wanted_names(show):
    """Basenames the catalog publishes for this show: the FLAC and the MP3
    proxy per track."""
    flacs = [os.path.basename(t["flac"]) for t in show["tracks"] if t.get("flac")]
    mp3s = [os.path.basename(t["file"]) for t in show["tracks"]]
    return flacs, mp3s


def lsl(path, flags=()):
    r = subprocess.run(["rclone", "lsl", path, *flags], capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        return None
    out = {}
    for line in r.stdout.splitlines():
        parts = line.split(None, 3)
        if len(parts) == 4:
            out[parts[3]] = int(parts[0])
    return out


def sweep(shows):
    """Name + size comparison, listings only. Returns the slugs that differ."""
    print(f"{'show':42} {'R2':>3} {'same':>4} {'diff':>4} {'miss':>4} {'extra':>5}")
    flagged = []
    for s in shows:
        folder = folder_of(s)
        flacs, mp3s = wanted_names(s)
        want = set(flacs) | set(mp3s)
        r2 = {}
        for top in ("FLAC", "MP3"):
            r2.update(lsl(f"{R2}/{top}/{folder}", ("--s3-no-check-bucket",)) or {})
        r2 = {n: sz for n, sz in r2.items() if n in want}
        dr = lsl(f"{DRIVE_WORK}/{folder}/Processed")
        if dr is None:
            print(f"{s['slug']:42} {len(r2):>3}  NO Processed/ folder")
            flagged.append(s["slug"])
            continue
        same = sum(1 for n, sz in r2.items() if dr.get(n) == sz)
        diff = sum(1 for n, sz in r2.items() if n in dr and dr[n] != sz)
        miss = sum(1 for n in r2 if n not in dr)
        extra = [n for n in dr if n not in want and n.lower().endswith((".flac", ".mp3"))]
        print(f"{s['slug']:42} {len(r2):>3} {same:>4} {diff:>4} {miss:>4} {len(extra):>5}")
        if diff or miss or extra:
            flagged.append(s["slug"])
    print(f"\n{len(flagged)} of {len(shows)} shows differ from R2 (by name and size) or carry orphans")
    return flagged


def check(src, dst, listing):
    """rclone check by hash, restricted to the named files. Returns True when
    nothing is missing or differing."""
    r = run(["rclone", "check", src, dst, "--files-from", listing, "--s3-no-check-bucket", "--one-way"],
            capture_output=True)
    if DRY:
        return True
    ok = r.returncode == 0
    if not ok:
        tail = (r.stderr or "").strip().splitlines()[-3:]
        print("    check: " + " | ".join(tail))
    return ok


def resync(show, delete_orphans):
    folder = folder_of(show)
    dst = f"{DRIVE_WORK}/{folder}/Processed"
    flacs, mp3s = wanted_names(show)
    print(f"\n== {show['slug']}  ({folder}): {len(flacs)} FLAC + {len(mp3s)} MP3 -> {dst}")
    all_ok = True
    with tempfile.TemporaryDirectory() as tmp:
        for top, names in (("FLAC", flacs), ("MP3", mp3s)):
            if not names:
                continue
            listing = os.path.join(tmp, f"{top}.txt")
            with open(listing, "w") as fh:
                fh.write("".join(n + "\n" for n in names))
            src = f"{R2}/{top}/{folder}"
            done = False
            for attempt in range(1, ATTEMPTS + 1):
                if check(src, dst, listing):
                    print(f"  {top}: Drive matches R2 by hash ({len(names)} files)")
                    done = True
                    break
                print(f"  {top}: copy attempt {attempt}/{ATTEMPTS}")
                run(["rclone", "copy", src, dst, "--files-from", listing, "--s3-no-check-bucket",
                     "--max-duration", MAX_DURATION, "--transfers", "2", "--stats", "60s", "--stats-one-line"])
                if DRY:
                    done = True
                    break
            if not done:
                print(f"  {top}: STILL DIFFERS after {ATTEMPTS} attempts")
                all_ok = False
    # orphans: FLAC/MP3 directly under Processed/ the catalog does not name
    have = lsl(dst) or {}
    want = set(flacs) | set(mp3s)
    orphans = sorted(n for n in have if n not in want and n.lower().endswith((".flac", ".mp3")))
    if orphans:
        print(f"  {len(orphans)} orphan(s) under Processed/ not named by the catalog:")
        for n in orphans:
            print(f"    - {n}")
        if delete_orphans:
            for n in orphans:
                run(["rclone", "deletefile", f"{dst}/{n}"])
        else:
            print("  (left in place; pass --delete-orphans to remove them)")
    return all_ok


def main():
    global DRY
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("slugs", nargs="*")
    p.add_argument("--sweep", action="store_true", help="list which shows differ; change nothing")
    p.add_argument("--all", action="store_true", help="resync every show the sweep flags")
    p.add_argument("--delete-orphans", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    DRY = args.dry_run
    shows = load_shows()
    by_slug = {s["slug"]: s for s in shows}
    if args.sweep or args.all:
        flagged = sweep(shows)
        if args.sweep:
            return
        targets = flagged
    else:
        targets = args.slugs
    unknown = [t for t in targets if t not in by_slug]
    if unknown:
        raise SystemExit(f"unknown or hidden/untracked slug(s): {unknown}")
    if not targets:
        print("nothing to do")
        return
    failed = [t for t in targets if not resync(by_slug[t], args.delete_orphans)]
    print(f"\n{len(targets) - len(failed)}/{len(targets)} shows in step with R2"
          + (f"; STILL DIFFERING: {failed}" if failed else ""))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
