#!/usr/bin/env python3
"""Publish-a-show orchestrator — the mechanical middle of the runbook in
two commands, with a human gate between them.

  python3 scripts/publish_show.py prepare <slug> [--folder "<Work Folder>"]
      Locate the show's hand-edited tracks on Drive ('Tracks Noise Reduction/'
      wins over 'Tracks/'; both populated is a hard error), pick up notes.txt
      as the pre-edits provenance, copy the tracks to ~/work/<slug>/tracks
      (from a matching local ~/gdrive-mount copy when available), and run the
      full diagnose. Then STOP so a human reads the verdicts.

  python3 scripts/publish_show.py publish <slug>
      After the diagnose looks clean: loudness-normalize to the archive
      standard, upload FLAC+MP3 to R2, generate waveform peaks, verify R2
      MD5s against the provenance sidecar (zero mismatches required), back
      the processed files up to Drive Processed/ (stall-aware retry loop),
      and clean up the local tracks copy.

  python3 scripts/publish_show.py rename-track <slug> --track-num N --new-title "Correct Title"
      When prepare's title preflight flags a fresh export's filename as
      drifted from the catalog and cross-referencing confirms it's a
      mechanical typo (not a real correction): rename that track's file in
      tracks/ (and out/ + any .v8state.json sidecar, if already rendered)
      to the established title, and update publish.json's manifest +
      fingerprint to match -- the supported alternative to hand-editing
      publish.json. Never touches audio bytes, Drive, or R2. Run this
      immediately after deciding the correction, BEFORE the first publish
      attempt -- not as recovery after a failed one (a first publish under
      the wrong name still uploads under that name and leaves a stray R2
      object only a human can delete).

Still human afterwards: draft_tracks.py for metadata, description/updates,
build, commit. State between the two phases lives in ~/work/<slug>/publish.json.

  --dry-run   (either phase) print every action without executing it.

  --tracks N,M,...   (publish) scoped mode: render/upload/draft/verify/
      back-up ONLY these track numbers from an already-prepared show,
      leaving every other track's existing entry and R2/Drive objects
      completely untouched. For a show where most tracks already sit at
      target under an older workflow version, this is the difference
      between touching 3 tracks and touching all 30 for the same audible
      benefit. Still requires prepare (and its diagnose review) to have
      run first for the whole show.
"""
import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK_ROOT = os.path.expanduser("~/work")
DRIVE_WORK = "gdrive:DAT Tapes/Work Folder"
GDRIVE_MOUNT = os.path.expanduser("~/gdrive-mount")
R2 = "r2:hannan-audio"
TARGET_LUFS = -20
AUDIO = ("*.flac", "*.wav")

DRY = False


