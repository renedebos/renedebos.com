# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-08-11 · **Branch:** `main` — everything through `2b6d124` is
committed, pushed, and **live**, deploy green and spot-checked on
renedebos.com itself. One show's work is still in progress, uncommitted, in
the working tree (see below) — safe, nothing at risk, just not finished.

> **A real, archive-wide bug was found and confirmed today**: ffmpeg's
> `loudnorm` filter silently falls back to dynamic (frame-adaptive)
> normalization instead of true linear gain on some v≤5 `linear`/
> `linear-reduced` tracks — flattening dynamics/fades in violation of the
> archive's permanent linear-normalization policy, with zero warning in the
> logs. An audit across the whole archive confirms it's widespread: **10
> shows, 182 susceptible tracks, 99 (54%) exceed the pipeline's own 0.5 LU
> LRA-drift QA gate.** Two shows shipped as fixes today
> (`jerry-19-broadway-1999-11-15` new, `jerry-19-broadway-1999-10-25`
> reprocessed); **8 more confirmed-affected shows are still on the worklist,
> not started.**

## ✅ Done this session

### Shipped `jerry-19-broadway-1999-11-15` (new show, 14 tracks, v8)
Routine publish — 4 linear / 5 linear-reduced / 5 sparse-transient-cap.
Track 6 ("Scallywag") had a review-tier cap flag (engages 0.25s at 1:19.9),
listened to and accepted. Caught and fixed two title typos from fresh
export filenames that the `TITLE CHANGED` preflight didn't catch (it
doesn't flag case-only or article-only differences): track 2 "My Fathers
House" → "My Father's House", track 14 "I Thought I Was you" → "I Thought I
Was You" — both required renaming the actual R2 objects (FLAC+MP3) after
publish, since the mismatch wasn't caught until a post-publish cross-check
against the rest of the catalog.

### Committed a previously-uncommitted feature: timestamps in review flags
`scripts/audio_process.py` had a finished, already-tested change sitting
uncommitted from earlier in the session (visible in today's diagnose output
as "engages continuously for 0.25s **at 1:19.9**"): both transient-cap
review-tier flag types (the sizing-rejection case and the finalize
"engages continuously" case) now surface the flagged moment's own start
timestamp, so a listening review doesn't require scrubbing the whole track.
Shipped as `ba748f8`, standalone.

### Found and confirmed the loudnorm dynamic-fallback bug — audit complete
`scripts/audit_dynamic_fallback.py` (**still untracked — not committed**)
compares each susceptible track's raw source LRA against its recorded
published-output LRA; drift beyond the pipeline's own 0.5 LU QA tolerance is
strong evidence the track was silently rendered in dynamics-flattening mode
instead of true linear gain. Full results at `~/work/audit/results.json`.
All 8 currently-susceptible shows (every v≤5 `linear`/`linear-reduced`
track still in the catalog) have been audited — the audit itself needs no
further work, only triage/action on its findings.

