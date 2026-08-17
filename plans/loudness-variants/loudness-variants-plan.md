# Loudness variants: Feature Proposal

Status: **both listening tests PASSED (2026-08-16). One variant, at −14 LUFS, cleared for the archive-wide render.**
Created 2026-08-16, when the client-side loudness phase of
`plans/player-consolidation/` was moved out of the browser.

> **Decisions taken 2026-08-16, after the first pilot.**
>
> 1. **One variant, not two.** Rene A/B'd −20 / −17 / −14 on
>    `jerry-19-broadway-1999-07-19`, loudness-matched, and heard no problem
>    with −14. Since −14 passes, −17 has no reason to exist: it would halve
>    nothing but add storage, render time, and a third choice in the UI. The
>    modes are **Archive (−20)** and **Loud (−14)**.
> 2. **The applause-limiter's precedence gets fixed** (§4a below) so the 42
>    applause-limited tracks in the archive can reach the loud target too.
> 3. **Hard-show check DONE and passed** —
>    `mad-cafe-java-1999-09-09` (§3b). 99.7% of the archive needs less
>    processing than what was approved there, so no shave ceiling is needed.
>
> The loudness-matched A/B is the load-bearing detail in decision 1: it
> strips out the "louder always sounds better" bias, so a pass there is a
> statement about processing damage, not about preferring loud. Any future
> re-test must be matched the same way.

## 1. Objective

Give visitors a louder way to hear the archive, without touching the
archival masters and without letting gain follow the music.

