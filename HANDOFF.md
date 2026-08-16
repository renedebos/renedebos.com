# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-08-16 · **Branch:** `player-consolidation`
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

**Six commits sit on the branch, unmerged and unpushed.** Nothing is
deployed; no PR is open. Newest first:
- `5d2746d` — applies the Phase 0 review findings, plus Task 1's
  `--player-*` aliases
- `d4056ac` — Stage 3a-canary Phase 0: the integration contracts
- `ffe0ae4` — merge from `origin/main` (session-start sync)
- `40b31c1`, `5b19d28` — earlier HANDOFF updates
- `825b3aa` — two stale `browser_check.mjs` assertions (see "Two incidents"
  below); dev script only, rides along with 3a-canary's PR

**Nothing on this branch is user-visible yet.** Every commit so far is
plumbing, docs, or tests; no generated HTML has changed since 3a-foundation
shipped. The stage's first visible surface is Task 2's `MiniPlayerView`.

## ✅ Done this session (2026-08-16)

All of it is Stage 3a-canary groundwork plus one documentation cleanup. Two
commits, both local.

### The plan doc's Phase 3 section was condensed
902 lines → 581. The round-by-round review narrative (the twelve
post-redesign rounds plus the pre-redesign claim-token rounds) moved into
`-codex.md`, where every finding's evidence and disposition already lived;
a "Review history" subsection maps round → entry and keeps a compressed
record of what the broad rounds found. **Residual-gap item numbers are
load-bearing** (referenced from this file and `-codex.md`) — don't renumber.
Verified nothing was lost by extracting all 141 backticked identifiers from
the deleted block and confirming each still appears somewhere. Phase 1 and
Phase 2's sections still carry their full inline narrative and are the
obvious next trim if the file gets unwieldy.

### Stage 3a-canary was planned, then re-planned twice
Three Codex rounds against the *plan* found 8, 7, and 7 gaps. That
restructured the stage around a **Phase 0** that closes integration
contracts before any UI work — without it, several would have surfaced
halfway through building the coordinator. Round 3 also overturned a
decision made from round 2 (see the `play`-event trigger below). Full task
breakdown with acceptance criteria:
`~/.claude/plans/imperative-frolicking-widget.md`.

### Phase 0 implemented, reviewed, and its findings applied
`PlaybackController` gained post-construction `onAnyExternalClaim(fn)` and
`onOwnershipEvent(fn)`, one monotonic `ownershipSeq` + `lastOwnershipEvent`,
and `lastPlayErrorItemId`. `miniplayer-state.js` gained
`OWNERSHIP_CHANNEL_NAME`, `tabIdentityLockName()`, and four caller
contracts. A `/review-step` round then found five issues — all confirmed by
independent reproduction, all fixed in `5d2746d`. Details in the "In
progress" section below and in `-codex.md`.

### Phase A Task 1
`home.css` gained the `--player-accent`/`--player-track`/`--player-surface`
aliases it had never defined, despite `player-views.js` claiming both token
systems did. Harmless until now — nothing importing that file ever ran on
the homepage, where the mini-player will. Declared once in `:root`, not per
theme block: `var()` resolves against the referenced token on the same
element, which `site.css` has relied on since Phase 1. Verified in real
Chromium across light, OS-dark and explicit-toggle on both stylesheets.

### Previous sessions, compressed
The fenced-lease ownership redesign and its twelve review rounds are no
longer narrated here — see the plan doc's "Review history" subsection and
`-codex.md`. The one-line version: `claimOwnership()` is exactly ONE
`localStorage.setItem()`, the `{ownerId, ownerEpoch}` lease lives in caller
memory and is re-derived by `restoreLease()`, `writeSession()` gates on
`hasValidLease()` checked fresh twice, `readEnvelope()` is tri-state, and
`withOwnershipLock()` fails closed with no Web Locks provider.

### Shipping 3a-foundation — two incidents still worth reading

