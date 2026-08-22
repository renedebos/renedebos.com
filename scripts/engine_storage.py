"""R2/Drive storage-verification helpers: decoded-audio MD5 of a remote
object (rclone cat piped through ffmpeg), used by `verify` to confirm
published audio still matches its provenance sidecar. Moved out of
audio_process.py 2026-08-22 verbatim.
"""
import subprocess

from engine_constants import BUCKET


# ── verify (#8 integrity / drift) ─────────────────────────────────────────────

def remote_md5(remote):
    """Decoded-audio MD5 of one remote object (rclone cat -> ffmpeg), or ""
    when rclone could not read it (missing file, bad path). Checked on
    rclone's exit code: an unreadable object hands ffmpeg an empty stream,
    whose "MD5" is a perfectly valid-looking hash of nothing."""
    flags = ["--s3-no-check-bucket"] if remote.startswith("r2:") else []
    rc = subprocess.Popen(["rclone", "cat", remote, *flags],
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    ff = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
                         "-map", "0:a", "-f", "md5", "-"],
                        stdin=rc.stdout, capture_output=True, text=True)
    rc.wait()
    if rc.returncode != 0:
        return ""
    return ff.stdout.strip().replace("MD5=", "")


def r2_md5(key):
    return remote_md5(f"{BUCKET}/{key}")
