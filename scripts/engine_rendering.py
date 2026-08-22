"""Rendering/encode primitives: the optional corrective-filter chain
builder (--hpf/--lpf/--notch), output codec selection, MP3 encode+QA
(shared with make_stream_mp3.py), audio fingerprinting, and the ffmpeg
version string recorded in provenance. Moved out of audio_process.py
2026-08-22 verbatim.
"""
import subprocess

from engine_analysis import measure
from engine_constants import (
    LPF_DEFAULT_HZ, LPF_NYQUIST_MARGIN, MP3_TP_MAX_ATTEMPTS,
    NOTCH_DEPTH_DB, NOTCH_WIDTH_HZ, TP_CEILING, TP_TOL,
)


def ffmpeg_version():
    try:
        out = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True).stdout
        return out.split("\n", 1)[0].replace("ffmpeg version ", "").split()[0]
    except Exception:
        return "unknown"


def audio_md5(path):
    out = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path,
                          "-map", "0:a", "-f", "md5", "-"],
                         capture_output=True, text=True).stdout.strip()
    return out.replace("MD5=", "")


def encode_mp3_with_qa(src_path, mp3_path, target, tags, bitrate="320k",
                       max_attempts=MP3_TP_MAX_ATTEMPTS, on_trim=None):
    """Encode `src_path` (a lossless master) to an MP3 proxy at `mp3_path`
    with the same QA the per-track pipeline has always used, factored out so
    any other MP3-proxy encoder (e.g. make_stream_mp3.py's whole-show
    proxies) can reuse it instead of a weaker ad hoc encode:

    - lossy encoding can overshoot the source's own true peak even when the
      source is clean (inter-sample reconstruction on decode) — measure the
      encoded MP3's true peak and, if it would clip on decode, trim a small
      extra MP3-ONLY gain and re-encode (never touching the source's own
      gain — this is an MP3-only, listener-convenience-format concern), same
      measure-and-correct pattern as the applause/transient-cap true-peak
      loops (v6).
    - `measure()` is ffmpeg's own loudnorm/ebur128 analysis pass, which must
      fully decode the file to produce a result — a corrupt/truncated MP3
      fails loudly there instead of shipping silently, so this doubles as
      the decode-verification step.
    - the encode's own checksum is returned so the caller can record it in
      provenance, same as every lossless master already does.

    Returns a dict: `ok` (encode succeeded at all), and on success `lufs`,
    `tp`, `trim_db` (total MP3-only gain trim applied, 0.0 if none needed),
    and `md5`. On failure, `ok` is False and `stderr` holds ffmpeg's error.
    A persistently-over-ceiling MP3 after `max_attempts` still returns
    `ok=True` (matches the existing per-track warn-don't-block behavior) —
    the caller decides whether `tp` warrants a warning.
    """
    trim_db = 0.0
    out_i = out_tp = None
    for attempt in range(1, max_attempts + 1):
        af = f"volume={trim_db}dB:precision=double" if trim_db else None
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", src_path]
        if af:
            cmd += ["-af", af]
        cmd += ["-b:a", bitrate, "-id3v2_version", "3"] + tags + [mp3_path]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            return {"ok": False, "stderr": r.stderr, "trim_db": trim_db}
        j = measure(mp3_path, target)
        out_i, out_tp = float(j["input_i"]), float(j["input_tp"])
        if out_tp <= TP_CEILING + TP_TOL or attempt == max_attempts:
            break
        new_trim = round(trim_db - (out_tp - TP_CEILING) - 0.1, 2)
        if on_trim:
            on_trim(attempt, out_tp, new_trim)
        trim_db = new_trim
    return {"ok": True, "lufs": out_i, "tp": out_tp, "trim_db": trim_db,
           "md5": audio_md5(mp3_path)}


def output_codec(bits, sample_fmt, container):
    """Return ffmpeg output args for the target container, preserving bit depth."""
    b = str(bits or "")
    if container == "flac":
        if b == "16":
            return ["-c:a", "flac", "-sample_fmt", "s16"]
        if b == "24":
            return ["-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24"]
        return ["-c:a", "flac", "-sample_fmt", "s32"]
    # WAV
    if b == "16":
        return ["-c:a", "pcm_s16le"]
    if b == "24":
        return ["-c:a", "pcm_s24le"]
    if sample_fmt in ("flt", "fltp"):
        return ["-c:a", "pcm_f32le"]
    return ["-c:a", "pcm_s32le"]


def build_filters(args, sr=None):
    """Assemble the optional pre-loudnorm filter chain. `sr` (the source's own
    sample rate) is optional — omit it for a nominal/summary rendering of what
    was requested (e.g. a report header); pass it when actually building the
    chain for a specific track so --lpf can be checked against that track's
    real Nyquist frequency (different tracks in one folder can, in principle,
    have different sample rates)."""
    chain = []
    if getattr(args, "eq", None):
        chain.append(args.eq)              # literal corrective-EQ chain (v2), applied first
    if getattr(args, "hpf", None) is not None:
        chain.append(f"highpass=f={args.hpf:g}")
    if getattr(args, "lpf", False):
        freq = LPF_DEFAULT_HZ
        if sr is not None:
            nyquist = sr / 2
            if freq >= nyquist:
                clamped = round(nyquist * LPF_NYQUIST_MARGIN)
                print(f"  note: --lpf {freq:g} Hz is at/above this source's Nyquist "
                      f"frequency ({nyquist:.0f} Hz at {sr} Hz sample rate) — a "
                      f"filter at {freq:g} Hz would be a silent no-op, so clamping "
                      f"to {clamped} Hz instead", flush=True)
                freq = clamped
        chain.append(f"lowpass=f={freq:g}")
    if getattr(args, "notch", None) is not None:
        # Narrow, genuinely a "notch" (a few Hz wide via width_type=h), not the
        # old two-octave-wide cut that measured ~25.5 dB down at the guitar's
        # 82 Hz low E. Harmonics are opt-in (--notch-harmonics) rather than
        # stacked automatically — this is a code fix, not a per-recording
        # tuning session, so don't guess which harmonics are actually present.
        freq = args.notch
        n_harm = getattr(args, "notch_harmonics", 0) or 0
        notches = [f"equalizer=f={freq:g}:width_type=h:width={NOTCH_WIDTH_HZ:g}:"
                   f"g={NOTCH_DEPTH_DB:g}"]
        for h in range(2, 2 + n_harm):
            notches.append(f"equalizer=f={freq * h:g}:width_type=h:"
                           f"width={NOTCH_WIDTH_HZ:g}:g={NOTCH_DEPTH_DB:g}")
        chain.append(",".join(notches))
    return ",".join(chain)
