# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-08-13 · **Branch:** `main` — everything through `c334352`
is committed, pushed, and **live**, deploy green and spot-checked on
renedebos.com itself. Working tree clean except the always-untracked
`codex-notes.md`.

**Note on scope:** this was one of several concurrent threads tonight. This
handoff covers the `main`-branch work only — the audio-processing archive.
A separate, parallel session ran on the `home-page` worktree/branch (site
header redesign, and the first real exercise of a new git-worktree
workflow); see "Concurrent work on other branches" below for a pointer
rather than a full narrative — that session's own handoff lives on its own
branch.

## ✅ Done this session

### Archive-data page: cap-audit detail is now visible to a human, not just hover-only
`/archive-data/`'s Treatment column previously only exposed the full
transient-cap provenance (attenuation applied, engagement %, event count,
policy ceiling, override note) via a native `title=` tooltip — invisible on
touch devices, easy to miss even on desktop. Added a real, always-discoverable
click-to-expand detail row (`scripts/archive-data.js`, styling in
`scripts/site.css`), following the same `<details>`-style disclosure pattern
already used elsewhere on the site (song entries, the show page's own
`#technical-data` table). Commit `c5497e9`.

### "Force through all 22 tracks plus the 6" — archive-wide shortfall batch, complete
Rene's instruction: force every remaining linear-reduced shortfall track
(LUFS between −21 and −25) archive-wide into the v8 transient-cap mode, and
separately raise the 6 dB attenuation ceiling for the 6 tracks already
pinned at it. 9 shows, all shipped and verified live:

1. **`jerry-19-broadway-1999-05-10`** (8 tracks) — two review-tier flags
   (Sam Hall, Ted Kennedy Song) exceeded the auto band, force-accepted.
2. **`jerry-19-broadway-1999-06-21`** (4 tracks) — `draft_tracks.py`
   overwrote 3 of the 4 titles with the fresh export's filename spelling
   (see the bug writeup below); restored "Hear Me" and the "/" form of
   "You're Pulling Me Leg / The Ted Kennedy Song" by hand after publish.
3. **`sean-19-broadway-unknown`** (3 tracks) — a genuine hard-blocking
   BALANCE finding (4.4 dB L/R RMS) on track 1, reviewed and accepted as
   normal audience-tape mic placement, not a defect.
4. **`sean-19-broadway-2000-02-21`** (3 tracks) — clean, no flags.
5. **`jerry-19-broadway-1999-10-25`** (2 tracks) — both review-tier,
   force-accepted per standing instruction.
6. **`mad-sweetwater-2000-02-17`** (1 track, Butter) — clean.
7. **`jerry-19-broadway-2001-01-15`** (5 tracks, ceiling-raise batch) —
   **every one of the show's 31 tracks** carried a uniform ~6.5–7 dB
   BALANCE finding (an SBD source's own channel-mix characteristic, not a
   defect — accepted all 31 at once). Escalated one genuinely ambiguous
   title call to Rene rather than guessing: track 1's fresh filename read
   "State Trooper," a real, different Springsteen song from the catalogued
   "Highway Patrolman" — Rene confirmed keep "Highway Patrolman." One
   track ("Xmas Song") landed short of −20 even after raising its ceiling
   to 9 dB — traced to the engine's own dynamics-safety check (cap
   engaging beyond isolated transients, exactly the failure mode the
   no-dynamics-compression policy exists to catch), left short rather than
   forced further.
8. **`mad-cafe-java-1999-09-09`** (1 track, ceiling raised to 8 dB) — clean
   result, −20.22. **Push hit a real conflict here**: an unrelated PR
   (`home-page` branch, header redesign) had landed on `origin/main`
   mid-batch. Fetched, merged (`git merge origin/main`, auto-resolved, no
   manual conflict markers), rebuilt to confirm no drift, pushed.
