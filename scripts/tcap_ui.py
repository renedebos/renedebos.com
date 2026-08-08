#!/usr/bin/env python3
"""Local-only control panel for the sparse-transient-cap rollout (workflow v8).

Serves a single page at http://127.0.0.1:<port> with three layers:

1. SCAN (instant, offline) — reads data/recordings.json + the provenance
   sidecars and classifies every track by its loudness gap to the show target:
   at-target / close-enough (<1 dB) / CANDIDATE (1-6 dB, the cap's window) /
   too-quiet-for-cap (>6 dB). No audio is read.

2. ANALYZE (per show, background) — two sources:
   - "r2" (preliminary estimate): fetches the published FLACs for candidate
     tracks (MD5-verified against provenance), runs the real engine decision
     (`plan_track(transient_cap=True)`) on each, deletes the audio. Valid for
     linear/linear-reduced outputs (linear transforms of their sources);
     applause-limiter and pre-v5 tracks are marked approximate/needs-source.
   - "prepared" (canonical): after publish_show prepare has fetched the real
     Drive sources into ~/work/<slug>/tracks/, runs the same decision on
     those exact bytes — the analysis that supports publishing. Tagged with
     the prepare fingerprint so staleness is detectable.

3. REPROCESS (per show, background) — drives the existing runbook commands
   (`publish_show.py prepare` / `publish`), streaming logs into the page.
   Per-track decisions (auto / exclude / accept-after-listening) persist in
   a small decisions.json bound to the prepared source fingerprint, and are
   passed to publish as --transient-cap-exclude/--transient-cap-accept. The
   engine's own gates (listen-flags hard-block, strict -1 dBTP, attenuation
   cap) remain the real safety barrier — this panel is the convenient face
   on them, not a substitute. Editorial steps stay human.

POSTs require the per-session token the page carries (X-Tcap-Token) plus
Host/Origin checks, so a malicious webpage can't fire drive-by requests at
the mutation endpoints. One background job at a time; Analyze is cancellable.
State lives under ~/work/tcap-ui/<slug>/. This file and its UI live in
scripts/, which is .assetsignore'd — never deployed.

Usage:
  python3 scripts/tcap_ui.py                 # opens the browser
  python3 scripts/tcap_ui.py --port 8769 --no-open
"""
import argparse
import datetime
import http.server
import json
import os
import re
import secrets
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
PREPARED_TRACKS = os.path.expanduser("~/work/{slug}/tracks")
BUCKET = "r2:hannan-audio"
TOKEN = secrets.token_hex(16)  # per-session; embedded in the page, required on POST

_job_lock = threading.Lock()
_job = None  # {"slug","kind","log","proc"|None,"thread"|None,"rc"|None,"done"}
_cancel = threading.Event()


def _shows():
    data = json.load(open(os.path.join(ROOT, "data", "recordings.json")))
    return [s for s in data["shows"] if s.get("tracks")]


def _sidecar(slug):
    p = os.path.join(ROOT, "data", "processing", f"{slug}.json")
    try:
        return json.load(open(p)).get("tracks", {})
    except Exception:
        return {}


def _publish_state(slug):
    try:
        return json.load(open(PUBLISH_STATE.format(slug=slug)))
    except Exception:
        return None


def _analysis_path(slug):
    return os.path.join(WORK, slug, "analysis.json")


def _analysis(slug):
    try:
        return json.load(open(_analysis_path(slug)))
    except Exception:
        return None


def _history_path(slug):
    return os.path.join(WORK, slug, "history.json")


def _history(slug):
    try:
        return json.load(open(_history_path(slug)))
    except Exception:
        return []


def _record_history(slug, kind, rc):
    h = _history(slug)
    h.append({"kind": kind, "rc": rc,
              "ts": datetime.datetime.now().isoformat(timespec="seconds")})
    os.makedirs(os.path.join(WORK, slug), exist_ok=True)
    json.dump(h[-50:], open(_history_path(slug), "w"), indent=1)


def _decisions_path(slug):
    return os.path.join(WORK, slug, "decisions.json")


def _decisions(slug):
    try:
        return json.load(open(_decisions_path(slug)))
    except Exception:
        return {"tracks": {}, "fingerprint": None}


