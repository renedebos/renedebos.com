# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-08-12 → 2026-08-13 · **Branch:** `main` — everything through
`9933f9b` is committed, pushed, and **live**, deploy green and spot-checked
on renedebos.com itself. Working tree is otherwise clean except the
always-untracked `codex-notes.md` and one new untracked file,
`plans/player-consolidation/navigation-continuity-mockup.html` — not
authored by me this session, origin/status unclear, worth checking with
Rene before touching it.

## ✅ Done this session

### Dynamic-fallback bug campaign is now fully complete
All 10 shows identified by the 2026-08-11 archive-wide audit
(`scripts/audit_dynamic_fallback.py`, 182 susceptible tracks, 99 exceeded
the LRA-drift gate) are confirmed on v8. Earlier today (before this
session's transcript): `jerry-19-broadway-1999-10-25`,
`jerry-19-broadway-1999-11-15`, `mad-marin-brewing-co-1998-04-01`,
`mad-marin-brewing-co-1999-04-01` (plus a six-bug audio-pipeline
correctness pass, see prior handoff content in git history if needed).
Tonight, this session:

- **`jerry-cafe-java-1999-05-27`** — full v8 reprocess; tracks 10 (Plastic
  Lemons) and 11 (Anna May) hit review-tier transient-cap flags, listened
  to and approved. This is also where Rene established the **standing
  preference**: always opt PRED_TP-flagged tracks into `--transient-cap`,
  don't ask per show (still respect listen-before-shipping hard-blocks) —
  see `feedback_default_transient_cap.md` in memory.
- **`jerry-cafe-java-1999-06-17`** — the show paused since 2026-08-11's
  data-loss incident (see that incident's writeup, still valid history,
  in `feedback_prepare_wipes_local_staging.md`). Rene finished the fade
  re-edit; reprocessed clean, transient-cap opted in from the start, no
  tracks needed capping (all landed under the 1 dB minimum-benefit
  threshold). Title fixes: "I Need a Lover"→"Hear Me", "I Want to Lean
  About Love"→"Learn About Love", slash/hyphen convention on "The Kiss /
  Da Da Da", "Barney"→"Blarney Stone Blues" typo.
- **`jerry-19-broadway-1999-06-07`** — full 29-track v8 reprocess,
  transient-cap opted in. Five review-tier flags (tracks 12, 17, 22, 26,
  29), each listened to and approved individually via
  `scripts/ab_compare.py --transient-cap` (see tooling section below).
  Track 27 auto-qualified for the applause-limiter mode. Title fixes:
  "Barney"→"Blarney Stone Blues", and "Come On All You Young Maidens" (a
  lyric-derived mislabel) back to the established "A Bunch of Thyme".
- **`jerry-cafe-java-1999-03-25`** — finished the reprocess left partial
  from 2026-08-11 (10/21 done then). Full 21 tracks now on v8. Hit the
  session's first genuine **hard-blocking diagnostic** (not just
  informational): a BALANCE flag on track 6 (ABC), 4.7 dB L/R RMS
  difference. Investigated with `ffmpeg astats` per-channel — peaks were
  close (−3.7 vs −4.5 dB), only RMS differed, consistent with normal
  audience-tape mic positioning rather than a defect. Rene reviewed and
  accepted via `--accept-diagnostic "6:BALANCE"`. Title fixes: "Good
  Life"→"The Good Life", "Angel of Montgomery"→"Angel from Montgomery"
  (also had to fix the show's own `description` text, which referenced
  the wrong title as if it were an intentional rarity).
- Two Drive `Processed/` cleanups (stale pre-rename-fix leftover files) and
  one R2 cleanup, all via `rclone delete` (R2 pre-approved,
  Drive confirmed with Rene each time per existing policy).

### Found and fixed a real gap in the resume-skip logic itself
While closing out the campaign, `version-map --version 5` still showed 8
tracks across two just-shipped shows. Investigated rather than assumed:
- **`jerry-cafe-java-1999-03-25`** (7 tracks) — false alarm. Chain strings
  and MD5s were byte-identical to a known-good v8 fix from 2026-08-11,
  proving they were safely resumed, not silently reused. Only the `ver`
  label was stale.
