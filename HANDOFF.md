# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-08-15 · **Branch:** `player-consolidation`
(worktree `/home/renedebos/renedebos.com-player-consolidation`)

**Phase 1 (all show pages on the shared `PlaybackController`) is complete,
review-hardened, and live in production** — see git history / the plan's
Phase 1 section; not repeated here.

**Phase 2 (`/playlist/` migration) is fully complete, committed, merged,
and confirmed live in production.** Stage 2c (deleting the legacy
`playlist.js` engine) shipped via PR #14, commit `11dfb24`. Spot-checked
against `renedebos.com`: `/assets/playlist.js` 404s, `/playlist/` serves
only `playlist-boot.js`. Nothing further queued for Phase 2.

**Phase 3 (sticky in-page mini-player) — Stage 3a-foundation is COMPLETE,
review-hardened, MERGED, and VERIFIED LIVE IN PRODUCTION** (PR #15, plus
PR #16 fixing a CI-only test failure). The cross-tab ownership subsystem
that was mid-redesign at the last handoff is now fully implemented and has
survived **twelve** review rounds; the review loop was deliberately closed
out (see "Why the review loop stopped"). Nothing in this stage ships
user-visible UI — that starts at 3a-canary. The one user-facing change is
song pages moving onto the shared `PlaybackController`, verified working
in production.

**One commit sits on the branch, unmerged: `825b3aa`** — fixes two stale
`browser_check.mjs` assertions (see "Two incidents" below). It touches only
that dev script, nothing shipped, so it can ride along with 3a-canary's PR
rather than needing one of its own.

## ✅ Done this session

### The fenced-lease ownership redesign — implemented, then rounds 6–12

The previous handoff left a fully-designed-but-uncoded redesign, after
five straight rounds each found the same bug shape (a multi-step commit
spread across two Storage objects, with a rollback that could itself
fail). That redesign was implemented, the scratch plan was folded into the
permanent docs, and it then went through seven more `/review-step` rounds
— **six of which found something real**. Every finding was independently
reproduced with a standalone script before being accepted or declined;
every fix removed the bug's *shape* rather than patching the instance.

The shipped shape: `claimOwnership()` is exactly ONE `localStorage.setItem()`
(nothing to roll back, ever); the fencing credential is a `{ownerId,
ownerEpoch}` "lease" held in caller memory and re-derived at boot by
`restoreLease()`; `writeSession()` gates every write on `hasValidLease()`
checked fresh twice; `readEnvelope()` is tri-state so a read failure is
never mistaken for "nothing there"; `withOwnershipLock()` fails closed
with no Web Locks provider.

Round-by-round, with full findings/dispositions in `-codex.md`:
- **6** — `hasValidLease()` was missing an identity check (a rotated tab
  could still validate an old lease), plus three others. Fixed via a
  shared `hasMatchingEnvelopeTuple()` predicate.
- **7** — active-owner UX gap, a test-harness gap, `revokeLease()` missing
  a read-back. Also one gap **investigated and deliberately left unfixed**
  (see Durable facts).
- **8** — `writeEnvelope()`, the actual commit path, never read back its
  own write. It was the one storage write that hadn't already gotten that
  treatment.
- **9** — `rotateTabId()`/`claimOwnership()` never checked that a freshly
  generated id/epoch actually *differed* from the value it replaced. Under
  degraded entropy this let a "resolved" collision stay unresolved and two
  consecutive claims mint the same `ownerEpoch` — reopening the round-5
  stale-write bug via entropy instead of storage. Fixed with a shared,
  bounded `generateDistinctFrom()`.
- **10** — that fix didn't fail closed when its own pre-write read threw;
  and `isTabProbeCollision()` treated an equal-nonce *genuine* collision as
  no collision at all (two real clones each silently ignoring the other,
  both restoring as owner).
- **11** — round 8's fix had introduced its own mirror image (a landed
  write plus one transient read throw reported as failure); collision
  memoization keyed by nonce alone survived a rotation; concurrent losers
  could generate identical replacement ids.
- **12 (final)** — **no High or Medium findings.** Two Low findings, both
  about the accuracy of Claude's own claims rather than the code: an
  overstated test count/strength, and a self-flattering characterization
  of why the loop should stop. Both confirmed and corrected.