The archive is normalized to **−20 LUFS** — chosen for comfortable listening
on acoustic live recordings with wide intentional dynamics, not for
competitive loudness (see `CLAUDE.md`'s linear-normalization policy). That is
the right default and it is not changing. But −20 LUFS is quiet in a car, on
phone speakers, or against anything else in a browser tab, and a visitor has
no way to ask for more than their volume slider can give.

**Deliverable:** one additional pre-rendered variant of every curated
track at −14 LUFS, selectable in the player, with the archival −20 version
remaining the default and the download.

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
loudness values the engine cannot guarantee. With one variant it collapses
further, to **Archive / Loud**.

## 3. Step 1 — the listening test — DONE 2026-08-16, PASSED

Rendered `jerry-19-broadway-1999-07-19` (26-song solo Jerry set) from its
canonical hand-edited sources at −20, −17 and −14, and A/B'd all three at
matched playback position via a local three-way page. Files live in
`~/work/loudness-pilot/jerry-19-broadway-1999-07-19/{m20,m17,m14}/`; the
page and its measurement cache are beside them.

**Verdict: −14 sounds fine, loudness-matched. Ship one variant at −14.**

Measured cost, against the locally-rendered −20 control (22 forced tracks;
the four applause-limited ones are unforceable and act as controls):

| | −17 | −14 |
|---|---|---|
| Mean LRA change | −0.15 LU | −0.55 LU |
| Worst single track | −0.5 LU | −1.1 LU (Nicolai) |
| Tracks losing > 1 LU | 0 | 1 |
| Tracks within ±0.3 LU | 18 of 22 | 5 of 22 |
| Longest continuous cap engagement | 0.80 s | 1.00 s |
| Cap engagement | 1.1–2.1 % | 2.2–5.7 % |

Getting a *uniform* −14 required overriding the engine on every track:
`--transient-cap-force` on all 22 forceable tracks, plus
`--transient-cap-max-gr` on ten of them (6.45–8.75 dB against the 6 dB
policy ceiling). Provenance records each override honestly via
`policy_max_gr_db`. Those ten land at −14.4 to −15.3 rather than −14.0,
because gain is trimmed to honour the raised ceiling.

**Two measurement lessons worth keeping:**
- **Always compare against a locally-rendered control, never against
  `track-spec.json`'s stored `lra`.** A first pass used the stored value and
  manufactured two phantom findings — a 1.6 LU loss on Truck and an LRA
  *increase* on Why Don't We Get Drunk — both of which vanished against a
  proper control. The stored number comes from a different render at a
  different time; it is not a baseline.
- **LRA under-reports this kind of damage.** It is a percentile spread over
  3-second windows, so a 1-second continuous gain reduction is only three
  times shorter than the measurement window and barely moves the number.
  Engagement duration from the render log is the more sensitive signal.

### 3b. Step 1b — the hard-show check — DONE 2026-08-16, PASSED

`mad-cafe-java-1999-09-09` rendered at −14 against a locally rendered −20
control. **Rene listened loudness-matched and could not hear a difference.**
Same verdict as the pilot, at roughly double the processing depth.

What that verdict covers, measured:

| | Pilot (07-19) | Cafe Java |
|---|---|---|
| Cap engagement, median | 3.4 % | **5.8 %** |
| Cap engagement, max | 5.7 % | **10.4 %** |
| Deepest cap | 8.75 dB | **13.2 dB** |
| Mean LRA change | −0.55 LU | −0.68 LU |
| Worst LRA change | −1.1 LU | −1.1 LU |

**Coverage: 678 of 680 tracks (99.7 %) need less shaving than the 13.2 dB
just approved.** The only two beyond it are `jerry-19-broadway-2001-01-08` #8
"The Wind" (14.2 dB) and `jerry-19-broadway-2001-01-15` #26 "Dope World"
(13.6 dB) — 1.0 and 0.4 dB past the tested depth. **No shave ceiling is
needed**; the fallback contemplated below is not being taken.

Note the LRA/engagement divergence: Cafe Java is worked about twice as hard
as the pilot on engagement, and LRA barely moves (−0.68 vs −0.55). LRA is
too blunt to be the acceptance test for this mode. The ear was the test, as
planned.

**The A/B must be served as MP3, not FLAC.** The first build served 24-bit
48 kHz FLAC (41 MB/track) and Chrome on the Chromebook could not decode it in
real time — audible stutter on every file, every variant, matched or not,
which read convincingly as dropouts in the audio. The local server was not at
fault (210 MB/s measured), nor was the audio (a dip detector found identical
level dips in source, −20 and −14, to a tenth of a dB; `silencedetect` found
no mid-song gaps at all). Rene's observation that the live site was clean is
what identified it — the site streams MP3. Rebuild on the 320 kbps MP3s the
render already produces, and re-measure loudness on those, since MP3
encoding shifts true peak and the engine applies a small MP3-only gain trim.

### 3c. The original hard-show rationale (superseded by the result above)

The pilot show turned out to sit at the archive median (6.0 dB of shave
needed for −14, against an archive median of 6.1), so the verdict covers
the typical case properly. It does not cover the tail:

- **77 of 680 tracks (11 %) need deeper shaving than the pilot's deepest
  track** (8.75 dB); the archive maximum is 14.2 dB.
- `mad-cafe-java-1999-09-09` needs a *median* of 8.3 dB and a maximum of
  13.1 — its typical track is harder than the pilot's worst.
  `jerry-19-broadway-2001-01-15` is comparable (median 8.2, max 13.6).

So Cafe Java is being rendered at −14 and listened to before any campaign.
If it fails, the fallback is a shave ceiling (e.g. 10 dB) with tracks past
it landing honestly short, rather than abandoning the variant.

## 3c. The original step-1 instructions (kept for re-runs)

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

## 4a. Engine change — let applause tracks reach the loud target

**Approved in principle by Rene, 2026-08-16. Not yet built.**

**The problem.** 42 of 680 tracks (6 %) are `applause-limiter` tracks, and
they cannot reach the loud target at all. On the pilot show four of them
landed at −17.5 to −21.9 while everything around them sat at −14 — a 5–8 dB
dip mid-set. With two variants a −17 mode partly hid this; with one variant
it is the most audible defect in the feature, and it directly contradicts
the reason for wanting a uniform target.

**Why they stop short — worked example, Plastic Lemons.** Source is −23.6
LUFS with applause at 2:40–2:45 louder than the music. The engine pulls that
window down 3.6 dB, which makes a musical peak at −5.6 dB the new ceiling,
then applies 4.4 dB of linear gain to put that peak at `APPLAUSE_LIMIT_DB`
(−1.2). −23.6 + 4.4 = −19.2, exactly where it landed. **The applause is
already being tamed; the music's own peaks are what block the rest.**

**The change.** In `plan_track()`, the applause branch commits and returns —
`try_transient_cap()` is never offered the track. Let both run: tame the
applause, then treat the music's transients exactly as every other track's
are treated (which is what Rene just approved by ear).

**The trap, which the code already documents.** The sparsity gate reads the
music's near-peak density against the file's overall peak. When applause
tops the file that yardstick is set by the clapping, so the music's density
reads far too low — the render log's own caveat cites Truck at **1.6 %
source vs 12.3 % published**, an ~8× understatement. Plastic Lemons
currently reports 0.1 %, which would sail through the gate on a number known
to be wrong. So the change must **re-measure density on the applause-tamed
signal** and gate on that, not merely reorder the branches.

**The specific hazard this creates, and it must be handled explicitly:**
`Truck` on `mad-cafe-java-1999-09-09` is an applause-limiter track — and it
is also the canonical counterexample in `CLAUDE.md`, the dominant-snare
material the ban on sustained limiting exists to protect, with *no listening
evidence* behind it. Today the applause branch shields it by accident. The
moment that shield is removed, the archive's single most explicitly
protected track becomes eligible for capping. The re-measured gate should
decline it on its real 12.3 % density — but that must be **verified, not
assumed**, before this ships. If the corrected gate does not decline Truck,
the gate is wrong, not the policy.

### 4a-result — BUILT and ACCEPTED 2026-08-16

Implemented as **`--transient-cap-over-applause`** (opt-in, on both `plan` and
`process`; also folded into `recipe_signature()` so a resume cannot reuse audio
built the other way — emitted into the hash **only when the flag is on**, so
signatures for the existing archive stay byte-identical to what v8 wrote).

**Deviation from the spec above, deliberate: the treatments are either/or, not
stacked.** §4a said "tame the applause, *then* treat the music's transients."
The build offers the track to `try_transient_cap()` **first**, and on success
the cap plan *replaces* the applause plan outright; the applause branch only
commits if the cap declines. Two reasons. The cap's own limiter is a true-peak
limiter over the whole file, so a clap that out-peaks the music is caught by it
anyway — a preceding applause stage would be shaving something already handled,
twice. And stacking would mean the cap sizing its gain against an
already-modified signal, breaking the render-state/true-peak assertion chain
that proves what was rendered. Measured outcome is what §4a asked for either
way (the four tracks reach target), so the goal is met; the mechanism differs
from the sketch and this is the record of that.

**Measured on the two Cafe Java applause tracks at −14** (both **with
`--transient-cap-force`** — see below):

| | Engagement | Longest event | Reaches (forced) |
|---|---|---|---|
| Truck | **8.7 %** | **0.15 s** | −14.4 LUFS |
| Anna May | 4.2 % | 0.55 s | −14.4 LUFS |
| *(approved on this show, §3b)* | *5.8 % median, 10.4 % max* | *up to 0.70 s* | |

Both land inside the envelope Rene had already listened to and passed on the
same tape — Truck's longest engagement (0.15 s) is shorter than the 0.2 s
*auto* threshold, and its 8.7 % is below the 10.4 % he accepted elsewhere on
the show. **Rene accepted Truck at −14 on that basis without a further
listening test** (2026-08-16).

**The flag grants eligibility, not passage — this matters for the campaign.**
With `--transient-cap-over-applause` alone, all four applause tracks tested
**decline**, and they decline twice over, at two different gates in sequence:

1. **The 6 dB attenuation ceiling, first.** Reaching −14 needs 9.5 dB of
   capping on Truck and 11.8 dB on Anna May, both past `TCAP_MAX_GR = 6.0`.
   This is the gate that actually fires on a bare `--transient-cap-over-applause`
   run — so a campaign that forgets the `--transient-cap-max-gr` overrides
   never even reaches the engagement question.
2. **Engagement, once an override lifts that ceiling.** With
   `--transient-cap-max-gr 8:12,16:13` the tracks measure 9.3 % / 0.15 s and
   4.7 % / 0.55 s against `TCAP_REJECT_ENGAGE_PCT = 2.0`.

| Track | Engaged | Longest event |
|---|---|---|
| Truck (Cafe Java 08) | 8.7–9.3 % | 0.15 s |
| Anna May (Cafe Java 16) | 4.2–4.7 % | 0.55 s |
| Plastic Lemons (07-19 #09) | 3.9 % | 0.40 s |
| Kilkelly Ireland (07-19 #23) | 3.2 % | 0.45 s |

The engagement figure **moves with the max-gr allowance** — a larger allowance
trims less off the gain, so more of the track crosses the threshold. That is
why the ranges above are ranges: quote the number from the run's own log, not
from this table.

So the campaign must pass **`--transient-cap-max-gr` and `--transient-cap-force`
per track** on top of the flag — the same treatment the other 20 Cafe Java
tracks needed at −14. Nothing is waved through silently: reaching the loud
target on an applause track takes three explicit opt-ins and rests on Rene's
listening test, not on the gate.

**Two corrections to §4a's original reasoning, both found by measuring:**

1. **Applause does not top Truck's file.** Its music peak is −0.0 dB and it
   has *no applause regions at all* — its drums hit full scale in the source,
   which is why it cannot get loud. So the documented "1.6 % source vs 12.3 %
   published" gap is not the applause distorting the screen; it is that the
   12.3 % was measured on an already-limited copy where everything sits nearer
   the peak. The `density_ref` correction is real for tracks like Anna May
   (music peak −11 dB, applause 11 dB above) and a no-op for Truck.
2. **Left automatic, the change rewrites the archive.** At the ordinary −20
   target it moved Truck from applause-limiter −23.65 to sparse-transient-cap
   −20.0, and Anna May from −22.26 to −20.3. That is published audio changing
   on the protected track with no listening evidence. Hence the opt-in flag —
   verified both ways: without it the −20 render is unchanged, and
   non-applause tracks are byte-identical with the flag on or off.

**Scope of the Truck decision, stated precisely:** Truck is capped **only in
the opt-in loud variant**. The −20 archive still renders it at −23.65 through
the applause path, untouched. `CLAUDE.md`'s ban on capping repeatedly-loud
material stands for the archive; the exception is the loud variant alone.

## 4. Step 2 — the render campaign

### 4-decisions — SETTLED 2026-08-17

**Target: −14 LUFS, one variant.** (§3, §3b.)

**Which tracks: all 680.** The "only tracks that gain ≥ 1 dB" filter is moot.
The archive is uniformly −20.0 LUFS (median; min −24.5), so every track gains
at least 3 dB and 643 gain ≥ 6 dB. There is no subset where "Louder" would be
inaudible, so there is no honest reason to omit any track.

**Source: the published −20 archive FLACs, not the original hand-edited
source.** Rene's call, and the A/B below cleared the one objection to it.

- For the 423 `linear` / `linear-reduced` tracks this is *provably identical*
  to rendering from source: the published file is the source times one
  constant, and FLAC is lossless.
- For the other 257 it means two limiter passes instead of one. Total
  attenuation is the same either way — a tcap track at −20/−1 dBTP needs
  ~6 dB more shave to reach −14, which is the same total as the ~11 dB one
  pass from source would have applied.
- **The decisive argument is not cost, it is correctness.** Re-staging 30
  shows from Drive is precisely the operation that has failed before: the
  `prepare` run that destroyed hand-edited fades (2026-08-11) and the export
  that drifted back to "I Need a Lover" after "Hear Me" had been published.
  Deriving from the archive makes it structurally impossible for the variant
  to disagree with the archive — same edits, same NR, same fades, guaranteed
  — and makes the variant reproducible by anyone from public files.
- Note this also means the shave figures here are *incremental*. From source
  the required attenuation is larger and far more than 151 tracks would need
  a max-gr override.

**Format: MP3 only** (~5.6 GB added; FLAC too would be ~30.7 GB). The variant
is a streaming convenience; downloads stay archival at −20. This also matches
the finding that 24-bit FLAC is too heavy to stream reliably on Rene's
Chromebook and reads as dropouts.

### 4-ab — the double-limiting A/B, PASSED 2026-08-17

The one real objection to rendering from the archive was that a second
limiter pass, acting on peaks the first pass had already flattened into
plateaus, might behave differently from one pass on raw spikes. Tested on the
two heaviest cap cases of the hardest show, `mad-cafe-java-1999-09-09` tracks
21 (Rocky Road, 13.2 dB) and 22 (The Kiss / Da Da Da, 10.7 dB — the one with
the hand-drawn fade). Blind, loudness-matched, synced, as MP3.

The from-source side was **byte-identical to the approved pilot render**
(md5 `ece83ce0`, `fa07d2ad`), so the comparison was against the genuine
article rather than a re-approximation.

| | 21 src → arch | 22 src → arch |
|---|---|---|
| Cap engagement | 5.8 % → **7.1 %** | 7.2 % → **8.2 %** |
| Longest event | 0.55 s → **0.65 s** | 0.30 s → **0.35 s** |
| Near-peak density | 0.3 % → **2.8 %** | 0.2 % → **2.6 %** |
| LRA (MP3) | 11.5 → 11.4 LU | 15.8 → 15.6 LU |

**Rene heard no difference on either track, fade included.**

**Read the near-peak number correctly.** Its ~9× jump is mostly a *yardstick*
effect, not added density: the first pass cut the tallest peaks down, so more
of the file now sits within 3 dB of the (now lower) maximum. The music did not
get denser. Engagement and longest-event are the numbers that reflect genuinely
more limiting, and LRA — which barely moved, on a 15.8 LU track — is the one
that says the dynamics survived.

**Operational consequence: the sparsity screen stops being meaningful on
archive input.** It exists to catch persistently-loud material (the Truck
case) and it cannot do that when its reference has been pre-flattened; every
track will read artificially dense. Both A/B renders tripped it and needed
`--transient-cap-force` that the from-source renders did not.

### 4-gating — how the campaign is gated

Rene's instruction (2026-08-17): render everything at −14 from the archive and
do not let the gates block. Adopted, with one qualification.

- **No blocking gates.** A gate overridden on all 680 tracks is not a gate; it
  is a habit of ignoring warnings. The sparsity screen in particular is
  measuring the wrong thing on this input (above).
- **But keep measuring.** Engagement, longest event and cap depth are computed
  during planning at no extra cost. Log them per track, render everything,
  then review the distribution across all 680 and **listen to the five worst
  outliers** before shipping. Rene has heard ~42 of 680; Cafe Java was the
  hardest show by *shave depth*, which is not the same as hardest by limiting
  behaviour. This is a spot-check on output, not a gate.
- **The −1.00 dBTP assertion is NOT in scope for "ignore the gates."** It
  deletes the output and aborts the run, and it is what stops clipped audio
  reaching the site. It stays, unconditionally.

### 4-open — still to settle

- **Naming and provenance.** Variants need their own R2 key convention and
  their own entries in `data/processing/<slug>.json` / `track-spec.json`, so
  `version-map` and `/archive-data/` stay honest. Provenance must record that
  the loud variant is **derived from the −20 archive**, not from source.
  This must not blur the archival provenance record.
- **Throughput.** There is no local copy of the archive and only ~17 GB free
  against a 25 GB archive, so the campaign must run **show by show**:
  download that show's FLACs, render, upload MP3s, delete. Measured R2
  download was ~26–60 KB/s single-stream and ~250 KB/s with
  `--multi-thread-streams 8`; at the latter the full archive is ~28 hours of
  transfer alone. Benchmark parallel settings before committing to a schedule.

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
