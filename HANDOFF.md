# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-08-10 · **Branch:** `main` — everything below is committed,
pushed, and **live** (`73eb716`), deploy green and spot-checked on
renedebos.com itself.

> **The archive-wide v2→v8 rollout is complete.** Every show that needed
> reprocessing off an older workflow is done — `jerry-19-broadway-1999-03-29`
> was the last one still on the original engine. Four shows have now been
> reprocessed as voluntary opt-ins (already on a modern-enough workflow,
> just not transient-cap) — `mad-sweetwater-1999-05-18` (v5→v8),
> `jerry-19-broadway-2001-01-08` (v7→v8), `jerry-cafe-java-1999-04-08`
> (v4→v8), and `jerry-19-broadway-1999-02-01` (v5→v8) — an ongoing "does
> this show benefit from the cap?" pass over the rest of the archive.
> **Nothing is outstanding — all eleven v8 shows are fully confirmed
> end-to-end**, including the two stray Drive `Processed/` "Angel of
> Montgomery" leftovers, which Rene has since cleaned up by hand.

## ✅ Done across the last three sessions

### Eleven shows now carry workflow v8 (`sparse-transient-cap`)
In ship order: `mad-cafe-java-1999-09-09`, `jerry-19-broadway-2001-01-15`,
`mad-sweetwater-2001-01-06`, `mad-new-georges-1999-10-13`,
`seanjerry-19-broadway-1999-12`, `mad-4th-street-tavern-1999-05-01`,
`jerry-19-broadway-1999-03-29`, `mad-sweetwater-1999-05-18`,
`jerry-19-broadway-2001-01-08`, `jerry-cafe-java-1999-04-08`,
`jerry-19-broadway-1999-02-01`. Each got the same treatment: prepare →
diagnose → cross-reference every title drift against the whole catalog
before correcting it → transient-cap plan preview → Rene confirms any
review-tier tracks by ear (timestamps recorded in that show's `updates[]`
note) → publish → R2 reconcile → Drive backup → metadata →
description/updates/`history.html` → build → commit → push → spot-check
live. `history.html`'s "Week fourteen" section has one bullet per show.

