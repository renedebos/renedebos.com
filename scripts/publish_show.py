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

    print("\nrunning full diagnose …")
    run([sys.executable, os.path.join(ROOT, "scripts", "audio_process.py"),
         "diagnose", dest, "--target", str(TARGET_LUFS)])

    if not DRY:
        os.makedirs(os.path.dirname(state_path(args.slug)), exist_ok=True)
        json.dump({"slug": args.slug, "folder": folder, "source_sub": sub,
                   "pre_edits": pre_edits, "n_tracks": len(files),
                   "prepared": datetime.datetime.now().isoformat()},
                  open(state_path(args.slug), "w"), indent=2, ensure_ascii=False)
    print(f"\nSTOP — review the diagnose verdicts above (report in {dest}).")
    print(f"Clean?  python3 scripts/publish_show.py publish {args.slug}")


def drive_backup(folder, out, n_expected):
    dst = f"{DRIVE_WORK}/{folder}/Processed"
    for attempt in range(1, 21):
        have = len([f for f in rclone_lsf(dst)
                    if f.lower().endswith((".flac", ".mp3"))])
        print(f"  [backup attempt {attempt}] Drive Processed has {have}/{n_expected}")
        if have >= n_expected or DRY:
            return
        run(["timeout", "1200", "rclone", "copy", out, dst,
             "--include", "*.flac", "--include", "*.mp3", "--transfers", "4"])
        time.sleep(2)
    raise SystemExit("Drive backup did not complete after 20 attempts")


def cmd_publish(args):
    if not os.path.exists(state_path(args.slug)):
        raise SystemExit(f"no publish.json for {args.slug} — run prepare first")
    st = json.load(open(state_path(args.slug)))
    folder, n = st["folder"], st["n_tracks"]
    tracks = os.path.join(WORK_ROOT, args.slug, "tracks")
    out = os.path.join(WORK_ROOT, args.slug, "out")

    print(f"[1/6] loudness-normalize {n} tracks to {TARGET_LUFS} LUFS")
    cmd = [sys.executable, os.path.join(ROOT, "scripts", "audio_process.py"),
           "process", tracks, out, "--target", str(TARGET_LUFS), "--slug", args.slug]
    if st.get("pre_edits"):
        cmd += ["--pre-edits", st["pre_edits"]]
    r = run(cmd)
    if r.returncode != 0:
        raise SystemExit("processing failed")

    print(f"[2/6] upload FLAC+MP3 to R2 ({folder})")
    for ext, top in (("*.flac", "FLAC"), ("*.mp3", "MP3")):
        run(["rclone", "copy", out, f"{R2}/{top}/{folder}",
             "--include", ext, "--s3-no-check-bucket", "--transfers", "8"])
        have = len(rclone_lsf(f"{R2}/{top}/{folder}")) if not DRY else n
        if have != n:
            raise SystemExit(f"R2 {top} incomplete: {have}/{n}")

    print("[3/6] waveform peaks")
    run([sys.executable, os.path.join(ROOT, "scripts", "gen_peaks.py"),
         "--slug", args.slug])

    print("[4/6] verify R2 MD5s against provenance")
    r = run([sys.executable, os.path.join(ROOT, "scripts", "audio_process.py"),
             "verify", args.slug], capture_output=True)
    print(r.stdout[-400:] if r.stdout else "")
    if not DRY and "0 mismatch(es)" not in (r.stdout or ""):
        raise SystemExit("MD5 verify FAILED — do not ship")

    print("[5/6] Drive backup of processed files")
    drive_backup(folder, out, 2 * n)

    print("[6/6] cleanup local tracks copy (out/ kept until the show is shipped)")
    if not DRY:
        shutil.rmtree(tracks, ignore_errors=True)

    print(f"""
done — still human:
  python3 scripts/draft_tracks.py {args.slug}     # metadata draft into recordings.json
  description + updates note, history.html
  python3 scripts/build.py && commit + push, then spot-check the live page""")
    # re-check at publish time — the nag repeats until the file exists
    if not labels_present(folder):
        print("\n" + LABELS_NAG)


def main():
    global DRY
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("phase", choices=["prepare", "publish"])
    ap.add_argument("slug")
    ap.add_argument("--folder", help="Drive Work Folder name (when date search is ambiguous)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    DRY = args.dry_run
    (cmd_prepare if args.phase == "prepare" else cmd_publish)(args)


if __name__ == "__main__":
    main()
