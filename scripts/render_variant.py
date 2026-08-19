#!/usr/bin/env python3
"""Render the -14 LUFS loud variant of the whole archive, show by show.

Source is the PUBLISHED -20 archive FLACs in R2, never a re-staged copy from
Drive (plans/loudness-variants: deriving from the archive is what makes
variant-vs-archive disagreement structurally impossible). That invariant is
enforced, not assumed: every rendered track's `src_md5` must equal the archive
sidecar's `md5` for the same track, or the show fails.

Like batch_process.py, this deliberately STOPS BEFORE PUBLISHING. It pulls,
renders, verifies and leaves MP3s + provenance on disk. The R2 upload is a
separate, human-reviewed step.

Gating: per plans/loudness-variants §4-gating and Rene's 2026-08-17
instruction, every track is forced past the engagement/sparsity gates and
given an explicit attenuation-ceiling override, because at -14 essentially
every track declines otherwise (measured: 0 of 22 capped on Cafe Java with the
plain flags). The -1.00 dBTP assertion is NOT bypassed -- it still deletes the
output and aborts, and it is the reason this is safe to run unattended.

Usage
-----
  python3 scripts/render_variant.py --list          # plan only, touch nothing
  python3 scripts/render_variant.py                 # render every show
  python3 scripts/render_variant.py --only SLUG     # one show
  python3 scripts/render_variant.py --jobs 4        # concurrent shows (default 5)

Resumable: a show whose MP3s are all present and whose provenance verifies is
skipped, so re-running continues where it left off.
"""
import argparse, concurrent.futures as cf, json, os, shutil, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.expanduser("~/work/variants/loud-14")
PROV = os.path.join(ROOT, "data", "processing", "variants", "loud-14")
BUCKET = "r2:hannan-audio"
TARGET = -14.0
# Explicit ceiling override. The engine takes only what a track actually needs
# and lands honestly short if that exceeds the allowance; the deepest measured
# case so far is Truck at 9.5 dB. Recorded per track as an override in
# provenance (policy_max_gr_db), never a change to the archive-wide policy.
MAX_GR = 15.0
VARIANT_PREFIX = "MP3-14"
RCLONE = ["--s3-no-check-bucket", "--transfers", "4",
          "--multi-thread-streams", "8", "--multi-thread-cutoff", "4M"]


def shows():
    m = json.load(open(os.path.join(ROOT, "data", "recordings.json")))
    out = []
    for s in m["shows"]:
        tr = s.get("tracks") or []
        if not tr or not all(t.get("flac") for t in tr):
            continue
        folder = tr[0]["flac"].split("/")[1]
        out.append({"slug": s["slug"], "folder": folder,
                    "nums": [t["num"] for t in tr], "n": len(tr),
                    "files": [t["flac"].split("/")[-1] for t in tr]})
    return sorted(out, key=lambda s: s["slug"])


def archive_md5s(slug):
    """Per-track decoded-audio md5 of the PUBLISHED -20 FLACs, from the
    archive's own provenance sidecar. This is the thing the variant's src_md5
    has to match."""
    p = os.path.join(ROOT, "data", "processing", f"{slug}.json")
    if not os.path.exists(p):
        return {}
    return {k: v.get("md5") for k, v in json.load(open(p)).get("tracks", {}).items()}


def verify_derivation(slug):
    """Enforce variant.src_md5 == archive.md5 for every track. A mismatch means
    the variant was NOT built from the published archive bytes."""
    vp = os.path.join(PROV, f"{slug}.json")
    if not os.path.exists(vp):
        return ["no variant provenance written"]
    var = json.load(open(vp)).get("tracks", {})
    arc = archive_md5s(slug)
    bad = []
    for num, entry in sorted(var.items(), key=lambda kv: int(kv[0])):
        want, got = arc.get(num), entry.get("src_md5")
        if not want:
            bad.append(f"track {num}: no archive md5 to check against")
        elif not got:
            bad.append(f"track {num}: variant recorded no src_md5")
        elif want != got:
            bad.append(f"track {num}: src_md5 {got[:8]} != archive md5 {want[:8]}")
    if not bad and not var:
        bad.append("variant provenance has no tracks")
    return bad


def done(show):
    d = os.path.join(WORK, show["slug"], "mp3")
    if not os.path.isdir(d):
        return False
    if len([f for f in os.listdir(d) if f.lower().endswith(".mp3")]) != show["n"]:
        return False
    return not verify_derivation(show["slug"])


def free_gb():
    st = os.statvfs(os.path.expanduser("~"))
    return st.f_bavail * st.f_frsize / 1e9


