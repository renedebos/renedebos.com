#!/usr/bin/env python3
"""Build a synced A/B comparison (current live audio vs. the current
processing engine reprocessing the original source) for one track, and
serve it locally with scripts/ab_server.py.

The point: hear whether an old workflow version (v1/v2/v3, before the v4
silent-dynamic-fallback fix and v5's applause-aware headroom recovery)
actually differs from what the engine would do today — not just compare
numbers.

Requires the track's ORIGINAL, unprocessed audio — this tool cannot get
that from the already-published output. For shows with an archived
Tracks/Tracks Noise Reduction folder + labels.txt, that's the raw split
(see split_raw.py); for older shows without one, export the track fresh
from its .aup3 Audacity project and place it on ~/gdrive-mount (or pass
--raw explicitly).

Usage:
  python3 scripts/ab_compare.py <show-slug> <track-num> [--raw PATH] [--port N]

Example:
  python3 scripts/ab_compare.py sean-19-broadway-2000-01-24 16
"""
import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GDRIVE_MOUNT = os.path.expanduser("~/gdrive-mount")
WORK_ROOT = os.path.expanduser("~/work/ab")
BUCKET = "r2:hannan-audio"
ARTIST_NAMES = {"jerry": "Jerry Hannan", "sean": "Sean Hannan",
                "mad": "Mad Hannans", "seanjerry": "Sean & Jerry Hannan"}

sys.path.insert(0, HERE)
import audio_process as ap  # noqa: E402


def load_track(slug, num):
    data = json.load(open(os.path.join(ROOT, "data", "recordings.json")))
    show = next((s for s in data["shows"] if s["slug"] == slug), None)
    if not show:
        raise SystemExit(f"show slug {slug!r} not found in recordings.json")
    track = next((t for t in (show.get("tracks") or []) if t["num"] == num), None)
    if not track:
        raise SystemExit(f"track {num} not found in {slug!r}")
    return show, track


def load_provenance(slug, num):
    path = os.path.join(ROOT, "data", "processing", f"{slug}.json")
    if not os.path.exists(path):
        return {}
    d = json.load(open(path))
    return d.get("tracks", {}).get(str(num), {})


def find_raw_source(track, explicit):
    if explicit:
        if not os.path.exists(explicit):
            raise SystemExit(f"--raw path does not exist: {explicit}")
        return explicit
    if not os.path.isdir(GDRIVE_MOUNT):
        raise SystemExit(f"no --raw given and {GDRIVE_MOUNT} doesn't exist")
    title_words = re.sub(r"[^a-z0-9 ]", "", track["title"].lower()).split()
    candidates = []
    for f in os.listdir(GDRIVE_MOUNT):
        if not f.lower().endswith((".flac", ".wav")):
            continue
        fl = f.lower()
        if str(track["num"]) not in fl and f"{track['num']:02d}" not in fl:
            continue
        if any(w in fl for w in title_words if len(w) > 2):
            candidates.append(os.path.join(GDRIVE_MOUNT, f))
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        raise SystemExit(
            f"no raw source for track {track['num']} {track['title']!r} found on "
            f"{GDRIVE_MOUNT} — export it from the show's .aup3 Audacity project "
            f"and place it there (or pass --raw PATH)")
    raise SystemExit(f"multiple candidates found, pass --raw explicitly: {candidates}")


def run(cmd, **kw):
    print("  $ " + " ".join(cmd))
    subprocess.run(cmd, check=True, **kw)


def audio_md5(path):
    return ap.audio_md5(path)