9. **`mad-sweetwater-2001-01-06`** (1 track, Far Away Eyes) — the planned
   ~9 dB ceiling override turned out to be unnecessary: the fresh Drive
   export measured louder than the stale source the original estimate was
   based on, so plain linear gain reached the full −20 target directly.

Full deploy-verification pass at the end (not per-show, to keep the batch
moving): confirmed via a fresh Action run plus a live spot-check that only
the final deploy could serve.

### Found a real, repeatable bug: `draft_tracks.py` silently overwrites titles
Discovered while fixing show 2 above, then confirmed on 5 of the 9 shows in
total (jerry-19-broadway-1999-06-21, sean-19-broadway-unknown,
jerry-19-broadway-2001-01-15, mad-cafe-java-1999-09-09, and implicitly
guarded-against on the rest). `scripts/draft_tracks.py:93` —
`title = f[3:-5]` — takes a track's title straight from the fresh export's
filename on every scoped publish, with **zero preservation** of the
existing catalog spelling, unlike tags (which at least attempt a
cross-archive majority vote). `publish_show.py`'s `preflight_catalog_titles()`
already does the right cross-reference check at `prepare` time, but it's
print-only and never wired to the actual write. Every affected track needed
a manual post-publish fix. Full writeup, root cause, and fix options in
memory: `draft_tracks_title_overwrite_bug.md`.

### `song-title-consistency` plan written
`plans/song-title-consistency/song-title-consistency-plan.md` — proposal to
fix the bug above properly: a shared canonical title registry
(`data/song-titles.json`, bootstrapped from the current catalog by majority
vote — a real read-only scan found only 26 of 145 songs have any spelling
drift on file, almost all of it trivial capitalization/whitespace noise),
consulted by both `draft_tracks.py` and `publish_show.py` instead of their
current two independent, incomplete matching implementations, plus a
`build.py` integrity-check addition (warn-only, matching the existing
rarity-tag-drift precedent). Also documents a separate, deferred fix: the
R2 download filename a visitor actually receives (`worker/index.js`'s
Content-Disposition) is built from the raw R2 key basename, not the
catalog title — so a title correction today doesn't propagate to what
people download. Not yet built. `song-title-consistency-codex-review.md`
is a pending placeholder — not fabricated content, waiting on an actual
Codex pass. Commit `c334352`.

## Concurrent work on other branches (not this session — pointer only)
A separate session ran the **first real exercise of a git-worktree
workflow** this project now uses: four worktrees sharing one `.git`,
`main` / `home-page` / `player-consolidation` / `share`, each on its own
branch. That session shipped the home-page header redesign (musical-note
mark → a "Shows" text pill) end to end — PR #2, reviewed, merged into
`main` (visible above as `a455f9d` / `2f9e688`), deploy verified live —
plus fixed an unrelated Cloudflare Workers Builds token issue found along
the way, and synced/pushed the `player-consolidation` and `share`
worktrees (the latter a new proposal for song/search sharing). Full detail
lives on that branch's own version of this file and in
`plans/home-page/home-page.md` — not duplicated here since this session
didn't do that work and can't vouch for specifics beyond what's visible in
the commit log.

