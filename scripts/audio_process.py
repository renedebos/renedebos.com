#!/usr/bin/env python3
"""Committed engine for the AUDIO_PROCESSING.md workflow.

Replaces the previously ad-hoc, re-typed-each-run scripts so Phase 1/2 are a
versioned, reproducible tool. The doc remains the how/why; this is the what.

Subcommands
-----------
  diagnose <input-folder> [--artist ID] [--target LUFS]
      Phase 1. Probe every lossless file (loudness, peak, dynamics, DC, stereo,
      predicted true peak at target) and run the second-tier clipping check
      (clipcheck.py) on any file whose peak reaches full scale. MP3 sources are
      reported and skipped (lossless-only rule). Writes diagnostic_report.txt.

  process <input-folder> <output-folder> --target LUFS [--hpf [FREQ]] [--lpf]
          [--notch [FREQ]] [--notch-harmonics N] [--slug SLUG]
      Phase 2. Two-pass loudnorm to target / -1 dBTP, output mirrors the input
      container, plus a derived 320k MP3 and an audio MD5 per track. Re-measures
      the output (Pass 3) and VERIFIES it (flags TP over ceiling or LUFS drift).
      Resumable: skips tracks whose outputs already exist. With --slug, writes
      the provenance sidecar to data/processing/<slug>.json.

  verify <slug> [--drive "gdrive:.../Processed"]
      Re-read each track's published copy (R2, and Drive if given), recompute the
      audio MD5, and confirm it matches the provenance sidecar — closing the
      integrity / drift-detection loop.

Lossless-only, per the workflow: only *.flac / *.wav are processed; the served
MP3 is always derived from the processed lossless master.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys

import clipcheck  # second-tier run-length clipping check (same dir)

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

# ── workflow versioning ───────────────────────────────────────────────────────
# Bump WORKFLOW_VERSION whenever the processing *functionality* changes (a new
# filter option, a limiter, different target logic, …) and add a registry entry
# describing it. Each processed track records its `ver` and the literal `chain`
# applied, so you can later tell exactly which workflow generation — and which
# concrete processes — touched any given track (even a single track of a show
# re-run later with a newer version). The registry is the human-readable decode
# of a version number; the per-track `chain` is the self-contained ground truth;
# the `md5` proves the live audio is that exact output.
WORKFLOW_VERSION = 8
WORKFLOW_VERSIONS = {
    1: {
        "desc": "Two-pass ffmpeg loudnorm to the per-artist target "
                "(all artists -20 LUFS; Mad moved -16 -> -20 after A/B testing showed "
                "-16 forced non-linear processing on band masters with no audible gain), "
                "-1 dBTP ceiling, linear; "
                "optional high-pass 80 Hz / low-pass 18 kHz / 60 Hz hum notch; a 320k "
                "MP3 derived from the processed lossless master. Recommend-only: no "
                "automatic limiter/compressor/denoise.",
        "loudnorm": "I=<target>:LRA=11:TP=-1:linear=true",
        "targets": dict(ARTIST_TARGET),
        "optional_filters": ["highpass=f=80", "lowpass=f=18000", "60Hz notch"],
    },
    2: {
        "desc": "As v1, plus an optional literal corrective-EQ chain via --eq "
                "(prepended before loudnorm) for restoring poor source recordings "
                "(e.g. de-mud + presence + air shelf on a muffled tape). The exact "
                "EQ is recorded in each track's `chain`; only tracks processed with "
                "--eq differ from v1. Still recommend-only (no auto compressor/limiter).",
        "loudnorm": "I=<target>:LRA=11:TP=-1:linear=true",
        "targets": dict(ARTIST_TARGET),
        "optional_filters": ["--eq <literal ffmpeg filter chain>", "highpass=f=80",
                             "lowpass=f=18000", "60Hz notch"],
    },
    3: {
        "desc": "As v2 (audio processing unchanged), plus: embedded metadata tags "
                "(title/artist/album/track/date/comment from recordings.json) written "
                "into both the FLAC master and the MP3, and a true-peak measurement "
                "of the encoded MP3 (lossy encoding overshoots peaks; warn above "
                "0 dBTP, recorded per-track as mp3_tp). `retag` retro-fits tags onto "
                "already-published shows via a container rewrite (-c copy) that "
                "leaves the audio stream — and therefore the provenance MD5 — intact.",
        "loudnorm": "I=<target>:LRA=11:TP=-1:linear=true",
        "targets": dict(ARTIST_TARGET),
        "optional_filters": ["--eq <literal ffmpeg filter chain>", "highpass=f=80",
                             "lowpass=f=18000", "60Hz notch"],
    },
    4: {
        "desc": "As v3, plus: fixed a silent loudnorm fallback. Requesting linear=true "
                "doesn't guarantee linear gain — if reaching the show target would push "
                "true peak past the TP ceiling, ffmpeg quietly switches to dynamic "
                "(frame-adaptive) normalization instead, which rides the gain up on quiet "
                "passages and can flatten hand-drawn fades. A track whose predicted TP "
                "exceeds the ceiling (the diagnose PRED_TP flag) is now processed at its "
                "own safe lower 'max linear target' (I - TP - 1, same number diagnose "
                "already reports) so it stays in true linear mode. Recorded per-track as "
                "`target_lufs` in the provenance sidecar whenever it differs from the "
                "show's nominal target.",
        "loudnorm": "I=<target or per-track max-linear target>:LRA=11:TP=-1:linear=true",
        "targets": dict(ARTIST_TARGET),
        "optional_filters": ["--eq <literal ffmpeg filter chain>", "highpass=f=80",
                             "lowpass=f=18000", "60Hz notch"],
    },
    5: {
        "desc": "As v4, plus applause-aware headroom recovery. On audience tapes the "
                "mic often sat near people: a clap can peak 6+ dB above anything in the "
                "music and alone force the v4 'max linear target' several dB quieter "
                "than the show nominal. When predicted TP overshoots the ceiling by "
                "more than 2 dB, the peaks are located and classified by BEHAVIOR, not "
                "sound: only windows within min(30 s, dur/6) of the track's head/tail "
                "(tracks are split from continuous tape — applause lives at the "
                "boundaries) can be applause, and only when the peak towers >= 27 dB "
                "over the window's own RMS (claps are millisecond spikes; sustained "
                "loud music measures 19-22 dB) or beats the loudest mid-song window "
                "by >= 2 dB (a final chord ringing under the applause dilutes the "
                "crest; nothing 2 dB louder than the whole body of the song lives at "
                "a split boundary except applause). If applause is eating the headroom, the track "
                "gets one constant linear gain sized to the MUSIC peaks (so the "
                "limiter mathematically cannot touch music) plus a lookahead limiter "
                "at -1.2 dB that only applause transients can reach. Music remains "
                "strictly linear-only; ambiguous cases (mid-song high-crest peaks, "
                "music-set ceilings, < 1 dB benefit) fall back to the v4 reduced "
                "target and are flagged for ears. Caught during the first real "
                "reprocess (jerry-cafe-java-1999-03-25, trk 5 'Anna May'): alimiter "
                "thresholds SAMPLE peaks, but the archive's ceiling is a TRUE "
                "(oversampled) peak — inter-sample reconstruction overs on hot "
                "transients exceeded the limiter's own -1.2 dB threshold by 0.4 dB. "
                "Fixed with a measure-and-correct loop in `process`: render, measure "
                "the ACTUAL output true peak, back the gain off and re-render if it "
                "overshot (up to 5 attempts) — never trusts the threshold alone. QA "
                "gates: output LRA must match source LRA within 0.5 LU; limited "
                "regions recorded in provenance. The `plan` command dry-runs the "
                "sizing decision without writing audio or running the true-peak "
                "safety loop, so a hot limiter track's actual output can land a bit "
                "quieter than plan predicted.",
        "loudnorm": "linear modes as v4; applause-limiter mode uses no loudnorm: "
                    "volume=<gain>dB,alimiter=limit=<-1.2 dB>:attack=5:release=100:"
                    "level=false:latency=1",
        "targets": dict(ARTIST_TARGET),
        "optional_filters": ["--eq <literal ffmpeg filter chain>", "highpass=f=80",
                             "lowpass=f=18000", "60Hz notch"],
    },
    6: {
        "desc": "As v5 (sizing/applause-classification logic unchanged), plus: linear and "
                "linear-reduced tracks now render with an explicit `volume=<gain>dB` gain "
                "(computed from the same plan_track() measurement v5 already used) instead "
                "of handing loudnorm a target and trusting its own linear/dynamic decision "
                "at render time. loudnorm/ebur128 remain the measurement tools; they no "
                "longer perform the render. This doesn't change what v5 already computed "
                "correctly by construction — it removes the last remaining reliance on "
                "ffmpeg's internal fallback behavior, so a hidden dynamic-mode render is "
                "no longer possible in principle, not just unlikely in practice. The output "
                "LRA-preservation QA gate (previously applause-limiter tracks only) now "
                "runs on every track, since any silent dynamics change would be visible "
                "there regardless of which mode produced it. Provenance also gains `plr` "
                "(true peak minus integrated loudness) and `max_m`/`max_s` (peak momentary/"
                "short-term loudness) per track — two tracks can share the same integrated "
                "loudness while one has a much hotter chorus the average smooths over; this "
                "is what actually predicts 'sounds louder in a playlist'. The MP3 derivative "
                "gets its own small, independent gain trim (never touching the FLAC master) "
                "if its lossy-encode true-peak overshoot would otherwise clip on decode, "
                "iterated up to 3 times like the existing applause true-peak safety loop.",
        "loudnorm": "measurement only (plan_track's analysis pass); render uses "
                    "volume=<gain>dB:precision=double for linear/linear-reduced, "
                    "unchanged applause-limiter volume+alimiter chain for that mode",
        "targets": dict(ARTIST_TARGET),
        "optional_filters": ["--eq <literal ffmpeg filter chain>", "highpass=f=80",
                             "lowpass=f=18000", "60Hz notch"],
    },
    7: {
        "desc": "As v6, plus: fixed the applause-limiter true-peak safety loop so its "
                "retry actually moves the number it's supposed to fix. On overshoot, "
                "the loop previously only backed off gain_db (the pre-limiter gain) — "
                "but when applause, not music, sets the ceiling, alimiter clamps to a "
                "fixed limit_db regardless of how much pre-gain feeds it, so a track "
                "whose applause was still over the -1 dBTP ceiling after the limiter "
                "measured the IDENTICAL true peak on every retry attempt and could run "
                "out of attempts still over ceiling (caught live on "
                "sean-19-broadway-1999-11-29 trk 21 'Houses of the Holy': 4 attempts, "
                "same -0.78 dBTP every time). Fixed by backing off limit_db and "
                "gain_db together on retry, preserving the invariant that the limiter "
                "never reaches anything classified as music (music_peak + gain <= "
                "limit). Linear/linear-reduced tracks and any applause-limiter track "
                "whose first attempt already met the ceiling are unaffected — this "
                "only changes the outcome of a retry that previously never worked.",
        "loudnorm": "unchanged from v6",
        "targets": dict(ARTIST_TARGET),
        "optional_filters": ["--eq <literal ffmpeg filter chain>", "highpass=f=80",
                             "lowpass=f=18000", "60Hz notch"],
    },
    8: {
        "desc": "As v7, plus an OPT-IN sparse-transient-cap mode (--transient-cap on "
                "process/plan; publish_show.py --transient-cap), per Rene's 2026-08-08 "
                "policy decision. On some tapes the loudest peaks are brief close-mic'd "
                "drum hits — music, so the v5 applause classifier correctly refuses to "
                "act, and under linear-only rules those tracks sit 4-7 dB below the show "
                "target because a few-millisecond transient sets the ceiling for the "
                "entire track. With the flag on, a track that would land linear-reduced "
                "may instead take one constant gain to the FULL nominal target plus a "
                "millisecond-scale true-peak cap on the transients: volume gain, 4x "
                "oversample (aresample=4*source rate), alimiter attack 1 ms / release "
                "50 ms at an internal -1.5 dB ceiling (0.5 dB under the archive's -1 "
                "dBTP ceiling, because downsampling reconstructs inter-sample "
                "overshoot), then back to the source rate. Eligibility is strict and "
                "per-track; every failed gate falls back to the existing linear-reduced "
                "path unchanged: (a) never on by default, and --transient-cap-exclude "
                "gives Rene a per-track veto on top of the per-show flag; (b) recovery "
                "must be >= 1 dB (else not worth a limiter) and <= 6 dB (beyond that "
                "the track stays honestly quiet), and the limiter's ACTUAL "
                "instantaneous attenuation (in_TP + gain - limit) is hard-capped at "
                "6.0 dB — Rene's 2026-08-08 disambiguation of the written policy: a "
                "track whose full target would need more shave gets its gain trimmed "
                "to the cap and lands up to ~0.5 dB shy of nominal (recorded via "
                "target_lufs) rather than over-shaved, and a track needing > 6 dB of "
                "recovery declines to linear-reduced UNLESS Rene explicitly opts that "
                "track into PARTIAL capping (--transient-cap-partial, added at his "
                "request 2026-08-08 with the Rocky Road case in view: full 6 dB "
                "attenuation, lands honestly short of target — never automatic); "
                "(c) a 50 ms frame-peak scan gates eligibility in three TIERS "
                "(2026-08-08 second revision, after the Hear Me case showed near-peak "
                "density and actual limiter engagement are different measurements and "
                "the listening evidence sampled ENGAGEMENT — passed tracks 0.1-0.8% "
                "engaged, events <= 0.15 s): AUTO when density <= 2%, engagement "
                "<= 1% and longest event <= 0.2 s; REVIEW (capped but the "
                "listen-before-shipping hard-block fires) up to 5% density / 2% "
                "engagement / 0.5 s; beyond that DECLINED to linear-reduced — "
                "'Truck', the repeatedly-loud counterexample, stays out of scope "
                "(its oft-quoted 12.3% density was measured on the applause-LIMITED "
                "published copy; the raw source reads 1.6% because the un-limited "
                "applause is the peak reference — the density screen is "
                "reference-dependent, which is exactly why ENGAGEMENT at the real "
                "threshold is the deciding gate; see the codex-notes drum-control "
                "proposal, deliberately NOT built); "
                "(d) applause-limiter takes precedence when applause is what eats the "
                "headroom, since it leaves the music strictly linear. Post-render, the "
                "ACTUAL output true peak is measured against the STRICT -1.00 dBTP "
                "ceiling (no QA tolerance for this mode — the promise is the number); "
                "on overshoot the render retries at a lower limiter threshold, gain "
                "untouched while the attenuation cap allows it (the v7 lesson: move "
                "the number that is stuck) and in lockstep with the gain once the cap "
                "is reached, up to 5 attempts; if still over the ceiling the mode "
                "DELETES the output and aborts the run rather than ship an "
                "over-ceiling render (deliberately stronger than the applause loop's "
                "warn-and-keep: this mode touches music transients, so compliance is "
                "non-negotiable). The accepted render's gain/limit are persisted in a "
                ".v8state.json beside the output; a resume that cannot load it (or "
                "whose file fails the strict ceiling) re-renders instead of guessing "
                "— provenance never describes a chain it cannot prove. A track whose "
                "engagement stats fire a 'listen before shipping' flag HARD-BLOCKS "
                "the run until Rene either accepts it after listening "
                "(--transient-cap-accept N) or vetoes it (--transient-cap-exclude N) "
                "— flagged tracks cannot ship unheard. Provenance records "
                "gain/limit/max-GR plus frame-scan engagement stats (near-peak %, "
                "engaged-time %, event count, longest event, p95 reduction while "
                "engaged, source LRA), surfaced in /archive-data/. Evidence: "
                "loudness-matched blind A/B on two "
                "independent shows — mad-cafe-java-1999-09-09 (Rocky Road, The Kiss / "
                "Da Da Da, incl. a hand-drawn fade) and mad-sweetwater-1999-05-18 "
                "(Blahana, Smoke in Heaven, The Kiss / Da Da Da) — inaudible to Rene "
                "at up to 5.9 dB of recovery; measured LRA moved <= 0.3 LU. Policy: "
                "this does NOT relax the dynamic-normalization ban. Frame-adaptive "
                "gain riding over seconds (loudnorm's dynamic mode) remains prohibited "
                "— it is what flattens hand-drawn fades; a 1 ms/50 ms cap acts three "
                "orders of magnitude below that timescale and measurably preserves "
                "LRA (the per-track LRA gate still applies).",
        "loudnorm": "measurement only (as v6); transient-cap render: "
                    "volume=<gain>dB:precision=double,aresample=<4x source rate>,"
                    "alimiter=limit=<-1.5 dB, lowered on retry>:attack=1:release=50:"
                    "level=false:latency=1,aresample=<source rate>",
        "targets": dict(ARTIST_TARGET),
        "optional_filters": ["--eq <literal ffmpeg filter chain>", "highpass=f=80",
                             "lowpass=f=18000", "60Hz notch"],
    },
}
# NOT bumped to v9 for the 2026-08-12 correctness-fix batch below (notch/hpf/lpf
# option fixes + resume recipe-hash invalidation + shared MP3 QA) — HANDOFF.md's
# separate archive-wide loudness-consistency proposal has already claimed
# "workflow v9" for its own (much larger, unapproved) coordinated
# applause+sparse-transient-cap render, and that same document explicitly
# recommends shipping these exact filter/resume fixes as "their own small
# change" ahead of it. Bumping here would collide with that reserved number.
# Safe not to version: grep of every data/processing/*.json sidecar confirms
# no published track was ever processed with --hpf, --lpf, or --notch (all
# three were only ever exercised via the separate literal --eq chain, e.g.
# mad-sweetwater-2001-01-06) — no existing provenance's `ver`/`chain` meaning
# is disturbed. --notch is no longer two-octave-wide cuts (was ~25.5 dB down
# at the guitar's own 82 Hz low E — a de facto bass cut, not a notch); it's
# now a literal few-Hz-wide cut (width_type=h:width=4) at a configurable
# frequency (--notch [FREQ], default 60 Hz; pass 50 for 50 Hz-mains
# recordings), harmonics opt-in only (--notch-harmonics N, default 0). --hpf's
# bare-flag default drops from 80 Hz (uncomfortably close to that same 82 Hz
# low E) to 25 Hz (DC/subsonic rumble only); 80 Hz is still reachable via an
# explicit --hpf 80. --lpf's 18 kHz cutoff is now checked per track against
# that track's real sample rate and clamped below Nyquist (with a printed
# note) instead of silently no-op'ing on a low-sample-rate source. Resume-skip
# now records a `recipe_sig` (hash of target/filters/transient-cap opt-ins/
# WORKFLOW_VERSION) and `src_md5` per track, and only trusts a resume when
# both match the current run's request and the existing output's own audio
# MD5 matches its recorded provenance — closing a bug where a later run
# requesting a different recipe for an unchanged source could silently skip
# rendering while writing provenance describing the newly-requested (never
# actually rendered) chain. Only enforced when a track's provenance already
# has `recipe_sig` recorded, so this doesn't force a reprocess of existing
# shows. The per-track MP3 encode/trim/verify loop is now a shared
# encode_mp3_with_qa() function (provenance gains an additive `mp3_md5`
# field), also adopted by make_stream_mp3.py for whole-show stream proxies in
# place of a weaker ad hoc encode with none of that QA.


def show_tags(slug):
    """Per-show tag context from recordings.json: (artist name, album string).
    None if the slug isn't in the catalog (tags are then skipped)."""
    try:
        data = json.load(open(os.path.join(ROOT, "data", "recordings.json")))
        show = next(s for s in data["shows"] if s["slug"] == slug)
        artist = next((a["name"] for a in data["artists"] if a["id"] == show["artist"]),
                      show["artist"].title())
        venue = show.get("venue_short") or show.get("venue") or ""
        when = show.get("date_display") or show.get("date") or ""
        album = f"{venue} — {when}" if venue and when else (venue or when or slug)
        year = (show.get("date") or "")[:4]
        return {"artist": artist, "album": album, "year": year}
    except (StopIteration, FileNotFoundError, json.JSONDecodeError):
        return None


