#!/usr/bin/env python3
"""Create lossy MP3 stream proxies for the lossless full-show recordings.

For every WAV/FLAC recording in data/recordings.json that lacks a `stream`
key, this downloads the lossless file from R2, transcodes it to a 320 kbps
MP3, uploads the MP3 back to R2 under `MP3/Full/<original path>.mp3`, and then
records the MP3 key in `stream` so build.py streams the lossy proxy for free
while the lossless original stays behind the password/download gate.

Shares audio_process.py's `encode_mp3_with_qa()` — the same measure/trim/
verify loop the per-track pipeline uses — instead of a separate, weaker ad
hoc encode: the encoded MP3's true peak is measured and, if the lossy
encode would overshoot and clip on decode, a small MP3-only gain trim is
applied and it's re-encoded (never touching the source's own level — these
are whole-show proxies, so any level change would have to be ONE constant
show-wide gain to keep internal dynamics and song-to-song relationships
intact, same linear-only policy as track processing; in practice no gain is
applied here at all, only the lossy-overshoot safety trim). The loudnorm
measurement pass that finds the trim also serves as decode verification — a
corrupt/truncated encode fails loudly there instead of shipping silently.
Catalog metadata (artist/album/date) is embedded via the same tag_args() the
per-track pipeline uses, and the MP3's own audio MD5 is recorded as
`stream_md5` in recordings.json — a checksum/provenance record, same as
every lossless master already gets.

Idempotent + resumable: skips recordings that already have `stream`, reuses an
MP3 already present in R2 (linking only — no local re-encode, so no fresh
`stream_md5` in that path), and saves recordings.json after each file. Safe to
re-run after an interruption.

Usage:
  python3 scripts/make_stream_mp3.py            # process all remaining
  python3 scripts/make_stream_mp3.py <slug> ... # only the named show slug(s)
  python3 scripts/make_stream_mp3.py --limit 1  # process at most N recordings
"""
import json
import os
import subprocess
import sys
import tempfile

import audio_process as ap  # same dir; shares encode_mp3_with_qa/tag_args/show_tags

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "recordings.json")
BUCKET = "r2:hannan-audio"
R2_FLAGS = ["--s3-no-check-bucket"]
BITRATE = "320k"
MP3_PREFIX = "MP3/Full/"
# Only affects loudnorm's suggested correction, not the actual input_i/input_tp
# readings encode_mp3_with_qa relies on for its true-peak safety loop — so this
# doesn't need to be "correct" for any given show, just the archive nominal.
TARGET_LUFS = -20


def mp3_key_for(file):
    base = file.rsplit(".", 1)[0]
    return f"{MP3_PREFIX}{base}.mp3"


def r2_exists(key):
    r = subprocess.run(
        ["rclone", "lsf", f"{BUCKET}/{key}", *R2_FLAGS],
        capture_output=True, text=True,
    )
    return r.returncode == 0 and r.stdout.strip() != ""


def run(cmd):
    print("  $", " ".join(cmd[:2]), "...", flush=True)
    subprocess.run(cmd, check=True)


def lossless_recordings(data, slugs):
    for show in data["shows"]:
        if slugs and show["slug"] not in slugs:
            continue
        for rec in show["recordings"]:
            f = rec["file"].lower()
            if f.endswith(".wav") or f.endswith(".flac"):
                yield show, rec


def main():
    args = [a for a in sys.argv[1:]]
    limit = None
    if "--limit" in args:
        i = args.index("--limit")
        limit = int(args[i + 1])
        del args[i:i + 2]
    slugs = set(args)

    data = json.load(open(DATA))
    todo = [(s, r) for s, r in lossless_recordings(data, slugs) if not r.get("stream")]
    if limit is not None:
        todo = todo[:limit]

    print(f"{len(todo)} recording(s) to process\n")
    done = 0
    for show, rec in todo:
        wav_key = rec["file"]
        mp3_key = mp3_key_for(wav_key)
        print(f"[{show['slug']}] {wav_key}")

        if r2_exists(mp3_key):
            print("  MP3 already in R2 — linking only")
        else:
            with tempfile.TemporaryDirectory(dir="/home/renedebos") as tmp:
                local_wav = os.path.join(tmp, os.path.basename(wav_key))
                local_mp3 = os.path.splitext(local_wav)[0] + ".mp3"
                run(["rclone", "copyto", f"{BUCKET}/{wav_key}", local_wav, *R2_FLAGS])

                ctx = ap.show_tags(show["slug"])
                tags = ap.tag_args(ctx, os.path.basename(wav_key), None, None, TARGET_LUFS)
                result = ap.encode_mp3_with_qa(
                    local_wav, local_mp3, TARGET_LUFS, tags, bitrate=BITRATE,
                    on_trim=lambda attempt, tp_now, new_trim: print(
                        f"  MP3 true peak {tp_now:+.2f} dBTP — trimming MP3-only "
                        f"gain to {new_trim:.2f} dB total and re-encoding", flush=True))
                if not result["ok"]:
                    raise SystemExit(f"MP3 encode failed for {wav_key}: "
                                     f"{result['stderr'][-400:]}")
                if result["tp"] > 0.0:
                    print(f"  ⚠ MP3 true peak {result['tp']:+.2f} dBTP after "
                          f"{ap.MP3_TP_MAX_ATTEMPTS} attempt(s) — still clips on decode")
                print(f"  {result['lufs']:.1f} LUFS, {result['tp']:+.2f} dBTP, "
                      f"md5 {result['md5'][:8]}")

                run(["rclone", "copyto", local_mp3, f"{BUCKET}/{mp3_key}", *R2_FLAGS])
                rec["stream_md5"] = result["md5"]

        rec["stream"] = mp3_key
        json.dump(data, open(DATA, "w"), ensure_ascii=False, indent=2)
        done += 1
        print(f"  done ({done}/{len(todo)})\n", flush=True)

    print(f"Finished. {done} recording(s) now have stream proxies.")


if __name__ == "__main__":
    main()
