#!/usr/bin/env python3
"""Overnight batch stager for the AUDIO_PROCESSING.md workflow.

Pulls, validates, diagnoses, and PROCESSES every not-yet-done track-listed show
to the per-artist target (now -20 LUFS for all), writing the processed masters +
provenance sidecars locally. It deliberately STOPS BEFORE PUBLISHING — no R2
upload, no git push, no Drive mirror. Those outward-facing, hard-to-reverse steps
stay a human-reviewed morning step; this tool just does the slow, safe,
reversible 90% (rclone pull + two-pass loudnorm) unattended and leaves a report.

Why a hard validation gate (the important part)
-----------------------------------------------
Source split files cannot be trusted to match the published track list. Of the
first 7 actionable shows, 2 had defects: one was mis-numbered (duplicate "18",
off-by-one to the end) and one had 20 files for an 18-track show with two
unnumbered extras. Both the engine and update_tracks.py key off the filename's
leading number, so either would have silently put the wrong audio on the wrong
track. So before touching a show this tool checks, against data/recordings.json:
  - file count matches the track count,
  - leading numbers form a clean 1..N,
  - each file maps positionally to the right track by title (fuzzy).
Any mismatch -> the show is HELD for human review, never processed. Validation
runs on the REMOTE file listing first, so a broken show is held without ever
being downloaded.

Other gates
-----------
  - CLIPPING in any track (diagnose) -> HELD (needs manual declip first).
  - Suspiciously flat input loudness (small spread, near a standard target) ->
    WARN "possibly pre-normalized" (raw live masters vary widely). Still staged,
    but the report tells you to confirm you pulled the raw master, not a prior
    normalized pass. (Known cases: sean 2000-02-21, mad 2001-01-06 were
    normalized to -16 off the books; pull from Tracks/, not Normalized Tracks/.)
  - Engine self-verify warning (TP/LUFS drift) -> staged WITH WARNING for review.

Usage
-----
  python3 scripts/batch_process.py              # stage all not-done shows
  python3 scripts/batch_process.py --only SLUG  # one show
  python3 scripts/batch_process.py --list       # show config + current status, do nothing
  python3 scripts/batch_process.py --no-process  # validate + diagnose only (dry-ish)

Overnight:  nohup python3 scripts/batch_process.py >~/work/batch.log 2>&1 &
Resumable:  rclone pull and the engine both skip existing outputs, so re-running
            continues where it left off. Already-done shows are skipped.
"""
import argparse
import datetime
import difflib
import os
import re
import subprocess
import sys

import audio_process as eng   # reuse ARTIST_TARGET, status logic, ROOT, helpers
import json

ROOT = eng.ROOT
WORK = os.path.expanduser("~/work")
DRIVE_BASE = "gdrive:DAT Tapes/Work Folder"
DRIVE_FLAGS = ["--drive-shared-with-me"]

# slug -> Drive folder under DRIVE_BASE (audio pulled from "<folder>/Tracks").
# Always pull the raw "Tracks/" subfolder, never a "Normalized Tracks/" variant.
SHOWS = {
    "sean-19-broadway-2000-01-24": "SeanHannan - 19 Broadway 2000-01-24",
    "sean-19-broadway-2000-02-21": "SeanHannan - 19 Broadway 2000-02-21",
    "sean-19-broadway-unknown":    "SeanHannan - 19 Broadway unknown date",
    "mad-sweetwater-2000-10-17":   "MadHannans - Sweetwater 2000-10-17 SBD",
    "mad-cafe-java-1999-09-09":    "MadHannans - Cafe Java 1999-09-09",
    "mad-sweetwater-2001-01-06":   "MadHannans - Sweetwater 2001-01-06",
}
# Shows known to have been normalized off the books (no sidecar) — pull raw.
KNOWN_PRENORM = {"sean-19-broadway-2000-02-21", "mad-sweetwater-2001-01-06"}

