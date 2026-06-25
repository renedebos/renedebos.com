#!/usr/bin/env python3
"""Local-only metadata editor for data/recordings.json.

Serves a single-page editor at http://127.0.0.1:<port> for the *editorial*
fields only — song titles, per-track artist credits, venue, date, subtitle,
description, and tags. Machine-derived fields (file paths, durations, sizes,
track numbers, the recordings[] list) are shown read-only and never touched:
the browser holds the whole JSON object and mutates only managed fields, so
everything else rides through a save unchanged.

Saving writes recordings.json directly after a timestamped backup. Run
`python3 scripts/build.py` and commit afterward to publish the changes.

This file and its UI live in scripts/, which is .assetsignore'd, so the editor
is never deployed.

Usage:
  python3 scripts/edit_metadata.py                 # opens the browser
  python3 scripts/edit_metadata.py --port 9000
  python3 scripts/edit_metadata.py --no-open
"""
import argparse
import datetime
import http.server
import json
import os
import shutil
import socketserver
import threading
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data", "recordings.json")
EDITOR_HTML = os.path.join(HERE, "metadata_editor.html")
BACKUP_DIR = os.path.join(HERE, ".metadata-backups")


class Handler(http.server.BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            with open(EDITOR_HTML, "rb") as f:
                self._send(200, f.read(), "text/html; charset=utf-8")
        elif self.path == "/api/data":
            with open(DATA, "rb") as f:
                self._send(200, f.read(), "application/json")
        else:
            self._send(404, '{"error":"not found"}')

    def do_POST(self):
        if self.path != "/api/save":
            self._send(404, '{"error":"not found"}')
            return
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        try:
            obj = json.loads(raw)
        except Exception as e:
            self._send(400, json.dumps({"error": f"invalid JSON: {e}"}))
            return
        # Refuse to overwrite with anything that isn't recognisably the dataset.
        if not isinstance(obj, dict) or "shows" not in obj or "artists" not in obj:
            self._send(400, json.dumps({"error": "missing expected top-level keys"}))
            return
        os.makedirs(BACKUP_DIR, exist_ok=True)
        ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = f"recordings-{ts}.json"
        shutil.copy2(DATA, os.path.join(BACKUP_DIR, backup))
        with open(DATA, "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=2, ensure_ascii=False)
            f.write("\n")
        self._send(200, json.dumps({"ok": True, "backup": backup}))

    def log_message(self, *args):
        pass  # quiet


class Server(socketserver.TCPServer):
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-open", action="store_true")
    args = ap.parse_args()

    url = f"http://127.0.0.1:{args.port}/"
    with Server(("127.0.0.1", args.port), Handler) as httpd:
        print(f"Metadata editor:  {url}")
        print(f"Editing file:     {DATA}")
        print(f"Backups:          scripts/.metadata-backups/")
        print("Ctrl-C to stop.")
        if not args.no_open:
            threading.Timer(0.6, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
