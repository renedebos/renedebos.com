#!/usr/bin/env python3
"""Reconcile the Drive source split filenames with the recordings.json titles.

Why this is a separate command and NOT part of `make build`
----------------------------------------------------------
The build is contractually deterministic -- CI runs it and fails if the
committed site differs by a byte -- and it has no Drive credentials. Renaming
files in the archive source of truth is also not something a command you run
twenty times a day should do unattended. So `make build` only ever *warns*,
offline, from the cached listing this script writes; the renaming happens here,
deliberately, and dry-run by default.

What it does
------------
Retitling a song in the metadata editor changes the catalog but not the source
filename on Drive, and batch_process.validate() compares the two positionally.
Enough drift in one show and the next reprocess is HELD with 'title-mismatch'.
This script closes that gap: it lists each show's Drive Tracks/ folder, reports
every position whose filename no longer matches the catalog title, and (with
--apply) renames the Drive file to '<NN> <Catalog Title>.<ext>'.

It also refreshes data/source_names.json, the tracked cache the build reads.
Nothing is renamed unless the listing is cleanly aligned (one file per track,
numbers 1..N), because without that the mapping itself is in doubt and a rename
would cement the wrong title onto the wrong audio.

Usage
-----
  python3 scripts/sync_source_titles.py                 # dry run, every show
  python3 scripts/sync_source_titles.py --only SLUG
  python3 scripts/sync_source_titles.py --apply          # actually rename
  python3 scripts/sync_source_titles.py --only SLUG --folder "Drive Folder Name"
  python3 scripts/sync_source_titles.py --refresh-only    # just update the cache

  make sync-titles            # dry run
  make sync-titles APPLY=1    # rename
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import title_match as tm  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "recordings.json")
CACHE = os.path.join(ROOT, "data", "source_names.json")
WORK_ROOT = os.path.expanduser("~/work")
DRIVE_WORK = "gdrive:DAT Tapes/Work Folder"

# rclone to Drive stalls mid-operation without ever returning; --timeout does
# not catch it. Bound each attempt and retry until a deadline instead.
ATTEMPT_TIMEOUT = 90      # seconds per rclone invocation
MAX_DURATION = 600        # seconds to keep retrying one rename

# Shows whose Drive source can't be found by date alone. A LIST means the
# published show is stitched from more than one tape folder: each part carries
# the catalog track number its own local 1..N numbering starts at.
SOURCE_FOLDERS = {
    # No date in the catalog, so nothing to match a folder name against.
    "sean-19-broadway-unknown": "SeanHannan - 19 Broadway unknown date",

    # Two tapes, one published show, and the Drive folder names are misleading.
    # The unlabelled folder is the FIRST tape (catalog 1-14, the clean 14-song
    # set). The folder named "Pt1 Distorted" is the distorted tape and is the
    # SECOND part of the published show (catalog 15-21) -- "Pt1" in its name
    # refers to the reel, not to its position on the show page. Confirmed by
    # Rene 2026-08-20. Do not "correct" this by swapping the order: the catalog
    # is right and the folder name is the thing that's wrong.
    "jerry-19-broadway-1999-08-23": [
        {"folder": "JerryHannan - 19 Broadway 1999-08-23", "first": 1},
        {"folder": "JerryHannan - 19 Broadway 1999-08-23 Pt1 Distorted",
         "first": 15},
    ],
}


def rclone(args, timeout=ATTEMPT_TIMEOUT):
    """Run rclone, returning (ok, stdout). A stall is a failure, not a hang."""
    try:
        r = subprocess.run(["rclone", *args], capture_output=True,
                           text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, ""
    return r.returncode == 0, r.stdout


def rclone_retry(args, label):
    """Retry a mutating rclone call until it succeeds or MAX_DURATION passes."""
    deadline = time.monotonic() + MAX_DURATION
    attempt = 0
    while time.monotonic() < deadline:
        attempt += 1
        ok, _ = rclone(args)
        if ok:
            return True
        print(f"      attempt {attempt} failed/stalled, retrying: {label}")
        time.sleep(5)
    return False


def lsf(path):
    ok, out = rclone(["lsf", path])
    return [l for l in out.splitlines() if l.strip()] if ok else []


def audio(names):
    return sorted(n for n in names if tm.AUDIO_EXT_RE.search(n))


TRACK_SUBS = ("Tracks Noise Reduction", "Tracks")


def find_tracks_sub(folder):
    """(sub, files, None) for a Work Folder's hand-edited tracks, or
    (None, None, reason).

    Same rule as publish_show.find_tracks_source: 'Tracks Noise Reduction/'
    wins over 'Tracks/' and both populated is an error, never a guess. It
    differs only in returning the reason instead of exiting -- one unreadable
    folder must not abort a 30-show sweep, and the caller collects these into
    the 'not checked' list.
    """
    found = {sub: audio(lsf(f"{DRIVE_WORK}/{folder}/{sub}")) for sub in TRACK_SUBS}
    populated = [sub for sub in TRACK_SUBS if found[sub]]
    if len(populated) > 1:
        return None, None, ("BOTH 'Tracks Noise Reduction/' and 'Tracks/' contain "
                            "audio -- delete or archive one; never guessing which "
                            "is canonical")
    if not populated:
        return None, None, ("no track audio found (checked 'Tracks Noise "
                            "Reduction/' and 'Tracks/')")
    sub = populated[0]
    return sub, found[sub], None


_WORK_DIRS = None


def work_dirs():
    """The Work Folder listing, fetched once — it is the same answer for every
    show and 31 identical round-trips to Drive is 31 chances to stall."""
    global _WORK_DIRS
    if _WORK_DIRS is None:
        ok, out = rclone(["lsd", DRIVE_WORK])
        _WORK_DIRS = ([line.split(None, 4)[-1] for line in out.splitlines()
                       if line.split()] if ok else [])
    return _WORK_DIRS


def find_folder(show, override):
    """Sole Drive folder for a show, by date. None if it isn't a clean 1:1."""
    if override:
        return override
    hits = []
    for name in work_dirs():
        if show.get("date") and show["date"] in name:
            hits.append(name)
    return hits[0] if len(hits) == 1 else None


