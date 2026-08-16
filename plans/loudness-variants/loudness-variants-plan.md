# Loudness variants: Feature Proposal

Status: **not started — the first step is a listening test, not code.**
Created 2026-08-16, when the client-side loudness phase of
`plans/player-consolidation/` was moved out of the browser.

## 1. Objective

Give visitors a louder way to hear the archive, without touching the
archival masters and without letting gain follow the music.

The archive is normalized to **−20 LUFS** — chosen for comfortable listening
on acoustic live recordings with wide intentional dynamics, not for
competitive loudness (see `CLAUDE.md`'s linear-normalization policy). That is
the right default and it is not changing. But −20 LUFS is quiet in a car, on
phone speakers, or against anything else in a browser tab, and a visitor has
no way to ask for more than their volume slider can give.

**Deliverable:** two additional pre-rendered variants of every curated
track, selectable in the player, with the archival version remaining the
default and the download.

## 2. The decision that shapes everything: offline, not Web Audio

The original design (player-consolidation §2's Loudness section, now
rejected) put a gain stage and possibly a limiter in the browser via Web
Audio. This plan renders variant **files** instead. The reasoning:

**The limiter already exists and is already trusted.** `audio_process.py`'s
transient-cap mode (workflow v8) was sanctioned on 2026-08-08 after
loudness-matched blind A/Bs on two independent shows, where Rene could not
hear the cap at up to 5.9 dB of recovery and measured LRA moved ≤ 0.3 LU. A
browser-side limiter would be new, untested code that cannot be auditioned
the same way.

**The headroom data rules out the simple client-side approach anyway.**
Across all 680 tracks (`assets/track-spec.json`'s `mp3TruePeak`):

| Flat boost | Tracks that can take it under −1 dBTP |
|---|---|
| +4 dB | 18 of 680 |
| +6 dB | 4 of 680 |
| none | 61 tracks already exceed −1 dBTP |

A single per-mode dB boost cannot work for this catalog. What is needed is a
per-track variable boost capped by that track's own headroom — which is
precisely the calculation `audio_process.py` already performs, with a hard
−1.00 dBTP post-render assertion that deletes the output and aborts on
failure.

**The hazards that disappear by going offline:** one lazily-created
`AudioContext` per document; resuming it synchronously from a user gesture;
`suspended`/`interrupted`/closed states; graceful degradation when Web Audio
is blocked, under the rule that *a loudness feature must never turn a
previously playable recording silent*; iOS Safari's Web Audio quirks; and
keeping the setting in sync across tabs and the popup.

**What it costs instead:** roughly 5.6 GB in R2 per variant (the entire MP3
set is 5.62 GB), about eight cents a month; a batch render across 680
tracks; provenance for each variant; and a reload-and-reseek when switching
mid-track rather than an instantaneous gain change.

**A design constraint this imposes, which turns out to be the design we
wanted:** pre-rendered files mean **discrete named modes**, not a continuous
slider. The mockup review had already landed on `Archive / Louder / Loudest`
for exactly the honesty reason — naming modes rather than promising output
loudness values the engine cannot guarantee.

## 3. Step 1 — the listening test (do this before anything else)

**Nothing else in this plan should be built until this is done.** No amount
of document review can answer whether −17 LUFS sounds right on a
fingerpicked Jerry Hannan verse. Concretely:

1. Pick one show with a mix of quiet and loud material. A show with a
   hand-drawn fade is ideal — that is the thing the linear-normalization
   policy exists to protect.
2. Render it at a candidate "Louder" target with the existing transient-cap
   engine. Suggested starting point: **−17 LUFS** (3 dB up), with **−14
   LUFS** as the "Loudest" candidate.
3. A/B it against the live version with `scripts/ab_compare.py`, which
   already switches between two versions of a track at the same playback
   position.

**What to listen for:** flattened fades, a fingerpicked verse squashed
against a strummed chorus, pumping on sustained material, and audible
limiting on any track where the recovery is large. The engine's three-tier
gating (auto / review / declined) and its 6 dB attenuation cap are the
safety barrier, but the ear is the acceptance test.

**Possible outcomes, all of them fine:**
- Sounds good at both targets → proceed to step 2 with those numbers.
- Good at −17, not at −14 → ship one variant instead of two.
- Too many tracks land short of target, or the cap is audible → the honest
  answer may be that this archive does not want a louder variant, and the
  feature stops here having cost one afternoon.

## 4. Step 2 — the render campaign (only after step 1 passes)

Open questions to settle **with** the pilot's evidence, not before:

- **Targets.** −17 / −14 are candidates, not decisions.
- **Which tracks get a variant.** Every track, or only those with enough
  headroom to gain ≥ 1 dB? A "Louder" mode that is inaudibly different on
  half the catalog is a worse experience than one that is honestly absent.
- **Tracks that decline the cap.** Some will land short of target. Does the
  variant ship at its honest reduced level, or not ship for that track?
- **Format.** MP3 only (streaming), or FLAC too? Downloads should almost
  certainly stay archival — the variants are a listening convenience, not a
  second master.
- **Naming and provenance.** Variants need their own R2 key convention and
  their own entries in `data/processing/<slug>.json` / `track-spec.json`, so
  `version-map` and `/archive-data/` stay honest about what is what. This
  must not blur the archival provenance record.

Mechanically the render reuses `batch_process.py` and the existing publish
verification (R2-MD5-vs-sidecar, the −1 dBTP assertion). It is compute time
plus review, not new engineering.

## 5. Step 3 — the player change (small, deliberately last)

- `assets/tracks.json` gains the variant keys per track. `mp3TruePeak`
  currently lives only in `track-spec.json`; whether it needs to join
  `tracks.json` depends on §4's answers.
- A three-way `Archive / Louder / Loudest` control. Per the mockup review it
  must be a real `<button>` with its current value in the accessible name
  and state, not a styled `<span>`.
- Switching sets a new source URL and re-seeks to the current position. The
  small audible hitch is the accepted cost of the offline approach.
- The setting persists, and a stored value is validated against the enum
  rather than trusted from `localStorage`.
- **Engine count is not a blocker.** Four of five surfaces already share
  `PlaybackController`; the `/player/` popup would need the same few lines.
  This is the whole reason the mini-player phase could be parked.

## 6. Rejected / out of scope

- **Client-side Web Audio gain or limiting** — §2.
- **Re-normalizing the archive louder.** The −20 LUFS masters are the
  archive. Variants are additions.
- **Any gain that follows the music.** `CLAUDE.md`'s ban on loudnorm dynamic
  mode and on sustained limiting of repeatedly-loud material applies to
  every variant exactly as it applies to the masters. The sanctioned
  exceptions remain the applause-limiter (v5) and sparse transient-cap (v8),
  under their existing per-track gating.
- **A continuous loudness slider** — §2.

## 7. Public-facing consequence

`/process/`'s "linear gain only… the dynamics of the room stay intact" claim
already needs a caveat once any transient-capped audio ships. A louder
variant makes that unavoidable: the page must state plainly what the
variants are, that they are additional renders rather than the archive, and
what was done to make them. Do not let the public page contradict the
archive's real provenance.

## 8. Review

Use the existing loop — `scripts/codex_review.sh` on this file, then
`/review-step` to verify findings and `/apply-review` to implement confirmed
ones.

**Cap it at two rounds.** This same loop ran twelve times on the mini-player's
ownership subsystem before being deliberately closed out. A review loop with
no exit condition will polish a document indefinitely.

And note what a review cannot do here: it cannot tell you how −17 LUFS
sounds. Step 1 is the real test of this plan. Prefer running the pilot and
revising this document from what it teaches over reviewing the document
harder.