def run(cmd, **kw):
    if DRY:
        print("  DRY:", " ".join(cmd) if isinstance(cmd, list) else cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
    return subprocess.run(cmd, text=True, **kw)


def rclone_lsf(path):
    r = subprocess.run(["rclone", "lsf", path], capture_output=True, text=True)
    return [l for l in r.stdout.splitlines() if l] if r.returncode == 0 else []


def audio_files(names):
    return [n for n in names if n.lower().endswith((".flac", ".wav"))]


def load_show(slug):
    M = json.load(open(os.path.join(ROOT, "data", "recordings.json")))
    for s in M["shows"]:
        if s["slug"] == slug:
            return s
    raise SystemExit(f"slug {slug!r} not found in recordings.json")


def state_path(slug):
    return os.path.join(WORK_ROOT, slug, "publish.json")


def find_work_folder(show, override):
    if override:
        return override
    hits = []
    r = subprocess.run(["rclone", "lsd", DRIVE_WORK], capture_output=True, text=True)
    for line in r.stdout.splitlines():
        name = line.split(None, 4)[-1] if line.split() else ""
        if show.get("date") and show["date"] in name:
            hits.append(name)
    if len(hits) != 1:
        raise SystemExit(f"could not uniquely locate the Work Folder by date "
                         f"{show.get('date')!r} (matches: {hits}) — pass --folder")
    return hits[0]


def find_tracks_source(folder):
    """'Tracks Noise Reduction/' (non-empty) wins over 'Tracks/'. Both
    populated = ambiguity = hard stop. notes.txt inside the chosen folder
    becomes the pre_edits provenance."""
    nr = audio_files(rclone_lsf(f"{DRIVE_WORK}/{folder}/Tracks Noise Reduction"))
    plain = audio_files(rclone_lsf(f"{DRIVE_WORK}/{folder}/Tracks"))
    if nr and plain:
        raise SystemExit("BOTH 'Tracks Noise Reduction/' and 'Tracks/' contain audio "
                         "— delete or archive one; never guessing which is canonical")
    if not nr and not plain:
        raise SystemExit(f"no track audio found in {folder!r} (checked 'Tracks Noise "
                         "Reduction/' and 'Tracks/')")
    sub = "Tracks Noise Reduction" if nr else "Tracks"
    files = nr or plain
    pre_edits = None
    if nr:
        pre_edits = "noise reduction (Audacity, whole show)"
    notes = f"{DRIVE_WORK}/{folder}/{sub}/notes.txt"
    r = subprocess.run(["rclone", "cat", notes], capture_output=True, text=True)
    if r.returncode == 0 and r.stdout.strip():
        pre_edits = " — ".join(l.strip() for l in r.stdout.strip().splitlines())
    return sub, files, pre_edits


def fetch_tracks(folder, sub, expected, dest):
    """Prefer a local ~/gdrive-mount copy when its audio matches Drive's file
    count; otherwise download from Drive. Always starts from a clean dest —
    a stale prior attempt's leftovers (e.g. tracks from before a Drive-side
    duplicate cleanup) would otherwise sit alongside the fresh copy and
    silently inflate the count, the same stale-local-directory bug class
    fixed for out/ in publish (2026-08-09)."""
    if not DRY:
        shutil.rmtree(dest, ignore_errors=True)
    local = os.path.join(GDRIVE_MOUNT, folder, sub)
    if os.path.isdir(local) and len(audio_files(os.listdir(local))) == len(expected):
        print(f"copying from local gdrive-mount ({len(expected)} files)")
        if not DRY:
            os.makedirs(dest, exist_ok=True)
            for f in audio_files(os.listdir(local)):
                shutil.copy(os.path.join(local, f), dest)
        return
    print(f"downloading from Drive ({len(expected)} files)")
    run(["rclone", "copy", f"{DRIVE_WORK}/{folder}/{sub}", dest,
         *sum ((["--include", p] for p in AUDIO), []), "--transfers", "4"])
    got = len(audio_files(os.listdir(dest))) if not DRY else len(expected)
    if got != len(expected):
        raise SystemExit(f"download incomplete: {got}/{len(expected)}")


def labels_present(folder):
    """The Audacity label export (labels.txt at the Work Folder root) is the
    raw archive's split recipe — warn whenever it's missing, never block."""
    return any(f.lower() == "labels.txt" for f in rclone_lsf(f"{DRIVE_WORK}/{folder}"))


LABELS_NAG = ("⚠ labels.txt is MISSING from the Work Folder — the raw archive is "
              "incomplete without it.\n  In Audacity: File > Export > Labels → save "
              "as labels.txt next to the whole-show WAV, then copy to Drive.")

# Diagnostic FLAGS categories serious enough to block publishing until a human
# explicitly reviews and accepts them (or the source is fixed and re-prepared).
# Reuses audio_process.py diagnose's own flag vocabulary verbatim — no new
# severity categories invented here. Left as informational-only (never
# blocking), same as always: PRED_TP (governed separately by the linear-
# normalization policy — audio_process.py handles it automatically), HIGH_LRA
# (explicitly informational per policy), DC, CLICK, BANDWIDTH (judgment calls,
# not confirmed defects the way a CLIPPING/DROPOUT/BALANCE/PHASE verdict is).
DIAGNOSTIC_HARD_BLOCK = {"CLIPPING", "DROPOUT", "BALANCE", "PHASE"}


def parse_diagnostic_findings(report_path):
    """Pull the hard-block-relevant FLAGS lines out of diagnose's
    diagnostic_report.txt into structured per-track findings. Previously
    `prepare` ran the full diagnostic and always created publish state
    regardless of what it found, and `publish` verified the source
    fingerprint but never checked that the diagnostic was clean or had been
    explicitly reviewed — so a track with confirmed sustained clipping or a
    mid-track dropout could ship without anyone having to look at it. This is
    the structured record `publish` checks against."""
    findings = []
    if not os.path.exists(report_path):
        return findings
    for line in open(report_path):
        line = line.strip()
        if not line.startswith("⚠ "):
            continue
        m = re.match(r"⚠ ([A-Z_]+): (.+?) — (.*)$", line)
        if not m:
            continue
        cat, fname, detail = m.group(1), m.group(2).strip(), m.group(3).strip()
        if cat not in DIAGNOSTIC_HARD_BLOCK:
            continue
        tm = re.match(r"^(\d+)", fname)
        findings.append({"track": int(tm.group(1)) if tm else None,
                         "file": fname, "category": cat, "detail": detail})
    return findings


def check_diagnostic_gate(st, args):
    """Hard-block publish on any unresolved hard-block-category finding from
    prepare's diagnose. `--accept-diagnostic 'TRACK:CATEGORY,...'` is the
    documented per-finding override (a human reviewed that specific finding
    on that specific track and accepts it) — never a global bypass. Accepted
    findings are persisted in publish.json as an audit trail so a later
    publish attempt for the same prepared state doesn't need the flag
    repeated."""
    findings = st.get("diagnostic_findings") or []
    if not findings:
        return
    accepted = set()
    for pair in (getattr(args, "accept_diagnostic", "") or "").split(","):
        pair = pair.strip()
        if not pair:
            continue
        tnum, _, cat = pair.partition(":")
        try:
            accepted.add((int(tnum), cat.strip().upper()))
        except ValueError:
            raise SystemExit(f"--accept-diagnostic: can't parse {pair!r} "
                             "(expected TRACK:CATEGORY, e.g. '12:CLIPPING')")
    prev_accepted = {(a["track"], a["category"]) for a in st.get("accepted_findings", [])}
    accepted |= prev_accepted
    unresolved = [f for f in findings if (f["track"], f["category"]) not in accepted]
    if unresolved:
        lines = [f"  track {f['track']} {f['file']!r}: {f['category']} — {f['detail']}"
                 for f in unresolved]
        ex_track, ex_cat = unresolved[0]["track"], unresolved[0]["category"]
        raise SystemExit(
            "prepare's diagnose flagged finding(s) that block publishing until "
            "reviewed:\n" + "\n".join(lines) +
            "\n\nListen (scripts/ab_compare.py or Audacity), then either fix the "
            "source and re-run prepare, or accept each reviewed finding with "
            "--accept-diagnostic 'TRACK:CATEGORY,...' (e.g. --accept-diagnostic "
            f"'{ex_track}:{ex_cat}')")
    if not DRY and accepted - prev_accepted:
        st["accepted_findings"] = [{"track": t, "category": c} for t, c in sorted(accepted)]
        json.dump(st, open(state_path(args.slug), "w"), indent=2, ensure_ascii=False)


def parse_duration(s):
    parts = [int(p) for p in s.split(":")]
    secs = 0
    for p in parts:
        secs = secs * 60 + p
    return secs


def audio_duration_seconds(path):
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", path], capture_output=True, text=True)
    return float(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else None


DURATION_DROP_RATIO = 0.5  # flag a track that shrank to less than half its prior length


def check_duration_regression(show, dest, files):
    """A reprocess's fresh export replacing an already-published track that's
    suddenly a fraction of its old length is very likely a bad/truncated
    Audacity export, not a real edit — diagnose (loudness/clipping/clicks)
    has no notion of 'is this the right length' and will pass it cleanly."""
    old_tracks = show.get("tracks") or []
    if not old_tracks:
        return []  # first-time publish for this show — nothing to compare
    old_by_num = {t["num"]: t.get("duration") for t in old_tracks if t.get("duration")}
    problems = []
    for f in sorted(files):
        m = re.match(r"^(\d+)\s", f)
        if not m:
            continue
        num = int(m.group(1))
        old = old_by_num.get(num)
        if not old:
            continue
        old_s = parse_duration(old)
        new_s = audio_duration_seconds(os.path.join(dest, f))
        if old_s and new_s is not None and new_s < old_s * DURATION_DROP_RATIO:
            problems.append((num, f, old, new_s))
    return problems


def source_manifest(dest):
    """Per-file audio-MD5 manifest of the fetched tracks plus one combined
    fingerprint. Binds the prepared state (and the UI's analysis/decisions)
    to the exact source bytes: same count with silently different contents —
    a corrected same-named export, a stale mount copy — no longer passes.
    Audio MD5s are already this repo's provenance currency."""
    import hashlib
    rows = []
    for f in sorted(audio_files(os.listdir(dest))):
        p = os.path.join(dest, f)
        md5 = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", p,
             "-map", "0:a", "-f", "md5", "-"],
            capture_output=True, text=True).stdout.strip().replace("MD5=", "")
        rows.append({"file": f, "size": os.path.getsize(p), "md5": md5})
    fp = hashlib.sha256(
        json.dumps(rows, sort_keys=True).encode()).hexdigest()[:16]
    return rows, fp