def scan():
    """Offline candidacy per track, rolled up per show. Candidacy is judged
    purely on the published loudness gap — the sparsity gate needs audio and
    is Analyze's job. A reprocess re-decides modes fresh, so the gap is the
    honest first-pass filter whatever mode produced the current file."""
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
        pstate = _publish_state(s["slug"])
        last = {}
        for h in _history(s["slug"]):
            last[h["kind"]] = h  # newest wins (list is chronological)
        out.append({"slug": s["slug"], "artist": s["artist"],
                    "venue": s.get("venue_short") or s.get("venue") or "",
                    "date": s.get("date") or "", "target": target,
                    "n": len(s["tracks"]), "counts": counts, "spread": spread,
                    "tracks": rows,
                    "analysis": _analysis(s["slug"]),
                    "decisions": _decisions(s["slug"]),
                    "history": last,
                    "prepared": bool(pstate),
                    "preparedAt": (pstate or {}).get("prepared"),
                    "fingerprint": (pstate or {}).get("fingerprint")})
    out.sort(key=lambda r: (-r["counts"]["candidate"], -r["spread"]))
    return out


def _log(msg, logf):
    logf.write(msg + "\n")
    logf.flush()


def _analyze_one(path, target, logf, enabled=True, partial=False, force=False):
    """Run the engine's own decision on one file — honoring the same per-track
    decisions publish will apply — and reduce it to the entry the page
    renders."""
    plan = ap.plan_track(path, target, transient_cap=enabled,
                         tcap_partial=partial, tcap_force=force)
    entry = {"mode": plan["mode"], "target": plan["target"],
             "flags": plan["flags"]}
    if plan["mode"] == "sparse-transient-cap":
        entry["tcap"] = plan["tcap"]
        _log(f"  → CAP: +{plan['tcap']['gain_db']:.1f} dB to "
             f"{plan['target']:g} LUFS, shave max {plan['tcap']['gr_db']:.1f} dB, "
             f"{plan['tcap']['engaged_pct']:.1f}% engaged, "
             f"{plan['tcap']['near_peak_pct']:.1f}% near-peak", logf)
    else:
        _log(f"  → {plan['mode']} @ {plan['target']:g} LUFS", logf)
    for fl in plan["flags"]:
        _log(f"  ⚠ {fl}", logf)
    return entry


def narrative(slug, results, target, side, source_label):
    """Deterministic prose summary of an analysis run — the 'what does this
    mean and what's left to decide' paragraph, generated from the numbers."""
    modes = {}
    capped, declined, flagged, errors = [], [], [], []
    proj = {}
    for num_s, e in sorted(results.items(), key=lambda kv: int(kv[0])):
        if e.get("skip") or e.get("error"):
            errors.append((num_s, e.get("skip") or e.get("error")))
            continue
        modes[e["mode"]] = modes.get(e["mode"], 0) + 1
        proj[num_s] = e.get("target")
        pub = side.get(num_s, {}).get("lufs")
        # the listener-facing number is the change vs what's LIVE now, not the
        # gain applied to the canonical source (those differ whenever the
        # published version was itself gained)
        vs_live = (f", {e['target'] - pub:+.1f} dB vs live"
                   if pub is not None and e.get("target") is not None else "")
        if e["mode"] == "sparse-transient-cap":
            t = e["tcap"]
            capped.append(f"#{num_s} → {e['target']:g} LUFS{vs_live} "
                          f"(shave ≤{t['gr_db']:.1f} dB, "
                          f"{t['engaged_pct']:.1f}% engaged)")
        else:
            gap = target - e["target"]
            if gap >= 1.0:
                # authoritative mode, never inferred from flag text
                if e["mode"] == "applause-limiter":
                    why = "applause limited, music's own peak sets the ceiling"
                else:
                    reason = next((f for f in e.get("flags", [])
                                   if "declined" in f), "")
                    why = ("over the 6 dB cap" if "hard cap" in reason
                           else "not sparse (dense/repeated)" if "repeat" in reason
                           else "honest quieter linear target")
                declined.append(f"#{num_s} {e['mode']} → {e['target']:g} "
                                f"LUFS{vs_live} ({why})")
        if any("listen before shipping" in f for f in e.get("flags", [])):
            flagged.append(num_s)
    # projected spread over the whole show: analyzed tracks at their plan
    # target, the rest at their currently-published loudness
    lufs = []
    for n, d in side.items():
        if n in proj and proj[n] is not None:
            lufs.append(proj[n])
        elif d.get("lufs") is not None:
            lufs.append(d["lufs"])
    spread = f"{max(lufs) - min(lufs):.1f} dB" if len(lufs) > 1 else "n/a"
    L = [f"SUMMARY — {slug} ({source_label}, engine v{ap.WORKFLOW_VERSION})",
         "Treatments: " + (", ".join(f"{v} {k}" for k, v in sorted(modes.items()))
                           or "none analyzed"),
         f"Projected show spread after publish: {spread} "
         f"(worst analyzed track: {min(lufs):.1f} LUFS)" if lufs else ""]
    if capped:
        L.append("Capped: " + "; ".join(capped))
    if declined:
        L.append("Left quieter: " + "; ".join(declined)
                 + " — over-cap tracks can be upgraded per-track with the "
                   "'partial (cap 6 dB)' decision")
    if errors:
        L.append("Not analyzed: " + "; ".join(f"#{n} ({r})" for n, r in errors))
    if flagged:
        L.append("⚠ NEEDS EARS before publish: track(s) "
                 + ", ".join(flagged)
                 + " — listen (ab_compare), then set accept or exclude; "
                   "publish hard-blocks until decided.")
        L.append("Next: resolve the flagged track(s), then Publish.")
    else:
        L.append("No listening flags — ready to Publish once decisions "
                 "(if any) are set.")
    return "\n".join(x for x in L if x)