def tag_args(ctx, filename, num, total, target, title=None):
    """ffmpeg -metadata args for one track. Works for FLAC (vorbis comments)
    and MP3 (id3v2) alike — ffmpeg maps the generic keys per container.
    `title` overrides the filename-derived title: retag passes the catalog
    title so a `make edit` retitle flows into the files; at process time the
    catalog entry doesn't exist yet, so the filename is the only source."""
    if ctx is None:
        return []
    title = title or re.sub(r"^\d+\s+", "", os.path.splitext(filename)[0])
    pairs = {
        "title": title, "artist": ctx["artist"], "album_artist": ctx["artist"],
        "album": ctx["album"],
        "track": f"{num}/{total}" if num is not None else None,
        "date": ctx["year"] or None,
        "comment": f"The Hannan Tapes (renedebos.com) — loudness-normalized "
                   f"to {int(target)} LUFS",
    }
    out = []
    for k, v in pairs.items():
        if v:
            out += ["-metadata", f"{k}={v}"]
    return out


def ffmpeg_version():
    try:
        out = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True).stdout
        return out.split("\n", 1)[0].replace("ffmpeg version ", "").split()[0]
    except Exception:
        return "unknown"


# ── shared helpers ────────────────────────────────────────────────────────────

def ff_err(args):
    return subprocess.run(["ffmpeg", "-hide_banner"] + args,
                          capture_output=True, text=True).stderr


def lossless_files(folder):
    return sorted(f for f in os.listdir(folder) if f.lower().endswith((".flac", ".wav")))


def mp3_sources(folder):
    return sorted(f for f in os.listdir(folder) if f.lower().endswith(".mp3"))


def lead_num(name):
    m = re.match(r"\s*(\d+)", os.path.basename(name))
    return int(m.group(1)) if m else None


def preflight_track_files(files):
    """Reject a batch before any rendering happens rather than let it corrupt
    output silently: a missing leading track number, or two files sharing one
    (e.g. a stray WAV export left alongside its FLAC), both collide on the
    same out_mp3 filename and the same provenance key (str(num)) — the second
    file processed would silently overwrite the first's audio and provenance
    entry."""
    missing = [f for f in files if lead_num(f) is None]
    if missing:
        raise SystemExit("no leading track number in: " + ", ".join(missing))

    by_num = {}
    for f in files:
        by_num.setdefault(lead_num(f), []).append(f)
    dupe_nums = {n: fs for n, fs in by_num.items() if len(fs) > 1}
    if dupe_nums:
        detail = "; ".join(f"{n}: {', '.join(fs)}" for n, fs in sorted(dupe_nums.items()))
        raise SystemExit(f"duplicate track number(s) — {detail}")


def probe(path):
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams",
         "-show_format", path], capture_output=True, text=True)
    j = json.loads(r.stdout)
    st = j["streams"][0]
    bits = st.get("bits_per_raw_sample")
    if not bits and st.get("sample_fmt") == "s32":
        bits = "24"
    return {
        "sr": st.get("sample_rate"),
        "ch": int(st.get("channels", 0)),
        "bits": bits or st.get("bits_per_sample"),
        "sample_fmt": st.get("sample_fmt"),
        "dur": float(j["format"]["duration"]),
    }


def measure(path, target, pre=""):
    # `pre` is an optional filter chain (e.g. corrective EQ) applied BEFORE the
    # loudnorm analysis. When processing prepends an EQ, loudnorm must be measured
    # on the post-EQ signal, or the gain calc is wrong and the output drifts off
    # target (the EQ changes the loudness it's normalizing).
    af = ((pre + ",") if pre else "") + \
        f"loudnorm=I={target}:LRA=11:TP={TP_CEILING}:print_format=json"
    err = ff_err(["-i", path, "-af", af, "-f", "null", "-"])
    return json.loads(re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", err, re.S).group(0))


def max_short_term_momentary(path):
    """Peak of the 3s short-term (S) and 400ms momentary (M) loudness curves,
    via one ebur128 analysis pass. Two full-track tracks can share the same
    integrated loudness (and pass the same QA gates) while one has a much
    hotter chorus or a long loud passage the integrated average smooths
    over — this is what actually predicts 'sounds louder in a playlist',
    which integrated loudness alone can miss (v6)."""
    err = ff_err(["-i", path, "-af", "ebur128", "-f", "null", "-"])
    ms = [float(x) for x in re.findall(r"\bM:\s*(-?[\d.]+)", err)]
    ss = [float(x) for x in re.findall(r"\bS:\s*(-?[\d.]+)", err)]
    return (round(max(ms), 1) if ms else None, round(max(ss), 1) if ss else None)


def astats_field(path, field):
    err = ff_err(["-i", path, "-af", "astats=measure_perchannel=0", "-f", "null", "-"])
    m = re.search(rf"{re.escape(field)}:\s*([-\d.]+|inf|-inf)", err)
    return m.group(1) if m else None


def astats_channels(path):
    """One astats pass: per-channel RMS (dB) plus overall peak and DC offset."""
    err = ff_err(["-i", path, "-af", "astats", "-f", "null", "-"])
    section, rms, peak, dc = None, [], None, None
    for line in err.splitlines():
        if re.search(r"Channel:\s*\d+", line):
            section = "ch"
        elif "Overall" in line:
            section = "all"
        m = re.search(r"RMS level dB:\s*([-\d.]+|-inf|inf)", line)
        if m and section == "ch":
            rms.append(float(m.group(1)) if "inf" not in m.group(1) else None)
        if section == "all":
            m = re.search(r"Peak level dB:\s*([-\d.]+|inf|-inf)", line)
            if m:
                peak = m.group(1)
            m = re.search(r"DC offset:\s*([-\d.]+)", line)
            if m:
                dc = m.group(1)
    return rms, peak, dc


def fmt_ts(sec):
    m, s = divmod(sec, 60)
    return f"{int(m)}:{s:06.3f}"


def defect_scan(path, sr, ch, min_ms=2.0, edge_s=2.0):
    """DAT-defect detector, one decode pass. Returns (dropouts, clicks):

    dropouts — [(time_s, run_ms)]: runs of IDENTICAL sample values (any level,
    including digital zero) of >= min_ms, ignoring edge_s at each end where
    fades legitimately sit at zero. Error concealment on a failing DAT holds
    or mutes samples — a different defect from clipping, which only lives at
    full scale. Skip-sampled for speed; runs are confirmed exactly.

    clicks — [(time_s, step, ratio)]: single-sample spikes and waveform
    discontinuities (corrupted samples / skipped samples). Candidates come
    from a per-window ffmpeg astats Max_difference pass (C speed); each is
    then confirmed in Python against its local context — a step is a defect
    when it dwarfs the surrounding RMS, which separates digital clicks from
    legitimate transients like claps (loud surroundings -> low ratio)."""
    a = clipcheck.decode_f32(path)
    n = len(a) // ch

    dropouts = []
    N = max(32, int(sr * min_ms / 1000))
    M = max(16, N // 3)
    for c in range(ch):
        s = a[c::ch]
        lo, hi = int(edge_s * sr), n - int(edge_s * sr)
        p = lo
        while p < hi - M:
            if s[p] == s[p + M]:
                v, j, k = s[p], p, p + M
                while j > lo and s[j - 1] == v:
                    j -= 1
                while k < hi - 1 and s[k + 1] == v:
                    k += 1
                run = k - j + 1
                if run >= N and s[j:k + 1].count(v) == run:
                    dropouts.append((j / sr, round(run * 1000 / sr, 1)))
                p = k + M
            else:
                p += M
    dropouts.sort()

    # click/discontinuity candidates: windowed max sample-to-sample difference
    win = 512
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path,
         "-af", f"asetnsamples=n={win},astats=metadata=1:reset=1,"
                "ametadata=mode=print:key=lavfi.astats.Overall.Max_difference:file=-",
         "-f", "null", "-"], capture_output=True, text=True)
    cands, t = [], None
    for line in r.stdout.splitlines():
        m = re.search(r"pts_time:([\d.]+)", line)
        if m:
            t = float(m.group(1))
        m = re.search(r"Max_difference=([\d.eE+-]+)", line)
        if m and t is not None and float(m.group(1)) > 0.18:
            cands.append(t)

    # Confirmation thresholds, calibrated on 34 real audience tracks
    # (2026-07-10): raw step size is useless there — loud strums/claps hit
    # sample steps of 0.6-1.1 routinely, and a lone clap in a quiet moment
    # reached 18.9x its surroundings. So: a SPIKE only counts when it dwarfs
    # its context by >= 25x (context excludes the defect itself), and a
    # SPLICE (skipped samples / hold offset) is detected by the DC mean-shift
    # between the audio before and after the step — claps are pure AC and
    # can't shift the mean. Clicks buried in loud music stay undetectable
    # statistically (and are masked anyway).
    clicks = []
    chans = [a[c::ch] for c in range(ch)]
    # splice mean-shift windows must exceed a bass period (30 ms covers 33 Hz
    # and up) or low-frequency phase reads as a DC jump — 17 false splices on
    # the calibration tracks came from 5 ms windows straddling bass notes
    ctx, guard, half = int(0.05 * sr), int(0.002 * sr), int(0.030 * sr)
    for t in cands:
        w0, w1 = int(t * sr), min(n - 1, int(t * sr) + win + 1)
        for s in chans:
            best, bi = 0.0, None
            for i in range(max(1, w0), w1):
                d = abs(s[i] - s[i - 1])
                if d > best:
                    best, bi = d, i
            if bi is None or best < 0.18:
                continue
            seg = (list(s[max(0, bi - ctx):max(0, bi - guard)])
                   + list(s[bi + guard:min(n, bi + ctx)]))
            rms = (sum(x * x for x in seg) / max(len(seg), 1)) ** 0.5
            ratio = best / max(rms, 1e-9)
            pre = s[max(0, bi - half):bi]
            post = s[bi:min(n, bi + half)]
            shift = abs(sum(post) / max(len(post), 1) - sum(pre) / max(len(pre), 1))
            if ratio >= 25:
                clicks.append((bi / sr, round(best, 2), round(ratio, 1), "spike"))
            elif shift > 0.08:
                clicks.append((bi / sr, round(best, 2), round(shift, 2), "splice"))
    # de-dup events within 5 ms of each other (stereo pairs, window overlaps)
    clicks.sort()
    deduped = []
    for e in clicks:
        if not deduped or e[0] - deduped[-1][0] > 0.005:
            deduped.append(e)
    return dropouts, deduped


def mean_vol(path, af):
    err = ff_err(["-i", path, "-af", af + ",volumedetect", "-f", "null", "-"])
    m = re.search(r"mean_volume:\s*([-\d.]+) dB", err)
    return float(m.group(1)) if m else None