def catalog_title_lookup():
    """title (lowercased) -> set of show slugs it's known to appear under,
    across the whole archive — used to sanity-check a fresh export's
    filename-derived titles against established usage."""
    M = json.load(open(os.path.join(ROOT, "data", "recordings.json")))
    seen = {}
    for s in M["shows"]:
        for t in (s.get("tracks") or []):
            seen.setdefault(t["title"].strip().lower(), set()).add(s["slug"])
    return seen


def preflight_catalog_titles(show, files):
    """Flag tracks whose fresh-export filename title differs from the
    already-published catalog title for that track number — the exact
    mechanical-filename-guess trap that produced 4 wrong titles on
    2026-08-09 (a fresh hand-edit export used different filenames than the
    catalog's established titles for those tracks). Informational only,
    never blocks — this is Rene's judgment call, same as a clipping verdict."""
    old_tracks = show.get("tracks") or []
    if not old_tracks:
        return  # first-time publish for this show — nothing to compare against
    old_by_num = {t["num"]: t["title"].strip() for t in old_tracks}
    known = catalog_title_lookup()
    changes = []
    for f in sorted(files):
        m = re.match(r"^(\d+)\s+(.+)$", os.path.splitext(f)[0])
        if not m:
            continue
        num, guess = int(m.group(1)), m.group(2).strip()
        old = old_by_num.get(num)
        if old and guess.lower() != old.lower():
            elsewhere = known.get(guess.lower())
            note = (f"matches an established title used in {sorted(elsewhere)}"
                     if elsewhere else "NOT used as a title anywhere else in the "
                     "archive — double-check this isn't a mechanical filename guess")
            changes.append((num, old, guess, note))
    if changes:
        print("\n⚠ TITLE CHANGED vs. the published catalog — the fresh export's "
              "filename differs from the title currently on file for that track "
              "number. Confirm each is a real correction before publishing "
              "(cross-reference every prior appearance across the archive, not "
              "just this filename):")
        for num, old, guess, note in changes:
            print(f"  track {num}: {old!r} -> {guess!r} ({note})")


def cmd_prepare(args):
    show = load_show(args.slug)
    folder = find_work_folder(show, args.folder)
    sub, files, pre_edits = find_tracks_source(folder)
    print(f"work folder : {folder}")
    print(f"tracks from : {sub}/  ({len(files)} files)")
    print(f"pre-edits   : {pre_edits or '(none — standard fades/clip-fixes)'}")
    print(f"labels.txt  : {'present' if labels_present(folder) else 'MISSING'}")
    if not labels_present(folder):
        print(LABELS_NAG)

    dest = os.path.join(WORK_ROOT, args.slug, "tracks")
    fetch_tracks(folder, sub, files, dest)

    if not DRY:
        problems = check_duration_regression(show, dest, files)
        if problems:
            print("\n⚠ DURATION REGRESSION — fresh export is far shorter than the "
                  "currently-published track (likely a truncated/wrong Audacity "
                  "export, not a real edit):")
            for num, f, old, new_s in problems:
                print(f"  track {num} {f!r}: was {old}, fresh export is only "
                      f"{new_s:.1f}s")
            if not args.allow_duration_drift:
                raise SystemExit(
                    "\nrefusing to proceed — re-export the track(s) above at full "
                    "length, or pass --allow-duration-drift if this is a genuine "
                    "intentional change (e.g. a real re-edit that trims the song)")

    preflight_catalog_titles(show, files)

    print("\nrunning full diagnose …")
    r = run([sys.executable, os.path.join(ROOT, "scripts", "audio_process.py"),
             "diagnose", dest, "--target", str(TARGET_LUFS)])
    if not DRY and r.returncode != 0:
        raise SystemExit(
            "\ndiagnose did not finish cleanly (decode error or crash — see "
            "output above) — refusing to create publish state from an "
            "incomplete diagnostic. Fix the failing file and re-run prepare.")

    diagnostic_findings = []
    if not DRY:
        diagnostic_findings = parse_diagnostic_findings(
            os.path.join(dest, "diagnostic_report.txt"))
        if diagnostic_findings:
            print(f"\n⚠ {len(diagnostic_findings)} diagnostic finding(s) will BLOCK "
                  "publish until reviewed — accept per-finding with "
                  "--accept-diagnostic, or fix the source and re-run prepare:")
            for f in diagnostic_findings:
                print(f"  track {f['track']} {f['file']!r}: {f['category']} — {f['detail']}")

    if not DRY:
        print("\nfingerprinting sources …")
        manifest, fp = source_manifest(dest)
        os.makedirs(os.path.dirname(state_path(args.slug)), exist_ok=True)
        json.dump({"slug": args.slug, "folder": folder, "source_sub": sub,
                   "pre_edits": pre_edits, "n_tracks": len(files),
                   "prepared": datetime.datetime.now().isoformat(),
                   "manifest": manifest, "fingerprint": fp,
                   "diagnostic_findings": diagnostic_findings},
                  open(state_path(args.slug), "w"), indent=2, ensure_ascii=False)
        print(f"source fingerprint: {fp}")
    print(f"\nSTOP — review the diagnose verdicts above (report in {dest}).")
    print(f"Clean?  python3 scripts/publish_show.py publish {args.slug}")


