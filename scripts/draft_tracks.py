#!/usr/bin/env python3
"""Draft a processed show's tracks[] into recordings.json.

Reads the processed files in ~/work/<slug>/out/ (durations, sizes), matches
each title against the existing catalog to reuse the established songwriter
and tags (qualifiers like "(incomplete)" are ignored for matching), and
writes the tracks[] array onto the show. Titles the archive has never seen
get empty tags and are FLAGGED for a human call, as are titles whose prior
appearances disagree with each other.

Deliberately NOT touched: description, updates notes, history — those are
written by a person. added/added_ts/processing_status are set (mechanical).

  python3 scripts/draft_tracks.py <slug> [--dry-run]
"""
import argparse
import datetime
import json
import os
import re
import shutil
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK_ROOT = os.path.expanduser("~/work")
QUALIFIER = re.compile(r"\s*\((incomplete|early version|cut|partial|reprise)[^)]*\)\s*$",
                       re.IGNORECASE)


def probe_duration(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "default=noprint_wrappers=1:nokey=1", path],
                       capture_output=True, text=True)
    s = float(r.stdout.strip())
    m, sec = divmod(int(round(s)), 60)
    return f"{m}:{sec:02d}"


def song_key(title):
    return QUALIFIER.sub("", title).strip().lower()


def catalog(M, exclude_slug):
    """title-key -> list of (songwriter, tags-tuple) from every curated track."""
    cat = {}
    for s in M["shows"]:
        if s["slug"] == exclude_slug:
            continue
        for t in (s.get("tracks") or []):
            cat.setdefault(song_key(t["title"]), []).append(
                (t.get("songwriter"), tuple(t.get("tags") or [])))
    return cat


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("slug")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    out = os.path.join(WORK_ROOT, args.slug, "out")
    if not os.path.isdir(out):
        raise SystemExit(f"{out} not found — publish_show.py runs before drafting")
    state = os.path.join(WORK_ROOT, args.slug, "publish.json")
    if not os.path.exists(state):
        raise SystemExit(f"{state} not found — run publish_show.py prepare first")
    r2dir = json.load(open(state))["folder"]

    data_path = os.path.join(ROOT, "data", "recordings.json")
    M = json.load(open(data_path))
    show = next((s for s in M["shows"] if s["slug"] == args.slug), None)
    if show is None:
        raise SystemExit(f"slug {args.slug!r} not in recordings.json")
    cat = catalog(M, args.slug)

    flags, tracks = [], []
    for f in sorted(x for x in os.listdir(out) if x.endswith(".flac")):
        num, title = int(f[:2]), f[3:-5]
        mp3 = f[:-5] + ".mp3"
        if not os.path.exists(os.path.join(out, mp3)):
            raise SystemExit(f"missing MP3 twin for {f}")
        t = {"num": num, "title": title,
             "duration": probe_duration(os.path.join(out, f)),
             "size_mb": max(1, round(os.path.getsize(os.path.join(out, mp3)) / 1e6)),
             "file": f"MP3/{r2dir}/{mp3}",
             "flac": f"FLAC/{r2dir}/{f}",
             "flac_size_mb": max(1, round(os.path.getsize(os.path.join(out, f)) / 1e6)),
             "processed": True, "tags": []}
        prior = cat.get(song_key(title))
        if prior:
            variants = sorted(set(prior), key=prior.count, reverse=True)
            sw, tags = variants[0]
            if sw:
                t["songwriter"] = sw
            t["tags"] = list(tags)
            if len(variants) > 1:
                flags.append(f"{num:02d} {title!r}: prior appearances disagree "
                             f"({len(variants)} variants) — drafted the most common")
        else:
            flags.append(f"{num:02d} {title!r}: NEW to the archive — needs "
                         "songwriter + tags by hand")
        # keep the track dict key order consistent with the rest of the catalog
        order = ["num", "title", "songwriter", "duration", "size_mb", "file",
                 "flac", "flac_size_mb", "processed", "tags"]
        tracks.append({k: t[k] for k in order if k in t})

    now = datetime.datetime.now()
    show["tracks"] = tracks
    show["added"] = now.date().isoformat()
    show["added_ts"] = now.isoformat()
    show["processing_status"] = "done"

    print(f"{args.slug}: drafted {len(tracks)} tracks "
          f"({len(tracks) - len(flags)} matched from catalog)")
    for fl in flags:
        print(f"  FLAG {fl}")
    if args.dry_run:
        print("(dry run — recordings.json untouched)")
        return
    shutil.copy(data_path, data_path.replace(".json", f".backup.draft.json"))
    json.dump(M, open(data_path, "w"), indent=2, ensure_ascii=False)
    open(data_path, "a").write("\n")
    print("written — still human: per-track review of flags, description (list), "
          "updates note, history.html, build")


if __name__ == "__main__":
    main()
