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

**Phase A Tasks 1–2 are MERGED (PR #17, merge commit `59e9c6b`) and
VERIFIED LIVE IN PRODUCTION.** The branch is level with `origin/main` — 0
ahead, 0 behind — and the worktree is clean. Nothing is queued.

Post-deploy verification actually performed (the runbook's "a green Action
alone isn't proof" step):
- `/assets/miniplayer-views.js` 200 and **byte-identical to source** — a URL
  only this deploy can serve; same for `player-controller.js` and
  `playlist-views.js`.
- Both bug fixes confirmed present in the deployed bytes (`wasUnpaused` in
  the controller, the `audio.paused || state === 'error'` guard in
  `playlist-views.js`).
- Regression checks hold: `/assets/playlist.js` still 404s (Stage 2c), and
  `/`, `/playlist/`, `/songs/` all 200.
- **Rene checked the user-visible fix by hand on `renedebos.com`: Prev on
  track 1 of `/playlist/` now restarts the track instead of leaving the bar
  on a spinner.**

**Nothing shipped in this PR is user-visible except that fix.** No generated
HTML changed — Task 2 built the mini-player's view layer, but nothing emits
it into a page, exactly as `miniplayer-state.js` sat after 3a-foundation.
The first genuinely visible mini-player change arrives at Task 6, when the
container markup and the boot module land.

**Three shipped-surface files changed as a side effect of Task 2's
reviews** — `player-controller.js`, `playlist-views.js`, and the two test
fakes. Each fixed a real bug on a live page (details below). They were
landed in their own PR *deliberately*, ahead of Phase B: `player-controller.js`
runs on every page's playback, and merging it alongside the coordinator would
have made a production problem ambiguous between the two.

## ✅ Done this session (2026-08-16)

Stage 3a-canary groundwork, then **Task 2 and its three review rounds**,
shipped as PR #17.

### Phase A Task 2 — `scripts/miniplayer-views.js` (`MiniPlayerView`)
The stage's first user-visible *surface*, though nothing emits it yet. A
third view module, importing `player-controller.js` and nothing else — a
test asserts that on the source text, and the harness loader rewrites only
that one specifier, so a second `/assets/` import fails to resolve rather
than passing silently. Queue-scoped, with its own local `QueueView` base
duplicated from `playlist-views.js` rather than imported.

What it does, all per the recorded Phase 0 contracts: patches in place and
rebuilds structure only on a `currentItem.id` change; hides prev/next for a
singleton queue, gated on `queueRevision`; resets `_seeking` on a track
change; distinguishes **Resume** (a `NotAllowedError` still attributed to
the current item) from **Retry**; emits a close *request* and owns no
stop/clear policy; and republishes `--miniplayer-height` from a
`ResizeObserver`.

**Two contracts Task 3 and the coordinator must match:**
- `--miniplayer-height` is **removed, not zeroed**, when the bar is hidden,
  so every consumer must read `var(--miniplayer-height, 0px)`. The published
  value is the border-box height, so the CSS must carry
  `env(safe-area-inset-bottom)` as the bar's own bottom padding for the
  measurement to include it.
- The view changes nothing about playback or the queue on Close. The
  dismiss → fresh epoch → empty write → drop-lease sequence stays the
  coordinator's.

### Task 2 was reviewed three times: 7, then 6, then 4 findings
All seventeen confirmed by reproduction, all fixed or dispositioned; full
detail in `-codex.md`'s three "Task 2" entries with their Disposition and
Applied blocks. **The loop was stopped after round three, deliberately** —
that round's two most serious findings were defects introduced by round
two's own fixes, which is the same signal that closed the ownership
subsystem's twelve-round sequence. What this code needs now is a real
consumer (Tasks 4–5) and a browser, not a fourth adversarial pass.

The findings worth carrying forward are in "Gotchas" and "Durable facts"
below. The single most valuable one: **making the test fakes honest found
two live bugs on shipped pages.**

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

## 🔧 In progress — Stage 3a-canary (Phase 0 and Phase A Tasks 1–2 complete)

**Task 2 is merged and live (PR #17); the branch is level with `main`.**

**Next: Task 3** — the mini-player's CSS in *both* design systems
(`scripts/site.css` and `scripts/home.css`), correct in light and dark in
each, which finishes Phase A. Full spec in the working copy; the two
Task-2 contracts it has to honor are listed under "Done this session"
above. After that, Phase B's coordinator (Tasks 4–5) — the highest-risk
work in the stage, and the first real consumer `miniplayer-state.js` has
ever had.


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

**The working copy's Task 4 text was stale and is now corrected** — it
still named `myNonce`, `resolvedNonces`, "the dedicated channel" and "the
settlement timer", all superseded by the tab-identity Web Lock. Left
uncorrected it would have been implemented as written. Task 4 owns the
lock's acquisition/retry/BFCache lifecycle and the `storage` listener, and
opens **no** ownership channel.

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

- **A test fake that is wrong about the platform hides real bugs — plural.**
  `FakeAudio.play()` fired `play`/`playing` on every call, and assigning
  `src` did not set `paused`. Neither matches the platform (WHATWG's
  internal play steps fire only on a paused → playing transition; the media
  load algorithm sets `paused` true). Modelling both rules turned **five
  tests red across four suites**: four had been relying on the lie, and the
  fifth was a **live bug on `/playlist/`** — pressing Prev on track 1 of a
  playing queue left `#pl-now` stuck in its loading presentation for the
  rest of the track, shipped since Phase 2 with a green test the whole
  time. It then surfaced a second, deeper one (below). Both fakes now model
  the two rules, and a harness-contract test pins them. **Don't "simplify"
  a fake toward whatever makes the suite green** — that is the same
  mistake, one level down, as the `ResizeObserver` fake that kept
  delivering after `disconnect()`.
- **A flaky test is a bug report, not a retry candidate.** One run in
  ~20 of `test-playlist-state.mjs` failed after the fake was fixed. It
  diagnosed to a real `player-controller.js` defect: replaying the CURRENT
  item assigns no `src`, so no load and no `play` event follow, and the
  controller sat in `'loading'` forever while audio played — reachable via
  repeat-one's replay and via `/playlist/`'s endless rollover when the
  reshuffle happens to put the just-finished track back at index 0. Fixed
  at the controller. Re-running until green would have buried it.
- **Ask what a fix makes untestable.** Twice this session a correct fix
  removed the only path that could prove a *different* line was
  load-bearing: `_patchMeta()`'s cross-invalidation made the rebuild
  branch's cache reset unprovable, and the controller-level state
  correction made both `_prev()` guards unprovable through state. Both were
  resolved by re-pinning on a property that is still local (the title in
  the controls key; `ownershipSeq` not moving), not by deleting the
  belt-and-braces line. When a mutation stops failing, the honest question
  is "what now guarantees this?", and the answer belongs in the comment.
- **A character check is not a URL parser.** `isSitePath()` required a
  leading `/` and rejected a literal second one, and was documented as
  "only same-origin root-relative paths survive". Four values pass it and
  resolve **off-origin**: `/\evil.test/x` (backslash is a path separator
  for special schemes) plus a tab, CR or LF before the second slash (all
  stripped before parsing). Both boundaries now parse against a sentinel
  origin on the reserved `.invalid` TLD and compare origins.
- **When a view starts rendering a field, check the persistence codec.**
  `encodeItem()`'s "omits every field a mini-bar never renders" was true
  when written and was falsified by a consumer a stage later — twice, one
  field apart (`venue`, then `date`). Every view test built fixtures
  directly, so nothing crossed the codec and the suites stayed green while
  a restored session rendered a track with its venue missing. The views
  suite now imports the real `buildEnvelope`/`decodeEnvelope` for at least
  one test, which is the structural fix; the invariant is written at the
  codec: **if `MiniPlayerView` renders a field, that projection carries
  it.**
- **Watch for a literal control byte in source.** A `0x1f` ended up inside
  a separator string because it was typed as a character rather than an
  escape, and it survived a full green test run. The verification sweep is
  now every C0 control character except tab/newline/CR, not NUL alone —
  same hazard as the NUL incident below, one byte over. Writing files via
  a scanned script rather than an inline heredoc is what stopped it
  recurring.

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

- **`FakeAudio` (both copies — `test-fake-dom.mjs` and
  `test-player-controller.mjs`'s own) models two spec rules deliberately:**
  `play()` fires `play`/`playing` only on a paused → playing transition, and
  assigning `src` (or calling `load()`) sets `paused = true`. They are a pair
  — the second is what keeps an ordinary track change working once the first
  is in place. A harness-contract test asserts both. Reverting either
  re-hides the two live bugs they exposed.
- **Never call `play()` on a media element that was not paused.** It
  resolves without firing anything, so a controller that has already set
  `'loading'` never leaves it. `MiniPlayerView._prev()` and
  `PlaylistNowPlayingView._prev()` both guard on `audio.paused ||
  state === 'error'`, and `player-controller.js`'s `_playIndex()` carries the
  backstop (a replay that neither reloads nor transitions sets `'playing'`
  itself). The guards are kept even though the backstop hides their symptom:
  a needless `play()` still mints an ownership `play-attempt` and clears
  `lastPlayError`. Both are tested on exactly that property.
- **A view creates a fresh `AbortController` per `onAttach()` and aborts the
  outgoing one first.** `PlaybackController.mount()` calls `onAttach()` even
  for a view already in its set, so replacing without aborting leaves two
  live handler sets — one click toggles twice and the control looks dead.
  `onDetach()` also hides and resets, so a remount rebuilds. Note
  `player-views.js`/`playlist-views.js` still use one constructor-scoped
  controller; harmless there only because nothing remounts those views.
- **`--miniplayer-height` is removed, not zeroed**, when the bar is hidden.
  Consumers must read `var(--miniplayer-height, 0px)`. The published value is
  the border-box height, so the bar's own CSS must carry
  `env(safe-area-inset-bottom)` as bottom padding for it to be included.
- **The mini-player view owns no stop/clear policy.** Close emits a callback
  and changes nothing about playback, the queue, or its own visibility.

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

Tests: `node scripts/test-*.mjs` — 9 files, of which `test-fake-dom.mjs`
is a helper rather than a suite. **327/327 passing** as of this handoff, on
**both** Node 20 and a simulated Node 24, counted per suite:

| suite | tests |
|---|---|
| `test-miniplayer-state.mjs` | 126 |
| `test-miniplayer-views.mjs` | 38 |
| `test-player-controller.mjs` | 60 |
| `test-player-boot.mjs` | 28 |
| `test-playlist-state.mjs` | 29 |
| `test-player-views.mjs` | 17 |
| `test-playlist-views.mjs` | 16 |
| `test-song-boot.mjs` | 13 |

(Commit `18e7dc7`'s message says 328 — arithmetic, not a lost test. The
table is the counted figure.)

Simulate Node 24 with `node --import <preload> …` where the preload defines
a getter-only `navigator` global — CI runs Node 24 and local dev runs Node
20. Also clean: `python3 scripts/build.py`, `--check`, `python3
scripts/verify_markup.py --check-allowlist-coverage`, `node --check`, `cmp`
of every `scripts/` module against its `assets/` copy, and a control-byte
sweep (now every C0 character except tab/newline/CR, not NUL alone). The two
suites that flaked during the fake-audio work were each run 25 further times
with zero failures.

Real-browser verification: `scripts/browser_check.mjs` — needs
`playwright-chromium`, and on this machine it is a **global** install, so
run it as `NODE_PATH="$(npm root -g)" node scripts/browser_check.mjs`
(the script's own error message tells you this too). `--prod` points it at
`https://renedebos.com`. Most recent numbers: **179/179 locally** (with
`--skip-webkit`; only `playwright-chromium` is installed on this machine)
and **182/185 against production** — the three non-passes are structural
skips, not failures, because every published show is currently allowlisted
so the "non-allowlisted show page" sub-checks have nothing to run against.
The production run predates PR #17's deploy; the post-deploy verification
above was done by hand instead. A full `--prod` sweep against the new deploy
has NOT been run and is the one loose end from this session. `plans/player-consolidation/
browser-check-miniplayer.draft.mjs` is a spec-ahead `checkMiniPlayer()`
scenario written against the frozen contracts, deliberately not wired into
any run path and not adopted until Phase C — every assertion in it would
fail today.

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