### Why the review loop stopped (deliberate, recorded)
Not "everything left is exotic" — that was an earlier, overstated version
of the reasoning that round 12 pushed back on and that has been corrected
in the plan (residual item 12). The honest version: the *collision*
findings did trend toward the exotic (rounds 9–11 needed pinned entropy or
3+ simultaneously duplicated tabs), but the *storage* findings did not —
rounds 8 and 11 each needed only one ordinary transient storage failure.
What actually justifies stopping is that **each round's fix was creating
the surface for the next round's finding** (round 8's fix directly caused
round 11's finding; round 9's directly caused round 10's), and round 12
confirms nothing High/Medium remains. The validation this module needs now
is **a real consumer**, not a thirteenth adversarial pass.

### Shipping it — and two incidents worth reading

Merged PR #15, then **the deploy Action failed at the test gate**. The
"Deploy renedebos-site Worker" step was correctly *skipped*, so production
was never touched — the gate did its job. Two separate things surfaced,
neither of them a bug in shipped code:

**1. A test that only failed on CI's Node.** Three "no lock provider"
tests asserted `typeof globalThis.navigator === 'undefined'` as a premise
check. That holds on Node 20 (local) but not Node 24 (CI's
`ubuntu-latest` default; `deploy.yml` deliberately does not pin it — see
its comment for why). The module keys off `navigator.locks`, which no Node
version ships, so the fail-closed behavior was always correct on CI too;
only the premise-check was wrong. The test's own comment had *predicted*
this exact failure and it was not acted on. Fixed in PR #16 by controlling
the global explicitly (`withNavigator()` helper, `defineProperty` since
Node ≥21's `navigator` is getter-only), covering both lock-less shapes,
plus new coverage for the real browser path (a genuine `navigator.locks`
present with no injected provider) that nothing tested before. Verified by
simulating Node 24 locally: old code reproduces CI's exact 116/117, new
code passes.

**2. Two browser_check assertions that contradicted the design.** The
first real production run of the song-page migration failed two checks on
song pages. Investigated as a possible live regression before anything
else — it was the *checks* that were wrong. Both asserted that song
occurrences accumulate into a growing shared queue; the plan's
**Queue-origin contract** assigns them `playSingleton()` semantics, and
`song-boot.js`'s own header says "every occurrence row is its own length-1
singleton queue, never merged with any other row's." The checks had
conflated *shared controller* with *shared queue*. Verified empirically
against production first (queue 0 at mount → 1 after playing a row → still
1 after a second row, audio advancing each time — exactly the contract),
then rewrote the assertions. Fix is `825b3aa`, still on the branch.

## 🔧 Next up — Stage 3a-canary

Mini-player container + script **always emitted**, with a
`MINI_PLAYER_ENABLED` flag controlling only the *runtime default*. An
earlier draft gated emission itself behind the flag, which made a
`?miniplayer=1` runtime override impossible to honor — don't reintroduce
that. The flag does not exist in the codebase yet; this stage creates it.

This is also where `scripts/miniplayer-state.js` **gets its first real
consumer**, which matters more than it sounds: several documented residual
gaps are explicitly "caller contract" items that no code enforces yet
because there is no caller. Building that coordinator is the point.

**Starting state, verified 2026-08-15** (so the next session doesn't
re-derive it). Everything on the *controller* side that the mini-player
needs already exists and shipped:
- `PlaybackController` has `restoreSession()`, `snapshot()`,
  `lastPlayError`, and the unconditional `onAnyExternalClaim` hook — the
  last two were added specifically for this stage (a browser-blocked
  autoplay resolves rather than rejects, so the Resume affordance needs
  an explicit signal; and the *conditional* claim callback never fires
  for a paused restored tab).
- The `PLAYBACK_HOST_READY` readiness contract is wired across all four
  boot paths — `player-boot.js`, `song-boot.js`, `playlist-boot.js`, and
  `fragments.py`'s `{mode:'none'}`/`{mode:'legacy'}` inline variants.
- `scripts/miniplayer-state.js` is complete and consumed by nothing.

What does **not** exist yet, i.e. the actual scope of this stage: the
mini-player view class (`player-views.js` has `PlayerView`,
`CompactPlayerView`, `HeroPlayerView` — no mini), the container markup in
`page_shell()`, its CSS, the coordinator joining `miniplayer-state.js` to
the controller, and `MINI_PLAYER_ENABLED` itself. Note the split this
implies: the logic layer is hardened and heavily tested, while this stage
is mostly *new* surface — view, markup, CSS, page template — so don't
expect round 6–12's threat model to transfer to it.

Read before starting:
- `plans/player-consolidation/player-consolidation-plan.md` — Phase 3
  stage shape, the full fenced-lease design, and **residual gaps 1–12**.
- The **caller contract** comments in `scripts/miniplayer-state.js` (the
  tab-collision handshake section). Three are load-bearing and each was
  a real reproduced bug: refresh `myTabId` after anything that rotates it
  (including `revokeLease()` escalation); disable ownership permanently on
  `failed:true`; and **re-probe under the new identity after any
  successful rotation**.

Remaining stages after this: **3b-default** (route "Add to player" /
`pl-player` into the mini-player; tombstoned migration off
`continuous-player.js`'s old `playerState` key; 2+ week soak), then
**3c-removal** (delete the popup code; `build_player()` becomes a redirect
stub).

## Gotchas learned this session

- **"All tests pass" is scoped to the runtime you ran them on.** Local is
  Node 20; CI is Node 24. A green local run said nothing about three tests
  whose premise was a Node-20-only fact, and the failure only appeared
  after merging. When a test asserts something about the *environment*
  rather than the code, control the environment explicitly instead of
  asserting the ambient one — and when a test comment says "this will need
  updating if X", treat that as a to-do, not a note. Simulating the other
  runtime locally (`node --import` a small preload that defines the
  global) reproduced CI exactly and made the fix verifiable before pushing.
- **A failing check on freshly-deployed code is not automatically a
  regression — but treat it as one until proven otherwise.** The two
  song-page failures looked exactly like a live breakage in the thing that
  had just shipped. The right order was: check user impact first (real
  playback passed), reproduce locally (it did — so not a deploy artifact),
  then read the design docs before touching either the code or the test.
  The docs settled it. Don't reach for "the test must be stale" early;
  reach for it only with the contract in hand and an empirical check
  against production.
- **When a test's name makes a strong claim, prove it fails without the
  fix.** Round 12 caught two tests that asserted something the *pre-fix*
  code would equally have satisfied — a residual-documenting test that
  never proved the retry bound existed, and an "end-to-end" test that
  hand-injected the very message the caller contract was supposed to
  produce. Both were fixed, and the three-clone test was then verified
  non-vacuous by temporarily deleting the re-probe and confirming a
  failure (116/117), then restoring it.
- **A tool going quiet is a symptom, not a null result.** An edit wrote a
  literal NUL byte into a template string, which silently made `grep`
  treat the whole source file as binary — every subsequent `grep` returned
  nothing, which read at first like the file having lost its contents.
  Diagnosed by checking byte offsets in Python. A null-byte check is now
  part of the verification sweep; keep it there.
- **Watch for a fix that over-corrects into the opposite bug.** Round 8
  added write verification to stop a silent drop being reported as
  success; round 11 found that same fix now reported a *landed* write as
  failure on one transient read blip. Bounded retry resolved it. When you
  close a false-positive, ask what false-negative you just opened.
- **Guard against self-flattering summaries.** The rationale for stopping
  the review loop was written in a way that made the remaining risk sound
  more exotic than it was, and a review round caught it. Documentation
  claims deserve the same reproduction standard as code claims.
- Carried forward (still true): the `cp` backup/revert/restore pattern
  beats `git stash` for multi-round edits; Node ≥21's `navigator` global
  is getter-only, so use `setGlobalNavigator()` in new test files; and a
  review round only reviews what you scope it to — but note the **inverse
  is also now proven**: narrow "verify these fixes" rounds repeatedly came
  back clean while the very next *broad* round immediately found several
  real bugs the narrow framing had hidden. Use both.

## Durable facts (don't undo)

- **Everything under "Durable facts" in this file's Phase-1/Phase-2-era
  versions is unchanged and still true** (see git history:
  `downloads.lossless`, recording-id keying, BroadcastChannel wire format
  basics, deep-link autoplay, WaveSurfer failure blast radius, the
  controller's `<audio>` element never being pre-appended, the flat
  `savedPlaylists` key, `syncHash()`'s query-string-dropping quirk).
- **Song occurrences are `playSingleton()`, deliberately — the queue does
  NOT accumulate across rows.** Per the plan's **Queue-origin contract**
  table and `song-boot.js`'s own header: mounting a row attaches a
  `PlayerView` and enqueues nothing, so an un-played song page correctly
  has an empty queue; playing a row replaces the queue with a length-1
  singleton. This preserves legacy behavior (occurrence rows never
  auto-advanced into each other). "All performances of this song" is
  explicitly *a deliberate later decision, not a side effect*. Two
  `browser_check.mjs` assertions once claimed the opposite and failed
  against production; they were the thing that was wrong. **Don't
  "restore" them.**
- **The tab-collision handshake is no longer "out of scope, keep as-is"** —
  that was true through round 9 and is now stale. Rounds 10–11 changed it:
  `isTabProbeCollision()` **dropped its `myNonce` parameter** and treats
  any same-tabId probe as a collision; `resolveCollision()` reports
  `failed:true` when the nonces give no tie-break asymmetry, and memoizes
  by the composite `(myTabId, theirNonce)`. `shouldRotateOnCollision()`'s
  tie-break logic itself is unchanged and still solid.
- **`tombstoneIfCurrent()` after a `revokeLease()` escalation is a known,
  permanent residual gap** (plan item 8). The "obvious" fix (dropping the
  identity check) was built, tested, and **rejected** — it lets a
  collision-loser clear a *different* live document's legitimate state.
  Purely cosmetic as-is. Two tests lock in both halves. Don't re-fix it.
- **`restoreLease()` returns a candidate, not a guarantee** (plan item 9).
  It is a single unlocked read. Any *write* under a superseded lease is
  still correctly rejected, but a caller that resumes visible UI/audio
  straight from `'restored'` without invalidation listeners has a window.
  Closing it is 3a-canary's coordinator work.
- **The BroadcastChannel wire-format upgrade (bare string →
  `{version,type,senderId}`) is out of Phase 3 entirely** — a separate
  future initiative.
- **Phase 3's mini-player replaces `/player/` entirely** once it reaches
  parity and passes a 2+ week production soak after 3b. Losing the popup's
  genuinely gapless cross-page mechanism is a deliberate, recorded
  tradeoff.
- **`player.js`'s `initLegacyPlayback()` fallback and
  `initCustomPlayers()`'s per-row engine are not being deleted in Phase
  3** — deliberate degraded-mode safety nets the readiness contract
  references.
- **`assets/miniplayer-state.js` and `assets/song-boot.js` are build
  outputs**, copied verbatim from `scripts/` by `scripts/build.py`. Edit
  the `scripts/` copy and rebuild; a direct edit to `assets/` is silently
  discarded. (Same relationship as `assets/site.css` — see `CLAUDE.md`.)
- Branch/worktree workflow: `git fetch origin && git merge origin/main` at
  session start and before a PR.

## Reference
Runbook: `CLAUDE.md` → "Publishing a Split Show" (unrelated to this
initiative, but the canonical project-wide instructions file). Player
work: `plans/player-consolidation/` — the plan doc plus `-codex.md`, which
logs every review round's findings, Claude's disposition (confirmed /
declined / already-handled, with reproduction evidence), and what shipped.
**The fenced-lease design has been folded into the permanent plan doc**;
`~/.claude/plans/dynamic-hugging-rossum.md` is superseded as a standalone
reference and should not be treated as current.

Tests: `node scripts/test-*.mjs` — 8 files, of which `test-fake-dom.mjs`
is a helper rather than a suite. **262/262 passing** as of this handoff
(119 of them in `test-miniplayer-state.mjs`), on **both** Node 20 and a
simulated Node 24. Also clean: `python3 scripts/build.py`, `--check`,
`python3 scripts/verify_markup.py --check-allowlist-coverage`, `node
--check`, zero null bytes, and `cmp scripts/miniplayer-state.js
assets/miniplayer-state.js`.

Real-browser verification: `scripts/browser_check.mjs` — needs
`playwright-chromium`, and on this machine it is a **global** install, so
run it as `NODE_PATH="$(npm root -g)" node scripts/browser_check.mjs`
(the script's own error message tells you this too). `--prod` points it at
`https://renedebos.com`. **185/185 against production** as of this handoff.

Production verification done after the 3a-foundation deploy (the runbook's
"a green Action alone isn't proof" step): `/assets/miniplayer-state.js`
and `/assets/song-boot.js` both 200 and byte-identical to source; song
pages reference `song-boot.js` with the legacy fallback intact; `/`,
`/songs/`, `/playlist/`, `/search/`, `/history/`, `/archive-data/` all
200; `/assets/playlist.js` still 404 (PR #14 regression check).

Also outstanding, unrelated to Phase 3: Rene wants to set up **custom
skills** (`~/.claude/skills/` or a project `.claude/skills/`) — neither
directory exists yet; the only skills present come from installed
marketplace plugins. That work belongs on `main`, not this branch.