def ebur128_curve(path):
    """Short-term (3s window) loudness every ~100ms, plus the file's own
    integrated loudness — for the loudness-over-time chart."""
    err = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", path, "-af", "ebur128=peak=true", "-f", "null", "-"],
        capture_output=True, text=True).stderr
    points = []
    for m in re.finditer(r"t:\s*([\d.]+)\s+TARGET:.*?M:\s*(-?[\d.]+)\s+S:\s*(-?[\d.]+)\s+I:\s*(-?[\d.]+)", err):
        t, mval, sval, ival = (float(x) for x in m.groups())
        points.append([round(t, 2), sval])
    m = re.search(r"Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+)\s*LUFS", err)
    integrated = float(m.group(1)) if m else (points[-1][1] if points else 0.0)
    return points, integrated


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def build_params_rows(show, track, plan, live_measure, new_measure, live_ver, new_ver):
    target = ap.ARTIST_TARGET[show["artist"]]
    rows = []
    rows.append(("Requested target", f"&minus;{abs(target):g} LUFS (nominal)",
                  f"&minus;{abs(target):g} LUFS (nominal; engine checks for overshoot automatically)"))
    rows.append(("Predicted true peak at target",
                  "not computed (predates the check)" if live_ver in (1, 2, 3) else f"{plan['pred']:+.1f} dBTP",
                  f"{plan['pred']:+.1f} dBTP" + (" &gt; &minus;1 ceiling &rarr; triggers headroom recovery" if plan["pred"] > ap.TP_CEILING else " — fits under the ceiling")))
    mode_desc = {
        "linear": "plain linear gain to the nominal target",
        "linear-reduced": f"linear gain, reduced to the track's own max linear target ({plan['target']:+.1f} LUFS) — avoids ffmpeg's silent dynamic-mode fallback",
        "applause-limiter": (f"<strong>applause-limiter</strong>: one constant "
                              f"{plan.get('gain_db', 0):+.1f} dB gain sized to the music's own peak "
                              f"({plan.get('music_peak_db', 0):.1f} dBFS), plus a lookahead limiter "
                              f"reaching only the flagged applause region(s)"),
    }[plan["mode"]]
    live_mode_desc = ("plain <code>loudnorm linear=true</code> request — predates the v4/v5 overshoot "
                       "handling; likely fell back to dynamic (frame-adaptive) normalization silently "
                       "if the source overshot the ceiling") if live_ver in (1, 2, 3) else "(same engine logic as B)"
    rows.append(("Mode used", live_mode_desc, mode_desc))
    if plan["mode"] == "applause-limiter" and plan.get("regions"):
        region_txt = ", ".join(f"{a}&ndash;{b} ({-r:.1f} dB)" for a, b, r in plan["regions"])
        rows.append(("Limited regions", "n/a", region_txt))
    rows.append(("Achieved loudness", f"{live_measure['input_i']} LUFS", f"{new_measure['input_i']} LUFS"))
    rows.append(("Achieved true peak", f"{live_measure['input_tp']} dBTP", f"{new_measure['input_tp']} dBTP"))
    html = []
    for label, a, b in rows:
        html.append(f"      <tr><td>{esc(label)}</td><td>{a}</td><td>{b}</td></tr>")
    return "\n".join(html)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("slug", help="show slug in recordings.json")
    parser.add_argument("track", type=int, help="track number")
    parser.add_argument("--raw", help="path to the original unprocessed clip (default: search ~/gdrive-mount)")
    parser.add_argument("--port", type=int, default=8767)
    args = parser.parse_args()

    show, track = load_track(args.slug, args.track)
    artist = show["artist"]
    target = ap.ARTIST_TARGET[artist]
    live_prov = load_provenance(args.slug, args.track)
    live_ver = live_prov.get("ver", "?")

    print(f"{show['slug']} track {args.track}: {track['title']!r} ({show.get('artist')}, "
          f"target {target} LUFS, currently v{live_ver})")

    raw_src = find_raw_source(track, args.raw)
    print(f"raw source: {raw_src}")

    work = os.path.join(WORK_ROOT, f"{args.slug}-{args.track:02d}")
    raw_dir, out_dir, final_dir = (os.path.join(work, d) for d in ("raw", "out", "final"))
    for d in (raw_dir, out_dir, final_dir):
        os.makedirs(d, exist_ok=True)

    raw_dest = os.path.join(raw_dir, os.path.basename(raw_src))
    shutil.copy(raw_src, raw_dest)

    print("\n== diagnose (full) ==")
    run([sys.executable, os.path.join(HERE, "audio_process.py"), "diagnose", raw_dir, "--artist", artist])

    plan = ap.plan_track(raw_dest, target)
    print(f"\nplan: mode={plan['mode']} target={plan['target']:.2f} LUFS — {plan['note']}")

    print("\n== process (current engine) ==")
    run([sys.executable, os.path.join(HERE, "audio_process.py"), "process", raw_dir, out_dir, "--target", str(target)])

    base = os.path.splitext(os.path.basename(raw_dest))[0]
    new_flac = os.path.join(out_dir, base + ".flac")
    new_mp3 = os.path.join(out_dir, base + ".mp3")
    if not os.path.exists(new_flac):
        # process() preserves the source extension; raw might be .wav
        new_flac = glob.glob(os.path.join(out_dir, base + ".*"))[0]

    print("\n== fetching current live version from R2 ==")
    live_dir = os.path.join(work, "live")
    os.makedirs(live_dir, exist_ok=True)
    run(["rclone", "copy", f"{BUCKET}/{track['flac']}", live_dir, "--s3-no-check-bucket"])
    live_flac = os.path.join(live_dir, os.path.basename(track["flac"]))
    if live_prov.get("md5"):
        got = audio_md5(live_flac)
        if got != live_prov["md5"]:
            print(f"  WARNING: live file MD5 {got} != provenance {live_prov['md5']} — "
                  f"comparison may not reflect what's actually published")
        else:
            print(f"  MD5 verified against provenance: {got}")

    print("\n== measuring both versions ==")
    live_measure = ap.measure(live_flac, target)
    new_measure = ap.measure(new_flac, plan["target"])
    print(f"  live (v{live_ver}): {live_measure['input_i']} LUFS / {live_measure['input_tp']} dBTP")
    print(f"  new  (v{ap.WORKFLOW_VERSION}): {new_measure['input_i']} LUFS / {new_measure['input_tp']} dBTP")

    print("\n== extracting loudness-over-time curves ==")
    pts_live, integ_live = ebur128_curve(live_flac)
    pts_new, integ_new = ebur128_curve(new_flac)

    label_a = f"v{live_ver} (live now)"
    label_b = f"v{ap.WORKFLOW_VERSION} (reprocessed)"
    file_a = f"{track['title']} - {label_a}{os.path.splitext(live_flac)[1]}"
    file_b_flac = f"{track['title']} - {label_b}.flac"
    file_b_mp3 = f"{track['title']} - {label_b}.mp3"
    shutil.copy(live_flac, os.path.join(final_dir, file_a))
    shutil.copy(new_flac, os.path.join(final_dir, file_b_flac))
    if os.path.exists(new_mp3):
        shutil.copy(new_mp3, os.path.join(final_dir, file_b_mp3))

    limited_regions = []
    if plan["mode"] == "applause-limiter":
        for a, b, r in plan.get("regions", []):
            limited_regions.append([a, b, f"applause-limited (B), {-r:.1f} dB"])

    title = f"{track['title']} — v{live_ver} vs v{ap.WORKFLOW_VERSION} A/B"
    venue = show.get("venue_short") or show.get("venue") or ""
    date = show.get("date") or "unknown date"
    subtitle_bits = [ARTIST_NAMES.get(artist, artist), venue, date, f"track {args.track}"]
    subtitle = " · ".join(b for b in subtitle_bits if b)

    params_desc = (f"Source overshoots the show's nominal &minus;{abs(target):g} LUFS target by "
                    f"<strong>{plan['pred']:+.1f} dBTP</strong> at full scale.")
    chart_desc = ("Short-term (3s window) loudness, plotted relative to each file's own integrated "
                  "average — isolates the shape of the dynamics from any overall level difference "
                  "between the two versions.")

    params_rows = build_params_rows(show, track, plan, live_measure, new_measure, live_ver, ap.WORKFLOW_VERSION)
    loudness_data = json.dumps({
        "a": {"label": label_a, "integrated": integ_live, "points": pts_live},
        "b": {"label": label_b, "integrated": integ_new, "points": pts_new},
    })

    template = open(os.path.join(HERE, "ab_template.html")).read()
    html = (template
            .replace("__TITLE__", esc(title))
            .replace("__SUBTITLE__", esc(subtitle))
            .replace("__LABEL_A__", esc(label_a))
            .replace("__LABEL_B__", esc(label_b))
            .replace("__PARAMS_DESC__", params_desc)
            .replace("__PARAMS_ROWS__", params_rows)
            .replace("__CHART_DESC__", chart_desc)
            .replace("__FILE_A__", file_a.replace('"', '\\"'))
            .replace("__FILE_B__", file_b_flac.replace('"', '\\"'))
            .replace("__LOUDNESS_DATA__", loudness_data)
            .replace("__LIMITED_REGIONS__", json.dumps(limited_regions)))
    open(os.path.join(final_dir, "index.html"), "w").write(html)

    print(f"\n== done — serving {final_dir} ==")
    os.execv(sys.executable, [sys.executable, os.path.join(HERE, "ab_server.py"), str(args.port), final_dir])


if __name__ == "__main__":
    main()