**1. A test that only failed on CI's Node.** Three "no lock provider" tests
asserted `typeof globalThis.navigator === 'undefined'` as a premise check.
True on Node 20 (local), false on Node 24 (CI's `ubuntu-latest` default;
`deploy.yml` deliberately does not pin it). The module keys off
`navigator.locks`, which no Node ships, so behavior was always correct — only
the premise was wrong. The test's own comment had *predicted* this and it
was not acted on. Fixed in PR #16 with `withNavigator()`/`defineProperty`.
Simulating Node 24 locally reproduced CI exactly.

**2. Two browser_check assertions that contradicted the design.** The first
production run of the song-page migration failed two checks. Investigated as
a possible live regression first — it was the *checks* that were wrong. Both
asserted that song occurrences accumulate into a shared queue; the
Queue-origin contract assigns them `playSingleton()`. Verified empirically
against production before rewriting them. Fix is `825b3aa`.

## 🔧 In progress — Stage 3a-canary (Phase 0 complete)

Mini-player container + script **always emitted**, with a
`MINI_PLAYER_ENABLED` flag controlling only the *runtime default*. An
earlier draft gated emission itself behind the flag, which made a
`?miniplayer=1` runtime override impossible to honor — don't reintroduce
that. The flag does not exist in the codebase yet; this stage creates it.

This is also where `scripts/miniplayer-state.js` **gets its first real
consumer**, which matters more than it sounds: several documented residual
gaps are explicitly "caller contract" items that no code enforces yet
because there is no caller. Building that coordinator is the point.

**Planned across three Codex review rounds** (8, 7, then 7 findings — all
verified against the source before folding in), which restructured the
stage around a **Phase 0** that closes integration contracts *before* any
UI work. The full task breakdown with acceptance criteria lives in
`~/.claude/plans/imperative-frolicking-widget.md`; the checklist and every
recorded decision are in the plan doc's Phase 3 section.

**Phase 0 is done and its review applied**, all gates green, nothing
user-visible changed. The plan doc's checklist now uses strict status
words — **implemented** means code plus a mutation-checked test, **decided**
means a written contract awaiting the coordinator in Task 4. A review round
found that distinction was being blurred, so don't re-blur it.

- **0.1 implemented** — the `PlaybackController` additions listed below.
- **0.2 SUPERSEDED, not done** — `OWNERSHIP_CHANNEL_NAME` and its hazard
  test survive, but the probe/reply handshake is no longer the collision
  mechanism, so the coordinator opens no ownership channel at all.
- **0.3 decided; `tabIdentityLockName()` implemented** — the settle timer
  was replaced by a document-lifetime Web Lock (see Durable facts).
- **0.4–0.6, 0.9 decided** — Close fencing, save cadence, restored-play
  rule, `initialIntent` disposition. In the plan doc.
- **0.7 decided** — `storage` is a wake-up signal only: re-read and
  re-validate against the captured lease before acting. Nothing routes
  anything yet.
- **0.8 decided** — eligible-page set (enumerated from source: 11 builders
  eligible, `/process/`, `/manual/`, `/player/` correctly excluded), boot
  cost, flag ownership, height measurement.