def resolve_parts(show, override):
    """[{folder, sub, first, files}] in published order, or (None, reason).

    A show is usually one tape in one folder starting at track 1. It can also
    be several tapes stitched into one published show, in which case each part
    numbers its own files from 01 and SOURCE_FOLDERS says which catalog track
    that 01 lands on. Everything downstream works on the merged, catalog-
    numbered view, so the multi-tape case stops being special after this point.
    """
    spec = SOURCE_FOLDERS.get(show["slug"])
    if override:
        spec = override
    if spec is None:
        folder = find_folder(show, None)
        if not folder:
            return None, (f"no unique Work Folder for date {show.get('date')!r}"
                          f" -- pass --folder, or add it to SOURCE_FOLDERS")
        spec = folder
    if isinstance(spec, str):
        spec = [{"folder": spec, "first": 1}]

    parts = []
    for p in spec:
        sub, files, err = find_tracks_sub(p["folder"])
        if err:
            return None, f"{p['folder']!r}: {err}"
        parts.append({"folder": p["folder"], "sub": sub,
                      "first": p["first"], "files": files})
    return parts, None


def merge_parts(parts):
    """(catalog-numbered filenames, {catalog filename: (part, real filename)}).

    Each part's local 01.. is shifted onto its catalog range so the whole show
    can be compared and reported as one list. Renames are written back through
    the index, against the part's real folder and its real local numbering --
    a part's own files must stay numbered 1..N, because update_tracks.py and
    the processing engine both key off that leading number.
    """
    merged, index = [], {}
    for part in parts:
        for f in part["files"]:
            local = tm.lead(f)
            if local is None:
                merged.append(f)          # unnumbered: surfaces in misalignment()
                index[f] = (part, f)
                continue
            catalog = part["first"] + local - 1
            name = f"{catalog:02d} {tm.file_title(f)}{ext_of(f)}"
            merged.append(name)
            index[name] = (part, f)
    return sorted(merged, key=lambda f: (tm.lead(f) is None, tm.lead(f) or 0)), index


