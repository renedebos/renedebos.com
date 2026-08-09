# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-08-09 · **Branch:** `main` — everything below is committed,
pushed, and **live** (`086ab8b`…`ceb5ab8`), deploys green and spot-checked on
renedebos.com itself.

> **Two shows now carry workflow v8 (`sparse-transient-cap`)**:
> `mad-cafe-java-1999-09-09` and `jerry-19-broadway-2001-01-15`. The second
> show's publish turned into a multi-hour saga — not because the audio engine
> is unreliable, but because of a real bug in the publish *plumbing*
> (stale local files silently resurrecting "deleted" R2 objects) compounded
> by several dead-end diagnoses before finding it. Root cause is now
> understood and documented below, plus a prioritized list of fixes for next
> time. The `/process/` public page also got the caveat sentence it was
> owed since Cafe Java shipped. **Nothing is outstanding — both shows are
> fully confirmed end-to-end** (R2 verified 0 mismatches, Drive backed up
> and checksum-matched, live and spot-checked).

## ✅ Done this session

### `jerry-19-broadway-2001-01-15` shipped as the second v8 show
21 of 31 tracks reached the full −20 LUFS target via the transient cap;
**Woman** stayed on the applause-only limiter (v5), untouched by the new
mode, same precedence rule as Cafe Java's Truck/Anna May. Four track titles
were corrected — **State Trooper → Highway Patrolman**, **Everything →
Everything Reminds Me of You**, **Four Leaf Clover Inn → The Barney Stone
Blues**, **Never Knew a Woman → Woman** — after the fresh hand-edit export
used different filenames than the catalog's established titles for those
four; each was verified by cross-referencing every prior appearance of the
title across the whole archive (`recordings.json`), not just accepted from
`draft_tracks`' mechanical filename-derived guess. `updates[]` entry +
folded into the existing "Week fourteen" `history.html` section (not a new
week — same feature, second show). Committed `ceb5ab8`.

### `/process/`'s public claim caught up to reality
The page previously said an in-performance loud moment is *never* capped —
true through v7, false since Cafe Java shipped v8. Added a paragraph
explaining the millisecond-scale cap alongside the existing applause-only
case, keeping the core "dynamics never squashed" claim intact (a cap is
categorically different from the seconds-scale riding the ban exists to
stop). Committed `9318d1d`.

### The real bug: stale local `out/` files kept resurrecting "deleted" R2 duplicates
This is the one worth understanding in full, because the symptom (`R2 FLAC
incomplete: 35/31`, identical every time, files reappearing with their
*exact original timestamps* after confirmed-successful `rclone delete`
runs) looked like R2 platform flakiness or human error, and wasn't either.

**What actually happened:** the fresh Drive export had 4 wrong filenames
(caught by cross-referencing the catalog, see above). Fixing that meant
renaming the local *source* files in `~/work/<slug>/tracks/` — correct
move. But the **already-rendered outputs** under the old wrong names were
still sitting in `~/work/<slug>/out/`, untouched, because nothing in the
pipeline validates that `out/` only contains files matching the current
source manifest. Every subsequent `rclone copy out/ → R2` faithfully
re-uploaded *everything* present locally — the correct new files **and**
the stale wrong-named leftovers — so deleting the wrong ones from R2 only
ever "fixed" it until the next publish attempt recreated them from local
disk. Four back-to-back publish attempts hit the identical count mismatch
before this was actually understood, each one burning a full resume-render
cycle (~5 min) plus upload before failing at the same check. `rclone delete`
is hard-blocked for the agent by the permission classifier — confirmed by
directly testing it, not assumed — so every deletion required Rene, which
added round-trips and, legitimately, frustration.

**Fix applied this session:** manually removed the stale local
`out/` files (flac+mp3+`.v8state.json` for the 4 affected tracks) once the
pattern was understood; deletions on R2 then actually stuck. **Fix NOT yet
built:** the pipeline still has no automatic guard against this — see the
hardening list below, item 3, which is the direct structural fix.

