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

Still human afterwards: draft_tracks.py for metadata, description/updates,
build, commit. State between the two phases lives in ~/work/<slug>/publish.json.

  --dry-run   (either phase) print every action without executing it.
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
    count; otherwise download from Drive."""
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

    print("\nrunning full diagnose …")
    run([sys.executable, os.path.join(ROOT, "scripts", "audio_process.py"),
         "diagnose", dest, "--target", str(TARGET_LUFS)])

    if not DRY:
        print("\nfingerprinting sources …")
        manifest, fp = source_manifest(dest)
        os.makedirs(os.path.dirname(state_path(args.slug)), exist_ok=True)
        json.dump({"slug": args.slug, "folder": folder, "source_sub": sub,
                   "pre_edits": pre_edits, "n_tracks": len(files),
                   "prepared": datetime.datetime.now().isoformat(),
                   "manifest": manifest, "fingerprint": fp},
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


def cmd_publish(args):
    if not os.path.exists(state_path(args.slug)):
        raise SystemExit(f"no publish.json for {args.slug} — run prepare first")
    st = json.load(open(state_path(args.slug)))
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

    print(f"[1/7] loudness-normalize {n} tracks to {TARGET_LUFS} LUFS"
          + (" (transient cap OPTED IN)" if args.transient_cap else ""))
    cmd = [sys.executable, os.path.join(ROOT, "scripts", "audio_process.py"),
           "process", tracks, out, "--target", str(TARGET_LUFS), "--slug", args.slug]
    if st.get("pre_edits"):
        cmd += ["--pre-edits", st["pre_edits"]]
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
    r = run(cmd)
    if r.returncode not in (0, 2):  # 2 = processed with non-fatal warnings, see report
        raise SystemExit("processing failed")

    print(f"[2/7] upload FLAC+MP3 to R2 ({folder})")
    for ext, top in (("*.flac", "FLAC"), ("*.mp3", "MP3")):
        run(["rclone", "copy", out, f"{R2}/{top}/{folder}",
             "--include", ext, "--s3-no-check-bucket", "--transfers", "8"])
        have = len(rclone_lsf(f"{R2}/{top}/{folder}")) if not DRY else n
        if have != n:
            raise SystemExit(f"R2 {top} incomplete: {have}/{n}")

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
    ap.add_argument("phase", choices=["prepare", "publish", "cleanup"])
    ap.add_argument("slug")
    ap.add_argument("--folder", help="Drive Work Folder name (when date search is ambiguous)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--manual-drive-backup", action="store_true",
                     help="publish: give a few minutes to manually copy out/ to "
                          "Drive Processed/ (often faster than rclone) before "
                          "falling back to the automated rclone copy")
    ap.add_argument("--allow-duration-drift", action="store_true",
                     help="prepare: proceed even though a fresh track export is "
                          "far shorter than the currently-published version — "
                          "only for a genuine intentional re-edit, not a suspected "
                          "bad export")
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
    args = ap.parse_args()
    DRY = args.dry_run
    {"prepare": cmd_prepare, "publish": cmd_publish,
     "cleanup": cmd_cleanup}[args.phase](args)


if __name__ == "__main__":
    main()
