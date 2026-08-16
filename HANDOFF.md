# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-08-15 · **Branch:** `player-consolidation`
(worktree `/home/renedebos/renedebos.com-player-consolidation`)

**Phase 1 (all show pages on the shared `PlaybackController`) is complete,
review-hardened, and live in production** — see git history / the plan's
Phase 1 section for that work; not repeated here.

**Phase 2 (`/playlist/` migration) is fully complete, committed, merged,
and confirmed live in production.** Stage 2c (deleting the legacy
`playlist.js` engine) shipped via PR #14, commit `11dfb24`, merged same
day. Spot-checked directly against `renedebos.com` afterward:
`/assets/playlist.js` 404s, `/playlist/` serves only `playlist-boot.js`.
Nothing further queued for Phase 2.

**Phase 3 (sticky in-page mini-player) is deep in progress, entirely
uncommitted.** The originally-planned `/player/` popup approach was
rejected by Rene (iOS Safari has no real popup windows; popup blockers
are unreliable generally). The replacement design (a fixed in-page bar
persisting session state across ordinary page navigation) went through
**five** Codex design-review rounds before implementation started. Stage
3a-foundation (song-page migration onto the shared controller, a
"playback readiness contract," an observable play-result signal, and
persisted-session/cross-tab-ownership logic — no user-visible UI yet) is
implemented, but **its cross-tab ownership subsystem is mid-redesign**:
five straight implementation-review rounds each found (or confirmed) a
real bug in the same code, and a sixth pass concluded the *pattern* of
fixes — not any single fix — was the problem. **A full redesign has been
planned in detail but NOT YET IMPLEMENTED.** See "🔧 Next up" below before
doing anything else in this area. All of Phase 3 is uncommitted,
working-tree only.

## ✅ Done this session

### Phase 2 Stage 2c — shipped
Picking up from a prior session's HANDOFF.md (Stage 2c implemented,
awaiting review/go-ahead): reviewed the full diff, committed (`11dfb24`),
pushed, opened and merged PR #14. Deploy Action succeeded; spot-checked
`renedebos.com` directly post-deploy. See `player-consolidation-plan.md`'s
Phase 2 section and `-codex.md`'s Phase 2 entries for the full
implementation history.

### Phase 3 — design (5 Codex review rounds, all findings verified against
actual code before/after incorporating)
Rounds 1–5 covered the overall mini-player architecture: readiness
contract, startup precedence, `/playlist/` handoff, and an *early* version
of the ownership design (an in-memory `hasOwnership` flag → persisted
`ownerId` → `ownerToken` fencing → a `sessionStorage`-durable `revoked`
latch). Full round-by-round history in `player-consolidation-plan.md`'s
Phase 3 section and `-codex.md`'s "Phase 3 design review" section. **This
design's ownership portion has since been superseded — see the redesign
below.** Nothing else about Phase 3's design changed this session
(readiness contract, song migration, `/playlist/` handoff, stage shape are
all still current).

### Phase 3 Stage 3a-foundation — implemented, then FIVE rounds of
ownership-specific review, converging on a full redesign