- **`jerry-19-broadway-1999-06-07`** (4 tracks: Crystal Rose, Truck, Blind
  Man, Some Get Married for Love) — a real gap. Their provenance had been
  *relabeled* to describe a v8-style render, but the audio bytes were the
  original, never-reverified v5 `loudnorm` output — the local
  `~/work/<slug>/out/` directory had leftovers from a 2026-08-10 scoped
  session predating the `recipe_sig`/`src_md5` safety fields, so the
  resume-skip's staleness check silently passed. Forced a genuine
  re-render (fresh `prepare` + scoped `publish --tracks 3,4,8,10`); new
  bytes came back MD5-identical to the old ones, which is only possible
  if the original v5 render for those specific tracks was never actually
  bugged — now proven, not assumed. Commit `7644b15`.
- Root cause **not fixed in code** (a real fix would make
  `recipe_changed`/`src_changed` default `True`, not `False`, when
  `recipe_sig`/`src_md5` are simply absent from old provenance) — full
  reproduction and fix direction in memory,
  `resume_skip_recipe_sig_gap.md`. Flag this for whoever next owns
  `audio_process.py`.
- Corrected the resulting stale `ver: 5` → `ver: 8` labels for all 8
  tracks (audio was never in question, only what `/archive-data/`
  displayed). Archive-wide v5 count is now **zero**. Commit `9933f9b`.

### Player-consolidation plan started
New `plans/` folder convention established (tracked in git, one
subfolder per initiative, `<topic>-plan.md` naming to keep editor
tabs/fuzzy-open distinguishable once there are several). First one:
`plans/player-consolidation/`:
- `player-consolidation-plan.md` — proposal to replace the site's four
  independent audio players (`player.js` track rows + "Full Recording",
  `playlist.js`, `continuous-player.js`) with one controller-per-document,
  multi-view component (compact/hero/mini densities), plus a client-side
  loudness control (Archive/Louder/Loudest via `GainNode` + overload
  protection) and a small functions list (share-timestamp, repeat,
  keyboard shortcuts — speed control and loop-region explicitly rejected,
  don't fit this archive's material).
