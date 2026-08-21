#!/usr/bin/env python3
"""Positional matching between the Drive source split files and the catalog.

Three callers need the *same* answer or the workflow is incoherent:

  - batch_process.validate() HOLDs a show whose source filenames no longer
    line up with the catalog titles,
  - sync_source_titles.py renames the Drive files to close that gap,
  - sitegen.core.check_source_title_drift() warns at build time, off a cached
    listing, about drift that is heading for that hold.

Keeping the thresholds in one module is the whole point: a build that warns at
a different threshold than the one that holds is worse than no warning at all.
"""
import difflib
import os
import re

TITLE_SIM = 0.55          # positional title similarity floor

AUDIO_EXT_RE = re.compile(r"\.(flac|wav)$", re.I)
LEAD_NUM_RE = re.compile(r"^\s*\d+\s*")


def norm_title(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def lead(name):
    """Leading track number in a source filename, or None."""
    m = re.match(r"\s*(\d+)", os.path.basename(name))
    return int(m.group(1)) if m else None


def file_title(name):
    """'07 The Galway Shawl.flac' -> 'The Galway Shawl'."""
    stem = AUDIO_EXT_RE.sub("", os.path.basename(name))
    return LEAD_NUM_RE.sub("", stem).strip()


def similarity(filename, title):
    return difflib.SequenceMatcher(
        None, norm_title(file_title(filename)), norm_title(title)).ratio()


def hold_allowance(n_tracks):
    """How many positional title mismatches still read as deliberate renames
    rather than a shifted mapping. Above this, batch_process HOLDs the show."""
    return max(1, int(0.15 * n_tracks))


def aligned(files, tracks):
    """True when the filenames can be trusted for positional comparison at
    all: one file per track, every file numbered, numbers a clean 1..N.

    Renaming is only ever safe under this precondition. Without it the mapping
    itself is in question, and renaming would cement the wrong title onto the
    wrong audio -- the exact failure the batch validation gate exists to catch.
    """
    n = len(tracks)
    if not files or len(files) != n:
        return False
    nums = [lead(f) for f in files]
    if any(x is None for x in nums):
        return False
    return sorted(nums) == list(range(1, n + 1))


def drift(files, tracks):
    """[(num, filename, catalog_title, similarity)] for each position whose
    source filename no longer matches the catalog title. Sorted by track."""
    by_num = {lead(f): f for f in files}
    out = []
    for t in sorted(tracks, key=lambda t: t.get("num") or 0):
        n, title = t.get("num"), (t.get("title") or "").strip()
        fn = by_num.get(n)
        if not fn or not title:
            continue
        sim = similarity(fn, title)
        if sim < TITLE_SIM:
            out.append((n, fn, title, sim))
    return out