Implemented directly (Claude, standing preference), `scripts/miniplayer-state.js`
+ `scripts/song-boot.js` + supporting boot-script wiring. **Rounds 1–2**
(prior session, before this session's context compaction): 8 findings then
5 findings, all fixed — see prior `-codex.md` entries. **This session
picked up at round 3** and ran three more `/review-step` cycles against
the exact same ownership/collision code, each finding something the
previous round's fix had missed:

- **Round 3** (`-codex.md` "fix verification", second entry): the round-2
  tab-collision handshake ("whichever tab receives a probe is protected
  from rotating") turned out to depend on a signal (`envelopeNamesThisTab()`)
  that a byte-identical cloned tab satisfies exactly as validly as the
  original — reproduced the real owner losing to an idle clone, AND a
  worse case: two clones probing each other near-simultaneously could
  BOTH rotate, orphaning the session entirely. **Fixed**: dropped
  ownership-based protection for a pure, symmetric nonce tie-break,
  memoized per collision. Also fixed a `claimOwnership()` rollback bug (a
  failed rollback could permanently corrupt the shared envelope) and a
  `playlist-boot.js` `destroyed`-guard gap. 198/198 tests passing
  afterward.
- **Round 4** (`-codex.md` "fourth fix verification"): the round-3 nonce
  tie-break wasn't actually unbiased — `generateNonce()` shared
  `generateTabId()`'s `Date.now()`-prefixed format, which dominates the
  lexicographic comparison; reproduced the earlier-generated nonce losing
  20/20 trials (whichever tab rebooted most recently always won). **Fixed**:
  `generateNonce()` now uses `crypto.getRandomValues()` (no time
  component), verified unbiased over repeated trials. Also found and fixed
  a narrower version of round 3's `claimOwnership()` bug (an
  already-owning tab's own reclaim attempt could self-orphan its valid
  claim on a failed shared write) — fixed by staging the candidate token
  in a new `PENDING_CLAIM_TOKEN_KEY` before promoting it. **Note**: these
  two fixes were implemented without waiting for an explicit
  `/apply-review` go-ahead — a process deviation Rene caught; acknowledged
  and corrected for round 5.
- **Round 5** (`-codex.md` "fifth fix verification"): found round 4's
  pending-token fix was ITSELF the same bug shape, one level deeper — a
  claim that lands only via the pending slot can be destroyed by a LATER
  reclaim attempt, which unconditionally overwrites that same pending slot
  before knowing if it will succeed. Reproduced directly. **Verified but
  NOT implemented** — correctly stopped and reported per `/review-step`'s
  contract this time.

**Then a separate, interactive Codex review session** (not the automated
`codex_review.sh` script — Rene ran it himself and pasted the verdict) confirmed
round 5's finding and found **three more instances of the identical root
cause**, all independently reproduced by Claude before accepting them:
revocation (`clearRevoked()`) isn't settled as one unit either — a failed
clear leaves `claimOwnership()` reporting success while `isOwner()` still
returns false; `getTabId()`/`rotateTabId()` silently tolerate a failed
`sessionStorage` persist and hand back a never-saved ephemeral id anyway,
so a claim can commit under an id that vanishes on the very next read; and
`readEnvelope()` collapses "storage read threw" and "no envelope exists"
into the same `null`, so a broken read gets treated as a free-to-claim
fresh session. **Verdict: stop patching this shape, redesign the
subsystem.**

**The diagnosis, independently confirmed**: every one of these five bugs is
the same shape — a multi-step commit spread across two separate Storage
objects (`sessionStorage` + `localStorage`), which Web Storage gives no
cross-key atomicity for. Every fix narrowed the failure window without
removing the shape that keeps producing new instances of it.

## 🔧 Next up — implement the fenced-lease redesign (planned, not yet coded)

**A complete, function-by-function redesign has been written to the
plan-mode scratch file:**
```
/home/renedebos/.claude/plans/dynamic-hugging-rossum.md
```
— specifically its **"Blocker B, redesigned: single-commit fenced lease
(2026-08-15)"** section (the original "Blocker B" design is kept
immediately below it, superseded, for history). **This is NOT yet folded
into the repo's permanent `plans/player-consolidation/player-consolidation-plan.md`**
— that's part of the implementation work, matching this project's
established pattern of folding scratch-plan design work into the
permanent docs once it ships (see how the original 5-round design and the
round-1/round-2 implementation reviews were folded in prior sessions).

**Do not patch the pending-token bug (round 5) or the three
interactive-session findings individually.** The whole point of the
redesign is to remove the multi-step-transaction shape that keeps
producing new instances of the same bug, not add a sixth patch.

