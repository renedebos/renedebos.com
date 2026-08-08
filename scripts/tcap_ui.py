#!/usr/bin/env python3
"""Local-only control panel for the sparse-transient-cap rollout (workflow v8).

Serves a single page at http://127.0.0.1:<port> with three layers:

1. SCAN (instant, offline) — reads data/recordings.json + the provenance
   sidecars and classifies every track by its loudness gap to the show target:
   at-target / close-enough (<1 dB) / CANDIDATE (1-6 dB, the cap's window) /
   too-quiet-for-cap (>6 dB). No audio is read; this is the "which shows
   would benefit" table.

2. ANALYZE (per show, background) — fetches the published FLACs for the
   show's candidate tracks from R2 (MD5-checked against provenance) and runs
   the REAL engine decision (`audio_process.plan_track(transient_cap=True)`)
   on each, so the page shows exactly what a reprocess would do: capped (with
   depth/engagement stats) or declined (with the reason). Valid because
   linear/linear-reduced outputs are linear transforms of their sources;
   applause-limiter and pre-v5 tracks are marked approximate/needs-source.
   Downloads are deleted after analysis.

3. REPROCESS (per show, background) — drives the existing runbook commands:
   `publish_show.py prepare <slug>` then, after the diagnose gate,
   `publish_show.py publish <slug> [--transient-cap]`, streaming their logs
   into the page. The human steps (CLIPPING verdicts, draft_tracks flags,
   description/history, build + commit) stay human — the page nags about
   them instead of pretending to do them.

One background job at a time. State lives under ~/work/tcap-ui/<slug>/.
This file and its UI live in scripts/, which is .assetsignore'd — the tool
is never deployed.

Usage:
  python3 scripts/tcap_ui.py                 # opens the browser
  python3 scripts/tcap_ui.py --port 8769 --no-open
"""
import argparse
import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import sys
import threading
import urllib.parse
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import audio_process as ap  # noqa: E402  (plan_track, measure, targets)

UI_HTML = os.path.join(HERE, "tcap_ui.html")
WORK = os.path.expanduser("~/work/tcap-ui")
PUBLISH_STATE = os.path.expanduser("~/work/{slug}/publish.json")
BUCKET = "r2:hannan-audio"

# One job at a time — prepare/publish are bandwidth- and disk-heavy, and a
# second concurrent analyze would make the log pane a lie.
_job_lock = threading.Lock()
_job = None  # {"slug","kind","log","proc"|None,"thread"|None,"rc"|None,"done"}


def _shows():
    data = json.load(open(os.path.join(ROOT, "data", "recordings.json")))
    return [s for s in data["shows"] if s.get("tracks")]


def _sidecar(slug):
    p = os.path.join(ROOT, "data", "processing", f"{slug}.json")
    try:
        return json.load(open(p)).get("tracks", {})
    except Exception:
        return {}


def scan():
    """Offline candidacy per track, rolled up per show. Candidacy is judged
    purely on the published loudness gap (out LUFS vs the show target) — the
    sparsity gate needs audio and is Analyze's job. Whatever mode produced
    the current file, a reprocess re-decides modes fresh, so the gap is the
    honest first-pass filter."""
    out = []
    for s in _shows():
        target = ap.ARTIST_TARGET[s["artist"]]
        side = _sidecar(s["slug"])
        rows, counts = [], {"at": 0, "close": 0, "candidate": 0, "over": 0}
        lufs_vals = []
        for t in s["tracks"]:
            d = side.get(str(t["num"]), {})
            lufs, mode, ver = d.get("lufs"), d.get("mode"), d.get("ver")
            gap = round(target - lufs, 2) if lufs is not None else None
            if lufs is not None:
                lufs_vals.append(lufs)
            if gap is None:
                cls = "unknown"
            elif gap < ap.TCAP_MIN_BENEFIT:
                cls = "close" if gap >= 0.5 else "at"
            elif gap <= ap.TCAP_MAX_GR:
                cls = "candidate"
            else:
                cls = "over"
            if cls in counts:
                counts[cls] += 1
            rows.append({"num": t["num"], "title": t["title"], "lufs": lufs,
                         "gap": gap, "mode": mode, "ver": ver, "cls": cls,
                         "approx": mode is None or mode == "applause-limiter"})
        spread = (round(max(lufs_vals) - min(lufs_vals), 1)
                  if len(lufs_vals) > 1 else 0.0)
        out.append({"slug": s["slug"], "artist": s["artist"],
                    "venue": s.get("venue_short") or s.get("venue") or "",
                    "date": s.get("date") or "", "target": target,
                    "n": len(s["tracks"]), "counts": counts, "spread": spread,
                    "tracks": rows,
                    "analysis": _analysis(s["slug"]),
                    "prepared": os.path.exists(
                        PUBLISH_STATE.format(slug=s["slug"]))})
    out.sort(key=lambda r: (-r["counts"]["candidate"], -r["spread"]))
    return out