def sanitize(s):
    """Strip characters illegal in a filename. Same rule as the ZIP entry
    names in sitegen.core, so a source file and its download share a spelling."""
    s = re.sub(r'[<>:"/\\|?*]', "", s)
    return re.sub(r"\s+", " ", s).strip().rstrip(". ")


def ext_of(name):
    m = tm.AUDIO_EXT_RE.search(name)
    return m.group(0).lower() if m else ".flac"


def target_name(local_num, title, old):
    """The file keeps its own leading number; only the title part changes."""
    return f"{local_num:02d} {sanitize(title)}{ext_of(old)}"


def load_cache():
    if not os.path.exists(CACHE):
        return {"shows": {}}
    with open(CACHE) as f:
        return json.load(f)


def save_cache(cache):
    """Written sorted and without timestamps so a re-listing that finds nothing
    changed produces a byte-identical file -- no git churn from a dry run."""
    cache["shows"] = {k: cache["shows"][k] for k in sorted(cache["shows"])}
    with open(CACHE, "w", encoding="utf-8") as f:
        json.dump(cache, f, indent=2, ensure_ascii=False, sort_keys=False)
        f.write("\n")


def misalignment(files, tracks):
    """Why a listing failed tm.aligned() — 'not aligned' on its own sends you
    to Drive to work out which of four different things went wrong."""
    n = len(files), len(tracks)
    if n[0] != n[1]:
        return f"{n[0]} source file(s) for {n[1]} catalog track(s)"
    nums = [tm.lead(f) for f in files]
    bad = [f for f, x in zip(files, nums) if x is None]
    if bad:
        return f"{len(bad)} file(s) lack a leading number, e.g. {bad[0]!r}"
    got = sorted(x for x in nums if x is not None)
    want = list(range(1, n[1] + 1))
    dupes = sorted({x for x in got if got.count(x) > 1})
    missing = sorted(set(want) - set(got))
    extra = sorted(set(got) - set(want))
    bits = []
    if dupes:
        bits.append(f"duplicate number(s) {dupes}")
    if missing:
        bits.append(f"missing {missing}")
    if extra:
        bits.append(f"out-of-range {extra}")
    return "numbering is not a clean 1..%d: %s" % (n[1], "; ".join(bits) or got)


