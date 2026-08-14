# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-08-13 · **Branch:** `player-consolidation`
(worktree `/home/renedebos/renedebos.com-player-consolidation`)

Three commits, working tree clean, **nothing pushed and nothing deployed** —
the new player engine exists in the build but no generated page loads it yet,
so the live site is unaffected. The previous session's audio-processing
handoff is in git history.

- `2c841b9` — Player consolidation Phase 1 steps 1–3
- `ccac16a` — Codex review automation
- `053ba69` — Codex review-file consolidation (not authored this session)

## ✅ Done this session

### Player consolidation — Phase 1 (show pages), steps 1–3 of 5

Plan is `plans/player-consolidation/player-consolidation-plan.md`, now the one
living document for the whole initiative (architecture + concrete design +
running checklist, revised in place — no per-phase files).

- **`scripts/player-controller.js`** — one `PlaybackController` per document
  owning the sole `<audio>` element, queue, transport, shuffle/repeat, the
  BroadcastChannel claim, Media Session, an explicit state machine, and a
  generation token invalidating stale `play()` promises. Adds `'error'`
  handling no existing engine has (a hard load failure previously left the row
  spinning forever) and ports `removeAt()`'s exact legacy slide-in semantics.
- **`scripts/player-views.js`** — compact (track row) and hero (recording card)
  views. Only the *active* row upgrades to a WaveSurfer instance wrapping the
  shared audio element; others draw an inert canvas from precomputed peaks,
  replacing one WaveSurfer per row on page load.
- **`data-item` markup** on every show page — one normalized playable item per
  playable thing, serialized at build time (zero round trips). Purely additive:
  stripping it reproduces the previous HTML byte for byte.
- **`scripts/verify_markup.py`**, run from `build.py` on every build — required
  fields, per-page id uniqueness, and `streamUrl` parity with the legacy
  `data-src` so the new engine cannot play different audio.
- **`validate()` now enforces per-track peaks coverage** — a show's peaks file
  makes every row a waveform row, which has no range input, so a track missing
  from that map would render with no seek surface at all.
- **37 deterministic tests** (`node scripts/test-player-controller.mjs` 22/22,
  `test-player-views.mjs` 15/15) — no browser, via a fake audio element and
  fake DOM, with fixtures mirroring the real generated markup.

### Review automation (Claude ⇄ Codex)

- **`scripts/codex_review.sh <plan-file> [focus]`** — runs `codex exec`
  read-only and appends the result to the plan's sibling `*-codex.md`. Pins to
  the current worktree (`-C`), fingerprints the tree before/after so a review
  whose code moved is flagged, locks against concurrent runs, aborts rather
  than appending empty output. Generic path derivation, so future `plans/`
  initiatives work unchanged.
- **`/review-step`** (reviews, verifies each finding against the code, records
  a disposition in the log, **stops**) and **`/apply-review`** (implements after
  approval). Deliberately split so the judgment step stays human-gated.

## 🔧 Next up — Phase 1 Step 4

**Read the plan's Step 4 before starting; its design was materially reworked
after review and differs from earlier drafts.**

- **Legacy defers, controller claims.** `player.js` moves its init to
  `DOMContentLoaded`; `player-boot.js` (a module, guaranteed to run first)
  mounts inside `try`/`catch` and sets a marker; legacy checks the marker and
  takes over if unset. A static "don't init" flag would leave the page
  **silent** on any module/asset failure — worse than today, where a
  wavesurfer failure still leaves Full Recording working.
- **Gate all three legacy playback registrations**, not just the mount:
  `initCustomPlayers` (`player.js:173`), the Space handler (`:175-190`), and
  `focusHashTrack`'s load/hashchange listeners (`:579-601`). Downloads, share,
  and tooltips are not playback — leave them alone.
- Verification includes **deliberately breaking the module** (rename the asset)
  to confirm fallback to a working legacy player.
- Step 4 is gated to an allowlist of show slugs; Step 5 flips it on and deletes
  only `wavesurfer.js` (**not** `initCustomPlayers` or the claim globals —
  `songs.js` and `/playlist/` still need them until their own phases).

## Gotchas learned this session

- **A test can pass for the wrong reason.** The retry test passed because it
  simulated a *native* error (populating `audio.error`) while the state half of
  the condition was dead code; a rejected `play()` promise — which sets `error`
  without `audio.error` — was silently unprotected. The habit now: after
  writing a regression test, **revert the fix and confirm the test fails**.
- **Vendored WaveSurfer strips the `src` if constructed too early.** It
  captures `options.url || getSrc()` at construction and defers `load()` to a
  microtask; built before `audio.src` is assigned, its `setSrc("", peaks)`
  calls `removeAttribute("src")` and kills playback. `_playIndex` therefore
  orders: assign src → notify views → `play()`.
- **Review claims need tracing, not trusting.** Two Codex claims this session
  were factually wrong about repo state, several suggestions were correctly
  declined, and the genuinely valuable findings only surfaced because claims
  were checked against code. This is why `/review-step` stops before applying.
- **Verify generated output, not just that the build is green.** The one-off
  markup check caught a real recording-id collision (`mad-sweetwater-2000-10-17`
  has a WAV *and* a FLAC transfer sharing one MP3 stream proxy) that inspection
  had missed — hence `verify_markup.py` now runs on every build.
- `codex exec` needs `-o` to capture a clean final message; the module-level
  `BroadcastChannel` keeps Node alive, so the test scripts exit explicitly.

## Durable facts (don't undo)

- **`downloads.lossless` carries an R2 key, not a URL.** `/stream` hard-403s
  every `.wav`/`.flac`, so a stream URL there is an address guaranteed to fail;
  the legacy button's href only *looks* like one because `player.js` intercepts
  the click. Named `lossless`, not `flac` — 64 of 747 items are WAV.
- **Recording ids key on the lossless original**, not the stream key, which is
  not unique across transfers of one tape.
- **No BroadcastChannel wire-format change until `/playlist/` and `/player/`
  migrate** — the legacy engines still expect a bare string, and cross-tab
  claim/pause between old and new pages is real, tested behavior.
- Loudness control and sticky navigation remain **fully deferred**; see the
  plan's §2 and §5. The mp3TruePeak headroom data (only 18/680 tracks have
  +4 dB of headroom) is banked there for whenever loudness is scoped.
- Branch/worktree workflow is the plan's §8; sync with
  `git fetch origin && git merge origin/main` at session start and before a PR.
  **Not done this session.**

## Reference
Runbook: `CLAUDE.md` → "Publishing a Split Show". Player work:
`plans/player-consolidation/` (plan + `player-consolidation-codex.md`, six
review passes with dispositions). Review loop: plan §7.