def _analysis_path(slug):
    return os.path.join(WORK, slug, "analysis.json")


def _analysis(slug):
    try:
        return json.load(open(_analysis_path(slug)))
    except Exception:
        return None


def _log(msg, logf):
    logf.write(msg + "\n")
    logf.flush()


def analyze_worker(slug, nums, logpath):
    """Fetch each candidate track's published FLAC and run the engine's own
    plan_track(transient_cap=True) on it — the same decision a reprocess
    would make, including every eligibility gate."""
    global _job
    shows = {s["slug"]: s for s in _shows()}
    s = shows[slug]
    target = ap.ARTIST_TARGET[s["artist"]]
    side = _sidecar(slug)
    audio_dir = os.path.join(WORK, slug, "audio")
    os.makedirs(audio_dir, exist_ok=True)
    results = {}
    prev = _analysis(slug) or {}
    results.update(prev.get("tracks", {}))
    def is_candidate(t):
        d = side.get(str(t["num"]), {})
        if d.get("lufs") is None:
            return False
        gap = target - d["lufs"]
        return ap.TCAP_MIN_BENEFIT <= gap <= ap.TCAP_MAX_GR

    with open(logpath, "w") as logf:
        try:
            todo = [t for t in s["tracks"]
                    if (t["num"] in nums if nums else is_candidate(t))]
            _log(f"analyzing {len(todo)} track(s) of {len(s['tracks'])} "
                 f"({'explicit list' if nums else 'candidates only'})", logf)
            for i, t in enumerate(todo, 1):
                d = side.get(str(t["num"]), {})
                mode = d.get("mode")
                if mode == "applause-limiter":
                    _log(f"[{i}/{len(todo)}] #{t['num']} {t['title']}: "
                         "applause-limited — published file is not a linear "
                         "transform of the source; needs the Drive source "
                         "(prepare does that). Skipping.", logf)
                    results[str(t["num"])] = {"skip": "applause-limited; needs source"}
                    continue
                key = t.get("flac")
                if not key:
                    results[str(t["num"])] = {"skip": "no FLAC key"}
                    continue
                dest = os.path.join(audio_dir, os.path.basename(key))
                _log(f"[{i}/{len(todo)}] #{t['num']} {t['title']}: fetching…", logf)
                r = subprocess.run(["rclone", "copy", f"{BUCKET}/{key}",
                                    audio_dir, "--s3-no-check-bucket"],
                                   capture_output=True, text=True)
                if r.returncode != 0 or not os.path.exists(dest):
                    results[str(t["num"])] = {"error": "fetch failed"}
                    _log(f"  fetch FAILED: {r.stderr[-200:]}", logf)
                    continue
                if d.get("md5"):
                    got = ap.audio_md5(dest)
                    if got != d["md5"]:
                        results[str(t["num"])] = {
                            "error": f"MD5 mismatch vs provenance ({got})"}
                        _log("  MD5 MISMATCH vs provenance — not analyzing "
                             "a file that isn't what we shipped", logf)
                        os.remove(dest)
                        continue
                plan = ap.plan_track(dest, target, transient_cap=True)
                entry = {"mode": plan["mode"], "target": plan["target"],
                         "flags": plan["flags"],
                         "approx": d.get("ver") in (1, 2, 3) or "ver" not in d}
                if plan["mode"] == "sparse-transient-cap":
                    entry["tcap"] = plan["tcap"]
                    _log(f"  → CAP: +{plan['tcap']['gain_db']:.1f} dB to "
                         f"{plan['target']:g} LUFS, max {plan['tcap']['gr_db']:.1f} dB, "
                         f"{plan['tcap']['engaged_pct']:.1f}% engaged, "
                         f"{plan['tcap']['near_peak_pct']:.1f}% near-peak", logf)
                else:
                    _log(f"  → {plan['mode']} @ {plan['target']:g} LUFS", logf)
                for fl in plan["flags"]:
                    _log(f"  ⚠ {fl}", logf)
                results[str(t["num"])] = entry
                os.remove(dest)
            payload = {"target": target, "tracks": results}
            os.makedirs(os.path.dirname(_analysis_path(slug)), exist_ok=True)
            json.dump(payload, open(_analysis_path(slug), "w"), indent=1)
            _log("analysis saved.", logf)
            _job["rc"] = 0
        except Exception as e:  # surface, don't vanish — the page shows the log
            _log(f"ANALYZE FAILED: {e!r}", logf)
            _job["rc"] = 1
        finally:
            shutil.rmtree(audio_dir, ignore_errors=True)
            _job["done"] = True


