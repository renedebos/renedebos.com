# Player consolidation: Feature Proposal

Status: proposal — not yet built. Mockup: https://claude.ai/code/artifact/71ae2166-d3ed-471d-9719-abd73fe353ba
Reviewed by Codex — see `player_consolidation_codex.md` in this folder. This
revision folds in its accepted findings (noted inline) and trims its
process-heavy asks (formal test suite, cross-browser QA matrix) down to
something proportionate for a two-person hobby project.

## 1. Objective

Replace the site's four independent audio players with one shared
implementation, rendered at different densities depending on context. Add a
client-side loudness control and a small set of other player functions along
the way.

**Clarified scope (Codex catch):** "one component" means one shared
implementation, not one browser-wide `<audio>` element. A normal page and the
`/player/` popup are separate documents and cannot share an in-memory audio
engine — each document gets its own controller instance, built from the same
module/state schema, still coordinated by `BroadcastChannel`. *Within* one
document, the target is one playback engine with multiple views — a show
page with many track rows plus a hero view should not create an audio graph
per row.

**Success criterion:** all current playback and handoff behavior survives
(see the parity checklist in §3), every document has at most one active
playback engine, and density changes affect presentation only, not
media/queue semantics.

## 2. Proposed Architecture & System Design

### The problem today

The site currently runs four independent audio engines, each with its own
markup, its own `<audio>` element, and its own logic:

1. `scripts/player.js` — show-page track rows (`.custom-player`), waveform
   via `scripts/wavesurfer.js`, peaks pre-computed
2. `scripts/player.js` — the "Full Recording" whole-show player
3. `scripts/playlist.js` — `/playlist/`, curated multi-show queues
4. `scripts/continuous-player.js` — `/player/`, reads a `#p=...` hash queue

`scripts/songs.js`, `scripts/track-select.js`, `scripts/sitegen/fragments.py`,
`scripts/sitegen/pages.py`, and `scripts/build.py` also participate in
creating players or handing queues between them — this is wider than a
markup migration.

They're coordinated only by a `BroadcastChannel('hannan-playback')`
claim/pause protocol so two don't play at once — that's cross-tab conflict
avoidance, not a shared component. Each has to be fixed/extended four times
for the same change.

There are also existing lifecycle races worth designing out rather than
carrying forward: a `play()` promise can resolve after the user has picked
another track or another tab has claimed playback, and lazily-rendered song
rows add listeners with no unsubscribe path today. The shared engine should
use a generation token to ignore stale async results and give views an
explicit mount/destroy API.

### Proposal: controller + views, three densities

- A `PlaybackController` per document owns the sole `<audio>` element, queue,
  current item/index, repeat/shuffle state, Web Audio graph, playback claim,
  Media Session integration, persistence, and error state.
- Compact, hero, and mini `PlayerView` instances subscribe to controller
  state and dispatch commands. They do not own media elements or audio
  graphs. A playing item can be reflected in its compact row *and* a
  mini/hero view simultaneously without duplicating playback.
- The `/player/` popup gets its own controller (separate document) using the
  identical module and state schema.
- A small explicit state machine (`idle`, `loading`, `playing`, `paused`,
  `ended`, `error`) replaces icon-state changes scattered across event
  handlers.

Define a normalized playable-item schema before building views: stable ID,
kind (`track` or `whole-show`), stream key/URL, version, title, artist,
date/venue, duration if known, peaks reference if available, canonical page
URL, and authorized download choices. A hero view represents both a lone
whole-show recording and a queued `/player/` track — those don't share
identical metadata today, so this needs to be resolved explicitly.

Control-matrix decisions still open:

- The hero's prev/next only make sense for a queue, not a lone full
  recording — hide/disable based on queue state.
- **Download policy:** FLAC is the protected/gated download; MP3 is the
  ungated streaming proxy and isn't currently presented as a download.
  "FLAC/MP3 download" in the mockup conflicts with that boundary — preserve
  the existing split unless changing it is a deliberate, separate decision.
- Repeat-one must take precedence over queue auto-advance/reshuffling;
  turning it off restores the previous queue mode.
- "Persistent mini bar" means sticky *within* the current page unless
  site-wide sticky navigation is separately approved (see §5).
- The existing playlist-selection bar also sits at the bottom of pages —
  define stacking/overlap behavior if both are present.

For waveforms: avoid one WaveSurfer instance per compact row when a single
controller owns playback. Precomputed peaks can render as inert
canvas/SVG for non-active rows, upgraded to an interactive seek surface only
for the active one; defer off-screen rendering with `IntersectionObserver`.

### Loudness control

Not a remaster — a live, client-side gain stage, so it never touches the
stored master. **Revised after review — the original "brick-wall, never
clips" claim overstated what a `DynamicsCompressorNode` guarantees.**