def fmt_dur(s):
    return f"{int(s) // 60}:{int(round(s)) % 60:02d}"


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


def target_for(artist, override):
    if override is not None:
        return override
    if artist in ARTIST_TARGET:
        return ARTIST_TARGET[artist]
    raise SystemExit("Pass --target (no/unknown --artist; expected jerry/sean/seanjerry/mad)")


# ── diagnose (Phase 1) ────────────────────────────────────────────────────────

def cmd_diagnose(args):
    folder = args.input
    target = target_for(args.artist, args.target)
    files = lossless_files(folder)
    if not files:
        raise SystemExit(f"no .flac/.wav files in {folder}")

    skipped = mp3_sources(folder)
    if skipped:
        print(f"Skipping {len(skipped)} MP3 source(s) (lossless-only rule): "
              + ", ".join(skipped[:4]) + (" ..." if len(skipped) > 4 else ""))

    rows, flags = [], []
    for f in files:
        p = os.path.join(folder, f)
        info = probe(p)
        sr, nch = int(info["sr"]), 2
        j = measure(p, target)
        I, LRA, TP = float(j["input_i"]), float(j["input_lra"]), float(j["input_tp"])
        ch_rms, peak_db, dc = astats_channels(p)
        nch = len(ch_rms) or 2
        pred = TP + (target - I)
        maxlin = I - TP - 1
        # clipping: astats screen, then run-length verdict only if peak at ceiling
        clip = "NONE"
        if peak_db is not None and peak_db not in ("inf", "-inf") and float(peak_db) >= -0.1:
            ch, srp = clipcheck.probe(p)
            a = clipcheck.decode_f32(p)
            worst_run = events = 0
            for c in range(ch):
                _, run, ev = clipcheck.analyse_channel(a[c::ch])
                worst_run = max(worst_run, run)
                events += ev
            clip, _ = clipcheck.classify(worst_run, srp, events)
        dc_bad = dc is not None and abs(float(dc)) > 0.01

        # DAT defect scan: dropouts (identical-sample runs) + clicks/steps
        dropouts, clicks = defect_scan(p, sr, nch)
        drops, drop_ms = len(dropouts), max((ms for _, ms in dropouts), default=0)
        # effective bandwidth vs container rate (catches mislabelled sample
        # rates and lossy-sourced files): high-band mean vs full-band mean
        cut = int(0.43 * sr)
        # 6 chained poles ≈ 36 dB/oct: steep enough that LF energy can't leak
        # through and mask a genuine null above the cutoff (a 2-pole highpass
        # measured a true 32k→48k upsample at only -37 dB; 6-pole: -63 dB)
        hp6 = ",".join([f"highpass=f={cut}"] * 6)
        full_v, hp_v = mean_vol(p, "anull"), mean_vol(p, hp6)
        # hp_v None with a measurable full band = literally nothing above the
        # cutoff (volumedetect can't say "-inf") — maximally deficient
        bw_delta = ((hp_v - full_v) if hp_v is not None else -99.0) \
            if full_v is not None else None
        bw_bad = bw_delta is not None and bw_delta < -55
        # channel health: L/R balance and mid/side relationship (phase)
        bal = (abs(ch_rms[0] - ch_rms[1])
               if nch == 2 and None not in ch_rms[:2] else None)
        sm = None
        if nch == 2:
            mid_v = mean_vol(p, "pan=mono|c0=0.5*c0+0.5*c1")
            side_v = mean_vol(p, "pan=mono|c0=0.5*c0-0.5*c1")
            if mid_v is not None and side_v is not None:
                sm = side_v - mid_v

        rows.append((f, info, I, LRA, TP, pred, maxlin, clip, dc_bad,
                     drops, drop_ms, bw_delta, bal, sm))
        if clip == "CLIPPING":
            flags.append(f"CLIPPING: {f} — likely audible; review/declip in Audacity.")
        if pred > -1:
            flags.append(f"PRED_TP: {f} — predicted {pred:+.1f} dBTP > -1 at {target}; "
                         f"max linear target {maxlin:+.1f} LUFS.")
        if LRA > 15:
            flags.append(f"HIGH_LRA: {f} — LRA {LRA:.1f} (very dynamic).")
        if dc_bad:
            flags.append(f"DC: {f} — DC offset {dc}.")
        if drops:
            where = ", ".join(f"{fmt_ts(t)} ({ms} ms)" for t, ms in dropouts[:5])
            more = f" +{drops - 5} more" if drops > 5 else ""
            flags.append(f"DROPOUT: {f} — {drops} identical-sample run(s) mid-track "
                         f"at {where}{more} (DAT error concealment?). Listen there.")
        if clicks:
            where = ", ".join(f"{fmt_ts(t)} ({kind}, step {st}, {m})"
                              for t, st, m, kind in clicks[:5])
            more = f" +{len(clicks) - 5} more" if len(clicks) > 5 else ""
            flags.append(f"CLICK: {f} — {len(clicks)} suspected digital defect(s) "
                         f"at {where}{more}. Listen there.")
        if bw_bad:
            flags.append(f"BANDWIDTH: {f} — energy above {cut/1000:.1f} kHz is "
                         f"{bw_delta:.0f} dB below full-band: content doesn't fill the "
                         f"{sr//1000} kHz container (mislabelled rate or lossy source?).")
        if bal is not None and bal > 4:
            flags.append(f"BALANCE: {f} — L/R RMS differs by {bal:.1f} dB.")
        if sm is not None and sm > 3:
            flags.append(f"PHASE: {f} — side energy {sm:+.1f} dB above mid: channels "
                         "largely out of phase (inverted channel?).")
        print(f"  {f}: in {I:.1f} LUFS, LRA {LRA:.1f}, TP {TP:.1f}, pred@{target} "
              f"{pred:+.1f}, clip {clip}, drops {drops}, clicks {len(clicks)}", flush=True)

        if getattr(args, "spectrograms", False):
            sdir = os.path.join(folder, "spectrograms")
            os.makedirs(sdir, exist_ok=True)
            png = os.path.join(sdir, os.path.splitext(f)[0] + ".png")
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                            "-i", p, "-lavfi",
                            "showspectrumpic=s=2048x512:legend=1:gain=5",
                            png], capture_output=True)

    out = os.path.join(folder, "diagnostic_report.txt")
    L = ["DIAGNOSTIC REPORT",
         f"Generated: {datetime.datetime.now().isoformat(timespec='seconds')}",
         f"Files analyzed: {len(rows)}",
         f"Loudness target: {target} LUFS / {TP_CEILING} dBTP",
         "=" * 43, "",
         f"{'File':40s}|{'LUFS':7s}|{'LRA':5s}|{'TruePk':8s}|{'Pred':7s}|{'Clip':9s}|"
         f"{'DC':6s}|{'Drop':5s}|{'HiBand':7s}|{'Bal':5s}|S-M",
         "-" * 118]
    for f, info, I, LRA, TP, pred, maxlin, clip, dc_bad, drops, drop_ms, bw, bal, sm in rows:
        L.append(f"{f[:40]:40s}|{I:7.1f}|{LRA:5.1f}|{TP:7.1f}T|{pred:+6.1f}|{clip:9s}|"
                 + ("OFFSET" if dc_bad else "OK    ").ljust(6)
                 + f"|{drops:5d}|"
                 + (f"{bw:+6.1f} " if bw is not None else "   --  ") + "|"
                 + (f"{bal:4.1f} " if bal is not None else "  -- ") + "|"
                 + (f"{sm:+.1f}" if sm is not None else "--"))
    L += ["", "FLAGS", "-----"]
    L += ["⚠ " + x for x in flags] if flags else ["(none)"]
    open(out, "w").write("\n".join(L) + "\n")
    print(f"\n[report -> {out}]  target {target} LUFS, {len(flags)} flag(s)")


# ── process (Phase 2) ─────────────────────────────────────────────────────────

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


# ── normalization planning (workflow v5) ─────────────────────────────────────

def window_stats(path, pre="", win_s=APPLAUSE_WIN_S):
    """Per-window sample peak and RMS (dB), one decode pass. The raw material
    for telling applause from loud music: a clap is a millisecond spike
    towering over its window's RMS; genuinely loud music is sustained, so its
    peaks sit close to the local average."""
    sr = int(probe(path)["sr"])
    af = ((pre + ",") if pre else "") + (
        f"asetnsamples=n={int(win_s * sr)},"
        "astats=metadata=1:reset=1:measure_perchannel=none,"
        "ametadata=mode=print:file=-")
    r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error",
                        "-i", path, "-af", af, "-f", "null", "-"],
                       capture_output=True, text=True)
    wins, t, peak, rms = [], None, None, None
    for line in r.stdout.splitlines():
        m = re.search(r"pts_time:([\d.]+)", line)
        if m:
            if t is not None and peak is not None and rms is not None:
                wins.append((t, peak, rms))
            t, peak, rms = float(m.group(1)), None, None
            continue
        m = re.search(r"Overall\.Peak_level=(-?[\d.]+)", line)
        if m:
            peak = float(m.group(1))
        m = re.search(r"Overall\.RMS_level=(-?[\d.]+)", line)
        if m:
            rms = float(m.group(1))
    if t is not None and peak is not None and rms is not None:
        wins.append((t, peak, rms))
    return wins


def plan_track(path, target, pre="", transient_cap=False, tcap_partial=False,
               tcap_force=False, tcap_max_gr=None, tcap_over_applause=False):
    """Decide how one track gets normalized (workflow v5; v8 adds the opt-in
    transient_cap flag). Returns a dict: mode ('linear' | 'linear-reduced' |
    'applause-limiter' | 'transient-cap'), target (projected output LUFS),
    gain_db/limit_db/regions for limiter mode, the loudnorm measurement
    (reusable by process), in_lra, and human-review flags.

    With transient_cap=True (never the default), a track that would fall back
    to linear-reduced because MUSIC transients set the ceiling may instead be
    upgraded by try_transient_cap() — full-target gain plus a millisecond
    true-peak cap — when it passes the sparsity/size gates. applause-limiter
    still wins when it applies: it leaves the music strictly linear.

    Conservative by construction: only EDGE windows (within min(30 s, dur/6)
    of the head/tail — applause lives at split boundaries) can be applause,
    and only when the pure crest signature fires (peak >= 27 dB over the
    window RMS) or the window's peak beats the loudest BODY window by >= 2 dB
    (mixed final-chord+applause windows dilute crest). High-crest windows
    mid-song count as music — they cap the gain rather than get limited — and
    are flagged for ears. The gain is sized to the music peaks
    (gain <= limit - music_peak), so the limiter cannot engage on any window
    classified as music."""
    j = measure(path, target, pre=pre)
    in_I, in_TP, in_LRA = float(j["input_i"]), float(j["input_tp"]), float(j["input_lra"])
    pred = in_TP + (target - in_I)
    maxlin = round(in_I - in_TP + TP_CEILING, 2)
    plan = {"measure": j, "in_lra": in_LRA, "flags": [],
            "pred": round(pred, 2), "maxlin": maxlin}
    if pred <= TP_CEILING:
        plan.update(mode="linear", target=target,
                    note=f"one constant gain to the show target; predicted TP "
                         f"{pred:+.1f} dBTP fits under the {TP_CEILING:g} ceiling")
        return plan
    if pred - TP_CEILING <= APPLAUSE_MIN_SHORTFALL:
        # applause-limiter never engages on overshoots this small (not worth a
        # limiter), so the cap doesn't need to defer to it here
        if transient_cap and try_transient_cap(plan, path, target, pre, in_I, in_TP, partial=tcap_partial, force=tcap_force, max_gr=tcap_max_gr):
            return plan
        plan.update(mode="linear-reduced", target=maxlin,
                    note=f"gain to {target:g} LUFS would overshoot the TP ceiling by "
                         f"{pred - TP_CEILING:.1f} dB — small enough to simply take the "
                         f"track's own max linear target; dynamics untouched")
        return plan

    wins = window_stats(path, pre=pre)
    if not wins:
        plan.update(mode="linear-reduced", target=maxlin,
                    note="window scan produced no data — fell back to the max linear target")
        plan["flags"].append("window scan produced no data — fell back to reduced target")
        return plan
    dur = wins[-1][0] + APPLAUSE_WIN_S
    # short songs: don't let the edge zones swallow the body of the piece
    edge_s = min(APPLAUSE_EDGE_S, dur / 6)
    body_peak = max((p for t0, p, _ in wins
                     if t0 >= edge_s and (t0 + APPLAUSE_WIN_S) <= dur - edge_s),
                    default=None)
    applause, music, mid_suspects = [], [], []
    for t0, peak, rms in wins:
        edge = t0 < edge_s or (t0 + APPLAUSE_WIN_S) > dur - edge_s
        # Two ways an EDGE window is applause: the pure signature (a spike
        # towering over near-silence), or a peak that beats everything in the
        # song's body by APPLAUSE_BODY_EXCESS — the final chord ringing under
        # the applause raises the window RMS and hides the crest, but a split
        # live tape whose loudest transient sits in the first/last seconds and
        # ISN'T applause is not a credible claim.
        is_applause = edge and (
            peak - rms >= APPLAUSE_CREST_MIN
            or (body_peak is not None and peak >= body_peak + APPLAUSE_BODY_EXCESS))
        if is_applause:
            applause.append((t0, peak))
        else:
            music.append((t0, peak))
            if not edge and peak - rms >= APPLAUSE_CREST_MIN:
                mid_suspects.append(t0)
    if mid_suspects:
        plan["flags"].append(
            "mid-song high-crest window(s) at "
            + ", ".join(fmt_ts(t) for t in mid_suspects[:4])
            + (f" +{len(mid_suspects) - 4} more" if len(mid_suspects) > 4 else "")
            + " — treated as music (caps the gain), listen to confirm")
    if not applause or not music:
        # the music itself sets the ceiling — exactly the case the opt-in
        # transient cap exists for (applause-limiter has nothing to act on)
        if transient_cap and try_transient_cap(plan, path, target, pre, in_I, in_TP, partial=tcap_partial, force=tcap_force, max_gr=tcap_max_gr):
            return plan
        plan.update(mode="linear-reduced", target=maxlin,
                    note=f"gain to {target:g} LUFS would overshoot the TP ceiling by "
                         f"{pred - TP_CEILING:.1f} dB, and no applause was found at the "
                         f"head/tail — the music itself sets the ceiling, so the track "
                         f"takes its honest quieter max linear target")
        if not applause:
            plan["flags"].append("no applause found at head/tail — the music itself "
                                 "sets the ceiling; honest quieter target")
        return plan
    music_peak = max(p for _, p in music)
    gain = round(min(target - in_I, APPLAUSE_LIMIT_DB - music_peak), 2)
    benefit = gain - (TP_CEILING - in_TP)  # dB recovered vs the v4 reduced target
    if benefit < APPLAUSE_MIN_BENEFIT:
        if transient_cap and try_transient_cap(plan, path, target, pre, in_I, in_TP, partial=tcap_partial, force=tcap_force, max_gr=tcap_max_gr):
            return plan
        plan.update(mode="linear-reduced", target=maxlin,
                    note=f"gain to {target:g} LUFS would overshoot the TP ceiling by "
                         f"{pred - TP_CEILING:.1f} dB; the loudest peaks are in (or "
                         f"within 2 dB of) the music itself, so limiting would only "
                         f"recover {max(benefit, 0):.1f} dB — the track takes its "
                         f"honest quieter max linear target instead")
        plan["flags"].append(f"applause limiting would only recover "
                             f"{max(benefit, 0):.1f} dB — not worth a limiter")
        return plan
    # Applause-limiter sizes its gain so the MUSIC peaks land at the ceiling,
    # which is why it can leave a track well short of a loud target: once the
    # clap is tamed, the music's own peaks are the wall. Where the cap is
    # opted into and the applause plan would still land >= 1 dB short, offer
    # the track to the cap first — it can go further by shaving the music's
    # transients too, exactly as it does on every non-applause track.
    #
    # Before 2026-08-16 this branch committed unconditionally and the cap was
    # never consulted, which stranded the archive's 42 applause-limited
    # tracks a median 6.7 dB below the rest of a loud render.
    #
    # STRICTLY OPT-IN (--transient-cap-over-applause), and that is not
    # cosmetic. Left automatic it silently rewrites the ARCHIVE too: measured
    # on mad-cafe-java-1999-09-09 at the normal −20 target, Truck moved from
    # applause-limiter @ −23.65 to sparse-transient-cap @ −20.0, and Anna May
    # from −22.26 to −20.3. Louder and arguably more consistent — but that is
    # a change to published audio, on the one track CLAUDE.md names as
    # never-cap material, with no listening test behind it. The loudness
    # variant campaign passes this flag; ordinary publishes never do, so the
    # archive keeps rendering exactly as it does today.
    #
    # Precedence is otherwise unchanged: when applause-limiting already
    # reaches the target it still wins, because leaving the music strictly
    # linear is the less invasive treatment.
    #
    # The sparsity screen is handed `music_peak` as its reference (see
    # try_transient_cap's docstring) — measuring against the clap would let
    # exactly the repeatedly-loud material the policy protects slip through.
    applause_target = round(in_I + gain, 2)
    if (transient_cap and tcap_over_applause
            and target - applause_target >= TCAP_MIN_BENEFIT):
        if try_transient_cap(plan, path, target, pre, in_I, in_TP,
                             partial=tcap_partial, force=tcap_force,
                             max_gr=tcap_max_gr, density_ref=music_peak,
                             fallback_desc="the applause-limiter's own target"):
            return plan
    plan.update(mode="applause-limiter", gain_db=gain, limit_db=APPLAUSE_LIMIT_DB,
                music_peak_db=music_peak, applause_windows=applause, dur=dur)
    limiter_finalize(plan)
    # Transparency (2026-08-08, codex-notes suggestion): when the cap was
    # requested but applause-limiter took precedence AND the track still lands
    # >= 1 dB short of nominal, measure the near-peak density fresh from THIS
    # source and report it as context — it answers "why not cap the rest?"
    # without anyone having to know the precedence rule. Informational only;
    # never changes the treatment.
    if transient_cap and target - plan["target"] >= TCAP_MIN_BENEFIT:
        fpeaks = [p for _, p, _ in window_stats(path, pre=pre,
                                                win_s=TCAP_FRAME_MS / 1000)]
        if fpeaks:
            top = max(fpeaks)
            near_pct = 100.0 * sum(1 for p in fpeaks
                                   if p >= top - TCAP_NEAR_PEAK_DB) / len(fpeaks)
            plan["near_peak_pct"] = round(near_pct, 2)
            why = ("the cap was offered this track first "
                   "(--transient-cap-over-applause) and declined — see the "
                   "decline flag above"
                   if tcap_over_applause else
                   "applause-limiter takes precedence; the music stays "
                   "strictly linear")
            # Only warn about the clap-as-yardstick distortion when applause
            # actually tops the file. On a track whose own music sets the peak
            # (Truck: music peak -0.0 dB, no applause regions) the screen is
            # already measuring against the music and the caveat would be
            # actively misleading — which is exactly how the "1.6% vs 12.3%"
            # figure got misattributed to this effect. See §4a-result of
            # plans/loudness-variants/loudness-variants-plan.md.
            caveat = ""
            if top - music_peak >= 1.0:
                caveat = (f" Caveat: applause tops this file by "
                          f"{top - music_peak:.1f} dB, so the screen is "
                          f"referenced to a clap and UNDERSTATES the music's "
                          f"own density; any stacked-cap question must be "
                          f"decided by engagement stats at a real threshold, "
                          f"not this number.")
            plan["flags"].append(
                f"context: {near_pct:.1f}% of 50 ms frames within 3 dB of this "
                f"source's overall peak (informational — {why}).{caveat}")
    return plan


