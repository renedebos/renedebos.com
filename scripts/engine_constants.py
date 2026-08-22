"""Shared numeric policy constants for the audio-processing engine.

Every DSP-decision threshold used by planning/rendering (applause-limiter
v5, sparse-transient-cap v8) plus the general loudness targets/ceilings that
the CLI and every internal module reference, in one place so
engine_versioning.py, engine_analysis.py, engine_planning.py,
engine_rendering.py, engine_catalog.py, engine_storage.py, and
audio_process.py itself all read the identical numbers the engine has
always used. Split out of audio_process.py 2026-08-22 (Codex modularity
review) -- values and their explanatory comments are unchanged, moved
verbatim. See CLAUDE.md's "Loudness policy" section before changing any
threshold here: a change to a cap threshold or gate is a new
WORKFLOW_VERSIONS[N] entry (engine_versioning.py), never a silent edit.
"""
import os


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUCKET = "r2:hannan-audio"
ARTIST_TARGET = {"jerry": -20, "sean": -20, "seanjerry": -20, "mad": -20}
TP_CEILING = -1.0
TP_TOL = 0.1      # warn if achieved TP exceeds the ceiling by more than this
LUFS_TOL = 0.5    # warn if achieved LUFS drifts from target by more than this

# ── optional corrective filters (--hpf / --lpf / --notch) ─────────────────────
HPF_DEFAULT_HZ = 25.0    # bare --hpf: DC/subsonic rumble only, well clear of the
                         # guitar's 82 Hz low E. 80 Hz (the old always-on default)
                         # is still available via an explicit --hpf 80, a deliberate
                         # per-recording choice, never the flag's own default.
LPF_DEFAULT_HZ = 18000.0
LPF_NYQUIST_MARGIN = 0.9  # if the requested cutoff is at/above a source's Nyquist
                          # frequency (a no-op filter, false confidence), clamp to
                          # this fraction of Nyquist instead of silently doing nothing
NOTCH_DEFAULT_HZ = 60.0  # US mains hum; pass --notch 50 for 50 Hz-mains recordings
NOTCH_WIDTH_HZ = 4.0     # genuinely narrow — width_type=h (literal Hz), not the old
                         # width_type=o:width=2 (two OCTAVES, ~25 dB down at the
                         # guitar's 82 Hz low E — that was never a "notch")
NOTCH_DEPTH_DB = -20.0
MP3_TP_MAX_ATTEMPTS = 3  # v6: lossy encoding can overshoot the FLAC's true peak; retry the
                         # MP3 encode alone (never the FLAC master) with a small extra trim
                         # instead of just flagging it, mirroring the applause true-peak loop

# ── applause-aware headroom recovery (workflow v5) ────────────────────────────
# Calibrated on Butter (jerry-cafe-java-1999-03-25 trk 4), 2026-07-13: music
# windows crest 19-22 dB very consistently; the applause tail measured 31.7 dB
# and peaked 6 dB above ANY music window. Spectral classification was tried and
# discarded — flatness/entropy barely separate applause from music on these
# noisy audience tapes; crest + position do.
APPLAUSE_MIN_SHORTFALL = 2.0  # dB of predicted-TP overshoot below which the v4 reduced target is fine as-is
APPLAUSE_CREST_MIN = 27.0     # window peak-over-RMS (dB) to call it applause; music measures 19-22
APPLAUSE_BODY_EXCESS = 2.0    # edge peak this far above the loudest BODY window is applause even
                              # below the crest bar (final-chord-under-applause windows dilute crest;
                              # the margin protects a finale strum that outrings the body)
APPLAUSE_EDGE_S = 30.0        # applause is only trusted this close to the track's head/tail
APPLAUSE_WIN_S = 5.0          # window size for the peak/RMS scan
APPLAUSE_LIMIT_DB = -1.2      # sample-peak limiter threshold (margin under the -1 dBTP ceiling)
APPLAUSE_MIN_BENEFIT = 1.0    # dB of loudness recovered below which a limiter isn't worth it
APPLAUSE_LRA_TOL = 0.5        # QA gate: output LRA must match source LRA within this
APPLAUSE_TP_MAX_ATTEMPTS = 5  # alimiter limits SAMPLE peaks, not oversampled true peak — inter-
                              # sample reconstruction overs can still exceed the ceiling on hot
                              # transients, so the render is measured and gain backed off until
                              # the ACTUAL output true peak (not just the limiter's threshold)
                              # complies, instead of trusting a fixed margin