MANUAL_BACKUP_GRACE_SECONDS = 180
MANUAL_BACKUP_POLL_SECONDS = 15


def drive_backup_matches(out, dst):
    """True iff every local FLAC/MP3 in `out` exists in Drive `dst` with a
    matching hash, and processing_report.txt made it across. A count-only
    check can't tell fresh output apart from stale same-named leftovers from
    a prior run — `rclone check` compares content, so leftovers fail loudly
    instead of silently satisfying a count."""
    r = subprocess.run(
        ["rclone", "check", out, dst,
         "--include", "*.flac", "--include", "*.mp3", "--one-way"],
        capture_output=True, text=True)
    if r.returncode != 0:
        return False
    if os.path.exists(os.path.join(out, "processing_report.txt")):
        return "processing_report.txt" in rclone_lsf(dst)
    return True


def drive_backup(folder, out, manual_first=False):
    dst = f"{DRIVE_WORK}/{folder}/Processed"

    if DRY:
        return

    if manual_first:
        print(f"\n[Drive backup] copy {out} -> '{dst}' yourself now if you want "
              f"— manual copy is often faster than rclone here. Waiting up to "
              f"{MANUAL_BACKUP_GRACE_SECONDS}s before falling back to rclone.")
        deadline = time.time() + MANUAL_BACKUP_GRACE_SECONDS
        while time.time() < deadline:
            if drive_backup_matches(out, dst):
                return
            print(f"  [waiting for manual copy] Drive Processed doesn't fully "
                  f"match local out/ yet")
            time.sleep(MANUAL_BACKUP_POLL_SECONDS)
        print("  no matching manual copy detected — falling back to rclone")

    for attempt in range(1, 21):
        if drive_backup_matches(out, dst):
            return
        print(f"  [backup attempt {attempt}] Drive Processed doesn't fully "
              f"match local out/ yet")
        run(["timeout", "1200", "rclone", "copy", out, dst,
             "--include", "*.flac", "--include", "*.mp3",
             "--include", "processing_report.txt", "--transfers", "4"])
        time.sleep(2)
    raise SystemExit("Drive backup did not complete after 20 attempts "
                     "(local out/ still doesn't match Drive Processed/ content)")


def clean_stale_out(tracks_dir, out_dir):
    """Remove out/ renders (flac/wav/mp3/.v8state.json) with no matching file
    in tracks/ — leftovers from a since-renamed or since-removed source that
    would otherwise get silently re-uploaded to R2/Drive alongside the
    correct new render. This is the direct structural fix for the
    2026-08-09 bug: a filename correction left the old-named outputs in
    place, and every subsequent `rclone copy` re-uploaded them, resurrecting
    'deleted' R2 duplicates every time."""
    if not os.path.isdir(tracks_dir) or not os.path.isdir(out_dir):
        return
    source_stems = {os.path.splitext(f)[0] for f in audio_files(os.listdir(tracks_dir))}
    stale = []
    for name in os.listdir(out_dir):
        if name.endswith(".v8state.json"):
            stem = os.path.splitext(name[:-len(".v8state.json")])[0]
        elif name.lower().endswith((".flac", ".wav", ".mp3")):
            stem = os.path.splitext(name)[0]
        else:
            continue  # not a per-track render (e.g. processing_report.txt)
        if stem not in source_stems:
            stale.append(name)
    if stale:
        print(f"[stale out/ cleanup] removing {len(stale)} leftover render(s) with no "
              f"matching source in tracks/ (renamed/removed since a prior attempt):")
        for name in sorted(stale):
            print(f"  - {name}")
            if not DRY:
                os.remove(os.path.join(out_dir, name))


def reconcile_r2(out_dir, dest, ext, label):
    """Exact-named diff instead of a bare count. A `35/31` mismatch says
    something's wrong but not what — three separate manual `rclone lsl`
    comparisons were needed to find the actual 4 extra files on 2026-08-09.
    Missing/obsolete names say exactly what to fix, and obsolete entries are
    handed back as ready-to-run `rclone delete` commands since the agent is
    hard-blocked from running deletes itself. Returns problem lines instead
    of raising directly — a stale leftover is typically a mirrored FLAC+MP3
    pair, and checking only one extension before aborting means fixing FLAC
    just to hit the identical MP3 problem next run (2026-08-09: exactly this,
    twice in a row)."""
    expected = {f for f in os.listdir(out_dir) if f.lower().endswith(ext)}
    have = set(rclone_lsf(dest))
    missing = sorted(expected - have)
    obsolete = sorted(have - expected)
    if not missing and not obsolete:
        return []
    lines = [f"R2 {label} mismatch at {dest}: {len(have)} present, "
             f"{len(expected)} expected"]
    if missing:
        lines.append(f"  missing ({len(missing)}): " + ", ".join(missing))
    if obsolete:
        lines.append(f"  obsolete ({len(obsolete)}) — present in R2 but not the "
                      "current source (likely renamed-away leftovers). rclone "
                      "delete is blocked for the agent — run these by hand:")
        for name in obsolete:
            lines.append(f'    rclone delete "{dest}/{name}"')
    return lines


