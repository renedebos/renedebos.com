#!/usr/bin/env python3
"""Local static file server WITH HTTP Range support, for serving audio A/B
comparisons (see ab_compare.py). Python's stdlib http.server lacks Range
support — it always returns the whole file with 200 OK — which breaks
<audio>/<video> seeking on anything but tiny files: a media element trying
to seek mid-playback can silently snap back to byte 0 instead of landing
where it asked. This is a drop-in replacement, Range support only.

Usage:
  python3 scripts/ab_server.py <port> <directory>
"""
import http.server
import os
import re
import socketserver
import sys

RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


class RangeHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    # HTTP/1.0 (the stdlib default) closes the TCP connection after every
    # response; a media element doing many sequential range requests over
    # constantly-reopened connections is exactly the pattern that can make
    # playback fail outright rather than just seek badly. HTTP/1.1 keeps
    # the connection alive (Content-Length is always sent either way, so
    # response framing is unambiguous).
    protocol_version = "HTTP/1.1"

    def send_head(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        if not os.path.exists(path):
            self.send_error(404, "File not found")
            return None

        ctype = self.guess_type(path)
        size = os.path.getsize(path)
        range_header = self.headers.get("Range")

        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        if range_header:
            m = RANGE_RE.match(range_header)
            if m:
                start = int(m.group(1)) if m.group(1) else 0
                end = int(m.group(2)) if m.group(2) else size - 1
                end = min(end, size - 1)
                length = end - start + 1
                self.send_response(206)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(length))
                self.end_headers()
                f.seek(start)
                self._range = (f, length)
                return f
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(size))
        self.end_headers()
        self._range = None
        return f

    def copyfile(self, source, outputfile):
        if getattr(self, "_range", None):
            f, length = self._range
            remaining = length
            while remaining > 0:
                chunk = f.read(min(65536, remaining))
                if not chunk:
                    break
                outputfile.write(chunk)
                remaining -= len(chunk)
        else:
            super().copyfile(source, outputfile)

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def serve(port, directory):
    os.chdir(directory)
    with Server(("127.0.0.1", port), RangeHTTPRequestHandler) as httpd:
        print(f"A/B comparison server: http://127.0.0.1:{port}/  (serving {directory})")
        print("Ctrl-C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8767
    directory = sys.argv[2] if len(sys.argv) > 2 else "."
    serve(port, directory)