def start_job(slug, kind, extra):
    global _job
    with _job_lock:
        if _job and not _job["done"]:
            return None, "a job is already running"
        os.makedirs(os.path.join(WORK, slug), exist_ok=True)
        logpath = os.path.join(WORK, slug, f"{kind}.log")
        if kind == "analyze":
            _job = {"slug": slug, "kind": kind, "log": logpath, "proc": None,
                    "thread": None, "rc": None, "done": False}
            th = threading.Thread(target=analyze_worker,
                                  args=(slug, extra.get("nums") or [], logpath),
                                  daemon=True)
            _job["thread"] = th
            th.start()
        elif kind in ("prepare", "publish"):
            cmd = [sys.executable, os.path.join(HERE, "publish_show.py"),
                   kind, slug]
            if kind == "publish" and extra.get("transient_cap"):
                cmd.append("--transient-cap")
            if kind == "prepare" and extra.get("folder"):
                cmd += ["--folder", extra["folder"]]
            logf = open(logpath, "w")
            proc = subprocess.Popen(cmd, stdout=logf, stderr=subprocess.STDOUT,
                                    cwd=ROOT)
            _job = {"slug": slug, "kind": kind, "log": logpath, "proc": proc,
                    "thread": None, "rc": None, "done": False}

            def reap():
                _job["rc"] = proc.wait()
                _job["done"] = True
                logf.close()
            threading.Thread(target=reap, daemon=True).start()
        else:
            return None, f"unknown job kind {kind!r}"
        return _job, None


def job_status(offset):
    if _job is None:
        return {"active": False}
    tail, size = "", 0
    try:
        size = os.path.getsize(_job["log"])
        with open(_job["log"]) as f:
            f.seek(max(0, offset))
            tail = f.read()
    except OSError:
        pass
    return {"active": True, "slug": _job["slug"], "kind": _job["kind"],
            "done": _job["done"], "rc": _job["rc"], "log": tail, "size": size}


class Handler(http.server.BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path in ("/", "/index.html"):
            with open(UI_HTML, "rb") as f:
                self._send(200, f.read(), "text/html; charset=utf-8")
        elif url.path == "/api/scan":
            self._send(200, json.dumps(scan()))
        elif url.path == "/api/job":
            q = urllib.parse.parse_qs(url.query)
            off = int(q.get("offset", ["0"])[0])
            self._send(200, json.dumps(job_status(off)))
        else:
            self._send(404, '{"error": "not found"}')

    def do_POST(self):
        m = re.match(r"^/api/(analyze|prepare|publish)/([a-z0-9-]+)$", self.path)
        if not m:
            self._send(404, '{"error": "not found"}')
            return
        kind, slug = m.groups()
        if slug not in {s["slug"] for s in _shows()}:
            self._send(404, '{"error": "unknown slug"}')
            return
        n = int(self.headers.get("Content-Length") or 0)
        extra = json.loads(self.rfile.read(n) or b"{}") if n else {}
        if kind == "publish" and not os.path.exists(PUBLISH_STATE.format(slug=slug)):
            self._send(409, '{"error": "no publish.json — run prepare first"}')
            return
        job, err = start_job(slug, kind, extra)
        if err:
            self._send(409, json.dumps({"error": err}))
        else:
            self._send(200, json.dumps({"started": kind, "slug": slug}))

    def log_message(self, *args):
        pass


class Server(socketserver.TCPServer):
    allow_reuse_address = True


def main():
    apar = argparse.ArgumentParser(description=__doc__)
    apar.add_argument("--port", type=int, default=8769)
    apar.add_argument("--no-open", action="store_true")
    args = apar.parse_args()
    os.makedirs(WORK, exist_ok=True)
    url = f"http://127.0.0.1:{args.port}/"
    with Server(("127.0.0.1", args.port), Handler) as httpd:
        print(f"sparse-transient-cap control panel: {url}  (Ctrl-C to stop)")
        if not args.no_open:
            threading.Timer(0.6, lambda: webbrowser.open(url)).start()
        httpd.serve_forever()


if __name__ == "__main__":
    main()