def analyze_worker(slug, nums, source, logpath):
    global _job
    shows = {s["slug"]: s for s in _shows()}
    s = shows[slug]
    target = ap.ARTIST_TARGET[s["artist"]]
    side = _sidecar(slug)
    audio_dir = os.path.join(WORK, slug, "audio")
    results = {}
    decs = _decisions(slug)["tracks"]
    partial_nums = {int(n) for n, v in decs.items() if v == "partial"}
    force_nums = {int(n) for n, v in decs.items() if v == "force"}
    excl_nums = {int(n) for n, v in decs.items() if v == "exclude"}

    def is_candidate(t):
        if t["num"] in partial_nums or t["num"] in force_nums:
            return True  # Rene's explicit per-track opt-in (partial/force)
        d = side.get(str(t["num"]), {})
        if d.get("lufs") is None:
            return False
        return ap.TCAP_MIN_BENEFIT <= target - d["lufs"] <= ap.TCAP_MAX_GR

    with open(logpath, "w") as logf:
        try:
            if source == "prepared":
                # canonical: the exact bytes publish will process
                tdir = PREPARED_TRACKS.format(slug=slug)
                files = sorted(f for f in os.listdir(tdir)
                               if f.lower().endswith((".flac", ".wav")))
                if nums:
                    files = [f for f in files
                             if (m := re.match(r"^(\d+)\s", f))
                             and int(m.group(1)) in nums]
                _log(f"canonical analysis of {len(files)} prepared track(s)", logf)
                for i, f in enumerate(files, 1):
                    if _cancel.is_set():
                        _log("cancelled.", logf)
                        break
                    m = re.match(r"^(\d+)\s", f)
                    num = int(m.group(1)) if m else None
                    _log(f"[{i}/{len(files)}] {f}", logf)
                    entry = _analyze_one(os.path.join(tdir, f), target, logf,
                                         enabled=num not in excl_nums,
                                         partial=num in partial_nums,
                                         force=num in force_nums)
                    if num is not None:
                        results[str(num)] = entry
                fp = (_publish_state(slug) or {}).get("fingerprint")
            else:
                # r2 estimate: candidates only, published files, MD5-verified
                prev = _analysis(slug) or {}
                if prev.get("source") == source:
                    results.update(prev.get("tracks", {}))
                os.makedirs(audio_dir, exist_ok=True)
                todo = [t for t in s["tracks"]
                        if (t["num"] in nums if nums else is_candidate(t))]
                _log(f"preliminary (R2) analysis of {len(todo)} track(s) of "
                     f"{len(s['tracks'])} "
                     f"({'explicit list' if nums else 'candidates only'})", logf)
                for i, t in enumerate(todo, 1):
                    if _cancel.is_set():
                        _log("cancelled.", logf)
                        break
                    d = side.get(str(t["num"]), {})
                    if d.get("mode") == "applause-limiter":
                        _log(f"[{i}/{len(todo)}] #{t['num']} {t['title']}: "
                             "applause-limited — not a linear transform of the "
                             "source; needs prepare. Skipping.", logf)
                        results[str(t["num"])] = {
                            "skip": "applause-limited; needs canonical source"}
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
                    if d.get("md5") and ap.audio_md5(dest) != d["md5"]:
                        results[str(t["num"])] = {
                            "error": "MD5 mismatch vs provenance"}
                        _log("  MD5 MISMATCH vs provenance — not analyzing a "
                             "file that isn't what we shipped", logf)
                        os.remove(dest)
                        continue
                    entry = _analyze_one(dest, target, logf,
                                         enabled=t["num"] not in excl_nums,
                                         partial=t["num"] in partial_nums,
                                         force=t["num"] in force_nums)
                    entry["approx"] = d.get("ver") in (1, 2, 3) or "ver" not in d
                    results[str(t["num"])] = entry
                    os.remove(dest)
                fp = None
            if not _cancel.is_set():
                src_label = ("drive-canonical" if source == "prepared"
                             else "r2-estimate")
                summary = narrative(slug, results, target, side, src_label)
                payload = {"tracks": results, "source": src_label,
                           "decisions": dict(decs),
                           "ts": datetime.datetime.now().isoformat(timespec="seconds"),
                           "engine_ver": ap.WORKFLOW_VERSION, "target": target,
                           "fingerprint": fp, "summary": summary}
                os.makedirs(os.path.dirname(_analysis_path(slug)), exist_ok=True)
                json.dump(payload, open(_analysis_path(slug), "w"), indent=1)
                _log("\n" + summary, logf)
                _log("\nanalysis saved.", logf)
            _job["rc"] = 0
        except Exception as e:  # surface, don't vanish — the page shows the log
            _log(f"ANALYZE FAILED: {e!r}", logf)
            _job["rc"] = 1
        finally:
            shutil.rmtree(audio_dir, ignore_errors=True)
            _record_history(slug, f"analyze-{source}", _job["rc"])
            _job["done"] = True