- `DynamicsCompressorNode` has threshold/ratio/attack/knee, but no output
  ceiling guarantee — it doesn't provably keep true/inter-sample peaks under
  a chosen bound. Don't promise "never clips" on that basis alone. A real
  guarantee needs either a tested look-ahead limiter (likely an
  `AudioWorklet`) or a deliberately conservative gain derived from each
  track's known peak headroom. If a plain compressor ships first, describe
  it as overload *protection*, not a limiter, and validate worst-case
  overshoot before calling it safe.
- **Archive mode needs a true bypass**, not "gain node at 0 dB through the
  compressor" — routing archive-target audio through a compressor with a
  threshold near −1 dBFS can still alter tracks that reach that threshold
  even at unity gain. Bypass dynamics processing entirely for Archive mode
  (a direct `MediaElementAudioSourceNode → destination` branch).
- Set `audio.crossOrigin = "anonymous"` **before** assigning the (cross-
  origin) stream URL — otherwise `createMediaElementSource()` can be
  silenced by CORS. The production Worker already emits the right headers;
  local/preview hosts need the same treatment, including on Range responses.
- One lazily-created `AudioContext` per document, resumed synchronously from
  the user's play/loudness gesture; handle `suspended`/interrupted states.
- If Web Audio is unavailable/blocked, Archive playback must still work
  through the native media element, with boosted modes simply unavailable —
  a loudness feature must never make a previously playable recording silent.
- Convert dB to gain with `10 ** (dB / 20)`, ramp over ~20–50 ms when
  switching modes to avoid clicks.
- Open question, not yet decided: is loudness mode global, per-queue, or
  per-item — and does it persist / sync with the popup?
- The −20/−16/−14 numbers in the mockup are illustrative only. Before
  finalizing them: test against real corpus material, including
  transient-capped tracks and tracks that already sit close to −20 without
  headroom — a fixed dB boost does not produce a fixed output LUFS across
  material with different starting loudness. Consider a conservative default
  or first-use notice given headphone-volume risk on "Loudest."

### Why one component is worth it regardless of the sticky-navigation question below

Agreed by review. This refactor has value without navigation changes. Build
order: extract and prove the controller first, adapt existing views to it,
*then* replace markup — keeps behavior parity observable instead of
combining engine, UI, and navigation changes in one step.

## 3. Technical Details

**Files in scope:** `scripts/player.js`, `scripts/playlist.js`,
`scripts/continuous-player.js`, `scripts/wavesurfer.js`, `scripts/songs.js`,
`scripts/track-select.js`, `scripts/site.css` / `scripts/home.css` (two
token systems the component must work under — see root `CLAUDE.md`), and the
generators in `scripts/sitegen/` (`fragments.py`, `pages.py`) plus
`scripts/build.py`. `worker/index.js` enters scope only if CORS or stream
metadata needs to change. Generated output under `assets/`, `/playlist/`,
`/player/`, show pages, and song pages gets rebuilt, never hand-edited.

**Migration-parity checklist (Codex catch, verified against the actual
code — all of these are real, working behavior today, not hypothetical):**

- waveform-row and curated-list auto-advance
- shuffle and endless-queue mode (`playlist.js`, `continuous-player.js`)
- saved playlists (`localStorage`, `playlist.js`'s `SAVED_KEY`)
- `/player/` queue/position restoration from `localStorage` (`STATE_KEY`)
- Media Session metadata + lock-screen/headset actions (both `playlist.js`
  and `continuous-player.js` wire `navigator.mediaSession`)
- add-to-player / playlist-selection handoffs (`track-select.js`)
- deep-linked tracks and the current `?autoplay=1#track-N` behavior
- password-gated single and batch downloads
- alternate recordings, stream-only items, items with no known duration
- loading/stalled/rejected-play/missing-file/decode-error states

**Other functions:**

- **Share timestamp** — copies a link that opens straight to the current
  second. Needs one canonical URL grammar across queued tracks, show-page
  tracks, and whole shows — the site already uses `#p=id,...`, `&t=...`,
  `#track-N`, and `?autoplay=1`; a timestamp scheme must not collide with
  those or break existing short playlist links.
- **Repeat** — restarts the current track on end instead of advancing the
  queue. Plain repeat-one, not a loop-region editor.
- **Keyboard shortcuts** — `space` play/pause, `←`/`→` seek ±5s, `↑`/`↓`
  next/prev in queue. Scope shortcuts to an active/focused player; ignore
  links, inputs, selects, `contenteditable`, and modifier chords — global
  Up/Down would otherwise fight page scrolling and assistive-tech
  conventions.

**Boundaries to keep, not re-litigate here:**

- Download authorization (password verification, token expiry, filename
  authorization, WAV/FLAC rejection on `/stream`) stays entirely
  server-side, exactly as today — the player UI never becomes the security
  boundary.
- Treat URL fragments, query params, `localStorage`, and `BroadcastChannel`
  messages as untrusted input the same way the current code already should:
  validate IDs against the catalog, clamp indices/times/gain, bound queue
  length.
- Continue escaping metadata (`textContent`/DOM construction, not
  interpolated `innerHTML`).

**Practical performance notes (fold into the build, not a separate
workstream):**

- One audio graph per document, never one per row.
- Don't make a full-show waveform analyze/download an entire recording on
  page load — use precomputed peaks (already the pattern for track rows) or
  omit the waveform until they exist.
- Update visible/subscribed views only; run any `requestAnimationFrame`
  progress loop only while playing, stop it on pause/hidden/teardown.

**Verification:** manual spot-check on Safari, Chrome, and Firefox before
shipping — matching how the rest of this project already ships (build fails
the integrity checks, then a manual check on the live site). Not proposing a
formal automated test suite or CI browser matrix; that's disproportionate
for this project's size, even though the individual technical points above
(CORS ordering, bypass path, audio-graph-per-document) are worth getting
right regardless.

## 4. Rejected / Out of Scope

- **Playback speed control** — doesn't apply to this archive (live acoustic
  recordings, not spoken word/lecture content).