| Show | Drifted / Susceptible |
|---|---|
| jerry-19-broadway-1999-10-25 | 22/24 — **fixed today** |
| jerry-19-broadway-1999-11-15 | 14/14 — fixed as a side effect of today's routine ship |
| jerry-19-broadway-1999-06-07 | 12/16 — **partially fixed** (12 tracks already v8 from 2026-08-10's scoped ship); 17 tracks remain v5, some of those also drifted |
| jerry-cafe-java-1999-03-25 | 5/9 — **reprocess in progress, not finished** (see below) |
| jerry-cafe-java-1999-04-29 | 13/21 — not started |
| jerry-cafe-java-1999-06-17 | 14/27 — not started |
| jerry-19-broadway-1999-08-23 | 13/20 — not started |
| jerry-cafe-java-1999-05-27 | 4/20 — not started, mild |
| mad-marin-brewing-co-1998-04-01 | 2/16 — not started, mild |
| mad-marin-brewing-co-1999-04-01 | 0/16 — **not actually affected**, no action needed despite being "susceptible" |

### Shipped `jerry-19-broadway-1999-10-25` — full v8 reprocess (26 tracks)
The first dynamic-fallback fix. 7 tracks qualify for sparse-transient-cap,
2 for applause-limiter, rest linear/linear-reduced. Two review-tier cap
flags (track 16 "Learn About Love" at 1:42.5, track 23 "El Paso" at 0:27.6)
listened to and accepted. A separate, non-blocking flag type (mid-song
high-crest window, track 21 "I Thought I Was You" at 2:05/2:35 — a
different classifier than the cap-engagement one, no accept/exclude
mechanism, purely advisory) was listened to and confirmed as genuine music.
`draft_tracks` also auto-resolved a title-variant disagreement on track 18
"Angel from Montgomery" correctly on its own (most-common spelling matches
9/10 prior appearances) — verified, no action needed. Updates-entry text
follows the established precedent from prior reprocess announcements
(technical, per-track LUFS/mode detail — confirmed against existing
entries, not simplified).

### Fixed "Good Life" → "The Good Life" archive-wide (4 tracks, 4 shows)
Same class of bug as the two title typos above — a fresh export filename
missing "The" wasn't caught by the `TITLE CHANGED` preflight, and the wrong
spelling had already propagated to 3 **already-published, already-live**
shows plus the in-progress cafe-java reprocess. "The Good Life" is correct
(10 prior appearances vs. 3 wrong + this one). Fixed in all 4 places: R2
objects renamed (FLAC+MP3) on `mad-sweetwater-2000-02-17`,
`mad-sweetwater-2000-10-17`, and `seanjerry-19-broadway-1999-12`;
`rename-track` used for the in-progress cafe-java reprocess's local files.
Shipped as part of `2b6d124`, verified live. **Left alone**: a 4th "Good
Life" entry under `singles` (artist `sean`, no venue/date) — plausibly a
genuinely different song, not verified either way.

## 🔧 In progress — uncommitted, in the working tree right now

**`jerry-cafe-java-1999-03-25`** — a `--tracks`-scoped v8 reprocess of 10 of
21 tracks (2,3,4,5,6,7,8,9,18,21), rendered locally
(`~/work/jerry-cafe-java-1999-03-25/out/`), **not yet published** (no R2
upload, `recordings.json` untouched). This predates today's session — found
mid-session as leftover state, and its title fix (`rename-track` to "The
Good Life" on track 7) was applied today, but the reprocess itself was
deliberately **not** carried forward into either of today's ships to avoid
bundling unreviewed work. `git status` right now shows exactly two modified
files: `data/processing/jerry-cafe-java-1999-03-25.json` and
`data/peaks/jerry-cafe-java-1999-03-25.json` — both local-only render
provenance, safe, not live. To finish: check for any unresolved review-tier
flags in `~/work/jerry-cafe-java-1999-03-25/tracks/normalization_plan.txt`,
then `python3 scripts/publish_show.py publish jerry-cafe-java-1999-03-25
--transient-cap [--transient-cap-accept ...]`.

## 🔜 Next session

### 1. Eight more dynamic-fallback-affected shows — worklist above
Priority by drift severity: `jerry-cafe-java-1999-04-29` (13/21) and
`jerry-19-broadway-1999-08-23` (13/20) are the worst untouched shows;
`jerry-19-broadway-1999-06-07`'s remaining 17 v5 tracks need a decision on
whether to finish the show to full v8 or leave the untouched tracks as-is
(the original 2026-08-10 scoped ship was based on loudness-gap candidacy,
not on this bug — some of those 17 may need reprocessing for this reason
even though they weren't cap candidates). `jerry-cafe-java-1999-05-27` and
`mad-marin-brewing-co-1998-04-01` are milder (4/20, 2/16) — lower priority.
`mad-marin-brewing-co-1999-04-01` needs no action (0/16 drifted). Same
runbook each time: `prepare` → diagnose review → publish → metadata →
build → ship, same as today's two shows.

### 2. Finish `jerry-cafe-java-1999-03-25`
See "In progress" above — closest to done, should probably go first.

### 3. `codex-notes.md` and `scripts/audit_dynamic_fallback.py` still untracked
Neither is committed. The audit script is genuinely useful ongoing tooling
(needed again for future re-audits or to verify the remaining 8 shows after
they're fixed) — worth committing at some point, just wasn't asked for
today. `codex-notes.md` is an external review tool's scratch output, not
Rene's own notes — treat as a source of findings to verify, not committed
project documentation (see memory).

### 4. A 4th "Good Life" entry, unverified
Under `singles`, artist `sean`, no venue/date — left untouched since it may
be a genuinely different song from "The Good Life." Worth a look if Rene
knows offhand.

### 5. Carried from before, still true
- Sixteen shows remain on the older transient-cap-candidate worklist from
  2026-08-10 (separate from the dynamic-fallback list above — some overlap,
  since a full reprocess picks up both fixes at once). Not re-enumerated
  since totals will have shifted after today's and future dynamic-fallback
  fixes.
- `jerry-19-broadway-1999-06-07`'s stray R2/Drive objects from the
  2026-08-10 title fix — still Rene's manual `rclone delete`, not urgent.
- Louder-playback derivative — still deferred, no A/B evidence, client-side
  toggle is the recommended direction whenever picked up.
- "Blind Man" gap on `jerry-19-broadway-1999-02-01` track 10 — needs a
  future manual Audacity look, shipped as-is with `dropouts: true`.
- `drum-control` (codex-notes.md proposal) deliberately not built — needs
  its own decision + A/B evidence.

## Gotchas learned this session
- **A generated show page can silently absorb unrelated leftover local
  state.** `scripts/build.py` regenerates every page from whatever's
  currently in `data/`, so an in-progress, unreviewed reprocess sitting in
  the working tree (the cafe-java partial reprocess above) gets baked into
  that show's page even though it was never published. Caught by checking
  `git status` before every commit and `git stash push -u -- <specific
  files>` around the build when unrelated local changes are present, then
  restoring them after. Do this every time uncommitted files predate the
  current task, not just when they look obviously unrelated.
- **The `TITLE CHANGED` preflight has a real gap**: it doesn't catch
  case-only or leading-article-only differences ("you" vs "You", "Good
  Life" vs "The Good Life"). Three separate instances of this hit today,
  one already live in three published shows. Cross-reference every fresh
  title against the rest of the catalog by eye, don't rely on the flag
  alone — especially for short/common words where a typo reads as
  plausible on its own.
- **A `--tracks`-scoped review-tier flag list can grow between diagnose-time
  and publish-time.** `jerry-19-broadway-1999-10-25`'s publish run surfaced
  a flag on track 21 that wasn't in the original `normalization_plan.txt` —
  a different, non-blocking classifier (mid-song high-crest window) that
  doesn't require `--transient-cap-accept`. Don't assume the flags you
  reviewed at diagnose time are the complete set; check the actual publish
  log too.

## Durable facts (don't undo)
- **v8 now covers fourteen shows** (twelve from before, plus
  `jerry-19-broadway-1999-11-15` new and `jerry-19-broadway-1999-10-25`
  reprocessed today). `jerry-cafe-java-1999-03-25` will be the fifteenth
  once its in-progress reprocess ships.
- **The dynamic-fallback bug is real and confirmed, not speculative** — the
  0.5 LU LRA-drift signal is the pipeline's own pre-existing QA tolerance,
  not a new invented threshold. Treat every remaining v≤5
  `linear`/`linear-reduced` track as suspect until reprocessed or
  positively cleared by the audit (like `mad-marin-brewing-co-1999-04-01`).
- **`--tracks` scoped publishing and `rename-track` remain first-class
  paths** — used repeatedly today without issue.
- **Linear-normalization policy, as amended for v8** (see `CLAUDE.md`):
  loudnorm/ebur128 are measurement-only since workflow v6; gain is always
  applied via a plain `volume` filter; a millisecond-scale transient cap is
  sanctioned (opt-in, tiered gates, 6 dB hard ceiling on actual attenuation,
  full listening-evidence trail); sustained/dense limiting of repeatedly-
  loud material is still banned with no exceptions and no evidence exists
  for it.
- `updates[]` is a dated changelog and should read as historically accurate
  to what was true *at the time* — don't retroactively rewrite entries to
  match a later wording standard.
- **`rclone delete` against `r2:` is now agent-executable** (Rene lifted the
  hard block 2026-08-11, pre-approved in `.claude/settings.local.json`) —
  clean up stale R2 leftovers directly instead of handing Rene commands.
  Still confirm with Rene before deleting anything on `gdrive:` (source of
  truth). (`rclone moveto`/`copyto` for renames remain fine, used freely.)

## Reference
Runbook: `CLAUDE.md` → "Publishing a Split Show". Technical record:
`WORKFLOW_VERSIONS[8]` in `audio_process.py`. Dynamic-fallback bug
background: docstring of `scripts/audit_dynamic_fallback.py` (untracked).
External review scratchpad: `codex-notes.md` (untracked, not Rene's notes —
verify before acting; also where the `drum-control` proposal lives).