TITLE_SIM = 0.55          # positional title similarity floor
PRENORM_SPREAD = 2.0      # input-LUFS stdev below this => suspect pre-normalized


def norm_title(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def lead(name):
    m = re.match(r"\s*(\d+)", os.path.basename(name))
    return int(m.group(1)) if m else None


def load_show(slug):
    data = json.load(open(os.path.join(ROOT, "data", "recordings.json")))
    return next((s for s in data["shows"] if s["slug"] == slug), None)


def remote_flacs(folder):
    """List *.flac filenames in '<folder>/Tracks' without downloading."""
    r = subprocess.run(
        ["rclone", "lsf", f"{DRIVE_BASE}/{folder}/Tracks", *DRIVE_FLAGS,
         "--include", "*.flac"],
        capture_output=True, text=True)
    if r.returncode != 0:
        return None
    return sorted(x for x in r.stdout.splitlines() if x.strip())


def validate(slug, show, files):
    """Return (ok, reason, details, warnings). Pure name/title check — no audio.

    Hard fails (HELD): no source, count mismatch, unnumbered files, numbering not
    a clean 1..N, or *multiple* positional title mismatches (== the mapping is
    shifted, like an off-by-one). A *single* isolated title mismatch on otherwise
    aligned, cleanly-numbered files is treated as a likely catalog rename (e.g.
    'Irish Song' -> 'Ode to Biddy McGee') and passed as a WARNING, not a hold.
    """
    tracks = show.get("tracks") or []
    nt = len(tracks)
    if not files:
        return False, "no-source", "no .flac files found in Tracks/", []
    nums = [lead(f) for f in files]
    if len(files) != nt:
        return False, "count-mismatch", f"recordings.json {nt} tracks, Drive {len(files)} files", []
    if any(n is None for n in nums):
        return False, "unnumbered", f"{sum(n is None for n in nums)} file(s) lack a leading number", []
    if sorted(nums) != list(range(1, nt + 1)):
        return False, "numbering", f"leading numbers not a clean 1..{nt}: {sorted(nums)}", []
    # positional title check (files by leading number vs tracks by num)
    by_num_file = {lead(f): f for f in files}
    by_num_trk = {t["num"]: t for t in tracks}
    mism = []
    for n in range(1, nt + 1):
        ftitle = norm_title(re.sub(r"^\s*\d+\s*", "", re.sub(r"\.flac$", "", by_num_file[n], flags=re.I), flags=re.I))
        ttitle = norm_title(by_num_trk[n].get("title", ""))
        if not ttitle:
            continue
        sim = difflib.SequenceMatcher(None, ftitle, ttitle).ratio()
        if sim < TITLE_SIM:
            mism.append((n, by_num_file[n], by_num_trk[n].get("title"), sim))
    # multiple mismatches => the mapping is shifted, not a rename => HOLD
    allow = max(1, int(0.15 * nt))
    if len(mism) > allow:
        first = "; ".join(f"trk {n}: {fn!r} vs {tt!r}" for n, fn, tt, _ in mism[:3])
        return False, "title-mismatch", f"{len(mism)} tracks misaligned ({first} ...)", []
    warns = [f"title differs at track {n}: file {fn!r} vs catalog {tt!r} (sim {s:.2f}) — "
             f"likely a rename; confirm it's the same song" for n, fn, tt, s in mism]
    return True, "ok", f"{nt} tracks, numbering aligned", warns


def pull(slug, folder):
    dest = os.path.join(WORK, slug, "input")
    os.makedirs(dest, exist_ok=True)
    r = subprocess.run(
        ["rclone", "copy", f"{DRIVE_BASE}/{folder}/Tracks", dest, *DRIVE_FLAGS,
         "--include", "*.flac", "--max-depth", "1"],
        capture_output=True, text=True)
    return r.returncode == 0, dest, r.stderr


def run_diagnose(slug, dest, artist):
    r = subprocess.run(
        ["python3", os.path.join(ROOT, "scripts", "audio_process.py"),
         "diagnose", dest, "--artist", artist],
        capture_output=True, text=True)
    lufs, clip_tracks = [], []
    for line in r.stdout.splitlines():
        m = re.search(r"in (-?\d+\.\d+) LUFS", line)
        if m:
            lufs.append(float(m.group(1)))
        if re.search(r"clip CLIPPING", line):
            clip_tracks.append(line.split(":")[0].strip())
    return lufs, clip_tracks


def stdev(xs):
    if len(xs) < 2:
        return 0.0
    m = sum(xs) / len(xs)
    return (sum((x - m) ** 2 for x in xs) / (len(xs) - 1)) ** 0.5


def run_process(slug, dest, target):
    out = os.path.join(WORK, slug, "processed")
    r = subprocess.run(
        ["python3", os.path.join(ROOT, "scripts", "audio_process.py"),
         "process", dest, out, "--target", str(target), "--slug", slug],
        capture_output=True, text=True)
    # engine exits 0 = clean, 2 = within-tol warnings, other = failure
    return r.returncode, out, r.stdout, r.stderr


def already_done(slug, show):
    return eng.show_status(show) == "done"


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", help="process just this slug")
    ap.add_argument("--list", action="store_true", help="print config + status, do nothing")
    ap.add_argument("--no-process", action="store_true", help="validate + diagnose only")
    args = ap.parse_args()

    slugs = [args.only] if args.only else list(SHOWS)
    if args.list:
        print(f"{'STATUS':10s} {'TARGET':>7s}  SLUG")
        for slug in slugs:
            show = load_show(slug)
            st = eng.show_status(show) if show else "??"
            tgt = eng.ARTIST_TARGET.get(show["artist"], "?") if show else "?"
            print(f"{st:10s} {str(tgt):>7s}  {slug}  <- {SHOWS.get(slug,'?')}")
        return

    results = []
    for slug in slugs:
        folder = SHOWS.get(slug)
        show = load_show(slug)
        if not show:
            results.append((slug, "HELD", "unknown-slug", "not in recordings.json", {}))
            continue
        if already_done(slug, show):
            results.append((slug, "SKIP", "done", "already processed", {}))
            print(f"[{slug}] SKIP — already done")
            continue
        artist = show["artist"]
        target = eng.ARTIST_TARGET.get(artist)
        info = {"artist": artist, "target": target}

        # 1. remote validation (no download)
        files = remote_flacs(folder)
        ok, reason, detail, vwarns = validate(slug, show, files or [])
        if not ok:
            results.append((slug, "HELD", reason, detail, info))
            print(f"[{slug}] HELD ({reason}) — {detail}")
            continue
        info["tracks"] = len(files)
        warns = list(vwarns)

        # 2. pull
        print(f"[{slug}] validated ({detail}); pulling...")
        pok, dest, perr = pull(slug, folder)
        if not pok:
            results.append((slug, "HELD", "pull-failed", perr[-200:], info))
            print(f"[{slug}] HELD (pull-failed)")
            continue

        # 3. diagnose
        lufs, clips = run_diagnose(slug, dest, artist)
        if lufs:
            info["lufs_range"] = f"{min(lufs):.1f}..{max(lufs):.1f}"
            info["lufs_spread"] = round(stdev(lufs), 2)
        if clips:
            results.append((slug, "HELD", "clipping", f"{len(clips)} track(s): {', '.join(clips[:3])}", info))
            print(f"[{slug}] HELD (clipping) — {len(clips)} track(s)")
            continue
        if lufs and stdev(lufs) < PRENORM_SPREAD:
            warns.append(f"possibly pre-normalized (LUFS spread {stdev(lufs):.2f}; confirm raw source)")
        if slug in KNOWN_PRENORM:
            warns.append("known prior -16 pass — confirm pulled Tracks/ (raw), not the normalized variant")

        if args.no_process:
            results.append((slug, "VALID", "diagnosed", "; ".join(warns) or "clean", info))
            print(f"[{slug}] VALID (no-process) {'· ' + '; '.join(warns) if warns else ''}")
            continue

        # 4. process
        print(f"[{slug}] processing to {target} LUFS...")
        rc, out, sout, serr = run_process(slug, dest, target)
        if rc not in (0, 2):
            results.append((slug, "HELD", "process-failed", serr[-200:], info))
            print(f"[{slug}] HELD (process-failed)")
            continue
        if rc == 2:
            warns.append("engine flagged within-tolerance TP/LUFS drift — review processing_report.txt")
        status = "STAGED-WARN" if warns else "STAGED"
        results.append((slug, status, "processed", "; ".join(warns) or "clean", info))
        print(f"[{slug}] {status}")

    write_report(results)


def write_report(results):
    today = datetime.date.today().isoformat()
    path = os.path.join(WORK, f"batch_report_{today}.md")
    os.makedirs(WORK, exist_ok=True)
    order = {"STAGED": 0, "STAGED-WARN": 1, "VALID": 2, "HELD": 3, "SKIP": 4}
    results.sort(key=lambda r: order.get(r[1], 9))
    L = [f"# Batch report — {today}", ""]
    tally = {}
    for _, st, *_ in results:
        tally[st] = tally.get(st, 0) + 1
    L.append("  ".join(f"**{k}**: {v}" for k, v in sorted(tally.items(), key=lambda x: order.get(x[0], 9))))
    L.append("")
    for slug, st, reason, detail, info in results:
        L.append(f"## {slug} — {st}")
        meta = []
        if info.get("target") is not None:
            meta.append(f"target {info['target']} LUFS")
        if info.get("tracks"):
            meta.append(f"{info['tracks']} tracks")
        if info.get("lufs_range"):
            meta.append(f"input {info['lufs_range']} LUFS (spread {info.get('lufs_spread')})")
        if meta:
            L.append("- " + " · ".join(meta))
        L.append(f"- {reason}: {detail}")
        if st in ("STAGED", "STAGED-WARN"):
            L += publish_block(slug, info)
        L.append("")
    open(path, "w").write("\n".join(L) + "\n")
    print(f"\n{'='*60}\nReport -> {path}")
    print("  ".join(f"{k}: {v}" for k, v in sorted(tally.items(), key=lambda x: order.get(x[0], 9))))
    staged = [r[0] for r in results if r[1] in ("STAGED", "STAGED-WARN")]
    held = [(r[0], r[2]) for r in results if r[1] == "HELD"]
    if held:
        print("HELD (need you):", ", ".join(f"{s} [{why}]" for s, why in held))
    if staged:
        print(f"Staged & ready to publish in the morning: {', '.join(staged)}")
        print("Review the report, then run the publish block for each staged show.")


def publish_block(slug, info):
    folder = SHOWS.get(slug, "<folder>")
    return [
        "- **Staged. To publish (review first):**",
        "  ```",
        f"  cd {ROOT}",
        f"  python3 scripts/update_tracks.py {slug} ~/work/{slug}/processed",
        f"  python3 scripts/gen_peaks.py --slug {slug}",
        f"  python3 scripts/audio_process.py status --write",
        f"  # add an Updates note for {slug} (report:true) in data/recordings.json",
        f"  # update build_history() in scripts/build.py (standing requirement)",
        f"  python3 scripts/build.py",
        f"  git add -A && git commit && git push",
        f'  rclone copy ~/work/{slug}/processed "{DRIVE_BASE}/{folder}/Processed" \\',
        f"    --drive-shared-with-me --exclude '*.txt'",
        f"  python3 scripts/audio_process.py verify {slug}",
        "  ```",
    ]


if __name__ == "__main__":
    main()
