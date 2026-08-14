# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-08-13 · **Branch:** `player-consolidation`
(worktree `/home/renedebos/renedebos.com-player-consolidation`)

Working tree clean, **nothing pushed and nothing deployed**. Merged
`origin/main` at session start (one conflict, in `HANDOFF.md` itself —
resolved in favour of this branch's handoff; the audio-processing handoff it
replaced is in git history).

Three show pages now load the new player engine in the *built* output. The
live site is still entirely on the legacy engines, because none of this has
been pushed.

## ✅ Done this session — Phase 1 Step 4 (`player-boot.js`)

Plan: `plans/player-consolidation/player-consolidation-plan.md` (Step 4's
entry there has the full record). Steps 1–3 were the previous session's.

**Engine selection: legacy defers, controller claims.** An allowlisted show
page emits `window.PLAYER_ENGINE = 'controller'` inline before `player.js`.
Both legacy engines then hold their playback init until `DOMContentLoaded` and
check `window.PLAYER_ENGINE_MOUNTED`; `player-boot.js` is a module, so it runs
first, mounts inside `try`/`catch`, and sets that flag only on success. A 404,
a parse error, or any boot exception therefore falls back to today's working
player at *runtime*, not just at deploy time.

- **`scripts/player-boot.js`** — mounts one `PlaybackController`,
  `CompactPlayerView` per `.track-list [data-item]` row and `HeroPlayerView`
  per `.recording-item[data-item]`, then wires peaks, Space, deep links, and a
  debounced resize redraw.
- **`wavesurfer.js` is gated too** — the plan said "three legacy registrations
  in `player.js`" and that was one short. Every published show has a peaks
  file, so every show-page track row is `.ws-track`, and `.ws-track` is
  invisible to `player.js`. Gating only `player.js` would have made a boot
  failure degrade to a page with a working Full Recording card and **no track
  players at all** — the exact silent degradation this step's redesign exists
  to prevent.
- **Allowlist** `pages.CONTROLLER_ENGINE_SLUGS`: `jerry-cafe-java-1999-05-27`
  (plain), `jerry-cafe-java-1999-03-25` (two hero cards), and
  `mad-sweetwater-2000-10-17` (alternate transfer sharing a stream proxy,
  inside a collapsed `<details>`).
- **`verify_markup.py` now checks the handshake**, not just the markup: flag
  and boot module travel together, only on allowlisted slugs, flag before
  `player.js`, `player.js` still on the page (it *is* the fallback) — plus
  that every `/assets/` script a page loads, and everything those scripts
  import, is actually written by `build.py`.
- **`scripts/test-player-boot.mjs`, 14 tests**, on a fake show-page document;
  DOM fakes extracted to `scripts/test-fake-dom.mjs`, shared with the view
  tests. Suite total 51 (22 + 15 + 14), all passing.
- Small supporting additions: `page_shell(pre_scripts=...)`,
  `PlayerView.setPeaks()` / `redrawWave()`, `window.PLAYER_BOOT` as a console
  handle.

## 🔧 Next up — the browser pass, before anything else

Step 4 is code-complete but **its verification gate is open**, and no browser
exists in the environment that built it. On the three allowlisted pages:

1. Full parity checklist (plan §3) — play/pause, seek, auto-advance, deep
   links, downloads, cross-tab claim/pause against `/playlist/`.
2. Exactly one engine mounted — `window.PLAYER_BOOT` in the console; no
   duplicate listeners on a row.
3. **Deliberately 404 the module** (rename `assets/player-boot.js`) and
   confirm the page falls back to a *working* legacy player, waveform rows
   included — not to an inert page.

Only then Step 5 (flip the allowlist on everywhere, delete `wavesurfer.js`).
Note what Step 5 actually costs: deleting `wavesurfer.js` gives up the
waveform half of the runtime fallback, leaving `player.js`, which can only
drive the recording cards.

## Gotchas learned this session

- **`document.readyState` is not a shortcut for the DOMContentLoaded
  barrier.** It is already `'interactive'` while deferred and module scripts
  run, so an "if we're past loading, just initialize" branch fires the legacy
  engine *before* a later module can claim the page — double-initializing
  exactly what the flag prevents. Written into both gates as a comment; I
  added that branch and had to take it straight back out.
- **A mutation test can be vacuous.** The partial-mount teardown test passed
  with the teardown deleted: the fixture's malformed item was on a *row*, and
  rows are all normalized before anything mounts, so nothing had ever been
  torn down. It has to be on a **hero** card (mounted after every row) to
  exercise that path. Same family as last session's "test passed for the wrong
  reason" — reverting the fix is the only way to find out.
- **The marker must be set synchronously, so peaks can't gate the mount.**
  DOMContentLoaded beats any fetch. Rows mount peak-less and get decorated
  when the fetch lands.
- **An empty peaks object is not the same as no peaks.** A `.ws-track` row has
  no range input, so a row left with `null` peaks loses its waveform *and* its
  only seek surface; `{}` makes WaveSurfer decode the audio to draw, which is
  what `wavesurfer.js`'s own fetch-failure path already does.

## Durable facts (don't undo)

- **`downloads.lossless` carries an R2 key, not a URL.** `/stream` hard-403s
  every `.wav`/`.flac`. Named `lossless`, not `flac` — 64 of 747 items are WAV.
- **Recording ids key on the lossless original**, not the stream key, which is
  not unique across transfers of one tape.
- **No BroadcastChannel wire-format change until `/playlist/` and `/player/`
  migrate** — the legacy engines still expect a bare string, and cross-tab
  claim/pause between old and new pages is real, tested behavior.
- **Deep-link autoplay fires on initial load only**, deliberately — exact
  parity with what the two legacy engines produce between them today.
- Loudness control and sticky navigation remain **fully deferred**; see the
  plan's §2 and §5. The mp3TruePeak headroom data (only 18/680 tracks have
  +4 dB of headroom) is banked there.
- Branch/worktree workflow is the plan's §8; sync with
  `git fetch origin && git merge origin/main` at session start and before a
  PR. **Done this session.**

## Reference
Runbook: `CLAUDE.md` → "Publishing a Split Show". Player work:
`plans/player-consolidation/` (plan + `player-consolidation-codex.md`, six
review passes with dispositions). Review loop: plan §7. Tests:
`node scripts/test-player-{controller,views,boot}.mjs`.