def cmd_publish_scoped(args, track_nums):
    """--tracks N,M,...: render/upload/draft/verify/back-up only these track
    numbers, leaving the rest of the show's already-published tracks fully
    untouched. For a show where most tracks already sit at their loudness
    target under an older workflow version, this is the difference between
    touching 3 tracks and touching all 30 to get the same audible benefit --
    v8's linear/linear-reduced rendering is unchanged since v6/v7, so an
    already-at-target track gains nothing from a whole-show reprocess.

    Skips two things the whole-show path relies on, both because they assume
    out/ represents the COMPLETE show: clean_stale_out() (would delete
    other in-progress scoped runs' outputs) and reconcile_r2()'s "obsolete"
    check (would flag every untouched track as a stray needing deletion).
    Correctness for the touched tracks is instead guaranteed by the scoped
    fingerprint check below plus the existing whole-show `verify` step,
    which is already per-track (it walks the provenance sidecar, not a
    file-count diff) and safe to run against a partial local out/."""
    if not os.path.exists(state_path(args.slug)):
        raise SystemExit(f"no publish.json for {args.slug} — run prepare first")
    st = json.load(open(state_path(args.slug)))
    check_diagnostic_gate(st, args)
    folder = st["folder"]
    tracks_dir = os.path.join(WORK_ROOT, args.slug, "tracks")
    out = os.path.join(WORK_ROOT, args.slug, "out")
    scoped_in = os.path.join(WORK_ROOT, args.slug, "tracks-scoped")

    if not os.path.isdir(tracks_dir):
        raise SystemExit(f"{tracks_dir} not found — run prepare first")

    picked = {}
    for f in audio_files(os.listdir(tracks_dir)):
        try:
            num = int(f[:2])
        except ValueError:
            continue
        if num in track_nums:
            picked[num] = f
    missing = track_nums - picked.keys()
    if missing:
        raise SystemExit(f"--tracks asked for {sorted(missing)} but no matching "
                         f"file exists in {tracks_dir!r} — check the track "
                         "numbers, or run prepare first")

    # Scoped fingerprint check: only the picked files' bytes must match what
    # prepare fingerprinted — not the whole show's tracks/ dir (untouched
    # tracks are expected to sit there unchanged from an old prepare run).
    if not DRY and st.get("fingerprint") and st.get("manifest"):
        stored = {row["file"]: row for row in st["manifest"]}
        changed = []
        for f in picked.values():
            row = stored.get(f)
            p = os.path.join(tracks_dir, f)
            if row is None or os.path.getsize(p) != row.get("size"):
                changed.append(f)
                continue
            md5 = subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", p,
                 "-map", "0:a", "-f", "md5", "-"],
                capture_output=True, text=True).stdout.strip().replace("MD5=", "")
            if md5 != row.get("md5"):
                changed.append(f)
        if changed:
            raise SystemExit(
                f"source fingerprint mismatch for {changed} — the local "
                "source(s) changed since prepare. Re-run prepare first, or "
                "use rename-track if this is just a filename correction.")

    if not DRY:
        if os.path.isdir(scoped_in):
            shutil.rmtree(scoped_in)
        os.makedirs(scoped_in)
        for f in picked.values():
            shutil.copy2(os.path.join(tracks_dir, f), os.path.join(scoped_in, f))

    print(f"[1/6] loudness-normalize {len(picked)} track(s) {sorted(picked)} to "
          f"{TARGET_LUFS} LUFS"
          + (" (transient cap OPTED IN)" if args.transient_cap else ""))
    cmd = [sys.executable, os.path.join(ROOT, "scripts", "audio_process.py"),
           "process", scoped_in, out, "--target", str(TARGET_LUFS), "--slug", args.slug]
    if st.get("pre_edits"):
        cmd += ["--pre-edits", st["pre_edits"]]
    if args.eq:
        cmd += ["--eq", args.eq]
    if args.transient_cap:
        cmd += ["--transient-cap"]
    if args.tcap_exclude:
        cmd += ["--transient-cap-exclude", args.tcap_exclude]
    if args.tcap_accept:
        cmd += ["--transient-cap-accept", args.tcap_accept]
    if args.tcap_partial:
        cmd += ["--transient-cap-partial", args.tcap_partial]
    if args.tcap_force:
        cmd += ["--transient-cap-force", args.tcap_force]
    if args.tcap_max_gr:
        cmd += ["--transient-cap-max-gr", args.tcap_max_gr]
    r = run(cmd)
    if r.returncode not in (0, 2):
        raise SystemExit("processing failed")
    if r.returncode == 2:
        print("⚠ processed with non-fatal warnings (see report above) — continuing")

    touched_stems = {os.path.splitext(f)[0] for f in picked.values()}
    upload_names = []
    if not DRY:
        for stem in touched_stems:
            for ext in (".flac", ".mp3"):
                if os.path.exists(os.path.join(out, stem + ext)):
                    upload_names.append(stem + ext)

    print(f"[2/6] upload {len(upload_names)} file(s) to R2 ({folder})")
    for ext, top in ((".flac", "FLAC"), (".mp3", "MP3")):
        names = [n for n in upload_names if n.endswith(ext)]
        if not names:
            continue
        cmd = ["rclone", "copy", out, f"{R2}/{top}/{folder}",
               "--s3-no-check-bucket", "--transfers", "8"]
        for n in names:
            cmd += ["--include", n]
        r = run(cmd)
        if not DRY and r.returncode != 0:
            raise SystemExit(f"rclone upload failed for {top} — aborting before "
                             "metadata/Drive steps")

    print("[3/6] draft tracks[] into recordings.json (scoped)")
    r = run([sys.executable, os.path.join(ROOT, "scripts", "draft_tracks.py"),
             args.slug, "--tracks", ",".join(str(n) for n in sorted(picked))])
    if not DRY and r.returncode != 0:
        raise SystemExit("draft_tracks failed")

    print("[4/6] waveform peaks (whole show; R2 fallback for untouched tracks)")
    run([sys.executable, os.path.join(ROOT, "scripts", "gen_peaks.py"),
         "--slug", args.slug, "--local", out])

    print("[5/6] verify R2 MD5s against provenance (whole show — cheap, per-track)")
    r = run([sys.executable, os.path.join(ROOT, "scripts", "audio_process.py"),
             "verify", args.slug], capture_output=True)
    print(r.stdout[-400:] if r.stdout else "")
    if not DRY and "0 mismatch(es)" not in (r.stdout or ""):
        raise SystemExit("MD5 verify FAILED — do not ship")

    print("[6/6] Drive backup of the touched files only")
    if not DRY and upload_names:
        dst = f"{DRIVE_WORK}/{folder}/Processed"
        cmd = ["rclone", "copy", out, dst, "--transfers", "4"]
        for n in upload_names:
            cmd += ["--include", n]
        r = run(cmd)
        if r.returncode != 0:
            print(f"⚠ Drive backup rclone copy exited {r.returncode} — check by hand")

    print(f"""
done (scoped: tracks {sorted(picked)}) — still human:
  review any FLAGs draft_tracks printed above (new/ambiguous titles), write
  description + updates note, history.html if this changes the show's story
  python3 scripts/build.py && commit + push, then spot-check the live page

Note: tracks/ was NOT cleaned up — other candidate tracks in this show may
still need a scoped run. Run cleanup manually once every track is on the
current workflow version, or leave it for a future --tracks pass.""")