- **Loop-region (drag-select a span to repeat)** — not useful for this use
  case; replaced by the simpler repeat-one above.
- **SPA/client-side navigation and iframe-shell work** — see sticky
  navigation in §5; a separate decision.
- **Cross-device playback sync, server-side remastering, in-browser EQ/
  crossfade/loudness analysis, per-track user presets, and any redesign of
  the download-authentication policy** — all out of scope for this pass.

The existing `/player/` popup is **not** out of scope in the sense of being
disposable early — it's the current practical mechanism for uninterrupted
listening while browsing, and stays functional until/unless a separate
sticky-navigation project replaces it.

## 5. Open Questions

- **Sticky playback across page navigation.** Consolidating the player does
  **not** by itself make playback survive clicking to another page. The
  site is a static multi-page site (`scripts/build.py` generates full
  separate HTML pages) — every internal link is a full page load, tearing
  down all JS state including any playing `<audio>` element. This is true
  of the *current* four-player setup too. A service worker alone doesn't
  fix this either — it can't preserve a live audio element across a full
  document navigation. The `/player/` popup is the current, lower-risk
  workaround and should be treated as the baseline during consolidation. If
  client-side navigation is pursued later, it needs its own scope covering
  History/`popstate`, scroll/focus restoration, title/meta updates,
  same-origin URL filtering, and a real-navigation fallback on error — a
  genuinely separate architectural decision, not a side effect of this one.
- **Runtime granularity:** one controller with many views (recommended), or
  a simpler reusable view class that still owns one audio element per
  instance?
- **Mini bar scope:** sticky on `/playlist/` only, or site-wide? Site-wide
  is part of the sticky-navigation decision above, not this one.
- **Hero queue semantics:** what does prev/next mean for a standalone
  whole-show recording with no queue?
- **Which playlist features surface in the mini/expanded states** — shuffle,
  queue editing, saved playlists, endless mode, open-in-popup?
- **Loudness control default/options** — −20/−16/−14 were illustrative,
  not yet validated against real listening across the corpus.
- **Loudness/repeat persistence** — per-item, per-queue, or global? Shared
  with the popup or reset per document?
- **Web Audio fallback** — confirmed behavior when Web Audio/CORS is
  unavailable (Archive-only, boosted modes disabled, per §2).

## 6. Implementation Steps

- [x] Codex review — findings recorded in `player_consolidation_codex.md`,
      accepted findings folded into this revision
- [ ] Turn the migration-parity checklist (§3) into a literal pre/post
      migration test list
- [ ] Decide sticky-navigation scope — recommended: separate project,
      preserve `/player/` as the baseline in the meantime
- [ ] Specify the per-document controller, playable-item schema, and view
      subscribe/teardown API
- [ ] Decide mini-bar scope and its interaction with the playlist-selection
      bar
- [ ] Prototype the Web Audio path against the production Worker with
      `crossOrigin` set before `src`
- [ ] Choose the real limiter strategy (or explicitly weaken the no-clip
      claim); implement the Archive bypass and the no-Web-Audio fallback
- [ ] Measure candidate loudness gains against representative and
      worst-case archive tracks
- [ ] Define the timestamp URL grammar against existing `#p=`/`&t=`/
      `#track-N`/`?autoplay=1` usage
- [ ] Extract the shared controller/queue/Media Session/keyboard logic while
      keeping current markup, to prove parity before touching UI
- [ ] Build the compact density on the shared controller, lazy/lightweight
      waveforms
- [ ] Build the hero density, including conditional queue controls
- [ ] Build the mini density
- [ ] Migrate `/playlist/` and `/player/` onto the new component without
      losing shuffle, saved queues, restore, or Media Session behavior
- [ ] Manual spot-check on Safari/Chrome/Firefox, mobile and desktop
- [ ] Remove the old four engines and duplicated markup once parity holds