def _sweep(*dirs):
    """Drop staged lossless audio. Called on every exit path from run(), not
    just the happy one -- an early return used to leak the whole show's FLACs."""
    for d in dirs:
        if not os.path.isdir(d):
            continue
        for f in os.listdir(d):
            try:
                os.remove(os.path.join(d, f))
            except OSError:
                pass
        try:
            os.rmdir(d)
        except OSError:
            pass


def run(show, log):
    slug = show["slug"]
    base = os.path.join(WORK, slug)
    try:
        return _run(show, log)
    finally:
        _sweep(os.path.join(base, "src"), os.path.join(base, "out"))


def _run(show, log):
    slug, folder = show["slug"], show["folder"]
    base = os.path.join(WORK, slug)
    src, out, mp3 = (os.path.join(base, x) for x in ("src", "out", "mp3"))
    for d in (src, out, mp3, PROV):
        os.makedirs(d, exist_ok=True)

    # Pull EXACTLY the files recordings.json names, never the whole prefix.
    # R2 carries orphaned stale duplicates from earlier reprocesses (measured
    # 2026-08-17: 4 of them, e.g. a pre-rename "01 Highway Patrolman.flac"
    # alongside the published "01 State Trooper.flac"), so copying the prefix
    # renders files that are not in the archive and mis-numbers the show.
    listing = os.path.join(base, "files.txt")
    with open(listing, "w") as fh:
        fh.write("\n".join(show["files"]) + "\n")
    log(f"[{slug}] pull {show['n']} published FLACs from FLAC/{folder}/")
    r = subprocess.run(["rclone", "copy", f"{BUCKET}/FLAC/{folder}/", src,
                        "--files-from", listing] + RCLONE,
                       capture_output=True, text=True)
    os.remove(listing)
    if r.returncode != 0:
        return f"FAIL {slug}: rclone pull ({r.stderr.strip()[-200:]})"
    got = {f for f in os.listdir(src) if f.lower().endswith(".flac")}
    missing = set(show["files"]) - got
    if missing:
        return f"FAIL {slug}: {len(missing)} published FLAC(s) absent from R2: " \
               + ", ".join(sorted(missing)[:3])
    extra = got - set(show["files"])
    if extra:
        return f"FAIL {slug}: pulled unexpected file(s): {sorted(extra)[:3]}"

    nums = ",".join(str(n) for n in show["nums"])
    maxgr = ",".join(f"{n}:{MAX_GR}" for n in show["nums"])
    cmd = ["python3", os.path.join(ROOT, "scripts", "audio_process.py"), "process",
           src, out, "--target", str(TARGET),
           "--transient-cap", "--transient-cap-over-applause",
           "--transient-cap-force", nums, "--transient-cap-max-gr", maxgr,
           "--slug", slug, "--provenance-out", os.path.join(PROV, f"{slug}.json")]
    log(f"[{slug}] render {show['n']} tracks @ {TARGET} LUFS (forced)")
    r = subprocess.run(cmd, capture_output=True, text=True)
    # exit 2 == "finished, with warnings". At -14 essentially every track warns
    # (LRA shift), so 2 is the normal success path here, not a failure.
    if r.returncode not in (0, 2):
        tail = (r.stdout + r.stderr).strip()[-400:]
        return f"FAIL {slug}: engine exit {r.returncode}\n{tail}"
    open(os.path.join(base, "render.log"), "w").write(r.stdout + r.stderr)

    bad = verify_derivation(slug)
    if bad:
        return f"FAIL {slug}: derivation check\n  " + "\n  ".join(bad)

    made = [f for f in os.listdir(out) if f.lower().endswith(".mp3")]
    if len(made) != show["n"]:
        return f"FAIL {slug}: engine produced {len(made)}/{show['n']} MP3s"
    for f in made:
        shutil.move(os.path.join(out, f), os.path.join(mp3, f))
    rep = os.path.join(out, "processing_report.txt")
    if os.path.exists(rep):
        shutil.move(rep, os.path.join(base, "processing_report.txt"))
    mb = sum(os.path.getsize(os.path.join(mp3, f)) for f in made) / 1e6
    return f"ok   {slug}: {len(made)} MP3s, {mb:.0f} MB, derivation verified"