def cmd_publish(args):
    if args.tracks:
        return cmd_publish_scoped(args, {int(x) for x in args.tracks.split(",") if x.strip()})
    if args.manual_drive_backup is None:
        if sys.stdin.isatty():
            ans = input("Handle the Drive Processed/ backup yourself, or let "
                         "rclone do it? [manual/rclone] (default rclone): ").strip().lower()
            args.manual_drive_backup = ans.startswith("m")
        else:
            args.manual_drive_backup = False

    if not os.path.exists(state_path(args.slug)):
        raise SystemExit(f"no publish.json for {args.slug} — run prepare first")
    st = json.load(open(state_path(args.slug)))
    check_diagnostic_gate(st, args)
    folder, n = st["folder"], st["n_tracks"]
    tracks = os.path.join(WORK_ROOT, args.slug, "tracks")
    out = os.path.join(WORK_ROOT, args.slug, "out")

    # the sources on disk must be the ones prepare fingerprinted — same count
    # with silently different bytes (re-export, stale mount) aborts here
    if not DRY and st.get("fingerprint"):
        print("verifying source fingerprint …")
        _, fp_now = source_manifest(tracks)
        if fp_now != st["fingerprint"]:
            raise SystemExit(
                f"source fingerprint mismatch: prepared {st['fingerprint']}, "
                f"tracks/ now {fp_now} — the local sources changed since "
                "prepare. Re-run prepare (and re-review the diagnose) first.")

    clean_stale_out(tracks, out)

    print(f"[1/7] loudness-normalize {n} tracks to {TARGET_LUFS} LUFS"
          + (" (transient cap OPTED IN)" if args.transient_cap else ""))
    cmd = [sys.executable, os.path.join(ROOT, "scripts", "audio_process.py"),
           "process", tracks, out, "--target", str(TARGET_LUFS), "--slug", args.slug]
    if st.get("pre_edits"):
        cmd += ["--pre-edits", st["pre_edits"]]
    if args.eq:
        cmd += ["--eq", args.eq]
    if args.transient_cap:
        cmd += ["--transient-cap"]
    if args.tcap_exclude:
        cmd += ["--transient-cap-exclude", args.tcap_exclude]
    if args.tcap_accept:
        cmd += ["--transient-cap-accept", args.tcap_accept]
    if args.tcap_partial:
        cmd += ["--transient-cap-partial", args.tcap_partial]
    if args.tcap_force:
        cmd += ["--transient-cap-force", args.tcap_force]
    if args.tcap_max_gr:
        cmd += ["--transient-cap-max-gr", args.tcap_max_gr]
    r = run(cmd)
    if r.returncode not in (0, 2):  # 2 = processed with non-fatal warnings, see report
        raise SystemExit("processing failed")
    if r.returncode == 2:
        print("⚠ processed with non-fatal warnings (see report above) — continuing")

    print(f"[2/7] upload FLAC+MP3 to R2 ({folder})")
    problems = []
    for ext, top in (("*.flac", "FLAC"), ("*.mp3", "MP3")):
        run(["rclone", "copy", out, f"{R2}/{top}/{folder}",
             "--include", ext, "--s3-no-check-bucket", "--transfers", "8"])
        if not DRY:
            problems += reconcile_r2(out, f"{R2}/{top}/{folder}", ext.lstrip("*"), top)
    if problems:
        raise SystemExit("\n".join(problems))

    print("[3/7] draft tracks[] into recordings.json (needed before peaks/verify can map "
          "track num -> R2 key)")
    r = run([sys.executable, os.path.join(ROOT, "scripts", "draft_tracks.py"), args.slug])
    if not DRY and r.returncode != 0:
        raise SystemExit("draft_tracks failed")

    print("[4/7] waveform peaks (from local out/, no R2 round trip)")
    run([sys.executable, os.path.join(ROOT, "scripts", "gen_peaks.py"),
         "--slug", args.slug, "--local", out])

    print("[5/7] verify R2 MD5s against provenance")
    r = run([sys.executable, os.path.join(ROOT, "scripts", "audio_process.py"),
             "verify", args.slug], capture_output=True)
    print(r.stdout[-400:] if r.stdout else "")
    if not DRY and "0 mismatch(es)" not in (r.stdout or ""):
        raise SystemExit("MD5 verify FAILED — do not ship")

    print("[6/7] Drive backup of processed files")
    drive_backup(folder, out, manual_first=args.manual_drive_backup)

    print("[7/7] cleanup local tracks copy (out/ kept until the show is shipped)")
    if not DRY:
        shutil.rmtree(tracks, ignore_errors=True)

    print(f"""
done — still human:
  review any FLAGs draft_tracks printed above (new/ambiguous titles), write
  description + updates note, history.html
  python3 scripts/build.py && commit + push, then spot-check the live page""")
    # re-check at publish time — the nag repeats until the file exists
    if not labels_present(folder):
        print("\n" + LABELS_NAG)