def plan_renames(merged, index, tracks):
    """[(catalog_num, part, old, new, sim)] plus refusals, from the merged view."""
    planned, refused = [], []
    taken = {}                       # folder -> set of names live in it
    for name, (part, real) in index.items():
        taken.setdefault(part["folder"], set()).add(real)
    for num, name, title, sim in tm.drift(merged, tracks):
        part, old = index[name]
        new = target_name(tm.lead(old), title, old)
        if new == old:
            continue
        if new in taken[part["folder"]]:
            refused.append(f"track {num}: {new!r} already exists in "
                           f"{part['folder']}/{part['sub']} (Drive allows "
                           f"same-name duplicates -- resolve by hand)")
            continue
        taken[part["folder"]].discard(old)
        taken[part["folder"]].add(new)
        planned.append((num, part, old, new, sim))
    return planned, refused


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="one slug")
    ap.add_argument("--folder", help="Drive Work Folder name (implies --only)")
    ap.add_argument("--apply", action="store_true", help="actually rename on Drive")
    ap.add_argument("--refresh-only", action="store_true",
                    help="refresh the cached listing, report nothing")
    ap.add_argument("--force", action="store_true",
                    help="rename even for a show with a prepared publish.json")
    args = ap.parse_args()

    if args.folder and not args.only:
        raise SystemExit("--folder needs --only SLUG")

    M = json.load(open(DATA))
    shows = [s for s in M["shows"] if s.get("tracks")]
    if args.only:
        shows = [s for s in shows if s["slug"] == args.only]
        if not shows:
            raise SystemExit(f"slug {args.only!r} not found (or has no tracks)")

    cache = load_cache()
    total_drift = total_renamed = 0
    unreachable = []

    for show in shows:
        slug = show["slug"]
        tracks = show["tracks"]
        parts, err = resolve_parts(show, args.folder)
        if err:
            unreachable.append(f"{slug}: {err}")
            continue

        merged, index = merge_parts(parts)
        cache["shows"][slug] = {
            "parts": [{"folder": p["folder"], "sub": p["sub"],
                       "first": p["first"], "files": p["files"]} for p in parts],
            "files": merged,
        }
        if args.refresh_only:
            continue

        if not tm.aligned(merged, tracks):
            unreachable.append(f"{slug}: {misalignment(merged, tracks)} -- not "
                               f"safe to rename; batch_process holds this show "
                               f"for review anyway")
            continue

        planned, refused = plan_renames(merged, index, tracks)
        if not planned and not refused:
            continue

        allow = tm.hold_allowance(len(tracks))
        where = " + ".join(f"{p['folder']}/{p['sub']}" for p in parts)
        print(f"\n{slug}  [{where}]")
        for num, part, old, new, sim in planned:
            tail = f"   (in {part['folder']})" if len(parts) > 1 else ""
            print(f"  {num:02d}  {old!r}{tail}\n      -> {new!r}   (sim {sim:.2f})")
        for r in refused:
            print(f"  REFUSED {r}")
        total_drift += len(planned)
        if len(planned) > allow:
            print(f"  ** {len(planned)} drifted, batch_process holds above "
                  f"{allow} -- this show would be HELD as 'title-mismatch' **")

        if not args.apply or not planned:
            continue

        state = os.path.join(WORK_ROOT, slug, "publish.json")
        if os.path.exists(state) and not args.force:
            print(f"  SKIPPED: {state} exists -- its manifest and fingerprint "
                  f"are keyed on these filenames, so renaming would invalidate "
                  f"the prepared publish. Finish or discard it, or pass --force.")
            continue

        for num, part, old, new, _ in planned:
            base = f"{DRIVE_WORK}/{part['folder']}/{part['sub']}"
            print(f"  renaming track {num:02d} ...")
            if rclone_retry(["moveto", f"{base}/{old}", f"{base}/{new}"],
                            f"{old} -> {new}"):
                part["files"][part["files"].index(old)] = new
                total_renamed += 1
            else:
                print(f"  FAILED after {MAX_DURATION}s: {old!r} -> {new!r}")
        for p in parts:
            p["files"].sort()
        merged, _ = merge_parts(parts)
        cache["shows"][slug] = {
            "parts": [{"folder": p["folder"], "sub": p["sub"],
                       "first": p["first"], "files": p["files"]} for p in parts],
            "files": merged,
        }

    save_cache(cache)

    if unreachable:
        print("\nnot checked:")
        for u in unreachable:
            print(f"  {u}")
    if args.refresh_only:
        print(f"\ncached listings for {len(cache['shows'])} show(s) -> data/source_names.json")
    elif not total_drift:
        print("\nno title drift between the catalog and the Drive source filenames.")
    elif args.apply:
        print(f"\nrenamed {total_renamed}/{total_drift} drifted file(s) on Drive. "
              f"Commit data/source_names.json.")
    else:
        print(f"\n{total_drift} drifted file(s). Dry run -- nothing was changed. "
              f"Re-run with --apply (make sync-titles APPLY=1) to rename them.")


if __name__ == "__main__":
    main()