`jerry-cafe-java-1999-04-08` (v4→v8) and `jerry-19-broadway-1999-02-01`
(v5→v8, whole-show NR carried over) shipped this session. The Broadway
show also picked up: an explicit `--transient-cap-max-gr` exception on
"Hello in There" (6.2 dB, just over the standard 6 dB ceiling, reaching
−20.9 instead of −26.2); two flagged moments confirmed as non-defects by
Rene ("Daddy"'s mid-song high-crest window is mic contact noise, capped
along with the track; "Everything Reminds Me of You"'s suspected click is
an audience clap); and a genuine unresolved dropout on "Blind Man" (real
gap in the tape, can't be fixed by processing) — tagged `dropouts: true`
and documented on the show page rather than silently shipped.

`jerry-19-broadway-2001-01-08` (v7→v8, 2026-08-10) was the largest
review-tier batch yet — 9 of 30 tracks needed a listen before shipping, all
confirmed as legitimate music, plus one (`The Wind`) opted into partial
capping after confirming its loud moments are music too (needed 8.2 dB of
recovery, over the 6 dB hard cap, so it lands honestly at −22.65 LUFS
instead of −20). Its Drive `Processed/` folder also turned up 30 stale
old-named MP3s (dated 2026-06-28, from a pre-v7 processing generation,
prefixed `JerryHannan - 19 Broadway 2001-01-08 - `) sitting alongside the
fresh output — **not caused by a title change this time**, just an old
leftover that had never been cleaned up. Worth eyeballing Drive
`Processed/` on every reprocess going forward, not only ones with a
filename-driven title correction (see gotcha below).

### Publish-pipeline hardening — built and validated live across 6 real shows
All in `scripts/publish_show.py`, all proven against genuine production
defects (never a false positive):
1. **Title preflight at `prepare` time** — cross-references every track's
   fresh export filename against every prior appearance of that title
   anywhere in the archive before flagging a mismatch, so "is this a real
   correction or a mechanical filename guess" has an answer before Rene
   even looks at the diagnose report.
2. **Exact R2 reconciliation, not a bare count** — named missing/obsolete
   diffs for both FLAC and MP3, collected across *both* extensions before
   raising once (fixed after the first live test raised on FLAC, got
   "fixed", then immediately hit the MP3 mismatch it could have caught in
   the same pass — see `reconcile_r2()`).
3. **Stale-`out/` cleanup** before every render+upload — the direct fix for
   last session's "deleted R2 files keep coming back" bug class.
4. **Stale-`tracks/`-destination cleanup** (`fetch_tracks()` now always
   `rmtree`s its destination first) — same bug class, found again on
   `jerry-19-broadway-1999-03-29` (a stray `prepare` retry left 2 old-named
   files sitting in the local tracks dir, silently inflating the count).

### New corrective-EQ badge
Traced a real gap: the docstring for `pre_edits` provenance anticipated an
EQ badge, but `fragments.py` never actually rendered one — a `--eq`-treated
show (`mad-sweetwater-2001-01-06`) had no visible marker distinguishing it
from a plain reprocess. Added `_eq_badge()`, wired into both the status
line and the Technical Data table, scanned the whole archive first to
confirm only that one show was affected before shipping.

### Sitewide loudness-normalization text cleanup
Rene caught mismatched/misleading text across the site (prompted by the
1999-12 show's tracks showing raw `<span style=...>` HTML literally instead
of rendering — that specific bug got fixed, then the broader question led
here). A second opinion (Codex) sharpened the diagnosis further — see below.
- **`fragments.py`**: the Technical Data head line and the status blurb now
  *derive* their claims from each track's own recorded filter chain, never
  from a blanket string — fixes a real bug where the sidecar's `"tool"`
  field said `"ffmpeg loudnorm"` even for workflow v6+ tracks, which
  actually render gain with a plain `volume` filter (loudnorm/ebur128 are
  measurement-only since v6) — the exact dynamic-sounding attribution the
  archive's own linear-normalization policy exists to avoid. Also: LUFS is
  now labeled explicitly as a *target*, not an achieved guarantee (some
  tracks land under it by design — the whole point of the 6 dB cap), and
  transient-cap/applause-limiter counts are tallied live, not hand-typed.
  Correctly handles a mixed-version show (per-track `chain`/`ver` is
  authoritative, never the sidecar's last-run-only `workflow_version`) —
  no such show exists yet, but the derivation is correct by construction
  either way, unlike the backfill approach originally considered.
- **`audio_process.py`**: stopped writing the misleading `"tool"` field
  going forward (nothing else read it once the generator derives instead).
- **`data/recordings.json`**: stripped the redundant, occasionally-stale
  "−20 LUFS" number out of 11 show `description` fields (the generated
  tech-data table is the single source of truth for achieved values now);
  **`updates[]` changelog entries deliberately left untouched** — they're a
  dated historical record of what was said/done at the time, not living
  documentation, so rewriting them to a new phrasing standard would make
  them less honest, not more.
- **`scripts/content/process.html`**: the public explainer no longer claims
  "no EQ" (false since corrective-EQ restoration shows exist), explains
  loudnorm's measure-only role since v6, and labels −20 LUFS as a target.
- Committed together with the `mad-sweetwater-1999-05-18` ship in `227ea3b`.

## 🔜 Next session

### 1. Louder-playback derivative — researched 2026-08-09, still deferred
Rene asked whether the archive should offer a louder stream (~−16 LUFS)
alongside the current ~−20 LUFS masters, since −16 would clip on many
tracks without real limiting. Ran a preliminary feasibility scan off
existing provenance (no audio touched, no files rendered):

| Peak reduction needed for −16 @ −2 dBTP | Tracks | Share |
|---|---|---|
| Fixed gain only | 4 | 0.6% |
| ≤1 dB | 12 | 1.8% |
| 1–3 dB | 79 | 11.6% |
| 3–6 dB | 453 | 66.6% |
| >6 dB | 132 | 19.4% |

Median required peak reduction: 4.70 dB. **Conclusion: a stored −16 LUFS
derivative would require sustained (not just isolated-transient) limiting
on the large majority of the archive — that's functionally the same
unproven territory as the `drum-control` proposal below, just reached from
a different direction, and it doesn't have the two-show blind-A/B evidence
that justified transient-cap.**

**Recommended direction instead: client-side "Louder playback" toggle**,
not a second stored master. A Web Audio gain+compressor chain applied only
at playback time — nothing written back to any file, downloads stay the
honest archival versions, fully reversible, doesn't reopen the sustained-
limiting policy question at all. Checked the actual codebase: playback
currently runs through plain `<audio>` elements (`scripts/player.js`), with
`wavesurfer.js` as a separate layer for the waveform track rows — a full
implementation would need to wire the gain/compressor chain into *both*
paths, not just one.

**Plan, if/when picked back up:**
1. Prototype (few hours, one sitting): `MediaElementSource → GainNode →
   DynamicsCompressorNode → destination` on the plain-`<audio>` path only,
   toggle UI, tested by ear on ~5 of the archive's most dynamic tracks
   (quiet solo acoustic, applause-heavy, sparse-transient, hand-drawn fade).
2. If that sounds good: wire into the `wavesurfer.js` path too, handle
   mobile Safari's AudioContext-unlock-needs-a-gesture quirk, seek/track-
   switch reconnection, saved preference, honest labeling ("Louder
   playback," never a specific LUFS claim since a browser can't guarantee
   that at the listener's ears). Coding is maybe a day and a half total;
   the real pacing constraint is Rene actually testing it on real devices
   (phone speaker, Bluetooth, AirPlay), not build time.
3. **Do not build a stored −16 derivative** unless this gets revisited with
   its own explicit decision + listening evidence, same gate transient-cap
   and `drum-control` are both held to.

### 2. "Blind Man" gap on jerry-19-broadway-1999-02-01 — needs a future Audacity look
Track 10 has a real gap in the tape around 3:10 that processing can't
repair (confirmed by Rene, not treated as a diagnose false-positive).
Currently shipped as-is with `dropouts: true` and a show-page note. If
Rene wants to attempt a manual fix later (e.g. a crossfade/patch in
Audacity), that's a fresh hand-edit + re-export + reprocess, same as any
other post-publish audio correction — not something to attempt from raw
DSP.

### 3. Everything else carried from before, still true
- Consider a `build_archive_zip.py` refresh (optional, whenever there's a
  batch of shipped shows to fold in) — now includes 11 v8 shows' worth of
  reprocessed audio since the last zip build.
- **Drive `Processed/` hygiene check is worth doing on every reprocess, not
  just ones with a title correction** — `jerry-19-broadway-2001-01-08`
  turned up 30 stale old-named MP3s with no title-change trigger at all,
  just an old pass that was never cleaned up. A quick `rclone lsf` count
  check on both FLAC and MP3 right after the Drive backup step (same
  pattern as the R2 reconciliation) would catch this without relying on
  noticing it by chance.
- `drum-control` (codex-notes.md proposal, for repeatedly-loud material like
  a dominant snare on every backbeat) is deliberately **not built** — needs
  its own decision + A/B evidence if it ever happens. The louder-playback
  feasibility scan above is more evidence *against* attempting it archive-
  wide, not for it.
- `/search/` index preload double-fetch check, still unverified (DevTools →
  Network, exactly one `search-index.json` request) — carried for several
  sessions now, low priority.

## Gotchas learned this session
- **Rename a corrected title's local file BEFORE the first `publish` call, not after it fails** — hit this twice in one session (`jerry-cafe-java-1999-04-08` and `jerry-19-broadway-1999-02-01`, both the same "Angel of/from Montgomery" typo). The `prepare`-time title preflight correctly flags a fresh export's filename drift; cross-referencing correctly identifies it as a typo vs. a real correction — but if the local `tracks/`/`out/` file isn't renamed to the established title right then, the first `publish` uploads under the wrong name, the R2 reconcile check aborts, and fixing it costs a full extra render-or-resume cycle plus a stray R2 duplicate that only Rene can delete (`rclone delete` is agent-blocked). The fix: the moment a title flag resolves to "keep the established spelling," rename the file immediately, before ever calling `publish` — not as cleanup afterward.
- **A count-only integrity check is much less useful than a named diff, and
  checking one extension at a time instead of both is the same mistake in a
  different shape** — `reconcile_r2()` had exactly this bug on its first
  live test (FLAC flagged, "fixed", then MP3 immediately flagged separately
  when both could've been caught in one pass). Fixed by collecting problems
  across both extensions before raising once.
- **Any local working directory that accumulates outputs across multiple
  attempts is a latent stale-file risk until something actively prunes
  it** — hit this twice more this session in a new shape: `fetch_tracks()`
  never cleared its destination before copying, so a failed/retried
  `prepare` could leave old-named stray files sitting alongside a fresh,
  correct download, silently inflating the expected count on the next run.
- **`pgrep -f` process-name matching can produce false negatives** — a
  grep-quoting/glob-expansion glitch showed "not running" twice this
  session while the process (and a child `rclone`) was actually alive.
  Prefer `ps aux | grep ... | grep -v grep` or `kill -0 <pid>` for a
  definitive check, or just trust the background-task completion
  notification instead of polling at all.
- **Python's stdout is block-buffered when redirected to a file** — a
  long-running `publish_show.py` process's own `print()` steps can sit
  unflushed in memory while a subprocess it launches (`draft_tracks.py`)
  writes straight through, making the log file's line order misleading
  about what's actually finished. Check the process is still alive
  (`ps`/`kill -0`), don't trust apparent step order in a still-running log.
- **`rclone delete` is hard-blocked for the agent by the permission
  classifier** — every R2 deletion this session had to go through Rene by
  exact copy-paste command.
- **A monitor's 30-minute timeout can fire on a genuinely-still-running
  background job** (Drive backup on a 22-track show ran past it) — that's
  a "re-arm and keep watching" situation, not a failure signal by itself;
  check the actual process before assuming anything went wrong.
- **A single `curl` cache-status check right after a deploy purge can be
  genuinely inconsistent, not just stale** — five checks on
  `jerry-19-broadway-2001-01-08` flip-flopped between the correct new
  content and stale pre-deploy content, all reporting `cf-cache-status:
  HIT`, before settling. That's normal multi-POP purge-propagation lag, not
  a broken deploy — confirm with several checks spaced ~30-45s apart before
  concluding anything is wrong.

## Durable facts (don't undo)
- **v8 now has eleven published shows** (see list above). Version-bump
  discipline (any cap threshold/semantics change = v9) is binding.
- **Linear-normalization policy, as amended for v8** (see `CLAUDE.md`):
  loudnorm/ebur128 are measurement-only since workflow v6; gain is always
  applied via a plain `volume` filter; a millisecond-scale transient cap is
  sanctioned (opt-in, tiered gates, 6 dB hard ceiling on actual attenuation,
  full listening-evidence trail); sustained/dense limiting of repeatedly-
  loud material is still banned with no exceptions and no evidence exists
  for it — see the louder-playback feasibility scan above, which is a
  fresh data point *against* ever attempting that without a real A/B pass.
- Modes stay exclusive — no stacking applause-limiter + cap without a new
  decision and listening evidence.
- `updates[]` is a dated changelog and should read as historically accurate
  to what was true *at the time* — don't retroactively rewrite entries to
  match a later wording standard, even when the wording genuinely improved
  (see the loudness-text cleanup above, which deliberately left `updates[]`
  alone and only touched the live `description` fields).

## Reference
Runbook: `CLAUDE.md` → "Publishing a Split Show" (+ the amended
linear-normalization section covering v8). Technical record:
`WORKFLOW_VERSIONS[8]` in `audio_process.py`. External review scratchpad:
`codex-notes.md` (untracked, not Rene's notes — verify before acting; also
where the `drum-control` proposal lives).