def cmd_rename_track(args):
    """Rename one track's local file(s) to a corrected title and update
    publish.json's manifest + fingerprint to match, without touching audio
    bytes. This is the supported path for the exact scenario that used to
    require hand-editing publish.json directly: prepare's title preflight
    flags a fresh export's filename as drifted, cross-referencing confirms
    it's a mechanical typo, and the file needs renaming to the established
    title before publish will accept it. Renaming without this command
    (bare `mv`) leaves publish.json's stored fingerprint pointing at the old
    filename, so the very next `publish` aborts with "source fingerprint
    mismatch" -- correct, since the local sources genuinely did change from
    what prepare fingerprinted, but tedious to resolve by hand every time."""
    st_path = state_path(args.slug)
    if not os.path.exists(st_path):
        raise SystemExit(f"no publish.json for {args.slug} — run prepare first")
    if not args.track_num or not args.new_title:
        raise SystemExit("rename-track needs --track-num N --new-title \"Correct Title\"")
    st = json.load(open(st_path))

    tracks_dir = os.path.join(WORK_ROOT, args.slug, "tracks")
    out_dir = os.path.join(WORK_ROOT, args.slug, "out")
    prefix = f"{args.track_num:02d} "

    old_in_tracks = next(
        (f for f in os.listdir(tracks_dir) if f.startswith(prefix)
         and f.lower().endswith((".flac", ".wav"))),
        None) if os.path.isdir(tracks_dir) else None
    if not old_in_tracks:
        raise SystemExit(f"no track {args.track_num} file found in {tracks_dir!r}")

    ext = os.path.splitext(old_in_tracks)[1]
    old_stem = os.path.splitext(old_in_tracks)[0]
    new_stem = f"{prefix}{args.new_title}"
    new_in_tracks = new_stem + ext

    if old_in_tracks == new_in_tracks:
        print(f"track {args.track_num} is already named {new_in_tracks!r} — nothing to do")
        return

    renamed = []

    def do_rename(d, old_name, new_name):
        old_p, new_p = os.path.join(d, old_name), os.path.join(d, new_name)
        if os.path.exists(old_p):
            if not DRY:
                os.rename(old_p, new_p)
            renamed.append((old_p, new_p))

    do_rename(tracks_dir, old_in_tracks, new_in_tracks)
    if os.path.isdir(out_dir):
        for f in sorted(os.listdir(out_dir)):
            if f == old_stem + ".flac" or f == old_stem + ".mp3" \
                    or f == old_stem + ".flac.v8state.json":
                do_rename(out_dir, f, new_stem + f[len(old_stem):])

    changed = False
    for row in st.get("manifest", []):
        if row["file"] == old_in_tracks:
            row["file"] = new_in_tracks
            changed = True
    fp = None
    if changed:
        import hashlib
        fp = hashlib.sha256(
            json.dumps(st["manifest"], sort_keys=True).encode()).hexdigest()[:16]
        st["fingerprint"] = fp
        if not DRY:
            json.dump(st, open(st_path, "w"), indent=2, ensure_ascii=False)

    for old_p, new_p in renamed:
        print(f"  renamed: {old_p} -> {new_p}")
    if changed:
        print(f"publish.json manifest + fingerprint updated"
              + (f" -> {fp}" if not DRY else " (dry-run, not written)"))
    else:
        print("⚠ no matching manifest entry for the old filename — "
              "publish.json left unchanged; the fingerprint check may still "
              "fail, verify by hand")


