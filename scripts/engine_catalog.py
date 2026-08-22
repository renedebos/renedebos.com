"""Catalog/provenance helpers: recordings.json tag lookups (show_tags,
tag_args -- used both by process/retag and directly imported by
make_stream_mp3.py) and the resume-proof recipe hash (recipe_signature,
which lets a resume decision prove "this run would compute the identical
recipe" instead of trusting mtime alone). Moved out of audio_process.py
2026-08-22 verbatim.
"""
import hashlib
import json
import os
import re

from engine_constants import ROOT
from engine_versioning import WORKFLOW_VERSION


def show_tags(slug):
    """Per-show tag context from recordings.json: (artist name, album string).
    None if the slug isn't in the catalog (tags are then skipped)."""
    try:
        data = json.load(open(os.path.join(ROOT, "data", "recordings.json")))
        show = next(s for s in data["shows"] if s["slug"] == slug)
        artist = next((a["name"] for a in data["artists"] if a["id"] == show["artist"]),
                      show["artist"].title())
        venue = show.get("venue_short") or show.get("venue") or ""
        when = show.get("date_display") or show.get("date") or ""
        album = f"{venue} — {when}" if venue and when else (venue or when or slug)
        year = (show.get("date") or "")[:4]
        return {"artist": artist, "album": album, "year": year}
    except (StopIteration, FileNotFoundError, json.JSONDecodeError):
        return None


def tag_args(ctx, filename, num, total, target, title=None):
    """ffmpeg -metadata args for one track. Works for FLAC (vorbis comments)
    and MP3 (id3v2) alike — ffmpeg maps the generic keys per container.
    `title` overrides the filename-derived title: retag passes the catalog
    title so a `make edit` retitle flows into the files; at process time the
    catalog entry doesn't exist yet, so the filename is the only source."""
    if ctx is None:
        return []
    title = title or re.sub(r"^\d+\s+", "", os.path.splitext(filename)[0])
    pairs = {
        "title": title, "artist": ctx["artist"], "album_artist": ctx["artist"],
        "album": ctx["album"],
        "track": f"{num}/{total}" if num is not None else None,
        "date": ctx["year"] or None,
        "comment": f"The Hannan Tapes (renedebos.com) — loudness-normalized "
                   f"to {int(target)} LUFS",
    }
    out = []
    for k, v in pairs.items():
        if v:
            out += ["-metadata", f"{k}={v}"]
    return out


def recipe_signature(target, filt, tc_on, tc_partial, tc_force, tc_maxgr,
                     tc_over_applause=False):
    """Hash of everything that fully determines one track's render — apart
    from the source audio itself — so a resume decision can prove "this run
    would compute the identical recipe" instead of just "an output file
    happens to exist and isn't older than the source". Previously a resume
    trusted mtime alone: a later run requesting a different target, filter
    chain, or transient-cap treatment for the same track could silently
    reuse stale audio while still writing provenance describing the newly
    requested (but never actually rendered) chain. Workflow version is
    included because a version bump can change what a given mode/target
    combination actually renders even with identical CLI flags.

    New keys must be added CONDITIONALLY, only when the option is actually in
    use. The signature is compared against ones persisted beside outputs
    rendered by earlier runs, so a key emitted unconditionally changes the
    hash of every existing track — turning any resume into a full re-render
    and re-arming every transient-cap listen-block that was already accepted.
    `transient_cap_over_applause` is the first such key: off (the ordinary
    publish path, and the entire existing archive) it stays out of the
    payload and those signatures are byte-identical to what v8 already
    wrote."""
    payload = {
        "workflow_version": WORKFLOW_VERSION, "target": target, "filters": filt,
        "transient_cap": tc_on, "transient_cap_partial": tc_partial,
        "transient_cap_force": tc_force, "transient_cap_max_gr": tc_maxgr,
    }
    if tc_over_applause:
        payload["transient_cap_over_applause"] = True
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]