def limiter_regions(applause, gain, limit_db, dur):
    return [(round(t0, 1), round(min(t0 + APPLAUSE_WIN_S, dur), 1),
             round(p + gain - limit_db, 1))
            for t0, p in applause if p + gain > limit_db]


def limiter_finalize(plan):
    """(Re)derive target/regions/note from plan's current gain_db/limit_db.
    Called after the initial sizing and again by cmd_process's true-peak
    safety loop whenever gain_db is backed off, so the provenance note always
    describes what was actually rendered, not the first guess."""
    regions = limiter_regions(plan["applause_windows"], plan["gain_db"],
                              plan["limit_db"], plan["dur"])
    max_red = max((r for _, _, r in regions), default=0.0)
    reg_txt = ", ".join(f"{fmt_dur(a)}–{fmt_dur(b)}" for a, b, _ in regions)
    plan["target"] = round(float(plan["measure"]["input_i"]) + plan["gain_db"], 2)
    plan["regions"], plan["max_reduction_db"] = regions, max_red
    plan["note"] = (f"applause (not music) set the ceiling: one constant "
                    f"{plan['gain_db']:+.1f} dB gain sized to the music peaks "
                    f"({plan['music_peak_db']:.1f} dB), with only the applause "
                    f"transients at {reg_txt} limited (up to {max_red:.1f} dB); "
                    f"the music is untouched linear")
    if max_red > 10:
        note = "limiter would cut applause peaks by " \
               f"{max_red:.1f} dB — heavy; listen to the applause"
        if note not in plan["flags"]:
            plan["flags"].append(note)


def limiter_chain(plan, pre=""):
    """The literal ffmpeg filter chain for an applause-limiter track. Also the
    provenance `chain` ground truth. No loudnorm: loudnorm's linear mode would
    refuse this gain (its TP measurement includes the applause) — the plain
    volume gain IS the linear normalization, sized to the music peaks."""
    amp = 10 ** (plan["limit_db"] / 20)
    return ((pre + ",") if pre else "") + (
        f"volume={plan['gain_db']}dB,alimiter=limit={amp:.6f}:"
        f"attack=5:release=100:level=false:latency=1")


# ── sparse-transient cap (workflow v8, opt-in) ───────────────────────────────

def try_transient_cap(plan, path, target, pre, in_I, in_TP, partial=False,
                      force=False, max_gr=None, density_ref=None,
                      fallback_desc="its reduced linear target"):
    """Attempt to upgrade a would-be linear-reduced track to the opt-in
    transient-cap mode (workflow v8). Mutates and returns `plan` on success;
    returns None (leaving only flags behind) when any eligibility gate fails,
    in which case the caller proceeds to its own fallback exactly as if the
    flag were off. Called only when --transient-cap was passed, and normally
    only after the applause classifier has declined (applause-limiter is less
    invasive — music strictly linear — so it keeps precedence). The one
    exception is --transient-cap-over-applause, which offers an
    applause-limited track to the cap first when the applause plan alone
    would still land short; there the fallback is applause-limiter, not
    linear-reduced, which is what `fallback_desc` names in the decline flags.

    `max_gr`, when given, is an explicit per-track EXCEPTION to the standard
    TCAP_MAX_GR policy ceiling (--transient-cap-max-gr) — e.g. after a
    loudness-matched listening test showed a deeper cut is inaudible on one
    specific track. Never a way to change the ceiling for the show or the
    archive; recorded in provenance (policy_max_gr_db / override) precisely
    so an exception is always distinguishable from standard-policy output.

    `density_ref`, when given, is the dB level the sparsity screen measures
    against instead of the track's own overall peak. It exists for one case:
    a track where APPLAUSE tops the file. There `max(peaks)` is a clap, so
    almost no musical frame sits within TCAP_NEAR_PEAK_DB of it and near_pct
    reads far too low. Measured case: Anna May on mad-cafe-java-1999-09-09,
    whose music peaks at about −11 dB while the applause runs some 11 dB
    above it — the whole screen would otherwise be referenced to a clap.
    (Truck, the track this correction was first written for, turns out NOT to
    be such a case: its music peak is −0.0 dB and the file has no applause
    regions at all, so `density_ref` is a no-op there and the once-quoted
    "1.6% vs 12.3%" figure did not come from this effect. See §4a-result of
    plans/loudness-variants/loudness-variants-plan.md.)
    Passing the music's own peak restores
    the number the screen was designed to produce. This makes the gate
    STRICTER on these tracks, never looser; it is a correction, not a
    bypass. The engagement gate below needs no such fix — it counts frames
    that exceed the limit after gain, which is already applause-independent,
    and is the "engagement stats at a real threshold" the written policy asks
    this question to be decided on."""
    effective_max_gr = TCAP_MAX_GR if max_gr is None else max_gr
    plan["max_gr"] = effective_max_gr
    overshoot = plan["pred"] - TP_CEILING  # dB of boost linear-only must forgo
    if overshoot < TCAP_MIN_BENEFIT:
        return None  # lands within 1 dB of target anyway — not worth a limiter
    if overshoot > effective_max_gr and not partial:
        plan["flags"].append(
            f"transient-cap declined: reaching {target:g} LUFS needs "
            f"{overshoot:.1f} dB of capping, over the {effective_max_gr:g} dB hard "
            f"cap — the track stays honestly quiet at {fallback_desc} "
            f"(per-track partial capping is available as Rene's "
            f"explicit opt-in: --transient-cap-partial)")
        return None
    wins = window_stats(path, pre=pre, win_s=TCAP_FRAME_MS / 1000)
    peaks = [p for _, p, _ in wins]
    times = [t for t, _, _ in wins]
    if not peaks:
        plan["flags"].append("transient-cap declined: frame scan produced no data")
        return None
    top = max(peaks) if density_ref is None else density_ref
    peak_desc = ("its own peak" if density_ref is None
                 else "the music's own peak (applause excluded)")
    near_pct = 100.0 * sum(1 for p in peaks if p >= top - TCAP_NEAR_PEAK_DB) / len(peaks)
    if near_pct > TCAP_REJECT_NEAR_PEAK_PCT and not force:
        plan["flags"].append(
            f"transient-cap declined: {near_pct:.1f}% of the track sits within "
            f"{TCAP_NEAR_PEAK_DB:g} dB of {peak_desc} (> "
            f"{TCAP_REJECT_NEAR_PEAK_PCT:g}% — repeatedly loud, not a sparse "
            f"transient; Truck-territory content) — {fallback_desc} instead "
            f"(Rene can override per track after listening: --transient-cap-force)")
        return None
    # Size the gain against the ATTENUATION cap, not just the target: the
    # shave at the loudest instant is in_TP + gain - limit, and the written
    # policy caps that at 6.0 dB. A track whose full-target gain would shave
    # more gets the excess trimmed off its gain instead — it lands a hair shy
    # of nominal (recorded via target_lufs) rather than over-shaved.
    gain = round(target - in_I, 2)
    excess = round(in_TP + gain - TCAP_LIMIT_DB - effective_max_gr, 2)
    if excess > 0:
        gain = round(gain - excess, 2)
    # Reject band on PREDICTED ENGAGEMENT — the measurement the listening
    # evidence actually sampled (passed tracks: 0.1-0.8% engaged, events
    # <= 0.15 s). Beyond the review band the limiter would behave like
    # repeated compression, which no evidence covers.
    reds, events, longest_s, longest_t = _tcap_engagement(peaks, gain, TCAP_LIMIT_DB, times)
    engaged_pct = 100.0 * len(reds) / len(peaks)
    if not force and (engaged_pct > TCAP_REJECT_ENGAGE_PCT
                      or longest_s > TCAP_REJECT_EVENT_S):
        where = f" at {int(longest_t // 60)}:{longest_t % 60:04.1f}" if longest_t is not None else ""
        plan["flags"].append(
            f"transient-cap declined: the limiter would engage on "
            f"{engaged_pct:.1f}% of the track (longest event {longest_s:.2f} s{where}) "
            f"— beyond the review band ({TCAP_REJECT_ENGAGE_PCT:g}% / "
            f"{TCAP_REJECT_EVENT_S:g} s); repeated-compression territory, no "
            f"listening evidence — {fallback_desc} instead "
            f"(--transient-cap-force after listening to override)")
        return None
    plan.update(mode="sparse-transient-cap", target=round(in_I + gain, 2),
                gain_db=gain, limit_db=TCAP_LIMIT_DB,
                sr=int(probe(path)["sr"]), tcap_peaks=peaks, tcap_times=times,
                near_peak_pct=round(near_pct, 2))
    tcap_finalize(plan)
    if force and near_pct > TCAP_MAX_NEAR_PEAK_PCT:
        # recorded, not blocking: force means Rene already listened — his
        # ears outrank the calibrated gate, and the provenance says so
        plan["flags"].append(
            f"sparsity screen ({near_pct:.1f}% near-peak > "
            f"{TCAP_MAX_NEAR_PEAK_PCT:g}%) overridden by Rene after listening "
            f"(--transient-cap-force)")
    if excess > 0:
        plan["flags"].append(
            f"gain trimmed {excess:.2f} dB to honor the {effective_max_gr:g} dB "
            f"attenuation cap — lands at {plan['target']:g} LUFS instead of "
            f"{target:g} (inaudible; the cap is the policy, the target is not)")
    return plan


def _tcap_engagement(peaks, gain, limit, times=None):
    """Predicted limiter engagement from the 50 ms frame-peak scan: sorted
    per-frame reductions where the gained signal exceeds the threshold, event
    count, the longest continuous engagement in seconds, and (when `times` is
    given) that longest run's own start time in seconds -- the single
    timestamp most worth a human ear, surfaced in review-tier flags so
    listening doesn't require scrubbing the whole track."""
    reds = sorted(p + gain - limit for p in peaks if p + gain > limit)
    events = longest = run = 0
    run_start = longest_start = None
    for i, p in enumerate(peaks):
        if p + gain > limit:
            if run == 0:
                run_start = i
            run += 1
            if run > longest:
                longest = run
                longest_start = run_start
            if run == 1:
                events += 1
        else:
            run = 0
    longest_t = times[longest_start] if times and longest_start is not None else None
    return reds, events, longest * (TCAP_FRAME_MS / 1000), longest_t