# ── sparse-transient cap (workflow v8, strictly opt-in) ───────────────────────
# Rene's 2026-08-08 policy decision, evidenced by loudness-matched blind A/B on
# two independent shows (see WORKFLOW_VERSIONS[8]). Recovers the headroom that
# brief MUSICAL transients (close-mic'd drum hits) eat on some tapes, where the
# applause classifier correctly refuses to act because the peaks ARE music.
# Never on by default: requires --transient-cap on process/plan (and
# publish_show.py --transient-cap), per show, per run.
TCAP_LIMIT_DB = -1.5          # internal limiter ceiling: 0.5 dB margin under TP_CEILING —
                              # downsampling reconstructs inter-sample overshoot (a -1.0
                              # setting measured -0.7 dBTP during the 2026-08-08 prototyping)
TCAP_MIN_BENEFIT = 1.0        # dB of recovery below which linear-reduced is close enough
TCAP_MAX_GR = 6.0             # hard cap on the limiter's ACTUAL instantaneous attenuation
                              # (in_TP + gain - limit), enforced at sizing AND after every
                              # true-peak retry (Rene's 2026-08-08 disambiguation of the
                              # written "gain reduction hard-capped at 6 dB": it means the
                              # shave, not the loudness recovered). A track whose full
                              # -20 target would need more shave gets its gain trimmed to
                              # the cap (landing <= ~0.5 dB shy of nominal — inaudible);
                              # one needing > 6 dB of RECOVERY falls back to
                              # linear-reduced entirely, never forced
TCAP_FRAME_MS = 50            # frame size for the sparsity/engagement scan
TCAP_NEAR_PEAK_DB = 3.0       # "near peak" = within this of the track's own frame-peak max
# ── tiered eligibility (2026-08-08, second revision the same day) ─────────────
# The original single gate (near-peak density <= 1%) was calibrated on the five
# A/B-transparent tracks (0.1-0.3%) vs Truck (12.3%). The Hear Me case showed
# density and actual limiter ENGAGEMENT are different measurements — 1.7%
# near-peak but only 0.7% engagement with 50 ms events — and the listening
# evidence was really sampling engagement (passed tracks: 0.1-0.8% engaged,
# events <= 0.15 s). Rene approved a tiered scheme: an AUTO envelope matching
# the evidence, a REVIEW band where the track is capped but hard-blocked until
# his ears rule (the listen-before-shipping mechanism), and a REJECT band that
# declines to linear-reduced (force still available).
TCAP_MAX_NEAR_PEAK_PCT = 2.0     # auto tier: density above this needs ears
TCAP_REJECT_NEAR_PEAK_PCT = 5.0  # beyond the review band: declined (12+ s of a
                                 # 4-min song near peak is different content)
TCAP_AUTO_ENGAGE_PCT = 1.0       # auto tier: engagement above this needs ears
TCAP_REJECT_ENGAGE_PCT = 2.0     # beyond: repeated-compression territory, declined
TCAP_AUTO_EVENT_S = 0.2          # auto tier: longest continuous event above this
                                 # needs ears
TCAP_REJECT_EVENT_S = 0.5        # beyond: sustained limiting, declined
TCAP_TP_MAX_ATTEMPTS = 5      # same measure-and-correct pattern as the applause loop, but
                              # exhausting it ABORTS the run (removes the output) instead of
                              # warning — this mode's whole job is touching music transients,
                              # so an over-ceiling render must never survive to be shipped

# Shared by the `plan` and `process` parsers — the two must describe this flag
# identically, since a plan run is what decides whether to pass it to process.
TCAP_OVER_APPLAUSE_HELP = (
    "let the transient cap take a track the applause-limiter would otherwise "
    "keep (v5 precedence) when applause-limiting alone cannot reach the target "
    "-- the 42 applause-limited tracks in the archive otherwise land a median "
    "6.7 dB short of a loud target. Makes those tracks ELIGIBLE only; the "
    "normal per-track gates still apply, so a dense track can still decline "
    "and need --transient-cap-force. OPT-IN ONLY: it changes the -20 archive "
    "render too (Truck moves from -23.65 to -20.0), so it belongs to the "
    "loudness-variant campaign, never an ordinary publish")