def start_job(slug, kind, extra):
    global _job
    with _job_lock:
        if _job and not _job["done"]:
            return None, "a job is already running"
        os.makedirs(os.path.join(WORK, slug), exist_ok=True)
        logpath = os.path.join(WORK, slug, f"{kind}.log")
        if kind == "analyze":
            source = extra.get("source", "r2")
            if source == "prepared" and not os.path.isdir(
                    PREPARED_TRACKS.format(slug=slug)):
                return None, "no prepared tracks/ — run Prepare first"
            _cancel.clear()
            _job = {"slug": slug, "kind": kind, "log": logpath, "proc": None,
                    "thread": None, "rc": None, "done": False}
            th = threading.Thread(
                target=analyze_worker,
                args=(slug, extra.get("nums") or [], source, logpath),
                daemon=True)
            _job["thread"] = th
            th.start()
        elif kind in ("prepare", "publish"):
            cmd = [sys.executable, os.path.join(HERE, "publish_show.py"),
                   kind, slug]
            if kind == "publish":
                dec = _decisions(slug)
                fp = (_publish_state(slug) or {}).get("fingerprint")
                if dec["tracks"] and dec.get("fingerprint") != fp:
                    return None, ("decisions were made against a different "
                                  "prepared source (fingerprint mismatch) — "
                                  "re-review after the latest prepare")
                excl = ",".join(n for n, v in sorted(dec["tracks"].items(),
                                                     key=lambda kv: int(kv[0]))
                                if v == "exclude")
                acc = ",".join(n for n, v in sorted(dec["tracks"].items(),
                                                    key=lambda kv: int(kv[0]))
                               if v == "accept")
                part = ",".join(n for n, v in sorted(dec["tracks"].items(),
                                                     key=lambda kv: int(kv[0]))
                                if v == "partial")
                if extra.get("transient_cap"):
                    cmd.append("--transient-cap")
                if excl:
                    cmd += ["--transient-cap-exclude", excl]
                if acc:
                    cmd += ["--transient-cap-accept", acc]
                if part:
                    cmd += ["--transient-cap-partial", part]
                frc = ",".join(n for n, v in sorted(dec["tracks"].items(),
                                                    key=lambda kv: int(kv[0]))
                               if v == "force")
                if frc:
                    cmd += ["--transient-cap-force", frc]
            if kind == "prepare" and extra.get("folder"):
                cmd += ["--folder", extra["folder"]]
            logf = open(logpath, "w")
            proc = subprocess.Popen(cmd, stdout=logf, stderr=subprocess.STDOUT,
                                    cwd=ROOT)
            _job = {"slug": slug, "kind": kind, "log": logpath, "proc": proc,
                    "thread": None, "rc": None, "done": False}

            def reap():
                _job["rc"] = proc.wait()
                _record_history(slug, kind, _job["rc"])
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
            "done": _job["done"], "rc": _job["rc"], "log": tail, "size": size,
            "cancellable": _job["kind"] == "analyze" and not _job["done"]}