def tcap_finalize(plan):
    """(Re)derive the transient-cap stats + note from plan's current
    gain_db/limit_db — called after initial sizing and again by cmd_process's
    true-peak retry loop whenever limit_db is backed off, so the provenance
    always describes what was actually rendered. All engagement numbers are
    predictions from the 50 ms frame-peak scan of the SOURCE (sample-peak
    domain); the render loop separately verifies the output's true peak."""
    gain, limit = plan["gain_db"], plan["limit_db"]
    peaks = plan["tcap_peaks"]
    times = plan.get("tcap_times")
    in_TP = float(plan["measure"]["input_tp"])
    # the projected output loudness follows the gain — authoritative here so
    # a lockstep gain backoff in the retry loop updates it too
    plan["target"] = round(float(plan["measure"]["input_i"]) + gain, 2)
    reds, events, longest_s, longest_t = _tcap_engagement(peaks, gain, limit, times)
    gr = round(in_TP + gain - limit, 2)  # reduction at the loudest instant (true-peak based)
    plan["tcap"] = {
        "gain_db": gain, "limit_db": limit, "gr_db": gr,
        "near_peak_pct": plan["near_peak_pct"],
        "engaged_pct": round(100.0 * len(reds) / len(peaks), 2),
        "events": events, "longest_s": round(longest_s, 2),
        "longest_at_s": round(longest_t, 2) if longest_t is not None else None,
        "p95_gr_db": round(reds[int(0.95 * (len(reds) - 1))], 2) if reds else 0.0,
        # source LRA, so the preservation claim is auditable from the sidecar
        # alone (entry-level `lra` is the OUTPUT measurement)
        "in_lra": plan["in_lra"],
    }
    t = plan["tcap"]
    plan["note"] = (
        f"sparse musical transients (not applause) set the ceiling: one constant "
        f"{gain:+.1f} dB gain to the full {plan['target']:g} LUFS target, with a "
        f"1 ms/50 ms true-peak cap shaving up to {gr:.1f} dB off the transients "
        f"(~{t['engaged_pct']:.1f}% of the track, {events} event(s), longest "
        f"{t['longest_s']:.2f} s; {t['near_peak_pct']:.1f}% near-peak density)")
    # REVIEW tier (tiered gates, 2026-08-08): anything beyond the auto envelope
    # the A/B evidence covers (engagement <= 1%, events <= 0.2 s, density
    # <= 2%) is capped but hard-blocks publish until Rene's ears rule via
    # accept/exclude/force. The reject band was already handled at sizing.
    # The flagged event's own start time is included so listening doesn't
    # require scrubbing the whole track for the moment in question.
    where = f" at {int(longest_t // 60)}:{longest_t % 60:04.1f}" if longest_t is not None else ""
    if t["longest_s"] > TCAP_AUTO_EVENT_S:
        note = (f"transient cap engages continuously for {t['longest_s']:.2f} s{where} "
                f"(auto envelope {TCAP_AUTO_EVENT_S:g} s) — review tier, "
                "listen before shipping")
        if note not in plan["flags"]:
            plan["flags"].append(note)
    if t["engaged_pct"] > TCAP_AUTO_ENGAGE_PCT:
        note = (f"transient cap engages on {t['engaged_pct']:.1f}% of the track "
                f"(auto envelope {TCAP_AUTO_ENGAGE_PCT:g}%) — review tier, "
                "listen before shipping")
        if note not in plan["flags"]:
            plan["flags"].append(note)
    if t["near_peak_pct"] > TCAP_MAX_NEAR_PEAK_PCT:
        note = (f"near-peak density {t['near_peak_pct']:.1f}% (auto envelope "
                f"{TCAP_MAX_NEAR_PEAK_PCT:g}%) — review tier, "
                "listen before shipping")
        if note not in plan["flags"]:
            plan["flags"].append(note)
    effective_max_gr = plan.get("max_gr", TCAP_MAX_GR)
    if gr > effective_max_gr + 0.01:
        # structurally impossible: sizing trims the gain to the cap and the
        # retry loop moves gain in lockstep once the cap is reached — if this
        # fires, the invariant is broken, not merely a loud track. Compared
        # against whatever ceiling was actually in effect for this track
        # (standard policy, or an explicit --transient-cap-max-gr exception).
        note = (f"attenuation {gr:.2f} dB EXCEEDS the {effective_max_gr:g} dB cap — "
                f"invariant broken; do not ship, listen before shipping")
        if note not in plan["flags"]:
            plan["flags"].append(note)


def tcap_chain(plan, pre=""):
    """The literal ffmpeg filter chain for a transient-cap track — also the
    provenance `chain` ground truth. alimiter thresholds SAMPLE peaks, so it
    runs at 4x the source rate (inter-sample peaks become real samples there)
    with an internal ceiling 0.5 dB under the archive's -1 dBTP (downsampling
    reconstructs some overshoot); cmd_process still measures the actual output
    true peak afterwards and aborts if it doesn't comply. The gain is a plain
    unconditional volume multiply — same no-hidden-dynamic-mode guarantee as
    linear_chain (v6)."""
    amp = 10 ** (plan["limit_db"] / 20)
    sr = plan["sr"]
    return ((pre + ",") if pre else "") + (
        f"volume={plan['gain_db']}dB:precision=double,"
        f"aresample={sr * 4},"
        f"alimiter=limit={amp:.6f}:attack=1:release=50:level=false:latency=1,"
        f"aresample={sr}")


def linear_chain(plan, pre=""):
    """The literal ffmpeg filter chain for a plain-linear or linear-reduced
    track (v6+). loudnorm/ebur128 (via plan_track's measurement pass) decide
    the gain; this single explicit volume multiply performs it — no loudnorm
    at render time, so there is no possibility of ffmpeg's own linear/dynamic
    fallback choosing dynamic-mode processing instead. plan['target'] is
    already the correct target for either mode (the nominal show target for
    'linear', the track's own max-linear target for 'linear-reduced')."""
    gain = round(plan["target"] - float(plan["measure"]["input_i"]), 2)
    return ((pre + ",") if pre else "") + f"volume={gain}dB:precision=double"


def _num_set(s):
    """Parse a comma-separated track-number list ('3,7,12') into a set."""
    return {int(x) for x in s.split(",") if x.strip()} if s else set()


def _num_map(s):
    """Parse a comma-separated track:value list ('8:8.65,3:7') into a dict
    {track_num: float}. Used for --transient-cap-max-gr, an explicit
    per-track exception to the TCAP_MAX_GR policy ceiling — never a way to
    change the ceiling globally."""
    out = {}
    for pair in (s.split(",") if s else []):
        pair = pair.strip()
        if not pair:
            continue
        num, _, val = pair.partition(":")
        out[int(num)] = float(val)
    return out


def recipe_signature(target, filt, tc_on, tc_partial, tc_force, tc_maxgr,
                     tc_over_applause=False):
    """Hash of everything that fully determines one track's render — apart
    from the source audio itself — so a resume decision can prove "this run
    would compute the identical recipe" instead of just "an output file
    happens to exist and isn't older than the source". Previously a resume
    trusted mtime alone: a later run requesting a different target, filter
    chain, or transient-cap treatment for the same track could silently
    reuse stale audio while still writing provenance describing the newly
    requested (but never actually rendered) chain. Workflow version is
    included because a version bump can change what a given mode/target
    combination actually renders even with identical CLI flags.

    New keys must be added CONDITIONALLY, only when the option is actually in
    use. The signature is compared against ones persisted beside outputs
    rendered by earlier runs, so a key emitted unconditionally changes the
    hash of every existing track — turning any resume into a full re-render
    and re-arming every transient-cap listen-block that was already accepted.
    `transient_cap_over_applause` is the first such key: off (the ordinary
    publish path, and the entire existing archive) it stays out of the
    payload and those signatures are byte-identical to what v8 already
    wrote."""
    payload = {
        "workflow_version": WORKFLOW_VERSION, "target": target, "filters": filt,
        "transient_cap": tc_on, "transient_cap_partial": tc_partial,
        "transient_cap_force": tc_force, "transient_cap_max_gr": tc_maxgr,
    }
    if tc_over_applause:
        payload["transient_cap_over_applause"] = True
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]


def cmd_plan(args):
    """Dry run: the exact per-track decisions `process` would make, no audio
    written. Table + normalization_plan.txt in the input folder."""
    folder = args.input
    target = target_for(args.artist, args.target)
    files = lossless_files(folder)
    if not files:
        raise SystemExit(f"no .flac/.wav files in {folder}")
    pre = getattr(args, "eq", None) or ""

    rows = []
    counts = {"linear": 0, "linear-reduced": 0, "applause-limiter": 0,
              "sparse-transient-cap": 0}
    tcap_on = bool(getattr(args, "transient_cap", False))
    tcap_excl = _num_set(getattr(args, "transient_cap_exclude", ""))
    tcap_part = _num_set(getattr(args, "transient_cap_partial", ""))
    tcap_frc = _num_set(getattr(args, "transient_cap_force", ""))
    tcap_maxgr = _num_map(getattr(args, "transient_cap_max_gr", ""))
    for f in files:
        p = plan_track(os.path.join(folder, f), target, pre=pre,
                       transient_cap=tcap_on and lead_num(f) not in tcap_excl,
                       tcap_partial=lead_num(f) in tcap_part,
                       tcap_force=lead_num(f) in tcap_frc,
                       tcap_max_gr=tcap_maxgr.get(lead_num(f)),
                       tcap_over_applause=bool(getattr(args, "transient_cap_over_applause", False)))
        counts[p["mode"]] += 1
        j = p["measure"]
        rows.append((f, float(j["input_i"]), float(j["input_tp"]), p))
        reg = ""
        if p["mode"] == "applause-limiter":
            reg = ("; limit " + ", ".join(f"{fmt_ts(a)}-{fmt_ts(b)} (-{r} dB)"
                                          for a, b, r in p["regions"])
                   + f"; music peak {p['music_peak_db']:.1f} dB")
        elif p["mode"] == "sparse-transient-cap":
            t = p["tcap"]
            reg = (f"; cap {t['gr_db']:.1f} dB max, ~{t['engaged_pct']:.1f}% engaged "
                   f"({t['events']} event(s), longest {t['longest_s']:.2f} s), "
                   f"{t['near_peak_pct']:.1f}% near-peak")
        print(f"  {f}: in {float(j['input_i']):.1f} LUFS, pred {p['pred']:+.1f} dBTP "
              f"-> {p['mode']} @ {p['target']:+.1f} LUFS{reg}", flush=True)
        for fl in p["flags"]:
            print(f"    ⚠ {fl}", flush=True)

    out = os.path.join(folder, "normalization_plan.txt")
    L = [f"NORMALIZATION PLAN (dry run, workflow v{WORKFLOW_VERSION})",
         f"Generated: {datetime.datetime.now().isoformat(timespec='seconds')}",
         f"Nominal target: {target} LUFS / {TP_CEILING} dBTP; "
         f"applause limiter at {APPLAUSE_LIMIT_DB} dB (crest >= {APPLAUSE_CREST_MIN}, "
         f"edge {APPLAUSE_EDGE_S:.0f} s)"
         + (f"; transient cap OPTED IN (limit {TCAP_LIMIT_DB} dB, max "
            f"{TCAP_MAX_GR:g} dB, sparsity <= {TCAP_MAX_NEAR_PEAK_PCT:g}%)"
            if tcap_on else ""),
         "=" * 43, "",
         f"{'File':40s}|{'In LUFS':8s}|{'Pred TP':8s}|{'Mode':17s}|{'Out LUFS':9s}|"
         f"{'vs -20':7s}|Limited regions / flags",
         "-" * 120]
    for f, in_I, in_TP, p in rows:
        extra = "; ".join(
            ([", ".join(f"{fmt_ts(a)}-{fmt_ts(b)} (-{r} dB)" for a, b, r in p["regions"])]
             if p["mode"] == "applause-limiter" else []) + p["flags"])
        L.append(f"{f[:40]:40s}|{in_I:8.1f}|{p['pred']:+8.1f}|{p['mode']:17s}|"
                 f"{p['target']:9.2f}|{p['target'] - target:+7.2f}|{extra}")
    L += ["", f"Modes: {counts['linear']} linear, {counts['linear-reduced']} "
              f"linear-reduced, {counts['applause-limiter']} applause-limiter, "
              f"{counts['sparse-transient-cap']} sparse-transient-cap"]
    open(out, "w").write("\n".join(L) + "\n")
    print(f"\n[plan -> {out}]  {counts['linear']} linear / "
          f"{counts['linear-reduced']} reduced / {counts['applause-limiter']} limiter / "
          f"{counts['sparse-transient-cap']} tcap")