def upload(show, log):
    """Push one show's variant MP3s to R2 and verify every file landed intact.
    rclone check re-hashes both sides, so a truncated or corrupted upload fails
    here rather than being discovered by a listener."""
    slug, folder = show["slug"], show["folder"]
    mp3 = os.path.join(WORK, slug, "mp3")
    made = [f for f in os.listdir(mp3)] if os.path.isdir(mp3) else []
    if len(made) != show["n"]:
        return f"FAIL {slug}: {len(made)}/{show['n']} MP3s present, not uploading"
    dest = f"{BUCKET}/{VARIANT_PREFIX}/{folder}/"
    log(f"[{slug}] upload {show['n']} MP3s -> {VARIANT_PREFIX}/{folder}/")
    r = subprocess.run(["rclone", "copy", mp3, dest] + RCLONE,
                       capture_output=True, text=True)
    if r.returncode != 0:
        return f"FAIL {slug}: upload ({r.stderr.strip()[-200:]})"
    c = subprocess.run(["rclone", "check", mp3, dest, "--s3-no-check-bucket"],
                       capture_output=True, text=True)
    if c.returncode != 0:
        return f"FAIL {slug}: verify ({c.stderr.strip()[-300:]})"
    mb = sum(os.path.getsize(os.path.join(mp3, f)) for f in made) / 1e6
    return f"ok   {slug}: {len(made)} MP3s uploaded + verified, {mb:.0f} MB"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="just this slug")
    ap.add_argument("--jobs", type=int, default=5, help="concurrent shows (default 5)")
    ap.add_argument("--list", action="store_true", help="plan only, touch nothing")
    ap.add_argument("--upload", action="store_true",
                    help="upload rendered MP3s to R2 under VARIANT_PREFIX and verify. "
                         "Writes to a NEW prefix nothing references yet, so it is "
                         "invisible to the site until tracks.json is wired up.")
    a = ap.parse_args()

    todo = shows()
    if a.only:
        todo = [s for s in todo if s["slug"] == a.only] or sys.exit(f"no show {a.only}")

    if a.upload:
        ready = [s for s in todo if done(s)]
        print(f"uploading {len(ready)} show(s) to {BUCKET}/{VARIANT_PREFIX}/ "
              f"({sum(x['n'] for x in ready)} tracks)")
        if a.list:
            return
        t0, res = time.time(), []
        with cf.ThreadPoolExecutor(max_workers=a.jobs) as ex:
            futs = [ex.submit(upload, s, lambda m: print(m, flush=True)) for s in ready]
            for i, f in enumerate(cf.as_completed(futs), 1):
                res.append(f.result()); print(f"({i}/{len(ready)}) {res[-1]}", flush=True)
        bad = [r for r in res if r.startswith("FAIL")]
        print(f"\n=== UPLOAD COMPLETE in {(time.time()-t0)/60:.1f} min ===")
        print(f"{len(res)-len(bad)} ok, {len(bad)} failed")
        for r in bad: print(r)
        sys.exit(1 if bad else 0)

    pending, skipped = [], []
    for s in todo:
        (skipped if done(s) else pending).append(s)
    tracks = sum(s["n"] for s in pending)
    print(f"{len(todo)} show(s); {len(skipped)} already rendered, "
          f"{len(pending)} to do ({tracks} tracks)")
    print(f"target {TARGET} LUFS, forced, max-gr override {MAX_GR} dB, "
          f"{a.jobs} concurrent, {free_gb():.1f} GB free")
    if a.list or not pending:
        for s in pending:
            print(f"  todo  {s['slug']} ({s['n']})")
        return

    t0, results = time.time(), []
    lock_print = lambda m: print(m, flush=True)
    with cf.ThreadPoolExecutor(max_workers=a.jobs) as ex:
        futs = {ex.submit(run, s, lock_print): s for s in pending}
        for i, f in enumerate(cf.as_completed(futs), 1):
            msg = f.result()
            results.append(msg)
            print(f"({i}/{len(pending)}) {msg}", flush=True)

    fails = [r for r in results if r.startswith("FAIL")]
    # Durable campaign record. The runner's stdout otherwise lives only in the
    # caller's log, which for an agent-run job is session-scoped scratch.
    summary = os.path.join(WORK, "campaign-summary.txt")
    with open(summary, "a") as fh:
        fh.write(f"\n=== run finished {time.strftime('%Y-%m-%dT%H:%M:%S')} "
                 f"({(time.time()-t0)/60:.1f} min, target {TARGET} LUFS, "
                 f"forced, max-gr {MAX_GR} dB) ===\n")
        for r in sorted(results):
            fh.write(r + "\n")
    print(f"\n=== RENDER COMPLETE in {(time.time()-t0)/60:.1f} min ===")
    print(f"{len(results)-len(fails)} ok, {len(fails)} failed. "
          f"MP3s under {WORK}/<slug>/mp3/, provenance under {PROV}/")
    for r in fails:
        print(r)
    print("NOT uploaded — R2 upload is a separate reviewed step.")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
