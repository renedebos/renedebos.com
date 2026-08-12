#!/usr/bin/env python3
"""Audit for the silent loudnorm dynamic-mode fallback discovered 2026-08-11
on jerry-19-broadway-1999-10-25 track 16.

v1-v5 tracks in 'linear'/'linear-reduced' mode were rendered by handing
ffmpeg's loudnorm filter measured_I/LRA/TP/thresh + the target and trusting
its own linear-vs-dynamic decision (linear=true requested, never verified).
v6+ replaced this with an explicit `volume=` gain and never asks loudnorm to
render at all, so only v<=5 'linear'/'linear-reduced' tracks are at risk
('applause-limiter' mode also uses an explicit volume+alimiter chain, no
loudnorm render, so it's unaffected regardless of version).

Empirically confirmed (see 2026-08-11 session): ffmpeg's own reported
normalization_type depends only on the four measured scalars (I, LRA, TP,
thresh) plus the requested I/LRA/TP -- not on the actual audio content. So
this script re-measures each susceptible track's ORIGINAL pre-render source
(downloaded fresh from its Drive Work Folder, same folder-selection logic as
publish_show.py prepare) with ffmpeg's single-pass loudnorm measurement call
and reads back the normalization_type ffmpeg itself would have chosen -- no
full two-pass render needed, just the one-line JSON measurement.

Usage:
  python3 scripts/audit_dynamic_fallback.py <slug> [<slug> ...]
  python3 scripts/audit_dynamic_fallback.py --all-susceptible
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import audio_process as ap  # noqa: E402
import publish_show as ps   # noqa: E402

AUDIT_ROOT = os.path.expanduser("~/work/audit")


def susceptible_tracks(slug):
    path = os.path.join(ROOT, "data", "processing", f"{slug}.json")
    if not os.path.exists(path):
        return {}
    d = json.load(open(path))
    out = {}
    for num, t in d.get("tracks", {}).items():
        if t.get("ver") is not None and t["ver"] <= 5 and t.get("mode") in ("linear", "linear-reduced"):
            out[int(num)] = t
    return out


def all_susceptible_slugs():
    slugs = []
    for fname in os.listdir(os.path.join(ROOT, "data", "processing")):
        if not fname.endswith(".json"):
            continue
        slug = fname[:-5]
        if susceptible_tracks(slug):
            slugs.append(slug)
    return sorted(slugs)


def local_tracks_dir(slug):
    """Reuse an already-downloaded ~/work/<slug>/tracks if one exists (from
    an in-flight publish_show.py prepare) instead of re-downloading."""
    d = os.path.expanduser(f"~/work/{slug}/tracks")
    return d if os.path.isdir(d) and os.listdir(d) else None


def fetch_for_audit(slug, show):
    existing = local_tracks_dir(slug)
    if existing:
        print(f"  using already-prepared tracks at {existing}")
        return existing
    folder = ps.find_work_folder(show, None)
    sub, files, pre_edits = ps.find_tracks_source(folder)
    dest = os.path.join(AUDIT_ROOT, slug, "tracks")
    print(f"  folder={folder!r} sub={sub!r} pre_edits={pre_edits!r} ({len(files)} files)")
    ps.fetch_tracks(folder, sub, files, dest)
    return dest


def measured_normalization_type(path, target):
    af = f"loudnorm=I={target}:LRA=11:TP={ap.TP_CEILING}:print_format=json"
    err = subprocess.run(["ffmpeg", "-hide_banner", "-i", path, "-af", af, "-f", "null", "-"],
                          capture_output=True, text=True).stderr
    import re
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", err, re.S)
    if not m:
        return None
    return json.loads(m.group(0))


LRA_TOLERANCE = 0.5  # the v5 pipeline's own stated QA gate: output LRA must
                     # match source LRA within this many LU. Pure linear gain
                     # preserves LRA almost exactly (verified empirically:
                     # raw 15.20 -> volume-only reference 15.30 LU) -- ffmpeg's
                     # self-reported normalization_type field proved unreliable
                     # in testing (returns "dynamic" even for trivial
                     # zero-gain synthetic cases), so this compares against
                     # the pipeline's own stated tolerance instead.


def audit_show(slug):
    tracks = susceptible_tracks(slug)
    if not tracks:
        print(f"{slug}: no v<=5 linear/linear-reduced tracks, skipping")
        return []
    show = ps.load_show(slug)
    print(f"{slug}: {len(tracks)} susceptible track(s)")
    tdir = fetch_for_audit(slug, show)
    files = {f: f for f in os.listdir(tdir) if f.lower().endswith((".flac", ".wav"))}
    results = []
    for num in sorted(tracks):
        t = tracks[num]
        match = next((f for f in files if f.startswith(f"{num:02d} ") or f.startswith(f"{num} ")), None)
        if not match:
            print(f"  #{num}: SKIP — no matching file in {tdir}")
            continue
        recorded_output_lra = t.get("lra")
        if recorded_output_lra is None:
            print(f"  #{num}: SKIP — no recorded output lra in provenance")
            continue
        err = subprocess.run(["ffmpeg", "-hide_banner", "-i", os.path.join(tdir, match),
                               "-af", "loudnorm=print_format=json", "-f", "null", "-"],
                              capture_output=True, text=True).stderr
        import re
        m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", err, re.S)
        if not m:
            print(f"  #{num}: SKIP — could not measure raw source")
            continue
        raw_lra = float(json.loads(m.group(0))["input_lra"])
        drift = abs(raw_lra - recorded_output_lra)
        recorded_mode = t["mode"]
        flag = " *** LRA DRIFT BEYOND PIPELINE'S OWN 0.5 LU QA GATE ***" if drift > LRA_TOLERANCE else ""
        print(f"  #{num} {match}: recorded mode={recorded_mode} raw_lra={raw_lra:.2f} "
              f"output_lra={recorded_output_lra:.2f} drift={drift:.2f} LU{flag}")
        results.append({"num": num, "file": match, "recorded_mode": recorded_mode,
                        "raw_lra": raw_lra, "output_lra": recorded_output_lra,
                        "drift_lu": round(drift, 2)})
    return results


def main():
    args = sys.argv[1:]
    if args == ["--all-susceptible"]:
        slugs = all_susceptible_slugs()
    elif args:
        slugs = args
    else:
        print(__doc__)
        sys.exit(1)

    out_path = os.path.join(AUDIT_ROOT, "results.json")
    os.makedirs(AUDIT_ROOT, exist_ok=True)
    all_results = {}
    if os.path.exists(out_path):
        all_results = json.load(open(out_path))
        print(f"resuming — {len(all_results)} show(s) already audited in {out_path}")

    for slug in slugs:
        if slug in all_results:
            print(f"{slug}: already audited, skipping (delete its entry in {out_path} to redo)")
            continue
        try:
            all_results[slug] = audit_show(slug)
        except (Exception, SystemExit) as e:
            # SystemExit (e.g. an ambiguous Work Folder match) is not an
            # Exception subclass, but must be caught the same way here --
            # otherwise one bad show kills the whole batch instead of
            # skipping it (caught the hard way: jerry-19-broadway-1999-08-23
            # has two Drive folders matching its date and blew through an
            # uncaught SystemExit, aborting every show queued after it).
            print(f"{slug}: FAILED ({e}) — leaving unaudited, safe to re-run later")
        finally:
            # write after every show, not just at the end, so a dropped
            # connection or interrupted run never loses completed work
            json.dump(all_results, open(out_path, "w"), indent=2)
        print()

    total = sum(len(v) for v in all_results.values())
    drifted = sum(1 for v in all_results.values() for r in v if r["drift_lu"] > LRA_TOLERANCE)
    print(f"=== {drifted}/{total} susceptible tracks exceed the pipeline's own 0.5 LU LRA QA gate ===")
    print(f"written -> {out_path}")


if __name__ == "__main__":
    main()