def cmd_process(args):
    infolder, outfolder = args.input, args.output
    target = args.target
    os.makedirs(outfolder, exist_ok=True)
    files = lossless_files(infolder)
    if not files:
        raise SystemExit(f"no .flac/.wav files in {infolder}")
    preflight_track_files(files)
    # nominal/unclamped, for the processing_report.txt header only — the actual
    # per-track chain (below) is Nyquist-aware and can differ from this on an
    # unusual low-sample-rate source; that per-track deviation is always
    # visible in that track's own recorded `chain`.
    filt_summary = build_filters(args)

    tag_ctx = show_tags(args.slug) if args.slug else None
    if args.slug and tag_ctx is None:
        print(f"note: {args.slug} not in recordings.json — no tags embedded")

    # Loaded up front (not just at the final merge) so a resume decision can
    # check what actually produced the existing per-track entry, and so a
    # resumed track's `ver` reports what really rendered it rather than
    # whatever WORKFLOW_VERSION this run happens to be.
    prev_tracks = {}
    if args.slug:
        prev_path = (getattr(args, "provenance_out", None)
                     or os.path.join(ROOT, "data", "processing", f"{args.slug}.json"))
        if os.path.exists(prev_path):
            try:
                prev_tracks = json.load(open(prev_path)).get("tracks", {})
            except Exception:
                prev_tracks = {}

    prov_tracks, report, warnings = {}, [], []
    for i, f in enumerate(files, 1):
        src = os.path.join(infolder, f)
        container = "flac" if f.lower().endswith(".flac") else "wav"
        out_audio = os.path.join(outfolder, f)
        out_mp3 = os.path.join(outfolder, os.path.splitext(f)[0] + ".mp3")
        num = lead_num(f)

        # Probed up front (not just in the render branch below) so the filter
        # chain can be built against THIS track's real sample rate — different
        # tracks in one folder can, in principle, have different rates, and
        # --lpf's Nyquist check needs to be per-track, not a single folder-wide
        # guess (fix for #6: an 18 kHz low-pass on a 32 kHz/16 kHz-Nyquist
        # source used to silently do nothing).
        info = probe(src)
        filt = build_filters(args, sr=int(info["sr"]))

        # Decide the effective per-track handling up front (source-only, cheap —
        # needed whether we process fresh or resume-skip). See plan_track: plain
        # linear when the nominal target fits under the TP ceiling; the v4
        # reduced "max linear target" for small overshoots (linear=true is only
        # a request — exceeding the ceiling silently switches loudnorm to
        # dynamic mode, which flattens fades); applause-aware limiting (v5)
        # when non-music transients are what's eating the headroom.
        tc_on = (bool(getattr(args, "transient_cap", False))
                 and num not in _num_set(getattr(args, "transient_cap_exclude", "")))
        tc_partial = num in _num_set(getattr(args, "transient_cap_partial", ""))
        tc_force = num in _num_set(getattr(args, "transient_cap_force", ""))
        tc_maxgr = _num_map(getattr(args, "transient_cap_max_gr", "")).get(num)
        recipe_sig = recipe_signature(target, filt, tc_on, tc_partial, tc_force, tc_maxgr,
                                      bool(getattr(args, "transient_cap_over_applause", False)))
        # Decoded once up front (extra cost paid on every track, resumed or
        # not) so a resume decision can prove "these are the exact bytes the
        # existing output's provenance claims to be built from", not just
        # "mtime looks plausible" — the source-side half of the #2 fix.
        src_md5 = audio_md5(src)
        tc_over_app = bool(getattr(args, "transient_cap_over_applause", False))
        plan = plan_track(src, target, pre=filt, transient_cap=tc_on,
                          tcap_partial=tc_partial, tcap_force=tc_force,
                          tcap_max_gr=tc_maxgr,
                          tcap_over_applause=tc_over_app)
        used_target = plan["target"]
        limiter = plan["mode"] == "applause-limiter"
        tcap = plan["mode"] == "sparse-transient-cap"
        in_I_chk = float(plan["measure"]["input_i"])
        in_TP_chk = float(plan["measure"]["input_tp"])
        for fl in plan["flags"]:
            print(f"  ⚠ {f}: {fl}", flush=True)
        # A tcap track flagged for ears is a HARD gate, not a warning: nothing
        # ships unheard. Resolve by listening and re-running with an explicit
        # per-track decision — accept (ears approved) or exclude (stay linear).
        blocking = [fl for fl in plan["flags"] if "listen before shipping" in fl]
        if tcap and blocking and not tc_force and num not in _num_set(
                getattr(args, "transient_cap_accept", "")):
            raise SystemExit(
                f"{f}: the transient cap flagged this track for ears:\n  - "
                + "\n  - ".join(blocking)
                + f"\nListen first (scripts/ab_compare.py <slug> {num}), then re-run "
                  f"with --transient-cap-accept {num} (ears approved) or "
                  f"--transient-cap-exclude {num} (keep it linear). "
                  "Nothing was rendered for this track and nothing was uploaded.")

        # Resume-skip only if the existing output isn't stale: if the source was
        # re-exported (e.g. Rene fixed a click in Audacity) after this render, its
        # mtime moves past the output's and the old render must not be trusted
        # just because a same-named file happens to exist. Also stale if the
        # RECIPE changed — target, filter chain, or transient-cap treatment —
        # even though the source bytes and mtime didn't. Previously only mtime
        # was checked, so a later run requesting a different --target/--eq/
        # --hpf/--transient-cap for an unchanged source would silently reuse
        # the old render while writing provenance describing the newly
        # requested (but never actually rendered) chain. `recipe_sig` is only
        # compared when the existing provenance entry has one recorded — older
        # entries that predate this check fall back to the mtime rule alone,
        # so this fix doesn't force a mass reprocess of the whole archive.
        prev_entry = prev_tracks.get(str(num), {})
        recipe_changed = ("recipe_sig" in prev_entry
                          and prev_entry["recipe_sig"] != recipe_sig)
        src_changed = ("src_md5" in prev_entry
                       and prev_entry["src_md5"] != src_md5)
        mtime_stale = (os.path.exists(out_audio) and os.path.exists(out_mp3)
                       and os.path.getmtime(out_audio) < os.path.getmtime(src))
        stale = os.path.exists(out_audio) and os.path.exists(out_mp3) \
            and (mtime_stale or recipe_changed or src_changed)
        if recipe_changed:
            print(f"  {f}: the requested recipe (target/filters/transient-cap) "
                  "differs from what produced the existing output — ignoring it "
                  "and reprocessing", flush=True)
        elif src_changed:
            print(f"  {f}: source audio MD5 differs from what produced the "
                  "existing output (re-export with unchanged mtime?) — ignoring "
                  "it and reprocessing", flush=True)
        elif stale:
            print(f"  {f}: source is newer than the existing output — "
                  "ignoring it and reprocessing", flush=True)
        resumable = (os.path.exists(out_audio) and os.path.exists(out_mp3) and not stale)
        if resumable:
            # Confirm the existing output's bytes actually match what its own
            # recorded provenance claims before trusting a resume-skip at all
            # — recipe/mtime agreement doesn't by itself prove the file on
            # disk wasn't hand-edited, partially re-exported, or left over
            # from an interrupted run.
            existing_md5 = prev_entry.get("md5")
            if existing_md5:
                out_md5_now = audio_md5(out_audio)
                if out_md5_now != existing_md5:
                    print(f"  {f}: existing output's audio MD5 doesn't match its "
                          f"own recorded provenance ({out_md5_now[:8]} vs "
                          f"{existing_md5[:8]}) — cannot trust this resume-skip; "
                          "reprocessing", flush=True)
                    resumable = False
        if resumable and tcap:
            # A resumed tcap render is only trusted when it can PROVE its
            # chain: the .v8state.json written beside the accepted render
            # holds the gain/limit that actually produced the bytes (retries
            # may have moved both, and neither leaves a reliable loudness
            # fingerprint). Missing state, or an output over the strict
            # ceiling (interrupted mid-retry), means re-render — provenance
            # must never describe a chain it merely guesses.
            state_path = out_audio + ".v8state.json"
            try:
                st = json.load(open(state_path))
                plan["gain_db"], plan["limit_db"] = st["gain_db"], st["limit_db"]
                tcap_finalize(plan)
                used_target = plan["target"]
            except (OSError, ValueError, KeyError):
                print(f"  {f}: no render-state file for the existing output — "
                      "cannot prove what produced it; reprocessing", flush=True)
                resumable = False
            if resumable:
                j2 = measure(out_audio, plan["target"])
                if float(j2["input_tp"]) > TP_CEILING:
                    print(f"  {f}: existing output measures "
                          f"{float(j2['input_tp']):+.2f} dBTP (> {TP_CEILING} strict "
                          "ceiling; interrupted mid-retry?) — ignoring it and "
                          "reprocessing", flush=True)
                    resumable = False

        if resumable:
            # still record provenance from the existing output. For a limiter
            # track this is a re-run after a prior interruption (e.g. a killed
            # job) — plan_track's fresh guess doesn't know the true-peak safety
            # loop backed the gain off last time, so it would describe a gain
            # that doesn't match what's actually in the file. Reconcile against
            # the real render before trusting any of plan's descriptive fields.
            if limiter:
                j2 = measure(out_audio, plan["target"])
                actual_gain = round(float(j2["input_i"]) - in_I_chk, 2)
                if actual_gain != plan["gain_db"]:
                    plan["gain_db"] = actual_gain
                    limiter_finalize(plan)
                used_target = plan["target"]
            elif tcap:
                # j2 measured, and plan's gain/limit were restored from the
                # render-state file above — the chain recorded below describes
                # the actual bytes, not a fresh guess.
                pass
            else:
                j2 = measure(out_audio, used_target)
            note = {"linear-reduced": f" [target {used_target:+.1f} LUFS, linear-preserving]",
                    "applause-limiter": f" [target {used_target:+.1f} LUFS, applause-limited]",
                    "sparse-transient-cap": f" [target {used_target:+.1f} LUFS, transient-capped]",
                    }.get(plan["mode"], "")
            print(f"[{i:02d}/{len(files)}] {f} — exists, skipping (resume){note}", flush=True)
            in_I = in_I_chk if os.path.exists(src) else None
        else:
            if limiter:
                print(f"  {f}: applause transients set the ceiling (music peaks at "
                      f"{plan['music_peak_db']:.1f} dB) — linear {plan['gain_db']:+.1f} dB to "
                      f"{used_target:+.1f} LUFS with applause-only limiting "
                      f"({len(plan['regions'])} region(s), max {plan['max_reduction_db']:.1f} dB)",
                      flush=True)
            elif tcap:
                t = plan["tcap"]
                print(f"  {f}: sparse musical transients set the ceiling "
                      f"({t['near_peak_pct']:.1f}% near-peak) — {plan['gain_db']:+.1f} dB "
                      f"to the full {used_target:+.1f} LUFS target with a true-peak cap "
                      f"(max {t['gr_db']:.1f} dB, ~{t['engaged_pct']:.1f}% engaged)",
                      flush=True)
            elif used_target != target:
                print(f"  {f}: linear gain to {target} LUFS would hit {plan['pred']:+.2f} dBTP "
                      f"(> {TP_CEILING}) — using {used_target:+.1f} LUFS instead to keep "
                      f"true linear normalization (preserves fades/dynamics)", flush=True)
            in_I = in_I_chk
            pre = (filt + ",") if filt else ""
            codec = output_codec(info["bits"], info["sample_fmt"], container)
            if limiter:
                # alimiter thresholds SAMPLE peaks; the archive's ceiling is a
                # TRUE (oversampled) peak. Render, measure the real output TP,
                # and back the gain off if it overshot — don't trust the
                # threshold alone (see APPLAUSE_TP_MAX_ATTEMPTS). Tags are
                # rebuilt each attempt so the final render's embedded "-N LUFS"
                # comment always matches what was actually achieved.
                for attempt in range(1, APPLAUSE_TP_MAX_ATTEMPTS + 1):
                    tags = tag_args(tag_ctx, f, num, len(files), plan["target"])
                    af = limiter_chain(plan, pre=filt)
                    r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                                        "-i", src, "-af", af, "-ar", str(info["sr"])] + codec
                                       + tags + [out_audio], capture_output=True, text=True)
                    if r.returncode != 0:
                        break
                    tp_now = float(measure(out_audio, plan["target"])["input_tp"])
                    if tp_now <= TP_CEILING + TP_TOL:
                        break
                    overshoot = tp_now - TP_CEILING
                    if attempt == APPLAUSE_TP_MAX_ATTEMPTS:
                        # Out of retries — out_audio on disk is attempt N's render, at
                        # plan's CURRENT gain. Don't adjust plan any further: doing so
                        # without a matching re-render would make the provenance chain
                        # and applause_limiter.gain_db describe a gain that was never
                        # actually applied, even though lufs/tp below are measured
                        # honestly straight off the file. The TP>ceiling warning below
                        # already flags the shortfall from the real measurement.
                        break
                    # Backing off gain_db alone doesn't move an overshoot caused by
                    # the applause: alimiter clamps to limit_db regardless of how
                    # much pre-gain feeds it, as long as the input still exceeds
                    # that threshold — so a gain-only backoff leaves the applause's
                    # output level (and therefore its true peak) unchanged while
                    # only eating into the music's already-safe headroom. Back off
                    # limit_db by the same amount so the clamp itself moves, and
                    # gain_db in lockstep to preserve music_peak + gain <= limit
                    # (the invariant that keeps the limiter from ever touching
                    # anything classified as music).
                    delta = overshoot + 0.15
                    print(f"  {f}: attempt {attempt} measured {tp_now:+.2f} dBTP "
                          f"(> {TP_CEILING}) — backing off limiter threshold and gain by "
                          f"{delta:.2f} dB and re-rendering", flush=True)
                    plan["limit_db"] = round(plan["limit_db"] - delta, 2)
                    plan["gain_db"] = round(plan["gain_db"] - delta, 2)
                    limiter_finalize(plan)
                used_target = plan["target"]
            elif tcap:
                # Same measure-and-correct pattern as the applause loop, with two
                # deliberate differences. (1) On retry, limit_db moves first (the
                # v7 lesson: move the number that's stuck; gain is what delivers
                # the loudness) — but the moment lowering the threshold alone
                # would push the shave past the TCAP_MAX_GR attenuation cap, the
                # gain moves in lockstep instead, sacrificing a sliver of
                # loudness to keep the cap absolute. (2) Exhausting the retries
                # ABORTS and deletes the output instead of warning, and the
                # ceiling here is the strict -1.00 dBTP promise, not the
                # QA-tolerance one: a mode whose whole job is limiting music
                # transients must never ship an over-ceiling render.
                for attempt in range(1, TCAP_TP_MAX_ATTEMPTS + 1):
                    tags = tag_args(tag_ctx, f, num, len(files), plan["target"])
                    af = tcap_chain(plan, pre=filt)
                    r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                                        "-i", src, "-af", af, "-ar", str(info["sr"])] + codec
                                       + tags + [out_audio], capture_output=True, text=True)
                    if r.returncode != 0:
                        break
                    tp_now = float(measure(out_audio, plan["target"])["input_tp"])
                    if tp_now <= TP_CEILING:
                        # persist what actually rendered, so a resumed run can
                        # prove the chain instead of guessing it (and so
                        # provenance never describes bytes it didn't make)
                        json.dump({"gain_db": plan["gain_db"],
                                   "limit_db": plan["limit_db"]},
                                  open(out_audio + ".v8state.json", "w"))
                        break
                    if attempt == TCAP_TP_MAX_ATTEMPTS:
                        for stalefile in (out_audio, out_mp3,
                                          out_audio + ".v8state.json"):
                            if os.path.exists(stalefile):
                                os.remove(stalefile)
                        raise SystemExit(
                            f"{f}: transient-cap could not bring the output under "
                            f"{TP_CEILING} dBTP in {TCAP_TP_MAX_ATTEMPTS} attempts "
                            f"(last measured {tp_now:+.2f} dBTP) — output deleted, "
                            f"aborting rather than shipping an over-ceiling render")
                    delta = (tp_now - TP_CEILING) + 0.15
                    new_limit = round(plan["limit_db"] - delta, 2)
                    gr_after = round(in_TP_chk + plan["gain_db"] - new_limit, 2)
                    if gr_after > TCAP_MAX_GR:
                        lock = round(gr_after - TCAP_MAX_GR, 2)
                        plan["gain_db"] = round(plan["gain_db"] - lock, 2)
                        print(f"  {f}: attempt {attempt} measured {tp_now:+.2f} dBTP "
                              f"(> {TP_CEILING}) — lowering threshold by {delta:.2f} dB "
                              f"and gain by {lock:.2f} dB (attenuation capped at "
                              f"{TCAP_MAX_GR:g} dB) and re-rendering", flush=True)
                    else:
                        print(f"  {f}: attempt {attempt} measured {tp_now:+.2f} dBTP "
                              f"(> {TP_CEILING}) — lowering the cap threshold by "
                              f"{delta:.2f} dB (gain untouched) and re-rendering",
                              flush=True)
                    plan["limit_db"] = new_limit
                    tcap_finalize(plan)
                used_target = plan["target"]
            else:
                tags = tag_args(tag_ctx, f, num, len(files), used_target)
                # v6: an explicit volume gain (the same number plan_track already
                # computed), not loudnorm at render time — loudnorm/ebur128 remain
                # the measurement tools (plan_track's own analysis pass), but the
                # signal change itself is now an unconditional multiply, so there
                # is no possibility of ffmpeg's linear-mode silently falling back
                # to dynamic (frame-adaptive) normalization at render time.
                af = linear_chain(plan, pre=filt)
                r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                                    "-i", src, "-af", af, "-ar", str(info["sr"])] + codec
                                   + tags + [out_audio], capture_output=True, text=True)
            if r.returncode != 0:
                print(f"  FAIL {f}: {r.stderr[-200:]}", flush=True)
                continue
            # v6: lossy encoding can overshoot the FLAC's true peak (clips on decode
            # even though the FLAC is fine). Never touch the FLAC master's gain for
            # this — it's an MP3-only, listener-convenience-format concern — so trim
            # a small extra volume cut into the MP3 encode alone and re-measure,
            # same measure-and-correct pattern as the applause true-peak loop above.
            # Factored into encode_mp3_with_qa() (also reused by make_stream_mp3.py's
            # whole-show proxies) so both encoders get the identical QA.
            mp3_result = encode_mp3_with_qa(
                out_audio, out_mp3, used_target, tags,
                on_trim=lambda attempt, tp_now, new_trim: print(
                    f"  {f}: MP3 true peak {tp_now:+.2f} dBTP — trimming MP3-only "
                    f"gain to {new_trim:.2f} dB total and re-encoding", flush=True))
            if not mp3_result["ok"]:
                print(f"  MP3 FAIL {f}: {mp3_result['stderr'][-200:]}", flush=True)
                continue
            j2 = measure(out_audio, used_target)

        out_I, out_TP, out_LRA = float(j2["input_i"]), float(j2["input_tp"]), float(j2["input_lra"])
        md5 = audio_md5(out_audio)
        mp3_md5 = audio_md5(out_mp3)
        max_m, max_s = max_short_term_momentary(out_audio)
        # the lossy encode can overshoot the FLAC's peaks — measure the MP3's
        # true peak too and warn if it would clip on decode
        mp3_tp = float(measure(out_mp3, used_target)["input_tp"])
        # verification (#7)
        status = f"target {used_target:+.1f}" if used_target != target else "OK"
        if limiter:
            status = f"limiter {used_target:+.1f}"
        if tcap:
            status = f"tcap {plan['tcap']['gr_db']:.1f}dB"
        if out_TP > TP_CEILING + TP_TOL:
            status = "TP>ceiling"
            warnings.append(f"{f}: achieved TP {out_TP:+.2f} dBTP exceeds {TP_CEILING} ceiling")
        if abs(out_I - used_target) > LUFS_TOL:
            status = "LUFS drift"
            warnings.append(f"{f}: achieved {out_I:.2f} LUFS drifts > {LUFS_TOL} from {used_target}")
        if abs(out_LRA - plan["in_lra"]) > APPLAUSE_LRA_TOL:
            # v6: checked on every mode, not just applause-limiter. A purely
            # linear gain (any mode) cannot change dynamic range at all — a
            # shifted LRA is exactly the signature of a hidden dynamic-mode
            # render, which is now structurally impossible (v6 renders with an
            # explicit volume gain, never loudnorm), or, for a limiter track,
            # of the limiter touching more than the applause transients.
            status = "LRA shifted"
            reason = ("limiter touched more than applause transients" if limiter
                      else "transient cap engaged beyond isolated transients — "
                           "this track may not belong in the mode" if tcap
                      else "linear gain should never change dynamic range")
            warnings.append(f"{f}: output LRA {out_LRA:.1f} vs source {plan['in_lra']:.1f} — "
                            f"{reason}; review")
        if mp3_tp > 0.0:
            status = "MP3 clips"
            warnings.append(f"{f}: MP3 true peak {mp3_tp:+.2f} dBTP — lossy overshoot "
                            "clips on decode (FLAC is fine; consider re-encode headroom)")
        track_chain = (limiter_chain(plan, pre=filt) if limiter
                       else tcap_chain(plan, pre=filt) if tcap
                       else linear_chain(plan, pre=filt))
        plr = round(out_TP - out_I, 2)
        if num is not None:
            # A resumed track's bytes were rendered by whatever version last
            # actually processed it, not necessarily this run's WORKFLOW_VERSION —
            # report that honestly instead of overwriting it on every resume.
            entry_ver = (prev_tracks.get(str(num), {}).get("ver", WORKFLOW_VERSION)
                         if resumable else WORKFLOW_VERSION)
            entry = {"ver": entry_ver, "chain": track_chain,
                     "lufs": round(out_I, 2), "tp": round(out_TP, 2),
                     "mp3_tp": round(mp3_tp, 2), "max_m": max_m, "max_s": max_s,
                     "lra": round(out_LRA, 2), "plr": plr, "md5": md5, "mp3_md5": mp3_md5}
            if in_I is not None:
                entry = {"ver": entry_ver, "chain": track_chain,
                         "in_lufs": round(in_I, 1),
                         "lufs": round(out_I, 2), "tp": round(out_TP, 2),
                         "mp3_tp": round(mp3_tp, 2), "max_m": max_m, "max_s": max_s,
                         "lra": round(out_LRA, 2), "plr": plr, "md5": md5, "mp3_md5": mp3_md5}
            # #2 fix: recorded so the NEXT run can prove a resume-skip's recipe
            # and source bytes both still match, instead of trusting mtime alone
            entry["recipe_sig"] = recipe_sig
            entry["src_md5"] = src_md5
            if used_target != target:
                entry["target_lufs"] = used_target
            if limiter:
                entry["applause_limiter"] = {"gain_db": plan["gain_db"],
                                             "limit_db": plan["limit_db"],
                                             "regions": plan["regions"]}
            if tcap:
                # the full guardrail record, per the 2026-08-08 review: depth
                # (gr/p95), duration (engaged %, longest event), and the
                # sparsity number that qualified the track — enough to audit
                # any capped track later without re-running the frame scan
                entry["transient_cap"] = dict(plan["tcap"])
                # policy_max_gr_db is always recorded (standard ceiling by
                # default) so a track is auditable even if TCAP_MAX_GR itself
                # changes later; override/override_note only appear when a
                # track's actual cut exceeds the STANDARD ceiling — i.e. an
                # explicit --transient-cap-max-gr exception, never silent.
                effective_max_gr = plan.get("max_gr", TCAP_MAX_GR)
                entry["transient_cap"]["policy_max_gr_db"] = effective_max_gr
                if plan["tcap"]["gr_db"] > TCAP_MAX_GR + 0.01:
                    entry["transient_cap"]["override"] = True
                    entry["transient_cap"]["override_note"] = (
                        f"exceeds the standard {TCAP_MAX_GR:g} dB policy ceiling — "
                        f"explicit per-track exception (--transient-cap-max-gr), "
                        f"ceiling raised to {effective_max_gr:g} dB for this render")
            # audit trail: what treatment this track got and WHY — the chain says
            # what ran; mode+note record the decision so Butter ("applause set the
            # ceiling, tail limited") reads differently from a track whose music
            # sets its own ceiling. Review flags travel with the note.
            entry["mode"] = plan["mode"]
            note = plan.get("note", "")
            if plan["flags"]:
                note += " [review: " + "; ".join(plan["flags"]) + "]"
            if note:
                entry["note"] = note
            prov_tracks[str(num)] = entry
        report.append((f, in_I, out_I, out_TP, status))
        print(f"[{i:02d}/{len(files)}] {f} -> {out_I:.2f} LUFS, TP {out_TP:.2f} "
              f"[{status}] md5 {md5[:8]}", flush=True)

    # processing report
    rp = ["PROCESSING REPORT",
          f"Generated: {datetime.datetime.now().isoformat(timespec='seconds')}",
          f"Filters: {filt_summary or 'none'}", f"Target: {target} LUFS / {TP_CEILING} dBTP",
          "=" * 43, "",
          f"{'File':40s}|{'In LUFS':8s}|{'Out LUFS':8s}|{'Out TP':8s}|Status",
          "-" * 82]
    for f, in_I, out_I, out_TP, status in report:
        rp.append(f"{f[:40]:40s}|{('%.1f' % in_I) if in_I is not None else '--':>8s}|"
                  f"{out_I:8.2f}|{out_TP:8.2f}|{status}")
    if warnings:
        rp += ["", "WARNINGS", "--------"] + ["⚠ " + w for w in warnings]
    open(os.path.join(outfolder, "processing_report.txt"), "w").write("\n".join(rp) + "\n")

    if args.slug:
        info0 = probe(os.path.join(infolder, files[0]))
        cont = "FLAC" if files[0].lower().endswith(".flac") else "WAV"
        whole = lambda x: int(x) if float(x) == int(x) else x
        dest = (getattr(args, "provenance_out", None)
                or os.path.join(ROOT, "data", "processing", f"{args.slug}.json"))
        # MERGE: keep any tracks not touched this run (possibly from an older
        # workflow version) and overlay the ones we just processed. This is what
        # lets one show hold a mix of versions — e.g. 29 tracks on v1 and a single
        # track later re-run on v2 with an added filter.
        merged, prev = {}, {}
        if os.path.exists(dest):
            try:
                prev = json.load(open(dest))
                merged = prev.get("tracks", {})
            except Exception:
                merged, prev = {}, {}
        merged.update(prov_tracks)
        # manual Audacity work beyond the standard fades/clip-fixes (e.g. whole-show
        # noise reduction); sticky across re-runs unless overridden on the CLI.
        pre_edits = getattr(args, "pre_edits", None) or prev.get("pre_edits")
        prov = {
            "slug": args.slug, "target_lufs": whole(target), "tp_ceiling": whole(TP_CEILING),
            "source": f"{info0['bits']}-bit / {int(info0['sr'])//1000} kHz {cont}",
            **({"pre_edits": pre_edits} if pre_edits else {}),
            "filters": filt_summary or "none",
            # last-run context; the per-track `ver`/`chain` are the authoritative
            # record for mixed-version shows.
            "workflow_version": WORKFLOW_VERSION, "ffmpeg": ffmpeg_version(),
            "date": datetime.date.today().isoformat(),
            "tracks": {k: merged[k] for k in sorted(merged, key=int)},
        }
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        json.dump(prov, open(dest, "w"), indent=2, ensure_ascii=False)
        open(dest, "a").write("\n")
        print(f"provenance -> {dest} (workflow v{WORKFLOW_VERSION}, "
              f"{len(prov_tracks)} track(s) this run, {len(merged)} total)")

    print(f"\nProcessed {len(report)} file(s). "
          + (f"{len(warnings)} warning(s) — see report." if warnings else "All within spec."))
    if warnings:
        sys.exit(2)