**The core of the design**: `claimOwnership()` becomes exactly **one**
`localStorage.setItem()` call — no second-store write is ever part of the
commit, so there's nothing to roll back, ever. The fencing credential
(`{ownerId, ownerEpoch}`, a "lease") is **never persisted to
`sessionStorage`** — it lives only in the caller's JS memory (naturally
wiped by navigation, which is exactly the lifetime a "was this write
issued under the still-current claim" check needs) and is *re-derived* on
a fresh page load by reading the one durable envelope. `writeSession()`
now takes that lease explicitly and rejects any write where it no longer
matches the current envelope — this is what makes a delayed/stale write
from a superseded claim structurally impossible to land, closing round
5's actual bug at the root. Revocation becomes epoch-scoped (compare a
specific value, never a boolean that must later be cleared — a fresh
epoch automatically supersedes an old revocation with no clear operation
to fail). Tab-identity establishment becomes strict (fail closed instead
of silently ephemeral). `readEnvelope()` gains a third state
(`'unavailable'`) distinct from `'absent'`. A new, optional, provably-safe
`tombstoneIfCurrent()` (fenced through the same lease-check `writeSession()`
uses, so a losing tab's tombstone can never stomp a fresher legitimate
claim) replaces the old unsafe idea of writing to the shared envelope from
the losing side directly.

**One explicit, flagged judgment call in the plan**: removes the
"best-effort, unlocked" fallback when Web Locks isn't available, failing
closed to no persistent ownership for that document instead of running a
known-racy protocol. Codex's recommendation; Claude agrees; not yet
re-confirmed with Rene beyond the plan-mode review (the `ExitPlanMode`
approval UI call itself failed twice with a stream error, but the harness
shows plan mode exited — worth a quick explicit sanity-check with Rene
before treating this specific behavior change as fully signed off, even
though the plan document itself is complete and was presented for
review).

**The plan file has, in full**: exact storage keys, exact function
signatures + algorithms for every changed/new function
(`establishTabId`/`peekTabId`/`rotateTabId`, the tri-state `readEnvelope`,
`isEpochRevoked`/`revokeLease`, `hasValidLease`/`restoreLease`,
`claimOwnership`, `writeSession`, `tombstoneIfCurrent`,
`withOwnershipLock`), a migration table (old export → new
export/signature), a curated critical-test list (9 highest-value tests
explicitly named, full ~62-item list referenced as living in the design
session), and an honestly-documented residual-gaps section (every
remaining gap now requires *two* independent write failures with no
successful write in between, not one — narrower and qualitatively
different from every prior round's leftover).

**After implementing**: prove each critical test fails against a reverted
copy of the old code before restoring the fix (this project's established
regression-proof standard — `cp` backup/revert/restore, not `git stash`,
given multi-round uncommitted edits). Re-verify `build.py --check`,
`build.py`, all `test-*.mjs` suites. Fold the finalized design into
`player-consolidation-plan.md` (replacing/annotating the current Phase 3
ownership section) and record it in `-codex.md`. **Then run at least one
more `/review-step` round on the redesign itself** before considering the
ownership subsystem settled — given the track record (3 of the last 3
automated rounds plus the interactive session each found something real),
treat a clean round as encouraging, not conclusive, until it happens.

Only after the ownership subsystem is genuinely settled: commit Stage
3a-foundation (currently 100% uncommitted), then proceed to **3a-canary**
(ship the dormant mini-player container/script) per the plan's Phase 3
section.

## Gotchas learned this session

- **When the same bug shape recurs across 3+ independent review rounds,
  the fix is at the wrong level — stop patching instances, find the
  pattern.** Every round-3/4/5 fix in `claimOwnership()` was a real,
  correctly-verified fix for the specific failure it targeted, and every
  one left behind a narrower version of the identical shape (a multi-step
  commit across two Storage objects, with a rollback that can itself
  fail). The tell was structural, not a matter of trying harder on the
  next patch: as long as ANY function tries to keep two separate storage
  locations in agreement via write-then-maybe-roll-back, there will always
  be a "the rollback itself fails" case left over. The fix was to redesign
  so there's only ever ONE commit point (a single `setItem()` call, atomic
  by spec for one key) and derive everything else from reading it fresh,
  not to get better at rolling back.
- **A comparison function's input distribution matters as much as the
  comparison logic itself.** `shouldRotateOnCollision()`'s symmetric
  nonce tie-break was correctly designed and correctly tested in
  isolation (given two arbitrary nonces, it produces a fair,
  complementary decision) — but the REAL nonces it was fed shared a
  `Date.now()`-prefixed format inherited from a sibling function where
  that format was harmless (only ever compared for equality there). The
  bug was invisible by reading the comparison function alone; it only
  showed up by reproducing the actual generator feeding it real,
  time-separated values.
