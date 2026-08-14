#!/usr/bin/env python3
"""Verify the data-item markup in the generated show pages.

Guards the player-consolidation work (plans/player-consolidation/): every
playable thing on a show page carries a normalized item as a data-item JSON
attribute, which the shared player reads instead of fetching a catalog. That
markup is generated, so nothing in build.py --check (which validates *source*
data) looks at it.

These assertions are not hypothetical: the one-off version of this check caught
a real recording-ID collision on mad-sweetwater-2000-10-17, where a WAV and a
FLAC transfer of the same tape share one MP3 stream proxy and so produced two
cards claiming the same id.

Run after a build:
  python3 scripts/build.py && python3 scripts/verify_markup.py
"""
import glob
import html
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ITEM_RE = re.compile(r'data-item="([^"]*)"')
# A track row carries data-src and data-item on the same element; a recording
# card carries data-item on .recording-item with data-src on the inner player.
ROW_RE = re.compile(r'<div class="track-row[^"]*"[^>]*data-src="([^"]*)"[^>]*data-item="([^"]*)"')
CARD_RE = re.compile(r'<div class="recording-item" data-item="([^"]*)">.*?<div class="custom-player" data-src="([^"]*)"', re.S)

REQUIRED = ("id", "kind", "streamUrl", "title", "playLabel")


def check():
    errors, n_track, n_rec, n_pages = [], 0, 0, 0

    show_pages = sorted(glob.glob(os.path.join(ROOT, "shows", "*", "index.html")))
    if not show_pages:
        return ["no generated show pages found — run scripts/build.py first"], 0, 0, 0

    for path in show_pages:
        rel = os.path.relpath(path, ROOT)
        src = open(path).read()
        n_pages += 1
        ids = []

        for raw in ITEM_RE.findall(src):
            try:
                item = json.loads(html.unescape(raw))
            except Exception as e:
                errors.append(f"{rel}: unparseable data-item ({e})")
                continue
            ids.append(item.get("id"))
            for field in REQUIRED:
                if not item.get(field):
                    errors.append(f"{rel}: item {item.get('id')!r} missing required field {field!r}")
            if item.get("kind") not in ("track", "recording"):
                errors.append(f"{rel}: item {item.get('id')!r} has bad kind {item.get('kind')!r}")
            if item.get("kind") == "track":
                n_track += 1
                if item.get("durationSec") is None:
                    errors.append(f"{rel}: track {item.get('id')!r} has no durationSec")
                if not item.get("peaksKey"):
                    errors.append(f"{rel}: track {item.get('id')!r} has no peaksKey")
            else:
                n_rec += 1
            # The lossless original is only reachable via /auth + /download;
            # /stream 403s it. Publishing a stream URL here would be publishing
            # an address guaranteed to fail.
            loss = (item.get("downloads") or {}).get("lossless")
            if loss and "://" in str(loss.get("key", "")):
                errors.append(f"{rel}: item {item.get('id')!r} downloads.lossless.key is a URL, expected an R2 key")

        # Two views decide which is active by comparing ids, so a duplicate
        # would light up both.
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        if dupes:
            errors.append(f"{rel}: DUPLICATE item ids on one page: {dupes}")

        # The new engine must play exactly what the legacy one plays.
        for data_src, raw in ROW_RE.findall(src):
            item = json.loads(html.unescape(raw))
            if html.unescape(data_src) != item["streamUrl"]:
                errors.append(f"{rel}: track {item['id']!r} streamUrl != legacy data-src")
        for raw, data_src in CARD_RE.findall(src):
            item = json.loads(html.unescape(raw))
            if html.unescape(data_src) != item["streamUrl"]:
                errors.append(f"{rel}: recording {item['id']!r} streamUrl != legacy data-src")

    # Song pages deliberately stay on the legacy engine this phase.
    for path in glob.glob(os.path.join(ROOT, "songs", "*", "index.html")):
        if "data-item" in open(path).read():
            errors.append(f"{os.path.relpath(path, ROOT)}: song pages must not carry data-item yet "
                          "(they migrate in a later phase)")

    return errors, n_track, n_rec, n_pages


def main():
    errors, n_track, n_rec, n_pages = check()
    if errors:
        print(f"markup integrity FAILED — {len(errors)} problem(s):")
        for e in errors[:40]:
            print(f"  - {e}")
        if len(errors) > 40:
            print(f"  ... and {len(errors) - 40} more")
        sys.exit(1)
    print(f"markup OK — {n_track + n_rec} items ({n_track} tracks, {n_rec} recordings) "
          f"across {n_pages} generated show pages")


if __name__ == "__main__":
    main()