# ── verify (#8 integrity / drift) ─────────────────────────────────────────────

def r2_md5(key):
    rc = subprocess.Popen(["rclone", "cat", f"{BUCKET}/{key}", "--s3-no-check-bucket"],
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    ff = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
                         "-map", "0:a", "-f", "md5", "-"],
                        stdin=rc.stdout, capture_output=True, text=True)
    rc.wait()
    return ff.stdout.strip().replace("MD5=", "")


def cmd_verify(args):
    data = json.load(open(os.path.join(ROOT, "data", "recordings.json")))
    show = next((s for s in data["shows"] if s["slug"] == args.slug), None)
    if not show:
        raise SystemExit(f"no show with slug {args.slug}")
    prov = json.load(open(os.path.join(ROOT, "data", "processing", f"{args.slug}.json")))
    by_num = {str(t["num"]): t for t in show["tracks"]}
    bad = 0
    for num, pt in prov["tracks"].items():
        want = pt.get("md5")
        key = by_num[num].get("flac") or by_num[num]["file"]
        got = r2_md5(key)
        ok = got == want
        bad += not ok
        print(f"  track {num}: R2 {'OK ' if ok else 'MISMATCH'} ({got[:8]} vs {want[:8]})")
        if args.drive:
            # Drive copy: filename mirrors the local processed name; compare by track num.
            import glob  # noqa
            print(f"           (drive check: pass {args.drive!r} keys not auto-mapped — "
                  "skipping unless filename known)")
    print(f"\n{len(prov['tracks'])} track(s) checked, {bad} mismatch(es).")
    sys.exit(1 if bad else 0)


def cmd_retag(args):
    """Retro-fit embedded metadata tags onto already-published shows: download
    each FLAC+MP3 from R2, rewrite the container with tags (-c copy — the audio
    stream and its provenance MD5 are untouched), verify, and upload back.
    Records `tags_embedded` in the sidecar. Drive Processed/ backups are NOT
    refreshed here (slow, stall-prone) — do that separately per show."""
    data = json.load(open(os.path.join(ROOT, "data", "recordings.json")))
    if args.slug:
        shows = [s for s in data["shows"] if s["slug"] == args.slug]
    elif args.all:
        shows = [s for s in data["shows"] if s.get("tracks")]
    else:
        raise SystemExit("give a slug or --all")

    for show in shows:
        slug = show["slug"]
        prov_path = os.path.join(ROOT, "data", "processing", f"{slug}.json")
        prov = json.load(open(prov_path)) if os.path.exists(prov_path) else {}
        if prov.get("tags_embedded") and not args.force:
            print(f"{slug}: already tagged ({prov['tags_embedded']}) — skipping "
                  "(--force to re-tag, e.g. after a make-edit retitle)")
            continue
        ctx = show_tags(slug)
        tracks = show["tracks"]
        work = os.path.expanduser(f"~/work/retag/{slug}")
        os.makedirs(work, exist_ok=True)
        print(f"\n{slug}: {len(tracks)} track(s)")
        bad = 0
        for t in tracks:
            for key in filter(None, (t.get("flac"), t.get("file"))):
                name = key.split("/")[-1]
                local = os.path.join(work, name)
                tmp = os.path.join(work, "tagged_" + name)
                if subprocess.run(["rclone", "copyto", f"{BUCKET}/{key}", local,
                                   "--s3-no-check-bucket"]).returncode != 0:
                    print(f"  DOWNLOAD FAIL {key}"); bad += 1; continue
                tags = tag_args(ctx, name, t["num"], len(tracks),
                                prov.get("target_lufs", -20), title=t.get("title"))
                extra = ["-id3v2_version", "3"] if name.lower().endswith(".mp3") else []
                r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                                    "-i", local, "-map", "0", "-c", "copy"]
                                   + extra + tags + [tmp],
                                   capture_output=True, text=True)
                if r.returncode != 0:
                    print(f"  RETAG FAIL {key}: {r.stderr[-120:]}"); bad += 1; continue
                if audio_md5(tmp) != audio_md5(local):
                    print(f"  AUDIO CHANGED (refusing) {key}"); bad += 1; continue
                os.replace(tmp, local)
                if subprocess.run(["rclone", "copyto", local, f"{BUCKET}/{key}",
                                   "--s3-no-check-bucket"]).returncode != 0:
                    print(f"  UPLOAD FAIL {key}"); bad += 1; continue
            print(f"  [{t['num']:02d}] {t['title']} ok", flush=True)
        if bad:
            print(f"{slug}: {bad} failure(s) — NOT marking tagged")
        else:
            prov["tags_embedded"] = datetime.date.today().isoformat()
            json.dump(prov, open(prov_path, "w"), indent=2, ensure_ascii=False)
            open(prov_path, "a").write("\n")
            print(f"{slug}: done, sidecar marked tags_embedded")
        # local copies are per-show scratch — drop them immediately or a long
        # --all run fills the disk (learned 2026-07-10: 5 shows died on ENOSPC)
        import shutil
        shutil.rmtree(work, ignore_errors=True)


def cmd_versions(args):
    """Decode the workflow-version registry: what each version's processing did."""
    print(f"Current workflow version: {WORKFLOW_VERSION}\n")
    for v in sorted(WORKFLOW_VERSIONS):
        meta = WORKFLOW_VERSIONS[v]
        print(f"v{v}: {meta['desc']}")
        for k, val in meta.items():
            if k == "desc":
                continue
            print(f"     {k}: {val}")
        print()


def cmd_history(args):
    """Show, per track, which workflow version and exact process chain was applied
    — including a single track re-run later on a newer version."""
    path = os.path.join(ROOT, "data", "processing", f"{args.slug}.json")
    if not os.path.exists(path):
        raise SystemExit(f"no provenance for {args.slug} (not processed via the engine)")
    prov = json.load(open(path))
    print(f"{args.slug}  —  last run: workflow v{prov.get('workflow_version','?')}, "
          f"ffmpeg {prov.get('ffmpeg','?')}, {prov.get('date','?')}")
    vers = {}
    for num in sorted(prov["tracks"], key=int):
        t = prov["tracks"][num]
        v = t.get("ver", "?")
        vers[v] = vers.get(v, 0) + 1
        if args.chains:
            print(f"  track {num:>2}: v{v}  {t.get('chain','(unknown)')}")
        else:
            print(f"  track {num:>2}: v{v}")
    summary = ", ".join(f"v{k}: {n} track(s)" for k, n in sorted(vers.items(), key=lambda x: str(x[0])))
    print(f"\n  {len(prov['tracks'])} track(s) — {summary}")


