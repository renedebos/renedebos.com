# Player consolidation: Codex review

Status: review of `player-consolidation-plan.md` against the current generated markup and the playback code in `player.js`, `wavesurfer.js`, `playlist.js`, and `continuous-player.js`.

## 1. Objective

The consolidation is worth doing. The current duplication is already visible in icon definitions, queue operations, keyboard handling, playback error handling, Media Session support, and cross-tab coordination. A shared implementation should make future fixes much safer.

The objective needs one important clarification: **one component should mean one shared implementation, not one browser-wide `<audio>` element**. A normal page and the `/player/` popup are separate documents and cannot share an in-memory audio engine. Each document can have one controller instance while importing the same controller/view code. `BroadcastChannel` is still needed between documents.

Within one document, the target should be one playback engine and multiple views. A show page can contain many compact rows plus a hero view, but it should not create an `AudioContext`, media element, limiter, and event stack for every row. Otherwise the design consolidates source code without consolidating runtime cost or state.

The plan also needs an explicit parity list. The control table omits existing behavior that could be lost during migration:

- waveform-row and curated-list auto-advance;
- shuffle and endless-queue behavior;
- saved playlists and queue editing;
- `/player/` queue/position restoration from `localStorage`;
- Media Session metadata and lock-screen/headset actions;
- add-to-player and playlist-selection handoffs;
- deep-linked tracks and the current `?autoplay=1#track-N` behavior;
- password-gated single and batch downloads;
- alternate recordings, stream-only items, and items with no known duration;
- loading, stalled, rejected-play, missing-file, and decode-error states.

A concise success criterion would be: all current playback and handoff behavior survives, every document has at most one active playback engine, and density changes affect presentation rather than media/queue semantics.

## 2. Proposed Architecture & System Design

### The problem today

The diagnosis is accurate, but the scope is wider than `scripts/player.js` and generated markup. The four engines currently live in:

1. `scripts/player.js` for `.custom-player` instances;
2. `scripts/wavesurfer.js` for waveform rows;
3. `scripts/playlist.js` for `/playlist/`;
4. `scripts/continuous-player.js` for `/player/`.

`songs.js`, `track-select.js`, `sitegen/fragments.py`, `sitegen/pages.py`, and `build.py` also participate in creating players or handing queues between them. Treating this as mostly a markup migration would leave substantial duplication behind.

There are also lifecycle races worth designing out. A `play()` promise may resolve after the user has selected another track or after an external playback claim. Lazy-rendered song rows can add listeners after page load, while the current global `claimListeners` array has no unsubscribe path. The shared engine should use an operation/generation token to ignore stale asynchronous results and offer explicit `mount`/`destroy` subscription cleanup.

### Proposal: one component, three densities

Recommended shape:

- A `PlaybackController` per document owns the sole `<audio>` element, queue, current item/index, repeat/shuffle state, Web Audio graph, playback claim, Media Session integration, persistence, and error state.
- Compact, hero, and mini `PlayerView` instances subscribe to controller state and dispatch commands. They do not own media elements or AudioContexts.
- Track rows provide data to the controller when selected. A playing item may be reflected simultaneously in its compact row and a mini/hero view without duplicating playback.
- The popup creates its own controller because it is another document, but uses the identical module and state schema.
- A small explicit state machine (`idle`, `loading`, `playing`, `paused`, `ended`, `error`) replaces icon changes scattered across event handlers.

Define a normalized playable-item schema before building views. At minimum it needs a stable ID, kind (`track` or `whole-show`), stream key/URL, version, title, artist, date/venue, duration if known, peaks reference if available, canonical page URL, and separately authorized download choices. This is especially important because a hero represents both a single whole-show recording and a queued track in `/player/`; those do not currently have identical metadata.

The control matrix needs several decisions:

- The hero's prev/next controls make sense for a queue, but not for a lone full recording. They should be hidden or disabled based on queue state.
- “FLAC/MP3 download” conflicts with the current policy: lossless downloads are protected, while MP3 is the ungated streaming proxy and is not currently presented as a download. Preserve that boundary unless changing it is a separate product/security decision.
- Repeat-one must take precedence over queue auto-advance and endless reshuffling. Turning repeat off should restore the previous queue mode.
- A mini bar on `/playlist/` is not persistent across site navigation. Calling it “persistent” should mean sticky within the page unless sticky navigation is separately approved.
- The existing playlist-selection bar also occupies the bottom of pages. Define stacking, safe-area insets, mobile keyboard behavior, and what happens if both bars are present.

For waveforms, avoid a WaveSurfer instance per compact row if all playback is owned by one controller. Precomputed peaks can be drawn as lightweight, inert canvases/SVGs and turned into an interactive seek surface only for the active row. At minimum, defer off-screen waveform work with `IntersectionObserver` and destroy it when rows are removed.

### Loudness control

This is the part that needs the most revision before implementation.

`DynamicsCompressorNode` is a compressor, not a true peak brick-wall limiter. It exposes no output ceiling, and threshold/ratio/attack settings do not prove that inter-sample or sample peaks remain below a selected ceiling. Therefore the plan should not promise that boosted playback “never clips.” A real guarantee needs a tested look-ahead limiter (likely an `AudioWorklet`) or deliberately conservative gain based on known per-track peak headroom. If a compressor is retained, describe it as overload protection and validate its worst-case overshoot rather than calling it brick-wall.

“Archive plays exactly as mastered” also requires a bypass path. Sending Archive mode through a compressor with a threshold near -1 dBFS will change tracks that reach that threshold even at unity gain. Archive mode should bypass dynamics processing; after Web Audio has been activated, a direct `MediaElementAudioSourceNode -> destination` branch preserves dynamics even though the browser may still resample to the output device.

Other required details:

- Convert dB boosts with `10 ** (dB / 20)` and ramp gain over roughly 20–50 ms to avoid clicks when changing modes.
- Use a single lazily created `AudioContext` per document. Resume it synchronously from the user's play/loudness gesture and handle `suspended`, `interrupted`, and closed states.
- Set `audio.crossOrigin = "anonymous"` **before** assigning a cross-origin stream URL. Otherwise `createMediaElementSource()` can be silenced by Web Audio's CORS rules. The production Worker emits allowed CORS origins today, but local/preview hosts will need an explicit development strategy, and Range responses must retain the same headers.
- If Web Audio is unavailable, blocked, or fails to initialize, Archive playback must continue through the native media element and boosted modes should become unavailable with a clear status. A loudness feature must never turn a previously playable recording silent.
- Do not create a second `MediaElementAudioSourceNode` for the same media element. Build and retain one graph, then change routing/parameters.
- Define whether the selected loudness is global or per track, whether it persists, and whether the popup and main tab synchronize it. If persisted, validate the stored enum rather than trusting arbitrary `localStorage` values.
- Test the illustrative modes against the actual corpus, including transient-capped tracks, already-loud exceptions, speech/banter, silence, and track transitions. Fixed `+4 dB`/`+6 dB` gains will not produce a fixed output LUFS for material that did not reach -20 LUFS.
- Consider a short first-use warning or conservative maximum. “Loudest” can cause a substantial jump on headphones even if it does not digitally clip.

### Why one component is worth it regardless of the sticky-navigation question below

Agreed. This refactor has value without navigation changes. The low-risk order is to extract and test the controller first, adapt existing views to it, and only then replace their markup. That makes behavior parity observable and avoids combining engine, UI, and navigation changes in one step.

## 3. Technical Details

The file list should include at least `scripts/playlist.js`, `scripts/continuous-player.js`, `scripts/wavesurfer.js`, `scripts/songs.js`, `scripts/track-select.js`, `scripts/sitegen/fragments.py`, `scripts/sitegen/pages.py`, and `scripts/build.py`, in addition to the files already named. `worker/index.js` enters scope if CORS or stream metadata must change. Generated files under `assets/`, `/playlist/`, `/player/`, show pages, and song pages should be rebuilt, not hand-edited.