**The Phase 0 review, 2026-08-16** (`-codex.md`, "Stage 3a-canary Phase 0
and Task 1 review") — five findings, all confirmed by independent
reproduction, all fixed in `5d2746d`. Two invalidated work already marked
complete, which is why the status words above exist. The three worth
carrying forward are in Durable facts and Gotchas below.

**Next: Phase A Task 2** — `scripts/miniplayer-views.js`
(`MiniPlayerView`), then Task 3's CSS in both design systems. Task 1 is
done. Task 2 is the stage's first user-visible surface.

**Starting state, verified 2026-08-15, CORRECTED 2026-08-16.** The earlier
version of this section said "everything on the *controller* side that the
mini-player needs already exists and shipped." **That was false**, and it
was believed and repeated when Stage 3a-canary was first planned. The
primitives shipped, but they were unreachable on the path that matters:
- `PlaybackController` has `restoreSession()`, `snapshot()`,
  `lastPlayError`, and the unconditional `onAnyExternalClaim` hook — the
  last two were added specifically for this stage (a browser-blocked
  autoplay resolves rather than rejects, so the Resume affordance needs
  an explicit signal; and the *conditional* claim callback never fires
  for a paused restored tab).
- **But `onAnyExternalClaim` was constructor-only**, and the mini-player
  *adopts* a controller someone else built: `player-boot.js:60` and
  `song-boot.js:69` both call `new PlaybackController()` with no arguments,
  so there was no option to pass. Fixed in Stage 3a-canary Task 0.1 —
  `onAnyExternalClaim(fn)` and `onOwnershipEvent(fn)` are now
  post-construction subscriptions returning an unsubscribe.
- **Subscription alone was still not enough.** The controller is built at
  module-parse time but readiness only resolves on `window.load`
  (`player-boot.js:217`) — on a show page that gap spans the entire page
  load, and a user pressing play or another tab claiming inside it is
  invisible to a listener installed afterward. `snapshot()` now carries
  `ownershipSeq` + `lastOwnershipEvent` (one monotonic sequence, kinds
  `play-attempt`/`local-play`/`external-claim`) so a late subscriber
  recovers by comparison. Subscribe first, read the snapshot second.
- **Ownership claims hook the media `play` event, never the `'playing'`
  state.** Every rebuffer is `playing → loading → playing`
  (`player-controller.js`'s `waiting`/`playing` listeners), so claiming on
  the state would mint a fresh ownership epoch on every buffering hiccup.
  There is a direct regression test for this.
- `snapshot()` also carries `lastPlayErrorItemId`: `lastPlayError` is never
  cleared on a queue change, so without the id a stale `NotAllowedError`
  would render "Resume" against a different track.
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
- The **caller contract** comments in `scripts/miniplayer-state.js`. The
  tab-identity lock contract supersedes the handshake ones for collision
  handling (see Durable facts); still load-bearing regardless of mechanism:
  refresh `myTabId` after anything that rotates it (including a
  `revokeLease()` escalation), and disable ownership permanently on any
  unrecoverable identity failure.

Remaining stages after this: **3b-default** (route "Add to player" /
`pl-player` into the mini-player; tombstoned migration off
`continuous-player.js`'s old `playerState` key; 2+ week soak), then
**3c-removal** (delete the popup code; `build_player()` becomes a redirect
stub).

## Gotchas learned this session

- **Ask "what mutation would make this fail?" while writing the test, not
  after.** Two vacuous tests turned up in Phase 0 alone — a `destroy()` one
  I caught myself, and a single-sequence one a review caught. Both had the
  identical shape: they asserted a *consequence* that some other mechanism
  already guaranteed, instead of the property named in the test. The
  `destroy()` test passed with its fix deleted because `_unclaim()` had
  already made the event impossible; the sequence test passed with per-kind
  counters substituted because it only ever checked `lastOwnershipEvent`.
  Twice in one phase is a pattern. Mutation-check every behavioural test
  before believing it — this project has now shipped three that passed for
  the wrong reason.
- **A test comment can be confidently wrong about the harness.** The
  sequence test's comment claimed each controller "saw one local play and
  one external claim." `claimListeners` is module-scope, so four live
  controllers share one registry and each actually saw *three* external
  claims. Instrumenting the real event stream took two minutes and
  contradicted the comment immediately. If a test's comment describes
  what other objects did, verify it rather than reasoning it.
- **Reproduce the hazard before designing around it.** Before adding a
  separate ownership channel I posted a probe-shaped object on
  `hannan-playback` against a real controller and watched it go
  `playing → paused`. That took one throwaway script and turned a plausible
  argument into a fact — and the resulting regression test asserts the
  hazard *still exists*, so nobody deletes the separation later on the
  grounds that it looks unnecessary.
- **Verifying a claim can be cheaper than defending it.** I asserted that
  declaring CSS aliases once in `:root` follows the theme. Rather than
  argue from the `site.css` precedent, a short Playwright script read the
  computed values across light, OS-dark and explicit-toggle on both
  stylesheets. Settled in one run.
- **A grep can match a comment that says the opposite.** My first
  page-eligibility scan reported `build_player` as using `page_shell()`,
  because it matched that string inside the function's own "NOT
  page_shell()" comment. Strip comments before classifying code.
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
- **The tab-identity Web Lock is the SOLE collision arbiter — the
  probe/reply handshake is superseded** (2026-08-16). A document holds an
  exclusive lock named `miniplayer-tab:<id>` for its whole lifetime;
  acquiring it is *positive* proof the identity is uniquely its own. This
  replaced a 250 ms quiet-period timer, which could only ever offer absence
  of evidence — a frozen or throttled tab holding a cloned identity can
  reply after any timer fires, producing exactly the double-owner window the
  mechanism exists to prevent. **The coordinator must not also run the
  handshake:** two independent rotation mechanisms can disagree and move
  `TAB_ID_KEY` while the document still holds only the old id's lock. The
  handshake helpers stay in the file (hardened, and deleting them is a
  separate decision) but nothing drives them. Full acquisition contract —
  `{ifAvailable:true}`, separate acquisition signal, never await `request()`
  during boot, bounded retry then disable persistence, re-acquire after any
  rotation including a `revokeLease()` escalation, and the BFCache rule — is
  in `miniplayer-state.js`. `tabIdentityLockName()` bounds and validates the
  id because `peekTabId()` does neither and `sessionStorage` is user-editable.
- **Ownership claims hook the media `play` EVENT, never the `'playing'`
  STATE, and both `play`/`playing` are ignored when `audio.paused` is
  already true.** Every rebuffer is `playing → loading → playing`, so the
  state would mint an ownership epoch per buffering hiccup. And `pause()`
  flips `paused` synchronously while `play`/`playing` arrive as queued media
  tasks that it does not cancel — without the guard a paused controller
  claimed ownership and reported `state:'playing'` while silent. Both have
  direct regression tests. Don't "simplify" either back.
- **`storage` events are a wake-up signal only — never act on
  `event.newValue`.** It can be stale by delivery: another tab writes and
  queues event A, the user plays locally and this tab claims lease B, then A
  arrives carrying the older value. Acting on it drops a valid lease and
  revokes a current epoch. Re-read and re-run `hasValidLease()` against the
  captured lease; do nothing if it still validates.
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

**The plan's Phase 3 section was condensed on 2026-08-15**: it now carries
the design, the stage shape, and residual gaps 1–12 only. The
round-by-round review narrative (the twelve post-redesign rounds plus the
pre-redesign claim-token rounds) moved into `-codex.md`, where every
finding's evidence and disposition already lived — the plan's "Review
history" subsection is the map from round to `-codex.md` entry, and keeps
a compressed record of what the broad rounds found. Residual-gap item
**numbers are load-bearing** (referenced from this file and from
`-codex.md`) — don't renumber them. The same treatment has NOT been
applied to the Phase 1/Phase 2 sections, which still carry their full
inline review narrative despite both phases being shipped and closed;
that's the obvious next trim if the file gets unwieldy again.

Tests: `node scripts/test-*.mjs` — 8 files, of which `test-fake-dom.mjs`
is a helper rather than a suite. **282/282 passing** as of this handoff
(122 in `test-miniplayer-state.mjs`, 58 in `test-player-controller.mjs`;
Stage 3a-canary Phase 0 and its review round added 20 between them), on
**both** Node 20 and a simulated Node 24. Simulate Node 24 with
`node --import <preload> …` where the preload defines a getter-only
`navigator` global — CI runs Node 24 and local dev runs Node 20. Also clean: `python3 scripts/build.py`, `--check`,
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