**Bonus confusion, now resolved:** after that, the Drive `Processed/`
backup appeared to "vanish" the local `out/` audio files entirely (only the
tiny `.v8state.json` sidecars survived). Root cause: Rene used **cut**, not
copy, in the Files app — cut removes the source after paste. Not a bug.
Recovered instantly by re-downloading the already-verified files back from
R2 into `out/` (faster and safer than re-rendering), confirmed 3 spot-check
MD5s against provenance, then the Drive backup check passed clean
(62/62 matching, 0 differences).

### Control panel (`scripts/tcap_ui.py` / `.html`) — five real fixes
All committed, none yet causing a problem in production use:
1. **Button order fixed** to match the actual pipeline sequence
   (1 Prepare → 2 Diagnose report → 3 Analyze prepared → 4 Publish, with the
   R2-estimate scouting tool moved to the end as the optional extra it is).
   It previously read top-to-bottom as if canonical analysis came before
   Prepare.
2. **Decision column narrowed** — verbose `<select>` option text was
   blowing out the column width and starving the adjacent verdict column.
   Shortened labels, moved detail to hover `title`.
3. **New `partial-accept` decision value.** `partial` and `accept` were
   mutually exclusive in the data model, but the engine needs both signals
   independently (opt into the 6 dB shave vs. "I listened, unblock the
   flag"). A track set to `partial` alone still aborted Publish on its
   review-tier flag — this bit State Trooper/Highway Patrolman directly.
   Also added a "re-analyze changed-only" button wired to the canonical
   analyzer's existing (but previously unexposed) `nums` filter — caught and
   fixed a real backend bug along the way: the filtered branch didn't merge
   with the prior analysis, so a partial re-analyze would have silently
   dropped every other track's results from the saved payload.
4. **Pre-flight warning banner + verdict fix.** Publish previously failed
   silently-until-it-didn't: a review-tier-flagged track under `auto` showed
   the exact same "WILL CAP" verdict as one that would actually ship. Now a
   banner lists every track that will abort Publish *before* you click it,
   Publish is disabled with an explanatory tooltip, and the per-row verdict
   itself says "🛑 BLOCKS PUBLISH" instead of the misleading "WILL CAP".

### A/B tooling used live for two review-tier tracks
Built loudness-matched, click-free A/B comparisons (Web Audio API gain
crossfade over ~15ms, not a hard `.muted` toggle — the naive version
produced an audible click on every switch) for **Sam Hall** (0.60s
continuous engagement, beyond the review band — declined by the gates,
Rene forced it *without* a clean listen due to tooling friction, flagged in
provenance as a weaker-evidence override than the validated tracks) and
**Highway Patrolman** (0.45s, review tier — resolved via `partial-accept`
after listening). Scratch dirs `~/work/samhall-ab/`, `~/work/statetrooper-ab/`
— deletable.

## 🔜 Next session
1. **Publish pipeline hardening — prioritized list saved to memory**
   (`publish_pipeline_hardening_ideas.md`), not yet built, per Rene's
   explicit request to fold into HANDOFF rather than implement immediately:
   - **Build first (cheap, directly prevents tonight's failure mode):**
     (a) pre-publish filename-vs-catalog check at Prepare time, before any
     rendering; (b) exact-diff R2 reconciliation (named missing/obsolete/
     mismatched objects, not a bare count); (c) validate/clean local `out/`
     against the current source manifest before render+upload — this is the
     direct structural fix for tonight's bug; (d) separate warnings from
     failures in the log/UI output.
   - **Build second:** structured `prepare --reuse-audio-decisions` instead
     of the manual fingerprint-JSON surgery done tonight to route around a
     stale decisions-binding after renaming sources; an end-of-run receipt.
   - **Deliberately not building** unless this class of failure recurs
     despite the above: full manifest-as-source-of-truth architecture,
     staging-prefix/run-ID atomic uploads, full stage-checkpoint
     resumability, an elaborate stale-object review/confirm workflow. All
     real engineering for a problem that structurally can't recur once the
     items above exist — same instinct as rejecting the codex-proposed
     approval-ledger apparatus for transient-cap earlier this week.
2. Version-bump discipline is binding for the cap mode itself — two
   published tracks now. Any change to cap thresholds/semantics = v9.
3. Consider a `build_archive_zip.py` refresh (optional, whenever there's a
   batch of shipped shows to fold in).

## ⚠️ Open items (carried, still true)
- `/search/` index preload double-fetch check, still unverified (DevTools →
  Network, exactly one `search-index.json` request).
- The stale-local-`out/` bug above is real and **not yet fixed in code** —
  only worked around by hand tonight. Don't assume it can't recur on the
  next reprocess that involves a filename correction.
- `drum-control` (codex-notes.md proposal, for repeatedly-loud material like
  a dominant snare) is deliberately **not built** — needs its own decision +
  A/B evidence if it ever happens. Truck stays applause-limited regardless.
- Sam Hall's `force` decision rests on weaker evidence than the rest of the
  validated tracks (A/B tooling friction meant no clean listen actually
  happened before forcing) — worth a real listen if this is ever revisited.

## Gotchas learned this session
- **A count-only integrity check (`have != n`) is much less useful than a
  named diff.** `35/31` told us nothing; three separate manual `rclone lsl`
  comparisons were needed each time to find the actual 4 extra files.
- **`rclone copy` re-uploads everything present in the source directory,
  stale or not** — it has no concept of "this shouldn't be here anymore."
  Any local working directory that accumulates outputs across multiple
  attempts (renames, reprocesses) is a latent duplicate-upload risk until
  something actively prunes it.
- **`rclone delete` is hard-blocked for the agent by the permission
  classifier** — confirmed by directly attempting it, not assumed. Every
  R2 deletion this session had to go through Rene.
- **Cut vs. copy in a file manager is a real, easy-to-hit footgun** when
  moving processed audio into Drive by hand — cut removes the local source
  after paste. Not a bug when it happens, but confusing in the moment
  (looks identical to files vanishing).
- **A hard `.muted` toggle between two `<audio>` elements produces an
  audible click on switch** — enough to contaminate an A/B listening test.
  Use a Web Audio API `GainNode` with a short (~15ms) linear ramp instead.
- **Long-running background jobs should get a long check-in interval, not
  frequent pings**, especially once a user has explicitly said so — this
  session over-pinged status during the publish saga before dialing back.

## Durable facts (don't undo)
- **v8 has two published tracks now** (Cafe Java, 19 Broadway 2001-01-15).
  Version-bump discipline (any cap threshold/semantics change = v9) is
  binding from here.
- **Five Rene decisions from the build (still policy):** (1) cap approved on
  two-show A/B evidence; (2) 6 dB = actual limiter attenuation, not loudness
  recovered; (3) partial capping = per-track opt-in only, never automatic;
  (4) tiered eligibility gates (auto ≤2%/1%/0.2s, review ≤5%/2%/0.5s beyond
  that declined); (5) force = after-listening override. All encoded in
  `audio_process.py` + `CLAUDE.md` + `WORKFLOW_VERSIONS[8]`.
- Modes stay exclusive — no stacking applause-limiter + cap without a new
  decision and listening evidence.
- The control panel (`make tcap`, 8769) is the intended flow for cap-era
  reprocesses, but the engine's own gates are the real safety barrier —
  terminal and panel are equivalent, panel is just more convenient. It is
  **not currently running** — start it fresh next session
  (`python3 scripts/tcap_ui.py --no-open --port 8769`), don't assume state
  survived a shutdown.
- `~/work/` is clean (only `tcap-ui/`, `song-concordance/`, empty
  `archive-zip/` — the two A/B scratch dirs from tonight are still there,
  deletable).

## Reference
Runbook: `CLAUDE.md` → "Publishing a Split Show" (+ the amended
linear-normalization section covering v8). Panel: `make tcap` (8769). A/B
tooling: `scripts/ab_compare.py` / `ab_server.py`. Technical record:
`WORKFLOW_VERSIONS[8]` in `audio_process.py`. Pipeline hardening backlog:
`publish_pipeline_hardening_ideas.md` in the memory store. External review
scratchpad: `codex-notes.md` (untracked, not Rene's notes — verify before
acting).