Missing edge cases and behavior specifications:

- **Share timestamps:** define one canonical URL grammar for queued tracks, show-page tracks, and whole shows. The current site already uses `#p=id,...`, `&t=...`, `#track-N`, and `?autoplay=1`; timestamp sharing must not overwrite the track identity or break short playlist links. Include the queue index/current track, use finite non-negative seconds, clamp after metadata loads, choose a precision, and decide whether opening a timestamp cues or autoplays. Preserve a prompt fallback when Clipboard API access fails.
- **Untrusted state:** treat URL fragments, query parameters, catalog responses, `localStorage`, and `BroadcastChannel` messages as untrusted. Validate IDs against the catalog, validate message shape/action names, clamp indices/times/gain, deduplicate queues, and impose a documented queue/hash limit before rendering or persisting. The random playback ID prevents self-pausing; it is not an authentication mechanism.
- **Markup safety:** continue escaping all metadata and prefer `textContent`/DOM construction over interpolated `innerHTML`. Validate navigated URLs and media URLs against expected same-origin/Worker locations. This matters more once the same renderer consumes URL-selected catalog entries in several densities.
- **Download authorization:** keep password verification, token expiry, filename authorization, and the WAV/FLAC rejection on `/stream` entirely server-side. Never infer that showing/hiding an overflow-menu item protects a file. Add a regression test that lossless keys cannot be played through the streaming route.
- **Playback races:** handle rapid play-next-play actions, a source change during `loadedmetadata`, a cross-tab claim while `play()` is pending, removal of the playing queue item, and `ended` firing during repeat/shuffle changes.
- **Media failures:** specify UI and recovery for 403/404/416/5xx, a network drop, stalled buffering, unsupported codec, invalid duration, and a seek beyond a partially loaded stream. Retry should not unexpectedly restart the whole queue.
- **Lifecycle:** cover back/forward cache restoration, page visibility, device sleep/wake, Bluetooth/output changes, popup closure, and teardown of dynamically inserted song results.
- **Accessibility:** make the loudness pill a real button with its current value in the accessible name/state. Overflow menus need focus management, Escape/outside-click dismissal, and return focus. Waveforms still need a native range-equivalent semantic with elapsed/total text. Avoid announcing every `timeupdate` through a live region.
- **Keyboard shortcuts:** global Up/Down for next/previous conflicts with page scrolling and assistive technology conventions. Keep shortcuts scoped to an active/focused player, ignore links, selects, and `contenteditable` as well as inputs/buttons, ignore modifier chords, and document them. Left/Right should seek only when a playable item is active; a focused range should retain native behavior.
- **Media Session:** centralize metadata, playback state, position state, and all action handlers. Clear stale metadata/handlers on stop or teardown and guard calls on browsers that expose only part of the API.
- **No-JS/failure behavior:** retain a useful title and download/link fallback if the module or peaks request fails. A progressive enhancement baseline is preferable to blank controls.

Performance bottlenecks to plan around:

- Never allocate an `AudioContext`/compressor per row. Keep one audio graph per document.
- Do not make full-show waveforms analyze or download an entire 320 kbps recording on page load. Generate and cache whole-show peaks at build time, or omit that waveform until peaks exist.
- Keep current lazy audio loading and Range seeking. Precomputed peak JSON should be cacheable/versioned and fetched only on pages that display it.
- Avoid constructing dozens of full WaveSurfer players merely to draw inactive rows. Lazy/static rendering is much cheaper in memory, DOM nodes, observers, and event listeners.
- Update progress only for visible subscribed views. If smooth updates use `requestAnimationFrame`, run it only while playing and stop it on pause/hidden/teardown.
- Fetch and index `tracks.json` once per document. Resolve IDs through a reused `Map`, and avoid full queue rerenders for every time tick or single-item mutation.
- Bound queue length and hash parsing. Otherwise a deliberately huge shared URL can cause expensive resolution, DOM construction, history writes, and `localStorage` churn.