class Handler(http.server.BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _local_ok(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost"):
            return False
        origin = self.headers.get("Origin")
        if origin:
            oh = urllib.parse.urlparse(origin).hostname
            if oh not in ("127.0.0.1", "localhost"):
                return False
        return True

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path in ("/", "/index.html"):
            html = open(UI_HTML).read().replace("__TOKEN__", TOKEN)
            self._send(200, html, "text/html; charset=utf-8")
        elif url.path == "/api/scan":
            self._send(200, json.dumps(scan()))
        elif url.path.startswith("/report/"):
            slug = url.path[len("/report/"):]
            if (re.fullmatch(r"[a-z0-9-]+", slug)
                    and slug in {s["slug"] for s in _shows()}):
                p = os.path.join(os.path.expanduser(f"~/work/{slug}"),
                                 "tracks", "diagnostic_report.txt")
                try:
                    self._send(200, open(p).read(), "text/plain; charset=utf-8")
                except OSError:
                    self._send(404, "no diagnose report on disk — run Prepare "
                                    "first (the report lives in the prepared "
                                    "tracks/ folder and is cleaned up after a "
                                    "publish)", "text/plain; charset=utf-8")
            else:
                self._send(404, '{"error": "unknown slug"}')
        elif url.path == "/api/job":
            q = urllib.parse.parse_qs(url.query)
            try:
                off = int(q.get("offset", ["0"])[0])
            except ValueError:
                off = 0
            self._send(200, json.dumps(job_status(off)))
        else:
            self._send(404, '{"error": "not found"}')

    def do_POST(self):
        # drive-by defense: local host/origin only, plus the session token the
        # page carries (a foreign page can neither read nor forge it, and the
        # custom header forces a CORS preflight that will fail)
        if not self._local_ok() or self.headers.get("X-Tcap-Token") != TOKEN:
            self._send(403, '{"error": "forbidden"}')
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            extra = json.loads(self.rfile.read(n) or b"{}") if n else {}
        except (ValueError, TypeError):
            self._send(400, '{"error": "malformed request body"}')
            return
        if self.path == "/api/cancel":
            _cancel.set()
            self._send(200, '{"cancelling": true}')
            return
        m = re.match(r"^/api/(analyze|prepare|publish|decide)/([a-z0-9-]+)$",
                     self.path)
        if not m:
            self._send(404, '{"error": "not found"}')
            return
        kind, slug = m.groups()
        if slug not in {s["slug"] for s in _shows()}:
            self._send(404, '{"error": "unknown slug"}')
            return
        if kind == "decide":
            num, dec = str(extra.get("num")), extra.get("decision")
            if dec not in ("auto", "exclude", "accept", "partial",
                           "force") or not num.isdigit():
                self._send(400, '{"error": "decision must be '
                                'auto/exclude/accept/partial/force"}')
                return
            d = _decisions(slug)
            if dec == "auto":
                d["tracks"].pop(num, None)
            else:
                d["tracks"][num] = dec
            d["fingerprint"] = (_publish_state(slug) or {}).get("fingerprint")
            os.makedirs(os.path.join(WORK, slug), exist_ok=True)
            json.dump(d, open(_decisions_path(slug), "w"), indent=1)
            self._send(200, json.dumps(d))
            return
        if kind == "publish" and not os.path.exists(
                PUBLISH_STATE.format(slug=slug)):
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
