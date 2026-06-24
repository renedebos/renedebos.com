#!/usr/bin/env python3
"""Prototype tooling: pre-compute waveform peaks for the wavesurfer.js lab page.

For each local track mp3 of the Sean Hannan 19 Broadway (unknown date) show, decode
to mono 8 kHz PCM with ffmpeg, bucket into ~400 peaks (max-abs per bucket, normalized
0-1), and capture the duration. Writes data/peaks/sean-19-broadway-unknown.json keyed
by track number: { "1": {"d": 175, "p": [..400 floats..]}, ... }.

These peaks let wavesurfer render the waveform without downloading the audio (avoids
the streaming Worker's CORS scope and ~150 MB of page-load fetches); playback still
streams lazily through a native media element.
"""
import array
import json
import os
import subprocess

LOCAL = "/home/renedebos/gdrive-mount/SeanHannan - 19 Broadway unknown date/Tracks Normalized"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "data", "peaks", "sean-19-broadway-unknown.json")
N_PEAKS = 400
SR = 8000

# track num -> local mp3 filename (matches scripts table used for the R2 upload)
LOCAL_MP3 = {
    1:  "01 Woman1.mp3",
    2:  "02 Long Black Veil.mp3",
    3:  "03 don't Think Twice It's Alright.mp3",
    4:  "04 I Thought I Was You.mp3",
    5:  "05 Gold's Gym Guy.mp3",
    6:  "06 The German Clockwinder.mp3",
    7:  "07 Model Family Man.mp3",
    8:  "08 Flag Decal.mp3",
    9:  "09 Galway Shawl.mp3",
    10: "10 The Grey Funnel Line w_Jerry.mp3",
    11: "11 Rugburns w_Jerry.mp3",
    12: "12 Elephant Shoes w_Jerry.mp3",
    13: "13 Daddy w_Kelly Peterson.mp3",
    14: "14 Angel of Montgomery w_Kelly Peterson.mp3",
    15: "15 The Black Velvet Band.mp3",
    16: "16 The Good Life.mp3",
    17: "17 Ode to Billy McGee.mp3",
    18: "18 The One I Love.mp3",
}


def pcm(path):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR),
         "-f", "s16le", "-"],
        capture_output=True, check=True).stdout
    a = array.array("h")
    a.frombytes(raw)
    return a


def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip()
    return round(float(out))


def peaks(samples, n=N_PEAKS):
    total = len(samples)
    if total == 0:
        return [0.0] * n
    step = total / n
    out = []
    for i in range(n):
        lo = int(i * step)
        hi = max(lo + 1, int((i + 1) * step))
        chunk = samples[lo:hi]
        m = max((abs(s) for s in chunk), default=0)
        out.append(round(m / 32768.0, 3))
    return out


def main():
    data = {}
    for num, name in LOCAL_MP3.items():
        path = os.path.join(LOCAL, name)
        if not os.path.exists(path):
            raise SystemExit(f"missing local file: {path}")
        data[str(num)] = {"d": duration(path), "p": peaks(pcm(path))}
        print(f"[{num:02d}] {name}  d={data[str(num)]['d']}s  peaks={len(data[str(num)]['p'])}", flush=True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(data, open(OUT, "w"))
    print(f"\nwrote {OUT} ({len(data)} tracks)")


if __name__ == "__main__":
    main()