The plan currently has no verification strategy. Add controller unit tests, generator snapshot/HTML checks, Worker authorization/CORS tests, and manual browser coverage for current Safari/iOS, Chrome/Android, Firefox, and Chromium desktop. The Web Audio CORS path, autoplay/user-activation handoff, mobile background playback, Media Session controls, keyboard use, screen-reader names, multiple tabs, and reduced-motion/high-contrast modes all deserve explicit cases.

## 4. Rejected / Out of Scope

Playback speed and loop-region editing are reasonable exclusions.

Also explicitly keep these out of the first consolidation release:

- SPA/client-side navigation and iframe-shell work;
- cross-device playback synchronization;
- server-side remastering or replacement of archive masters;
- EQ, crossfade, loudness analysis in the browser, and per-track user presets;
- redesign of the download authentication policy.

The existing popup is not out of scope: it is the current practical solution for uninterrupted listening while browsing and should remain functional until a separate sticky-navigation project replaces it.

## 5. Open Questions

The sticky-navigation analysis is correct, and it should remain separate. A service worker alone will not preserve an audio element across full document navigations. The current named `/player/` popup already provides a lower-risk persistence mechanism and should be treated as the baseline during consolidation.

If client-side navigation is pursued later, its scope must include History API/popstate behavior, scroll and focus restoration, page title/meta/canonical updates, execution/teardown of page-specific scripts, same-origin URL filtering, download links, hash navigation, error fallback to a real navigation, and accessibility announcements. The iframe option likewise needs a plan for focus order, deep links, responsive sizing, history, and communication validation.

Questions to resolve before implementation:

- Is the runtime architecture one controller with many views, as recommended, or merely one reusable view class that still owns one audio element per instance?
- Does “persistent mini bar” mean sticky on `/playlist/` only, or site-wide? If site-wide, that is part of the navigation decision.
- What exactly is a hero queue for a full-show recording, and when should prev/next appear?
- Which current playlist features appear in the mini/expanded states: shuffle, queue editing, saved playlists, endless mode, and open-in-popup?
- Are loudness mode and repeat global, per queue, or per item? Are they persisted, shared with the popup, or reset on every document?
- What are the measured gain values and validated limiter behavior? The names should not be finalized before listening and peak tests.
- What is the canonical timestamp-link format, and how does it interact with playlist shortening and existing show-page fragments?
- What is the supported fallback when Web Audio or CORS is unavailable?
- What maximum queue length and URL length will the UI support?

## 6. Implementation Steps

- [x] Codex review — findings recorded in this file
- [ ] Inventory existing behaviors and turn them into a migration-parity checklist
- [ ] Decide sticky-navigation scope; recommended: separate project, preserve `/player/`
- [ ] Specify the per-document controller, playable-item schema, state machine, and view subscription/teardown API
- [ ] Decide mini-bar scope and its interaction with the playlist-selection bar
- [ ] Prototype the Web Audio path against the production Worker with `crossOrigin` set before `src`
- [ ] Choose a real limiter strategy or weaken the no-clipping claim; implement a true Archive bypass and failure fallback
- [ ] Measure candidate loudness gains against representative and worst-case archive tracks
- [ ] Define timestamp URL grammar, validation, queue bounds, and persistence rules
- [ ] Extract shared controller/queue/Media Session/keyboard logic while keeping current markup
- [ ] Add automated controller, generator, CORS, and download-authorization regression tests
- [ ] Build the compact density on the shared controller; use lightweight/lazy precomputed waveforms
- [ ] Build the hero density, including conditional queue controls and precomputed whole-show peaks
- [ ] Build the mini density and mobile safe-area/selection-bar behavior
- [ ] Migrate `/playlist/` and `/player/` without losing shuffle, saved queues, handoff, restore, or Media Session behavior
- [ ] Test errors, accessibility, multiple tabs, autoplay restrictions, background playback, and supported desktop/mobile browsers
- [ ] Remove old engines and duplicated markup only after parity checks pass
