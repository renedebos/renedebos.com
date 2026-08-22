"""Processing-status reporting: per-show done/partial/needs-processing/redo
classification derived from the provenance sidecars. Moved out of
audio_process.py 2026-08-22 verbatim.
"""
import json
import os

from engine_constants import ROOT


# ── processing status (which shows/tracks are done / need work) ────────────────
# Statuses:
#   done             — track-listed show, every track has a sidecar entry
#   partial          — track-listed show, some (not all) tracks processed
#   needs-processing — never processed (track-listed with no sidecar, OR a
#                      whole-show-only show — those have no split tracks for the
#                      engine to act on yet, so they need splitting first)
#   redo             — normalized off the books (e.g. an old manual pass at the
#                      wrong target, no sidecar). Sticky: stays `redo` until a real
#                      sidecar exists, then auto-upgrades to done/partial.
# Shows known to have been normalized outside the engine (no provenance) — flagged
# for a re-run through the engine to get on-standard + verifiable:
REDO_SLUGS = {"jerry-19-broadway-2001-01-15"}


def show_status(show):
    slug = show["slug"]
    tracks = show.get("tracks") or []
    if not tracks:
        return "needs-processing"  # whole-show-only: nothing split to process yet
    path = os.path.join(ROOT, "data", "processing", f"{slug}.json")
    if os.path.exists(path):
        pt = json.load(open(path)).get("tracks", {})
        done = sum(1 for t in tracks if str(t["num"]) in pt)
        if done >= len(tracks):
            return "done"
        if done > 0:
            return "partial"
    if slug in REDO_SLUGS:
        return "redo"
    return "needs-processing"