# ── processing status (which shows/tracks are done / need work) ────────────────
# Statuses:
#   done             — track-listed show, every track has a sidecar entry
#   partial          — track-listed show, some (not all) tracks processed
#   needs-processing — never processed (track-listed with no sidecar, OR a
#                      whole-show-only show — those have no split tracks for the
#                      engine to act on yet, so they need splitting first)
#   redo             — normalized off the books (e.g. an old manual pass at the
#                      wrong target, no sidecar). Sticky: stays `redo` until a real
#                      sidecar exists, then auto-upgrades to done/partial.
# Shows known to have been normalized outside the engine (no provenance) — flagged
# for a re-run through the engine to get on-standard + verifiable:
REDO_SLUGS = {"jerry-19-broadway-2001-01-15"}


def show_status(show):
    slug = show["slug"]
    tracks = show.get("tracks") or []
    if not tracks:
        return "needs-processing"  # whole-show-only: nothing split to process yet
    path = os.path.join(ROOT, "data", "processing", f"{slug}.json")
    if os.path.exists(path):
        pt = json.load(open(path)).get("tracks", {})
        done = sum(1 for t in tracks if str(t["num"]) in pt)
        if done >= len(tracks):
            return "done"
        if done > 0:
            return "partial"
    if slug in REDO_SLUGS:
        return "redo"
    return "needs-processing"


def cmd_status(args):
    """Compute each show's processing status (and per-track `processed`) from the
    sidecars. With --write, persist `processing_status` per show and `processed`
    per track into recordings.json so the data is browsable/checkable without drift
    (re-run after any processing). Without --write, just print the report."""
    data_path = os.path.join(ROOT, "data", "recordings.json")
    data = json.load(open(data_path))
    order = {"needs-processing": 0, "redo": 1, "partial": 2, "done": 3}
    rows, tally = [], {}
    for show in sorted(data["shows"], key=lambda s: order.get(show_status(s), 9)):
        st = show_status(show)
        tally[st] = tally.get(st, 0) + 1
        tracks = show.get("tracks") or []
        path = os.path.join(ROOT, "data", "processing", f"{show['slug']}.json")
        pt = json.load(open(path)).get("tracks", {}) if os.path.exists(path) else {}
        ndone = sum(1 for t in tracks if str(t["num"]) in pt)
        kind = "tracks" if tracks else "whole-show"
        rows.append((st, show["slug"], kind, ndone, len(tracks)))
        if args.write:
            show["processing_status"] = st
            for t in tracks:
                if str(t["num"]) in pt:
                    t["processed"] = True
                else:
                    t.pop("processed", None)  # keep it accurate, no stale flags
    print(f"{'STATUS':17s} {'KIND':10s} {'DONE':>7s}  SLUG")
    print("-" * 70)
    for st, slug, kind, nd, nt in rows:
        cnt = f"{nd}/{nt}" if nt else "—"
        print(f"{st:17s} {kind:10s} {cnt:>7s}  {slug}")
    print("\n" + "  ".join(f"{k}: {v}" for k, v in sorted(tally.items(), key=lambda x: order.get(x[0], 9))))
    if args.write:
        json.dump(data, open(data_path, "w"), indent=2, ensure_ascii=False)
        open(data_path, "a").write("\n")
        print(f"\nwrote processing_status (+ per-track processed) to {data_path}")
    else:
        print("\n(report only — pass --write to persist into recordings.json)")


def cmd_version_map(args):
    """Archive-wide view of which workflow version(s) are on each show's
    tracks — the source of truth for reprocessing triage. A show's tracks can
    legitimately span more than one version: re-running a single track later
    updates only that track's `ver`/`chain` in the sidecar and leaves the rest
    alone (see AUDIO_PROCESSING.md's provenance "merge, don't overwrite"
    note), so a show is not "done" in one uniform sense — it's done per-track.
    --version N lists every track anywhere in the archive still on that exact
    version, for finding reprocessing candidates without opening every show."""
    proc_dir = os.path.join(ROOT, "data", "processing")
    data = json.load(open(os.path.join(ROOT, "data", "recordings.json")))
    titles = {show["slug"]: {str(t["num"]): t["title"] for t in (show.get("tracks") or [])}
              for show in data["shows"]}
    sidecars = sorted(f[:-5] for f in os.listdir(proc_dir) if f.endswith(".json"))

    if args.version is not None:
        hits = []
        for slug in sidecars:
            prov = json.load(open(os.path.join(proc_dir, f"{slug}.json")))
            for num in sorted(prov.get("tracks", {}), key=int):
                if str(prov["tracks"][num].get("ver")) == str(args.version):
                    hits.append((slug, num, titles.get(slug, {}).get(num, "?")))
        print(f"{len(hits)} track(s) currently on workflow v{args.version}:\n")
        for slug, num, title in hits:
            print(f"  {slug}  track {num:>2} — {title}")
        return

    rows, totals = [], {}
    for slug in sidecars:
        prov = json.load(open(os.path.join(proc_dir, f"{slug}.json")))
        vers = {}
        for t in prov.get("tracks", {}).values():
            v = t.get("ver", "?")
            vers[v] = vers.get(v, 0) + 1
            totals[v] = totals.get(v, 0) + 1
        rows.append((slug, vers, len(vers) > 1, len(prov.get("tracks", {}))))

    if args.only_mixed:
        rows = [r for r in rows if r[2]]
        if not rows:
            print("No shows have mixed workflow versions across their tracks.")
            return

    print(f"{'SLUG':45s} {'TRACKS':>6s}  VERSIONS")
    print("-" * 90)
    for slug, vers, mixed, n in sorted(rows, key=lambda r: (not r[2], r[0])):
        summary = ", ".join(f"v{k}: {c}" for k, c in sorted(vers.items(), key=lambda x: str(x[0])))
        flag = "  ⚠ MIXED" if mixed else ""
        print(f"{slug:45s} {n:>6d}  {summary}{flag}")

    print(f"\nArchive-wide track totals: "
          + ", ".join(f"v{k}: {c}" for k, c in sorted(totals.items(), key=lambda x: str(x[0]))))
    if not args.only_mixed:
        nmixed = sum(1 for r in rows if r[2])
        print(f"{nmixed} show(s) have more than one workflow version across their tracks.")


def main():
    ap = argparse.ArgumentParser(description="Audio processing workflow engine.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("diagnose")
    d.add_argument("input")
    d.add_argument("--artist", choices=list(ARTIST_TARGET))
    d.add_argument("--target", type=float)
    d.add_argument("--spectrograms", action="store_true",
                   help="also write a spectrogram PNG per track (visual QA for "
                        "suspect tapes: dropouts show as vertical stripes)")
    d.set_defaults(func=cmd_diagnose)

    pl = sub.add_parser("plan", help="dry run: per-track normalization decisions "
                                     "(linear / reduced target / applause limiter) "
                                     "without writing any audio")
    pl.add_argument("input")
    pl.add_argument("--artist", choices=list(ARTIST_TARGET))
    pl.add_argument("--target", type=float)
    pl.add_argument("--eq", help="literal corrective-EQ chain that process would use "
                                 "(plan measures the post-EQ signal, like process does)")
    pl.add_argument("--transient-cap-over-applause",
                    dest="transient_cap_over_applause",
                    action="store_true", help=TCAP_OVER_APPLAUSE_HELP)
    pl.add_argument("--transient-cap", dest="transient_cap", action="store_true",
                    help="opt in to the v8 sparse-transient cap (see WORKFLOW_VERSIONS[8]); "
                         "plan shows which tracks would qualify and their predicted "
                         "cap depth/engagement")
    pl.add_argument("--transient-cap-exclude", dest="transient_cap_exclude", default="",
                    help="comma-separated track numbers to keep out of the cap "
                         "(same veto process honors)")
    pl.add_argument("--transient-cap-partial", dest="transient_cap_partial", default="",
                    help="comma-separated track numbers allowed PARTIAL capping: a "
                         "track needing > 6 dB of recovery gets the full 6 dB "
                         "attenuation and lands honestly short of target instead of "
                         "declining — Rene's explicit per-track opt-in, never automatic")
    pl.add_argument("--transient-cap-force", dest="transient_cap_force", default="",
                    help="comma-separated track numbers where Rene, AFTER LISTENING, "
                         "overrides the sparsity gate (and any listen-flags) for that "
                         "track — his ears outrank the calibrated gate; recorded in "
                         "provenance")
    pl.add_argument("--transient-cap-max-gr", dest="transient_cap_max_gr", default="",
                    help="comma-separated track:dB pairs (e.g. '8:8.65') raising the "
                         "6 dB attenuation ceiling for ONE track — an explicit, "
                         "recorded exception after a loudness-matched listening test, "
                         "never a way to change the archive-wide policy; every capped "
                         "track's provenance always records the ceiling that was in "
                         "effect (policy_max_gr_db) and flags an override when this "
                         "is used")
    pl.set_defaults(func=cmd_plan)

    p = sub.add_parser("process")
    p.add_argument("input")
    p.add_argument("output")
    p.add_argument("--target", type=float, required=True)
    p.add_argument("--hpf", nargs="?", const=HPF_DEFAULT_HZ, type=float, default=None,
                   metavar="FREQ",
                   help=f"high-pass at FREQ Hz (default {HPF_DEFAULT_HZ:g} Hz when "
                        "given with no value — DC/subsonic rumble only). 80 Hz sits "
                        "close enough to the guitar's 82 Hz low E to thin acoustic "
                        "guitar, so reaching up that high needs an explicit "
                        "frequency, e.g. --hpf 80, never the bare flag's default")
    p.add_argument("--lpf", action="store_true",
                   help=f"low-pass at {LPF_DEFAULT_HZ:g} Hz; automatically clamped "
                        "below the source's own Nyquist frequency (with a printed "
                        "note) instead of silently applying a no-op filter on a "
                        "low-sample-rate source")
    p.add_argument("--notch", nargs="?", const=NOTCH_DEFAULT_HZ, type=float, default=None,
                   metavar="FREQ",
                   help=f"narrow mains-hum notch at FREQ Hz (default {NOTCH_DEFAULT_HZ:g} "
                        "Hz -- US mains -- when given with no value; pass 50 for a "
                        "50 Hz-mains recording). Genuinely narrow (a few Hz wide), "
                        "unlike the old two-octave-wide cut this replaces")
    p.add_argument("--notch-harmonics", dest="notch_harmonics", type=int, default=0,
                   help="also notch this many harmonics above --notch's fundamental "
                        "(0, the default, = fundamental only; e.g. 2 adds narrow "
                        "notches at 2x/3x as well) — opt in only when a harmonic is "
                        "actually visible/audible on that recording, not by default")
    p.add_argument("--eq", help="literal ffmpeg corrective-EQ chain applied before "
                                "loudnorm (e.g. de-mud + presence + air for a muffled tape); "
                                "recorded per-track in provenance")
    p.add_argument("--pre-edits", dest="pre_edits",
                   help="non-standard manual edits already applied in Audacity before "
                        "this run (e.g. 'noise reduction (Audacity, whole show)'); "
                        "recorded show-level in provenance and shown on the site")
    p.add_argument("--slug", help="write provenance sidecar for this show slug")
    p.add_argument("--provenance-out", dest="provenance_out", default=None,
                    help="write the provenance sidecar to this path instead of "
                         "data/processing/<slug>.json. Required for loudness-variant "
                         "renders: the default path MERGES into the archive's own "
                         "sidecar, so a variant render would silently overwrite the "
                         "-20 archive's provenance with the variant's numbers.")
    p.add_argument("--transient-cap-over-applause",
                   dest="transient_cap_over_applause",
                   action="store_true", help=TCAP_OVER_APPLAUSE_HELP)
    p.add_argument("--transient-cap", dest="transient_cap", action="store_true",
                    help="opt in to the v8 sparse-transient cap for tracks whose own "
                         "sparse musical transients set the ceiling (never default; "
                         "per-track eligibility gates still apply — see "
                         "WORKFLOW_VERSIONS[8])")
    p.add_argument("--transient-cap-exclude", dest="transient_cap_exclude", default="",
                    help="comma-separated track numbers to keep OUT of the cap even "
                         "when eligible (they take the normal linear/linear-reduced "
                         "path) — Rene's per-track veto")
    p.add_argument("--transient-cap-accept", dest="transient_cap_accept", default="",
                    help="comma-separated track numbers whose 'listen before shipping' "
                         "flags have been reviewed and accepted; without this, a "
                         "flagged track ABORTS the run instead of shipping unheard")
    p.add_argument("--transient-cap-partial", dest="transient_cap_partial", default="",
                    help="comma-separated track numbers allowed PARTIAL capping: a "
                         "track needing > 6 dB of recovery gets the full 6 dB "
                         "attenuation and lands honestly short of target instead of "
                         "declining — Rene's explicit per-track opt-in, never automatic")
    p.add_argument("--transient-cap-force", dest="transient_cap_force", default="",
                    help="comma-separated track numbers where Rene, AFTER LISTENING, "
                         "overrides the sparsity gate (and any listen-flags) for that "
                         "track — his ears outrank the calibrated gate; recorded in "
                         "provenance")
    p.add_argument("--transient-cap-max-gr", dest="transient_cap_max_gr", default="",
                    help="comma-separated track:dB pairs (e.g. '8:8.65') raising the "
                         "6 dB attenuation ceiling for ONE track — an explicit, "
                         "recorded exception after a loudness-matched listening test, "
                         "never a way to change the archive-wide policy; every capped "
                         "track's provenance always records the ceiling that was in "
                         "effect (policy_max_gr_db) and flags an override when this "
                         "is used")
    p.set_defaults(func=cmd_process)

    v = sub.add_parser("verify")
    v.add_argument("slug")
    v.add_argument("--drive", help="Drive Processed/ path (best-effort)")
    v.set_defaults(func=cmd_verify)

    rt = sub.add_parser("retag", help="retro-fit embedded tags onto published shows "
                                      "(container rewrite, audio MD5 preserved)")
    rt.add_argument("slug", nargs="?")
    rt.add_argument("--all", action="store_true", help="every track-listed show")
    rt.add_argument("--force", action="store_true",
                    help="re-tag even if already tags_embedded (after catalog edits)")
    rt.set_defaults(func=cmd_retag)

    vs = sub.add_parser("versions", help="describe what each workflow version does")
    vs.set_defaults(func=cmd_versions)

    h = sub.add_parser("history", help="per-track workflow version + process chain for a show")
    h.add_argument("slug")
    h.add_argument("--chains", action="store_true", help="also print the literal filter chain")
    h.set_defaults(func=cmd_history)

    st = sub.add_parser("status", help="per-show processing status (done/partial/redo/needs-processing)")
    st.add_argument("--write", action="store_true",
                    help="persist processing_status (+ per-track processed) into recordings.json")
    st.set_defaults(func=cmd_status)

    vm = sub.add_parser("version-map", help="archive-wide view of which workflow version(s) "
                                            "each show's tracks are on; flags shows whose tracks "
                                            "span more than one version")
    vm.add_argument("--only-mixed", action="store_true",
                    help="only list shows with more than one workflow version across their tracks")
    vm.add_argument("--version", type=int,
                    help="list every track archive-wide currently on this exact workflow version")
    vm.set_defaults(func=cmd_version_map)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