def cmd_cleanup(args):
    """Delete ~/work/<slug> once the show is provably safe everywhere else:
    live on the site, complete on R2, and backed up to Drive Processed/."""
    import urllib.request
    show = load_show(args.slug)
    tracks = show.get("tracks") or []
    if not tracks or show.get("processing_status") != "done":
        raise SystemExit(f"{args.slug} is not a published track-listed show — refusing")
    n = len(tracks)

    page = (show.get("page") or f"shows/{args.slug}") + "/"
    req = urllib.request.Request(
        f"https://renedebos.com/{page}",
        headers={"Sec-Fetch-Mode": "navigate",
                 # Cloudflare 403s urllib's default UA
                 "User-Agent": "Mozilla/5.0 (publish-show cleanup check)"})
    if urllib.request.urlopen(req).status != 200:
        raise SystemExit("live page check failed — refusing")

    r2dir = tracks[0]["file"].split("/")[1]
    for top in ("FLAC", "MP3"):
        have = len(rclone_lsf(f"{R2}/{top}/{r2dir}"))
        if have < n:
            raise SystemExit(f"R2 {top} has {have}/{n} — refusing")
    st = state_path(args.slug)
    folder = json.load(open(st))["folder"] if os.path.exists(st) else r2dir
    out = os.path.join(WORK_ROOT, args.slug, "out")
    dst = f"{DRIVE_WORK}/{folder}/Processed"
    if os.path.isdir(out) and not drive_backup_matches(out, dst):
        raise SystemExit(f"Drive Processed at {dst!r} doesn't fully match "
                         f"local {out!r} by content — refusing (a count-only "
                         "check can be fooled by stale same-named leftovers "
                         "from a prior run)")

    freed = 0
    for d in (os.path.join(WORK_ROOT, args.slug),
              os.path.join(WORK_ROOT, "retag", args.slug)):
        if os.path.isdir(d):
            freed += sum(os.path.getsize(os.path.join(r, f))
                         for r, _, fs in os.walk(d) for f in fs)
            if not DRY:
                shutil.rmtree(d)
            print(f"removed {d}")
    print(f"verified live + R2 {n}+{n} + Drive {have} — freed {freed/1e9:.2f} GB")


def main():
    global DRY
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("phase", choices=["prepare", "publish", "cleanup", "rename-track"])
    ap.add_argument("slug")
    ap.add_argument("--folder", help="Drive Work Folder name (when date search is ambiguous)")
    ap.add_argument("--track-num", type=int, default=None,
                     help="rename-track: track number to rename")
    ap.add_argument("--new-title", default=None,
                     help="rename-track: corrected title (no leading track number, "
                          "no extension — e.g. \"Angel from Montgomery\")")
    ap.add_argument("--tracks", default="",
                     help="publish: comma-separated track numbers — render/upload/"
                          "draft/verify/back-up ONLY these tracks, leaving the rest "
                          "of the show's already-published tracks untouched. For a "
                          "show where most tracks already sit at target under an "
                          "older workflow version, this avoids re-touching tracks "
                          "that would render bit-for-bit identical under v8.")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--manual-drive-backup", action="store_true", default=None,
                     help="publish: give a few minutes to manually copy out/ to "
                          "Drive Processed/ (often faster than rclone) before "
                          "falling back to the automated rclone copy. If omitted "
                          "and running interactively, you'll be asked; "
                          "non-interactively this defaults to rclone.")
    ap.add_argument("--no-manual-drive-backup", dest="manual_drive_backup",
                     action="store_false",
                     help="publish: skip the manual-copy prompt/window, go "
                          "straight to rclone")
    ap.add_argument("--allow-duration-drift", action="store_true",
                     help="prepare: proceed even though a fresh track export is "
                          "far shorter than the currently-published version — "
                          "only for a genuine intentional re-edit, not a suspected "
                          "bad export")
    ap.add_argument("--eq", default="",
                     help="publish: literal corrective-EQ filter chain applied before "
                          "loudnorm (passed through to audio_process.py process --eq) "
                          "— for restoration shows like mad-sweetwater-2001-01-06 that "
                          "need mud-cut/presence-lift EQ, not the default")
    ap.add_argument("--transient-cap", dest="transient_cap", action="store_true",
                     help="publish: opt this show in to the v8 sparse-transient cap "
                          "(audio_process.py --transient-cap) — per-track eligibility "
                          "gates still apply; Rene's per-show call, never assume it")
    ap.add_argument("--transient-cap-exclude", dest="tcap_exclude", default="",
                     help="publish: comma-separated track numbers vetoed from the cap "
                          "(passed through to audio_process.py)")
    ap.add_argument("--transient-cap-accept", dest="tcap_accept", default="",
                     help="publish: comma-separated track numbers whose listen-flags "
                          "were reviewed by ear and accepted (without this, a flagged "
                          "track aborts the publish before upload)")
    ap.add_argument("--transient-cap-partial", dest="tcap_partial", default="",
                     help="publish: comma-separated track numbers allowed partial "
                          "capping (full 6 dB attenuation, lands short of target) — "
                          "Rene's explicit per-track opt-in for over-cap tracks")
    ap.add_argument("--transient-cap-force", dest="tcap_force", default="",
                     help="publish: comma-separated track numbers where Rene, after "
                          "listening, overrides the sparsity gate/listen-flags")
    ap.add_argument("--transient-cap-max-gr", dest="tcap_max_gr", default="",
                     help="publish: comma-separated track:dB pairs (e.g. '8:8.65') "
                          "raising the 6 dB attenuation ceiling for ONE track — an "
                          "explicit, recorded exception after a loudness-matched "
                          "listening test, never an archive-wide policy change "
                          "(passed through to audio_process.py)")
    ap.add_argument("--accept-diagnostic", dest="accept_diagnostic", default="",
                     help="publish: comma-separated track:CATEGORY pairs (e.g. "
                          "'12:CLIPPING') marking a specific prepare-time diagnostic "
                          "finding as reviewed and accepted for publishing — the "
                          "documented per-finding override, never a global bypass. "
                          "Hard-block categories: CLIPPING, DROPOUT, BALANCE, PHASE. "
                          "Without this, any unresolved finding aborts publish before "
                          "anything renders or uploads; accepted findings are recorded "
                          "in publish.json so a later publish for the same prepared "
                          "state doesn't need the flag repeated")
    args = ap.parse_args()
    DRY = args.dry_run
    {"prepare": cmd_prepare, "publish": cmd_publish,
     "cleanup": cmd_cleanup, "rename-track": cmd_rename_track}[args.phase](args)


if __name__ == "__main__":
    main()