- **Skipping the `/review-step` → `/apply-review` gate, even when the
  findings are correctly verified, is a real process violation, not a
  harmless shortcut.** Implementing round 4's fixes immediately after
  verifying them (instead of reporting and waiting for an explicit
  `/apply-review`) meant Rene never got the chance to weigh in before code
  changed. Caught and corrected for round 5 (verified, reported, stopped,
  waited for explicit direction).
- **An external, interactively-run Codex review (pasted into chat, not
  from `codex_review.sh`) still needs the exact same independent
  verification standard as an automated round** — traced all four of its
  claims against the actual code with standalone repro scripts before
  accepting any of them, same as every `codex_review.sh` round this
  project has run.
- Carried forward (still true): `git stash` can't cleanly target files
  with uncommitted changes across multiple edit rounds — use the `cp`
  backup/revert/restore pattern. Node's CI runner (>=21) has a getter-only
  `navigator` global — use `setGlobalNavigator()`, not a plain assignment,
  in new test files. A Codex review round only reviews what you scope it
  to — a narrow, explicit "verify these specific fixes" framing on a
  follow-up round finds real gaps; "review the branch again" risks
  re-litigating settled points.

## Durable facts (don't undo)

- **Everything under "Durable facts" in this file's Phase-1/Phase-2-era
  versions is unchanged and still true** (see git history: `downloads.lossless`,
  recording-id keying, BroadcastChannel wire format basics, deep-link
  autoplay, WaveSurfer failure blast radius, the controller's `<audio>`
  element never being pre-appended, the flat `savedPlaylists` key,
  `syncHash()`'s query-string-dropping quirk).
- **The BroadcastChannel wire-format upgrade (bare string →
  `{version,type,senderId}`) is explicitly out of Phase 3 entirely**,
  tracked as a separate future initiative.
- **Phase 3's mini-player replaces `/player/` entirely** once it reaches
  parity and passes a full 2+ week production soak after Stage 3b ships —
  `/player/` becomes a lightweight compatibility redirect afterward. This
  tradeoff (losing the popup's only genuinely gapless cross-page mechanism)
  is deliberate and recorded, not an oversight.
- **`player.js:217`'s `initLegacyPlayback()` fallback and
  `initCustomPlayers()`'s per-row engine are not being deleted in Phase
  3** — deliberate degraded-mode safety nets referenced by the readiness
  contract.
- **Nothing in `scripts/miniplayer-state.js` is wired to any live boot
  script yet** — pure, unit-tested logic ahead of its first real consumer.
  Its exports are about to change substantially under the fenced-lease
  redesign (see "Next up") — don't be surprised the current exports
  (`CLAIM_TOKEN_KEY`, `PENDING_CLAIM_TOKEN_KEY`, `isOwner`, `getTabId`,
  etc.) are slated for removal/replacement, that's expected and planned.
- **The tab-collision handshake** (`generateNonce`, `isTabProbeCollision`,
  `isTabProbeReplyForMe`, `shouldRotateOnCollision`, `resolveCollision`,
  `handleIncomingProbe`, `handleIncomingProbeReply`) **is NOT part of the
  redesign** — considered solid after rounds 3–4, out of scope, keep as-is.
- Branch/worktree workflow: sync with `git fetch origin && git merge
  origin/main` at session start and before a PR.

## Reference
Runbook: `CLAUDE.md` → "Publishing a Split Show" (unrelated to this
initiative, but the canonical project-wide instructions file). Player
work: `plans/player-consolidation/` (plan doc + `-codex.md` for every
review round's findings/dispositions/fixes). **The fenced-lease redesign
plan lives OUTSIDE the repo**, at `/home/renedebos/.claude/plans/dynamic-hugging-rossum.md`
— read this first before touching `miniplayer-state.js` again; fold it
into the permanent docs as part of implementing it. Tests: `node
scripts/test-*.mjs` (8 files; `test-fake-dom.mjs` is a helper, not a
suite) — 198/198 passing as of this handoff, against the OLD (pre-redesign)
ownership code, which still has the known unfixed bugs described above.
Real-browser verification: `scripts/browser_check.mjs` (needs
`playwright-chromium`; `--prod` points it at `https://renedebos.com`).