**Worth knowing for any future `main`-branch session:** `HANDOFF.md` got
independently rewritten on both `main` and `home-page` this round,
producing a real (non-mechanical) merge conflict neither git nor a plain
merge could resolve — reconciled by hand this time. Consider moving each
branch's full session narrative into its own `plans/<project>/<project>.md`
going forward (the pattern `home-page`'s session was already half-using)
and treating root `HANDOFF.md` as `main`-only, to stop this recurring with
`player-consolidation` or `share`.

## 🔧 In progress / blocked
Nothing blocking. All audio work for tonight is shipped and verified live.
The `song-title-consistency` plan is a proposal awaiting a Codex pass and
Rene's go-ahead to build.

## Gotchas learned this session
- **`draft_tracks.py` always derives `title` from the fresh filename, never
  preserves the existing catalog spelling** — see
  `draft_tracks_title_overwrite_bug.md`. After any scoped `publish` that
  touches a track flagged `TITLE CHANGED` in `prepare`'s diagnose, always
  re-check that track's `title` field afterward, even when the flag looked
  like harmless filename-convention noise (most of them are, but the write
  path doesn't know that).
- **A whole-show-uniform BALANCE finding (same few-dB range on every
  track) is a source characteristic, not a per-track defect** — seen on an
  audience tape (single track, 4.4 dB) and an SBD board feed (all 31
  tracks, 6.3–7.2 dB, near-identical spread). Worth eyeballing the
  *spread* across the show before deciding accept-vs-investigate, not just
  the raw dB number on one track.
- **Raising `--transient-cap-max-gr`'s ceiling doesn't always move the
  result** — one track's shortfall was gated by the engine's own LRA-shift
  dynamics-safety check, not by the declared ceiling (which was already
  well above what the track's transients actually needed). Check the
  `[LRA shifted]` status tag before assuming a higher ceiling will help;
  if it's present, forcing further risks exactly the dynamics-flattening
  the whole transient-cap policy exists to prevent.
- **A multi-line Bash command with a variable assignment (`accept=$(...)`)
  can get killed at the 2-minute mark instead of auto-backgrounding**,
  unlike simple single-line `python3 ...` calls which reliably
  auto-background past the timeout. Pass `run_in_background: true`
  explicitly for anything nontrivial rather than relying on the timeout
  heuristic — confirmed this killed an in-progress render twice before
  switching.
- **A rejected `git push` mid-batch can mean real, unrelated work landed
  on the remote** — don't assume it's your own stale branch state.
  `git fetch` + inspect before merging; in this case it was a legitimate
  PR from a parallel session, safely auto-merged with zero conflicts once
  identified.

## Durable facts (don't undo)
- **Archive-wide shortfall-track batch is complete** — the 22
  linear-reduced tracks plus the 6 at-ceiling tracks identified by the
  2026-08-13 audit are all now on v8 transient-cap (or confirmed to not
  need it, in Far Away Eyes' case).
- **`/archive-data/`'s Treatment column is click-expandable** for any
  `sparse-transient-cap` track — full provenance (gr_db, p95_gr_db,
  engaged_pct, events, longest_s, near_peak_pct, policy_max_gr_db,
  override) visible to anyone browsing the page, not hover-only.
- **Four-worktree map now in use**, one branch each, sharing one `.git`:
  `/home/renedebos/renedebos.com` (`main`),
  `/home/renedebos/renedebos.com-home-page` (`home-page`),
  `/home/renedebos/renedebos.com-player-consolidation`
  (`player-consolidation`), `/home/renedebos/renedebos.com-share` (`share`).
- **`plans/<project>/<project>-plan.md` + `plans/<project>/<project>-codex-review.md`
  naming convention** now has multiple live examples
  (`player-consolidation`, `song-title-consistency`, and `home-page`/`share`
  on their own branches, spelled slightly differently as `-codex.md`) — the
  Codex file is reserved for the actual external tool's output, pasted in
  verbatim, never fabricated as a placeholder beyond a plain "pending" note.
- `codex-notes.md` remains untracked scratch input from an external review
  tool, not Rene's own notes — verify claims before acting, same as always.
- Linear-normalization policy, transient-cap (v8) tiers, and the
  applause-limiter exception are unchanged — see CLAUDE.md, not repeated
  here.

## Reference
Runbook: `CLAUDE.md` → "Publishing a Split Show". Technical record:
`WORKFLOW_VERSIONS[8]` in `audio_process.py`. Title-overwrite bug:
`draft_tracks_title_overwrite_bug.md` in memory. Song-title-consistency
plan: `plans/song-title-consistency/`. External review scratchpad:
`codex-notes.md` (untracked, not Rene's notes). Home-page/worktree
session: `plans/home-page/`, and that branch's own `HANDOFF.md`.