- `player-consolidation-codex.md` — Codex's consolidated reviews of the plan. Verified
  its specific claims against the real code (shuffle/endless-queue/saved
  playlists/Media Session all genuinely exist, confirmed via grep) before
  accepting them. Folded the real findings in (controller-per-document,
  not per-row; honest limiter language instead of an unproven "brick-wall/
  never clips" claim; migration-parity checklist) while trimming the
  process-heavy asks (formal cross-browser test suite) that don't fit a
  two-person project.
- `player-consolidation-mockup.html` — a working HTML/CSS/JS concept
  mockup (published as a Claude Artifact, self-contained with real
  archive data — track titles/durations from tonight's shows). Also
  reviewed by Codex; fixed real problems (a false "survives navigation"
  claim on the mini bar, misleading absolute-LUFS labels, the hero
  showing one variant when it needed two — standalone recording vs. queued
  track with prev/next, non-semantic interactive elements, phone-width
  overflow).
- `player-consolidation-mockup-codex-review.md` — that review, logged.
- **Not yet reconciled:** `navigation-continuity-mockup.html` appeared in
  the working tree untracked, not authored by me — check with Rene on its
  origin/status before building on it or committing it.
- **Open architectural question, deliberately not decided yet:** sticky
  playback across page navigation. The site is a static multi-page site;
  consolidating the player does not by itself make audio survive a full
  page load. `/player/` stays as the practical workaround until/unless
  client-side navigation is separately decided — see the plan's "Open
  Questions" section.

### Investigated (unresolved, informational)
- A reported Chromebook loudness discrepancy (live site sounding louder
  than a local A/B comparison) — ruled out as a pipeline bug (FLAC and
  live MP3 measured identically via direct `ffmpeg`/`ebur128`
  measurement; MP3 encoding confirmed to be a straightforward transcode
  with no separate loudness pass). Root cause likely browser/OS
  playback-chain specific, not further diagnosable without listening
  directly. Rene accepted the transient-cap fix on the affected track
  (05-27 track 10) as a practical mitigation rather than continuing to
  chase the root cause.
- Discussed (not decided) whether to also reprocess workflow-v6 shows
  ahead of a hypothetical v9 engine — recommendation was **no**, v6 has no
  correctness bug to fix (unlike v5), so bundling v6 into a future v9 pass
  avoids doing the same shows twice.
- Discussed archive-wide headroom: pushing the on-disk target from −20 to
  −19 LUFS would break the −1 dBTP ceiling on 116 of 680 tracks currently
  at full target — this is the concrete data point behind the
  player-consolidation plan's client-side loudness control (sidesteps the
  ceiling per-listener instead of re-fighting it per-track on disk).

## 🔧 In progress / blocked
Nothing blocking. All audio work for tonight is shipped and verified live.
The player-consolidation plan is a proposal awaiting Rene's next move
(build it, extend the plan to playlist-generator/search-page, or park it).

## Gotchas learned this session
- **`recipe_sig`/`src_md5`-based resume-skip trusts old provenance that
  simply lacks those fields** — see `resume_skip_recipe_sig_gap.md`.
  After any "full reprocess" claim, run
  `python3 scripts/audio_process.py version-map --version 5` and treat any
  hit as a lead: diff the track's `chain` field before/after in git. Chain
  unchanged + md5 unchanged = safe resume. Chain changed (old `loudnorm=`
  → new `volume=`) + md5 unchanged = the real bug, force a re-render.
- **`publish_show.py`'s `--accept-diagnostic 'TRACK:CATEGORY'` is for hard
  blocks only** (`CLIPPING`, `DROPOUT`, `BALANCE`, `PHASE`) — these are
  confirmed-defect categories, not just informational flags like
  `PRED_TP`/`HIGH_LRA`. Investigate with real tooling (e.g. `ffmpeg
  -af astats` for a BALANCE flag) before asking Rene to accept/reject,
  don't just relay the raw flag.
- **A stale local `~/work/<slug>/out/` directory left over from an earlier
  session is the actual mechanism behind the resume-skip gap above** — not
  `~/work/<slug>/tracks/` (already covered by the 2026-08-11 incident/
  `feedback_prepare_wipes_local_staging.md`). `prepare` only manages
  `tracks/`; `out/` isn't touched by it and can silently persist
  old renders across sessions/days if a prior run didn't reach its own
  cleanup step.
- **Rename a track's title before its first `publish` call, not after** —
  established convention (`rename-track`), reconfirmed working smoothly
  across all four shows tonight. Note it needs re-running after every
  fresh `prepare` (a fresh Drive fetch reintroduces the same title-drift
  filename each time).
- **`ab_compare.py --transient-cap --raw PATH` requires an explicit `--raw`
  path when a track's source isn't findable via the automatic
  `~/gdrive-mount` search** — reliably worked tonight by pointing at the
  already-staged file in `~/work/<slug>/tracks/`.
- **Never chain a `pkill` targeting a background server with the command
  that replaces it in one call** — causes ambiguous kills (both the old
  and new process can end up dead). Run them as separate calls.

## Durable facts (don't undo)
- **v8 now covers the entire archive** for the dynamic-fallback bug's
  affected list — zero v5 tracks remain (`version-map` confirms). The one
  remaining `⚠ MIXED` show, `jerry-19-broadway-2001-01-15` (v7/v8 split),
  is unrelated — v7 isn't part of the buggy version range.
- **Standing preference: always opt PRED_TP-flagged tracks into
  `--transient-cap`**, no need to ask per show — but listen-before-shipping
  hard-blocks (review-tier flags) still require Rene's ears every time,
  no exception.
- **`plans/` is a new, deliberate, tracked-in-git convention** (not
  gitignored, per Rene's explicit choice) — one subfolder per initiative,
  `<topic>-plan.md` / `<topic>-codex-review.md` naming. Expect
  `plans/playlist-generator/` and `plans/search-page/` folders in a future
  session.
- `codex-notes.md` remains untracked scratch input from an external
  review tool, not Rene's own notes — verify claims before acting, same as
  always.
- Linear-normalization policy, transient-cap (v8) tiers, and the
  applause-limiter exception are unchanged — see CLAUDE.md, not repeated
  here.

## Reference
Runbook: `CLAUDE.md` → "Publishing a Split Show". Technical record:
`WORKFLOW_VERSIONS[8]` in `audio_process.py`. Dynamic-fallback bug
background: `scripts/audit_dynamic_fallback.py`'s docstring, and
`dynamic_fallback_bug_2026_08_11.md` in memory (now marked complete).
Resume-skip gap: `resume_skip_recipe_sig_gap.md` in memory. Player
consolidation: `plans/player-consolidation/` (plan, mockup, both Codex
reviews). External review scratchpad: `codex-notes.md` (untracked, not
Rene's notes).
