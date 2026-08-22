"""Workflow-version registry: WORKFLOW_VERSION (the current version number
every fresh render is stamped with) and WORKFLOW_VERSIONS (the human-
readable decode of what every past and current version's processing
actually did -- each processed track records its own `ver`/`chain`, so this
registry is how a number in provenance becomes a description). Moved out of
audio_process.py 2026-08-22 verbatim -- see CLAUDE.md's "Loudness policy"
section before touching anything here; any change to cap thresholds, gate
semantics, or the render chain is a NEW WORKFLOW_VERSIONS[N] entry, never a
silent edit to an existing version's behavior.
"""
from engine_constants import ARTIST_TARGET


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
                "quieter than plan predicted. The accepted render's gain/limit are "
                "persisted in a .v8state.json beside the output (the same file the "
                "transient cap uses, tagged with its mode; the name is historical) "
                "and a resume that cannot load it re-renders. Before that, a resumed "
                "applause render INFERRED its gain as out_I - in_I, which a limiter "
                "makes systematically wrong — the limiter has already pulled the "
                "transients down, so output loudness is not input + gain, and the "
                "recorded chain did not reproduce the bytes (measured on "
                "jerry-19-broadway-1999-10-25 trk 14: chain said volume=2.65dB, the "
                "render had applied ~2.67 dB). Audibly nothing; but provenance must "
                "be a recipe, not an estimate.",
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
                ".v8state.json beside the output, tagged with the mode that wrote it "
                "(v5 applause renders now use the same file); a resume that cannot "
                "load it, or loads one written by the other mode, or whose file fails "
                "the strict ceiling, re-renders instead of guessing "
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
