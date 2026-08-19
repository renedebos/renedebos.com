# Player consolidation: Codex reviews

This is the canonical record of all Codex reviews for
`player-consolidation-plan.md`. It consolidates the original review with the
later implementation reviews that were already recorded in this file.

## First review — committed 2026-08-12 18:28:56 PDT

Status: review of `player-consolidation-plan.md` against the current generated markup and the playback code in `player.js`, `wavesurfer.js`, `playlist.js`, and `continuous-player.js`.

### 1. Objective

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

### 2. Proposed Architecture & System Design

#### The problem today

The diagnosis is accurate, but the scope is wider than `scripts/player.js` and generated markup. The four engines currently live in:

1. `scripts/player.js` for `.custom-player` instances;
2. `scripts/wavesurfer.js` for waveform rows;
3. `scripts/playlist.js` for `/playlist/`;
4. `scripts/continuous-player.js` for `/player/`.

`songs.js`, `track-select.js`, `sitegen/fragments.py`, `sitegen/pages.py`, and `build.py` also participate in creating players or handing queues between them. Treating this as mostly a markup migration would leave substantial duplication behind.

There are also lifecycle races worth designing out. A `play()` promise may resolve after the user has selected another track or after an external playback claim. Lazy-rendered song rows can add listeners after page load, while the current global `claimListeners` array has no unsubscribe path. The shared engine should use an operation/generation token to ignore stale asynchronous results and offer explicit `mount`/`destroy` subscription cleanup.

#### Proposal: one component, three densities

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

#### Loudness control

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

#### Why one component is worth it regardless of the sticky-navigation question below

Agreed. This refactor has value without navigation changes. The low-risk order is to extract and test the controller first, adapt existing views to it, and only then replace their markup. That makes behavior parity observable and avoids combining engine, UI, and navigation changes in one step.

### 3. Technical Details

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

### 4. Rejected / Out of Scope

Playback speed and loop-region editing are reasonable exclusions.

Also explicitly keep these out of the first consolidation release:

- SPA/client-side navigation and iframe-shell work;
- cross-device playback synchronization;
- server-side remastering or replacement of archive masters;
- EQ, crossfade, loudness analysis in the browser, and per-track user presets;
- redesign of the download authentication policy.

The existing popup is not out of scope: it is the current practical solution for uninterrupted listening while browsing and should remain functional until a separate sticky-navigation project replaces it.

### 5. Open Questions

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

### 6. Implementation Steps

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

---

## Subsequent implementation reviews

**Reviewed:** 2026-08-13 18:29:38 PDT (UTC−07:00)  
**Review target:** `player-consolidation-plan.md`  
**Status:** architecture approved with implementation changes recommended below

These comments are intended to be read by Claude Code before revising or
implementing the player-consolidation plan. They supplement the first review
above and focus on the remaining decisions and risks visible in the current
plan and codebase.

## Overall assessment

The core architecture is correct: use one `PlaybackController` per document
with multiple subscribed views. The `/player/` popup is a separate document,
so it gets its own controller instance using the same implementation and
state schema. `BroadcastChannel` remains responsible for preventing playback
in different documents from talking over itself.

Do not replace this with one audio element per view. Worktrees isolate
projects; the shared controller isolates playback state within the current
document.

The main concern is scope. The current plan combines a high-risk engine
consolidation with new views, Web Audio loudness processing, repeat-one,
timestamp sharing, keyboard behavior, and waveform changes. Split these into
independently verifiable milestones so failures can be attributed to one
layer.

## Required plan revisions before full implementation

### 1. Split consolidation from feature expansion

Use three delivery milestones:

1. **Controller and parity:** introduce the shared controller and page
   adapters while retaining the current markup and user-facing behavior.
2. **Shared views:** migrate compact, hero, and mini presentations onto the
   proven controller, including lightweight/lazy waveform rendering.
3. **New functions:** add loudness, repeat-one, and timestamp sharing as
   individually testable features after consolidation is stable.

The existing build-order statement in §2 points in this direction, but the
implementation checklist should make these separate gates. In particular,
limiter research and loudness-option decisions should not block proving the
controller or removing per-row audio engines.

### 2. Close questions the architecture has already answered

The following should become decisions, not remain open questions:

- Runtime granularity is one controller with many views. A view must not own
  an audio element or audio graph.
- Sticky playback across full-page navigation is a separate project.
  Preserve `/player/` as the uninterrupted-listening baseline.
- A standalone whole-show or alternate recording is a singleton queue, so
  prev/next controls are unavailable.
- The first mini bar is sticky only within its current document. Site-wide
  persistence belongs to the separate navigation project.

Remove the alternative “reusable view class with one audio element per
instance”; it contradicts the success criterion of one playback engine per
document.

### 3. Specify queue-origin semantics before building views

Define what queue each context supplies to the controller:

- Clicking a show-page track loads that show’s ordered track list and starts
  at the selected track, preserving current auto-advance.
- Clicking a full recording or alternate transfer replaces the current queue
  with that singleton recording.
- A lazily rendered song occurrence preserves today’s singleton behavior
  unless “all performances of this song” is deliberately approved later.
- `/playlist/` supplies its generated, restored, or URL-provided queue.
- `/player/` restores its persisted queue or accepts a handed-off queue.
- Switching between one of these contexts must explicitly say whether it
  replaces, appends to, or leaves the current queue intact.

Represent this distinction in the API rather than making views manipulate
controller internals. For example, use operations equivalent to
`setQueue(items, { startIndex, autoplay })`, `playSingleton(item)`, and
`appendQueue(items)`.

This decision controls auto-advance, prev/next visibility, repeat, shuffle,
Media Session metadata, persistence, and timestamp URLs.

### 4. Define JavaScript module and file boundaries

Current code depends on classic-script globals and ordering. `songs.js`
directly consumes `WORKER`, icons, constants, and `initCustomPlayers` from
`player.js`; `page_shell()` loads `player.js` before its page-specific
scripts. Turning only the controller into an ES module can make those classic
consumers execute before the replacement API is available.

Define the intended boundaries explicitly. A reasonable shape is:

- `player-controller.js`: media element, queue, transport state, playback
  coordination, Media Session, and state notifications
- `player-views.js`: compact, hero, and mini views
- `player-bootstrap.js`: discover generated markup and mount page views
- `downloads.js`: password modal, individual downloads, and batch ZIP logic
- page adapters for playlist generation, popup restoration, track selection,
  and lazy song occurrences

Either convert consumers to modules with explicit imports or provide one
small, documented global facade. Do not rely accidentally on module timing.
Keep download/auth UI separate from the playback controller so `/player/`
does not inherit machinery it does not use.

### 5. Separate parity behavior from new reliability work

The migration-parity list currently describes loading, stalled,
missing-file, and decode-error states as existing working behavior. That is
not fully accurate. The current engines handle some `waiting` events and
rejected `play()` promises, but do not provide comprehensive `error` or
`stalled` handling.

Create two literal checklists:

1. **Existing behavior that must not regress:** auto-advance, shuffle,
   endless mode, saved queues, popup restoration, handoff, Media Session,
   deep links/autoplay, downloads, alternate recordings, and stream-only
   items.
2. **Hardening introduced by consolidation:** explicit media-error states,
   stalled/network recovery, stale-play generation guards, teardown, invalid
   state validation, and clearer external-claim status.

This preserves an honest before/after comparison while still allowing the
new controller to fix known gaps.

### 6. Keep loudness as a separate post-consolidation experiment

The archive’s current MP3 peak data makes a fixed clean gain boost impossible
for most tracks without additional dynamics processing. Inspection of the
680 tracks with measured `mp3TruePeak` found:

- only 18 have enough headroom for +4 dB while remaining under −1 dBTP;
- only 4 have enough headroom for +6 dB while remaining under −1 dBTP; and
- 61 already peak above −1 dBTP before any playback boost.

Therefore the implementation must choose honestly among:

- a compressor-based “louder playback” mode without a brick-wall/no-clipping
  promise;
- a tested limiter; or
- a variable, per-track boost capped by known headroom.

`assets/tracks.json` does not currently carry `mp3TruePeak` or achieved
loudness, although `assets/track-spec.json` does. A peak-aware approach must
join those fields into the playable-item data path. Whole-show recordings
need a separate policy because they do not have equivalent track-level
provenance.

Archive mode must bypass dynamics processing. If Web Audio or CORS setup
fails, recreate or route playback so ordinary native Archive playback still
works; do not leave an element using a failed cross-origin Web Audio fetch.
Local-preview CORS behavior must be tested because the audio Worker currently
allows production site origins, not arbitrary localhost origins.

### 7. Version persisted and cross-document state

The new shared state is richer than today’s `playerState` value. Define a
versioned stored shape and migration/fallback behavior before adding repeat,
shuffle, loudness, or queue-source information. Invalid or future versions
should degrade to a clean queue rather than partially restoring corrupt
state.

Likewise, replace the current anonymous `BroadcastChannel` string with a
small validated message shape such as `{ version, type, senderId }`. Treat
channel messages, URL state, and `localStorage` as untrusted input.

### 8. Add small deterministic controller tests

A formal browser matrix is unnecessary, but manual checks alone are weak for
state-machine behavior. Add a small test harness around a fake audio element
for:

- stale/rejected `play()` promises;
- rapid item changes;
- repeat at `ended`;
- shuffle enable/disable restoration;
- removal and reordering around the current index;
- singleton-to-queue transitions; and
- external playback claims.

Continue using manual Safari, Chrome, and Firefox checks for actual media,
autoplay, Web Audio, CORS, Media Session, mobile backgrounding, and visual
behavior.

## File-scope corrections

Update the plan’s file list to include:

- `scripts/player-controller.js`
- the eventual view/bootstrap/download modules
- `site_worker.js` if timestamp sharing changes `/play/{slug}` behavior or
  short-link redirects
- `worker/index.js` only for the audio-stream/CORS concerns already noted
- the catalog generator if peak/loudness fields enter the playable schema

The timestamp feature must account for both Workers correctly:
`site_worker.js` owns playlist short links, while `worker/index.js` owns audio
streaming and CORS.

## Branch workflow correction

Use this sync command in §7:

```bash
git fetch origin && git merge origin/main
```

This unambiguously merges the freshly fetched remote integration branch.
`git fetch origin main && git merge main` can still merge a stale local
`main`, depending on which checkout most recently advanced it.

## Live-worktree observation

During the review, an untracked `scripts/player-controller.js` appeared in
the `player-consolidation` worktree. At the time of this note it was a
384-line partial controller implementation containing normalized items,
queue state, repeat, shuffle, generation tokens, Media Session support, and
error handling. It was not modified by this review.

Before continuing, reconcile that file with this plan and determine which
session owns the worktree. The project’s stated rule is one active editing
session per worktree. Once the controller is accepted, update the plan’s
“not yet built” status and keep the implementation and checklist in sync.

## Recommended implementation gate

Do not remove any existing engine until all of the following are true:

- the queue-origin rules are written down;
- the controller API and module-loading strategy are settled;
- the literal parity checklist exists;
- the shared controller works with existing show-page markup;
- stale-play and queue-transition tests pass; and
- the relevant current player remains available as a fallback during the
  next migration step.

The architecture is approved. The safest next move is to finish and prove
the controller/parity milestone, not to begin loudness processing or replace
all player markup at once.

---

## Follow-up review — 2026-08-13 19:05:38 PDT

This review covers the substantially revised living plan and the current
`scripts/player-controller.js` implementation. The overall architecture is
sound, but the following gaps should be resolved before the migration reaches
real show pages.

### 1. High: Hero playback strands the track queue

`playSingleton()` replaces the queue, while `play(item)` deliberately refuses
items that are not already queued. The page initially queues all track rows,
but playing the Full Recording replaces that queue with one recording. A
subsequent click on a track row will therefore no-op unless some other layer
first restores the page's track queue.

Add an explicit queue-origin/queue-activation contract, for example:

```js
controller.activateQueue('show-tracks', items, index, { autoplay: true });
```

The exact API can differ, but switching queue contexts and starting the
selected item should be one atomic operation. Add deterministic tests for:

- Track -> Hero -> Track
- Hero -> Track -> Next
- Alternate recording -> Track

The existing singleton test proves that an unqueued item no-ops; it does not
yet prove that a visitor can return from singleton playback to the page queue.

### 2. High: the allowlist migration will still double-initialize players

Phase 1 Step 4 proposes having `player-boot.js` mark claimed rows and adding a
`dataset.mounted` guard to the legacy engines. The generated page, however,
loads `player.js` before its extra scripts, and `player.js` immediately calls
`initCustomPlayers(document)`. A later module cannot mark rows before that
initial legacy pass.

Use a page-level engine flag that is present before `player.js` executes, or
generate mutually exclusive initialization for each allowlisted page. The
legacy engine can remain in the repository/build as the rollback path without
both engines mounting the same DOM at runtime.

### 3. High: Step 5 would break untouched song and playlist pages

Step 5 deletes `initCustomPlayers` and the playback-coordination globals while
the same phase explicitly leaves song pages, `/playlist/`, and `/player/`
untouched. `songs.js` still invokes `initCustomPlayers()` after lazily inserting
performance rows, and those rows are deliberately not receiving `data-item`
markup in this phase.

Revise the sequence as follows:

- retain the legacy `initCustomPlayers` implementation for song pages until
  their own migration;
- prevent its automatic initialization only on migrated show pages;
- move claim coordination into a small site-wide compatibility module loaded
  before classic consumer scripts; and
- adapt the old `onExternalClaim(fn, owner)` signature explicitly, because the
  new internal helper currently takes `(owner, fn)`.

Do not delete a compatibility global until every remaining consumer either
loads its replacement or has migrated away from it.

### 4. Medium-high: playlist removal parity is not implemented

The controller's current `removeAt()` calls `stop()` when the current item is
removed. Both legacy queued players instead let the next item slide into that
position, cue it, and continue playback when the removed item had been
playing. The claim that `/playlist/` and `/player/` can reuse the controller
"unmodified" is therefore premature.

Either reproduce and test the existing removal behavior now, or defer the
queue-editing methods until Phase 2. If `reorder()` remains in the controller,
also validate/clamp `toIndex` and define how reordering updates the
pre-shuffle snapshot; the current implementation does neither completely.

### 5. Medium: teardown and queue replacement need explicit contracts

`destroy()` currently unregisters playback-claim handling and detaches views,
but it does not pause playback, remove native audio listeners, or clear Media
Session action handlers. Those handlers can retain and call a controller after
it has supposedly been destroyed.

`setQueue()` can also replace the internal queue without pausing or changing
an already-playing audio source when `autoplay` is false. That can leave the
audible source inconsistent with `currentItem` and the published queue.

Define both operations precisely, implement complete teardown, and add tests
covering queue replacement during playback and Media Session/audio behavior
after `destroy()`.

### 6. Low: distinguish implemented behavior from intended contracts

The plan describes WaveSurfer generation-token handling and synchronous
upgrading as if they are already implemented, although the view layer does not
exist yet. It also says `normalizeItem()` validates the item schema, while a
missing `streamUrl` currently normalizes to an empty string.

Label view behavior as an intended contract until Step 2 implements and tests
it. Require a non-empty stream URL, validate finite/non-negative numeric
fields, bound queue input when persisted or URL-derived queues arrive in later
phases, and change "reuse unmodified" to "intended foundation for later
migration" until playlist parity has actually been demonstrated.

## Verification during this review

- `node scripts/test-player-controller.mjs`: 10/10 passed
- `python3 scripts/build.py --check`: integrity passed for 31 shows and 680
  curated tracks

These checks are healthy, but the current tests prove the controller's chosen
behavior rather than complete behavioral parity with the legacy players. The
first three findings above should be treated as migration blockers; the
controller/lifecycle items should be resolved before deleting any legacy
engine.

---

## Fourth review — 2026-08-13 19:42:23 PDT

This review covers the newly completed view layer and the corresponding
additions to `player-consolidation-plan.md`. The revision resolves the previous
queue-restoration, double-initialization, and untouched-page sequencing
blockers well. The following issues remain in the new view implementation and
plan.

### 1. High: inactive rows update on every `timeupdate`

`PlayerView._render()` resets any inactive view whenever `_lastState !== null`.
After initial mounting, that condition is true for every inactive row on every
controller update. For waveform rows, the reset path destroys and redraws the
inert canvas repeatedly. This contradicts the plan's statement that a view
rewrites its DOM only while active or once when transitioning away from active.

Track whether the view was previously active instead of whether it has ever
rendered:

```js
if (active) {
  // update the active view
} else if (this._wasActive) {
  // reset exactly once on the active -> inactive transition
}
this._wasActive = active;
```

Add a deterministic test proving repeated controller updates do not touch an
inactive row or recreate its inert canvas.

### 2. High: inactive waveforms have lost tap-to-play behavior

Waveform interaction is registered only after `_upgradeWave()`, but a row is
upgraded only after it is already the controller's active item. Tapping an
inactive inert waveform therefore does nothing; the visitor must first use the
play button. The legacy WaveSurfer row starts playback for that row at the
tapped position.

Either make the inert waveform surface interactive — calculate the clicked
position, re-assert the show queue, start that row, then seek — or explicitly
record this as an accepted behavior regression. Add an inactive-waveform test
covering queue restoration, playback, and the selected seek position.

### 3. Medium-high: the promised error affordance is not implemented

The plan promises an inline "Playback failed — tap to retry" affordance. The
view currently only adds a `player-error` class, and no CSS or status element
uses that class. The visitor receives no visible explanation that playback
failed.

Retry is incomplete as well: clicking the active errored row routes through
`toggle()`/`play()`, while `_currentSrc` still matches the failed item. The
controller therefore does not reset or reload a media element already in an
error state.

Add visible or `aria-live` error text, change the active button label to
"Retry ...", and provide an explicit retry path that reloads the source before
calling `play()`. Test both the rendered message/accessible name and source
reload behavior.

### 4. Medium: define recording IDs before Step 3

The playable-item schema documents the ID format only for track rows. Full
recordings and alternate transfers also require stable, unique IDs because
every view decides whether it is active by comparing `currentItem.id` with its
own item ID. Two recording cards sharing an ID would both render as active.

Define a deterministic scheme before generating `data-item`, for example:

```text
recording:{show-slug}:{stable-recording-key}
```

Add a test with two alternate recording cards proving only the selected card
enters the active state.

### 5. Medium: the Hero controls test does not mirror real generated markup

The real `recording_card()` markup contains no `data-act="prev"` or
`data-act="next"` buttons, but the hand-built Hero fixture adds both while the
test file says its fixtures mirror the real generated markup. The current
render logic would also show those controls whenever any queue has more than
one item, including when an unrelated show-track queue is active. An active
Hero always uses `playSingleton()`, so it can never simultaneously have a
multi-item queue.

Remove these controls from Phase 1 and its real-markup fixture, or define a
future non-singleton Hero use case and require both `heroIsActive` and
`queue.length > 1` before showing them.

### 6. Medium: guard Media Session initialization

The controller calls every `navigator.mediaSession.setActionHandler()` during
construction without individual error handling. A browser can expose Media
Session while rejecting an unsupported action, which would abort controller
construction. `MediaMetadata` is also assumed to exist whenever Media Session
does.

Register each action in `try/catch`, and guard metadata construction
separately. This should be covered by a fake partial-support Media Session test
and then confirmed during the planned real-browser checks.

### 7. Minor plan and comment cleanup

- The implementation gate still says "classic script + bridge-globals
  pattern," although revised Step 5 deliberately avoids building a bridge.
- The same gate still reports controller tests as 10/10 rather than 19/19.
- The untouched-page paragraph says later phases reuse the controller "with no
  redesign," conflicting with the more accurate later statement that it is an
  intended foundation, not a proven drop-in.
- `scripts/test-player-controller.mjs` still links to a nonexistent
  `phase-1-show-pages-plan.md`.
- The controller file header still says `/playlist/` and `/player/` can adopt
  the class unmodified, which now conflicts with the plan's qualified wording.

## Verification during this review

- `node scripts/test-player-controller.mjs`: 19/19 passed
- `node scripts/test-player-views.mjs`: 11/11 passed
- `python3 scripts/build.py --check`: integrity passed for 31 shows and 680
  curated tracks
- `git diff --check`: passed

These checks establish a healthy baseline, but the first three findings expose
behavior the current tests do not exercise. Keep Phase 1 Step 2 open until
those view-layer issues are either fixed or, for inactive waveform tapping,
explicitly accepted as a deliberate behavior change.

---

## Fifth review — 2026-08-13 20:49:05 PDT

This review covers the completed Phase 1 Step 3 additive markup and the Step 2
changes made in response to the fourth review. The earlier inactive-row,
inactive-waveform, error-affordance, recording-ID, Hero-fixture, and Media
Session findings have been incorporated well. Step 3 is sound for the current
corpus and can remain marked complete.

### 1. Medium: retry detection happens after error state is overwritten

`PlaybackController._playIndex()` changes the controller state to `loading`
before calculating:

```js
const retrying = this._state === 'error' || !!this.audio.error;
```

The state half of that expression can therefore never be true. The current
retry tests use a native media error that leaves `audio.error` populated, so
they do not expose the ordering problem. A rejected `play()` promise can put
the controller in error state without setting `audio.error`.

Capture the condition before changing state:

```js
const retrying = this._state === 'error' || !!this.audio.error;
this._setState('loading');
```

Add a case where `play()` rejects while `audio.error` remains null, then a
second attempt succeeds and is verified to have taken the intended retry path.

### 2. Medium: the missing-peaks fallback still differs from the plan

The playable-item schema says a missing peaks entry falls back to a plain
native range. `build_show()` still selects `.ws-track` versus
`.custom-player` at show granularity, however, and emits a `peaksKey` for every
track whenever that show has a peaks file. If an individual key is absent,
the resulting waveform row has neither usable peaks nor a native range input.

Every current waveform row has a matching peak entry — independently verified
during this review, with zero missing — so this is not a current corpus bug.
Before Step 4, choose one explicit policy:

- select waveform/range markup per track;
- have `player-boot.js` construct the native fallback; or
- make missing per-track coverage a build failure and revise the plan's
  fallback claim accordingly.

### 3. Medium: make Step 3's verification rerunnable

The Step 3 notes record strong checks: all 747 generated items parse, IDs are
unique within each page, stream URLs match the legacy source, song pages have
no item markup, and removing the attributes reproduces the old HTML. Those
checks are not currently represented by a committed test or by
`build.py --check`; the latter validates source-data integrity without reading
generated `data-item` attributes.

Add a small generator/integrity test covering:

- JSON parsing and required fields;
- ID uniqueness per page;
- `streamUrl` parity with the corresponding legacy `data-src`;
- peak-key coverage; and
- absence of `data-item` on song pages during this phase.

This is proportionate protection: the one-off verification already found a
real WAV/FLAC recording-ID collision.

### 4. Minor plan and comment cleanup

- Phase 1 Step 1 still reports controller tests as 19/19 rather than 21/21.
- Earlier plan sections still describe Hero prev/next controls as hidden based
  on queue length. Phase 1 now correctly has no such controls at all; align the
  API discussion, lifecycle snippet, and resolved-question text with that
  decision.
- The controller file header still says `/playlist/` and `/player/` can adopt
  the class unmodified, conflicting with the plan's more accurate "intended
  foundation, not a proven drop-in" wording.
- The plan may usefully distinguish the 30 generated public show pages from
  the 31 shows checked in source-data integrity output, avoiding an apparent
  count discrepancy.

## Verification during this review

- `node scripts/test-player-controller.mjs`: 21/21 passed
- `node scripts/test-player-views.mjs`: 15/15 passed
- `python3 scripts/build.py --check`: integrity passed for 31 shows and 680
  curated tracks
- Generated show-page items: 747 total across 30 public pages; 680 tracks and
  67 recordings; zero malformed items, missing required fields, or duplicate
  IDs within a page
- Waveform rows missing a corresponding peaks entry: zero
- Generated controller, view, and CSS assets match their source files
- `git diff --check`: passed

The Step 2 corrections and Step 3 output are healthy. Keep Step 3 checked
complete; fix the retry ordering and commit a rerunnable markup-integrity
check before Step 4 enables the controller on an allowlisted real page.

---

## Step 3 markup and Step 4 engine-gating review — 2026-08-13

1. **High — Step 4 disables the legacy engine before confirming that the module-based controller can start.**  
   Evidence: `plans/player-consolidation/player-consolidation-plan.md:828-839` sets `PLAYER_ENGINE = 'controller'` before `player.js` and makes both legacy initializers bail. `scripts/player-views.js:13-14` has static module dependencies on both WaveSurfer and the controller. Any unsupported-module browser, asset failure, parse error, or bootstrap exception therefore leaves every player inert; the retained legacy code is only a deployment rollback, not a runtime fallback. This is a regression over the current arrangement, where a WaveSurfer module failure still leaves the Full Recording player working through classic `player.js`.  
   Suggested fix: make engine activation transactional. Feature-detect module support before setting the flag, dynamically import the controller/view graph with a caught failure path, and only suppress legacy initialization once boot is ready to mount. Alternatively, explicitly call this a deploy-time rollback and add a tested recovery mechanism that tears down partial controller mounts before invoking legacy initialization.

2. **Medium — The proposed flag gates player construction but leaves two legacy playback integrations active on controller pages.**  
   Evidence: `scripts/player.js:173` is only the initial custom-player mount, while the legacy Space handler is independently registered at `scripts/player.js:175-190` and the legacy deep-link/load/hashchange handler at `scripts/player.js:579-601`. Step 4 says `player-boot.js` will wire both Space and deep links (`plans/player-consolidation/player-consolidation-plan.md:822-839`) and then claims the engines never touch the same DOM. In reality both deep-link handlers will scroll and mutate `.target`; the legacy Space listener will also consume Space even with no legacy active player. For a future non-waveform track, both deep-link implementations could trigger `?autoplay=1`, producing a double start/toggle.  
   Suggested fix: gate all legacy playback-owned registration—initialization, Space handling, and `focusHashTrack` load/hashchange listeners—behind the engine selection. Leave unrelated download/share functionality active.

3. **Medium — The documented per-track missing-peaks fallback does not exist.**  
   Evidence: the plan promises `peaksKey: null` or missing coverage yields a plain range (`plans/player-consolidation/player-consolidation-plan.md:270,310-315`). `build_show()` chooses waveform markup once per show (`scripts/sitegen/pages.py:686-689`), assigns a key to every track (`scripts/sitegen/pages.py:787-790`), and emits `.ws-track` without a range (`scripts/sitegen/pages.py:797-810`). With no matching peaks object, `PlayerView` has neither usable waveform data nor `.progress-range` (`scripts/player-views.js:49-52,302-304`), leaving a blank, non-seekable surface. The current corpus has zero missing keys, but nothing committed enforces that invariant.  
   Suggested fix: preferably make missing peak coverage a build failure and revise the fallback claim. Otherwise choose row markup after inspecting the peaks map or have the bootstrap construct a real range fallback before mounting.

4. **Medium — The normalized download schema contains unusable URLs and misclassifies WAV recordings as FLAC.**  
   Evidence: the declared schema is `downloads.flac.url` (`plans/player-consolidation/player-consolidation-plan.md:273`). `playable_item_attr()` populates it with `stream_url(lossless_file)` (`scripts/sitegen/fragments.py:60-63`), but `/stream` deliberately returns 403 for WAV and FLAC (`worker/index.js:40-53`). Existing downloads only work because `player.js` treats the href as a carrier for the R2 key, then performs `/auth` and `/download` (`scripts/player.js:425-440,459-465`). Additionally, `recording_card()` passes both WAV and FLAC originals through the `flac_file` field (`scripts/sitegen/fragments.py:169-196`). The generated corpus currently contains 747 non-null `downloads.flac` entries, including 64 WAV files.  
   Suggested fix: model the real contract, for example `downloads.lossless: { key, format, sizeMb, title }`, and route it through the existing authenticated download flow. Do not describe a guaranteed-403 `/stream` address as a download URL.

5. **Medium — The plan overstates fixture fidelity, and none of Step 3’s important output assertions are in a rerunnable project check.**  
   Evidence: the plan says the Hero fixture matches `recording_card()` exactly and has a separate total label (`plans/player-consolidation/player-consolidation-plan.md:645-651`). The fixture invents that label and flattens the progress markup (`scripts/test-player-views.mjs:147-160`); real `recording_card()` calls `player()` without a duration (`scripts/sitegen/fragments.py:169-177`), so generated Hero cards contain only the current-time label. The item parser test also supplies hand-written `JSON.stringify()` data rather than browser-decoded generator output (`scripts/test-player-views.mjs:182-200`). Finally, `build.py --check` exits after source-data validation (`scripts/build.py:26-34`) and does not inspect generated `data-item` attributes, despite the Step 3 verification record at `plans/player-consolidation/player-consolidation-plan.md:807-814`. The current output is correct, but regression protection is absent.  
   Suggested fix: add a Python generator test that calls `build_show()` in memory and parses the resulting HTML. Check schema fields, escaping round trips, per-page ID uniqueness, legacy `data-src` parity, peak-key coverage, absence on song pages, and additive-only output. Remove the invented Hero total label or generate the fixture from the real fragment.

**Verification during this review**

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks.
- `for f in scripts/test-*.mjs; do node "$f" || exit $?; done` — passed: controller 21/21; views 15/15.
- `git diff --check` — passed.
- Read-only in-memory generator/HTML audit — 747 items across 30 public show pages (680 tracks, 67 recordings); zero malformed items, missing fields, duplicate IDs, or stream/source mismatches; generated pages match current `build_show()` output; song pages contain no `data-item`.
- Additive-output audit — stripping `data-item` from all generated show pages reproduced HEAD exactly.
- Peak audit — zero currently generated waveform rows lack their referenced peaks entry.
_Review generated 2026-08-13 20:56:29 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-13) — review of the review automation

Codex reviewed `scripts/codex_review.sh` + `.claude/commands/review-step.md`.
Six findings; five confirmed and fixed, one factually wrong.

- **Preserve the human checkpoint** — *confirmed, fixed.* The command did apply
  fixes before reporting, which automates exactly the judgment step that has
  been catching bugs. Split into `/review-step` (review, verify, record
  disposition, **stop**) and `/apply-review` (implement after approval). This
  also matches how this project has actually been working.
- **Don't review a moving worktree** — *confirmed, fixed.* Script now
  fingerprints `git status` before/after and annotates the appended review if
  the tree moved; `/review-step` is instructed to wait and write nothing while
  a review runs.
- **Scope to the current worktree** — *confirmed, fixed.* Script resolves
  `git rev-parse --show-toplevel` and passes `-C "$REPO_ROOT"`, so it can't
  review a sibling checkout (this repo is worked from several worktrees).
- **Narrow the permission** — *confirmed, fixed.* `Bash(codex exec *)` would
  have allowed arbitrary invocations including
  `--dangerously-bypass-approvals-and-sandbox`. Replaced with
  `Bash(bash scripts/codex_review.sh:*)`.
- **Record disposition in the log** — *confirmed, fixed.* This block is that
  mechanism; `/review-step` step 4 now requires one per review, so later
  reviews can see what became of earlier findings instead of re-raising them.
- **Robustness (`--ephemeral`, non-empty output, no concurrent runs)** —
  *confirmed, fixed.* All three added; a crashed/timed-out Codex now aborts
  instead of appending an empty section, and a lock prevents interleaved
  appends.
- **"The end-to-end test produced no evidence; the log has no script-generated
  footer and was last changed at 20:49"** — *factually incorrect.* The log
  carries `_Review generated 2026-08-13 20:56:29 PDT by
  scripts/codex_review.sh_` at line 809, and that script-generated review (the
  sixth) is what produced the retry-ordering, download-schema, peaks-invariant,
  fixture-fidelity and Step 4 fallback findings already fixed above. The review
  appears to have read a snapshot taken before the append landed. Noted rather
  than actioned.

---

## Step 4 player boot and engine-gating review — 2026-08-13

1. **High — Bootstrap teardown is incomplete and can reactivate a destroyed controller or leave two engines live.**  
   Evidence: [player-boot.js](/home/renedebos/renedebos.com-player-consolidation/scripts/player-boot.js:65) catches and destroys only failures during view mounting. The keyboard, deep-link, and resize listeners are installed afterward at lines 80–83 and never removed; `handle.destroy()` at line 75 destroys only the controller. [player-controller.js](/home/renedebos/renedebos.com-player-consolidation/scripts/player-controller.js:422) leaves `_idx` and the queue intact, while transport methods do not check `_destroyed`. Consequently, after `window.PLAYER_BOOT.destroy()`, Space or a later `load`/`hashchange` can call `toggle()`/`setQueue(...autoplay)` and start the detached audio again. Separately, if a synchronous decoration step throws after some listeners are installed, the outer auto-run catch leaves the mounted controller/listeners alive but the flag unset; `DOMContentLoaded` then starts legacy playback too. This contradicts the plan’s claim at [player-consolidation-plan.md](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:903) that any bootstrap failure tears down partial work.  
   Why it matters: this is a concrete lifecycle path to an invisible engine and a transactional-error path to two engines.  
   Suggested fix: create one boot-level `AbortController`, register all document/window listeners with its signal, and make `handle.destroy()` abort it before destroying the controller. Put all synchronous boot wiring inside the same cleanup boundary, and make controller transport methods no-op after destruction or clear the queue/index in `destroy()`. Add tests that destroy a successful boot and then dispatch Space, `load`, `hashchange`, and resize, plus a forced post-mount wiring exception followed by legacy initialization.

2. **Medium — A missing `data-item` silently suppresses legacy playback while leaving that row unwired.**  
   Evidence: [player-boot.js](/home/renedebos/renedebos.com-player-consolidation/scripts/player-boot.js:28) discovers only `.track-list [data-item]` and `.recording-item[data-item]`; absent attributes are skipped rather than rejected. The module nevertheless sets `PLAYER_ENGINE_MOUNTED` at lines 170–176, even if one playable row—or every playable element—was skipped. [verify_markup.py](/home/renedebos/renedebos.com-player-consolidation/scripts/verify_markup.py:128) validates only attributes it finds; it never compares all `.track-row`/`.recording-item` elements with the `data-item` population. The invented fixtures always supply the attribute.  
   Why it matters: one generator regression can produce zero engines for a row while all current checks pass; deleting every `data-item` from an allowlisted page can make the empty controller claim the whole page.  
   Suggested fix: enumerate all expected `.track-list .track-row` and `.recording-item` elements, then throw if any lacks valid item data or required controls. Extend `verify_markup.py` to assert one valid `data-item` per playable element and require at least one mounted view before setting the flag.

3. **Medium — “A module/asset failure falls back to the complete legacy engine pair” is overbroad.**  
   Evidence: `player-boot.js` and [player-views.js](/home/renedebos/renedebos.com-player-consolidation/scripts/player-views.js:13) statically import the same `/assets/wavesurfer.esm.js` used by [wavesurfer.js](/home/renedebos/renedebos.com-player-consolidation/scripts/wavesurfer.js:8). The actual outcomes are:

   - `player-boot.js` 404/parse error: legacy `player.js` and `wavesurfer.js` initialize; waveform rows work.
   - `player-views.js` or `player-controller.js` 404: the boot graph fails, but the independent legacy WaveSurfer graph still initializes; waveform rows work.
   - `wavesurfer.esm.js` 404/parse error: both module graphs fail. Classic `player.js` restores Full Recording cards, but every `.ws-track` row is dead.
   - Exception during the guarded mount loop: mounted views are destroyed and both legacy engines initialize; waveform rows work.
   - No module support: neither WaveSurfer module nor boot module executes. Classic Full Recording cards work, but waveform rows are dead.

   The last two dead-row cases are no worse than an unflagged page today—those pages already require module support and the same WaveSurfer asset—but they are not the “complete engine pair” promised at [player-consolidation-plan.md](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:925).  
   Why it matters: later work may treat the fallback as broader than it is and remove the remaining native escape hatch.  
   Suggested fix: narrow the plan and comments to “boot-only dependency failures fall back”; explicitly document the shared WaveSurfer dependency and unsupported-module baseline. If waveform fallback must survive that dependency failing, it needs a native range/player path independent of WaveSurfer.

4. **Medium — The 14 boot tests do not exercise the engine handshake or generated markup, and the mutation-check claim is unsupported.**  
   Evidence: [test-player-boot.mjs](/home/renedebos/renedebos.com-player-consolidation/scripts/test-player-boot.mjs:29) hand-builds convenient rows/cards rather than invoking `build_show()` or parsing generated HTML. It never loads `player.js` or `wavesurfer.js`, never fires `DOMContentLoaded`, and therefore cannot detect legacy double initialization. [test-fake-dom.mjs](/home/renedebos/renedebos.com-player-consolidation/scripts/test-fake-dom.mjs:65) has no bubbling, capture, `once`, AbortSignal removal, readiness state, or browser event scheduling. Its `FakeAudio` at line 131 always plays successfully without user activation, loading, source-reset, metadata, or rejection semantics. Its `FakeWaveSurfer` at line 149 merely stores options, while the loader at lines 170–192 replaces the real vendored implementation. Two harmful mutations that would still leave the boot suite green are removing the flagged-page gate from either `player.js` or `wavesurfer.js`, and changing late `setPeaks()` to store the object without drawing/upgrading—the failed-peaks test checks only the stored property. This directly undercuts the “each boot test was mutation-checked” and “through the real markup” claims at [player-consolidation-plan.md](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:692) and line 977.  
   Why it matters: the suite proves selected bootstrap/controller behavior, but gives no evidence for the load-order gate, fallback, real event teardown, browser media behavior, or generated-markup integration. The late-peaks adoption path appears sound by source audit—the vendored WaveSurfer marks `options.media` external, detects the already-playing element, and its same-source check avoids removing/reassigning `src`—but the fake tests exercise none of those operations.  
   Suggested fix: add a browser test served from actual generated `build_show()` output. Instrument `Audio`, break each module URL independently, fire real lifecycle events, and assert which listeners/media elements own every row. At minimum, parse a real generated page in the non-browser test instead of constructing parallel fixtures.

5. **Low — The asset graph checker does not cover everything scripts import.**  
   Evidence: [verify_markup.py](/home/renedebos/renedebos.com-player-consolidation/scripts/verify_markup.py:73) recognizes only single-quoted static `from '/assets/…'` imports. It misses dynamic imports, side-effect imports, double-quoted imports, and re-exports. There is already a missed real edge: [player.js](/home/renedebos/renedebos.com-player-consolidation/scripts/player.js:401) dynamically imports `/assets/client-zip.js`. The file currently exists, but deleting its build write would not fail this check despite the plan’s assertion at line 990 that all imports are covered.  
   Why it matters: a build can pass while shipping a broken lazily loaded feature.  
   Suggested fix: parse JavaScript imports with a small JS parser, or conservatively scan static `from`, side-effect `import`, `export … from`, and literal `import()` forms with both quote styles. Add a test fixture for each supported form.

6. **Low — The timing rationale contains two inaccurate guarantees, although the emitted parser-inserted order itself is valid.**  
   Evidence: the plan says `DOMContentLoaded` “beats any fetch” and that the listener is timely “under any script placement” at [player-consolidation-plan.md](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:697) and line 943. A fetch completion is not ordered behind `DOMContentLoaded` in that general way, and a dynamically inserted module can run after the event. The actual page is safe for a narrower reason: [the generated page](/home/renedebos/renedebos.com-player-consolidation/shows/jerry-cafe-java-1999-05-27/index.html:361) uses parser-inserted modules in document order, and the flag assignment happens in the same JavaScript job before any fetch promise continuation. The HTML Standard sets readiness to `interactive`, executes the ordered deferred/module list, and only then queues `DOMContentLoaded`. [HTML parsing algorithm](https://html.spec.whatwg.org/multipage/parsing.html#the-end), [script processing model](https://html.spec.whatwg.org/multipage/scripting.html#processing-model).  
   Why it matters: overstated timing folklore invites unsafe reuse in dynamically loaded or reordered contexts.  
   Suggested fix: document the precise parser-inserted ordering and synchronous-job guarantee; remove “any fetch” and “any script placement.”

**Verification during this review**

- `for f in scripts/test-*.mjs; do node "$f" || exit $?; done` — passed: boot 14/14, controller 22/22, views 15/15.
- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks.
- `python3 scripts/verify_markup.py` — passed: 747 items across 30 generated show pages.
- Two-direction `BroadcastChannel` probe — passed: controller bare-string claims reached a legacy peer, and a legacy claim paused the controller.
- `git diff --name-only 6b05a79^ 6b05a79` — only the three allowlisted generated show pages changed; song, `/playlist/`, `/player/`, and lab HTML did not.
- Source trace confirmed unflagged `player.js` and `wavesurfer.js` still take their immediate branches, and `songs.js` still calls the exposed `initCustomPlayers(container)`.
- Source/asset `cmp` checks — all five player assets match their script sources.
- `git diff --check` and `bash -n scripts/codex_review.sh` — passed. The uncommitted lock fix correctly resolves the linked worktree’s absolute git directory.
- No browser executable was available, so actual module-404 and real WaveSurfer/media tests remain unperformed.
_Review generated 2026-08-13 23:08:08 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-13)

All six findings confirmed — no factually wrong claims this pass. Three were
reproduced directly (not just read and agreed with).

- **#1 High, destroyed-controller reactivation — confirmed, reproduced.**
  Built a repro against the real modules (not a hypothetical): started
  playback through a mounted `CompactPlayerView`, called
  `handle.destroy()`, then dispatched a `keydown` Space event on the
  document. The controller's audio resumed playing — `paused` went from
  `true` right after `destroy()` back to `false` after the leaked
  `wireKeyboard` listener fired `toggle()`. `player-controller.js` sets
  `_destroyed = true` (line 435) but the string never appears again in the
  file — no transport method checks it. Real defect.
  **Mitigating fact Codex's finding didn't state:** `handle.destroy()` is
  called from exactly nowhere in shipped code today (only defined, and
  exposed via `window.PLAYER_BOOT.destroy()` for console/future use) — this
  site is static multi-page, so a full navigation already tears everything
  down and nothing currently invokes it in production. Still a real bug: it's
  public API, the plan explicitly reserves a future SPA-navigation phase
  where teardown becomes load-bearing, and an API that's silently broken
  until someone needs it is worse than one that visibly doesn't exist.
- **#2 Medium, unmarked missing data-item — confirmed.** Traced
  `verify_markup.py`'s `ITEM_RE.findall(src)` (line 128): it validates every
  `data-item` attribute it finds and never counts `.track-row`/
  `.recording-item` elements independently to compare. A regression in
  `build_show()` that dropped the attribute from one row would produce a
  silently unmounted row — invisible to `ROW_SELECTOR` too
  (`'.track-list [data-item]'`), so on a flagged page that row would get
  neither engine, since legacy is suppressed. No live path produces this
  today (every row in the loop unconditionally gets `playable_item_attr()`),
  but the same "structural invariant, not just a snapshot of current output"
  argument that made peaks-coverage a build failure in the sixth review
  applies here too.
- **#3 Medium, "complete legacy pair" overclaim — confirmed, and the most
  important finding.** Traced the import graphs: `wavesurfer.js` and
  `player-views.js` both statically import the identical
  `/assets/wavesurfer.esm.js`. If that one shared file 404s or fails to
  parse, BOTH graphs fail — not just the new engine. Verified all five
  failure modes in the finding by tracing each import chain by hand; all
  five check out, including the "no module support" case matching today's
  UNFLAGGED-page baseline exactly (waveform rows there already depend
  entirely on `wavesurfer.js` as a module script — this isn't new fragility
  Step 4 introduced, it's fragility that already existed and my language
  didn't carve out). This directly contradicts language I used repeatedly
  this session — in the plan, in HANDOFF.md, and in chat replies ("confirm
  the page falls back to a working legacy player, waveform rows included").
  That claim is false for exactly one dependency: the vendored WaveSurfer
  asset itself. **Action: fix the wording in the plan and HANDOFF before the
  browser pass**, so whoever runs it (there's no browser in this
  environment) tests the right claim — module/asset failures in
  `player-boot.js`/`player-views.js`/`player-controller.js` fall back
  completely; a `wavesurfer.esm.js` failure does not, and never has.
- **#4 Medium, test-quality/mutation-check overclaim — confirmed, reproduced
  both named mutations.** (a) Deleted the entire engine-gate block from
  `player.js` (reverting to unconditional `initLegacyPlayback()`) — all 51
  tests across the three suites still passed, because none of them ever
  loads `player.js`. Same result deleting `wavesurfer.js`'s gate. (b) Removed
  the `_upgradeWave()`/`_drawInertWave()` calls from `PlayerView.setPeaks()`,
  leaving only `this.peaks = peaks` — all 51 tests still passed; the "failed
  peaks fetch" test only asserts the stored `.peaks` property, never that
  drawing was invoked. **Correction to my own prior claim:** "each boot test
  was mutation-checked" was true for the specific behaviors I actually
  checked this session (hashchange-not-autoplaying, the Space form-field
  guard, row-click queue-scoping, the peaks-fetch-failure fallback *value*,
  and the partial-mount teardown, all independently reverted and confirmed
  failing) — but it was not exhaustive, and these two gaps are real. Neither
  is close to the modules I mutation-checked; they're the two pieces of
  Step 4 that were never checked at all.
- **#5 Low, asset-import-graph checker gap — confirmed, already known.** I'd
  flagged this exact gap (`IMPORT_RE`'s dynamic-`import()` blind spot,
  concretely `player.js:401`'s `await import('/assets/client-zip.js')`) to
  the user before this review ran, specifically left unfixed as a live test
  of whether the review would catch it. It did. The double-quote/side-effect/
  re-export sub-gaps are currently latent — no shipped script uses those
  forms — but the checker is still narrower than its docstring claims.
- **#6 Low, timing-comment wording — confirmed.** "Beats any fetch" and
  "under any script placement" (both phrases appear verbatim, in
  `wavesurfer.js:162` and twice in the plan) overstate a general guarantee
  that doesn't hold outside this architecture's specific case. The actual
  page is safe for the narrower reason Codex traced against spec: emitted
  scripts are parser-inserted modules in document order, and the flag check
  runs synchronously in that same job, before any fetch continuation could
  interleave. Wording-only; no code behavior is wrong.

**What I'd change if approved (not done — `/apply-review`'s job):**
1. Give `PlaybackController` a real `_destroyed` guard on every transport
   method, and have `player-boot.js`'s `handle.destroy()` remove the
   keyboard/deep-link/resize listeners it installed (one boot-level
   `AbortController`, matching the pattern `PlayerView` already uses).
2. Extend `verify_markup.py` to enumerate `.track-row`/`.recording-item`
   elements independently and require a valid `data-item` on each, on
   allowlisted pages — not just validate whatever it happens to find.
3. Rewrite the "complete legacy engine pair" framing in the plan and
   HANDOFF.md to name `wavesurfer.esm.js` as the one dependency shared by
   both engines, whose failure is not survived by either.
4. Add the two missing mutation-guarded assertions: a boot test that loads
   real `player.js`/`wavesurfer.js` source and confirms the engine gate
   actually suppresses their init when a peer boot succeeds (this needs
   either a minimal DOM capable of executing classic scripts, or a
   source-level assertion that the gate exists and wraps the right calls);
   and a `setPeaks()` test asserting `_upgradeWave`/`_drawInertWave` was
   actually invoked, not just that `.peaks` was stored.
5. Tighten `IMPORT_RE` to also catch `import(` dynamic calls (at minimum);
   double-quote and side-effect forms can wait until something actually uses
   them.
6. Reword the two timing comments to state the actual guarantee (parser-
   inserted module ordering, same-job synchronicity) instead of "any fetch"
   / "any script placement."

None of this blocks the still-outstanding browser pass from the previous
session's plan — it's the item ordering that changes: #1 and #3 above are
worth fixing before that pass, since #3 changes what the pass should
actually be testing for the waveform-asset-failure case.

### Fixes applied (Claude, 2026-08-14)

All six findings fixed. Every behavioral fix got a regression test, and every
one of those tests was proven meaningful the same way — the fix reverted,
the test confirmed **failing**, the fix restored, full suite confirmed green
again — not just written and assumed to work.

- **#1 (fixed).** `PlaybackController` gained a `_destroyed` guard on every
  mutating method (`setQueue`, `appendQueue`, `removeAt`, `reorder`, `play`,
  `playSingleton`, `pause`, `toggle`, `stop`, `seek`, `seekBy`, `next`,
  `prev`, `setRepeatOne`, `toggleShuffle`, `mount`) and `destroy()` itself is
  now idempotent. `player-boot.js` gained one `AbortController` shared by
  mounting AND decoration (previously two separate try/catch boundaries —
  the finding's second half, a decoration throw leaving a mounted-but-
  unclaimed controller, is fixed by merging them into one), with
  `handle.destroy()` aborting it before destroying the controller.
  `test-fake-dom.mjs`'s `FakeElement`/`FakeWindow` gained real `{ signal }`
  support (mirroring the DOM) so this is exercised in Node, not just by
  inspection. Five new tests in `test-player-boot.mjs` (destroy() stopping a
  leaked Space/hashchange-load/resize listener; the controller refusing
  every mutating call directly; `mount()` refusing to attach post-destroy).
  **Both halves proven independently necessary**, not just both present:
  reverting only the controller guards left the two controller-state-backed
  tests failing (Space, hashchange) but NOT the resize test (proving resize
  isn't backstopped by controller state); reverting only the boot-level
  abort left only the two controller-direct tests failing. Neither fix alone
  covers what the other does.
- **#2 (fixed).** `verify_markup.py` gained `check_every_row_has_item()`,
  enumerating `.track-row`/`.recording-item` ELEMENTS independently of
  whether `data-item` is present (the old `ITEM_RE`-only approach structurally
  cannot notice an absent attribute — proven by running it against a
  real mutated page, where it found 0 errors). Carries its own in-memory
  `_selftest()`, run automatically every invocation. `player-boot.js` also
  refuses to claim a page where its selectors found zero rows/heroes to
  mount, as a runtime backstop for the same invariant — new test in
  `test-player-boot.mjs`.
- **#3 (fixed — wording only, no behavior changed).** The "falls back to the
  complete legacy engine pair" claim is corrected everywhere it appeared
  (the plan's intro, Step 4's build-notes, Step 4's "still to verify" note,
  Step 5's cost description) to name `wavesurfer.esm.js` as the one
  dependency shared by both engines, whose failure neither survives — not
  new fragility Step 4 introduced, just a claim that needed the exception
  carved out. The still-outstanding browser pass now has the corrected
  claim to test against.
- **#4 (fixed).** Two real gaps, both closed. `PlayerView.setPeaks()` now has
  a dedicated test in `test-player-views.mjs` asserting `_upgradeWave()`/
  `_drawInertWave()` was actually CALLED (keyed on active/inactive), not just
  that `.peaks` was stored — reproduced the named mutation (strip the two
  calls, keep the assignment) and confirmed it used to pass. `player.js`
  itself is now loaded and executed for real in two new
  `test-player-boot.mjs` cases (`readScript()`, exported from
  `test-fake-dom.mjs`) — sliced to exclude the download-modal/tooltip/share
  code that needs a real `innerHTML` parser, spliced back together with the
  deep-link section further down whose `initLegacyDeepLink()` the gate calls.
  One proves the gate stays dormant once a peer boot mounted; the other
  proves it still initializes legacy playback when nothing else claimed the
  page. Reverting the real gate in `player.js` (the same mutation used to
  verify the finding) now fails the first of these two.
  `wavesurfer.js`'s identical gate is deliberately NOT separately covered —
  scoped to one file since the finding itself offered "player.js or
  wavesurfer.js" as sufficient, and `player.js` is the one on every page.
- **#5 (fixed).** `IMPORT_RE` rewritten to catch dynamic `import()`,
  side-effect imports, and `export … from`, both quote styles — not just
  single-quoted static `from`. Confirmed it now catches `player.js:401`'s
  `await import('/assets/client-zip.js')` (previously invisible to this
  check), and confirmed end-to-end by temporarily removing
  `assets/client-zip.js` and observing 30 fresh failures where there were
  previously zero. Carries its own `_selftest()` cases for each import shape.
- **#6 (fixed — wording only).** The "beats any fetch" / "under any script
  placement" comments in `player.js`, `wavesurfer.js`, and the plan are
  rewritten to state the actual guarantee: every script here is a
  parser-inserted `<script>` in document order (`build.py`'s own output),
  and the flag check runs in that same synchronous parse job, before
  `DOMContentLoaded` is even queued — narrower than, and not equivalent to,
  a universal claim about fetches or script placement.

**Verification:** `python3 scripts/build.py --check` (31 shows, 680 tracks),
`python3 scripts/build.py` (includes `verify_markup.py`, 747 items across 30
pages, clean), and all three suites — `test-player-controller.mjs` 22/22,
`test-player-views.mjs` 16/16 (+1), `test-player-boot.mjs` 22/22 (+8) — 60
tests total, up from 51 at the start of the review. Nothing pushed or
deployed; the browser pass from the previous session's plan is still
outstanding and still gates Step 5.

---

## Phase 1 Step 4 implementation review — 2026-08-14

1. **Medium — The previous inactive-row churn fix is incomplete.**

   Evidence: every `timeupdate` notifies every view in [player-controller.js](/home/renedebos/renedebos.com-player-consolidation/scripts/player-controller.js:159) and [player-controller.js](/home/renedebos/renedebos.com-player-consolidation/scripts/player-controller.js:541). Before checking `_wasActive`, `_render()` still toggles classes and calls `_setPlayState()` for inactive rows in [player-views.js](/home/renedebos/renedebos.com-player-consolidation/scripts/player-views.js:183), which replaces the button’s SVG through `innerHTML` and rewrites its ARIA label at line 219. This contradicts the no-inactive-rewrites claims in [player-consolidation-plan.md](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:390) and line 705. The passing test at [test-player-views.mjs](/home/renedebos/renedebos.com-player-consolidation/scripts/test-player-views.mjs:294) watches only the inactive time label, so it misses button and class writes. A direct 25-tick probe observed 25 `innerHTML` writes and 25 `aria-label` writes on one inactive row.

   Why it matters: the allowlisted pages carry 20–24 rows, and the wider rollout reaches 34. Re-parsing SVG markup for every inactive button on every media tick creates exactly the per-item DOM churn the optimization claims to have removed.

   Suggested fix: return early from `_render()` when a view is inactive and was not previously active, before class/button updates, or cache the last rendered `(active,state)` tuple. Extend the test to instrument button `innerHTML`, attributes, class mutations, time text, and canvas creation—not only `timeEl.textContent`.

2. **Medium — Late peaks decoration is not inside the claimed transactional failure boundary.**

   Evidence: `bootShowPage()` invokes `attachPeaks()` without awaiting its promise at [player-boot.js](/home/renedebos/renedebos.com-player-consolidation/scripts/player-boot.js:101), then returns and sets the mounted flag at lines 205–206. Exceptions from the later `.then(apply)` at lines 132–135 therefore cannot reach the surrounding synchronous `try/catch`, despite the comments at lines 38–49 and 98–100 saying mounting and decoration share one catch. `setPeaks()` can perform canvas or WaveSurfer construction at [player-views.js](/home/renedebos/renedebos.com-player-consolidation/scripts/player-views.js:107). A delayed-fetch probe with `setPeaks()` throwing produced an unhandled `late decoration failed` rejection after the controller had claimed the page.

   Why it matters: once `PLAYER_ENGINE_MOUNTED` is set, the legacy engines remain dormant. A late WaveSurfer/DOM failure cannot trigger the advertised fallback and may leave a claimed page with a broken waveform and an unhandled rejection.

   Suggested fix: make asynchronous decoration explicitly best-effort and exception-isolated per view. Catch `setPeaks()` failures without retrying the same throwing path, abort/ignore results after teardown, and keep native controller playback usable. Correct the comments and plan to say only synchronous mount/decorator registration is transactional. Add a delayed-fetch test where `setPeaks()` throws and assert there is no unhandled rejection and playback remains usable.

3. **Medium — The browser pass does not prove that every real-page view mounted or that both legacy engines stayed dormant.**

   Evidence: the harness records `viewCount` at [browser_check.mjs](/home/renedebos/renedebos.com-player-consolidation/scripts/browser_check.mjs:137), but the passing condition at line 141 checks only the flag and existence of `PLAYER_BOOT`. It never compares mounted roots with the real `[data-item]` elements. Its legacy check at lines 144–146 looks only for `player.js`’s `_audio` marker on `.custom-player`; legacy `wavesurfer.js` creates WaveSurfer instances at [wavesurfer.js](/home/renedebos/renedebos.com-player-consolidation/scripts/wavesurfer.js:45) without setting that marker. Nevertheless, the plan says the legacy engine “provably stays dormant” on all three pages at [player-consolidation-plan.md](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:1092). The Node source test also deliberately covers only `player.js`, not `wavesurfer.js`, as documented at plan lines 745–756.

   Why it matters: a missed view or double-mounted legacy WaveSurfer is the central rollout risk. The current harness can report “controller mounted” with an incomplete view set, and its stated marker cannot directly distinguish dormant from active legacy waveform initialization.

   Suggested fix: assert that `PLAYER_BOOT.views.length` equals the real row-plus-card count and that every expected element is represented exactly once. Before activating a row, assert that no legacy WaveSurfer shadow root/media element exists, or expose an explicit dev-only legacy initialization marker. Exercise every hero on the multipart and alternate-transfer pages, not only the first card.

**Verification during this review**

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks.
- `python3 scripts/verify_markup.py` — passed: 747 items across 30 show pages.
- `node scripts/test-player-controller.mjs` — passed, 22/22.
- `node scripts/test-player-views.mjs` — passed, 16/16.
- `node scripts/test-player-boot.mjs` — passed, 22/22.
- Inactive-row write probe — reproduced 25 SVG and 25 ARIA writes over 25 ticks.
- Delayed peaks-decoration failure probe — reproduced an unhandled rejection after successful mount.
- `NODE_PATH="$(npm root -g)" node scripts/browser_check.mjs --skip-webkit` — could not start Chromium in this read-only environment: Playwright failed creating `/tmp/playwright-artifacts-*` with `EROFS`; no browser assertions ran.
- `git diff --check` and source/generated player asset comparisons — passed; working tree clean and all three generated player assets match their sources.
_Review generated 2026-08-14 09:21:45 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-14)

Requested focus was the new `--prod` commit (1ff1aa5) and PR #3's readiness
to merge; Codex instead surfaced three pre-existing gaps in Step 4's
original implementation and in the older parts of `browser_check.mjs`. All
three confirmed by reading the actual code (not re-run via Codex's own
probes, which don't persist outside its sandboxed session) — none are
factually wrong, and none touch this session's `--prod` code specifically.

- **#1 Medium, inactive-row rewrites incomplete — confirmed.** `_render()`
  (`player-views.js:177-212`) only gates the progress/time/canvas paint path
  behind `if (active) {} else if (this._wasActive) {}` (193-209). The
  `classList.toggle(...)` calls (183-184) and `_setPlayState()` (186-191 —
  which unconditionally does `this.btn.innerHTML = iconHtml` and
  `setAttribute('aria-label', ...)` at 219/222) run on *every* `_render()`
  regardless of active state, and `_render()` runs on every controller
  `_notify()`, which fires on every `timeupdate`
  (`player-controller.js:159-167`). Directly contradicts the explicit claims
  at `player-consolidation-plan.md:390-392` and `:705`. The existing
  regression test (`test-player-views.mjs:294`) only instruments
  `timeEl.textContent` — it never watches `innerHTML` or `aria-label`, so it
  passes today despite the button/icon churn it was meant to catch. Real
  defect and a real test gap, not just a documentation mismatch.
- **#2 Medium, async peaks decoration isn't actually inside the boot-level
  try/catch — confirmed.** `bootShowPage()` (`player-boot.js:57-111`) calls
  `attachPeaks(handle, win)` synchronously inside the try (line 101) but
  never awaits or `.catch()`s its returned promise, then returns `handle`
  immediately (105). The auto-run block sets `MOUNTED_FLAG` synchronously
  right after `bootShowPage()` returns (200-211) — before `attachPeaks`'s
  fetch chain has resolved. A throw inside `apply()` (133, or its own
  fallback at 135) runs in a microtask outside the synchronous try/catch's
  stack frame, so it is *not* "caught exactly like a malformed-markup throw"
  the way the header comment (38-49) claims — that claim holds for the
  decoration steps' synchronous wiring, not for this async continuation.
  Real mismatch between documented and actual behavior: a `setPeaks()`
  failure that surfaces after the fetch lands produces an unhandled
  rejection on an already-claimed page, with no fallback available (legacy
  is already dormant by then).
- **#3 Medium, `browser_check.mjs`'s "mounted"/"legacy dormant" checks don't
  prove what their names claim — confirmed.** The `controller mounted`
  check (~line 141, pre-existing, not part of this session's diff) passes on
  `flag === true && hasBoot` alone — `viewCount` is captured and printed but
  never compared against the real row+card count, so an incomplete view set
  would still report PASS. The `legacy engine stayed dormant` check
  (~144-146) only looks for player.js's `_audio` marker on `.custom-player`;
  wavesurfer.js is gated by the identical `window.PLAYER_ENGINE_MOUNTED`
  check (confirmed at `wavesurfer.js:171-173`) but sets no equivalent marker
  on `.ws-track` rows, and nothing in the harness inspects WaveSurfer/
  `.ws-track` state when the controller is active. Both engines are in fact
  gated by the same flag today, so this isn't evidence of a live bug — it's
  a real verification gap: a regression specific to wavesurfer.js's own gate
  (as opposed to player.js's) would slip past this harness undetected.
  Codex's own verification block notes it couldn't actually run
  `browser_check.mjs` in its sandboxed environment (Playwright `EROFS`), so
  this finding is from reading the code, not an observed harness failure —
  it holds up on inspection regardless.

**Not raised, and independently checked anyway:** whether this session's
actual `--prod` additions (the `isRemote` gating logic, `checkAssetHeaders`,
`checkNonAllowlistedPagesUnaffected`) have defects of their own — despite
being the stated focus, Codex didn't flag anything there. Before committing,
I independently verified the `_headers` Cache-Control expectation, the real
selectors/markup for the five non-allowlisted sample pages, the `#p=` hash
format, and `tracks.json`'s shape against the actual repo state (not
assumed) and found no issue. Nothing in this review changes that.

**Recommendation:** #1-#3 are all pre-existing Step 4 issues already on this
branch (not introduced by PR #3's new commit), so they don't block merging
PR #3 on their own new-code merits — but they are real correctness/testing
gaps worth fixing before this canary is trusted further (5b's wider
rollout in particular would amplify #1's per-tick DOM churn across ~34 rows
per page instead of ~24). Whether to fix them now (via `/apply-review`)
before merging, or merge as-is and fix in a follow-up commit, is a call for
Rene — flagging it rather than deciding it here.

### Fixes applied (Claude, 2026-08-14)

Rene approved fixing all three before merging PR #3. All fixed, each with a
regression test proven to fail on the unfixed code first, then pass after —
verified independently (re-ran the full suite and the real-browser pass
myself, not just trusted the implementing pass's report).

1. **Fixed.** `player-views.js`'s `_render()` now returns immediately when
   `!active && !this._wasActive`, before any DOM write — the same guard
   condition the progress/canvas block already used, applied earlier so it
   covers the button icon and `aria-label` too. Extended the existing
   regression test (`test-player-views.mjs:294`) to instrument
   `innerHTML`/`aria-label` writes on the inactive row, not just the time
   label. **Proven failing first:** ran against the unfixed code — 25/25
   icon and aria-label writes over 25 ticks, matching the review's own probe
   exactly. Passed cleanly after the fix. One necessary fixture correction
   surfaced along the way: `test-player-views.mjs`'s `trackRow()` fixture
   started with a blank `aria-label`, which only worked before because the
   (buggy) unconditional initial render filled it in — updated the fixture
   to pre-set `aria-label="Play <label>"`, mirroring what
   `fragments.py:159-173`'s real server-rendered markup actually ships, which
   is exactly the fact the fix's safety argument depends on (verified by
   reading `fragments.py` directly, not assumed).
2. **Fixed.** `attachPeaks()` in `player-boot.js` now wraps each view's
   `setPeaks()` call in its own try/catch inside `apply()` (log and continue
   on failure — one bad row can no longer abort the loop or trigger a
   retry-from-scratch that downgrades already-decorated rows), uses the
   two-argument `.then(onFulfilled, onRejected)` form so only a genuine
   fetch/parse failure triggers the empty-map fallback, and ends in a
   trailing `.catch()` so the returned promise can no longer reject at all.
   Both overclaiming comments (the `bootShowPage` header and the
   `attachPeaks` call-site comment) rewritten to say precisely what the
   shared try/catch covers (synchronous wiring only) versus what protects
   the async continuation (per-view isolation, not the try/catch). New
   regression test in `test-player-boot.mjs` patches one row's `setPeaks` to
   always throw, mounts with `holdPeaks`, releases the fetch, and watches
   `process.on('unhandledRejection', ...)`. **Proven failing first:** ran
   against the unfixed code — one unhandled rejection observed (the test's
   own listener caught it cleanly rather than crashing the process, which is
   itself useful information about Node's exact behavior here). Passed
   cleanly after the fix, including confirming the row before and the row
   after the throwing one both still received their real peaks data, and
   that the controller stayed fully playable afterward.
3. **Fixed.** `browser_check.mjs`'s `runParityPass()` now asserts
   `viewCount === expectedViewCount` (computed from the real
   `.track-list [data-item]` + `.recording-item[data-item]` count in the
   same `page.evaluate` call) instead of only printing it, and adds a
   pre-interaction dormancy check for `wavesurfer.js` specifically: on pages
   with `.ws-track` rows, before any click, `findAudioDeep(document.body)`
   must find zero real `<audio>` elements — true only if neither the
   controller's own shared audio element (never appended to the document,
   confirmed by grep) nor an eagerly-built legacy WaveSurfer instance
   exists yet. This lives in a manual/dev-only harness, not the `test-*.mjs`
   node suites, so there's no unit-level fail-then-pass proof for it; instead
   ran it for real (positive control) against the actual deployed-nowhere
   local build: **44/44 passed**, including the new checks on all three
   allowlisted pages (`views=21/expected=21`, `views=23/expected=23`,
   `views=26/expected=26`; `audioElements=0` on all three) — confirming the
   new assertions are correctly wired and don't false-positive against
   known-good code. Re-ran this myself independently after the implementing
   pass reported the same 44/44, to be sure.

**Re-verification (run independently, not just trusted):**
```
python3 scripts/build.py --check   → integrity OK — 31 shows, 680 curated tracks
python3 scripts/build.py           → markup OK — 747 items across 30 generated show pages
node scripts/test-player-controller.mjs → 22/22
node scripts/test-player-views.mjs      → 16/16
node scripts/test-player-boot.mjs       → 23/23
NODE_PATH="$(npm root -g)" node scripts/browser_check.mjs --skip-webkit → 44/44
```

Nothing here touches PR #3's actual new commit (the `--prod` extension
itself) — that code was independently checked before it was committed and
nothing in this pass changed the assessment. PR #3 is ready to merge as far
as this review is concerned.

## Ninth review — Step 5b readiness — 2026-08-14

Run via the Codex MCP server directly (`mcp__codex__codex`, sandbox
`read-only`), not `scripts/codex_review.sh` — a different invocation path
than every prior review in this log, at Rene's explicit request. Focus:
whether the current code and Step 5a's record actually support proceeding
to Step 5b (widening `CONTROLLER_ENGINE_SLUGS` to all show pages).

**Conclusion:** the shared runtime (`player-controller.js`/`player-views.js`/
`player-boot.js`) looks capable of handling all 30 published show pages, and
the eighth review's three fixes hold up. Not ready to *start implementing*
5b as a one-line allowlist edit, though — the verification tooling and two
pieces of documentation need to catch up first.

1. **High — `browser_check.mjs` cannot be reused unchanged for 5b.** `ALLOWLIST`
   (line 90-98) is hardcoded to the 3 current slugs. `NON_ALLOWLISTED_PAGES`
   (line 466-470) explicitly includes `/shows/jerry-cafe-java-1999-04-08/` as
   a page that must NOT have the controller mounted — after 5b widens the
   allowlist to all shows, that page WOULD be allowlisted, so this exact
   check would assert the opposite of what would then be true.
2. **Medium — nothing enforces that 5b actually covers every generated show,
   and there's a dangerous stale comment.** `verify_markup.py`'s `check()`
   (line 151-157) only catches an allowlisted slug that generates no page —
   never the reverse (a generated public show missing from the set).
   Separately, `pages.py:684` says "Step 5 empties this out and flips the
   engine on everywhere" — but the actual gate (`pages.py:930`,
   `if show["slug"] in CONTROLLER_ENGINE_SLUGS:`) is a membership check.
   Literally emptying the set would disable the controller **everywhere**,
   the opposite of what the comment says. Read that comment as wrong, not
   as a spec — 5b needs the set actually filled with every public show slug
   (or the gate inverted to an exclude-list), not emptied.
3. **Medium — the new wavesurfer.js dormancy check is timing-dependent.**
   `browser_check.mjs` waits a fixed 500ms after load (line 135) then checks
   for zero real `<audio>` elements. Legacy `wavesurfer.js`'s `start()`
   (`wavesurfer.js:136-146`) fetches peaks asynchronously before calling
   `build()` (which is what actually constructs the WaveSurfer/`<audio>`
   instances) — on a slow response, the check could read "dormant" before a
   wrongly-running legacy engine has even reached `build()` yet. Not an
   active bug (the gate itself is provably correct via the identical
   `PLAYER_ENGINE_MOUNTED` check both engines share), but a real soundness
   gap in the check *as a regression detector*.
4. **Low, but concretely already demonstrated — the wider run can't
   currently be green, and one bad page can abort the whole thing.** The
   known Cloudflare-beacon CSP console warning (confirmed site-wide, see
   Step 5a's record) would produce ~30 failures instead of 3 once every show
   page is checked. Separately, the per-page loop (`for (const path of
   ALLOWLIST)`, line 128) has no try/catch — a single page's failure throws
   and aborts evaluation of every remaining page. This is not hypothetical:
   it's exactly what happened on Step 5a's first, non-reproducing production
   hit (see that record above) — becomes far more costly at 30 pages than 3.
5. **Documentation drift, confirmed on inspection:**
   - `player-consolidation-plan.md:14-16` still says production verification
     is "a separate, still-outstanding step" and "nothing is pushed or
     deployed" — stale; missed when the Step 5a record was added further
     down in the same document.
   - `HANDOFF.md:8` says production verification "passed" — true for every
     player-consolidation-specific check, but the harness's actual exit
     code was 1 (3 of 58 checks failed, all the known unrelated CSP
     warning). Imprecise, not false, but worth tightening.
   - `HANDOFF.md`'s claim that a contemporaneous `curl` proved "the page
     itself was never wrong" overclaims what one `curl` request can prove —
     it shows *a* request got the correct HTML at that moment, not
     necessarily that Playwright's specific request hit the same edge
     response. Fair correction.

### Disposition (Claude, 2026-08-14)

All five findings confirmed by reading the actual code/docs directly, not
taken on the review's word:

- **#1 confirmed** — read `browser_check.mjs:90-98` and `:466-470` myself;
  exactly as described.
- **#2 confirmed, and the more important of the two Medium findings** — read
  `verify_markup.py:151-157` (no reverse check) and `pages.py:678-686` /
  `:930` directly. The stale comment is a real hazard: a future
  implementation of 5b that took "empties this out" literally would silently
  revert the entire site to 100% legacy while looking, on a quick read, like
  the rollout had completed. Treating this as the highest-priority item to
  fix before 5b, comment severity notwithstanding.
- **#3 confirmed** — read `wavesurfer.js:136-146`; the async fetch-before-
  `build()` sequence is exactly as described. Agree it's not an active bug
  today (the underlying gate is sound) but is worth hardening before relying
  on this check across a much larger, less-audited page set.
- **#4 confirmed on both counts** — grepped for `try`/`catch` around the
  `ALLOWLIST` loop (`browser_check.mjs:128`), none exists; and the
  CSP-multiplication math is straightforward given Step 5a's own record
  that the warning is site-wide. The "one bad page aborts everything" part
  isn't theoretical — it's the same failure mode as Step 5a's first,
  non-reproducing production hit, now recognized as a real gap rather than
  a one-off.
- **#5 confirmed, all three sub-points** — read the exact lines named in
  each. `plan.md:14-16` is a genuine miss (I updated Step 4/5a's own
  sections but not this earlier summary paragraph). The `HANDOFF.md`
  wording issues are fair precision corrections, not factual errors.

**Recommendation, not yet actioned:** fix items #2 (the stale/dangerous
comment plus a real completeness check) and #5 (documentation) essentially
for free — they're small and unambiguous. Items #1, #3, #4 are real
prerequisites for 5b specifically (updating `browser_check.mjs` for a wider
allowlist, a robustness pass on the per-page loop, and deciding how to
handle the known CSP warning at scale) rather than blockers on the
already-shipped Step 5a. Whether to fix all of this via `/apply-review`
before starting 5b's implementation, or fold some of it into 5b's own work
directly, is Rene's call — reporting rather than deciding here.

### Fixes applied (Claude, 2026-08-14)

Rene approved fixing all five findings as prep work before starting 5b's
actual implementation (`CONTROLLER_ENGINE_SLUGS` itself is untouched — that
remains 5b's own, separate, not-yet-approved step). All fixed, independently
re-verified myself rather than only trusting the implementing pass's report:

1. **Fixed.** `runParityPass`'s per-page loop (`browser_check.mjs`) now
   wraps each page's body in try/catch; a crash records
   `${path} page-level crash` with the error message and moves to the next
   page instead of aborting the whole run. Lives in a manual dev-only
   harness with no unit-test coverage (same situation as several eighth-
   review fixes), so verified with real runs instead: local pass still
   44/44; the `isRemote` code path exercised by pointing `--base=` at a
   local `python3 -m http.server` standing in for production (never hit
   real production for this) — 54/58.
2. **Fixed.** The known Cloudflare-beacon CSP console message is now
   filtered out of every "no console errors" check (both the per-page loop
   and `runWebkitSmoke()`) via one narrowly-scoped regex, with a comment
   making clear this is one specific, confirmed, pre-existing, site-wide
   message — not a general CSP-ignoring policy.
3. **Fixed.** Added `await page.waitForLoadState('networkidle')`
   immediately before the wavesurfer.js dormancy check, so an in-flight
   peaks fetch (in either engine) has resolved either way before the check
   reads the DOM. Left the earlier, unrelated fixed timeout alone since
   other checks depend on it.
4. **Fixed.** `checkNonAllowlistedPagesUnaffected`'s non-allowlisted
   show-page sample is no longer hardcoded — `pickNonAllowlistedShowPage()`
   fetches the real `assets/home-shows.json` (the same asset the homepage
   itself uses) and picks the first show not in `ALLOWLIST`, gracefully
   skipping that one sub-check if none remain (a future full rollout).
   Verified for real: against the local-server-as-remote-target run above,
   it correctly picked `/shows/mad-marin-brewing-co-1998-04-01/` — a
   different page than the old hardcoded one, confirming the logic is
   genuinely dynamic, not coincidentally landing on the same value.
5. **Fixed.** `pages.py`'s backwards "Step 5 empties this out and flips the
   engine on everywhere" comment corrected to state plainly that the gate is
   a membership check, so 5b needs to widen the set (or invert to an
   exclude-list) — never empty it.

**Also added, beyond a strict reading of "fix the finding":**
`verify_markup.py --check-allowlist-coverage` — a new function
(`check_allowlist_covers_every_public_show`), deliberately **not** wired
into the default `check()`/`main()` path (today's 3-page allowlist is an
intentional partial rollout; wiring this in unconditionally would fail
every build until 5b/5c lands). Covered by two new cases in the existing
`_selftest()`. Confirmed independently: `build.py --check` and
`verify_markup.py`'s default path are genuinely unaffected, while
`--check-allowlist-coverage` correctly fails today, listing all 27
not-yet-allowlisted public shows by name — real tooling ready for 5b to
invoke once it's actually widened the set, not just a comment fix.

**Documentation** (`player-consolidation-plan.md`'s opening paragraph,
`HANDOFF.md`'s "passed" framing and the `curl` overclaim) corrected to
match the disposition above — see those files directly rather than
duplicating the wording here.

**Re-verification (run independently):**
```
python3 scripts/build.py --check        → integrity OK — 31 shows, 680 curated tracks
python3 scripts/build.py                → markup OK — 747 items across 30 generated show pages
python3 scripts/verify_markup.py        → markup OK (self-test included, unaffected by the new function)
python3 scripts/verify_markup.py --check-allowlist-coverage → correctly FAILS, 27 shows listed
NODE_PATH="$(npm root -g)" node scripts/browser_check.mjs --skip-webkit → 44/44
node scripts/browser_check.mjs --base=http://127.0.0.1:8123 --skip-webkit (local server standing in for prod) → 54/58, all 4 non-passes expected (bare http.server doesn't set Cloudflare's real Cache-Control headers)
```

Nothing here touches `CONTROLLER_ENGINE_SLUGS` or widens the rollout —
Step 5b's actual implementation is still a separate, not-yet-started step.

---

## Step 5b implementation review — 2026-08-14

1. **High — Step 5b is marked complete before its required production verification.**  
   Evidence: [player-consolidation-plan.md](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:1246) marks 5b `[x]` and calls it “Done,” although the step itself requires production-equivalent verification before it is settled at line 1252, and lines 1296–1299 explicitly say production verification is pending. [HANDOFF.md](/home/renedebos/renedebos.com-player-consolidation/HANDOFF.md:5) likewise says it is not merged or deployed.  
   Why it matters: the checklist says the rollout gate passed when only local implementation passed. A later agent could proceed to 5c and delete the fallback before the site-wide rollout has been exercised against production caching and headers.  
   Suggested fix: split 5b into “implementation/local verification” `[x]` and “merge/deploy/production verification” `[ ]`, leaving the parent incomplete until `browser_check.mjs --prod` succeeds and its result is recorded.

2. **Medium — The advertised single-page rollback escape hatch is rejected by both the build gate and browser harness.**  
   Evidence: [pages.py](/home/renedebos/renedebos.com-player-consolidation/scripts/sitegen/pages.py:693) describes `CONTROLLER_ENGINE_EXCLUDED_SLUGS` as a targeted rollback mechanism, and line 713 subtracts it from the allowlist. However, [verify_markup.py](/home/renedebos/renedebos.com-player-consolidation/scripts/verify_markup.py:164) unconditionally requires every public slug to remain in `CONTROLLER_ENGINE_SLUGS`; simulating one exclusion produces `CONTROLLER_ENGINE_SLUGS is missing public show(s)`. The production harness also constructs its “allowlisted” set from every `ALL_SHOWS` entry and therefore can never discover an exclusion ([browser_check.mjs](/home/renedebos/renedebos.com-player-consolidation/scripts/browser_check.mjs:548)); its main loop would instead report the intentionally excluded page as a mount failure.  
   Why it matters: during a page-specific incident, the documented rollback edit cannot pass the normal build or verification process.  
   Suggested fix: validate that `allowlisted ∪ excluded == PUBLIC_SHOWS`, that the two sets are disjoint, and that exclusions are valid public slugs. Export an explicit rollout manifest to the browser harness so excluded pages are tested for working legacy fallback rather than controller mounting.

3. **Medium — The full-catalog browser check lets the deployed catalog define its own test scope.**  
   Evidence: [browser_check.mjs](/home/renedebos/renedebos.com-player-consolidation/scripts/browser_check.mjs:122) trusts the target origin’s `home-shows.json` without checking its status, schema, uniqueness, expected slug set, or presence of all four heavy-test slugs; line 169 visits only entries returned by that response, while lines 740–742 fail only recorded negative results. A stale or truncated but valid JSON array can therefore omit pages and still produce a green exit with fewer checks. Moreover, [feeds.py](/home/renedebos/renedebos.com-player-consolidation/scripts/sitegen/feeds.py:94) intentionally puts only shows with tracks into `home-shows.json`, while the controller allowlist covers every public show.  
   Why it matters: the pending production verification can falsely report success without checking every page Step 5b claims to cover. A future public hero-only show would be enabled but never enter this harness.  
   Suggested fix: derive an expected rollout manifest from local `PUBLIC_SHOWS`, compare the deployed manifest against it exactly, assert unique slugs/URLs and that every heavy slug exists, then iterate the expected set rather than the target response’s set.

4. **Low — The largest-page browser run does not test the DOM-churn regression it is claimed to stress.**  
   Evidence: the plan calls the 34-track page a real stress test for inactive-row churn at [player-consolidation-plan.md](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:1279), but the heavy browser path only checks playback, toggle, seek, Space, and canvas presence ([browser_check.mjs](/home/renedebos/renedebos.com-player-consolidation/scripts/browser_check.mjs:243)). It never observes mutations or DOM writes. The actual churn assertion remains a two-row synthetic fixture in [test-player-views.mjs](/home/renedebos/renedebos.com-player-consolidation/scripts/test-player-views.mjs:300).  
   Why it matters: the browser test would still pass if every inactive row were rewritten on every tick, so the plan overstates what 184/184 establishes.  
   Suggested fix: either remove the “stress test” claim or attach a `MutationObserver` to inactive controls on the large real page and assert zero relevant mutations across repeated `timeupdate` events.

**Verification during this review**

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks.
- `python3 scripts/verify_markup.py` — passed: 747 items across 30 generated show pages.
- `python3 scripts/verify_markup.py --check-allowlist-coverage` — passed: all 30 public shows.
- Player Node suites — passed: controller 22/22, views 16/16, boot 23/23.
- Generated-markup audit — all 30 pages contain exactly one controller flag, boot module, and dormant `wavesurfer.js` tag; largest page is correctly 34 tracks plus 5 recording cards.
- `NODE_PATH="$(npm root -g)" node scripts/browser_check.mjs --skip-webkit` — could not run in this read-only environment: Playwright failed creating `/tmp/playwright-artifacts-*` with `EROFS`; the recorded 184/184 result was therefore not independently reproduced.
- `git diff --check HEAD^..HEAD` — passed.
_Review generated 2026-08-14 11:35:29 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-14)

All four findings confirmed. #2 was independently reproduced, not just read
and agreed with — it's the most important finding in this review.

- **#1 confirmed.** `player-consolidation-plan.md:1246` marks 5b `[x]` and
  a "Done" note follows immediately, even though 5b's own text (line 1252)
  defines "verify the wider rollout the same way as 5a" as part of being
  settled, and the very next paragraph in that same edit says production
  verification is still pending. `HANDOFF.md:5` is consistent (correctly
  says not yet merged), so the drift is localized to the plan checkbox —
  still a real overclaim worth fixing.
- **#2 confirmed, reproduced directly, the important one.** Ran
  `check_allowlist_covers_every_public_show` myself with one slug removed
  from a simulated `CONTROLLER_ENGINE_SLUGS` (exactly what setting
  `CONTROLLER_ENGINE_EXCLUDED_SLUGS = {"some-slug"}` would produce):
  ```
  Coverage check errors: ["CONTROLLER_ENGINE_SLUGS is missing public show(s): ['jerry-19-broadway-1999-02-01']"]
  ```
  Since this function now runs inside `check()`'s default gate, `python3
  scripts/build.py --check` — the exact gate CI runs before every deploy —
  would **fail** the instant the escape hatch is used for its documented
  purpose. The rollback mechanism I built in the same commit as the gate
  that rejects it. Separately confirmed `browser_check.mjs`'s
  `pickNonAllowlistedShowPage`/main loop treat every entry in
  `ALL_SHOWS` (fetched from `home-shows.json`) as expected-allowlisted, so
  an excluded page would show up as a `controller mounted` FAILURE with no
  way to tell "correctly excluded" apart from "actually broken." Real,
  active, load-bearing bug — this is exactly the mechanism Rene would reach
  for during a real incident, and it doesn't work.
- **#3 confirmed.** Grepped `feeds.py:94-96` directly:
  `build_home_shows()` iterates `[s for s in PUBLIC_SHOWS if s.get("tracks")]`
  — "one row per **track-listed** show," per its own docstring. So
  `home-shows.json` ⊆ `PUBLIC_SHOWS`, not `==`, while `CONTROLLER_ENGINE_SLUGS`
  (this step's own change) is computed from all of `PUBLIC_SHOWS`. They
  happen to coincide today (the one trackless public show is hidden), so
  this isn't an active bug, but it's a real, currently-latent gap: a future
  public show without a track list yet (the runbook's "whole-show entry,
  `tracks: null`" state) would get the controller engine but never be
  exercised by this harness, silently. Confirmed as described.
- **#4 confirmed.** My own wording in `plan.md`/`HANDOFF.md` called the
  34-track heavy-check page "a real stress test for the eighth review's
  inactive-row DOM-churn fix" — but the heavy tier only checks
  playback/toggle/seek/Space/canvas, never counts DOM writes on inactive
  rows. The actual churn assertion is still only the synthetic 2-row unit
  test. Fair correction — I overclaimed what 184/184 demonstrates.

**Recommendation:** #2 should be fixed before merging PR #4 — an
unusable-under-fire rollback mechanism is worse than not advertising one at
all, and it's a small, well-scoped fix (validate
`allowlisted ∪ excluded == public`, not `allowlisted == public`; give
`browser_check.mjs` a way to know about exclusions instead of assuming
every fetched show should be mounted). #1 and #4 are one-line documentation
corrections. #3 is real but lower-priority — proposing a scoped defensive
fix (assert the fetched catalog actually contains all `HEAVY_CHECK_SLUGS`,
fail loudly if not) rather than a full independent-manifest redesign, since
no trackless public show exists today and a fuller fix would mean changing
`home-shows.json`'s row-inclusion criteria, which the homepage itself also
depends on — a bigger, separate decision. Not yet implemented — reporting
per `/review-step`'s stop-before-applying discipline.

### Fixes applied (Claude, 2026-08-14)

Rene approved fixing all four before merging PR #4. All fixed, independently
re-verified myself (not just trusted the implementing pass's report):

1. **Fixed.** `player-consolidation-plan.md`'s 5b checkbox changed from
   `[x]` to `[~]` with an explicit note explaining why (implementation and
   local verification done; production verification — 5b's own stated
   completion criterion — still pending). Held to the same bar 5a was: 5a
   only got its `[x]` after production verification actually passed.
2. **Fixed, the important one, reproduced twice — once as the bug, once as
   the fix.** `check_allowlist_covers_every_public_show()` (`verify_markup.py`)
   now takes `(controller_engine_slugs, excluded_slugs, public_show_slugs)`
   and validates the real three-way relationship: an excluded slug that
   isn't actually public is an error; overlap between allowlisted and
   excluded is an error; a slug in neither is the real gap. Both call sites
   updated to pass `CONTROLLER_ENGINE_EXCLUDED_SLUGS`. New `_selftest()`
   cases: a deliberate exclusion now produces zero errors (**ran this
   exact case against the old two-arg logic first — it failed with
   `CONTROLLER_ENGINE_SLUGS is missing public show(s): ['show-b']`,
   confirming the bug precisely** — then applied the fix and confirmed it
   passes), and an invalid excluded slug (a typo) is still flagged by name.
   `browser_check.mjs` now fetches a new `assets/controller-excluded-slugs.json`
   (written by `build.py` from `CONTROLLER_ENGINE_EXCLUDED_SLUGS`, a
   dedicated small asset — deliberately not folded into `home-shows.json`,
   whose shape the live homepage also depends on) and uses it to skip
   excluded pages in the main mount-check loop and to let
   `pickNonAllowlistedShowPage()` find a real excluded page instead of only
   ever hitting the "everyone's allowlisted" null path. **Verified end-to-end
   with a real simulated exclusion**, not just the unit test: temporarily
   set the excluded-slugs asset to one real slug and ran the full harness
   (185→180 checks, that show's assertions cleanly absent, no false
   failure); then also stripped that show's actual generated page's engine
   flag/boot tag to simulate a truly-excluded page — still clean, no crash.
   Reverted both afterward and confirmed `git diff --stat -- shows/` was
   empty and the default full-allowlist run was back to 185/185.
3. **Fixed, scoped as proposed (not a full manifest redesign).**
   `fetchAllShowUrls()` now asserts every `HEAVY_CHECK_SLUGS` entry is
   present in the fetched `home-shows.json`, throwing immediately if not.
   The residual gap (`home-shows.json` ⊆ `PUBLIC_SHOWS`, could silently
   narrow the light-tier's scope for a future trackless public show) is
   documented in a comment at the fetch site, not fixed — correctly out of
   scope, since a real fix means changing `home-shows.json`'s row-inclusion
   criteria and that asset's shape is also load-bearing for the live
   homepage listing.
4. **Fixed properly, not just reworded.** The `jerry-19-broadway-1999-03-29`
   heavy check now attaches a real `MutationObserver` (via `page.evaluate`,
   results read back from `window.__mutationLog`) to an inactive row before
   playback starts, observing through the existing playback/toggle/seek/
   Space sequence with no new waits needed, and asserts zero mutations.
   Confirmed passing for real: `PASS - .../jerry-19-broadway-1999-03-29/
   inactive row not rewritten during playback/toggle/seek/Space (DOM-churn
   stress test) :: mutations=0`. The plan/HANDOFF language now describes
   what this check actually measures instead of what it was hoped to imply.

**Re-verification (run independently):**
```
python3 scripts/build.py --check              → integrity OK — 31 shows, 680 curated tracks
python3 scripts/build.py                       → markup OK — 747 items across 30 generated show pages
python3 scripts/verify_markup.py               → markup OK (self-test included)
python3 scripts/verify_markup.py --check-allowlist-coverage → OK, all 30 public shows
node scripts/test-player-controller.mjs        → 22/22
node scripts/test-player-views.mjs             → 16/16
node scripts/test-player-boot.mjs              → 23/23
NODE_PATH="$(npm root -g)" node scripts/browser_check.mjs --skip-webkit → 185/185
```

PR #4 is ready to merge as far as this review is concerned; production
verification (`browser_check.mjs --prod`) remains the next real gate.

---

## Step 5c deletion review — 2026-08-14

1. **Medium — Breakage Test A3 does not prove the waveform row is inert and can false-pass.**  
   Evidence: A2 starts the Full Recording’s detached `Audio` and leaves it playing ([browser_check.mjs](/home/renedebos/renedebos.com-player-consolidation/scripts/browser_check.mjs:475), [player.js](/home/renedebos/renedebos.com-player-consolidation/scripts/player.js:64)). A3 then searches only audio elements reachable from `document.body`, including Shadow DOM ([browser_check.mjs](/home/renedebos/renedebos.com-player-consolidation/scripts/browser_check.mjs:184), [browser_check.mjs](/home/renedebos/renedebos.com-player-consolidation/scripts/browser_check.mjs:484)). Thus “no audio plays” is literally false—the Hero continues playing—and a regression that drove the waveform row through another detached `Audio` would still return `found: false`. The assertion only detects the specific old WaveSurfer shape that inserts a discoverable audio element.  
   Why it matters: the test can stay green while a waveform click starts an unintended detached playback engine, so it does not establish the claimed inert fallback behavior.  
   Suggested fix: test A3 on a fresh page or stop A2 first; install a pre-navigation spy on `HTMLMediaElement.prototype.play` and assert that clicking `#track-1 .play-btn` produces zero play calls. Also assert the row remains without `_audio`, `.playing`, a changed play label, or a WaveSurfer canvas/audio.

2. **Low — The living plan and source comments still describe the deleted lab/engine as current infrastructure.**  
   Evidence: the plan says `build_wavesurfer_lab()` remains deferred even though this change deletes it and its build output ([player-consolidation-plan.md](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:1378), [player-consolidation-plan.md](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:1385)); `HANDOFF.md` still calls Step 5c “Next up” ([HANDOFF.md](/home/renedebos/renedebos.com-player-consolidation/HANDOFF.md:258)). The CSS comment falsely says `player.js` drives `.ws-wave`/`.ws-dl` ([site.css](/home/renedebos/renedebos.com-player-consolidation/scripts/site.css:603)); `player.js` still says waveform rows are wired by the deleted module ([player.js](/home/renedebos/renedebos.com-player-consolidation/scripts/player.js:28), [player.js](/home/renedebos/renedebos.com-player-consolidation/scripts/player.js:640)); and `pages.py` still references matching the deleted lab page ([pages.py](/home/renedebos/renedebos.com-player-consolidation/scripts/sitegen/pages.py:831)).  
   Why it matters: these comments now give future rollback and cleanup work the wrong ownership model. `.ws-wave` is consumed by `player-views.js`; `.ws-dl` remains because live generated markup uses it, while `player.js` only supplies generic download handling and the Full Recording fallback.  
   Suggested fix: fold Step 6 into Step 5c in the plan, update `HANDOFF.md` when the step is accepted, and correct the stale comments in `player.js`, `site.css`, and `pages.py`; then regenerate copied assets/output.

**Verification during this review**

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks, no orphan song pages.
- `python3 scripts/verify_markup.py` — passed: 747 items across 30 generated show pages.
- `python3 scripts/verify_markup.py --check-allowlist-coverage` — passed: all 30 public shows covered.
- Player Node suites — passed: controller 22/22, views 16/16, boot 23/23.
- Peaks/markup audit — passed: all 30 waveform pages preserve one valid `WS_PEAKS_URL`; all 680 waveform rows have corresponding peaks keys; `.ws-wave` and `.ws-dl` remain in live show markup.
- Deleted-reference scan — no runtime/generated references remain to `scripts/wavesurfer.js`, `assets/wavesurfer.js`, `/lab/wavesurfer/`, `WAVESURFER_LAB_SLUG`, or `build_wavesurfer_lab`.
- In-memory excluded-slug build simulation — passed: excluded markup retains `player.js` and `WS_PEAKS_URL`, omits the controller flag/boot module, and contains no broken `/assets/wavesurfer.js` tag.
- `git diff --check` — passed.
- `NODE_PATH="$(npm root -g)" node scripts/browser_check.mjs --skip-webkit` — could not run: Playwright failed before browser launch because this review environment cannot create `/tmp/playwright-artifacts-*` (`EROFS`).
_Review generated 2026-08-14 18:22:06 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-14)

- **#1 (Test A3 false-pass risk) — partially confirmed.** The specific
  reasoning is factually wrong: `player.js`'s Full Recording `_audio` is a
  **detached** `new Audio()` (`player.js:64`, never `appendChild`'d), and
  `findAudioDeep()` only walks `document.body`'s actual DOM tree
  (`browser_check.mjs:184-193`). So A2's Hero playback is invisible to
  `findAudioDeep` regardless of its play state — it does not contaminate
  A3's `found: false` result, and the 155/155 pass wasn't a false pass for
  the reason claimed. But the underlying methodological gap the suggested
  fix would close is real and pre-existing (shared by Test B3, not new to
  this diff): `findAudioDeep` can't see *any* detached `Audio()` object, so
  a hypothetical regression where a click started a new detached engine for
  the track row (rather than the DOM-attached WaveSurfer shape the old code
  produced) would also silently pass today. Confirmed as a genuine, if
  overstated, test-hardening opportunity — not a bug in the current
  passing result.
- **#2 (stale comments/docs) — confirmed**, three real hits: `player.js:28`
  ("waveform rows (wavesurfer.js)") and `player.js:~641`
  ("wired up asynchronously by wavesurfer.js, which handles its own
  hash-autoplay") both name the deleted module as if it still runs;
  `pages.py:831`'s "matches the lab page" references the deleted
  `/lab/wavesurfer/` page. `plan.md`/`HANDOFF.md` are correctly flagged as
  not yet updated — that's step 8 of this step's own execution sequence,
  not yet reached, not a defect. The `site.css` comment Codex paraphrased
  as claiming "player.js drives `.ws-wave`/`.ws-dl`" is actually accurate
  as written (credits both `player.js` and `player-views.js`) — no fix
  needed there.

**Recommendation:** fix #2's three stale comments (cheap, real accuracy
bugs) and strengthen A3 with a `play()`-spy per #1's suggestion (cheap,
closes a real if narrow blind spot) before merging. Plan/HANDOFF updates
happen as part of step 8 regardless. Not yet implemented — reporting per
`/review-step`'s stop-before-applying discipline.

### Fixes applied (Claude, 2026-08-14)

Both confirmed items fixed:

1. **#2 (stale comments) — fixed.** `player.js:28-32`'s playback-coordination
   comment no longer names `wavesurfer.js` as something that runs; it now
   says waveform rows are "driven by the shared PlaybackController where
   mounted, or dormant otherwise" and notes wavesurfer.js was removed in
   Step 5c. `player.js`'s `focusHashTrack()` comment (previously ~643-645)
   rewritten to explain the real current behavior: controller-engine pages
   get hash-autoplay from `player-boot.js`'s own deep-link handling
   (verified this exists: `player-boot.js:179-204`); an excluded/rolled-back
   page has no handler at all for waveform rows now, which is the accepted
   tradeoff already documented for Step 5c. `pages.py:831`'s "matches the
   lab page" reference removed (the lab page no longer exists).
2. **#1 (Test A3 false-pass risk) — fixed with the suggested hardening.**
   Added a `play()`-spy via `page.addInitScript()` (installed before any
   page script runs, so it also covers Test A2's Hero playback) that counts
   every `HTMLMediaElement.prototype.play()` call. A3 now asserts BOTH
   `findAudioDeep` finds nothing AND the play-call count didn't grow from
   the `#track-1` click. **Proved fail-then-pass**: temporarily injected a
   fake regression right after the click (`new Audio(...).play()`, a
   detached element, exactly the blind spot Codex described) — the
   hardened assertion correctly went `FAIL` (`playCalls=1->2`) while the
   old `findAudioDeep`-only check would have stayed `found:false` and
   silently passed, confirming the fix closes the real gap. Removed the
   injected regression and reran clean.

**Re-verification (run independently):**
```
python3 scripts/build.py --check                     → integrity OK — 31 shows, 680 curated tracks, no orphan song pages
python3 scripts/build.py                              → markup OK — 747 items across 30 generated show pages
node scripts/test-player-boot.mjs                      → 23/23
node scripts/test-player-controller.mjs                → 22/22
node scripts/test-player-views.mjs                     → 16/16
NODE_PATH="$(npm root -g)" node scripts/browser_check.mjs --skip-webkit → 155/155, incl. A3 :: playCalls=1->1
```

Ready to push/PR/merge as far as this review is concerned.

### Step 5c production verification — 2026-08-15

PR #5 (`88df4f8`/`9461e48`, merge commit `1a19160`) merged and deployed
(Action `31857142955`, green). `browser_check.mjs --prod --skip-webkit`
against all 30 live show pages: **166/167**, one failure investigated and
confirmed to be a **pre-existing false failure in the check script**, not a
regression from this step:

`/playlist/ real legacy playback works` asserts the now-playing time text
isn't `0:00` after a 2.5s wait. Reproduced directly with a standalone
Playwright script against production: the time reads `0:00` at 1s,
`0:01` at 2s — playback genuinely starts and advances correctly, it just
crosses zero slightly after the check's 2.5s window on a colder run.
`/playlist/` and `playlist.js` are untouched by this step's diff (only
`wavesurfer.js`, `player.js` comments, `pages.py` comments, `site.css`,
`browser_check.mjs`'s A3/dormancy checks, `gen_peaks.py` comments, and
`player-dev.md` changed). Not fixed here — out of scope for Step 5c, a
tight-timing assertion pre-dating this PR, tracked as a known flake rather
than blocking this step's completion.

Also spot-checked: `curl -sI https://renedebos.com/lab/wavesurfer/` → 404
(expected, the page is deleted); `curl -s https://renedebos.com/shows/jerry-cafe-java-1999-05-27/`
contains no reference to `/assets/wavesurfer.js`.

**Step 5c is done.**

### Fixes applied and production-verified (Claude, 2026-08-15)

All six items from the "Phase 1's normal production path is healthy" review
fixed (PR #6, `294e007`) and shipped:

1. `_notify()` isolates each view's exception (per-view try/catch, matching
   `attachPeaks()`'s existing pattern); `_upgradeWave()` guards
   `WaveSurfer.create()` with a fallback to the inert canvas. A
   WaveSurfer construction failure can no longer block `audio.play()`.
2. `appendQueue()` now also updates `_unshuffledQueue` — an item appended
   while shuffled no longer vanishes when shuffle is toggled off.
3. `destroy()` explicitly sets `navigator.mediaSession.playbackState =
   'none'` — teardown no longer leaves the OS lock screen stuck reporting
   "playing".
4. `pages.py`'s `CONTROLLER_ENGINE_EXCLUDED_SLUGS` comment now documents
   the post-5c reality: an excluded page's waveform rows stay dead, only
   the Full Recording card recovers.
5. The four deterministic Node suites are wired into the deploy workflow
   as Gate 3.
6. Fixed the real Phase-1-completion documentation contradiction (heading
   said "in progress", Step 5's parent checkbox unchecked, despite the
   plan's own opening paragraph claiming completion).

**Shipping Gate 3 broke deploy twice before landing** — both incidents
independently root-caused and fixed, not guessed at:
- PR #7: `actions/setup-node` pinned to Node 20 for the new test step,
  which silently downgraded Node for the rest of the job too, including
  `wrangler deploy` (needs >=22). Fixed by removing the pin entirely —
  the runner's own default (Node 24) already satisfies both steps.
- PR #8: Node >=21's built-in getter-only `navigator` global broke the
  two new Media-Session tests' plain `globalThis.navigator = {...}`
  assignment — invisible on local dev Node 20, which has no such global.
  Given this was the second broken deploy in a row, verified the fix
  against a real downloaded Node 24.19.0 binary rather than guessing a
  third time: confirmed the actual failure reproduces, confirmed
  `Object.defineProperty` resolves it, reran all 4 suites AND
  `wrangler --version` under that real binary before pushing.

**Final production verification (2026-08-15):** deploy run 31860440965
green (29s, includes the new test gate passing for real in CI), then
`browser_check.mjs --prod --skip-webkit` against all 30 live show pages:
**167/167**, fully clean — including `/playlist/`'s previously-flagged
timing-flake check now passing normally (`time=0:01`), consistent with
the earlier diagnosis that it was a timing coincidence, not a bug.

Phase 1 for show pages is complete, its production-healthy state is
independently confirmed post-fix, and the deploy pipeline itself is
verified working end-to-end again after two self-inflicted regressions
along the way.

---

## Phase 2 Stage 2a implementation review — 2026-08-14

1. **High — The runtime fallback is not transactional after the views mount.**  
   Evidence: the plan explicitly requires teardown after an injected mid-mount failure ([player-consolidation-plan.md:1506](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:1506)). The cleanup `try/catch` ends immediately after mounting views ([playlist-boot.js:389](/home/renedebos/renedebos.com-player-consolidation/scripts/playlist-boot.js:389)), while all remaining listener registration, initial rendering, and fetch startup occur outside it ([playlist-boot.js:418](/home/renedebos/renedebos.com-player-consolidation/scripts/playlist-boot.js:418)). The test called a “thrown mount failure” only removes required markup, so it throws before a controller exists ([test-playlist-state.mjs:103](/home/renedebos/renedebos.com-player-consolidation/scripts/test-playlist-state.mjs:103)). A targeted failure injected into the first post-view `addEventListener` left the mounted flag unset but all seven controller AbortSignals un-aborted.  
   Why it matters: `playlist.js` then starts the fallback while the partially mounted controller, views, claim listener, and some DOM handlers remain alive. Both implementations can react to the same page and overwrite visible state.  
   Suggested fix: wrap controller construction, every mount, all synchronous listener registration/rendering, and synchronous fetch invocation in one transaction. On any throw, abort and destroy before rethrowing. Add failures after the first view, after the second view, and during DOM wiring; assert teardown, not merely absence of the flag.

2. **Medium — The external-claim status remains visibly wrong after playback resumes.**  
   Evidence: the new callback only writes the paused message ([playlist-boot.js:384](/home/renedebos/renedebos.com-player-consolidation/scripts/playlist-boot.js:384)). Legacy explicitly tracks `pausedByClaim` and restores the normal status when audio plays again ([playlist.js:626](/home/renedebos/renedebos.com-player-consolidation/scripts/playlist.js:626)). A targeted two-controller probe produced `state="playing"` while the status still said “Paused — playback started somewhere else on the site.”  
   Why it matters: the page contradicts what the user hears and what the controller reports. The browser cross-tab check verifies pausing but never resumes the playlist or inspects the status ([browser_check.mjs:467](/home/renedebos/renedebos.com-player-consolidation/scripts/browser_check.mjs:467)).  
   Suggested fix: retain a `pausedByClaim` flag and clear it on the controller audio element’s next `play` event, restoring `updateStatus()`. Add a cross-tab pause→resume assertion covering both controller state and visible text.

3. **Medium — Every `timeupdate` still scans the entire queue.**  
   Evidence: each audio `timeupdate` calls `_notify()` ([player-controller.js:190](/home/renedebos/renedebos.com-player-consolidation/scripts/player-controller.js:190)). Although row rebuilding is revision-gated, every notification unconditionally invokes `_highlight()` ([playlist-views.js:142](/home/renedebos/renedebos.com-player-consolidation/scripts/playlist-views.js:142)), which queries and toggles every `.pl-row` ([playlist-views.js:194](/home/renedebos/renedebos.com-player-consolidation/scripts/playlist-views.js:194)).  
   Why it matters: a 680-track full-catalog queue—or the permitted 1,000 items—causes an O(queue length) DOM traversal several times per second even though `currentIndex` normally does not change. Existing tests cover row count/highlighting but not steady-state playback work.  
   Suggested fix: cache both the last queue revision and last current index. Highlight only when either changes, ensuring a rebuilt queue is highlighted once. Add a large-queue test that counts `querySelectorAll`/toggle calls across repeated `timeupdate` events.

4. **Medium — The markup verifier does not enforce the rollout default required by the plan.**  
   Evidence: the plan requires the emitted no-param default to match `PLAYLIST_CONTROLLER_ENGINE` ([player-consolidation-plan.md:1639](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:1639)). `check_playlist_engine_wiring()` accepts that value but never reads it; it checks only tag presence and order ([verify_markup.py:78](/home/renedebos/renedebos.com-player-consolidation/scripts/verify_markup.py:78)). Calling it against the current false-default HTML returned no errors when passed either `False` or `True`.  
   Why it matters: Stage 2b could flip the Python constant without updating or regenerating the resolver, and the deployment integrity check would accept the wrong default engine.  
   Suggested fix: emit a stable default marker or parse the resolver’s boolean literal and compare it with `playlist_controller_engine`. Add self-tests for both mismatch directions.

5. **Medium — The green suites do not implement the plan’s stated parity matrix.**  
   Evidence: the plan lists save/load/delete/rename, storage sync, all three endless rollover entry points, exact shuffle restoration, page-level remove/reorder, share/ZIP/popup, and status checks ([player-consolidation-plan.md:1579](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:1579)). The state suite tests only `ended` rollover, not Next or Media Session ([test-playlist-state.mjs:220](/home/renedebos/renedebos.com-player-consolidation/scripts/test-playlist-state.mjs:220)). `checkPlaylistPage()` covers playback, hash reload, save/load/delete, button presence, and console output, but no rename, storage sync, endless mode, shuffle, remove, share, ZIP, or popup ([browser_check.mjs:535](/home/renedebos/renedebos.com-player-consolidation/scripts/browser_check.mjs:535)). Its “track-select wiring” assertion checks only that buttons exist ([browser_check.mjs:586](/home/renedebos/renedebos.com-player-consolidation/scripts/browser_check.mjs:586)).  
   Why it matters: Stage 2a cannot yet be described as parity-tested based on the current passing counts; several lifted behaviors could be dead while every suite remains green.  
   Suggested fix: turn the plan’s matrix into explicit tests, prioritizing Next/Media Session rollover, shuffle restoration, remove-index behavior, saved rename/storage events, actual `track-select.js` selection flow, and share/download/popup payloads.

6. **Low — The new browser playback checks duplicate a known timing flake with shorter waits.**  
   Evidence: both new checks sleep two seconds and require the floored display to differ from `0:00` ([browser_check.mjs:535](/home/renedebos/renedebos.com-player-consolidation/scripts/browser_check.mjs:535), [browser_check.mjs:615](/home/renedebos/renedebos.com-player-consolidation/scripts/browser_check.mjs:615)). The review log already documents the same assertion false-failing after a 2.5-second wait on a cold production load ([player-consolidation-codex.md:1746](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-codex.md:1746)).  
   Why it matters: a healthy deployment can fail the Stage 2a acceptance run nondeterministically.  
   Suggested fix: poll until controller `currentTime` exceeds a threshold; for the legacy fallback, poll the displayed time with a reasonable timeout instead of taking one fixed-time sample.

7. **Low — `appendQueue()` bounds retained queue length but not untrusted-input processing.**  
   Evidence: the controller describes the limit as an unbounded-input backstop ([player-controller.js:65](/home/renedebos/renedebos.com-player-consolidation/scripts/player-controller.js:65)), but `appendQueue()` normalizes and filters every supplied item before applying `.slice(0, room)` ([player-controller.js:256](/home/renedebos/renedebos.com-player-consolidation/scripts/player-controller.js:256)).  
   Why it matters: a huge array cannot grow the stored queue beyond 1,000, but it can still force unbounded synchronous work; even a full queue unnecessarily validates the entire input.  
   Suggested fix: return immediately when `room === 0`, and cap the inspected input before `map(normalizeItem)`. Add a test that counts normalization work on oversized input.

**Verification during this review**

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks, no orphan song pages.
- Node suites — passed: controller 24/24, player views 17/17, player boot 23/23, playlist views 13/13, playlist state 14/14; `test-fake-dom.mjs` exited 0.
- `python3 scripts/verify_markup.py` — passed: 747 items across 30 generated show pages.
- `python3 scripts/verify_markup.py --check-allowlist-coverage` — passed: all 30 public shows.
- `git diff --check` — passed; all four generated player/playlist assets match their `scripts/` sources byte-for-byte.
- Targeted fault/status/default probes — reproduced the un-aborted partial mount, stale paused status while playing, and verifier acceptance of both default values.
- `NODE_PATH="$(npm root -g)" node scripts/browser_check.mjs --skip-webkit` — could not launch Chromium: Playwright failed with `EROFS` creating `/tmp/playwright-artifacts-*`.
_Review generated 2026-08-14 21:58:05 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-15)

All seven findings verified against the actual code (not taken on the review's word). Six confirmed as real; one confirmed but scoped down. Nothing fixed yet — that's `/apply-review`'s job.

1. **CONFIRMED — high, real gap.** Read `playlist-boot.js:389-414` directly: the `try/catch` wraps only the three `controller.mount()` calls (queueView, nowView, the hash-sync pseudo-view). Everything after it — all ~13 `addEventListener` registrations (filters, length, presets, clear, generate, share, save, download, player, saved-playlist actions, hashchange, storage) and the `fetch('/assets/tracks.json')` kickoff — sits outside that block, unprotected. If any of that synchronous wiring throws, the exception propagates uncaught to the auto-run block's `catch`, which only logs and leaves the flag unset — it never calls a teardown path, because the throw happens before `bootPlaylistPage()` reaches `return handle`. By that point three views are already mounted and the controller is alive with its external-claim listener registered on the module-level `claimListeners` Set, none of which get unwound. `playlist.js` then initializes on top of that live state. Confirmed exactly as described, including that my own "thrown mount failure" test (`test-playlist-state.mjs:103`) only exercises the pre-construction markup-validation throw, never a failure during/after mounting — a real, separate test gap on top of the code gap.

2. **CONFIRMED — medium.** `playlist-boot.js:384-386`'s `onExternalClaim` callback only ever writes the paused message; nothing clears it. Legacy's `pausedByClaim` flag + reset-on-`play` (`playlist.js:605-609`) has no counterpart here. Confirmed by reading both call sites — there's no code path anywhere in `playlist-boot.js` that clears `statusEl.textContent` back to a normal status once playback resumes after an external claim, so the page can show "Paused — playback started somewhere else" while `controller.state === 'playing'`.

3. **CONFIRMED — medium.** `playlist-views.js:142-147`: `PlaylistQueueView._render()` calls `this._highlight(snapshot.currentIndex)` unconditionally on every call, in both branches, and `_render` runs on every `onControllerUpdate`, i.e. every `timeupdate` (~4/s per `player-controller.js`'s `on('timeupdate', ...)`). `_highlight()` does `querySelectorAll('.pl-row')` + a `classList.toggle` per row — real O(queue length) DOM work every tick regardless of whether `currentIndex` actually changed. Confirmed as a genuine gap relative to the plan's own "render gating is load-bearing, not an optimization" principle (which I applied to the *rebuild* path via `queueRevision` but never applied to the *highlight* path).

4. **CONFIRMED — medium.** `verify_markup.py:78-117`: `check_playlist_engine_wiring(src, playlist_controller_engine)` takes the parameter and never reads it anywhere in the function body — grepped the whole function, confirmed no reference. The docstring documents invariant (2) ("the resolver's default decision matches `PLAYLIST_CONTROLLER_ENGINE`") but the code never implements it. This is exactly the "corrected two-invariant check" the plan called for, with invariant (2) simply never written. A real, confirmed gap in the build-time integrity gate: Stage 2b could flip the Python constant without the resolver's emitted default actually changing (a copy-paste or stale-cache bug in `pages.py`), and this check would not catch it.

5. **CONFIRMED as a coverage gap** (not a behavior bug — the underlying mechanisms are implemented and were exercised individually elsewhere in earlier phases). Checked `test-playlist-state.mjs`: it tests `ended`-triggered rollover and the non-endless stop case, but not the `next()`/Media-Session-`nexttrack` rollover paths the plan explicitly called out ("the Next path is the one that has no working mechanism without the hook — assert all three"). `checkPlaylistPage()` in `browser_check.mjs` covers mount/dormancy/playback/hash/save/load/delete/console/track-add-presence, but not rename, cross-tab storage sync, endless mode, shuffle, remove, share, ZIP, or popup — confirmed by reading the function, matches the review's line citations. Scoping down from "every Stage 2a suite claims full parity" (which nothing in my prior report claimed) to: the parity matrix in the plan is broader than what Stage 2a's tests currently cover, and the gap is real and worth closing before this stage is called done, prioritizing `next()`/Media-Session rollover first since that's the one path with a real, not-yet-proven code branch (`_advance()`'s `onQueueExhausted('next')` call).

6. **CONFIRMED, but scoped down — not a regression this diff introduced.** Grepped `browser_check.mjs` for `waitForTimeout(2000)`: it appears at lines 347, 379, 425, 657, 667, 701, 710, 829 — all pre-existing, from Phase 1's own checks — in addition to my two new call sites (537, 616). The flake precedent the review cites (`player-consolidation-codex.md:1746`) is about this same pre-existing pattern, not something new. Declining a project-wide rewrite of `browser_check.mjs`'s timing strategy in this review cycle (out of scope for a Stage 2a diff), but the suggested fix (poll `currentTime`/displayed time instead of one fixed sample) is cheap and directly applicable to my two new call sites specifically — worth doing in `/apply-review` for at least those two, without touching the seven pre-existing instances.

7. **CONFIRMED — low, currently unreachable.** `player-controller.js:256-260`: `appendQueue()` does `items.map(normalizeItem).filter(...).slice(0, room)` — normalizes the full input before truncating, and doesn't short-circuit when `room === 0`. Confirmed by reading the line. Also confirmed by grep that `appendQueue()` has no caller anywhere in the Stage 2a code (`playlist-boot.js`/`playlist-views.js`) — it's a controller primitive for a future `/player/` append feature, not yet exercised with untrusted input by anything shipping in this stage. Real and worth the one-line fix (bound-then-normalize, or bail on `room === 0`) since it's trivial and makes the primitive safe for whenever it does get a caller, but it has zero live impact on Stage 2a today.

**Net assessment:** findings 1, 2, and 4 are genuine correctness/integrity-gate gaps that should be fixed before Stage 2a is considered done — 1 in particular contradicts an explicit, load-bearing plan requirement. 3 and 7 are real but lower-stakes efficiency issues. 5 is a legitimate test-coverage gap, not a shipped-behavior bug. 6 is real but pre-existing and out of scope to fix broadly here. Recommend `/apply-review` for 1, 2, 3, 4, and 7 (all small, contained fixes), and for 5 at minimum the `next()`/Media-Session rollover test plus a cross-tab pause→resume status assertion (which also covers verifying the fix for #2). Leaving 6 as a noted, not-fixed, pre-existing issue.

### Fixes applied (Claude, 2026-08-15)

Rene approved acting on findings 1, 2, 3, 4, 7, and the `next()` test addition from 5. Each behavioral fix's regression test was confirmed to FAIL against the pre-fix code before being restored to passing (proof method: temporarily reverted just that fix in the working file, re-ran the suite, confirmed the specific new test failed with the expected assertion message, then restored the fix) — not just written and left green.

1. **Fixed.** `playlist-boot.js`'s transactional boundary now wraps view mounting, hash-sync mounting, the `pausedByClaim`-reset listener, ALL DOM wiring (filters/length/presets/clear/generate/share/save/download/player/saved/hashchange/storage), and the catalog-fetch kickoff, in one `try`, with `handle` built and returned from inside it — mirrors `player-boot.js`'s `bootShowPage()` shape exactly. New test `'a mount failure AFTER views are already mounted still tears everything down (not just the missing-markup case)'` injects a throw into the (optional) presets-panel wiring, well after both views mount, and asserts the controller's `destroy()` actually runs and no handle leaks to the caller. Confirmed failing (`0 !== 1` on the destroy-call assertion) against the original narrow-try shape before the restructure; passes after.

2. **Fixed.** Added `pausedByClaim` state in `playlist-boot.js`, set by the `onExternalClaim` callback, cleared (with `updateStatus()` restoring the normal status line) by a new listener on `controller.audioElement`'s `'play'` event — direct port of legacy's `playlist.js:605-609` pattern. New test `'the "paused elsewhere" status clears once playback resumes after an external claim'` drives a real second `PlaybackController` to issue the claim, then resumes via `c.play()` and asserts the status text no longer contains "Paused". Confirmed failing before the `'play'`-listener was added; passes after.

3. **Fixed.** `PlaylistQueueView._render()` now tracks `_lastIndex` alongside `_lastRevision`; `_highlight()` only runs when the queue was just rebuilt or `currentIndex` actually changed, not on every `onControllerUpdate`. New test `'PlaylistQueueView does not re-scan/re-highlight rows on a timeupdate tick where neither the queue nor the current index changed'` spies on `querySelectorAll('.pl-row')` across three no-op `timeupdate` ticks (asserts zero scans) and one real `next()` (asserts exactly one). Confirmed failing (`3 !== 0`) against the unconditional-highlight version; passes after.

4. **Fixed.** `verify_markup.py` gained `PLAYLIST_DEFAULT_LITERAL_RE`, which extracts the resolver's baked-in `true`/`false` literal from the generated HTML and compares it against the `playlist_controller_engine` parameter — invariant (2) is now actually implemented, not just documented. Added four `_selftest()` cases (both matching directions, both mismatch directions) following the file's existing self-test convention. Confirmed the mismatch-direction self-tests fail (`expected a mismatch error ... got []`) against the version that returns early without checking; pass after.

5. **Partially closed** (`next()`/Media-Session rollover test only, per the approved scope — the rest of the parity matrix in the disposition above remains open, noted in the plan doc rather than silently dropped). New test `'next() at the end of an endless queue rolls over the same way ended does'` calls `c.next()` (the same call Media Session's `nexttrack` handler makes) instead of dispatching `'ended'`, asserting identical rollover behavior. This test exercises already-correct code (no fix was needed for it to pass — finding 5 was a coverage gap, not a behavior bug), so no fail-then-pass proof applies; it passed on first run, confirming the shared `_advance()` code path Media Session also depends on.

6. **Declined**, as recorded above — pre-existing pattern across `browser_check.mjs`, out of scope for this diff, not touched.

7. **Fixed.** `appendQueue()` now bails immediately when `room === 0`, and slices `items` to `room` BEFORE `normalizeItem()`/dedup, not after — bounds the per-item work, not just the stored result (documented trade-off: a duplicate-heavy prefix could now yield fewer fresh items than a full scan would; acceptable since nothing calls `appendQueue()` yet). Two new tests in `test-player-controller.mjs`: one passes 998 existing + 2 fresh + 50 deliberately-malformed items and asserts no throw (the malformed excess must never reach `normalizeItem()`); one asserts a `room === 0` queue bails before touching the input at all. Confirmed both failing (`playable item requires an id`, thrown from the malformed items) against the normalize-then-slice order; pass after.

**Re-verification:** `python3 scripts/build.py --check` and `python3 scripts/build.py` — both clean (31 shows, 680 curated tracks, no orphan song pages; 747 items across 30 show pages). `python3 scripts/verify_markup.py` and `--check-allowlist-coverage` — both clean. All five `node scripts/test-*.mjs` suites — 97/97 passing (`test-player-boot.mjs` 23, `test-player-controller.mjs` 26, `test-player-views.mjs` 17, `test-playlist-state.mjs` 17, `test-playlist-views.mjs` 14). Generated assets (`assets/playlist-boot.js`, `assets/playlist-views.js`, `assets/player-controller.js`, `assets/playlist.js`) confirmed byte-identical to their `scripts/` sources after the rebuild. `browser_check.mjs` itself still not run (no `playwright-chromium` in this environment) — its new checks remain syntax-checked only.

Nothing committed. Plan document's Phase 2 section updated to record Stage 2a as implemented and review-hardened, not yet deployed.

## Phase 2 Stage 2a post-deploy review — 2026-08-15

Status: Stage 2a and the deploy fix (`4400531`, `ed01f2f`) are merged to `main`
and live in production, gated behind `?engine=controller` and manually
verified working end-to-end (mount, queue build/play, next/prev, share-link
round-trip, saved playlists, endless rollover, remove/shuffle, cross-tab
external-claim, `?engine=legacy` fallback). Requested via direct
`mcp__codex__codex` call rather than `scripts/codex_review.sh`, scoped to (a)
anything new/missed in the prior review round and (b) `ed01f2f`, which had no
review pass at all.

1. **Medium.** `playlist-boot.js:314`'s `syncHash()` replaces the URL with
   `win.location.pathname` when the queue empties, dropping the query string
   — including a `?engine=controller`/`?engine=legacy` override. Reloading
   after the last track is removed (or an all-unknown hash is hydrated)
   silently falls back to the default engine.
2. **Medium.** `verify_markup.py:113-140`'s `check_playlist_engine_wiring()`
   only runs its `playlist.js`-presence/ordering/default-literal checks
   inside `if has_resolver:`. If both the resolver and the boot tag are
   accidentally removed from the template, `has_resolver != has_boot` is
   `False != False` (no error), and nothing else fires — a build that
   silently drops the entire `/playlist/` canary mechanism would still pass
   `verify_markup.py` clean, even though (per the function's own docstring)
   both must be present at this stage.
3. **Medium.** `MAX_SAVED_PLAYLISTS` (`playlist-boot.js:41`) is enforced only
   in `storeSaved()` (line 259), not in `loadSaved()` (line 246-256) or
   `renderSaved()` (line 292) — a localStorage value with far more than 100
   valid entries (stale from before this bound existed, or tampered with)
   renders unbounded DOM. Not XSS (names are escaped, ids resolve through the
   trusted catalog) — an availability/input-bounding gap only.
4. **Low.** `playlist-views.js`: `_seeking` is set `true` on
   `mousedown`/`touchstart` (lines 238-239) and cleared only on `change`
   (line 240). If the current track changes mid-drag (Next, `ended`, Media
   Session, removal) before `change` fires, `_buildStructure()` (line 275)
   replaces the range element without resetting `_seeking` — it stays `true`
   permanently, and `_patch()` (line 318) skips updating the range/time
   display forever after.
5. **Low, test-coverage only.** `test-playlist-state.mjs:308-328`'s endless
   rollover test captures `firstOrder` (line 319) but never asserts against
   it — a rollover that replayed the identical order would still pass, so
   "reshuffles" isn't actually proven. The companion `next()` test's comment
   (lines 330-339) claims Media Session `nexttrack` registration is covered
   by `browser_check.mjs`'s `checkPlaylistPage()`; grepped `browser_check.mjs`
   for `nexttrack`/`mediaSession` — zero matches, so that claim is false as
   stated (the test itself is fine; only the comment overclaims).

### Disposition (Claude, 2026-08-15)

All 5 findings verified directly against the current code (not taken on
Codex's word):

1. **CONFIRMED**, but pre-existing, not Stage-2a-introduced: legacy
   `playlist.js:338-341`'s `syncHash()` has the byte-identical
   `location.pathname` bug (verified by reading the function). Faithful
   parity with legacy, same category as the queue-end-hides-controls
   behavior Rene already reviewed and asked to leave. Flagging to Rene
   rather than auto-fixing, since fixing it changes established legacy-
   parity behavior mid-canary.
2. **CONFIRMED**, real integrity-gate gap, not a nitpick — a silent template
   regression at this stage would currently slip past CI.
3. **CONFIRMED**, real but low-likelihood (requires a pre-existing
   oversized/tampered localStorage value); consistent with the project's own
   untrusted-input hardening stance elsewhere in Stage 2a.
4. **CONFIRMED** by tracing `_seeking`'s only two write sites — no test
   exercises a mid-drag track change, so this shipped unnoticed.
5. **CONFIRMED** on both halves — `firstOrder` is dead code in that test,
   and the "covered by browser_check.mjs" claim is unsupported by the actual
   file contents. `ed01f2f` itself (separately) verified **correct and
   complete** — both `globalThis.navigator` sites now use the
   `setGlobalNavigator` helper, and no other getter-only-navigator
   assignments remain anywhere in the new suites.

Recommend fixing 2, 3, 4, and 5 (all small, contained) and asking Rene
whether 1 should be fixed now (diverges from legacy parity) or left alone
per his standing preference for this canary phase.

### Fixes applied (Claude, 2026-08-15)

Rene approved acting on findings 2, 3, 4, and 5; asked to leave 1
untouched (legacy parity, matches his earlier "leave it" call on the
queue-end-controls-disappear behavior). Each behavioral fix's regression
test was confirmed to FAIL against the pre-fix code before being restored
(same backup/revert/re-run/restore proof method as the pre-merge review
round, since `git stash` doesn't target already-tracked files being
edited in place cleanly here either — used `cp` to `/tmp` throughout).

1. **Left as-is**, per Rene's explicit instruction — real, byte-identical
   to legacy `playlist.js:338-341`, not touched.

2. **Fixed.** `check_playlist_engine_wiring()` now derives `has_legacy`
   from `PLAYLIST_TAG`'s presence and branches on it: while `playlist.js`
   still ships (pre-2c), both the resolver and the boot tag must be
   present regardless of whether they happen to agree with each other;
   once `playlist.js` is gone (post-2c), both must be absent. The old
   `has_resolver != has_boot` check is now fully subsumed by this and was
   removed to avoid double-reporting the same regression. Four new
   `_selftest()` cases: `playlist.js` alone with neither resolver nor boot
   (pre-2c, must error), resolver present without boot (pre-2c, must
   error), a page with none of the three (post-2c, must be clean), and
   leftover resolver+boot after `playlist.js` is gone (post-2c, must
   error). Confirmed `both_missing_pre_2c` fails (`expected [...], got []`)
   against the reverted has_resolver!=has_boot-only version; passes after.

3. **Fixed.** `loadSaved()` now slices its filtered result to
   `MAX_SAVED_PLAYLISTS` before returning — the read boundary is bounded
   the same way the write boundary (`storeSaved()`) already was, so
   `renderSaved()` (and the save/delete/rename handlers, which all read
   through `loadSaved()`) can never act on more than the cap regardless of
   what's actually sitting in `localStorage`. New test seeds storage with
   130 valid entries and asserts exactly 100 `.pl-saved-row` elements
   render. Confirmed failing (`130 !== 100`) against the unsliced version;
   passes after.

4. **Fixed.** `PlaylistNowPlayingView._render()` now resets `_seeking =
   false` on every `currentItem.id` change (both the "item disappeared"
   and "structure rebuilt" branches) — a drag in progress on the OLD range
   element is meaningless once that element is torn down and replaced, so
   there's nothing to preserve. New test starts a `mousedown` drag, calls
   `next()` before any `change` event fires, then asserts the new range's
   `aria-valuetext` still updates on the next `timeupdate` instead of
   staying frozen at `0:00`. Confirmed failing (stuck at `'0:00 of 3:20'`)
   against the version without the reset; passes after.

5. **Fixed, both halves.** The endless-rollover test now scripts
   `Math.random` (restored via `finally`) so the pre-rollover order is
   deterministic (`a,b,c,d,e`) and the post-rollover order is
   deterministically different, then asserts `secondOrder` both differs
   from `firstOrder` and remains a permutation of the same pool — closing
   the gap where a rollover that silently replayed the same order would
   have passed. Proved by temporarily scripting BOTH shuffles to the same
   values and confirming the new assertion fails
   (`AssertionError: a real rollover reshuffle must produce a different
   order...`) before restoring the real (differing) values. Also corrected
   the companion test's comment, which had claimed `browser_check.mjs`
   covers Media Session `nexttrack` registration — grepped and confirmed
   zero matches there; the comment now states plainly that the browser's
   actual MediaSession API surface remains untested by any suite in this
   repo, while still correctly noting that `next()`/`nexttrack` share the
   same `_advance(1)` call this test does exercise.

**Re-verification:** `python3 scripts/build.py --check` and
`python3 scripts/build.py` — both clean (31 shows, 680 curated tracks, no
orphan song pages; 747 items across 30 show pages, 136 song pages).
`python3 scripts/verify_markup.py` and `--check-allowlist-coverage` —
both clean. All five `node scripts/test-*.mjs` suites — **99/99 passing**
(`test-player-boot.mjs` 23, `test-player-controller.mjs` 26,
`test-player-views.mjs` 17, `test-playlist-state.mjs` 18,
`test-playlist-views.mjs` 15). Generated assets (`assets/playlist-boot.js`,
`assets/playlist-views.js`) confirmed byte-identical to their `scripts/`
sources via `diff -q` after rebuild. `browser_check.mjs` still not run in
this environment (no `playwright-chromium`).

Nothing committed yet — working-tree changes only, pending Rene's go-ahead
to commit/push (this round touches already-deployed production code, so
committing means another deploy).

## Phase 3 design review — 2026-08-15

Five rounds reviewing Phase 3's design (the sticky in-page mini-player
that replaced the originally-planned `/player/` popup — see
`player-consolidation-plan.md`'s Phase 3 section for why the popup
approach was rejected). Sourced differently from every review above: run
interactively by Rene against a working plan file
(`~/.claude/plans/dynamic-hugging-rossum.md`) rather than via
`scripts/codex_review.sh`, with each round's verdict pasted back and
verified against the actual code before the plan was revised — the
verification and disposition happened inline, round by round, rather than
as a separate later pass. Every claim below (Codex's and the plan's) was
independently checked against the source, not taken on either side's word.

### Round 1 findings

1. **"No controller" doesn't mean "no player."** A design draft assumed a
   missing `PLAYER_BOOT`/`PLAYLIST_BOOT` global meant no player existed on
   a page. False: `songs.js`/`player.js`'s `initCustomPlayers()` and
   `player.js:217`'s `initLegacyPlayback()` fallback both create
   independent `<audio>` engines outside `PlaybackController`.
   `BroadcastChannel` never echoes to the sending document, so two
   same-page engines can't coordinate — a real double-playback risk.
2. **Adopt-without-restoring defeats the primary feature.** The draft said
   an adopted controller must never restore a persisted session — but
   show-page controllers start empty (`player-boot.js` mounts before any
   queue exists) and `/playlist/` exposes its controller before its async
   catalog/hash hydration finishes. Navigating onto either would make a
   restored session disappear, or worse, let an empty adopted controller
   overwrite valid persisted state.
3. **The proposed autoplay-error detection cannot work.** The draft relied
   on `controller.play().catch(...)` to detect a browser-blocked autoplay
   attempt. Verified: `_playIndex()` (`player-controller.js:564`) already
   attaches its own `.catch()` to the play promise and resolves — the
   promise `play()` returns to a caller never rejects, so nothing external
   can ever catch it.
4. **The persistence contract was incomplete/partly inaccurate.**
   `normalizeItem()` doesn't cap the queue (`setQueue()` does, verified at
   `:230`); `endless` is playlist-page-local state, not something
   `PlaybackController` owns; restored shuffle needs explicit
   `_unshuffledQueue` handling; filtering corrupt entries can shift a raw
   index (persist `currentItemId` instead); booleans need real-type
   validation, not truthy coercion.
5. **Multiple tabs can corrupt the shared session** with no
   writer/ownership arbitration in the original draft.
6. **The canary mechanism contradicted itself** — gating asset *emission*
   behind the same flag a runtime `?miniplayer=1` override was supposed to
   flip made the override impossible to honor.
7. **Stage 3b didn't exercise the replacement workflow** — both "Add to
   player" and `/playlist/`'s handoff still opened the popup during the
   proposed soak, so the soak wouldn't have tested the actual replacement
   path, and 3c would have silently changed "Add to player"'s behavior at
   deletion time.
8. Smaller items: don't bundle the BroadcastChannel wire-format upgrade
   with 3c's destructive deletion; use a shared component stylesheet
   instead of duplicating CSS structure across `site.css`/`home.css`;
   "dismiss" needed a real definition (must not leave inaccessible audio
   playing); the soak needed a concrete duration, not "multi-day."

**Disposition**: all eight confirmed real, all incorporated into the
revised plan (see round 2+ below for what changed as a direct result —
notably a new prerequisite "3a-foundation" stage for song-page migration,
which didn't exist in the pre-round-1 draft at all).

### Round 2 findings

1. **Stage 3a-foundation's architecture was left as an "or"** — "migrate
   song pages onto the shared controller, or add a yield rule" are
   materially different designs; the plan needed to pick one.
2. **The readiness contract needed an actual interface**, not just a
   concept: who creates it, what value it resolves with, when each page
   type resolves it, how it settles on a boot module's failure, who owns
   the resulting controller's teardown.
3. **Storage-ownership rules still allowed stale-tab overwrites.**
   Suppressing only the immediate pause-triggered write was insufficient
   — a losing tab's later `visibilitychange`/`pagehide` writes weren't
   suppressed. Also, reusing `player-controller.js`'s `selfId` for tab
   identity was wrong — verified it's a fresh `Math.random()` value
   generated once per document load (`:23`), not stable across a
   same-tab navigation.
4. **`/playlist/`'s own handoff path was missing entirely** — the plan's
   file list covered `track-select.js`'s "Add to player" but not
   `playlist-boot.js:540`'s independent `window.sendToPlayer(...)` call
   or its dedicated "Open continuous player" button
   (`pages.py:324`).
5. Smaller clarifications: a migration tombstone for the one-time
   `playerState`→`miniPlayerState` migration (or it re-triggers whenever
   the new key is legitimately absent); `restoreSession()` needed to
   actually assign `audio.src` (`setQueue(...,{autoplay:false})` doesn't)
   and defer the seek to `loadedmetadata`, generation-guarded;
   `window.MINI_PLAYER` needed explicit lifecycle discipline (only destroy
   a controller it constructed, never one it adopted); the measured height
   offset needed to cover the document's own bottom spacing, not just
   `.track-select-bar`; page scope needed explicit enumeration; the
   BroadcastChannel protocol fork needed a firm decision, not "earlier or
   later"; song migration needed its own verification plan.

**Disposition**: all confirmed real (spot-checked directly: `selfId`'s
per-document regeneration, `setQueue()`'s lack of `src` assignment, and
`playlist-boot.js:540`'s independent `sendToPlayer()` call site were all
verified against the actual source before being incorporated). Resolved
by restructuring into the four-stage shape (3a-foundation/3a-canary/
3b-default/3c-removal), a concrete five-question readiness-contract
answer, a durable ownership redesign, and adding `/playlist/`'s handoff
path to the file list.

### Round 3 findings

1. **The round-2 readiness-contract fix — a generic ~4s timeout defaulting
   to `{mode:'none'}` on failure — was itself unsafe.** It could fire
   before a slow-but-healthy `/playlist/` catalog fetch or show-page mount
   settled, constructing a second, competing controller. Time elapsed
   isn't a valid "no player here" signal; only real events are.
2. **Show pages were resolving readiness at mount time**, before the
   deep-link/autoplay decision that actually happens later. Verified:
   `wireDeepLink()`'s `focus(true)` call runs on `window.load`
   (`player-boot.js:203`), deliberately deferred for layout reasons — a
   mini-player restoring at mount could start before that decision fires
   and get overridden by it moments later.
3. **The ownership model was entirely in-memory** — useless across a full
   page navigation, which is the exact scenario this phase exists for.
   Two further gaps: a second tab restoring a persisted session had no way
   to know it wasn't the rightful owner, and the controller's
   external-claim callback (`player-controller.js:154-158`, verified)
   only invokes its body — including any caller-supplied callback — when
   `state === 'playing'/'loading'`, so a paused restored tab never learns
   it lost ownership at all.

**Disposition**: all three confirmed by direct code inspection (the
`window.load` deferral comment, the exact state-gating condition on the
claim callback). Resolved: readiness resolution rebuilt around real
events only (script `onerror`, existing try/catch, actual async settle —
no timeout on any player-capable page); show-page resolution moved inside
the `window.load` handler, carrying an `initialIntent` value; ownership
redesigned to live in the persisted envelope itself (`ownerId`), gated by
exactly three grant-cases, plus a new unconditional `onAnyExternalClaim`
controller hook so a paused tab can learn about a claim it would
otherwise never see.

### Round 4 findings

1. **`/playlist/`'s own boot-module failure wasn't covered** — round 3
   handled a slow/rejected catalog fetch, but not `playlist-boot.js`
   itself failing to load, parse, or mount, which would leave
   `PLAYBACK_HOST_READY` pending forever with no timeout to fall back on.
2. **Ownership-transfer ordering was unspecified.**
   `BroadcastChannel`/`storage`-event delivery order between tabs isn't
   guaranteed — a claimant needs to become the recorded owner *before* its
   controller action broadcasts a claim, or the old owner's in-flight
   write can land after the new claimant's and silently revert ownership.
3. Minor: the plan's wording implied `player-boot.js`'s catch directly
   triggers the legacy fallback — verified it doesn't; the catch only
   leaves `MOUNTED_FLAG` unset, and `player.js:217`'s separate,
   later-firing `DOMContentLoaded` listener is what actually calls
   `initLegacyPlayback()`.

**Disposition**: all confirmed (the `player.js:217` sequencing was
directly verified — the catch and the fallback trigger are genuinely two
separate, independently-firing code paths). Resolved: `/playlist/` given
all three explicit failure paths (script `onerror` → `{mode:'none'}`, an
in-script throw destroying any partial controller first → `{mode:'none'}`,
a catalog-fetch-local timeout that never itself constructs a second
controller), plus a new required breakage test (remove `playlist-boot.js`,
confirm exactly one controller gets constructed, not zero or two); an
explicit before-the-broadcast ownership-write ordering contract, with
external claims only ever setting a local `revoked` latch rather than
touching the shared envelope; the wording corrected to describe the real
two-listener sequence.

### Round 5 findings

1. **The `revoked` latch from round 4 was in-memory only** — resets on
   exactly the event this phase exists to survive, navigation. Concretely
   broken during the Stage 3b soak: the popup broadcasts claims but never
   writes to `miniPlayerState` at all, so a tab that received a claim from
   the popup and then navigated would lose its in-memory latch, see its
   own `ownerId` still on record, and incorrectly resume ownership —
   possibly autoplaying over or overwriting the popup's still-active
   session.

**Disposition**: confirmed — this is a direct, traceable consequence of
choosing in-memory state for something that must survive a full document
reload. Resolved: `revoked` moved to `sessionStorage` (same
survives-same-tab-navigation property as the tab-identity key), checked
on every boot before any autoplay attempt or write, cleared only by an
explicit local reclaim alongside the `ownerId` write.

**Net assessment**: the design that emerged after five rounds is the one
folded into `player-consolidation-plan.md`'s Phase 3 section. Codex's
final verdict: "conditionally approved... I would allow implementation
after adding [round 4's two corrections]," then after round 5's fix,
approved for implementation beginning with 3a-foundation, with no further
architectural blockers found. Stage 3a-foundation was then implemented
directly (Claude, not Codex — standing preference) per that design; its
review is the next section below.

---

## Phase 3 Stage 3a-foundation implementation review — 2026-08-15

1. **High — Song occurrences violate the finalized singleton queue contract and now auto-advance unexpectedly.**

   Evidence: The plan requires each song occurrence to use `playSingleton(item)` to preserve legacy behavior ([player-consolidation-plan.md:197–209](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:197)). Instead, [song-boot.js:66–98](/home/renedebos/renedebos.com-player-consolidation/scripts/song-boot.js:66) accumulates every mounted occurrence into one shared queue and calls `appendQueue()`. The controller automatically advances on `ended` ([player-controller.js:201–208](/home/renedebos/renedebos.com-player-consolidation/scripts/player-controller.js:201)), whereas legacy only advanced inside an explicit `[data-autoplay-next]` container ([player.js:127–140](/home/renedebos/renedebos.com-player-consolidation/scripts/player.js:127)). Song pages do not carry that attribute.

   This changes audible behavior: a detail page plays every performance sequentially, while `/songs/` can continue across unrelated groups in the order the user opened them. The tests encode the regression as the expected result, including asserting that later groups extend the live queue and `next()` reaches them ([test-song-boot.mjs:154–205](/home/renedebos/renedebos.com-player-consolidation/scripts/test-song-boot.mjs:154)), rather than testing legacy parity. The plan’s “implemented/unit-tested” statement at lines 1959–1963 is therefore an overclaim.

   Suggested fix: mount each occurrence with singleton semantics and remove `rowItems`/`appendQueue()` from song boot. Add an end-of-track test proving playback reaches `ended` without starting another occurrence, plus a lazy-index test proving opening another group does not mutate the active singleton queue.

2. **High — Durable ownership is neither atomic nor failure-aware, so a stale tab can overwrite a newer owner.**

   Evidence: `writeSession()` performs a separate ownership read followed by an unconditional envelope write ([miniplayer-state.js:281–300](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:281)). Another tab can claim between those operations, after which the stale writer writes its old `ownerId` back. An inline Node probe reproduced exactly that interleaving: the stale write returned `true`, restored tab A as owner, and replaced tab B’s envelope with `a-late`. This is the exact race the final design claimed to close ([player-consolidation-plan.md:1932–1949](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:1932)). The HTML Standard explicitly warns authors to assume Web Storage has no locking mechanism across agent clusters ([HTML Web Storage](https://html.spec.whatwg.org/dev/webstorage.html)).

   `claimOwnership()` also clears `revoked`, ignores `writeEnvelope()`’s boolean result, and returns an apparently successful envelope ([miniplayer-state.js:320–329](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:320)). A probe with a throwing `localStorage.setItem()` returned an owner envelope and cleared revocation even though no claim was persisted. Existing scenario 3 only models the favorable ordering where revocation arrives before the stale write begins ([test-miniplayer-state.mjs:243–264](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:243)).

   Suggested fix: use a separate current-owner pointer containing a fresh claim epoch and write session data under an epoch-specific key. A stale writer can then only modify its obsolete key, never the current owner pointer or current session. Make `claimOwnership()` return failure unless the pointer write succeeds, and clear `revoked` only after success. Add deterministic tests that interleave a new claim between the old writer’s read and write, plus quota/security-error tests.

3. **High — `sessionStorage` does not guarantee a unique tab ID; copied storage makes two tabs simultaneous owners.**

   Evidence: [miniplayer-state.js:210–227](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:210) states that a new tab/window gets a fresh ID, and the test creates every simulated tab from an empty storage object ([test-miniplayer-state.mjs:16–23](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:16)). In browsers, a page opened with an opener initially receives a copy of the opener’s `sessionStorage` ([MDN `sessionStorage`](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage)). Browser tab duplication can produce the same practical problem.

   A probe using two distinct storage objects initialized with the same copied contents showed identical tab IDs; the passive clone passed `isOwner()`, successfully wrote, and replaced the original tab’s queue. That defeats the requirement that passive restoration in another tab remain read-only.

   Suggested fix: add a live-context collision handshake—such as a BroadcastChannel probe carrying `tabId` plus a per-document nonce—and rotate a copied ID before permitting restoration or writes. Use `noopener` for applicable outgoing opens, but do not rely on it alone because tab duplication also needs handling. Add a real-browser or faithful copied-storage fixture.

4. **Medium — `restoreSession()` loses the saved position as soon as normal resume playback is attempted.**

   Evidence: `restoreSession()` captures `_gen` for its deferred metadata seek ([player-controller.js:345–384](/home/renedebos/renedebos.com-player-consolidation/scripts/player-controller.js:345)), but `play()` immediately increments `_gen` in `_playIndex()` ([player-controller.js:638–642](/home/renedebos/renedebos.com-player-consolidation/scripts/player-controller.js:638)). Thus the expected `restoreSession(); play(); loadedmetadata` flow invalidates its own seek. A direct probe restored position 42, called `play()`, dispatched `loadedmetadata`, and observed `currentTime === 0`.

   This breaks the phase’s core “position across navigation” behavior and will affect both permitted automatic resume and user-gesture resume. Existing tests exercise metadata after restore and superseding restore calls, but never the real restore-then-play sequence ([test-player-controller.mjs:676–708](/home/renedebos/renedebos.com-player-consolidation/scripts/test-player-controller.mjs:676)).

   Suggested fix: key the pending restore seek to item ID/source or queue revision, not the general play generation. Preserve it when playing the same restored item; clear it only when the current item/session changes. Add tests for both successful and autoplay-blocked restore-then-resume flows.

5. **Medium — `/playlist/` reports restoration as safe after explicitly handling an all-unknown queue link.**

   Evidence: `hydrateFromHash()` clears the queue and shows “None of the tracks…” for a recognized but all-unknown `#p=` hash, then returns `false` ([playlist-boot.js:349–375](/home/renedebos/renedebos.com-player-consolidation/scripts/playlist-boot.js:349)). `resolveReady(false)` converts that to `initialIntent:'none'` ([playlist-boot.js:634–638](/home/renedebos/renedebos.com-player-consolidation/scripts/playlist-boot.js:634)). The test explicitly asserts this unsafe result ([test-playlist-state.mjs:216–221](/home/renedebos/renedebos.com-player-consolidation/scripts/test-playlist-state.mjs:216)).

   Once the mini-player consumes the contract, it may restore an old persisted session immediately after the page deliberately cleared the queue, contradicting both the URL and visible error message. `initialIntent` was introduced specifically to prevent restoration from racing a page-owned queue decision.

   Suggested fix: distinguish “recognized page queue intent” from “resolved nonempty queue.” Return a structured hydration result and use `page-queue` for any recognized `#p=` decision, including an empty result, or extend the union with an explicit `page-clear` intent.

6. **Medium — A stalled playlist catalog request leaves `PLAYBACK_HOST_READY` pending forever.**

   Evidence: [playlist-boot.js:641–661](/home/renedebos/renedebos.com-player-consolidation/scripts/playlist-boot.js:641) resolves readiness only from the fetch’s fulfillment/rejection chain; a fetch that never settles has no fallback. The test covers immediate rejection only ([test-playlist-state.mjs:224–235](/home/renedebos/renedebos.com-player-consolidation/scripts/test-playlist-state.mjs:224)). The final design review specifically required a catalog-fetch-local timeout that does not construct another controller ([player-consolidation-codex.md:2220–2225](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-codex.md:2220)).

   The plan now contradicts that finalized disposition by saying no wall-clock timeout anywhere while also claiming all three playlist failure paths are covered ([player-consolidation-plan.md:1917–1930](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:1917)). Both the implementation and plan wording need correction.

   Suggested fix: add a timeout scoped only to `/assets/tracks.json`, abort the request, retain/adopt the already-mounted controller, and settle readiness exactly once. This is not the rejected generic host timeout and cannot construct a second controller. Add a never-settling-fetch test using a short injectable timeout.

7. **Medium — The persisted codec caps writes but not hostile reads.**

   Evidence: the codec declares a 1,000-item cap ([miniplayer-state.js:30–42](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:30)), but `decodeEnvelope()` iterates the entire stored array without slicing ([miniplayer-state.js:163–173](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:163)). A probe decoded 1,007 items despite the declared 1,000 cap. The only cap test exercises `encodeQueue()` ([test-miniplayer-state.mjs:48–62](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:48)).

   This contradicts the plan’s “dedicated capped/deduped/bounded item codec” claim and permits unnecessary work on corrupt storage. It can also leave `currentItemId` valid after decoding but invalid after `restoreSession()` independently truncates the queue.

   Suggested fix: slice the raw queue before any per-item decoding, then resolve `currentItemId` against that capped, filtered queue. Add a decode-side cap test proving entries beyond the limit are never inspected.

8. **Low — The required real module-load failure test for `/playlist/` is absent.**

   Evidence: the final design review required removing `playlist-boot.js` and verifying the resulting controller count/readiness behavior ([player-consolidation-codex.md:2220–2225](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-codex.md:2220)). Instead, [browser_check.mjs:1076–1083](/home/renedebos/renedebos.com-player-consolidation/scripts/browser_check.mjs:1076) explicitly declines that scenario. Static asset-existence checks and an ordinary smoke test cannot exercise the script element’s `onerror` handler.

   Suggested fix: include `playlist/index.html` in the isolated breakage copy, remove `playlist-boot.js`, and assert `PLAYBACK_HOST_READY` resolves to `mode:'none'`. Once the mini-player consumer exists, extend this to the required exactly-one-controller assertion.

**Verification during this review**

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks, no orphan song pages.
- `python3 scripts/verify_markup.py` — passed: 1,427 items across 166 generated show/song pages.
- `python3 scripts/verify_markup.py --check-allowlist-coverage` — passed.
- All `node scripts/test-*.mjs` suites — 161/161 passed across the seven test suites; `test-fake-dom.mjs` is a helper.
- `git diff --check` and source-to-generated-asset `diff -q` checks — passed.
- Inline Node probes — reproduced stale ownership overwrite, copied-session tab collision, uncapped decode, failed-claim reporting, and restore-then-play position loss.
- `node scripts/browser_check.mjs` — not executed: it exited after reporting that `playwright-chromium` is unavailable; this is not a browser pass.
_Review generated 2026-08-15 09:33:23 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-15)

All eight findings verified directly against the actual code (read every
cited line, ran the cited tests, and independently re-derived several of
the failure sequences by hand) — not taken on the review's word. All
eight confirmed as real. Nothing fixed yet; that's `/apply-review`'s job.

1. **CONFIRMED — high, real regression against a pre-existing plan
   requirement.** Verified `song-boot.js:66-98`: `mountRows()` shares one
   `rowItems` array across every mounted occurrence group (not per-group)
   and calls `controller.appendQueue(fresh)` to extend a single live
   queue, unconditionally. `player-controller.js`'s `ended` handler
   auto-advances through this shared queue with nothing gating it to a
   single group. Verified `player.js:135`: legacy auto-advance is gated by
   a `[data-autoplay-next]` ancestor container; verified via
   `scripts/sitegen/pages.py` that only `.track-list` (show pages, line
   895) carries that attribute — `.song-occs` (line 1146) does not. This
   confirms legacy never auto-advanced across (or even within) song
   occurrences. This isn't one of the five Phase 3 design-review rounds'
   findings — it contradicts an **earlier, pre-existing** part of this
   same plan document, the "Queue-origin contract" table
   (`player-consolidation-plan.md:197-209`), which explicitly assigns
   lazily-rendered song occurrences `playSingleton(item)` — "preserves
   today's singleton behavior; 'all performances of this song' would be a
   deliberate later decision, not a side effect." `test-song-boot.mjs:154-205`
   encodes the cross-group queueing/auto-advance as the *expected*, tested
   behavior, so the suite is green while enforcing the wrong contract.

2. **CONFIRMED — high, real race.** Verified `miniplayer-state.js:281-284`:
   `writeSession()`'s `isOwner()` check and its `writeEnvelope()` call are
   two separate `localStorage` operations, not one atomic transaction —
   per the HTML Standard, Web Storage has no cross-tab locking guarantee,
   so a claim from another tab landing between those two calls lets a
   stale writer overwrite the new owner's envelope. Manually re-derived
   the exact interleaving the review describes (read succeeds as owner →
   another tab claims and writes → stale writer's write still proceeds)
   and confirmed it reaches `writeEnvelope()` with no guard against it.
   Also verified `claimOwnership()` (`:320-329`): `writeEnvelope()`'s
   boolean return is discarded, and `clearRevoked()` runs unconditionally
   before the write is attempted — a failed write (quota/private
   browsing) still reports success and clears the revoked latch. Verified
   `test-miniplayer-state.mjs:243-264` ("scenario 3"): it calls
   `setRevoked(sessionA)` directly in test setup *before* attempting A's
   write, which only proves the latch works once already set — it does
   not model the actual TOCTOU gap (a write whose ownership check passes
   before a concurrent claim, then proceeds anyway).

3. **CONFIRMED — high, a genuine platform-behavior gap missed across all
   five design-review rounds.** `sessionStorage` is not reliably unique
   per tab: per MDN, a page opened via `window.open()` with an opener
   initially receives a **copy** of the opener's `sessionStorage`, and
   browser tab duplication does the same. None of the five design rounds
   considered this — they compared `sessionStorage` favorably against
   `player-controller.js`'s per-load `selfId` for surviving navigation,
   without addressing that it can be *cloned* across what the ownership
   model needs to treat as genuinely distinct tabs. Verified
   `test-miniplayer-state.mjs:16-23`: `fakeStorage(initial = {})` is
   called with no pre-populated `TAB_ID_KEY` at every simulated-tab call
   site in the suite, so every test tab gets a fresh, distinct id — the
   suite cannot and does not catch a cloned-id collision. This is a real
   gap in the design itself, not just an implementation shortfall.

4. **CONFIRMED — defeats the feature's primary claimed behavior in the
   realistic call sequence.** Verified `player-controller.js:345-378`
   (`restoreSession()`'s deferred seek, generation-guarded via `gen =
   this._gen` captured at restore time) against `:637-638` (`_playIndex()`,
   called by `play()`): `const gen = ++this._gen;` bumps generation
   unconditionally, on every `play()` call, including one resuming the
   exact item `restoreSession()` just cued. Hand-traced the sequence the
   plan requires (`restoreSession()` → `play()` attempted per the "attempt
   `play()` only when permitted" resume flow → `loadedmetadata` fires
   later): `play()`'s `_gen` bump happens before `loadedmetadata` can ever
   fire, so the deferred seek's `gen !== this._gen` guard is already true
   by the time metadata arrives, and the seek is silently skipped —
   playback resumes from 0, not the restored position. Verified
   `test-player-controller.mjs:676-708`: both existing `restoreSession()`
   tests either never call `play()` at all, or call a second
   `restoreSession()` to test supersession — neither exercises the actual
   restore-then-play sequence, so nothing caught this.

5. **CONFIRMED — real logic gap.** Verified `playlist-boot.js:358-366`:
   the all-ids-unknown branch (`if (!rows.length)`) explicitly calls
   `controller.setQueue([])` and sets a visible "None of the tracks in
   that link are in the archive anymore" status, then `return false` —
   conflating "a `#p=` hash was recognized and a real decision was made"
   with "that decision produced a non-empty queue." Verified
   `resolveReady(hadIds)` (`:634-638`) maps that `false` straight to
   `initialIntent: 'none'`, indistinguishable from "no hash was present at
   all." A future mini-player restoring its own session onto this
   controller because `initialIntent` said it was safe would silently
   contradict both the URL the visitor followed and the message just
   shown to them.

6. **CONFIRMED — both a real code gap and a real overclaim in this
   session's own documentation fold.** Verified `playlist-boot.js:640-661`:
   readiness resolves only from the catalog fetch's `.then()`/`.catch()` —
   no local timeout exists on that `fetch()` call. A genuinely
   non-settling request (not just a rejection, which the existing test at
   `test-playlist-state.mjs:224-235` does cover) would leave
   `PLAYBACK_HOST_READY` pending indefinitely. Separately verified: this
   session's own round-4 disposition, written into this same file at
   lines 2220-2225, states the catalog-fetch-local timeout as part of
   what was "Resolved" — an overclaim relative to what actually got
   built. Both need fixing: the missing timeout in code, and the
   overclaim in that disposition text and in
   `player-consolidation-plan.md`'s Phase 3 section (which also doesn't
   flag this as outstanding).

7. **CONFIRMED — same bug class this project already fixed once before.**
   Verified `miniplayer-state.js:36` declares `MAX_PERSISTED_QUEUE_ITEMS`,
   referenced only at the write side (`encodeQueue()`, `:95`, plus its
   test at `test-miniplayer-state.mjs:56-60`) — `decodeEnvelope()`
   (`:163-173`) iterates `parsed.queue` with no `.slice()` at all. An
   arbitrary/corrupted stored value can force unbounded per-item decode
   work. This is the identical bug class as the Phase 2 Stage 2a
   post-deploy review's finding #3 (`MAX_SAVED_PLAYLISTS` enforced on
   write but not read) — same project, same lesson, recurring in new
   code.

8. **CONFIRMED — a required test from the design review was not added.**
   Verified `browser_check.mjs:1076-1083`: the comment there reuses Stage
   2c-era reasoning (no fallback engine exists, so a missing
   `playlist-boot.js` is "just a broken deploy" already caught by
   asset-existence checks) to justify skipping the scenario — but round
   4's requirement (`player-consolidation-codex.md:2220-2225`, this same
   file) was for a *different* thing that didn't exist at Stage 2c: proof
   the new `onerror` handler actually resolves `PLAYBACK_HOST_READY` to
   `{mode:'none'}` rather than hanging. The Stage 2c-era reasoning is
   still correct for the scenario it originally addressed; it just
   doesn't cover what round 4 actually asked for, and the comment
   conflates the two.

**Net assessment:** findings 1-4 are real regressions/gaps against either
an explicit pre-existing plan requirement (1) or this phase's own
finalized design (2, 3, 4) — none should be considered done. 1 changes
live audible behavior on the Songs page today. 2 and 3 both defeat the
ownership model the five design rounds specifically exist to get right —
3 in particular is a gap the design itself never anticipated, not just an
implementation slip. 4 defeats the feature's headline behavior
(position-across-navigation) in its primary intended use. 5-7 are real
but narrower — 5 and 6 are correctness gaps with a clear, contained fix;
7 repeats a known bug class from this project's own history. 8 is a
missing test, not a live bug. Recommend `/apply-review` for all eight —
none require further design discussion, all have a concrete suggested fix
already verified against the real code above.

### Fixes applied (Claude, 2026-08-15)

All eight fixed. Implemented directly (Claude, not Codex — standing
preference), each behavioral fix proven fail-before/pass-after against the
pre-fix code (backup/revert-in-place/restore via `cp`, since these files
already carried this session's own uncommitted changes and `git stash`
doesn't cleanly target that). Every fix below was independently
re-verified against the actual code by this session afterward — not just
taken on the implementing pass's own report.

1. **Fixed.** `song-boot.js`'s `mountRows()` now mounts each occurrence row
   with a plain `PlayerView` (not `CompactPlayerView`) — its base
   `_start()` already calls `controller.playSingleton(item)`, the exact
   mechanism the Hero Full Recording card uses and the one this document's
   own pre-existing "Queue-origin contract" table specifies for lazily-
   rendered song occurrences. The shared `rowItems` array and
   `appendQueue()` call are gone entirely (verified: zero matches for
   either in the file). `test-song-boot.mjs` rewritten: playing to `ended`
   no longer starts another occurrence; opening a later group doesn't
   touch an already-playing singleton's queue; `next()` against a
   length-1 queue falls through to `stop()` rather than reaching an
   unrelated song, verified against `_advance()`'s actual behavior rather
   than assumed.

2. **Fixed.** `miniplayer-state.js` gained an `ownerToken` field (fresh
   random value per successful `claimOwnership()`, mirrored to a new
   `sessionStorage['miniPlayerClaimToken']`) alongside `ownerId`.
   `isOwner()` now requires both to match. `writeSession()` checks
   ownership **twice** in the same synchronous function body — once up
   front, once again immediately before the actual `writeEnvelope()` call
   — closing the realistic race window, which is the nontrivial
   `buildEnvelope()`/`encodeQueue()` work in between for a large queue,
   not the trivial gap between two adjacent statements. `claimOwnership()`
   now returns `{ok, envelope}` and only remembers the new token / clears
   the revoked latch if the underlying write actually succeeded — a
   quota/private-browsing failure no longer reports false success. New
   "scenario 5" test uses an `interleavedStorage()` harness that injects a
   second tab's claim between the first tab's ownership check and its
   write, reproducing the exact TOCTOU interleaving the original
   "scenario 3" test didn't (that one only proved the latch works once
   pre-set, not that the race itself is closed). A quota-failure test
   covers `claimOwnership()`'s failure path. Re-read the final
   implementation directly (`miniplayer-state.js:447-478`): the
   double-check is real, inside one synchronous function, with no
   await/microtask boundary between either check and the write.

3. **Fixed, as a unit-tested decision-logic module — not wired to a live
   channel yet, since nothing consumes this module at all this stage.**
   Added `generateNonce()`, `isTabIdCollision()`,
   `shouldRotateOnCollision()` (a deterministic, symmetric
   lexicographic-nonce tie-break — both colliding documents independently
   compute the same answer with no further coordination), `rotateTabId()`,
   and `handleTabCheckMessage()` (the composed decision a future boot
   script's `channel.onmessage` would call directly). Tested with a fake
   broadcast/message harness proving two documents that start with a
   cloned tab id converge on different ids after one round of messages.
   **A real browser proof of `window.open()`'s actual storage-cloning
   behavior remains impossible in this environment** (no
   `playwright-chromium`) — noted honestly in the code rather than
   silently assumed fixed. **Important documented constraint, verified
   directly against `player-controller.js`'s existing channel code**: this
   handshake must use a dedicated `BroadcastChannel`, never
   `'hannan-playback'` — that channel's `onmessage` treats any
   non-`selfId` payload as an external claim and pauses playback, so
   reusing it for tab-check messages would pause every engine on every
   page load.

4. **Fixed.** `restoreSession()`'s deferred `loadedmetadata` seek no
   longer keys off `_gen` (bumped by `_playIndex()` on every `play()`
   call, including one resuming the very item just restored — confirmed
   this was the exact bug). It now checks `_queueRevision` (bumped only by
   actual queue-membership/order changes, never by a plain resume) **and**
   that `this._queue[this._idx].id` still equals the restored item's id
   (catching a `next()`/`prev()`/different-singleton-click that moves
   `_idx` without touching `_queueRevision` at all). Verified the full
   block directly (`player-controller.js:355-403`) — both conditions are
   checked, with a code comment explaining exactly why `_gen` was wrong
   for this. New tests: the seek survives a `play()` call resuming the
   restored item (the realistic sequence that was broken) and survives a
   blocked-autoplay (`NotAllowedError`) resume too. The pre-existing
   "seek doesn't fire against a track already navigated away from" test
   still passes unmodified.

5. **Fixed.** `hydrateFromHash()` now returns `{recognized, hadIds}`
   instead of a bare boolean; `resolveReady()` reports
   `initialIntent: 'page-queue'` for any recognized `#p=` decision,
   including the all-unknown-ids case that used to collapse to `'none'`.
   The existing test that had asserted the old (wrong) `'none'` outcome
   for that case was corrected, not just left passing by coincidence.

6. **Fixed** — and the documentation overclaim from round 4's original
   disposition (elsewhere in this same file) is now accurate again
   retroactively. `CATALOG_FETCH_TIMEOUT_MS` (10s) with a dedicated
   `AbortController` scoped to only the `/assets/tracks.json` fetch — on
   firing, it routes into the existing `.catch()` path, `resolveReady(false)`,
   no second controller ever constructed. Verified this is genuinely
   local to the one fetch, not a page-wide timeout (the exact thing round
   3 correctly banned). Test uses a never-resolving fake fetch with a
   20ms test-scale timeout substituted via the existing test loader, so
   the suite doesn't actually wait 10 real seconds.

7. **Fixed.** `decodeEnvelope()` now slices `parsed.queue` to
   `MAX_PERSISTED_QUEUE_ITEMS` *before* any per-item decode work, mirroring
   `encodeQueue()`'s existing write-side cap (verified: `:187`). This is
   the same bug class as the Phase 2 Stage 2a post-deploy review's
   `MAX_SAVED_PLAYLISTS` fix, applied to new code. Two tests: decoded
   length is capped exactly; `currentItemId` resolves correctly against
   the capped (not the original, uncapped) queue.

8. **Fixed.** The isolated `browser_check.mjs` breakage-test copy now
   includes `/playlist/`'s assets. New Test D renames `playlist-boot.js`
   in that copy, loads the page, and asserts `window.PLAYBACK_HOST_READY`
   resolves to `{mode:'none'}` via the script tag's `onerror`, within a
   bounded race rather than hanging. Syntax-checked only
   (`node --check` clean) — no `playwright-chromium` in this environment,
   the same limitation as every other check added to this file this
   session.

**Re-verification** (independently re-run by this session, not just
taken from the implementing pass's report): `python3 scripts/build.py
--check` — clean, 31 shows, 680 curated tracks, no orphan song pages.
`python3 scripts/verify_markup.py` — clean, 1,427 items across 166
generated show/song pages. All seven `node scripts/test-*.mjs` suites —
**177/177 passing** (`test-miniplayer-state.mjs` 37, `test-player-boot.mjs`
28, `test-player-controller.mjs` 41, `test-player-views.mjs` 17,
`test-playlist-state.mjs` 26, `test-playlist-views.mjs` 15,
`test-song-boot.mjs` 13; `test-fake-dom.mjs` is a helper, no assertions of
its own). `node --check scripts/browser_check.mjs` — clean. Directly
re-read the actual diffs for findings 1, 2, 3, and 4 (the four hardest —
a behavioral regression, a genuine cross-tab race, a real platform-
behavior gap, and a defeated headline feature) rather than relying on
test-suite-green alone; all four hold up under direct inspection, not
just under their own tests.

Nothing committed. Two stale comments in `scripts/sitegen/fragments.py`
(referencing `CompactPlayerView` where finding 1's fix made the reference
inaccurate) were caught and corrected as part of this pass.

---

## Phase 3 Stage 3a-foundation fix verification — 2026-08-15

1. **High — The owner-token double-check narrows the storage race but does not close it.**

   Evidence: [`writeSession()` checks ownership and then performs a separate `localStorage.setItem()`](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:474). Another tab can still claim between the second `isOwner()` read at line 479 and the write at line 480; `ownerToken` cannot provide compare-and-swap semantics. The test injects the competing claim only during the *first* storage read, so the second check necessarily sees it and passes without exercising the remaining boundary ([test-miniplayer-state.mjs:399](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:399)). A focused probe injecting the claim after the second read produced `staleWriteAccepted:true` and overwrote B’s queue with `a-late`.

   Why it matters: a stale pagehide/timer write can still replace the new owner’s envelope. Therefore the plan and review log’s “all fixed”/“closing the race window” claims are unsupported ([plan:1867](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:1867), [review log:2505](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-codex.md:2505)).

   Suggested fix: serialize all envelope claims and writes with an actual cross-tab primitive, such as a Web Lock with a defined fallback, or move the record to an IndexedDB read-write transaction. Add a test that injects the competing claim specifically between the final ownership read and write; two ordinary `localStorage` calls cannot make that boundary atomic.

2. **High — The tab-collision handshake only converges in the test’s simultaneous-announcement fiction.**

   Evidence: the documented wiring broadcasts one message on boot and only rotates the receiver selected by the nonce comparison ([miniplayer-state.js:277](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:277), [miniplayer-state.js:337](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:337)). The test joins both ports before broadcasting both announcements ([test-miniplayer-state.mjs:544](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:544)). A duplicated tab actually joins after the original tab’s one-time announcement. In that faithful sequence, only the original receives the newcomer’s message: if the original has the larger nonce, neither rotates and both retain the cloned ID; the focused probe reproduced `converged:false`. If the original has the smaller nonce, the original rotates and the passive clone retains the old `ownerId` and copied claim token, potentially transferring ownership to the clone because `isOwner()` accepts that pair ([miniplayer-state.js:447](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:447)).

   Why it matters: finding 3 is not closed, and the current scheme can either leave duplicate owners or displace the established playing owner.

   Suggested fix: design this as a request/response handshake. Install the listener before announcing; existing matching tabs must reply to a newcomer’s probe so the newcomer always learns about an older tab. Preserve the established owner and rotate the joining document, with a deterministic tie-break only for genuinely simultaneous probes. Test the late-join sequence and confirm the established envelope owner remains owner.

3. **Medium — The owner-token API can report ownership success while immediately failing `isOwner()`.**

   Evidence: a new empty session is considered owned even though no claim token exists ([miniplayer-state.js:447](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:447)). `writeSession()` then persists `ownerToken:null`, after which that same tab fails `isOwner()`; a focused probe returned `{before:true,wrote:true,ownerToken:null,after:false}`. Separately, `claimOwnership()` ignores failure to persist `CLAIM_TOKEN_KEY`, clears the revoked latch, and returns `ok:true` ([miniplayer-state.js:510](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:510)). A probe with only that session-storage write failing returned `{reportedOk:true,actuallyOwner:false,revokedAfter:false}`. Existing tests check new-session ownership only before writing and simulate failure only in localStorage ([test-miniplayer-state.mjs:249](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:249), [test-miniplayer-state.mjs:423](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:423)).

   Why it matters: the future boot code can start playback based on `ok:true` but be unable to persist any queue or position, defeating navigation restoration.

   Suggested fix: require even a new session to pass through `claimOwnership()` before `writeSession()`, and report success only after the claim token is durably stored and read back. Preserve/restore the prior token and revoked state if either storage step fails. Add both probes as regression tests.

4. **Medium — Catalog failure still reports an explicit `#p=` link as safe to restore over.**

   Evidence: successful hydration correctly returns `{recognized,hadIds}`, but every fetch rejection or timeout bypasses `hydrateFromHash()` and hard-codes `recognized:false` ([playlist-boot.js:700](/home/renedebos/renedebos.com-player-consolidation/scripts/playlist-boot.js:700), [playlist-boot.js:708](/home/renedebos/renedebos.com-player-consolidation/scripts/playlist-boot.js:708)). The catalog-failure test uses no hash, so it cannot catch this ([test-playlist-state.mjs:237](/home/renedebos/renedebos.com-player-consolidation/scripts/test-playlist-state.mjs:237)).

   Why it matters: with `/#p=a,b` and a transient catalog failure, readiness resolves `initialIntent:'none'`; the future mini-player can restore an unrelated persisted queue over the explicit shared-link intent—the same failure class fix 5 was intended to eliminate.

   Suggested fix: parse whether the hash is syntactically recognized independently of catalog resolution, and preserve `initialIntent:'page-queue'` through fetch rejection/timeout. Add catalog-rejection and never-settling-fetch tests with a valid `#p=` hash.

5. **Medium — Destroying `/playlist/` during its catalog fetch leaves the timeout/fetch lifecycle inconsistent.**

   Evidence: `destroy()` clears the catalog timeout but never aborts `catalogAbort` ([playlist-boot.js:631](/home/renedebos/renedebos.com-player-consolidation/scripts/playlist-boot.js:631)); the fetch owns a separate controller created later ([playlist-boot.js:688](/home/renedebos/renedebos.com-player-consolidation/scripts/playlist-boot.js:688)). A never-settling fetch therefore remains pending forever after destroy, while a later successful fetch can resolve readiness with an already-destroyed controller. This contradicts the adjacent comment claiming destroy participates in settling cleanup. The plan also still states there is “no wall-clock timeout anywhere on a player-capable page,” despite the new 10-second timer ([plan:1936](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:1936)).

   Why it matters: lifecycle/teardown behavior can diverge depending on whether the fetch settles before or after destruction, and later work may rely on the plan’s now-false timeout description.

   Suggested fix: retain the catalog abort controller in handle scope, abort it from `destroy()`, and guard the continuation with a destroyed/settled flag so readiness cannot publish a dead controller. Add a destroy-before-timeout test. Amend the plan to distinguish the prohibited page-wide fallback timeout from this catalog-local timeout.

**Verification during this review**

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks, no orphan song pages.
- `python3 scripts/verify_markup.py` — passed: 1,427 items across 166 generated show/song pages.
- `python3 scripts/verify_markup.py --check-allowlist-coverage` — passed.
- All `node scripts/test-*.mjs` suites — 177/177 passed; `test-fake-dom.mjs` is a helper.
- `node --check scripts/browser_check.mjs` and `git diff --check` — passed.
- Source/generated asset comparisons for the four changed modules — passed.
- Focused Node probes — reproduced the final-check/write TOCTOU overwrite, late-join collision non-convergence, new-session self-disqualification, and claim-token false success.
- `node scripts/browser_check.mjs` — not run: `playwright-chromium` is unavailable, so the new real module-load failure test remains unexecuted rather than browser-verified.
_Review generated 2026-08-15 10:23:15 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-15)

All five findings verified directly against the actual code — including,
where relevant, re-tracing exactly why this session's OWN prior
verification (in the "Fixes applied" block above) was insufficient. That
prior pass confirmed the fixes "worked" by checking that the code did what
its comments claimed; it didn't sufficiently question whether what the
code claims is actually enough. This round's two high findings are
corrections to that prior verification, not new code discovered fresh —
worth stating plainly rather than glossing over.

1. **CONFIRMED — high. The previous "fix" for finding #2 narrows the race,
   it does not close it.** Verified `writeSession()` (`miniplayer-state.js:474-480`):
   the second `isOwner()` check and the actual `writeEnvelope()` call are
   still two separate statements — closer together than the original
   single-check version, but still not one atomic operation. No number of
   sequential checks can close a TOCTOU gap between two independent tabs;
   only an actual mutual-exclusion primitive can. Verified
   `interleavedStorage()`'s harness (`test-miniplayer-state.mjs:56-68`)
   directly: `onFirstGet` fires exactly once, on the FIRST `getItem()`
   call — which, inside `writeSession()`, is the first `isOwner()` check.
   By the time the SECOND `isOwner()` check runs, `triggered` is already
   `true`, so it never fires again — meaning "scenario 5" (added to prove
   this finding fixed) only ever models a claim landing before the first
   check, which the double-check already handled even in its naive form.
   The actual remaining gap (a claim landing between the second check and
   the write) is structurally never exercised by this harness. This
   session's own prior disposition claimed "closing the race window" —
   that claim was wrong; the honest description is "narrows it."

2. **CONFIRMED — high. The tab-collision handshake (finding #3's fix) does
   not converge in the realistic case, and can strip ownership from the
   legitimate tab.** Verified the documented protocol
   (`miniplayer-state.js:277-297`): announce once on boot, then only react
   to incoming messages — no reply/response step. Verified the passing
   test (`test-miniplayer-state.mjs:544-584`) joins BOTH simulated
   documents' listeners before either posts anything, modeling perfectly
   simultaneous presence — not what a real duplicated tab does (it boots
   and joins well after the original tab's own one-time announcement
   already happened and is gone). Traced the real late-join sequence by
   hand: the newcomer's announcement is the only message either side ever
   sees; only the ALREADY-ESTABLISHED tab (which is still listening)
   receives it, and reacts via `handleTabCheckMessage()`'s nonce
   comparison — the newcomer, having received nothing back, never runs
   that comparison at all. Two failure shapes follow directly: if the
   established tab's nonce is smaller, it's the one that rotates —
   stripping the ALREADY-PLAYING, actually-owning tab's identity, while
   the passive newcomer (still holding the original cloned id AND, since
   `sessionStorage` clones its ENTIRE contents including
   `CLAIM_TOKEN_KEY`, the original claim token too) now satisfies
   `isOwner()`'s check and can silently become the new owner despite
   having done nothing. If the newcomer's nonce is smaller, neither side
   ever rotates — the newcomer never even ran the comparison — and the
   collision goes undetected indefinitely.

3. **CONFIRMED — medium, two related gaps.** Verified `isOwner()`
   (`miniplayer-state.js:447-453`): grant-case 1 ("no envelope exists")
   returns `true` unconditionally, with no requirement that the tab has
   actually gone through `claimOwnership()` first. If a caller writes
   directly via `writeSession()` for a brand-new session (nothing in the
   API prevents this), `getClaimToken()` returns `null` (nothing was ever
   stored), so the written envelope's `ownerToken` is `null`, and that
   SAME tab's very next `isOwner()` check fails the `envelope.ownerToken
   != null` guard — a self-disqualifying first write. Verified the
   existing "grant-case 1" test (`:249-253`) only checks `isOwner()` in
   isolation and never proceeds to a `writeSession()`/re-check sequence,
   so nothing caught this. Separately verified `claimOwnership()`
   (`:510-522`): the `sessionStore.setItem(CLAIM_TOKEN_KEY, ...)` call is
   wrapped in a tolerate-and-continue try/catch — if THAT write fails
   while the `localStorage` envelope write succeeds, `claimOwnership()`
   still proceeds to `clearRevoked()` and returns `{ok:true, ...}`, even
   though this tab can never subsequently pass its own `isOwner()` check
   (its own `getClaimToken()` will keep returning `null` forever). The one
   existing failure-path test (`:423-432`) only simulates the
   `localStorage` write failing, not the `sessionStorage` one.

4. **CONFIRMED — medium, a gap in the previous round's finding #5 fix.**
   Verified the success path (`playlist-boot.js:697` area) correctly uses
   `hydrateFromHash()`'s real `{recognized, hadIds}` result — the actual
   fix worked for that path. But verified the `.catch()` branch
   (`:707-709`) hardcodes `resolveReady({recognized: false, hadIds:
   false})` regardless of what the URL hash actually contained — a
   genuine `#p=a,b` share link, hit by a transient catalog failure or the
   new finding-#6 timeout, is reported exactly the same as no hash at all.
   This is the identical failure class the previous round's finding #5
   fix addressed for the all-unknown-ids case, just reachable via a
   different path (network failure instead of stale ids) that fix didn't
   cover.

5. **CONFIRMED — medium, real cleanup gap plus a documentation
   overclaim.** Verified `destroy()` (`playlist-boot.js:639-642`): it
   calls `clearTimeout(catalogTimeoutId)` (cancels the timer that would
   eventually abort the fetch) and `controller.destroy()`, but never calls
   `catalogAbort.abort()` directly — so a page torn down while the catalog
   fetch is still in flight leaves that fetch running past teardown, and
   its eventual `.then()`/`.catch()` continuation still executes,
   including a `resolveReady()` call that can reference an
   already-destroyed controller. Separately verified
   `player-consolidation-plan.md:1936` still literally reads "no
   wall-clock timeout anywhere on a player-capable page" — true in the
   sense originally intended (no generic page-wide fallback timeout,
   which really was rejected and really isn't present), but now
   inaccurate as a literal sentence given the real, scoped, local
   10-second catalog timeout finding #6 (previous round) added. A
   documentation-precision issue, not a design contradiction — the
   sentence needs a qualifying clause, not a reversal.

**Net assessment**: three of five findings (1, 2, 3) are corrections to
work this session had already marked "fixed" and verified — 1 and 2 in
particular are not small misses. Finding 1 means the actual required fix
category is different from what was built (a real mutual-exclusion
primitive — Web Locks API with a defined fallback, or an IndexedDB
transaction — not more sequential `localStorage` checks, which cannot
structurally close a cross-tab TOCTOU gap no matter how many are added).
Finding 2 means the tab-collision handshake needs a genuine
request/reply redesign (a newcomer's probe must get an explicit reply
from any already-listening tab, with the established/already-owning side
protected from losing its identity, not a symmetric nonce coin-flip
between two sides that may never both be listening at the same time) —
the current implementation is directionally reasonable but the protocol
shape itself doesn't hold up under the realistic sequencing. 3, 4, and 5
are contained, mechanical fixes. Recommend `/apply-review` for all five,
with 1 and 2 flagged as needing more design care than a quick patch —
worth a deliberate check before considering them closed a second time,
not just re-running tests until green.

### Fixes applied (Claude, 2026-08-15)

All five fixed. Given this session's own prior over-confidence on findings
1 and 2 (verified as "closed" once already, incorrectly), every fix below
was re-verified independently after implementation — reading the actual
mechanism, not just running the new tests — with particular scrutiny on
1 and 2.

1. **Fixed, at the correct level.** `miniplayer-state.js`'s `writeSession()`
   and `claimOwnership()` are now `async` and run their entire
   check-build-check-write critical section inside `withOwnershipLock()`
   (`:610-629`), which requests a named lock (`OWNERSHIP_LOCK_NAME`) from
   an injectable provider — a real `navigator.locks.request()` when
   available, an injected fake for tests, or (honestly documented, never
   claimed as "fixed") a best-effort direct-call fallback when neither
   exists. Verified the fallback path's own test explicitly demonstrates
   the race is STILL reachable there (`finding #1 (honest fallback)`) —
   the code doesn't overclaim what it can't provide. Verified
   `serializingLockProvider()`'s test fake (`test-miniplayer-state.mjs:124-131`)
   is a genuine minimal mutex (a single promise chain every call appends
   to), not a coincidentally-passing stub — traced it directly. Verified
   `finding #1b`'s test: a competing claim triggered SYNCHRONOUSLY from
   inside the first tab's own critical section is still correctly forced
   to wait for that section to fully release the lock before running, and
   both writes succeed on their own terms with the correct final state.
   This is real serialization, independently confirmed, not test-shaped
   coincidence.

2. **Fixed, as a genuine protocol redesign.** Replaced the one-shot
   announce with `handleIncomingProbe()`/`handleIncomingProbeReply()`
   (`:421-473`) — a real request/reply exchange. Traced the decision logic
   directly: a tab that receives a probe and holds a real durable identity
   for that tabId (`envelopeNamesThisTab()`, deliberately narrower than
   `isOwner()` — excludes the "no envelope at all" grant-case, which would
   incorrectly treat an idle clone as equally "established") always
   replies and is NEVER the one that rotates; the prober, once told the
   other side is established, always rotates instead. Only when NEITHER
   side has a durable identity does the symmetric nonce tie-break decide.
   Verified this closes the exact bug traced last round: since the
   established tab is now required to reply rather than stay silent, a
   newcomer that boots long after the established tab's own boot-time
   activity still learns about the collision, and the established/actually-
   owning side can never be the one stripped of its identity. Verified the
   primary test (`finding #2: realistic late-join collision`,
   `test-miniplayer-state.mjs:754-804`) uses the correct realistic
   sequencing this time — the established tab claims real ownership
   completely independently first, THEN a newcomer with cloned storage
   appears and probes — not the previous round's simultaneous-both-
   listening fiction. All three required properties (established tab
   unchanged and still owner; newcomer is the one that rotates; newcomer
   can no longer pass `isOwner()` despite the cloned token) are directly
   asserted, not inferred.

3. **Fixed.** `writeSession()` now mints and persists a real claim token
   itself, inside the SAME locked critical section, whenever this tab
   doesn't already hold one — not a nested call to `claimOwnership()`
   (which would re-request the non-reentrant lock and deadlock; a real
   risk correctly identified and avoided). `claimOwnership()` now requires
   the `sessionStorage` token write to succeed for a reported success,
   rolling the `localStorage` envelope back to its prior state (or
   removing it) if the token write fails, so a half-landed claim never
   leaves a durable record this tab itself can't satisfy.

4. **Fixed.** `hashIsRecognizedShareLink()` (`playlist-boot.js:371-374`)
   answers "is the current URL hash syntactically a `#p=` link" from the
   hash alone, independent of catalog state. The catalog fetch's
   `.catch()` branch now reports `recognized: hashIsRecognizedShareLink()`
   instead of hardcoding `false` — a genuine share link hit by a network
   failure or the timeout is no longer indistinguishable from no hash at
   all.

5. **Fixed.** `destroy()` now calls `catalogAbort.abort()` directly
   (`:673-677`), and both the fetch's `.then()`/`.catch()` continuations
   check a `destroyed` flag as their first action (`:734`, `:750`) —
   verified this correctly covers the residual case where a request was
   already too far along over the network to actually be stopped by the
   abort signal in time. Plan-doc wording fixed separately (see below).

**Re-verification** (independently re-run, not taken from the
implementing pass's report): `python3 scripts/build.py --check` and
`verify_markup.py` — clean. All eight `node scripts/test-*.mjs` suites —
**191/191 passing** (`test-miniplayer-state.mjs` 48, `test-player-boot.mjs`
28, `test-player-controller.mjs` 41, `test-player-views.mjs` 17,
`test-playlist-state.mjs` 29, `test-playlist-views.mjs` 15,
`test-song-boot.mjs` 13; `test-fake-dom.mjs` is a helper). `node --check
scripts/browser_check.mjs` — clean. Directly read and traced the actual
mechanism for all five findings, not just the tests — findings 1 and 2 in
particular, given this session's own prior verification of those same two
findings was wrong once already.

Nothing committed.

---

## Phase 3 Stage 3a-foundation fix verification — 2026-08-15

1. **High — The probe/reply protocol can still rotate the real durable owner during overlapping startup.**

   **Evidence:** [`envelopeNamesThisTab()`](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:406) only checks the shared envelope’s `ownerId`. Because a duplicated tab clones both the tab ID and claim token, both documents see this predicate as true. [`handleIncomingProbe()`](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:421) therefore protects whichever document happens to receive a probe, while [`handleIncomingProbeReply()`](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:460) unconditionally rotates the prober when the reply reports an established identity. Receiving first proves only that the listener existed before that particular message was posted; it does not prove that listener is the incumbent owner.

   A focused probe created a real owner, cloned its complete session storage, then delivered the owner’s delayed boot probe to the clone. The clone did not rotate; the owner did, leaving `ownerStillOwns:false` and `cloneNowOwns:true`. The tests only exercise the favorable ordering where the newcomer is exclusively the prober ([test-miniplayer-state.mjs:744](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:744), [test-miniplayer-state.mjs:866](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:866)); they never reverse probe direction or overlap both startups.

   **Why it matters:** The original owner can still be stripped of identity and ownership, exactly the failure this third-round fix claims is structurally impossible. Consequently, the plan’s “review-hardened” and “durable owner … protected from ever being the one that rotates” claims are unsupported ([player-consolidation-plan.md:1863](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:1863), [player-consolidation-plan.md:1900](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:1900)).

   **Suggested fix:** Track whether a document completed its own presence handshake before the colliding probe arrived. Only a previously settled listener may claim incumbent protection. If both handshakes are unsettled, use the symmetric nonce tie-break regardless of the shared envelope—the cloned storage cannot distinguish them. Add reversed-direction and crossed-probe tests with a durable envelope, asserting exactly one identity survives; downgrade the plan’s completion claim until these pass.

2. **Medium — `claimOwnership()` rollback is best-effort but is documented and tested as guaranteed.**

   **Evidence:** When the claim-token write fails, [`claimOwnership()`](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:737) attempts to restore the previous envelope, but ignores `writeEnvelope()` returning false and suppresses `removeItem()` failure at lines 745–746. The rollback tests use an always-successful `fakeStorage()` for local storage ([test-miniplayer-state.mjs:612](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:612), [test-miniplayer-state.mjs:627](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:627)), so they cannot exercise rollback failure.

   A focused probe allowed the new envelope write, failed the session token write, then failed the rollback write. `claimOwnership()` returned `ok:false`, but the durable owner remained the failed claimant (`owner-b`) instead of the prior owner (`owner-a`).

   **Why it matters:** The false-success bug is fixed, but the claimed invariant that a half-landed claim “never leaves a durable record” is not. A transient storage failure can displace the prior owner while leaving the named replacement unable to satisfy `isOwner()`.

   **Suggested fix:** Persist the new session token first, then write the shared envelope while holding the lock; if the envelope write fails, restore/remove only this tab’s previous token and leave the shared envelope untouched. Clear revocation only after both writes succeed. Add a test where the initial shared write succeeds but the attempted shared rollback fails.

3. **Low — Teardown still runs `response.json()` after destruction, contrary to the “continuations check first” claim.**

   **Evidence:** The first fetch continuation calls `r.json()` without checking `destroyed` ([playlist-boot.js:724](/home/renedebos/renedebos.com-player-consolidation/scripts/playlist-boot.js:724)); only the later data continuation and `.catch()` check it at lines 735 and 752. The destroy test explicitly advances through `r.json()` after teardown ([test-playlist-state.mjs:414](/home/renedebos/renedebos.com-player-consolidation/scripts/test-playlist-state.mjs:414)) but only asserts that readiness and the DOM remain unchanged, so its title “prevents the continuation from acting afterward” is stronger than what it tests. Its blank status fixture also differs from the generated page’s initial “Loading the track catalog…” text.

   **Why it matters:** Direct abort and the later guards do close the original dead-controller/DOM mutation finding, but response-body parsing can still occur after teardown and the recorded “both fetch continuations check destroyed first” claim is literally false.

   **Suggested fix:** Make the first continuation `if (destroyed) return null; return r.json();`, guard the following step against the sentinel, and assert that the fake response’s `json()` was never called. Seed the fixture with the generated initial status text and assert it remains unchanged.

**Verification during this review**

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks, no orphan song pages.
- `python3 scripts/verify_markup.py` — passed: 1,427 items across 166 generated show/song pages.
- `python3 scripts/verify_markup.py --check-allowlist-coverage` — passed.
- All executable `node scripts/test-*.mjs` suites — 191/191 passed; `test-fake-dom.mjs` is a helper.
- Fix 1’s lock tests genuinely queue a competing claim under one mutex, and the unprotected fallback test reproduces the race. The named Web Lock wraps the complete synchronous critical sections.
- Fix 4’s tests directly cover both immediate catalog rejection and timeout with a real `#p=` hash; the hash-only recognition fix closes that finding.
- `node --check scripts/browser_check.mjs` and `git diff --check` — passed.
- Source/generated comparisons for `miniplayer-state.js` and `playlist-boot.js` — identical.
- Focused Node probes — reproduced the reversed-probe ownership transfer and failed rollback leaving the failed claimant as durable owner.
- `node scripts/browser_check.mjs` — not executed: `playwright-chromium` is unavailable.
_Review generated 2026-08-15 13:09:35 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-15)

All three findings independently reproduced against the actual code with
standalone Node scripts calling the real exported functions directly (not
just re-reading the source or re-running the existing suite) — this is the
third round on this exact ownership/collision code, and the first two
rounds each found real gaps in fixes already believed closed, so nothing
here was accepted on the report's word alone.

1. **CONFIRMED — high, genuine unresolved architectural gap.** Reproduced
   exactly as described: `claimOwnership()` a real owner (`ownerSession`),
   clone its `sessionStorage` verbatim (matching real duplicate-tab
   semantics), then have the OWNER be the one who sends the next probe
   (e.g. on its own re-boot after a navigation) while the CLONE is the one
   already listening. `envelopeNamesThisTab()` reads the same shared
   `localStorage` envelope from both sides, so the clone's check passes
   too — it replies `establishedIdentityExists: true`, and
   `handleIncomingProbeReply()` then unconditionally rotates the real
   owner. Confirmed output: owner's `isOwner()` flips from `true` to
   `false`, clone's stays `true` — the real owner is stripped of its
   identity and the clone ends up as the confirmed durable owner. Root
   cause is real: the protocol's protection is keyed on which side
   *received* a given probe, not on which side has been continuously
   holding the identity since before the collision — and since a cloned
   tab's storage is byte-identical, the two are structurally
   indistinguishable to `envelopeNamesThisTab()`. Both existing tests
   (`test-miniplayer-state.mjs:754`, `:871`) only exercise the newcomer
   as prober, established tab as receiver — never the reverse. The plan
   doc's "durable owner … protected from ever being the one that rotates"
   claim (`player-consolidation-plan.md:1900`) is not true in general, only
   for the one direction tested.

2. **CONFIRMED — medium, real gap, worse in practice than the report's own
   framing.** Reproduced with a real owner-a claiming successfully on
   working storage, then a `localStorage` fake whose 2nd `setItem()` call
   throws (simulating the rollback write failing) combined with a
   `sessionStorage` fake whose `setItem()` always throws (triggering the
   rollback in the first place). Result: `claimOwnership()` correctly
   returns `{ok:false}` for owner-b (honest about its own failure), but
   the durable envelope is left naming owner-b's tabId as owner anyway —
   and reproduced that **both** owner-a and owner-b then fail `isOwner()`
   against that envelope, not just "the prior owner is displaced" as the
   report states. The session is left fully orphaned (nobody can pass
   `isOwner()`), which is a strictly worse outcome. Root cause confirmed
   at `miniplayer-state.js:745-746`: the rollback's `writeEnvelope()`
   return value is discarded and `removeItem()`'s failure is swallowed by
   an explicit best-effort `catch`, with no re-check or second-level
   recovery either way.

3. **CONFIRMED — low, real but non-functional gap; documentation
   overclaim.** Read `playlist-boot.js:724-725`: the first `.then((r) =>
   r.json())` has no `destroyed` guard; only the second `.then((data) =>
   {...})` (`:735`) and the `.catch()` (`:752`) check it. Read the
   existing destroy test (`test-playlist-state.mjs:400-422`): it resolves
   the fake fetch with `{ json: () => Promise.resolve([]) }` and advances
   two ticks, meaning `r.json()` genuinely does execute post-destroy in
   the test as written — but the test only asserts `readiness` stays null
   and the DOM is untouched, never that `json()` itself was skipped. No
   controller/DOM mutation actually occurs after destroy (the second
   `.then()`'s guard still catches it before anything observable
   happens), so this is not a correctness bug, but the "Fixes applied"
   entry's literal claim that "both fetch continuations check destroyed
   first" (this file, "Phase 3 Stage 3a-foundation fix verification —
   2026-08-15", finding 5) is inaccurate — only one of the two `.then()`s
   does.

**Net assessment**: findings 1 and 2 are real, and finding 1 in particular
means the probe/reply redesign from the previous round is not the
structural fix it was believed to be — the underlying problem (a cloned
tab is indistinguishable from the original by any signal derivable from
shared storage alone) needs a different mechanism, not a variation on the
same probe/reply shape. Recommend `/apply-review`, with 1 flagged as
needing real design work (per the report's suggested direction: track
whether a document's own identity was settled *before* the colliding
probe arrived, and fall back to the nonce tie-break whenever that can't be
established on either side — i.e. incumbency must be evidenced by
something that isn't itself subject to `sessionStorage` cloning) before
being considered closed, not a quick patch — this is the second
consecutive round where the quick-patch version of a fix for this same
area didn't hold up under a reversed-order test. 2 and 3 are contained,
mechanical fixes (make the rollback path itself failure-checked/reported,
and add the missing `destroyed` guard to the first continuation).

### Fixes applied (Claude, 2026-08-15)

All three fixed. Finding 1 got the real design work flagged as necessary
above, not a patch to the existing role-based shape — traced by hand
before writing any code (see the reasoning below), and every fix was
independently reproduced against the actual code both BEFORE (confirming
the bug) and AFTER (confirming the fix), not just covered by a new test
that happened to pass.

1. **Fixed via a genuine protocol redesign, not a patch.** Root cause:
   once a tab's storage can be cloned, "a durable envelope names this
   tabId as owner" is satisfied equally by the original AND the clone —
   there is no signal derivable from storage content that tells them
   apart, so any rule built on that signal (round 2's `envelopeNamesThisTab()`)
   was structurally unable to reliably protect the real owner, whichever
   quick patch it went through. Fix: dropped the ownership/role-based
   asymmetry entirely (`envelopeNamesThisTab()` deleted). Every collision
   is now decided by ONLY the deterministic, symmetric nonce tie-break
   (`shouldRotateOnCollision()`, unchanged), routed through one shared
   `resolveCollision()` path for both message types and memoized per
   opposing nonce (`resolvedNonces`, a Set the caller owns for the
   document's lifetime) so a given collision is never decided twice —
   this is what closes the mutual-rotation case, not just the reversed-role
   case. Verified by standalone reproduction against the ACTUAL pre-fix
   `handleIncomingProbe`/`handleIncomingProbeReply` functions (not a
   hypothetical): the real owner rebooting after navigation genuinely lost
   to an idle clone every time, and two clones probing each other
   near-simultaneously genuinely both rotated, orphaning the session
   (`isOwner()` false on both sides). Both reproductions failed to trigger
   against the fixed code. `scripts/test-miniplayer-state.mjs` gained 4 new
   tests (both nonce directions for the reversed-owner case, the mutual-
   probe case, and a memoization case for a redelivered probe) plus 2
   rewritten "no-current-owner" tests and a rewritten full-channel
   integration test (all updated for the new
   `(incoming, sessionStore, myTabId, myNonce, resolvedNonces)` signature —
   `localStore` is no longer a parameter, since collision decisions no
   longer read the envelope at all). Each new/rewritten test was run
   against a reverted copy of the pre-fix file via the project's
   cp-based backup/revert/restore method and confirmed to fail there
   before being confirmed to pass against the fix — not merely written to
   pass. The plan doc's overclaimed "structurally protected from ever
   rotating" sentence is corrected with a linked explanation of why no such
   guarantee is achievable, and the bounded, self-correcting blast radius
   (any real local interaction reclaims ownership outright) is spelled out
   there.

2. **Fixed by reordering, eliminating the vulnerable path rather than
   hardening it.** `claimOwnership()` now writes the LOCAL
   `sessionStorage` claim token FIRST; only if that succeeds does it
   attempt the SHARED `localStorage` envelope write. A failure at that
   second step now only ever requires rolling back the LOCAL token (a
   single-tab-private write nothing else could have raced against), never
   the shared envelope — because the shared envelope is structurally never
   written to at all unless the local half already safely landed. This
   removes the entire class of bug (a failed rollback of SHARED state)
   rather than making that rollback more careful. Added
   `sharedCounterFlakyStores()` to the test file — an order-agnostic fake
   where the first write across either store succeeds and the second
   fails — and one new test built on it. Confirmed this exact test FAILS
   against the pre-fix (envelope-first) code, with the shared envelope
   visibly corrupted to name the failed claimant instead of the true prior
   owner (captured in the failure diff), and PASSES against the fix.

3. **Fixed.** Added a `destroyed` check to `playlist-boot.js`'s first
   `.then((r) => r.json())`, matching the guard already present on the
   second `.then()` and the `.catch()`. Strengthened the existing destroy
   test (`test-playlist-state.mjs`) to track whether the fake response's
   `json()` was actually called (it wasn't, previously, asserted) and to
   seed/assert against the real generated page's actual initial status
   text ("Loading the track catalog…") instead of an arbitrary blank
   fixture value. Confirmed this strengthened test fails against the
   pre-fix code (`json()` genuinely gets called post-destroy) and passes
   against the fix.

**Re-verification** (independently re-run): `python3 scripts/build.py
--check` and `python3 scripts/build.py` (which also runs
`verify_markup.py`) — clean, 31 shows/680 curated tracks/166 generated
show+song pages, no orphans. All 8 `node scripts/test-*.mjs` suites —
**195/195 passing** across the 7 executable suites (`test-miniplayer-state.mjs`
52, `test-player-boot.mjs` 28, `test-player-controller.mjs` 41,
`test-player-views.mjs` 17, `test-playlist-state.mjs` 29,
`test-playlist-views.mjs` 15, `test-song-boot.mjs` 13; `test-fake-dom.mjs`
is a helper). `node --check scripts/browser_check.mjs` and `git diff
--check` — clean. Plan doc updated to correct the round-2 overclaim and
document the round-3 redesign. Nothing committed.

---

## Phase 3 Stage 3a-foundation fourth fix verification — 2026-08-15

1. **High — The nonce tie-break is not an unbiased coin flip; a later clone is structurally favored and the realistic late-join test uses impossible nonce ordering.**

   **Evidence:** `generateNonce()` prefixes randomness with `Date.now()` ([scripts/miniplayer-state.js:362](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:362)), while `shouldRotateOnCollision()` lexicographically rotates the smaller nonce ([scripts/miniplayer-state.js:397](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:397)). For tabs started in different milliseconds, the timestamp prefix dominates the random suffix: the earlier incumbent has the smaller nonce and loses to the later clone. The full-channel test instead hardcodes the earlier incumbent as `"nonce-zzz"` and the later newcomer as `"nonce-aaa"` ([scripts/test-miniplayer-state.mjs:1070](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:1070)), and explicitly avoids calling `generateNonce()` ([scripts/test-miniplayer-state.mjs:1017](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:1017)). A focused probe using the real generator with the incumbent’s random component larger than the newcomer’s still produced `incumbentRotated:true`, `incumbentOwns:false`, and `newcomerOwns:true`.

   **Why it matters:** The redesign does prevent two successful rotations for the same two valid nonces, but it does not provide the plan’s claimed “unbiased coin flip” ([plans/player-consolidation/player-consolidation-plan.md:1936](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:1936)). In the canonical late-join duplication scenario it systematically recreates the prior finding: the real durable owner loses to the clone. The “only idle/passive tabs” justification is also incomplete when the incumbent is rebooting because of an active navigation and can consequently lose permission to restore the session.

   **Suggested fix:** Generate a random-only nonce, preferably with `crypto.randomUUID()` or `crypto.getRandomValues()`, with a documented fallback; do not include an ordering timestamp in the compared value. Rewrite the late-join integration test to use the production nonce generator with controlled time/random sources and prove that a later boot is not predetermined to win. If retaining the real owner is still a requirement, acknowledge that a nonce-only protocol cannot provide it and redesign around a non-clonable live arbiter/lease rather than describing owner loss as closed.

2. **Medium — Reordering `claimOwnership()` moves the rollback hazard to session storage and can still orphan the current owner.**

   **Evidence:** The new token is written locally first ([scripts/miniplayer-state.js:721](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:721)); when the shared write fails, restoration of the previous token remains explicitly best-effort and its failure is swallowed ([scripts/miniplayer-state.js:732](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:732)). If the claimant already owns the durable envelope, a successful new-token write followed by a failed shared write and failed local rollback leaves the shared envelope holding the old token while session storage holds the new one. A focused probe against the real function returned `claimOk:false`, left the shared envelope unchanged, but produced `tokenStillMatches:false` and `ownerAfter:false`.

   The new regression fixture deliberately makes every write after the first fail, so its local rollback actually fails too ([scripts/test-miniplayer-state.mjs:98](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:98)). However, it uses a different claimant B and only verifies that prior owner A remains valid ([scripts/test-miniplayer-state.mjs:706](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:706)); it never exercises an already-current owner reclaiming on a local action.

   **Why it matters:** The shared envelope is no longer corrupted, so the precise shared-rollback finding is narrowed correctly. But the broader invariant that a failed claim cannot orphan the session is still unsupported: the current tab can invalidate its own otherwise-valid durable claim. This contradicts the code’s assertion that nothing relies on the previous local token and the plan’s “eliminates the entire class” wording ([plans/player-consolidation/player-consolidation-plan.md:1944](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:1944)).

   **Suggested fix:** Make the local representation preserve both the previous and pending token until the shared write commits, with `isOwner()` accepting whichever token the shared envelope currently names; cleanup can then be best-effort without losing ownership. Add a regression test where the existing owner calls `claimOwnership()`, the shared write fails, and restoring the local token also fails, asserting that the existing owner still passes `isOwner()`.

### Verification during this review

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks, no orphan song pages.
- `python3 scripts/verify_markup.py` and `python3 scripts/verify_markup.py --check-allowlist-coverage` — passed: 1,427 items across 166 generated pages; all 30 public shows covered.
- All executable `node scripts/test-*.mjs` suites — 195/195 passed: miniplayer 52, player boot 28, controller 41, views 17, playlist state 29, playlist views 15, song boot 13.
- `node --check scripts/browser_check.mjs`, `git diff --check`, and source/generated comparisons for `miniplayer-state.js` and `playlist-boot.js` — passed.
- Focused real-function probes — reproduced the timestamp-biased incumbent loss, current-owner local-token orphaning, and rotation reporting success when its storage write fails.
- `playlist-boot.js` teardown probe/test — the first continuation now skips `response.json()` after destruction, and its fixture matches the generated “Loading the track catalog…” markup; no remaining finding there.
- `node scripts/browser_check.mjs` — not run: `playwright-chromium` is unavailable.
_Review generated 2026-08-15 13:54:45 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-15)

Both findings independently reproduced against the actual code (standalone
scripts calling the real exported functions directly, matching the same
method used for every prior round) before implementing anything.

1. **CONFIRMED — high.** Reproduced exactly: called the real
   `generateNonce()` twice a few milliseconds apart and ran
   `shouldRotateOnCollision()` — the earlier-generated nonce lost in 20/20
   trials, not roughly half. Traced the root cause directly:
   `generateNonce()` (`miniplayer-state.js:362`, pre-fix) used the same
   `` `${Date.now().toString(36)}-...}` `` shape as `generateTabId()`/
   `generateClaimToken()`, and since `Date.now()`'s base-36 encoding keeps
   a constant digit count for years, that leading segment deterministically
   dominates `shouldRotateOnCollision()`'s lexicographic `<` comparison —
   the trailing random suffix only ever gets consulted when the timestamps
   are byte-identical, which never happens across any realistic gap. The
   round-3 disposition's "unbiased coin flip" framing was simply wrong —
   confirmed by this repro, not just plausible from reading the diff.

2. **CONFIRMED — medium.** Reproduced exactly: an already-owning tab
   (`isOwner()` true) attempted a reclaim against storage where the shared
   envelope write fails; afterward `isOwner()` for that SAME tab returned
   `false`, even though the shared envelope was completely unchanged and
   still correctly named this tab. Traced the cause directly to round 3's
   own fix: writing the candidate token straight into `CLAIM_TOKEN_KEY`
   BEFORE knowing whether the shared write would succeed meant a failed
   attempt (plus a failed best-effort rollback) left this tab's own
   previously-valid token overwritten with an uncommitted one. Genuinely
   narrower than the original round-2/round-3 bug (the shared envelope
   itself is never corrupted, and no OTHER tab is affected — only the
   reclaiming tab's own local bookkeeping), but real and self-inflicted,
   exactly as described.

### Fixes applied (Claude, 2026-08-15)

Both fixed, both independently re-reproduced against the actual post-fix
code via the same standalone scripts (not just re-running the test suite)
to confirm the mechanism itself closed, given this is the fourth
consecutive round on this code and the third to find something the
previous round missed.

1. **Fixed by removing the orderable component entirely**, not by
   reweighting it. `generateNonce()` no longer includes `Date.now()` at
   all: `crypto.getRandomValues()` (16 bytes, base-36 encoded with
   per-byte zero-padding so every output has uniform length/character
   distribution) when available, with a same-shape two-draw
   `Math.random()`-only fallback otherwise — still free of any time
   component. Re-ran the exact repro against the fixed function: 8/20
   "earlier wins" in one run (close to the expected ~50%, nowhere near the
   pre-fix 20/20). Two new permanent tests added: a repeated-trial
   statistical check (generous band, guards against flakiness rather than
   asserting exact 50%) and a common-prefix check (two back-to-back calls
   must not share the long timestamp-driven prefix the old format
   produced).

2. **Fixed by staging, not by hardening the rollback again.**
   `claimOwnership()` now writes the candidate token to a NEW
   `PENDING_CLAIM_TOKEN_KEY` first, leaving `CLAIM_TOKEN_KEY` (this tab's
   existing, possibly-still-valid token) completely untouched until the
   shared envelope write is confirmed to have landed — only then is the
   candidate promoted to `CLAIM_TOKEN_KEY`. `isOwner()` now accepts either
   slot. This is a genuine, deliberate behavior change beyond a bugfix:
   when the shared write succeeds but the LOCAL promotion itself then
   fails, `claimOwnership()` now correctly reports `ok:true` (previously
   this exact residual case wasn't reachable in a way any prior round's
   tests exercised) — verified this is honest, not a regression, since
   `isOwner()` genuinely does resolve via the pending token in that case.
   Re-ran the exact repro against the fixed function: the reclaiming tab's
   `isOwner()` returned `true` after the identical failed-shared-write
   scenario, with its session token and the envelope's `ownerToken`
   confirmed matching. `scripts/test-miniplayer-state.mjs`'s three old
   finding-#3b tests (which asserted the now-superseded "any
   `CLAIM_TOKEN_KEY` write failure fails the whole claim" behavior) were
   replaced with four tests covering the actual current behavior: the
   staging write failing outright, an already-owning tab's reclaim
   surviving a failed shared write, a promotion-only failure now correctly
   reporting success, and a new claimant still correctly displacing a
   prior owner when only its own promotion fails.

**Re-verification**: `python3 scripts/build.py --check` and
`python3 scripts/build.py` (which also runs `verify_markup.py`) — clean,
31 shows/680 curated tracks/166 generated pages, no orphans. All 7
executable `node scripts/test-*.mjs` suites — **198/198 passing**
(`test-miniplayer-state.mjs` 55, up from 52; `test-player-boot.mjs` 28;
`test-player-controller.mjs` 41; `test-player-views.mjs` 17;
`test-playlist-state.mjs` 29; `test-playlist-views.mjs` 15;
`test-song-boot.mjs` 13). `node --check scripts/browser_check.mjs` and
`git diff --check` — clean. Plan doc updated to correct the "unbiased coin
flip" overclaim and document both round-4 fixes. Nothing committed.

---

## Phase 3 Stage 3a-foundation fifth fix verification — 2026-08-15

1. **Medium — A promotion-failed owner can still self-orphan on its next failed reclaim.**

   **Evidence:** When the shared write succeeds but promotion to `CLAIM_TOKEN_KEY` fails, `claimOwnership()` deliberately leaves the committed token only in `PENDING_CLAIM_TOKEN_KEY` ([scripts/miniplayer-state.js:803](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:803)); `isOwner()` accepts that token ([scripts/miniplayer-state.js:581](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:581)). A later `claimOwnership()` unconditionally overwrites that same pending slot with its new candidate ([scripts/miniplayer-state.js:783](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:783)). If the later shared write fails, it removes the candidate ([scripts/miniplayer-state.js:794](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:794)), permanently losing the previous committed token while the unchanged envelope still names it.

   A direct probe produced:

   `first claim: ok:true, owner:true, current:null, pendingMatches:true`

   `later failed reclaim: ok:false, owner:false, envelopeUnchanged:true, current:null, pending:null`

   The same result occurred with both calls routed through an injected `miniplayer-ownership` lock, so Web Locks cannot prevent this intra-operation state transition. The replacement tests split the two states: the promotion-failure test stops immediately after confirming pending ownership ([scripts/test-miniplayer-state.mjs:688](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:688)), while the failed-reclaim test begins with an ordinary successfully promoted current token ([scripts/test-miniplayer-state.mjs:664](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:664)). They never chain the two scenarios.

   **Why it matters:** This contradicts the plan’s assertion that accepting either slot leaves “nothing left to roll back in any branch” ([player-consolidation-plan.md:2003](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2003)). The fourth-round finding remains reachable after two individually tolerated storage failures.

   **Suggested fix:** Preserve whichever slot currently matches the envelope. If `CLAIM_TOKEN_KEY` matches, stage in the pending slot; if only `PENDING_CLAIM_TOKEN_KEY` matches, stage in the current slot or a second candidate slot. Never overwrite the sole matching token before the shared write commits. Add the exact chained regression test above, including an injected serializing lock provider.

2. **Low — The new nonce tests are probabilistic, can reject correct output, and do not exercise the fallback generator.**

   **Evidence:** The timing-bias test relies on 30 uncontrolled random comparisons ([scripts/test-miniplayer-state.mjs:863](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:863)); because calls are back-to-back, it does not ensure `Date.now()` differs as the original failure required. The common-prefix test rejects any randomly occurring three-character prefix ([scripts/test-miniplayer-state.mjs:882](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:882)); a correct crypto-generated pair has roughly a 1-in-1,846 chance of doing that. Both tests use Node’s available Web Crypto path, leaving the `Math.random()` fallback untested ([scripts/miniplayer-state.js:386](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:386)).

   **Why it matters:** The actual generator is timing-independent, but these tests are weaker than the plan’s verification claim and introduce avoidable suite flakiness.

   **Suggested fix:** Make nonce generation accept an injectable random-byte source, or test a small exported encoding helper with fixed byte sequences. Explicitly disable/mock `crypto` for a fallback test, control `Date.now()` to change between calls, and replace statistical/common-prefix assertions with deterministic format and comparison assertions.

**Verification during this review**

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks, no orphan song pages.
- `python3 scripts/verify_markup.py` — passed: 1,427 items across 166 generated pages.
- `python3 scripts/verify_markup.py --check-allowlist-coverage` — passed.
- All seven executable `node scripts/test-*.mjs` suites — 198/198 passed.
- `node --check scripts/browser_check.mjs`, `git diff --check`, and source/generated asset comparisons — passed.
- Focused nonce probe, 100,000 pairs per path — crypto earlier-win rate `50.192%`; forced `Math.random()` fallback with changing `Date.now()` `49.962%`. Both produced fixed 32-character outputs.
- Focused pending-token probes — reproduced the self-orphaning sequence both without a lock and through the named ownership lock.
- `node scripts/browser_check.mjs` — could not execute browser checks because `playwright-chromium` is unavailable.

### Disposition (Claude, 2026-08-15)

Both findings independently reproduced against the actual code before
recording this disposition.

1. **CONFIRMED — medium.** Reproduced exactly with a standalone script:
   claim 1 lands via the pending slot only (promotion to `CLAIM_TOKEN_KEY`
   fails, `PENDING_CLAIM_TOKEN_KEY` holds the committed token, `isOwner()`
   true via pending). A SECOND, later reclaim attempt then fails its
   shared-envelope write; its failure-cleanup path removes
   `PENDING_CLAIM_TOKEN_KEY` unconditionally — but that was the ONLY place
   the FIRST claim's still-valid, still-envelope-matching token lived.
   After the second (failed) attempt, session storage holds neither
   `CLAIM_TOKEN_KEY` nor `PENDING_CLAIM_TOKEN_KEY`, while the original
   envelope is completely unchanged and still names the original token —
   `isOwner()` now has nothing to match against and returns `false`. Root
   cause confirmed directly: round 4's fix moved the exact "overwrite an
   as-yet-unconfirmed slot before knowing if this attempt will succeed"
   pattern from `CLAIM_TOKEN_KEY` onto `PENDING_CLAIM_TOKEN_KEY`, without
   protecting the pending slot the same way — a second claim's own staging
   write (`sessionStore.setItem(PENDING_CLAIM_TOKEN_KEY, ...)`) clobbers
   whatever a PRIOR, still-relied-upon claim had staged there, with no
   memory of what it overwrote to restore on failure. This is the same bug
   class as round 4's finding 2, now reachable one level deeper — round 4's
   fix narrowed the failure window without eliminating the pattern that
   causes it.

2. **CONFIRMED — low, test-quality gap, not a code defect.** Read both
   tests directly: the timing-bias test (`test-miniplayer-state.mjs:863`)
   generates two nonces back-to-back without forcing any real time gap or
   controlling `Date.now()`, so it does not specifically exercise the
   original failure's precondition (a genuine millisecond-or-more gap
   between generations) — it happens to still catch the old bug because
   that bug was severe enough to fail even at native call-to-call spacing,
   but that's incidental, not by design. The common-prefix test
   (`:882`) asserts `commonPrefixLen <= 2`, which — confirmed by reasoning
   through the alphabet size (base-36) — has a real, nonzero chance of
   spuriously failing against a CORRECT, unbiased implementation purely by
   chance, matching Codex's estimate. Confirmed via grep: neither test (nor
   any other in the suite) disables/mocks `crypto` to exercise
   `generateNonce()`'s `Math.random()`-only fallback branch at all — that
   code path is currently untested.

**What I'd change if approved**: for finding 1, stage the new candidate
token without destroying whatever token (current OR pending) the envelope
currently matches — e.g. read which of the two slots (if either) actually
matches the CURRENT envelope before writing anything, and stage the new
candidate in the OTHER slot, never the one presently backing a valid
claim; add the exact chained regression test from the report (claim
succeeds-via-pending, then a second reclaim's shared write fails,
asserting the FIRST claim's `isOwner()` status survives), including a
real injected serializing lock provider per the report's note that Web
Locks alone doesn't prevent this (it's a single-tab sequential bug, not a
cross-tab race, so a lock was never going to help — worth saying
explicitly in the fix's comment so a future reader doesn't wonder). For
finding 2, make `generateNonce()`'s random-byte source injectable (or
extract/export the byte-to-string encoding step so it can be tested with
fixed input), add a test that explicitly disables `crypto` and controls
`Date.now()` across two calls to exercise the fallback path directly, and
replace the two probabilistic assertions with deterministic ones (fixed
byte sequences in, exact expected string out) rather than relying on
statistical bands.

Not implementing either — awaiting `/apply-review`.
_Review generated 2026-08-15 14:43:00 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

## Phase 3 Stage 3a-foundation — interactive review session — 2026-08-15

A separate, interactive Codex session (Rene ran it himself, outside
`scripts/codex_review.sh`, and pasted the verdict into chat) reviewed the
same ownership code immediately after the fifth automated round above.
Confirmed the fifth round's finding, and found three further instances of
the identical root cause. All four claims independently reproduced by
Claude against the actual code (standalone repro scripts, not the
reviewer's word) before being accepted, matching the verification standard
every `codex_review.sh` round in this log has been held to.

1. **Revocation is not settled as one unit.** `setRevoked()`/`clearRevoked()`
   are two independent `sessionStorage` operations with no coordination
   between them ([scripts/miniplayer-state.js:525](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:525) (old)).
   A failed `clearRevoked()` inside `claimOwnership()` leaves the revoked
   marker set even though the claim otherwise landed and reports
   `ok:true` — the caller believes it reclaimed ownership, but `isOwner()`
   still returns `false` on the very next check because the stale latch
   was never actually cleared.

2. **`getTabId()`/`rotateTabId()` silently tolerate a failed persist.**
   Both functions call `sessionStore.setItem()` and, on a thrown
   exception, fall back to returning the freshly-generated (but never
   durably stored) id anyway ([scripts/miniplayer-state.js:254-273](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:254) (old)).
   A caller that commits a write under that id has no way to know the id
   was never actually saved — the very next read (e.g. after navigation,
   or even just a second call in the same document if the underlying
   store is now failing every write) returns something else entirely,
   orphaning whatever was just claimed under the ephemeral one.

3. **`readEnvelope()` collapses "read threw" and "nothing exists" into the
   same `null`.** A `localStorage.getItem()` call that throws (storage
   disabled, a hostile/corrupted environment) is indistinguishable from a
   confirmed-empty key ([scripts/miniplayer-state.js:225-232](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:225) (old)).
   `isOwner()`'s grant-case 1 ("no envelope exists → free to originate")
   then fires on a genuine read FAILURE exactly as it would on a genuine
   fresh session — a broken store gets treated as a free-to-claim one.

**Verdict: stop patching this shape, redesign the subsystem.** Every one
of these, plus all three of the automated rounds' findings (3, 4, 5), is
the identical shape: a multi-step commit spread across two separate
Storage objects, which Web Storage gives no cross-key atomicity for. Every
individual fix narrowed the failure window without removing the shape that
keeps producing new instances of it.

### Disposition (Claude, 2026-08-15)

All three findings independently reproduced against the actual code
before recording this disposition (standalone scripts exercising
`setRevoked()`/`clearRevoked()`, `getTabId()`/`rotateTabId()`, and
`readEnvelope()` directly under injected failing/throwing fakes). Agreed
with the verdict: **not implementing any of these three as individual
patches.** A sixth patch in the same shape would, per the pattern already
established by rounds 3/4/5, almost certainly leave behind a seventh. A
complete redesign was planned instead — see the plan doc's "Blocker B,
redesigned: single-commit fenced lease" section for the design, and the
implementation entry below for what shipped from it.

## Phase 3 Stage 3a-foundation — fenced-lease redesign implementation — 2026-08-15

Implemented directly (Claude, standing preference for this project), from
the design already reviewed and finalized in plan-mode against the actual
code (see `player-consolidation-plan.md`'s "Blocker B, redesigned" section
for the full design and rationale — condensed here to what changed and how
it was verified).

**What shipped**: `scripts/miniplayer-state.js` rewritten in place.
`claimOwnership()` is now exactly one `localStorage.setItem()` call — no
second store write is ever part of the commit, so there is nothing left to
roll back in any branch, closing the shape (not just the latest instance
of it) that produced rounds 3, 4, 5, and all three interactive-session
findings above. The fencing credential (a `{ownerId, ownerEpoch}` "lease")
is never persisted anywhere; it lives only in the caller's JS memory and is
re-derived at boot by `restoreLease()` reading the one durable envelope.
`writeSession()`/`tombstoneIfCurrent()` take that lease explicitly and
gate every write on `hasValidLease()`, checked fresh immediately before
the actual write — this is the mechanism that makes a delayed write issued
under a superseded lease structurally unable to land, closing round 5's
actual bug at the root rather than narrowing it further. Revocation
(`isEpochRevoked()`/`revokeLease()`) is scoped by comparing a specific
`ownerEpoch` value rather than a boolean latch that must later be cleared
— a fresh epoch is never equal to a previously recorded revoked one, so
supersession is automatic and there is no clear step left to fail (closes
interactive finding 1). `establishTabId()`/`rotateTabId()` now read back
what was actually persisted before returning it, returning `null` instead
of a fabricated ephemeral id on any failed-or-unverified write (closes
finding 2). `readEnvelope()` is now tri-state (`'ok'`/`'absent'`/
`'unavailable'`), so a genuine read failure can never again be treated as
a free-to-claim empty session (closes finding 3). The best-effort
unlocked fallback in `withOwnershipLock()` is removed — with no lock
provider available, the critical section never runs at all, and callers
surface a documented degraded result (`{ok:false, reason:'no-lock'}` /
`false`) rather than running unprotected; this is a judgment call flagged
in the plan (Codex's recommendation, Claude agreed, explicitly re-confirmed
with Rene this session before implementing) since the OLD design's
no-lock race could permanently orphan a claim while the NEW design's
would just be a self-healing one-cycle glitch (a single atomic `setItem()`
has nothing to half-write).

**Test suite rewritten to match**: `scripts/test-miniplayer-state.mjs`,
83/83 passing (up from 55 in the pre-redesign shape — the old suite's
claim-token/`isOwner()`-specific tests no longer apply to the new API and
were replaced, not kept alongside). Covers, among others, the exact test
list called out in the plan: a call-counting fake proving `claimOwnership()`
performs exactly one `setItem()`; `establishTabId()`/`rotateTabId()`
returning `null` (never a fabricated id) on both a thrown write and a
write that "succeeds" but a read-back doesn't confirm; `readEnvelope()`
resolving `'unavailable'` (never `'absent'`) on a thrown read; supersession
without any clear step, proven directly; `writeSession()` rejected on a
stale `ownerId` (gate 6) and — the sharpest test in the suite, re-targeting
round 5's actual bug at the new design — rejected on a stale `ownerEpoch`
with `ownerId` unchanged (gate 7); `tombstoneIfCurrent()` proven unable to
stomp a fresher legitimate claim; an end-to-end sequencing test running
`establishTabId()` through the (unchanged) collision handshake to
convergence via the existing `fakeChannel()` harness, then `restoreLease()`
resolving exactly one of two duplicated tabs to `'restored'`; and both
`claimOwnership()`/`writeSession()` proven to take the degraded no-lock
path with no provider injected and no `navigator.locks` (this Node
environment has neither). The tab-collision handshake's own tests carried
forward with no logic changes (out of scope for this redesign, per the
plan), updated only where they referenced the removed `getTabId()`/
`isOwner()`.

**Full-suite verification**: all 7 executable `node scripts/test-*.mjs`
suites, 226/226 passing (83 miniplayer-state + 28 player-boot + 41
player-controller + 17 player-views + 29 playlist-state + 15
playlist-views + 13 song-boot — `song-boot.js` unaffected, confirmed by
grep it never imports this module). `python3 scripts/build.py --check`
and `python3 scripts/build.py` both clean (`assets/miniplayer-state.js`
regenerated as the verbatim build-output copy, per this repo's
`scripts/*.js` → `assets/*.js` convention — not hand-edited).

**Not done as part of this pass, per the plan's own "residual gaps"
section**: `browser_check.mjs`'s real-browser two-tab ownership test
(gate 6/7 against a genuine second tab, not a fake) — `playwright-chromium`
unavailable in this environment, same limitation every prior round in
this log has hit. At least one more `/review-step` round against this
implementation is still owed before treating the ownership subsystem as
settled — three of the last three automated rounds plus the interactive
session each found something real, so a clean round here should be read
as encouraging, not conclusive, until it actually happens. Not yet
committed.

---

## Fenced-lease redesign review — 2026-08-15

1. **Medium — A stale revocation can overwrite a newer revoked epoch, making the newer epoch resumable again.**

   Evidence: revocation uses one shared `REVOKED_EPOCH_KEY`; `revokeLease()` unconditionally replaces its value, while `isEpochRevoked()` compares only against that latest value ([miniplayer-state.js:492](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:492), [miniplayer-state.js:528](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:528)). Calling `revokeLease(newEpoch)` followed by a delayed `revokeLease(oldEpoch)` makes `isEpochRevoked(newEpoch)` return `false`. Existing tests exercise only one stored epoch and the normal fresh-claim direction ([test-miniplayer-state.mjs:401](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:401)). This also contradicts the plan’s claim that all remaining revocation gaps require two write failures ([player-consolidation-plan.md:2356](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2356)). The assumption that navigation always wipes the old in-memory lease is also unsafe with lifecycle restoration or leaked callbacks ([player-consolidation-plan.md:2147](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2147)).

   Why it matters: a delayed listener or restored old document can replace epoch B’s durable revocation with epoch A. If the envelope still names B, the next `restoreLease()` can return `restored`, recreating the phantom-resume behavior revocation exists to prevent—with no storage failures involved.

   Suggested fix: store revocation independently per epoch, such as `miniPlayerRevokedEpoch:<ownerEpoch>`, so revoking one epoch cannot un-revoke another and each revocation remains one atomic `setItem()`. Add a regression test that revokes B, then stale A, and verifies both remain revoked. Also remove or qualify the plan’s “wiped by navigation” and two-write-failure claims.

2. **Low — The tests do not prove two edge-path invariants that the plan relies on.**

   Evidence: the call-counting test covers only `claimOwnership()`’s happy path ([test-miniplayer-state.mjs:562](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:562)); the write-failure test uses an uncounted throwing store ([test-miniplayer-state.mjs:587](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:587)). Thus a future failure-only rollback write would evade both tests despite the implementation record claiming the counter proves exactly one write ([player-consolidation-codex.md:3436](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-codex.md:3436)). Likewise, no-lock behavior is tested for `claimOwnership()` and `writeSession()` but not `tombstoneIfCurrent()`, although the plan specifies all three ([player-consolidation-plan.md:2330](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2330)). The code currently satisfies both invariants: the failure-path probe attempted exactly one write, and all three operations route through `withOwnershipLock()` ([miniplayer-state.js:666](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:666)).

   Why it matters: these are precisely the failure branches where the superseded design repeatedly regressed, so happy-path-only coverage is insufficient protection.

   Suggested fix: add a counting store whose first `setItem()` throws and assert exactly one attempted write, plus a no-provider `tombstoneIfCurrent()` test asserting `false` and byte-for-byte unchanged storage.

### Verification during this review

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks, no orphan song pages.
- All seven executable `node scripts/test-*.mjs` suites — 226/226 passed.
- Focused inline probes — confirmed one claim write attempt on quota failure; confirmed no-lock `writeSession()` and `tombstoneIfCurrent()` both return `false` without mutation; reproduced the stale-revocation overwrite described above.
_Review generated 2026-08-15 19:35:51 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-15)

Both findings independently reproduced against the actual code before
recording this disposition.

1. **CONFIRMED — medium.** Reproduced exactly with a standalone script:
   claimed epoch A, `revokeLease(A)` (A correctly revoked), reclaimed as
   epoch B, `revokeLease(B)` (B correctly revoked — `isEpochRevoked(B)`
   true), then a THIRD, stale `revokeLease(A)` call (modeling a delayed
   listener or leftover closure still holding the earlier lease) —
   `isEpochRevoked(B)` immediately flips back to `false`, and
   `restoreLease()` on the same storage resolves `'restored'` instead of
   `'revoked'`. Root cause confirmed directly: `REVOKED_EPOCH_KEY` holds
   only the single most-recently-written epoch, and `isEpochRevoked()`
   compares against exactly that one value — a later write to the same key
   unconditionally destroys the record of any earlier one, regardless of
   which epoch is actually current. This does contradict the plan's
   residual-gaps claim that every remaining gap "requires two independent
   write failures with no successful write in between" — this one requires
   zero failures, just two ordinary (non-failing) writes arriving
   out of order, which is a materially weaker (worse) precondition than
   the plan claims. The "caller contract" note in the plan/module that the
   in-memory lease is wiped by navigation is unaffected by this gap and
   remains correct as far as it goes — it's specifically an out-of-order
   *duplicate/stale* revocation call (not navigation) that this finding
   depends on, worth clarifying in the fix's own comment rather than
   removing that language outright.

2. **CONFIRMED — low, test-quality gap, not a code defect.** Read the
   test file directly: `countingStorage()` is instantiated and asserted on
   only once (`test-miniplayer-state.mjs:563`), covering solely the happy
   path; the write-failure test (`:587`, "fails with write-failed...")
   uses a plain `throwingStorage()` with no write-count assertion, so a
   hypothetical future rollback/second write on that path would pass
   silently. Confirmed via grep: `tombstoneIfCurrent()` has no counterpart
   to the "no lock provider" tests that exist for `claimOwnership()`
   (`:614`) and `writeSession()` (`:696`). Consistent with Codex's own
   probes (recorded above) that the CODE already satisfies both invariants
   today — this is purely about the test suite not proving it, the same
   category of gap this project has flagged before (a correct
   implementation under-protected by its own regression suite).

**What I'd change if approved**: for finding 1, key revocation per-epoch
(e.g. `REVOKED_EPOCH_KEY` becomes a small JSON set/list of revoked epochs,
or a per-epoch key like `miniPlayerRevokedEpoch:<epoch>`) so revoking one
epoch can never un-revoke another, each individual revocation remains a
single atomic `setItem()`, and `isEpochRevoked()` checks membership rather
than equality against a single slot; add the exact repro above as a
regression test (revoke B, then a stale revoke of an OLDER epoch A,
assert B is still revoked and `restoreLease()` still returns `'revoked'`);
narrow the plan's residual-gaps wording to no longer claim this class of
gap requires a write failure. For finding 2, add a counting-store variant
of the write-failure test asserting exactly one attempted write (not just
the outcome), and add a `tombstoneIfCurrent()` no-lock-provider test
mirroring the existing two.

Not implementing either — awaiting `/apply-review`.

**Applied (Claude, 2026-08-15).** Both findings fixed, per Rene's go-ahead:

1. `REVOKED_EPOCH_KEY` now stores a bounded (`MAX_REVOKED_EPOCHS = 32`),
   deduped JSON array of revoked epochs rather than a single value.
   `isEpochRevoked()` checks set membership; `revokeLease()` appends
   (still exactly one `setItem()` call — the fix is what gets written, not
   how many writes happen), evicting the oldest entry once the cap is
   exceeded. Regression test added reproducing the exact repro from the
   finding (revoke B, then a stale revoke of older A, assert B is still
   revoked) plus a cap/eviction test. The plan's residual-gaps wording is
   corrected below to no longer claim this class of gap needs a write
   failure — the fixed version now does require one, closing the gap this
   finding identified.
2. Added a `throwingCountingStorage()` fake and a companion test proving
   `claimOwnership()` attempts exactly one `setItem()` call on the
   write-FAILURE path, not just the happy path; added a
   `tombstoneIfCurrent()` no-lock-provider test mirroring the existing
   `claimOwnership()`/`writeSession()` ones.

`scripts/test-miniplayer-state.mjs`: 87/87 passing (up from 83 — 2 rewritten
for the new storage format, 4 new). All 7 suites, 230/230 passing;
`build.py --check`/`build.py` clean. Not yet committed.

---

## Revocation-fix review — 2026-08-15

1. **Medium — An unreadable or corrupt revocation set fails open and can erase every prior revocation.**

   Evidence: [`readRevokedEpochs()`](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:507) returns `null` for a read exception but `[]` for malformed/non-array JSON. [`revokeLease()`](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:561) converts either result to `[]`, then successfully overwrites the key with only the requested epoch. [`isEpochRevoked()`](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:527) also treats corrupt JSON as no revocations. A focused probe produced `{ok:true, escalated:false}`, forgot the current revoked epoch, and made [`restoreLease()`](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:636) return `restored` after one transient read failure and a successful write. Corrupt JSON likewise changed a revoked lease to `restored`.

   Why it matters: the original stale-revocation bug reappears whenever a read temporarily throws or the stored value is damaged—without either of the two write failures the plan claims are required at [plan lines 2197–2199](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2197). This is not a cross-origin security boundary, but it can recreate phantom session restoration after storage corruption or transient browser/storage failure. No test covers corrupt JSON or `revokeLease()` after an unreadable set.

   Suggested fix: make `readRevokedEpochs()` tri-state. Treat malformed, wrong-shape, or unreadable data as unknown/fail-closed. `isEpochRevoked()` should return `true`; `revokeLease()` must not overwrite unknown history and should instead rotate the tab ID, returning the escalated result. Add both corrupt-JSON and transient-read-failure restoration regressions.

2. **Medium — The 32-entry cap lets delayed old revocations evict the currently revoked epoch with zero failures.**

   Evidence: [`revokeLease()`](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:565) removes the target, appends it as newest, and shifts entries until only 32 remain. After creating 32 old leases, claiming current lease B, revoking B, then delivering delayed revocations for those 32 old leases, a focused probe showed `isEpochRevoked(B) === false` and `restoreLease() === 'restored'`. The envelope still names B because the delayed revocations do not rewrite it. This directly contradicts the claims that revoking one epoch “can never destroy” another and that the cap gap is practically unreachable at [plan lines 2388–2399](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2388), as well as the review-log claim that the fixed case now requires a failure at [codex log lines 3573–3577](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-codex.md:3573).

   Why it matters: this is the same stale-callback lifecycle shape the fix targets, merely repeated enough times to cross the cap. Each individual `setItem()` is atomic, but that does not make the bounded read/modify/write policy loss-free.

   Suggested fix: before recording a revocation, validate that the supplied lease still matches the current envelope; a stale lease cannot need durable revocation when the envelope names a newer epoch. If that API change is undesirable, remove the cap until an eviction policy can guarantee the envelope-named revoked epoch is retained. Update the plan to describe any remaining finite-cap limitation accurately.

3. **Low — The two new revocation tests do not prove their broad names and plan claims.**

   Evidence: the stale regression at [`test-miniplayer-state.mjs:441`](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:441) checks only two epochs and membership; it does not construct an envelope, assert `restoreLease() === 'revoked'`, or exercise cap pressure. Its “never” claim is disproved by the probe above. The eviction test at [`test-miniplayer-state.mjs:458`](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:458) accepts any length from 1–32 and checks only that epoch 0 disappeared and epoch 39 survived. An implementation retaining only epoch 39 would pass; it does not prove exact capacity, FIFO boundaries, stored order, or deduplication.

   Why it matters: both tests remain green under materially incorrect eviction policies, including policies that forget recent revocations prematurely.

   Suggested fix: assert the stored array equals `epochs.slice(-32)` exactly; test the boundary epochs, duplicate insertion behavior, and malformed/duplicate stored input. Extend the stale regression through a real envelope and `restoreLease()`, including enough delayed distinct epochs to cross the cap.

4. **Low — The new tombstone no-lock test proves semantic equality, not that no storage write occurred.**

   Evidence: [`test-miniplayer-state.mjs:765`](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:765) compares decoded envelopes with `deepEqual`. A rewrite of byte-identical JSON, or a write to another key, would still satisfy that assertion despite the test name claiming “writes nothing.”

   Why it matters: the intended invariant is that the fail-closed path never enters the critical section or touches storage, not merely that the decoded state looks unchanged afterward.

   Suggested fix: use `countingStorage()`, snapshot the raw backing store, and assert zero additional `setItem()`/`removeItem()` calls plus byte-for-byte equality. The new `throwingCountingStorage()` claim-failure test itself correctly detects a second attempted `setItem()`.

5. **Low — The plan’s function-level revocation contract still describes the removed single-value implementation.**

   Evidence: [plan lines 2281–2284](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2281) say `isEpochRevoked()` compares one stored `revokedEpoch` for exact equality and that `revokeLease()` persists one epoch, while the implementation now reads and writes an array.

   Why it matters: this is the authoritative design section later work will implement against, so it can cause the old bug to be reintroduced despite the later residual-gap note.

   Suggested fix: update the function contracts to specify validated array membership, deduplication, eviction behavior, and the intended fail-closed handling for unreadable or malformed arrays.

**Verification during this review**

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks, no orphan song pages.
- `for test_file in scripts/test-*.mjs; do node "$test_file" || exit; done` — passed: all seven suites, 230/230 tests.
- Focused Node probes — reproduced corrupt-JSON restoration, transient-read revocation loss, and current-epoch eviction after 32 delayed old revocations.
- `cmp scripts/miniplayer-state.js assets/miniplayer-state.js` — source and generated asset match.
- `node --check scripts/miniplayer-state.js` and `node --check scripts/test-miniplayer-state.mjs` — passed.
_Review generated 2026-08-15 19:49:59 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-15)

All five findings independently reproduced/checked against the actual code
before recording this disposition.

1. **CONFIRMED — medium.** Reproduced exactly with a standalone script:
   revoked B, hand-corrupted the stored revoked-epoch set's raw JSON, then
   called `revokeLease()` for an unrelated epoch — the corrupt read
   collapsed to `[]`, the write proceeded, and B's revocation was silently
   lost (`isEpochRevoked(B)` flipped to `false`, `restoreLease()` returned
   `'restored'`). Root cause confirmed directly: `revokeLease()`'s
   `readRevokedEpochs(sessionStore) || []` treated an unreadable/corrupt
   read identically to a confirmed-empty one before overwriting, with no
   failure required at all.
2. **CONFIRMED — medium.** Reproduced exactly: revoked B, then delivered
   32 unrelated stale revocations for older epochs — the FIFO cap evicted
   B's entry with zero storage failures involved, `isEpochRevoked(B)`
   flipped to `false`, `restoreLease()` returned `'restored'`. Directly
   contradicted the plan's claim that this was "practically unreachable."
3. **CONFIRMED — low, test-quality.** The stale-regression test asserted
   only `isEpochRevoked()` in isolation, never constructing a real envelope
   or asserting `restoreLease()`'s actual status; the eviction test
   accepted any length ≤32 and only checked the two boundary epochs, not
   exact FIFO order.
4. **CONFIRMED — low, test-quality.** The no-lock tombstone test used
   `assert.deepEqual` on the *decoded* envelope, which a byte-identical
   rewrite (or a write to an unrelated key) would still satisfy despite
   the test's "writes nothing" claim.
5. **CONFIRMED — documentation drift.** The plan's function-level
   contract for `revokeLease()`/`isEpochRevoked()` (written earlier the
   same day, describing the just-superseded array design) no longer
   matched either the array implementation it described or the fix
   applied afterward.

**Fixed, all five, same session — this time by removing the shape rather
than further patching it**, per this project's own established lesson
from the original claim-token bugs: the actual root cause wasn't "not
enough history remembered," it was that `restoreLease()` only ever checks
revocation against whatever epoch the envelope *currently* names, so a
revocation for any *other* epoch is provably irrelevant the instant it's
attempted. `revokeLease()` now takes `(localStore, sessionStore, lease)`
and skips the write entirely — never reads, never merges, never touches
`REVOKED_EPOCH_KEY` — when the given epoch no longer matches the fresh
envelope. `REVOKED_EPOCH_KEY` reverted to a single string value (no JSON,
no cap, no eviction policy to get wrong); `isEpochRevoked()` is back to a
plain equality check. On a genuine envelope-read failure (`'unavailable'`),
the write proceeds anyway (errs toward revoking rather than silently
skipping a possibly-legitimate revocation) — verified by test and by a
standalone repro. Re-ran both original repro scripts against the fixed
code: finding 1's corrupted-storage scenario no longer applies at all
(there is no more read-merge-write cycle on the revocation key for it to
corrupt); finding 2's 100-stale-call repro now correctly leaves the
current revocation untouched. A third standalone check confirmed no
legitimate (non-tampered) call sequence can lose a real revocation.
Findings 3/4 fixed by rewriting the affected tests to go through real
`claimOwnership()`/`restoreLease()` calls and `countingStorage()`
respectively. Finding 5 fixed by updating the plan doc's function
contract to match.

`scripts/test-miniplayer-state.mjs`: 89/89 passing. All 7 suites,
232/232 passing; `build.py --check`/`build.py` clean. Not yet committed.

---

## Latest `revokeLease()` revocation-fix review — 2026-08-15

1. **Medium — An unavailable envelope read lets a stale revocation overwrite the current marker and makes `restoreLease()` resume a genuinely revoked lease.**

   Evidence: [`revokeLease()`](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:568) writes the supplied epoch whenever `readEnvelope()` returns anything other than an `ok` envelope naming a different epoch. Therefore the explicit `unavailable` branch overwrites `REVOKED_EPOCH_KEY` at [line 573](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:573). I reproduced: claim epoch A, reclaim as epoch B, revoke B, make the next `localStorage.getItem()` throw once, then deliver stale `revokeLease(A)`. The marker changed from B to A and [`restoreLease()`](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:639) changed from `revoked` to `restored`.

   The tests do not catch this. The clean-read stale regressions correctly reach `restoreLease()` ([test lines 467–486](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:467), [493–504](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:493)), but the `unavailable` test starts with no envelope or existing relevant marker and only asserts the stale value was written ([515–521](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:515)). It therefore proves the unsafe policy rather than the end-to-end property.

   Why it matters: this requires one transient read failure and otherwise successful storage operations—no tampering and not the two write failures claimed by the plan. It directly contradicts “nothing left to lose” and “no legitimate (non-tampered) call sequence can lose a real revocation” at [plan lines 2427–2436](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2427), as well as the residual-gap characterization at [2396–2405](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2396).

   The missing ownership lock is not a separate clean-read defect in the intended top-level caller: `revokeLease()` is synchronous, local callbacks cannot interleave within it, and other tabs can change shared `localStorage` but not this tab’s `sessionStorage` marker. The platform explicitly provides no cross-agent locking for local storage, however, so the unknown-read branch cannot safely infer which marker may be current. [HTML Web Storage specification](https://html.spec.whatwg.org/multipage/webstorage.html)

   Suggested fix: never overwrite the single marker when `readEnvelope()` is `unavailable`. Escalate directly by rotating the tab ID; if rotation succeeds, return `{ok:true, escalated:true}` with the existing marker untouched, and if it fails return `{ok:false, escalated:true}`. Add the exact end-to-end regression above, asserting the B marker remains intact and `restoreLease()` never returns `restored`. Alternatively, use independent per-epoch keys so revoking A can never overwrite B. Correct the plan’s safety and residual-gap claims.

**Verification during this review**

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks, no orphan song pages.
- `for test_file in scripts/test-*.mjs; do node "$test_file" || exit; done` — passed: all seven suites, 232/232 tests.
- Focused Node reproduction — confirmed transient envelope-read failure changes B from `revoked` to `restored`.
- `node --check scripts/miniplayer-state.js` and `node --check scripts/test-miniplayer-state.mjs` — passed.
- `cmp scripts/miniplayer-state.js assets/miniplayer-state.js` — passed; source and generated asset match.
_Review generated 2026-08-15 20:03:19 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-15)

**CONFIRMED — medium.** Reproduced exactly with a standalone script: A
claimed, reclaimed as B, B revoked (`restoreLease()` correctly `'revoked'`)
— then a stale `revokeLease(A)` call hit a `localStorage.getItem()` that
throws exactly once (a transient read failure, not tampering, not
corruption) — the previous fix's "proceed with the write when unavailable"
policy overwrote `REVOKED_EPOCH_KEY` from B to A anyway, and
`restoreLease()` flipped from `'revoked'` to `'restored'`. Root cause
confirmed directly: my own stated rationale for that policy ("err toward
revoking, never silently skip a legitimate revocation") was solving the
wrong problem — it correctly avoided *skipping* a legitimate revocation,
but didn't account for a stale/irrelevant call ALSO hitting the
`'unavailable'` branch and blindly overwriting a different, genuinely
current one. Same bug class as findings 1 and 2 from the prior two rounds,
third distinct trigger path.

**Fixed** by treating an unavailable envelope read the same way a failed
`sessionStorage` write is already treated: escalate via `rotateTabId()`
instead of writing the marker at all. This can neither confirm the epoch
is current nor rule it out, so it does neither of the two things that
already proved unsafe (writing unconditionally, or silently skipping) —
it makes the decision moot by rotating this document's own identity,
which the same `restoreLease()` ownerId check already relies on elsewhere
in this design. Re-ran the exact repro above against the fix: result is
now `{ok:true, escalated:true}`, B's marker is completely untouched, and
`restoreLease()` reports `'not-mine'` (never `'restored'`) — the escalation
does mean this specific tab can no longer recognize its own still-valid
claim B until it explicitly reclaims again (a narrow, honestly-documented
consequence: it only bites when a caller has already violated its own
"drop the lease before calling revokeLease" contract by holding a stale
lease past its drop point, AND a transient read failure lands at that
exact moment — both required, matching the residual-gaps section's stated
severity bar).

`scripts/test-miniplayer-state.mjs`: 90/90 passing (added an escalation
test and the end-to-end transient-failure regression, replaced the test
that asserted the old unsafe "write anyway" behavior). All 7 suites,
233/233 passing; `build.py --check`/`build.py` clean. Not yet committed.

**This is the third round in a row to find something real in
`revokeLease()` specifically** (single-value overwrite → bounded-set
eviction → unavailable-read overwrite, one fix session, three distinct
bugs, all in the same ~15-line function). Per this project's own stated
standard, a clean round from here is required, not assumed, before this
subsystem is considered settled.

---

## `revokeLease()` fourth-form review — 2026-08-15

1. **Medium — Successful escalation leaves the collision handshake’s cached tab ID stale, allowing a later duplicated tab to evade collision detection.**

   Evidence: `revokeLease()` rotates `TAB_ID_KEY` on an unavailable envelope or failed marker write ([scripts/miniplayer-state.js:579](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:579), [scripts/miniplayer-state.js:590](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:590)). However, the documented boot wiring caches `myTabId` and refreshes it only when a handshake handler itself reports rotation ([scripts/miniplayer-state.js:377](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:377), [scripts/miniplayer-state.js:382](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:382)). The handlers compare incoming probes against that caller-supplied cached value ([scripts/miniplayer-state.js:466](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:466), [scripts/miniplayer-state.js:481](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:481)).

   A focused reproduction established an ID, forced `revokeLease()` through its unavailable-read escalation, copied the resulting session storage as a duplicated tab would, and sent a probe using the rotated ID. With the documented cached pre-rotation ID, `handleIncomingProbe()` returned `{reply:null, rotated:false}`; using `peekTabId()` instead recognized the collision and returned a reply. If ownership is later reclaimed under the shared rotated ID, the undetected clone can subsequently restore that lease because its `ownerId` matches.

   The tests exercise revocation escalation and collision handling separately. The revocation tests only verify that storage rotated ([scripts/test-miniplayer-state.mjs:515](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:515)); the collision fixture refreshes its cached ID only after rotations initiated inside the handshake ([scripts/test-miniplayer-state.mjs:984](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:984)). No test joins these paths.

   The plan’s branch-by-branch `revokeLease()` description matches the implementation, but its caller contract mentions only dropping the lease ([player-consolidation-plan.md:2295](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2295)), while calling the unchanged handshake “solid” ([player-consolidation-plan.md:2283](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2283)) and residual item 5 “not a live gap” ([player-consolidation-plan.md:2429](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2429)). Those safety claims are now unsupported.

   Suggested fix: structurally prevent cached-identity divergence—prefer having handshake dispatch read `peekTabId(sessionStore)` for every message, or require every successful `revokeLease()` escalation to refresh `myTabId` immediately. Add an end-to-end test covering escalation → copied session storage → clone probe → claim/restore, asserting the collision is resolved and at most one tab restores. Cover both escalation triggers. Update the plan’s function contract and residual-gap item 5 accordingly.

### Verification during this review

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks, no orphan song pages.
- `for test_file in scripts/test-*.mjs; do node "$test_file" || exit; done` — passed: all seven suites, 233/233 tests.
- `node --check scripts/miniplayer-state.js && node --check scripts/test-miniplayer-state.mjs` — passed.
- `cmp scripts/miniplayer-state.js assets/miniplayer-state.js` — passed; generated asset matches source.
- Focused inline Node escalation/collision probe — reproduced the stale cached-ID failure described above.
_Review generated 2026-08-15 20:11:50 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-15)

**CONFIRMED — medium, a genuinely fourth and distinct bug, not a
re-discovery of rounds 1-3.** Reproduced exactly with a standalone script:
established a tab id, escalated `revokeLease()` via an unavailable
envelope read (rotating `TAB_ID_KEY` internally, as intended), then sent a
collision probe carrying the CURRENT (rotated) id. `handleIncomingProbe()`
called with the STALE cached `myTabId` (never refreshed, since the
documented boot pseudocode only refreshes it on a handshake-reported
rotation) returned `{reply:null, rotated:false}` — the real collision
invisible, no reply ever sent. The identical probe, called with a freshly
re-read `peekTabId(sessionStore)`, correctly recognized the collision and
replied. Root cause confirmed directly: `revokeLease()`'s escalation path
(added this session, to fix the round-3 finding) introduced a SECOND
trigger for `TAB_ID_KEY` rotation that the collision handshake's
documented caller-wiring pseudocode was never updated to account for — it
only ever refreshed the cached id in response to a rotation the handshake
itself reported.

**This is a caller-contract/documentation gap, not a defect inside
`revokeLease()` or the handshake functions themselves** — both correctly
do what they're individually documented to do; the gap is specifically
that nothing connected the two. Per this project's own established
boundary (`HANDOFF.md`'s "Durable facts": the tab-collision handshake "is
NOT part of the redesign... considered solid after rounds 3-4, out of
scope, keep as-is"), the fix does not touch
`handleIncomingProbe`/`handleIncomingProbeReply`/`isTabProbeCollision` —
doing so would mean modifying code this project has separately declared
settled. Instead: the boot-pseudocode comment now explicitly states the
caller contract (refresh `myTabId` after `revokeLease()` reports
`escalated:true`, exactly the same as after a handshake-reported
rotation), `revokeLease()`'s own comment cross-references it, and two new
tests prove both the hazard (stale cached id → collision invisible) and
the fix (fresh `peekTabId()` after escalation → collision correctly
detected).

`scripts/test-miniplayer-state.mjs`: 92/92 passing. All 7 suites,
235/235 passing; `build.py --check`/`build.py` clean. Not yet committed.

**Fourth round in a row to find something real in this immediate area**
(the first three all inside `revokeLease()` itself; this one at the
boundary between `revokeLease()` and the handshake it now interacts
with). Per this project's own repeatedly-stated standard, still not
treating a clean round as assured — one more genuinely clean pass is
owed before this is settled.

---

## Caller-contract fix review — 2026-08-15

1. **Medium — The plan’s canonical `revokeLease()` caller contract still omits the required cached-ID refresh.**

   Evidence: The function-by-function contract describes dropping the lease and calling `revokeLease()`, but never instructs the caller to refresh `myTabId` when `escalated:true` ([player-consolidation-plan.md:2302](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2302), [player-consolidation-plan.md:2321](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2321)). The requirement appears only later in the historical residual-gap narrative ([player-consolidation-plan.md:2474](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2474)).

   Why it matters: A future boot implementation is likely to follow the function-by-function API contract rather than reconstruct requirements from review provenance. Following that section literally would recreate the stale-ID hazard this fix addresses.

   Suggested fix: Add `if (result.escalated) myTabId = peekTabId(sessionStore)` directly to the `revokeLease()` caller contract around line 2326, including the reason that handshake handlers trust the cached caller-supplied ID.

2. **Low — `revokeLease()`’s new comment incorrectly says `escalated:true` proves the ID was rotated.**

   Evidence: The comment says “`escalated:true` means TAB_ID_KEY was just rotated” ([miniplayer-state.js:589](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:589)). Both escalation branches return `escalated:true` even when `rotateTabId()` returns `null`, producing `{ok:false, escalated:true}` ([miniplayer-state.js:606](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:606), [miniplayer-state.js:617](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:617)); that result is explicitly tested ([test-miniplayer-state.mjs:566](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:566)).

   Why it matters: The refresh-on-`escalated` rule remains safe and correct, but callers must not infer that rotation succeeded unless `ok:true`. The current wording contradicts the documented return shape.

   Suggested fix: Say that `escalated:true` means rotation was attempted and the caller must refresh its cache; `ok:true` means the rotation landed, while `ok:false` means it failed.

No additional unaccounted rotation source exists in this module. `establishTabId()` writes only during boot before the cache is established; runtime rotation is limited to the handshake’s `resolveCollision()` path and `revokeLease()`. The two new tests faithfully exercise `handleIncomingProbe()` with stale versus refreshed IDs and prove their stated behavior.

**Verification during this review**

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks, no orphan song pages.
- `for test_file in scripts/test-*.mjs; do node "$test_file" || exit; done` — passed: all seven suites, 235/235 tests.
- `node --check scripts/miniplayer-state.js` and `node --check scripts/test-miniplayer-state.mjs` — passed.
- `cmp scripts/miniplayer-state.js assets/miniplayer-state.js` — passed; generated asset matches the source.
_Review generated 2026-08-15 20:20:00 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-15)

Both confirmed by reading the actual text.

1. **CONFIRMED — medium, documentation gap.** Verified: the plan's
   canonical `revokeLease()` function-by-function contract (the
   authoritative section a future implementer would read) described
   dropping the lease and calling `revokeLease()` but never mentioned the
   `myTabId` refresh requirement — that only appeared in the later
   historical residual-gap narrative, easy to miss if reading the contract
   section alone. Fixed by adding the refresh instruction directly to the
   canonical contract, with the same reasoning (a second rotation source
   the handshake's own wiring didn't originally anticipate).
2. **CONFIRMED — low, precision gap.** Verified: `revokeLease()`'s own
   comment said "`escalated:true` means TAB_ID_KEY was just rotated,"
   which is imprecise — both escalation branches return `escalated:true`
   even when the `rotateTabId()` fallback itself fails (`{ok:false,
   escalated:true}`, already covered by an existing test). The
   refresh-unconditionally-on-`escalated` guidance remains correct either
   way (a re-read via `peekTabId()` simply reflects whatever is actually
   there), but the comment's own justification was wrong. Fixed by
   clarifying `escalated:true` means rotation was *attempted*, `ok`
   distinguishes whether it landed.

No new code defects found this round — first genuinely clean pass on the
underlying logic, after four consecutive rounds each finding a real
behavioral bug in this immediate area. `scripts/test-miniplayer-state.mjs`
unchanged at 92/92 (documentation-only fixes). All 7 suites, 235/235
passing; `build.py --check`/`build.py` clean. Not yet committed.

---

## Full fenced-lease ownership subsystem review — 2026-08-15

1. **High — Rotating the tab ID does not invalidate captured leases, allowing a displaced owner to continue writing.**

   Evidence: both collision resolution and revocation escalation rotate `TAB_ID_KEY` ([scripts/miniplayer-state.js:466](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:466), [scripts/miniplayer-state.js:603](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:603)), but `hasValidLease()` checks only the revocation marker and envelope tuple—not whether `peekTabId(sessionStore)` still equals `lease.ownerId` ([scripts/miniplayer-state.js:649](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:649)). Consequently, `writeSession()` accepts the old lease after a successful rotation ([scripts/miniplayer-state.js:831](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:831)). A focused probe forced a revocation-marker failure, successfully rotated the ID, then confirmed `hasValidLease(oldLease) === true` and that a stale session write landed.

   This also exposes a plan overclaim: the exact `{ownerId, ownerEpoch}` tuple is stored in the envelope ([scripts/miniplayer-state.js:229](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:229)), despite the assertion that “the lease isn’t stored at all” ([player-consolidation-plan.md:2268](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2268)). Any tab can reconstruct that tuple; the current gate does not bind it to that tab’s session identity. Existing tests exercise stale epochs, rotation, and escalation separately, but never attempt an old write after rotation ([test-miniplayer-state.mjs:515](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:515), [test-miniplayer-state.mjs:648](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:648)).

   Why it matters: when a live owner loses the collision nonce tie-break, or `revokeLease()` escalates, an already-scheduled position/queue callback holding the previous lease can still overwrite durable state. This directly contradicts the plan’s claim that captured stale callbacks are structurally unable to write and that dropping the main lease variable fully protects the current document ([player-consolidation-plan.md:2382](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2382), [player-consolidation-plan.md:2434](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2434)).

   Suggested fix: make `hasValidLease()` fail closed unless `peekTabId(sessionStore) === lease.ownerId`, in addition to the existing epoch/envelope checks. Add regressions for collision rotation → captured old write, both revocation escalation triggers → captured old write, and a distinct tab attempting to use a lease copied from the envelope. Correct the plan’s “lease isn’t stored” and residual-gap claims.

2. **Medium — The prescribed revoke-then-tombstone sequence makes `tombstoneIfCurrent()` reject itself.**

   Evidence: successful `revokeLease()` records the lease epoch ([scripts/miniplayer-state.js:619](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:619)); `tombstoneIfCurrent()` then gates on `hasValidLease()` ([scripts/miniplayer-state.js:856](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:856)), which rejects that exact revoked epoch at [scripts/miniplayer-state.js:654](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:654). The module explicitly instructs callers to invoke the tombstone after revocation ([scripts/miniplayer-state.js:853](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:853)). A focused probe confirmed `{ok:true}` from revocation followed by `false` from tombstoning, with `ownerId`/`ownerEpoch` left intact. The tests cover each operation independently but never this documented sequence.

   Why it matters: the tombstone’s stated purpose—preventing passive observers from continuing to display stale ownership after an external non-module player takes over—cannot work on its normal path ([player-consolidation-plan.md:2393](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2393)). Durable state can therefore disagree with what has actually taken ownership.

   Suggested fix: give tombstoning a predicate that compares the captured owner tuple against the fresh envelope under the lock but does not reject solely because the same local epoch was revoked. Retain the second immediate pre-write comparison. Alternatively, tombstone before revocation and document/test that ordering. Add an end-to-end external-claim → revoke → tombstone regression.

3. **Medium — The collision handshake reports a rotation even when `rotateTabId()` failed, leaving both duplicated tabs able to restore ownership.**

   Evidence: `rotateTabId()` correctly returns `null` when persistence fails ([scripts/miniplayer-state.js:325](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:325)), but `resolveCollision()` ignores that return value, memoizes the nonce, and returns the tie-break decision as `rotated:true` ([scripts/miniplayer-state.js:466](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:466)). The caller consequently refreshes the same unchanged ID and treats the collision as resolved. A focused probe made only the loser’s `TAB_ID_KEY` write throw; both tabs retained the shared ID and both returned `restored`.

   The suite tests failed `rotateTabId()` only in isolation ([test-miniplayer-state.mjs:400](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:400)); every handshake test uses infallible storage ([test-miniplayer-state.mjs:1040](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:1040)). Thus the plan’s characterization of the unchanged handshake as “solid” is unsupported ([player-consolidation-plan.md:2290](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2290)), and the residual-gaps introduction claiming two independent write failures are always required is false ([player-consolidation-plan.md:2430](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2430)).

   Why it matters: one transient sessionStorage write failure preserves a duplicated identity and permits two documents to restore the same lease—the exact collision the handshake exists to prevent.

   Suggested fix: propagate rotation success separately from the tie-break decision. Do not mark the opposing nonce resolved when the losing side’s rotation fails; fail closed by disabling persistent ownership for that document if retry cannot converge. Add an end-to-end failed-rotation handshake test asserting at most one tab can restore.

4. **Low — `establishTabId()` treats an initial read failure as absence and overwrites a valid carried identity.**

   Evidence: the initial `getItem()` exception is collapsed to `existing = null`, after which a new ID is generated and persisted ([scripts/miniplayer-state.js:292](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:292)). The test explicitly blesses this behavior as “tolerates a throwing pre-check read” ([test-miniplayer-state.mjs:368](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:368)). A focused probe began with a valid carried ID, threw only on the first read, and confirmed it was replaced.

   Why it matters: a one-off read failure during same-tab navigation destroys ownership continuity and makes the subsequent envelope appear `not-mine`. This contradicts the plan’s idempotence claim when an identity exists ([player-consolidation-plan.md:2280](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2280)) and applies the exact read-failure-as-absence policy that `readEnvelope()` was redesigned to avoid.

   Suggested fix: return `null` immediately when the initial identity read throws; do not write a replacement ID. Change the test to assert zero `setItem()` attempts and preservation of the existing value.

**Verification during this review**

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks, no orphan song pages.
- All seven executable `node scripts/test-*.mjs` suites — passed, 235/235 total; `test-miniplayer-state.mjs` passed 92/92.
- `python3 scripts/verify_markup.py` — passed: 1,427 items across 166 generated show/song pages.
- `node --check scripts/miniplayer-state.js`, `node --check scripts/test-miniplayer-state.mjs`, and `node --check scripts/browser_check.mjs` — passed.
- `cmp scripts/miniplayer-state.js assets/miniplayer-state.js` — passed.
- Focused Node interleaving probes — reproduced all four findings, including stale writes after successful escalation, the self-rejecting tombstone sequence, dual restoration after failed collision rotation, and identity replacement after a transient read failure.
- `git diff --exit-code bf59f10 -- …` and `git status --short` — clean; reviewed files match commit `bf59f10`.
_Review generated 2026-08-15 20:26:16 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-15)

All four findings independently reproduced against the actual code before
recording this disposition. This broader, non-narrowly-scoped round
caught things the last several increasingly-narrow rounds missed — exactly
the risk flagged when narrowing scope: "review the branch again" was
avoided in favor of narrow framings for speed, and it let a real
interaction bug (finding 3, and the round-4 caller-contract gap before it)
go unnoticed by rounds looking only at the immediately-preceding patch.

1. **CONFIRMED — high.** Reproduced exactly: captured a valid lease,
   rotated THIS document's own `TAB_ID_KEY` (modeling a lost collision
   tie-break or a `revokeLease()` escalation) without touching the
   envelope, then confirmed `hasValidLease(the old lease)` still returned
   `true` and `writeSession()` with that stale lease still landed. Root
   cause confirmed directly: `hasValidLease()` compared the lease against
   the envelope but never against THIS document's own current
   `peekTabId()`. Also confirmed the plan's "the lease isn't stored at
   all" wording was imprecise — the envelope legitimately stores
   `(ownerId, ownerEpoch)` (that's how `restoreLease()` re-derives a
   lease at all); the real property that matters is no SEPARATE credential
   needing to be kept in sync, not that no tuple is ever persisted
   anywhere.
2. **CONFIRMED — medium.** Reproduced exactly: `revokeLease()` then
   `tombstoneIfCurrent()` with the same lease — `{ok:true}` from
   revocation, `false` from tombstoning, envelope untouched. Root cause
   confirmed directly: `tombstoneIfCurrent()` gated on `hasValidLease()`,
   which itself gates on `isEpochRevoked()` — so the exact epoch
   `revokeLease()` just recorded as revoked immediately fails
   `tombstoneIfCurrent()`'s own gate, on the function's own documented
   normal-use sequence.
3. **CONFIRMED — medium.** Reproduced exactly: forced the losing side's
   `rotateTabId()` write to fail during collision resolution — the loser
   kept its original (still-shared) id, but `handleIncomingProbe()` still
   reported `rotated:true`. Both sides then independently passed
   `restoreLease()` as `'restored'`. Root cause confirmed directly:
   `resolveCollision()` called `rotateTabId(sessionStore)` and discarded
   its return value entirely, never checking for the `null`-on-failure
   result this same redesign gave `rotateTabId()`. This is squarely a
   consequence of THIS redesign (the old pre-redesign `rotateTabId()`
   never returned `null`, always fabricating a value) breaking an
   assumption `resolveCollision()` — otherwise legitimately out of scope —
   was written under; not a re-litigation of the settled nonce-comparison
   logic itself.
4. **CONFIRMED — low.** Reproduced exactly: seeded a valid carried
   identity, made only the FIRST `getItem()` call throw, confirmed
   `establishTabId()` replaced the valid identity with a freshly minted
   one. Root cause confirmed directly: the existence pre-check collapsed a
   read failure to "nothing exists," applying exactly the
   read-failure-as-absence policy `readEnvelope()` was redesigned earlier
   today to avoid, just missed in this one other spot.

**Fixed, all four, same session**, each by removing the shape rather than
adding a narrow patch:
1. `hasValidLease()` refactored around a new shared predicate,
   `hasMatchingEnvelopeTuple()`, which now also requires
   `peekTabId(sessionStore) === lease.ownerId` before ever consulting the
   envelope.
2. `tombstoneIfCurrent()` switched from `hasValidLease()` to
   `hasMatchingEnvelopeTuple()` directly — deliberately excluding the
   revocation check, since tombstoning is purely cosmetic and its safety
   comes entirely from the tuple match, with revocation never part of that
   argument in the first place.
3. `resolveCollision()`/`handleIncomingProbe()`/`handleIncomingProbeReply()`
   return shape gains `failed`; `rotated` is only ever `true` when the
   write is verified to have landed. Documented caller contract: on
   `failed:true`, disable persistent ownership for that document's entire
   lifetime (same remedy as `establishTabId()` returning `null`) — the
   collision genuinely could not be resolved, and no safe continuation
   exists. This is the one fix that touches code inside the
   nominally-"out of scope" tab-collision handshake — justified because
   the bug is in how that code handles a CHANGED dependency contract
   (`rotateTabId()`'s new `null`-on-failure return), not in the
   nonce-comparison decision logic itself, which is untouched.
4. `establishTabId()`'s initial existence check now returns `null`
   immediately on a read failure, rather than proceeding to mint and
   persist a replacement.

`scripts/test-miniplayer-state.mjs`: 97/97 passing (up from 92 — 1
rewritten to match the corrected fail-closed behavior, 6 new). All 7
suites, 240/240 passing; `build.py --check`/`build.py` clean. Not yet
committed.

**Given a broader review round found four real bugs immediately after a
narrowly-scoped round reported clean, do not read that prior clean round
as having validated anything beyond its own narrow scope.** Another
`/review-step` round — broad again, not narrowed to just this batch's
diff — is warranted before treating the ownership subsystem as settled.

---

## Second full fenced-lease ownership subsystem review — 2026-08-15

1. **Medium — A successful collision rotation invalidates an active owner’s lease without requiring the caller to stop or relinquish visible playback.**

   Evidence: the documented listener only refreshes `myTabId` after `rotated:true`; it does not clear the lease or change controller state ([scripts/miniplayer-state.js:393](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:393)). The module nevertheless claims the tie-break matters only between idle/passive tabs ([scripts/miniplayer-state.js:369](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:369)), even though any live owner can receive a newly duplicated tab’s probe. Rotation immediately makes its captured lease invalid through `peekTabId()` ([scripts/miniplayer-state.js:704](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:704)). The test explicitly permits a durable owner to lose but never models an actively playing controller or lease lifecycle ([scripts/test-miniplayer-state.mjs:1203](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:1203)).

   A focused probe persisted `playing:true`, made the incumbent lose the nonce tie-break, and produced `oldLeaseValid:false` while the envelope still said `playing:true` and the clone returned `restored`. Under the documented future wiring, the incumbent’s audio can continue while all its saves silently fail and the clone becomes the persistent owner.

   Why it matters: playback visible to the user can diverge from durable ownership and a second document may resume the same session. This zero-failure lifecycle case is absent from the residual-gaps list.

   Suggested fix: make `rotated:true` a full caller contract, not merely an ID-cache update. If the document holds a lease, synchronously drop it and pause/demote the controller before allowing the winning document to restore, or redesign the late-join protocol to preserve an actively playing incumbent. Add an integration test with a playing incumbent, duplicated newcomer, successful incumbent rotation, and assertions over both lease and controller state.

2. **Medium — The collision integration harness still ignores `failed`, so the suite does not test the newly required fail-closed behavior.**

   Evidence: `wireDocument()` destructures only `reply`/`rotated` from both handlers and has no `ownershipDisabled` state ([scripts/test-miniplayer-state.mjs:1092](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:1092)). The test named “two colliding tabs never both restore” bypasses that harness and actually asserts that the failed side still returns `restored` ([scripts/test-miniplayer-state.mjs:1315](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:1315)). It therefore documents the hazard without verifying the caller contract that supposedly closes it. Only failure through `handleIncomingProbe()` is tested; reply-side failure is not integrated.

   This is especially brittle because `resolveCollision()` memoizes the opposing nonce before attempting rotation ([scripts/miniplayer-state.js:512](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:512)). A focused probe returned `failed:true` on the first failed rotation but `{rotated:false, failed:false}` for the repeated message. Ignoring the first result permanently loses the failure signal.

   Why it matters: the plan records the failed-rotation bug as closed and cites the 97-test suite ([plans/player-consolidation/player-consolidation-plan.md:2593](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2593)), but the separately maintained integration fixture still demonstrates the unsafe wiring future boot code could copy.

   Suggested fix: add `ownershipDisabled` to `wireDocument()`, set it permanently on either handler’s `failed:true`, and prevent restore/claim/write operations when set. Rewrite the failed-rotation test to run through that harness and assert exactly one enabled document may restore. Cover failures reached through both probe and reply processing.

3. **Medium — `revokeLease()` reports success without verifying the epoch marker, contradicting the subsystem’s own silent-write failure model.**

   Evidence: the suite explicitly defines a storage implementation whose `setItem()` succeeds but silently drops the write ([scripts/test-miniplayer-state.mjs:102](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:102)); `establishTabId()` and `rotateTabId()` read back writes for exactly this reason. In contrast, `revokeLease()` returns `{ok:true, escalated:false}` immediately after `setItem()` without reading the marker back ([scripts/miniplayer-state.js:663](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:663)).

   A focused probe silently dropped only `REVOKED_EPOCH_KEY`; `revokeLease()` reported success, the marker remained absent, and the next `restoreLease()` returned `restored`. That contradicts the plan’s claim that `ok:false` requires both marker and fallback failure ([plans/player-consolidation/player-consolidation-plan.md:2344](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2344)) and its residual claim that wrongful future restoration requires two independent failures ([plans/player-consolidation/player-consolidation-plan.md:2484](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2484)).

   Why it matters: under the failure behavior the module already claims to defend against, one undetected write failure re-enables a genuinely revoked lease after navigation.

   Suggested fix: read back `REVOKED_EPOCH_KEY` after writing it. If the value is not the requested epoch or the read throws, treat the write as unverified and invoke `rotateTabId()`. Add the silent-drop regression through `restoreLease()`.

4. **Low — Revocation escalation makes the documented cosmetic tombstone path impossible, and the residual list omits that limitation.**

   Evidence: marker-write failure successfully rotates the tab ID ([scripts/miniplayer-state.js:663](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:663)); `hasMatchingEnvelopeTuple()` then rejects the old lease because its owner ID no longer matches `peekTabId()` ([scripts/miniplayer-state.js:704](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:704)); and `tombstoneIfCurrent()` uses that predicate ([scripts/miniplayer-state.js:928](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:928)). The revoke-then-tombstone regression covers only the ordinary marker-write success path ([scripts/test-miniplayer-state.mjs:1059](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:1059)).

   A focused marker-write-failure probe produced `{ok:true, escalated:true}`, followed by `tombstoneIfCurrent() === false`; the envelope continued naming the abandoned old ID. This undercuts the plan’s cosmetic-cleanup description ([plans/player-consolidation/player-consolidation-plan.md:2437](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2437)).

   Why it matters: passive observers can continue displaying stale ownership after the external player took over. Correctness remains fenced, so severity is low, but the documented purpose is not met on either escalation trigger.

   Suggested fix: do not simply remove the identity check globally, because collision-driven rotations need it. Either document this as a residual cosmetic limitation, or introduce a dedicated external-claim cleanup path that compares the fresh envelope tuple under the ownership lock independently of the subsequent revocation rotation. Test both escalation triggers.

**Verification during this review**

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks, no orphan song pages.
- Seven executable `node scripts/test-*.mjs` suites — passed, 240/240 total; `test-miniplayer-state.mjs` passed 97/97.
- `python3 scripts/verify_markup.py` — passed: 1,427 items across 166 generated pages.
- `python3 scripts/verify_markup.py --check-allowlist-coverage` — passed: all 30 public shows covered.
- Syntax checks, `cmp scripts/miniplayer-state.js assets/miniplayer-state.js`, and `git diff --check` — passed.
- Focused Node probes reproduced the silent revocation loss, escalation-blocked tombstone, failed-result memoization, and active-owner rotation divergence described above.
_Review generated 2026-08-15 20:43:57 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-15)

All four findings independently reproduced/checked against the actual code
before recording this disposition.

1. **CONFIRMED — medium, documentation/caller-contract gap, not a storage-
   correctness bug.** Verified: the module already correctly makes a
   post-rotation stale write structurally impossible (hasValidLease()'s
   peekTabId() check, fixed in the previous round), but nothing in the
   documented boot pseudocode told a caller to stop/pause actively playing
   audio on `rotated:true` — only to refresh its cached id. Also verified
   the section comment's claim that the tie-break "only matters between two
   idle/passive tabs" was genuinely wrong: a live, actively-playing owner
   can receive a newly-duplicated tab's probe and lose exactly the same way
   an idle one can. **Fixed** by correcting that claim and extending the
   documented CALLER CONTRACT: on `rotated:true`, drop the in-memory lease
   and pause/relinquish playback via the caller's own playback-layer wiring
   (deliberately not reaching into controller state from this module,
   consistent with its "pure, DOM-free" design). No code change — this
   module has no PlaybackController dependency to act through; storage-
   level safety was already correct.
2. **CONFIRMED — medium, test-quality gap in this session's own prior
   fix.** Verified directly: `wireDocument()` (the integration harness)
   destructured only `reply`/`rotated`, never `failed`; the "two colliding
   tabs never both restore" test's own assertion proved the opposite of
   its name (that Y *can* still restore), documenting the hazard without
   ever proving a correctly-wired caller avoids it. **Fixed**: `wireDocument()`
   now tracks `ref.disabled` on `failed:true`; the old test renamed to
   honestly describe what it proves (the hazard); a new test wired through
   the corrected harness proves a caller that actually follows the
   documented contract (check `disabled` before calling `restoreLease()`)
   never reaches the dual-restoration outcome.
3. **CONFIRMED — medium.** Reproduced exactly: a `setItem()` that silently
   drops the write (the same `silentlyDroppingStorage()` shape this suite
   already models elsewhere) made `revokeLease()` report `{ok:true}` with
   nothing actually recorded, and a subsequent `restoreLease()` wrongly
   resolved `'restored'`. Root cause confirmed directly: unlike
   `establishTabId()`/`rotateTabId()`, `revokeLease()` never read back its
   own write. **Fixed** by adding the identical read-back-and-verify step;
   on a confirmed-unpersisted write, escalates via `rotateTabId()` exactly
   like a thrown write already does.
4. **CONFIRMED — low — but the suggested "remove the identity check"
   fix was investigated and explicitly REJECTED, not merely deferred.**
   Reproduced the reported case directly (tombstone fails immediately
   after a `revokeLease()` escalation). Before accepting the suggested
   fix, reproduced the SPECIFIC hazard it would reopen: a tab that lost a
   collision tie-break holds a stale lease whose tuple can still
   legitimately describe a *different*, still-live document's ongoing
   ownership (collision resolution never touches the shared envelope) —
   removing `hasMatchingEnvelopeTuple()`'s identity check to fix (4) would
   let that loser wrongly clear the *winner's* completely legitimate
   state, reproduced directly and clearly worse (cross-document
   interference vs. a cosmetic display staying stale). **Disposition:
   left as an honest, narrowly-scoped residual gap** — the review's own
   suggested fix explicitly offered this as an acceptable resolution.
   Documented in `tombstoneIfCurrent()`'s own comment with the specific
   scenario and the specific rejected alternative; two new tests added,
   one proving the gap exists (tombstone fails after escalation) and one
   proving the protection it exists to preserve (a collision loser's
   stale lease can never tombstone a different document's legitimate
   ownership).

`scripts/test-miniplayer-state.mjs`: 100/100 passing (up from 97 — 2
rewritten, 5 new). All 7 suites, 243/243 passing; `build.py --check`/
`build.py` clean. Not yet committed.

**Eighth review round today on this subsystem** (five narrow + two broad
+ this disposition's verification pass), seven of which found something
real. The two broad, non-narrowly-scoped rounds each found multiple real
bugs immediately after narrower preceding rounds reported clean — the
clearest evidence yet in this project's history that scope-narrowing
review rounds trade completeness for speed. Another broad round is
warranted before treating this subsystem as settled; given the pattern,
a clean broad round should still be read as encouraging, not conclusive.

---

## Full fenced-lease ownership subsystem review — 2026-08-15

1. **High — Every shared-envelope write can report success without verifying that the write landed.**

   Evidence: `writeEnvelope()` returns `true` immediately after `setItem()` and performs no read-back ([scripts/miniplayer-state.js:262](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:262)). `claimOwnership()` consequently returns `{ok:true, lease}` ([scripts/miniplayer-state.js:907](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:907)), while `writeSession()` and `tombstoneIfCurrent()` return `true` ([scripts/miniplayer-state.js:940](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:940), [scripts/miniplayer-state.js:992](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:992)) solely because `setItem()` did not throw.

   This contradicts the subsystem’s own explicit silent-drop failure model ([scripts/test-miniplayer-state.mjs:102](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:102)). That fixture is applied to tab-ID writes, but never to `writeEnvelope()` or any of its three callers. A focused probe made `localStorage.setItem()` silently drop writes: `claimOwnership()` returned `ok:true` while `readEnvelope()` remained `absent`; after a healthy claim, both `writeSession()` and `tombstoneIfCurrent()` returned `true` while the durable envelope stayed byte-for-byte unchanged.

   Why it matters: a caller can start playback believing it acquired durable ownership, silently lose queue/position saves, or believe ownership was tombstoned when it was not. Only one failure is required, contradicting the plan’s claim that remaining gaps require two independent write failures ([player-consolidation-plan.md:2237](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2237)) and that a failed claim returns `{ok:false}` ([player-consolidation-plan.md:2433](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2433)).

   Suggested fix: make `writeEnvelope()` serialize once, call `setItem()`, then read the raw value back under the same ownership lock and require exact equality before reporting success. Return a reason distinguishing thrown writes, unavailable read-back, and mismatched read-back. Add silent-drop regressions for `writeEnvelope()`, `claimOwnership()`, `writeSession()`, and `tombstoneIfCurrent()`.

2. **Medium — `restoreLease()` can return a stale lease as “restored” after another tab has already claimed ownership.**

   Evidence: `restoreLease()` reads the envelope once and immediately returns its tuple without a lock or final validation ([scripts/miniplayer-state.js:790](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:790)). The ownership lock wraps claims and writes, but not restoration. The integration test performs the claim and handshake strictly before restoration and never interleaves a claim during the read ([scripts/test-miniplayer-state.mjs:1172](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:1172)).

   A focused interleaving captured A’s envelope read, let B’s real `claimOwnership()` land before that read returned, and then completed A’s `restoreLease()`. A returned `status:'restored'` with A’s lease while durable storage already named B. This directly contradicts the plan’s “safe to resume” characterization ([player-consolidation-plan.md:2424](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2424)).

   Why it matters: later gated writes reject the stale lease, but a boot caller may already restore visible state or resume audio from the stale snapshot, diverging from durable ownership and potentially overlapping another tab’s playback.

   Suggested fix: treat restoration as a candidate snapshot, not an unconditional resume grant. Run its read/validation under the ownership lock, install external-claim/collision listeners before beginning restoration, and use a caller-owned ownership generation so any claim received during or after restoration invalidates the result before state or playback is applied. Add an interleaving regression where B claims between A’s envelope read and returned result.

3. **Medium — Higher-level APIs still collapse storage failures into ordinary negative ownership results.**

   Evidence: `peekTabId()` converts a throwing `sessionStorage` read to `null` ([scripts/miniplayer-state.js:323](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:323)); `restoreLease()` then reports normal `no-identity` ([scripts/miniplayer-state.js:790](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:790)), and `claimOwnership()` reports `no-identity` ([scripts/miniplayer-state.js:896](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:896)). Likewise, `hasMatchingEnvelopeTuple()` converts both an absent envelope and an unavailable read to `false` ([scripts/miniplayer-state.js:749](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:749)), causing `writeSession()` to return the same `false` for storage failure, revocation, stale ownership, and no lock. The tests explicitly equate unavailable and absent reads at this layer ([scripts/test-miniplayer-state.mjs:641](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:641), [scripts/test-miniplayer-state.mjs:646](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:646)).

   Why it matters: these paths fail closed, but a future caller cannot distinguish ownership loss from a storage outage and therefore cannot choose correct retry, disablement, logging, or user-status behavior. The plan’s statement that genuine read failures are never mistaken for absence is only true of `readEnvelope()`, not the subsystem’s public operations ([player-consolidation-plan.md:2218](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2218)).

   Suggested fix: introduce tri-state tab-ID and lease checks, such as `valid`, `stale`, and `unavailable`, and return structured results from `writeSession()`/`tombstoneIfCurrent()` with explicit reasons including `no-lock`, `read-unavailable`, `revoked`, `stale`, and `write-failed`.

4. **Medium — The failed-collision “end-to-end” test still proves only a test-owned latch, not enforceable caller behavior.**

   Evidence: the module explicitly has no real consumer yet ([scripts/miniplayer-state.js:28](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:28)). `wireDocument()` merely stores `failed` in `ref.disabled`; it does not own or guard restore/claim/write operations, and it still does not model the required lease drop or playback relinquishment on `rotated:true` ([scripts/test-miniplayer-state.mjs:1154](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:1154)). The purported enforcement assertion conditionally avoids calling `restoreLease()` with `yRef.disabled ? null : ...`, then asserts that self-produced `null` ([scripts/test-miniplayer-state.mjs:1440](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:1440)). Thus the test would remain green if the future boot implementation ignored the latch entirely.

   Why it matters: the underlying module still permits both duplicated tabs to return `restored` after failed rotation, as the adjacent hazard test demonstrates. The plan records the harness gap as fixed ([player-consolidation-plan.md:2104](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2104)), but enforcement remains only pseudocode.

   Suggested fix: create a small DOM-free ownership coordinator that owns `disabled`, current lease, collision handling, restore/claim/write gating, and the playback-relinquish callback. Exercise that real coordinator in the collision tests. Until such a consumer exists, describe this behavior as an unverified caller contract rather than an end-to-end guarantee.

5. **Low — The plan’s summary retains two claims that its later detailed section already corrects.**

   Evidence: the summary says the lease is “never persisted” and that both `writeSession()` and `tombstoneIfCurrent()` gate on `hasValidLease()` ([player-consolidation-plan.md:2193](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2193), [player-consolidation-plan.md:2203](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2203)). In reality, the tuple is persisted inside the envelope ([scripts/miniplayer-state.js:182](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:182)), and tombstoning deliberately uses the tuple-only predicate ([scripts/miniplayer-state.js:985](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:985)). The later plan text acknowledges both corrections.

   Why it matters: an implementing agent reading the summary can restore the exact cross-store misconception already found in prior reviews or incorrectly add revocation back to the tombstone gate.

   Suggested fix: say “no separately persisted fencing credential” and describe `writeSession()` as using `hasValidLease()` while `tombstoneIfCurrent()` uses `hasMatchingEnvelopeTuple()`.

**Verification during this review**

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks, no orphan song pages.
- All seven executable `node scripts/test-*.mjs` suites — passed, 243/243 total; `test-miniplayer-state.mjs` passed 100/100. The playlist suite emitted `MaxListenersExceededWarning`s but did not fail.
- `python3 scripts/verify_markup.py` and `--check-allowlist-coverage` — passed: 1,427 items across 166 pages; all 30 public shows covered.
- Syntax checks, `git diff --check`, and `cmp scripts/miniplayer-state.js assets/miniplayer-state.js` — passed.
- Focused Node interleaving/failure probes — reproduced false-success envelope writes, stale restoration after a concurrent claim, and storage-read failures collapsing to normal negative results.
_Review generated 2026-08-15 21:10:48 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-15)

1. **High — `writeEnvelope()` never reads back its own write — CONFIRMED, real bug, not yet fixed.**
   Reproduced directly: a silently-dropping `localStorage` (setItem() never
   throws, never mutates) makes `claimOwnership()` return `{ok:true}` while
   `readEnvelope()` still reports `'absent'`; on an already-healthy claim,
   both `writeSession()` and `tombstoneIfCurrent()` return `true` while the
   durable envelope is byte-for-byte unchanged. This is a genuine
   inconsistency against the module's own established pattern:
   `establishTabId()` and `revokeLease()` were BOTH already fixed earlier
   this session (rounds 4 and 6/7) to read back their own writes for
   exactly this reason, but `writeEnvelope()` — the actual commit path for
   `claimOwnership()`/`writeSession()`/`tombstoneIfCurrent()` — never got
   the same treatment. Needs fixing before this stage is settled: make
   `writeEnvelope()` read back the raw stored value and compare for exact
   equality before reporting success, matching `establishTabId()`'s and
   `revokeLease()`'s existing shape.

2. **Medium — `restoreLease()`'s "safe to resume" characterization overclaims — CONFIRMED as a documentation gap, DECLINING the code-level fix.**
   `restoreLease()` is a plain synchronous read with no lock (by design —
   "Pure read, no lock needed" per the plan) and returns `'restored'` from
   a snapshot that a concurrent claim by another tab can supersede a
   moment later; the plan's summary text calls this state "safe to
   resume" with no caveat. The characterization is real and the doc text
   should be softened — but the suggested fix (run restoration under the
   lock, wire external-claim/collision listeners, add a caller-owned
   generation counter to invalidate a stale restoration after the fact)
   requires a real boot-time coordinator, and this module explicitly has
   no consumer yet (Stage 3a-foundation is scoped as "unit-tested with no
   UI consuming them yet" per the plan's own stage-shape text). No
   correctness property is actually at risk: any subsequent WRITE
   attempted under a superseded restored lease is still correctly
   rejected by `hasValidLease()`'s fresh-envelope re-check, same mechanism
   that already closes the analogous round-5 bug. Treating this the same
   way the round-4 handshake caller-contract gap was treated: a
   documentation fix now (reword "safe to resume" to make clear it is a
   candidate a future caller must not treat as final without its own
   collision-listener wiring), full fix deferred to whichever stage
   actually builds that boot-time coordinator.

3. **Medium — `peekTabId()` collapsing a read failure to `null` — DECLINED, working as designed for this module's current scope.**
   Confirmed technically true (a transient `sessionStorage` read failure
   inside `peekTabId()` becomes indistinguishable from "no identity" at
   every layer built on it), but every path this feeds is already
   fail-closed: `hasMatchingEnvelopeTuple()` rejects, `restoreLease()`
   reports `'no-identity'`, `claimOwnership()` refuses — none of them ever
   *incorrectly succeeds* because of this collapse, which is the
   correctness property this module actually needs to hold. Checked the
   two specific plan citations the finding names
   (player-consolidation-plan.md:2218-2219 and :2332-2333) — both already
   scope the tri-state guarantee explicitly to `readEnvelope()` by name,
   not to "the subsystem's public operations" generally, so the claimed
   plan overclaim is not actually present in the text as written. This is
   a legitimate future UX/observability request (a real boot caller might
   someday want to show "storage unavailable" differently from "someone
   else is playing"), not a correctness bug — declining a tri-state
   refactor of the whole public surface for a module with no consumer yet
   that would need to act on the distinction.

4. **Medium — the "correctly-wired caller" test is tautological — CONFIRMED, DECLINING the suggested fix (build a real coordinator), ACCEPTING a test-honesty fix.**
   Verified directly: the test's key assertion is
   `yRef.disabled ? null : restoreLease(...).status` — when `disabled` is
   true this trivially evaluates to `null` regardless of what
   `restoreLease()` would have returned, so the test cannot fail even if
   a real future implementation ignored the latch entirely, exactly as
   claimed. This is the same underlying gap already accepted and
   documented in the "Second full fenced-lease ownership subsystem
   review" disposition (round 7, finding on the caller-contract test) —
   this round's finding sharpens the same point with a cleaner
   reproduction rather than surfacing a new one. Building the suggested
   real DOM-free ownership coordinator now would pull Stage 3a-canary/3b
   work forward into a stage explicitly scoped as consumer-less; declining
   that. Accepting the smaller fix: reword the test's name/assertion
   comment so it honestly claims to prove the latch mechanism plus a
   caller pattern that follows the contract, not "a caller correctly
   following the documented contract" (implying a real one exists).

5. **Low — plan summary retains two claims already corrected later in the same document — CONFIRMED, easy fix.**
   Verified both citations: player-consolidation-plan.md:2192-2193 still
   says the lease is "never persisted" and :2203-2204 still says
   `tombstoneIfCurrent()` gates on `hasValidLease()` — both already
   corrected further down the same section (:2333-2335 clarifies "never
   persisted" means no separately-synchronized credential, not literal
   absence from storage; :2356+ area documents `tombstoneIfCurrent()`
   using `hasMatchingEnvelopeTuple()` directly). Summary text should be
   updated to match the corrected detail section so an implementing agent
   skimming only the summary doesn't reintroduce either misconception.

**Net assessment: this round is NOT clean.** One High-severity, genuine,
in-scope correctness gap (finding 1) plus two documentation-accuracy fixes
(findings 2 summary wording, 5) and one test-honesty fix (finding 4) are
real and worth doing before the next broad round. Findings 3's code-level
suggestion and 2/4's full-coordinator suggestions are declined as
out-of-scope for a consumer-less module. Reported to Rene; awaiting
explicit go-ahead before implementing anything above — no source file has
been touched during this review.

---

## Full fenced-lease ownership subsystem review — 2026-08-15

1. **Medium — Lease epochs and rotated tab IDs can repeat, causing operations to report successful fencing without changing the fence.**

   Evidence: both identifiers use `${Date.now()}-${Math.random()}` without checking the result against the value being replaced ([scripts/miniplayer-state.js:298](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:298), [scripts/miniplayer-state.js:357](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:357), [scripts/miniplayer-state.js:907](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:907)). `rotateTabId()` verifies only that its candidate was persisted, so it returns success even when that candidate equals the existing ID; `resolveCollision()` then reports `rotated:true` although the duplicated identity remains unresolved ([scripts/miniplayer-state.js:558](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:558)). Likewise, `claimOwnership()` accepts a repeated `ownerEpoch`, making an earlier lease indistinguishable from the purportedly newer claim ([scripts/miniplayer-state.js:933](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:933)).

   A focused probe fixed `Date.now()` and `Math.random()`: `rotateTabId()` returned the unchanged ID as success; two consecutive claims minted the identical epoch; and `writeSession()` accepted a delayed write under the first claim after the second claim. Existing tests merely call the real RNG and assert inequality, so they cannot exercise reuse ([scripts/test-miniplayer-state.mjs:422](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:422), [scripts/test-miniplayer-state.mjs:853](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:853)).

   Why it matters: epoch reuse reopens the central same-tab stale-write bug this redesign claims is structurally impossible, while unchanged “rotation” can leave two duplicated documents able to restore the same lease. It also contradicts the plan’s claims that a fresh epoch is never equal to an earlier one and that residual correctness gaps require two write failures ([player-consolidation-plan.md:2211](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2211), [player-consolidation-plan.md:2218](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2218), [player-consolidation-plan.md:2503](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2503)).

   Suggested fix: generate IDs/epochs from `crypto.getRandomValues()` or `crypto.randomUUID()`, but still compare against the value being superseded and retry until different. `rotateTabId()` should fail closed if it cannot read the prior ID or produce and verify a distinct replacement. `claimOwnership()` should require `ownerEpoch !== existing.ownerEpoch`. Add deterministic tests with injected/stubbed entropy that first repeats the old value.

2. **Low — The prior `restoreLease()` documentation correction is incomplete; the plan still calls the result “safe to resume.”**

   Evidence: the detailed function contract still describes `{status:'restored'}` as “safe to resume” ([player-consolidation-plan.md:2428](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2428)), although the implementation and later plan text correctly characterize it as an unlocked candidate snapshot that may already have been superseded ([scripts/miniplayer-state.js:804](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:804), [player-consolidation-plan.md:2641](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2641)).

   Why it matters: a future coordinator following the function-by-function contract could resume visible playback before installing the collision/external-claim invalidation required to trust the candidate.

   Suggested fix: replace “safe to resume” with “candidate lease; a coordinator must install invalidation listeners before applying visible/audio state,” matching residual-gap item 9.

3. **Low — Two nonce tests presented as deterministic are probabilistic and can fail on valid random output.**

   Evidence: one test samples only 30 real random pairs and requires an arbitrary 5–25 split; the next fails whenever two valid nonces happen to share more than two prefix characters ([scripts/test-miniplayer-state.mjs:1309](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:1309), [scripts/test-miniplayer-state.mjs:1321](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:1321)). For the current two-character-per-byte encoding, the prefix assertion has roughly a 1-in-1,800 chance of rejecting valid independent output.

   Why it matters: the project describes these Node suites as deterministic, but repeated healthy runs can fail randomly. Statistical sampling also does not reliably detect an orderable prefix regression.

   Suggested fix: inject or stub the entropy source with fixed byte sequences. Assert exact nonce encoding and demonstrate that changing `Date.now()` does not affect output; retain the fixed-string symmetry tests for the tie-break itself.

**Verification during this review**

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks, no orphan song pages.
- All `node scripts/test-*.mjs` files — seven executable suites passed, 248/248 total; `test-playlist-state.mjs` emitted existing `MaxListenersExceededWarning`s.
- `python3 scripts/verify_markup.py` and `python3 scripts/verify_markup.py --check-allowlist-coverage` — passed: 1,427 items across 166 pages; all 30 public shows covered.
- Syntax checks, `cmp scripts/miniplayer-state.js assets/miniplayer-state.js`, and `git diff --check` — passed.
- Focused fixed-entropy probe — reproduced unchanged successful tab rotation, repeated owner epochs, and a stale first-lease write landing after a second claim.
_Review generated 2026-08-15 21:30:17 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-15)

1. **Medium — Lease epochs/rotated tab IDs never checked against the value they're replacing — CONFIRMED via direct reproduction, real bug, not yet fixed.**
   Pinned `Date.now()`/`Math.random()` to fixed values (models degraded or
   predictable entropy — e.g. a fingerprinting-resistance browser patch, a
   broken PRNG, or simply the pathological case) and reproduced all three
   claims directly: `rotateTabId()` returned the SAME id as before while
   reporting success (a genuine collision would be reported resolved while
   remaining completely unresolved); two consecutive `claimOwnership()`
   calls minted the identical `ownerEpoch`; and, most importantly, a write
   issued under the FIRST claim's lease then landed successfully via
   `writeSession()` AFTER the second claim — this is exactly the round-5
   bug class ("a delayed write issued under a superseded lease
   structurally unable to land") this entire redesign exists to close,
   reopened under degraded entropy. Real, in-scope, worth fixing: this is
   the same underlying principle as every write-verification fix already
   applied this session (verify the actual invariant holds, don't trust
   the mechanism not to fail) — just applied to entropy instead of
   storage. Proposed fix: `rotateTabId()` reads the existing id first and
   requires its candidate to differ, retrying (small bounded loop) before
   failing closed; `claimOwnership()` requires the freshly minted
   `ownerEpoch` to differ from the existing envelope's, same retry
   pattern. Add deterministic tests with pinned/injected entropy proving
   both paths detect and recover from a first-draw collision.

2. **Low — `restoreLease()`'s "safe to resume" wording still present at one location I missed last round — CONFIRMED, easy fix.**
   Verified: player-consolidation-plan.md:2434 (the function-by-function
   contract description of `restoreLease()`) still reads "safe to resume"
   — I fixed the section's summary paragraph and the code comment in the
   previous round's disposition but missed this specific, separate
   location. Same correction applies here.

3. **Low — Two nonce tests sample real randomness despite the suite's own "deterministic" documentation — CONFIRMED, real flake risk, fixable.**
   Verified both tests directly: `generateNonce() output is NOT biased by
   generation order` (scripts/test-miniplayer-state.mjs, 30 real trials,
   asserts a 5–25 split) and `generateNonce() output has no shared prefix
   across calls` (asserts a real pair's common prefix length ≤ 2) both
   call the real entropy source rather than a fixed/injected one, despite
   this test file's own header comment describing itself as
   "Deterministic tests for miniplayer-state.js." The prefix test's
   rejection probability on valid independent output is small (~1-in-1800
   for the current two-characters-per-byte encoding) but nonzero, and
   sampling doesn't reliably catch a real ordering regression anyway.
   Real, low-severity, worth fixing: rewrite to inject/stub the entropy
   source with fixed byte sequences and assert exact nonce encoding,
   keeping the existing fixed-string symmetry tests for the tie-break
   logic itself unchanged.

**Net assessment: this round is NOT clean either.** One real, in-scope
correctness gap (finding 1, same underlying principle as findings already
fixed this session, just applied to entropy rather than storage) plus two
low-severity, easy documentation/test fixes (2, 3). Reported to Rene;
awaiting explicit go-ahead before implementing anything above — no source
file has been touched during this review.

---

## Fenced-lease ownership subsystem review — 2026-08-15

1. **Medium — `rotateTabId()` can report a successful rotation without changing the ID when its initial read fails.**

   Evidence: a failed pre-write `getItem()` is collapsed to `existing = null`, after which `generateDistinctFrom()` compares the candidate against `null`, not the unreadable stored ID ([scripts/miniplayer-state.js:383](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:383), [scripts/miniplayer-state.js:387](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:387)). The final read-back proves only that the candidate is stored, not that it differs from the previous value ([scripts/miniplayer-state.js:397](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:397)). A focused probe combining a first-read exception with pinned `Date.now()`/`Math.random()` produced `{original:"kf12oi-i", rotated:"kf12oi-i", reportedSuccess:true}`. `resolveCollision()` consequently reports `rotated:true`, and `revokeLease()` escalation reports `ok:true`, despite the identity remaining unchanged ([scripts/miniplayer-state.js:591](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:591), [scripts/miniplayer-state.js:734](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:734)). The suite tests a failed initial read only for `establishTabId()`; every rotation-distinctness test uses a readable store ([scripts/test-miniplayer-state.mjs:395](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:395), [scripts/test-miniplayer-state.mjs:422](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:422), [scripts/test-miniplayer-state.mjs:444](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:444)).

   Why it matters: the collision handshake or revocation fallback can claim the duplicated identity was abandoned when both documents still possess it, allowing both to restore the same lease. This contradicts the plan’s successful-rotation contract and its claim that the handshake’s nonce/rotation logic is settled ([player-consolidation-plan.md:2339](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2339)).

   Suggested fix: make `rotateTabId()` return `null` without writing when the existing-ID read throws, matching `establishTabId()`’s fail-closed policy. Add a regression using `throwingOnFirstGetStorage()` plus pinned entropy, and exercise it through both `handleIncomingProbe()` and `revokeLease()`.

2. **Medium — Equal collision nonces make two cloned documents ignore each other and both restore ownership.**

   Evidence: `generateNonce()` can produce identical values when its entropy source repeats ([scripts/miniplayer-state.js:526](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:526)); the deterministic tests explicitly demonstrate identical injected entropy producing identical output ([scripts/test-miniplayer-state.mjs:1409](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:1409), [scripts/test-miniplayer-state.mjs:1431](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:1431)). Nevertheless, `isTabProbeCollision()` rejects a same-ID probe when its nonce equals this document’s nonce, and `shouldRotateOnCollision()` also declines the tie ([scripts/miniplayer-state.js:540](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:540), [scripts/miniplayer-state.js:566](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:566)). The suite actively blesses this behavior as “never treated as a collision” ([scripts/test-miniplayer-state.mjs:1364](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:1364)). A focused probe with two cloned session stores and equal nonces returned no reply, no rotation, no failure from either handler; both subsequent `restoreLease()` calls returned `restored`.

   Why it matters: `BroadcastChannel` does not deliver a sender its own message, so a received same-ID/same-nonce probe is another document, not a self-echo. Ignoring it defeats the handshake’s sole purpose without any storage failure and contradicts the plan’s “exactly one survives” and “already solid” claims ([player-consolidation-plan.md:1931](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:1931), [player-consolidation-plan.md:2342](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2342)).

   Suggested fix: recognize every valid same-tab-ID probe as a collision. Because equal nonces provide no deterministic asymmetry, return `failed:true` and require both documents to disable persistent ownership, or introduce a bounded fresh-nonce collision round that fails closed if equality persists. Replace the current same-nonce test with an end-to-end fixed-entropy regression proving two clones cannot both restore.

**Verification during this review**

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks, no orphan song pages.
- All seven executable `node scripts/test-*.mjs` suites — passed, 252/252 total; `test-miniplayer-state.mjs` passed 109/109. Existing synthetic-error logs and playlist `MaxListenersExceededWarning`s were emitted.
- `python3 scripts/verify_markup.py` — passed: 1,427 items across 166 generated pages.
- `python3 scripts/verify_markup.py --check-allowlist-coverage` — passed: all 30 public shows covered.
- Syntax checks, `cmp scripts/miniplayer-state.js assets/miniplayer-state.js`, and `git diff --check` — passed.
- Focused fixed-entropy probes — reproduced unchanged successful rotation after a transient read failure and dual restoration after equal collision nonces.
_Review generated 2026-08-15 21:44:20 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-15)

1. **Medium — `rotateTabId()` can report success without changing the ID when its pre-write read fails — CONFIRMED via direct reproduction, real gap in my own round-9 fix, not yet fixed.**
   Reproduced directly: a session store whose first `getItem()` call throws
   (transient read failure), combined with pinned entropy, makes
   `rotateTabId()` return the SAME id that was already stored while
   reporting it as a successful rotation. Root cause: the pre-write read
   failure collapses `existing` to `null`, so `generateDistinctFrom()`
   compares the freshly generated candidate against `null` (which any real
   id always differs from) instead of against the actual, unreadable prior
   value — the final read-back only proves the write LANDED, not that
   anything actually CHANGED, which is exactly the distinction the
   `writeEnvelope()` fix (round 8) exists to enforce elsewhere. This is a
   genuine inconsistency in my own round-9 patch: I reasoned in the code
   comment that "a read failure on the pre-write existing value is not
   itself fatal here... the read-back verification below is unaffected
   either way" — that reasoning conflated "verified to have landed" with
   "verified to have changed anything," which are different properties.
   Real, in-scope, needs fixing: match `establishTabId()`'s existing
   fail-closed policy — return `null` without ever writing when the
   pre-write read throws, rather than silently treating an unreadable
   value as "nothing there." Safe to do so: the caller contract already
   handles a `null`/`failed` rotation by disabling ownership for that
   document entirely, so failing closed here doesn't strand a real
   collision unresolved, it just routes it through the existing
   already-tested disable-on-failure path instead of a false-success path.

2. **Medium — Two genuinely distinct documents with equal collision nonces never detect each other and both restore ownership — CONFIRMED via direct reproduction, real bug in previously out-of-scope handshake logic, proposing to fix.**
   Reproduced directly: two documents sharing a tab id (a genuine
   collision — e.g. duplicated tab), whose nonces happen to be equal,
   both call `handleIncomingProbe()` on each other's probe and get
   `{reply:null, rotated:false, failed:false}` — a complete no-op,
   identical to "no collision at all" — because `isTabProbeCollision()`
   explicitly excludes `incoming.nonce === myNonce` from being a
   collision at all (original reasoning: BroadcastChannel never delivers
   a sender its own message, so same-tabId+same-nonce was assumed to only
   ever be a self-echo). Both sides then call `restoreLease()` and both
   get `'restored'` — full dual-ownership, not merely a display gap. This
   logic is technically outside the fenced-lease redesign's stated scope
   ("NOT part of the 2026-08-15 redesign... already solid after rounds
   3-4... out of scope here" per the module's own comment), but round 9's
   own deterministic-nonce-injection fix is what made this provable, and
   the underlying shape is identical to every other fix applied this
   session: a comparison that silently degrades to "no-op" when compared
   values collide, instead of treating "can't distinguish" as its own
   outcome requiring a decision. The original justification (guarding
   against a self-echo BroadcastChannel structurally cannot deliver) was
   solving a problem that cannot occur while leaving open one that can, if
   rarely. Proposing to fix by widening `isTabProbeCollision()` to treat
   ANY same-tabId probe as a collision regardless of nonce equality (safe
   given BroadcastChannel's no-self-delivery guarantee — the "self-echo"
   case this excluded cannot reach this code path in a real deployment),
   and having `resolveCollision()` report `failed:true` (never silently
   `rotated:false, failed:false`) when the nonces are equal and therefore
   provide no deterministic tie-break winner — routing through the
   already-built, already-tested "disable ownership on failed:true"
   caller contract rather than inventing new caller-side behavior.

**Net assessment: this round is NOT clean either — both findings real,
both reproduced, both worth fixing.** Finding 1 is a direct gap in my own
round-9 patch (higher priority to close before it ships alongside that
fix). Finding 2 touches logic previously declared out-of-scope for this
redesign, but the same reproduction discipline and "structural, not
probabilistic" principle already applied three times this session
(writeEnvelope, rotateTabId's/claimOwnership's entropy check) applies
here too — declining to fix it now, on the grounds that it predates this
redesign, would be inconsistent with why findings 1's round-9 sibling was
fixed. Reported to Rene; awaiting explicit go-ahead before implementing
anything above — no source file has been touched during this review.

**Outcome (Claude, 2026-08-15): both implemented, approved by Rene.**
- Finding 1: `rotateTabId()`'s pre-write read now fails closed (returns
  `null`, writes nothing) on a throw, matching `establishTabId()`'s
  existing policy, instead of collapsing to `existing = null` and
  comparing the fresh candidate against the wrong value.
- Finding 2: `isTabProbeCollision()` now treats any same-tabId,
  well-formed-nonce probe as a collision regardless of nonce equality
  (dropped its now-unused `myNonce` parameter entirely rather than leave
  it dead); `resolveCollision()` now returns `{rotated:false,
  failed:true}` when the two nonces provide no usable tie-break asymmetry
  (equal, or either missing/malformed) instead of a silent
  `{rotated:false, failed:false}` no-op — routed through the same
  already-tested "disable ownership on failed:true" caller contract as a
  failed rotation. `shouldRotateOnCollision()` itself is unchanged.
- Added 6 regression tests: `rotateTabId()`'s pre-read failure (pinned
  entropy, proves no false-success self-overwrite), the corrected
  `isTabProbeCollision()` equal-nonce classification, a malformed-nonce
  case, `handleIncomingProbe()` reporting `failed:true` for an
  unresolvable collision, and an end-to-end regression proving two cloned
  documents with an equal collision nonce are both correctly flagged
  rather than silently both restoring. 112/112
  `test-miniplayer-state.mjs`, 255/255 across all suites, `build.py
  --check`, `verify_markup.py --check-allowlist-coverage`, syntax checks,
  and `cmp scripts/miniplayer-state.js assets/miniplayer-state.js` all
  clean. Round eleven (`/review-step`) launched next.

---

## Eleventh fenced-lease ownership subsystem review — 2026-08-15

1. **Medium — A post-write verification-read failure mutates durable state while every public API reports that the write failed.**  
   Evidence: [writeEnvelope()](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:279) performs `setItem()` before its verification read, then returns `false` when that read throws at [line 287](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:287). `claimOwnership()` consequently returns `write-failed` with no lease at [line 1040](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:1040), even though its candidate may now be the durable owner. The same ambiguity affects `writeSession()` and `tombstoneIfCurrent()`. A focused probe made only the immediate read-back throw: `claimOwnership()` returned `{ok:false, lease:null, reason:"write-failed"}` while `readEnvelope()` showed its new owner tuple durably stored; `writeSession()` returned `false` while its new item was stored; and `tombstoneIfCurrent()` returned `false` while ownership was actually cleared. This directly falsifies the plan’s assertion that a failed claim leaves the previous envelope completely untouched at [player-consolidation-plan.md:2456](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2456). Existing tests cover a throwing `setItem()` and a silently dropped write, but never “write lands, verification read throws” ([test-miniplayer-state.mjs:895](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:895), [line 920](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:920)).  
   Why it matters: a claimant can displace the previous owner yet receive no lease, leaving neither live caller able to save; callers can also retry or display failure despite their session/tombstone having landed. One transient read failure is sufficient.  
   Suggested fix: make `writeEnvelope()` return a structured outcome such as `confirmed`, `not-written`, or `indeterminate`. Treat a post-write unreadable verification as indeterminate, not equivalent to a thrown/dropped write; under the lock, re-read and adopt the candidate lease only if its exact tuple is later confirmed. Propagate this status through all three callers and remove the “previous envelope untouched” guarantee from ambiguous paths. Add focused regressions for claim, session write, and tombstone.

2. **Medium — Collision memoization survives a tab-ID rotation and can suppress a genuinely new collision under the replacement identity.**  
   Evidence: the module specifies one document-lifetime `resolvedNonces` set keyed only by the opposing nonce ([miniplayer-state.js:469](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:469)); `resolveCollision()` checks and inserts only `theirNonce` at [lines 644–646](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:644). After A rotates because of nonce `zzz`, then claims under its new ID, a later clone of that new identity using `zzz` is treated as already resolved by A. The clone computes that it should retain the ID, so neither rotates and both return `restored`. The focused reproduction produced `second:{rotated:false,failed:false}`, identical replacement IDs, and `aRestore:"restored", cRestore:"restored"`. The memoization test misses this because, after rotating storage, it calls the handler again with the obsolete pre-rotation `sharedTabId` ([test-miniplayer-state.mjs:1625](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:1625), [line 1634](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:1634)); real wiring refreshes the cached ID. The plan’s “memoized per opposing nonce so a given collision is never decided twice” claim at [player-consolidation-plan.md:1934](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:1934) conflates a nonce with a collision identity.  
   Why it matters: nonce reuse—precisely the degraded-entropy case the last two rounds hardened—can create dual restoration without a storage failure. The equal-nonce `failed:true` path itself remains latched correctly; the defect is reuse after the document has moved to a new ID generation.  
   Suggested fix: memoize by `(collisionTabId, opposingNonce)`, passing the message’s tab ID into `resolveCollision()`, or clear the memo whenever this document’s ID changes, including revocation escalation. Add the reproduced rotate → reclaim → clone-new-ID-with-historical-nonce regression.

3. **Medium — Multiple collision losers can independently generate the same replacement ID, and successful rotation does not trigger another probe.**  
   Evidence: `generateDistinctFrom()` guarantees only that each candidate differs from that document’s own previous value ([miniplayer-state.js:319](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:319)); `rotateTabId()` cannot compare against replacements concurrently generated by other tabs ([line 398](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:398)). The documented `rotated:true` wiring refreshes the ID and relinquishes playback but sends no probe for the new identity ([lines 488–495](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:488)). With three clones and fixed entropy, two lower-nonce tabs independently processed the highest nonce’s probe, both returned `rotated:true`, and both persisted the same replacement `kf12oi-i`. After one claimed under that ID, both returned `restored`. The suite covers only two-tab collisions, where exactly one side rotates, so this cannot occur in its fixture ([test-miniplayer-state.mjs:1528](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:1528)). This also disproves the plan’s blanket assertion that every residual gap requires two independent write failures at [player-consolidation-plan.md:2516](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2516).  
   Why it matters: the round-9 distinctness fix prevents a no-op against the old ID, but does not establish that the replacement is unique among concurrent losers. Three duplicated documents or repeated degraded entropy can therefore leave a fresh duplicated identity undetected, with zero storage failures.  
   Suggested fix: after every successful handshake rotation, start a fresh probe for the replacement ID, with collision bookkeeping scoped to that ID generation; repeat within a bounded convergence protocol and disable persistence if it cannot converge. Add a three-clone fixed-entropy test asserting no two enabled documents retain the same replacement ID and at most one can restore.

Verification during this review:

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks, no orphan song pages.
- All seven `node scripts/test-*.mjs` suites — passed, 255/255; existing synthetic-error output and playlist `MaxListenersExceededWarning`s were non-fatal.
- `python3 scripts/verify_markup.py` and `--check-allowlist-coverage` — passed: 1,427 items across 166 pages; all 30 public shows covered.
- Syntax checks, source/generated-asset `cmp`, and `git diff --check` — passed.
- Focused Node probes reproduced all three findings.
- Repository-wide signature search found no stale three-argument `isTabProbeCollision()` caller or remaining `myNonce` documentation for that function.
_Review generated 2026-08-15 22:12:56 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-15)

All three findings independently reproduced via standalone Node scripts
before writing anything up.

1. **Medium — post-write verification-read failure reported as write failure — CONFIRMED, real false-negative bug, proposing a bounded fix.**
   Reproduced directly for all three callers: a storage double whose
   `setItem()` genuinely lands but whose VERY NEXT `getItem()` throws once
   (a transient read blip immediately after a successful write) made
   `claimOwnership()` report `{ok:false, reason:'write-failed'}` while
   `readEnvelope()` showed the new owner durably stored; `writeSession()`
   returned `false` while the new queue item was durably saved;
   `tombstoneIfCurrent()` returned `false` while ownership was actually
   cleared. This is the mirror image of round 8's bug (false SUCCESS on a
   silent drop) — round 8's fix over-corrected into an occasional false
   FAILURE on a genuinely landed write. Real, worth fixing, but I'm
   declining the reviewer's full suggested fix (propagate a 3-state
   `confirmed`/`not-written`/`indeterminate` result through all three
   public APIs) as disproportionate to the actual risk: traced the
   consequence for each caller and it's bounded, not corrupting —
   `claimOwnership()`'s `{ok:false}` self-heals on the next retry (no CAS
   precondition, a fresh claim just overwrites cleanly); `writeSession()`
   likewise self-heals on the next periodic save; `tombstoneIfCurrent()`
   is already explicitly documented "best-effort... never load-bearing for
   correctness." Proposing instead: a small bounded RETRY on the
   verification read itself inside `writeEnvelope()` (same shape as
   `generateDistinctFrom()`'s existing retry pattern elsewhere in this
   file) — closes the overwhelming majority of realistic transient-blip
   cases without a larger interface change across every caller; the
   residual (every retry also throws) gets documented honestly rather than
   chased further, given the bounded, self-healing consequence traced
   above.

2. **Medium — collision memoization keyed by opposing nonce alone survives this document's own tab-ID rotation — CONFIRMED, real bug, cheap and clean to fix.**
   Reproduced directly: after A loses a collision on nonce `zzz` and
   rotates to a new id, a LATER, genuinely different collision under A's
   NEW id that happens to carry the identical opposing nonce `zzz` (the
   same reused-nonce scenario rounds 9-10 already established as reachable
   under degraded entropy) is silently treated as "already resolved" by
   the stale memoization entry — `resolveCollision()` returns
   `{rotated:false, failed:false}` without even reconsulting
   `shouldRotateOnCollision()`, and A wrongly restores as owner. Small,
   contained fix: `resolveCollision()` already receives `myTabId` at both
   call sites (`handleIncomingProbe()`/`handleIncomingProbeReply()`) — key
   `resolvedNonces` by a composite of `(myTabId, theirNonce)` instead of
   `theirNonce` alone, so a collision under a NEW identity is never
   shadowed by a stale entry from a previous one. No caller-contract
   change needed — the Set's lifetime/ownership is unchanged, only what's
   stored in it.

3. **Medium — concurrent collision losers can independently generate the identical replacement ID, and no re-probe follows a successful rotation — CONFIRMED, real, proposing a partial fix plus an honestly documented residual.**
   Reproduced directly: with 3 clones colliding and 2 losers (B, C) both
   needing to rotate under pinned entropy, both independently generated
   the SAME replacement id — `generateDistinctFrom()` can only guarantee a
   candidate differs from THAT document's own prior value, it has no way
   to know what a DIFFERENT, concurrently-rotating document is
   independently generating. Confirmed separately that the documented
   caller-contract pseudocode never re-probes under the new identity after
   `rotated:true`, so even a fresh collision from an unrelated cause (not
   just this specific concurrent-generation case) would go undetected.
   Proposing a caller-contract-level fix (consistent with how this exact
   gap category — refresh `myTabId`, drop the lease, pause playback — was
   already handled for `rotated:true` elsewhere in this file): document
   that a caller MUST broadcast a fresh PROBE under the new id immediately
   after any successful rotation. This turns the existing pairwise
   handshake into a genuinely self-converging protocol across additional
   rounds without any new internal module logic, since a stale duplicate
   the round-2 memoization fix doesn't already catch would now surface as
   a brand-new collision under the freshly rotated identity and get
   handled by the SAME mechanism again. Declining to also build the
   reviewer's suggested bounded-convergence-with-give-up protocol: it
   requires 3+ genuinely simultaneous duplicated tabs AND 2+ of the losers
   independently generating identical replacement ids, a compounding,
   extremely narrow case; the re-probe fix means it doesn't go
   permanently undetected even if it happens, just possibly takes an
   extra handshake round — documenting that residual honestly rather than
   building convergence-bound machinery this consumer-less module has no
   caller to exercise yet.

**Net assessment: this round is NOT clean — all three findings real and
reproduced.** Proposing to fix all three at the scope described above
(bounded retry for #1, composite memoization key for #2, re-probe caller
contract for #3, with #3's N-way edge case documented as residual rather
than fully engineered against). Worth flagging directly: eleven rounds in,
the findings have been trending toward progressively more exotic,
compounding edge cases (rounds 6-7 were plausible real-world triggers —
storage quota, private browsing; rounds 8-11 need pinned/degraded entropy
or 3+-way simultaneous tab duplication to manifest). Reported to Rene,
including that observation; awaiting explicit go-ahead before implementing
anything above — no source file has been touched during this review.

**Outcome (Claude, 2026-08-15): all three implemented at the proposed
scope, approved by Rene — who also approved stopping the review loop after
one final verification round.**
- Finding 1: `writeEnvelope()`'s verification read now retries a bounded
  3 attempts (`MAX_WRITE_VERIFY_ATTEMPTS`); a successful read is decisive
  either way, only a thrown read retries. Still exactly one `setItem()`.
  Residual (every attempt throws) documented in the source and as plan
  residual-gap item 10.
- Finding 2: `resolveCollision()` now memoizes by the composite key
  `` `${myTabId}|${theirNonce}` `` instead of the nonce alone; both call
  sites pass `myTabId`. `|` is unambiguous — tab ids are base36 + one
  hyphen, nonces are base36, so neither part can contain it.
- Finding 3: addressed at the caller-contract level — the boot pseudocode
  now routes every `rotated:true` through an `onRotated()` helper that
  re-probes under the new identity, with a dedicated MANDATORY RE-PROBE
  contract section explaining why. Residual (convergence by repetition
  rather than a bounded protocol) documented as plan item 11.
- Added 5 regression tests (an earlier version of this entry said 6 —
  corrected by round 12; the ownership suite went 112 -> 117):
  `writeEnvelope()` transient-verification-read
  retry, `claimOwnership()` reporting `ok:true` over the same blip, the
  give-up-after-all-retries residual, a genuinely-new-collision-under-a-
  rotated-identity test (finding 2's exact reproduction), and a
  three-clone concurrent-loser test locking in both that the id collision
  can happen and that the re-probe resolves it end to end.
- **One incident worth recording**: my first edit for finding 2 wrote a
  literal NUL byte into the memo-key template string (`${myTabId}\x00
  ${theirNonce}`), which silently made `grep` treat the whole source file
  as binary — every subsequent `grep` against it returned nothing, which
  I initially misread as the file having lost content. Caught by checking
  byte offsets in Python, fixed by replacing with `|`, and now guarded by
  an explicit null-byte check in the verification sweep. Worth
  remembering: a tool going quiet is a symptom, not a null result.
- Verification: 117/117 `test-miniplayer-state.mjs`, 260/260 across all
  suites (an earlier version of this entry said 257 — arithmetic error,
  corrected by round 12), `build.py`, `build.py --check`, `verify_markup.py
  --check-allowlist-coverage`, `node --check` on both files, zero null
  bytes in all three files, `git diff --check` clean for `scripts/` and
  `assets/`, and `cmp scripts/miniplayer-state.js
  assets/miniplayer-state.js` matching.

---

## Final fenced-lease verification review — 2026-08-15

No High or Medium findings. All three round-11 fixes are correctly implemented; no stale `isTabProbeCollision()` signature remains, and the composite memoization preserves duplicate-message and simultaneous-mutual-probe behavior.

1. **Low — Round 11 overstates the number and strength of its regression tests.**  
   Evidence: the review log claims six new tests, but the ownership suite increased from 112 to 117—five cases ([player-consolidation-codex.md:4686](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-codex.md:4686), [player-consolidation-codex.md:4700](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-codex.md:4700)). The “every verification read throws” case does not count reads, so the pre-fix single-attempt implementation would also pass it ([test-miniplayer-state.mjs:415](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:415)). The three-clone case manually injects the fresh probe through direct handler calls ([test-miniplayer-state.mjs:1669](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:1669)); the shared caller harness still only refreshes the ID and never re-probes ([test-miniplayer-state.mjs:1398](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:1398)). Thus it proves the existing handshake can resolve a manually surfaced collision, but not the plan’s “end-to-end” caller-contract wording ([player-consolidation-plan.md:2725](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2725)).  
   Why it matters: later work could remove the three-attempt bound or omit the mandatory caller re-probe while these tests remain green.  
   Suggested fix: count and assert exactly three verification reads and one write; update `wireDocument()` to perform the documented post-rotation re-probe and drive the three-clone case through that harness. Until a real coordinator exists, call this a caller-contract simulation rather than end-to-end coverage. Correct the round-11 count to five new cases and the current aggregate from 257 to 260.

2. **Low — Residual item 12 inaccurately characterizes every round 8–11 trigger as degraded entropy or three-tab duplication.**  
   Evidence: item 12 makes that blanket statement at [player-consolidation-plan.md:2739](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2739), while item 10 correctly records that round 11’s first defect required only one transient `getItem()` exception after a landed write ([player-consolidation-plan.md:2699](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2699)).  
   Why it matters: this overstates how exotic the final review’s storage defect was and weakens the stated rationale for stopping the loop. Items 10 and 11 otherwise accurately describe the code’s remaining behavior.  
   Suggested fix: say that the collision findings increasingly required degraded entropy or N-way duplication, while the verification-read finding remained an ordinary transient-storage failure.

**Verification during this review**

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks, no orphan song pages.
- All `node scripts/test-*.mjs` files — passed: 260/260 executable tests; `test-miniplayer-state.mjs` passed 117/117.
- `python3 scripts/verify_markup.py --check-allowlist-coverage` — passed; all 30 public shows covered.
- `node --check` on both reviewed JavaScript files — passed.
- Source/generated-asset `cmp` and null-byte checks — passed.
- `git diff --check` over all reviewed files — failed only on pre-existing trailing spaces in the round-11 review-log entry; the scripts/assets themselves were clean.
_Review generated 2026-08-15 22:32:08 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-15) — FINAL ROUND, loop stopped here

**Headline: no High or Medium findings. All three round-11 fixes verified
correct**, no stale `isTabProbeCollision()` signature, and the composite
memoization key confirmed to preserve both the duplicate-message and
simultaneous-mutual-probe guarantees. Both Low findings were about the
accuracy of MY OWN claims rather than about the code — both confirmed and
both fixed:

1. **Low — overstated test count and strength — CONFIRMED on all three
   sub-points, all three fixed.**
   - *Count*: I wrote "6 regression tests"; the suite went 112 → 117, so
     it was 5. I had also renamed (not added) the memoization test, which
     is where the miscount came from. Corrected above.
   - *Aggregate*: I wrote 257/257; recounted directly and it is **260**
     (117 + 28 + 41 + 17 + 29 + 15 + 13). Plain arithmetic error on my
     part, carried forward from the prior round's 255. Corrected in both
     documents.
   - *Vacuous test*: correct and the sharpest of the three — my "every
     verification read throws" test asserted only the `false` return,
     which the PRE-fix single-attempt implementation would equally have
     satisfied. It documented the residual without proving the retry
     bound exists at all. Rewritten to count calls and assert exactly 3
     `getItem()` attempts and exactly 1 `setItem()` (the latter also
     guarding the single-write property against a future change to the
     retry loop).
   - *Overclaimed "end-to-end"*: also correct — the three-clone test
     hand-injected the post-rotation probe, so it proved the handshake
     can resolve a manually surfaced collision, not that following the
     contract surfaces it. Fixed properly rather than by softening the
     wording: `wireDocument()` now performs the documented re-probe (the
     same way it was taught to model `ownershipDisabled` after round 7's
     equivalent finding), and the three-clone test now drives the entire
     cascade through it from a single `postMessage`, with entropy pinned
     for exactly the first two draws so B and C genuinely collide
     mid-cascade. **Verified non-vacuous** by temporarily removing the
     re-probe from `wireDocument()` and confirming the test fails
     (116/117), then restoring it (117/117).

2. **Low — residual item 12 mischaracterized rounds 8-11 — CONFIRMED, and
   this one is worth naming plainly.** I wrote that rounds 8-11 all
   required degraded entropy or 3+ duplicated tabs. That is true of the
   *collision-handshake* findings but false of the *storage* ones: round
   8's silent-drop bug and round 11's verification-read bug each needed
   only one ordinary transient storage failure. The inaccuracy flattered
   my own argument for stopping the loop, which is exactly the kind of
   claim that should not go unchecked. Item 12 rewritten to separate the
   two trends honestly and to rest the stop-the-loop decision on the
   defensible reason instead: each round's fix has been creating the
   surface for the next round's finding (round 8's fix directly caused
   round 11's item 10; round 9's fix directly caused round 10's first
   finding), and round 12 confirms no High/Medium findings remain.

**Loop stopped here, as agreed with Rene.** Final state: 117/117
`test-miniplayer-state.mjs`, 260/260 across all suites, `build.py`,
`build.py --check`, `verify_markup.py --check-allowlist-coverage`, `node
--check` on both files, zero null bytes, `cmp` source↔asset matching, and
`git diff --check` clean for `scripts/`/`assets/`. The next validation
this subsystem gets is a real consumer in Stage 3a-canary.

---

## Stage 3a-canary Phase 0 and Task 1 review — 2026-08-16

1. **High — A queued stale `play` event can reclaim ownership after an external claim already paused the controller.**

   Evidence: external claims bump `external-claim` and call `pause()` at [scripts/player-controller.js](/home/renedebos/renedebos.com-player-consolidation/scripts/player-controller.js:225), but the `play` listener unconditionally records `local-play` and broadcasts another claim at [scripts/player-controller.js](/home/renedebos/renedebos.com-player-consolidation/scripts/player-controller.js:243). `_playIndex()` invokes `audio.play()` at line 798. The HTML algorithm queues `play` as a media task; a subsequent `pause()` changes `paused` immediately but does not cancel that already-queued event. [HTML media-element algorithm](https://html.spec.whatwg.org/multipage/media.html#playing-the-media-resource)

   A focused probe started two controllers synchronously, before either queued `play` event ran. It ended with controller B audibly paused but reporting `lastOwnershipEvent: "local-play"` after an intervening external claim. The suite’s own fake has the same unconditional queued-event behavior at [scripts/test-player-controller.mjs](/home/renedebos/renedebos.com-player-consolidation/scripts/test-player-controller.mjs:53), but no test starts competing attempts before the first event is delivered. The similarly unguarded `playing` handler can also publish `state="playing"` while `audio.paused === true`.

   Why it matters: an adopting mini-player can mint a fresh durable epoch for a controller that is actually paused, overwrite the genuine winner’s session, and present state inconsistent with audible playback. This invalidates the plan’s checked claim that the `play` hook is safe at [player-consolidation-plan.md](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2082).

   Suggested fix: ignore queued `play` and `playing` events when `audio.paused` is already true. Add a regression that calls `a.play()` and `b.play()` in the same task, before awaiting, then asserts the paused loser’s final ownership event remains `external-claim` and no controller reports `playing` while paused.

2. **High — A 250 ms quiet period cannot establish that the collision handshake has “converged.”**

   Evidence: the contract declares silence for 250 ms to mean settled and permits `restoreLease()` immediately afterward at [scripts/miniplayer-state.js](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:651). BroadcastChannel provides no delivery deadline. A frozen, background-throttled, or busy existing tab can hold the cloned identity while replying after the newcomer’s timer fires. That newcomer can restore and attempt playback while the original tab is still audible; the later reply only repairs ownership after a double-owner window already occurred.

   The round semantics are also underspecified: “after five restarts” is six quiet windows including the initial one, contradicting the stated ~1.25-second bound at lines 672–684, and “any collision resolved restarts” conflicts with “restart-on-rotation” in the plan at [player-consolidation-plan.md](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2090).

   Why it matters: the policy calls this fail-closed and converged, but timeout silence is only a heuristic. It can restore two copies of one lease—the exact condition the handshake exists to prevent.

   Suggested fix: use a document-lifetime Web Lock keyed by the stored tab ID before restoration. A duplicate that cannot acquire that identity lock must rotate and retry; lack of Web Locks already has a defined fail-closed path. Keep BroadcastChannel for late collision signaling if desired, but do not treat a timer without positive uniqueness evidence as convergence. Define whether the initial window counts toward `MAX_SETTLE_ROUNDS`.

3. **Medium — The storage-event invalidation contract can revoke a newly reclaimed, currently valid lease.**

   Evidence: the contract says a changed event tuple enters the full loss path at [scripts/miniplayer-state.js](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:698), but never requires a fresh `readEnvelope()`/`hasValidLease()` check before acting. Storage events are queued tasks delivered only to other storage objects, so this sequence is valid: another tab writes and queues event A; before A is handled, the user plays locally and this tab claims/writes lease B; A then arrives carrying its older `newValue`. [HTML Web Storage broadcast algorithm](https://html.spec.whatwg.org/multipage/webstorage.html#the-storage-interface)

   Why it matters: treating `event.newValue` as current would drop B, pause valid playback, and call `revokeLease()` on B’s still-current epoch. The user’s newer action loses to stale notification data.

   Suggested fix: specify that `storage` is only an invalidation signal. On delivery, re-read current storage and run a fresh lease-validity comparison; ignore the event if the current envelope still matches the current lease. Add a delayed-event test where a local reclaim lands before an older queued event is dispatched.

4. **Low — The new sequence test does not enforce one monotonic counter across local and external events.**

   Evidence: [scripts/test-player-controller.mjs](/home/renedebos/renedebos.com-player-consolidation/scripts/test-player-controller.mjs:933) constructs four controllers sharing one registry, so each receives multiple unrelated claims, despite lines 955–957 saying each saw one. It asserts only `lastOwnershipEvent`, not the exact event stream or sequence values.

   A focused mutation split local and external counters and exposed `Math.max(localSeq, externalSeq)` in `snapshot()`—violating Task 0.1’s single-sequence contract—and all 57 controller tests still passed. The “play-attempt … cannot let a stale restore win” case at line 892 likewise proves only synchronous visibility; it contains no restore/adoption decision.

   Why it matters: a later regression to per-kind counters would leave the named ordering test green, while the plan presents this behavior as tested.

   Suggested fix: run the two scenarios with isolated controller pairs and capture exact `{seq, kind}` streams, including `external-claim`, asserting consecutive sequence values across all three kinds. Rename the play-attempt test to its narrower primitive claim until the coordinator suite proves restore suppression end to end.

5. **Low — The contract text claims a real consumer exists when the repository explicitly has none.**

   Evidence: the module header says the future boot script will be its first consumer at [scripts/miniplayer-state.js](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:31), while the settlement section says “There is a consumer now” at line 690. Repository search found no production import of `miniplayer-state.js`; [HANDOFF.md](/home/renedebos/renedebos.com-player-consolidation/HANDOFF.md:200) also says it is “consumed by nothing.” Nevertheless, the checked plan item says storage invalidation “routes” through the loss path at [player-consolidation-plan.md](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2093).

   Why it matters: this overstates implementation and validation status precisely at the caller boundary where the unresolved races above live.

   Suggested fix: change these claims to “policy drafted for the future coordinator,” and mark routing/settlement implemented only after the coordinator and delayed asynchronous tests exist.

**Verification during this review**

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks.
- All seven executable `node scripts/test-*.mjs` suites — passed, 278/278.
- `python3 scripts/verify_markup.py` — passed: 1,427 items across 166 pages.
- `python3 scripts/verify_markup.py --check-allowlist-coverage` — passed.
- `node --check` on the three changed JavaScript sources — passed.
- Source/asset comparisons and `git diff --check` — passed.
- Focused queued-`play` race probe — reproduced paused controller ending with `lastOwnershipEvent="local-play"`.
- Focused split-counter mutation — all 57 controller tests still passed.
- Real Chromium probe could not launch in the read-only sandbox: Playwright failed with `EROFS` while creating `/tmp/playwright-artifacts-*`.
_Review generated 2026-08-16 01:12:50 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-16)

All five **confirmed**, each reproduced or traced independently before being
accepted. Nothing declined. Two of them invalidate claims this session made in
the plan and in the module comments, which is recorded below rather than
quietly corrected.

1. **Queued stale `play` event reclaims ownership — CONFIRMED (High).**
   Reproduced directly with two controllers started in the SAME task, before
   either queued `play` event ran. Result: controller B ends with
   `audio.paused === true` but `state === 'playing'` AND
   `lastOwnershipEvent === 'local-play'` — it would mint a durable epoch while
   audibly silent, and overwrite the genuine winner's session. Sequence: A's
   `play` fires → A claims → B (still `'loading'`) is paused by the claim → B's
   *already-queued* `play` fires anyway → B bumps `local-play` and re-claims.
   **One correction to the finding's framing:** the `state === 'playing'` while
   `audio.paused` half is **pre-existing** — the `'playing'` listener has always
   been unguarded and this is not a regression from Task 0.1. What Task 0.1
   changed is the consequence: attaching ownership to that event turned a
   cosmetic state inconsistency into a durable-storage one. Fix as suggested:
   ignore `play`/`playing` when `audio.paused` is already true, plus the
   same-task regression test.

2. **A 250 ms quiet period is not convergence — CONFIRMED (High), and the
   suggested remedy is better than what the contract currently specifies.**
   The objection is correct in principle: silence is absence of evidence, and
   BroadcastChannel has no delivery deadline, so a frozen or background-
   throttled tab holding the cloned identity can reply after the newcomer's
   timer fires — producing exactly the double-owner window the handshake exists
   to prevent. A document-lifetime **Web Lock keyed by the stored tab id**
   (`navigator.locks.request(..., {ifAvailable: true})`) is strictly better: it
   is *positive* uniqueness evidence, deterministic, needs no timer, and
   degrades through the fail-closed path Web Locks already has here. It also
   covers late duplication (a tab cloned an hour later fails to acquire and
   rotates immediately) without depending on a probe reply arriving.
   Both sub-points also confirmed: "after MAX_SETTLE_ROUNDS restarts" with
   `MAX_SETTLE_ROUNDS = 5` is six windows (1.5 s), not the "~1.25 s" the same
   comment claims; and "any collision resolved restarts it" contradicts the
   rotation-based rationale given two lines later — winning a collision does
   not change this document's identity and needs no fresh quiet window.
   Note this is a change to a **documented policy only** — no settlement code
   exists yet — so the cost is a rewrite of the contract plus its
   implementation landing in Task 4 as originally scheduled.

3. **Storage-event invalidation can revoke a valid lease — CONFIRMED (Medium).**
   Storage events are queued tasks, so `event.newValue` can be stale by
   delivery: another tab writes and queues event A; the user then plays locally
   and this tab claims lease B; A arrives carrying the older value. The contract
   as written says "on a tuple change, route through the full loss path" without
   requiring a fresh read — underspecified in precisely the way that invites
   acting on `newValue`. Fix as suggested: `storage` is an invalidation *signal*
   only; on delivery re-read current storage and re-run `hasValidLease()`,
   ignoring the event when the current envelope still matches the current lease.
   Plus a delayed-event test where a local reclaim lands before an older queued
   event is dispatched.

4. **The sequence test does not enforce a single monotonic counter — CONFIRMED
   (Low severity, but the most important finding here).** Independently
   reproduced: splitting `_bumpOwnership()` into per-kind counters exposing
   `Math.max(localSeq, externalSeq)` — a direct violation of Task 0.1's
   single-sequence contract — leaves **all 57 controller tests green**. The test
   asserts only `lastOwnershipEvent`, which a split-counter implementation gets
   right too, so its name promises more than it checks. The second half is also
   confirmed: `claimListeners` is module-scope (`player-controller.js:25`), so
   the four controllers share one registry and each receives **three** external
   claims, not one — instrumenting the real event streams gives
   `one: play-attempt, local-play, external-claim, external-claim, external-claim`,
   directly contradicting that test's own comment. This is the same
   passes-for-the-wrong-reason class as the `destroy()` test caught earlier this
   session, and it is the second time in Phase 0 — worth treating as a pattern,
   not an incident. Fix as suggested: isolated controller pairs, assert the
   exact `{seq, kind}` stream and consecutive sequence values across all three
   kinds, and narrow the play-attempt test's name to what it actually proves
   (synchronous visibility, not restore suppression — there is no restore
   decision anywhere in it).

5. **Contract text claims a consumer that does not exist — CONFIRMED (Low).**
   `miniplayer-state.js:31` says "Nothing in this repo calls this module yet"
   while line 690, added this session, says "There is a consumer now" — a direct
   self-contradiction inside one file. The plan's `- [x] 0.7 storage-event
   invalidation routes through the full loss path` overstates status the same
   way: nothing routes anything, it is a written contract awaiting Task 4.
   Fix as suggested: reword to "policy drafted for the coordinator", and mark
   0.3/0.7 as decided-but-not-implemented rather than done. Same failure mode
   round 12 flagged (documentation claims deserve the code standard), recurring.

**Not yet actioned** — per `/review-step`'s contract this pass only verifies and
records. Findings 2 and 4 both change work already marked complete: 2 replaces
the settlement mechanism, and 4 means Phase 0's test evidence is weaker than
reported, so Checkpoint 0 should not be considered met until it is redone.

### Disposition update — all five fixed (Claude, 2026-08-16)

Applied via `/apply-review` after Rene approved, with finding 2's remedy
amended per Codex's follow-up constraints. Suites: **282/282** across 7 files
on both Node 20 and a simulated Node 24 (was 278). `build.py`, `--check`,
`verify_markup.py --check-allowlist-coverage` all clean; assets byte-identical.

1. **FIXED.** `play` and `playing` both return early when `audio.paused` is
   already true. Regression test starts two controllers in the SAME task,
   before either queued event runs, and asserts the loser ends with
   `external-claim` last and never reports `state:'playing'` while paused.
   Mutation-verified: removing both guards fails that test alone.
2. **FIXED, amended.** The quiet-period settle timer is gone, replaced by a
   document-lifetime Web Lock keyed by the tab id. Implemented now:
   `TAB_IDENTITY_LOCK_PREFIX` and `tabIdentityLockName()`, which validates and
   length-bounds the id — `peekTabId()` does neither, and sessionStorage is
   user-editable — and namespaces it so no stored value can produce a
   `-`-leading reserved name. Three tests, mutation-verified. The full
   acquisition contract is written into the module per Codex's constraints:
   `{ifAvailable:true}`, acquisition signalled through a separate deferred
   while the callback is held open by a never-resolving promise (never await
   `request()` during boot), bounded retry then disable persistence,
   re-acquire the new id's lock after any rotation including a
   `revokeLease()` escalation (new before old where possible), and an explicit
   BFCache rule. The lock is the **sole** collision arbiter — the coordinator
   does not also run the probe/reply handshake, since two rotation mechanisms
   can disagree and strand the document holding only the old id's lock.
   Consequently **0.2 is now marked superseded, not done**; the constant and
   its hazard test are kept because the hazard generalizes to any future
   channel, not because the handshake needs them.
3. **FIXED.** The contract now states that `storage` is a wake-up signal only:
   never act on `event.newValue`, re-read and re-run `hasValidLease()` against
   the captured lease, and do nothing if it still validates. Documentation
   only — the loss path lands with the coordinator in Task 4, and the plan now
   says so rather than claiming it routes today.
4. **FIXED.** Sequence test rewritten: isolated controller pairs, torn down
   between scenarios, asserting exact `{seq, kind}` streams
   (`play-attempt, local-play, external-claim` and
   `external-claim, play-attempt, local-play`) with consecutive seq values.
   The per-kind-counter mutation that previously left all 57 tests green now
   fails. The play-attempt test was renamed to its actual claim
   ("observable synchronously, before the play promise settles") — it contains
   no restore decision and never proved suppression.
5. **FIXED.** The "There is a consumer now" sentence went with the replaced
   settlement block; the file is self-consistent with line 31 again. The plan's
   Phase 0 checklist now uses explicit status words — **implemented** (code +
   mutation-checked test) versus **decided** (written contract awaiting Task
   4) — and 0.3/0.7 are marked decided, not done.

Checkpoint 0 is met again on the corrected evidence. Per `/apply-review`, work
stops here rather than starting Phase A's next task.

---

## Stage 3a-canary Phase A Task 2 review — 2026-08-16

1. **High — A detached `MiniPlayerView` cannot be remounted, leaving a visible but inert bar with no reserved page space.**

   Evidence: the abort controller is created once at [scripts/miniplayer-views.js:53](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-views.js:53), permanently aborted during detach at [scripts/miniplayer-views.js:62](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-views.js:62), then reused during reattachment at [scripts/miniplayer-views.js:56](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-views.js:56). Detach clears the height but does not reset or hide the rendered structure at [scripts/miniplayer-views.js:128](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-views.js:128); remounting the same item skips `_buildStructure()` and therefore never restarts height observation at [scripts/miniplayer-views.js:141](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-views.js:141). The tests cover detach only, never remount, at [scripts/test-miniplayer-views.mjs:324](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-views.mjs:324) and [scripts/test-miniplayer-views.mjs:369](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-views.mjs:369). A focused probe produced `hidden:false`, no `--miniplayer-height`, and a Play click that left the controller paused.

   Why it matters: the recorded Close lifecycle unmounts the view and says a later play brings it back at [player-consolidation-plan.md:2181](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2181). The natural remount implementation cannot satisfy that contract.

   Suggested fix: create a fresh `AbortController` on every attachment and fully reset/hide the view during detach so remount rebuilds the structure and `ResizeObserver`. Add an unmount→remount test asserting restored height, active controls, and a new observer.

2. **Medium — Unknown-duration items permanently display `0:00` as their total after the browser learns the real duration.**

   Evidence: the visible total is built once from nullable `item.durationSec` at [scripts/miniplayer-views.js:183](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-views.js:183), while later progress and ARIA updates use `audio.duration` at [scripts/miniplayer-views.js:235](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-views.js:235). The fixture gives every item a convenient 200-second duration at [scripts/test-miniplayer-views.mjs:29](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-views.mjs:29). A probe with `durationSec:null` followed by `audio.duration=245` displayed `0:00`, while the range announced `0:05 of 4:05`.

   Why it matters: nullable duration is part of the playable-item contract. The visible UI and accessibility state disagree for exactly those items.

   Suggested fix: retain the total-time element and update it when the resolved duration changes, using a cached duration to avoid per-tick writes. Add a null-duration fixture that receives duration metadata after mounting.

3. **Medium — Replacing a queue item with fresh data under the same ID leaves stale title, link, artist, and duration visible.**

   Evidence: structure is keyed only on `currentItem.id` at [scripts/miniplayer-views.js:141](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-views.js:141), while all metadata and the seek label are written only in `_buildStructure()` at [scripts/miniplayer-views.js:172](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-views.js:172). `PlaybackController.setQueue()` legitimately replaces normalized item objects at [scripts/player-controller.js:325](/home/renedebos/renedebos.com-player-consolidation/scripts/player-controller.js:325). A focused restore-old-item→setQueue-fresh-same-ID probe continued showing every old value.

   Why it matters: a persisted session can contain older metadata than a newly generated page. Clicking that same track can make the controller use the fresh queue while the mini-player continues linking to and describing the stale item.

   Suggested fix: patch metadata nodes separately from transport controls, keyed by the relevant metadata fields, so focus-bearing buttons remain intact. Add an integration test that restores old persisted metadata and then supplies a fresh same-ID queue item.

4. **Medium — Pressing the seek thumb without changing it can freeze the range and its ARIA value indefinitely.**

   Evidence: `mousedown`/`touchstart` sets `_seeking`, but only `change` clears it at [scripts/miniplayer-views.js:111](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-views.js:111). Subsequent updates then skip both the range and `aria-valuetext` at [scripts/miniplayer-views.js:237](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-views.js:237). The suite tests only a drag that explicitly dispatches `change` at [scripts/test-miniplayer-views.mjs:195](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-views.mjs:195). A mousedown→mouseup-with-no-change probe left the range at 10% and ARIA at `0:20` while the visible current time advanced to `1:40`.

   Why it matters: an unchanged click, canceled touch, or release outside the control need not produce `change`, leaving user-visible progress permanently divergent.

   Suggested fix: clear seeking on pointer/mouse/touch release and cancellation, including release outside the range, with listeners covered by the attachment signal. Test no-change release and cancellation paths.

5. **Low — Previous at the start of the queue regresses the popup behavior this mini-player will replace.**

   Evidence: the mini-player calls `controller.prev()` directly at [scripts/miniplayer-views.js:99](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-views.js:99), which no-ops before index zero at [scripts/player-controller.js:626](/home/renedebos/renedebos.com-player-consolidation/scripts/player-controller.js:626). The popup clamps a negative index back to zero and plays it at [scripts/continuous-player.js:112](/home/renedebos/renedebos.com-player-consolidation/scripts/continuous-player.js:112). The current test only exercises index 1→0 at [scripts/test-miniplayer-views.mjs:173](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-views.mjs:173).

   Why it matters: on track one, Previous currently restarts/resumes the track; the replacement control silently does nothing.

   Suggested fix: add a mini-player `_prev()` policy matching `PlaylistNowPlayingView`/the popup, and test both paused and playing states at index zero.

6. **Low — The plan overclaims that every acceptance criterion is mutation-checked.**

   Evidence: the plan explicitly says removing controls-cache invalidation fails its named test at [player-consolidation-plan.md:2139](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2139). An in-memory mutation removing every `this._lastControlsKey = null` still passed all 20 Task 2 tests. The item-change test checks metadata and range identity, but not the replacement button’s icon or accessible label, at [scripts/test-miniplayer-views.mjs:132](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-views.mjs:132).

   Why it matters: a same-state item switch can leave the newly created button with its generic `aria-label="Play"` while the suite and plan report this regression as caught.

   Suggested fix: switch items without changing state and assert the new item-specific label/icon. Until that test exists, revise the plan’s “all seven” claim.

7. **Low — `FakeResizeObserver` does not enforce real teardown or delivery ordering.**

   Evidence: `resize()` invokes the callback synchronously and still does so after `disconnect()` empties its targets at [scripts/test-fake-dom.mjs:257](/home/renedebos/renedebos.com-player-consolidation/scripts/test-fake-dom.mjs:257).

   Why it matters: lifecycle tests using this fake cannot detect callbacks delivered around detach or accidentally invoked after observation ends.

   Suggested fix: queue delivery and make it a no-op when disconnected or targetless; add a detach-before-delivery test.

**Verification during this review**

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks.
- All `node scripts/test-*.mjs` files — passed: 302/302 executable tests; `test-fake-dom.mjs` loaded successfully as a harness-only module.
- `python3 scripts/verify_markup.py` — passed: 1,427 items across 166 pages.
- `python3 scripts/verify_markup.py --check-allowlist-coverage` — passed.
- `node --check` on the three changed JavaScript files, source↔asset `cmp`, and scoped `git diff --check` — passed.
- Focused detach/remount, unknown-duration, same-ID replacement, no-change seek, and queue-start Previous probes — reproduced the findings above.
- Controls-cache invalidation mutation run — unexpectedly passed 20/20, disproving the plan claim.
- `NODE_PATH="$(npm root -g)" node scripts/browser_check.mjs` — could not run in this read-only environment: Playwright failed creating `/tmp/playwright-artifacts-*` with `EROFS`; WebKit was also unavailable.
_Review generated 2026-08-16 11:02:18 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-16)

All seven verified by direct reproduction against the committed code (probe
script, not inspection). **Six confirmed, one accepted in half.** Nothing was
declined outright — an unusually clean round for the reviewer, and worth
noting that this stage's *new-surface* work drew a different class of finding
than the ownership module's rounds 6–12 did (lifecycle and UI-state bugs, not
storage races), exactly as the plan predicted when it warned that round 6–12's
threat model would not transfer to Task 2.

1. **CONFIRMED (High).** Reproduced all three halves: after `unmount()` the bar
   keeps `hidden=false` with 1288 chars of stale markup; after remounting the
   same instance the height variable is still absent, and a click on the play
   button leaves the controller untouched (`paused` unchanged) because
   `QueueView`'s single `AbortController` was permanently aborted by the first
   `onDetach()`. The remount path is on the recorded Close contract ("a later
   genuine `play` brings it back"), so this is reachable by design, not
   hypothetically. Note the one-shot-`AbortController` shape is inherited from
   `player-views.js`/`playlist-views.js`, where it is harmless because no view
   is ever remounted; the mini-player is the first view with a real
   detach/reattach cycle. Fix: fresh `AbortController` per `onAttach()`, and
   `onDetach()` resets render state + hides the root so a remount rebuilds.
2. **CONFIRMED (Medium).** A `durationSec:null` item shows a permanent `0:00`
   total while the range announces `0:05 of 4:05` from the resolved
   `audio.duration` — the visible UI and the accessible name disagree for
   exactly the items the schema says may be nullable.
3. **CONFIRMED (Medium).** A same-id item carrying fresh metadata keeps the old
   title *and the old `href`* (`Old Title` / `/shows/old/` after a `setQueue()`
   with `New Title` / `/shows/new/`). Cosmetic in effect, but the stale link is
   the sharp edge: the bar would send the listener to a page for a track the
   controller is no longer playing.
4. **CONFIRMED (Medium).** Pressing the thumb and releasing without moving it
   emits no `change`, so `_seeking` stays true for the rest of the track:
   reproduced with the range frozen at `0` and `aria-valuetext` at `0:00 of
   3:20` while the visible current time read `1:40`. **This is the same
   mousedown/touchstart-plus-`change` shape `player-views.js` and
   `playlist-views.js` already ship** — the finding is correct about the
   mini-player and, unprompted, identifies a live bug in two shipped surfaces.
   Fixing those two is a separate decision for Rene, not part of Task 2.
5. **CONFIRMED (Low).** Verified against the code it compares to:
   `continuous-player.js:206,273` call `playAt(idx - 1)`, and `playAt()` clamps
   `i < 0` to `0` and plays — so the popup restarts track one, while
   `controller.prev()` no-ops before index 0. `PlaylistNowPlayingView._prev()`
   already implements the restart parity for the same reason. Adopting it here
   is consistency with two existing surfaces, not a new policy.
6. **CONFIRMED (Low), both halves.** Ran the reviewer's mutation: removing all
   three `this._lastControlsKey = null` invalidations passes 20/20. The
   mutation this session actually ran was a *weaker* one (pinning the cache key
   to a constant), which is not the same property, so the plan's "all seven
   mutation-checked" is an overclaim and will be corrected rather than
   defended. The defect it hides is real and reachable: a `removeAt()` that
   changes the item while `state` stays `'paused'` leaves the new button
   labelled generically `"Play"` instead of `"Play Song b"` — confirmed under
   the mutation.
7. **ACCEPTED IN PART (Low).** Making `resize()` a no-op once `disconnect()`
   has run is worth the one line: a fake that behaves unlike the platform is
   how a confidently-wrong test comment gets believed later (this session's own
   gotcha). It also turns the existing disconnect assertion from a flag check
   into a behavioural one. **Declining the async-delivery half** — queueing
   delivery would force every height test to await for no property under test,
   and the view already nulls `_ro` at teardown so it has no post-disconnect
   path of its own.

Not attempted by this review: `browser_check.mjs` (the sandbox is read-only,
so Playwright could not write its artifacts). The bar is not emitted into any
page yet, so there is nothing for it to check on this task regardless — it
becomes load-bearing at Task 6.

### Applied (Claude, 2026-08-16)

All six confirmed findings fixed, plus the accepted half of 7. Suite went
20 → 28 tests; 310/310 across all suites on Node 20 and simulated Node 24.
Every fix below was mutation-checked — the mutation named for it was applied
and the test written for it failed.

1. **FIXED.** Fresh `AbortController` per `onAttach()`, and `onDetach()` now
   hides the bar, drops its markup and resets render state so a remount
   rebuilds and re-observes height. One test drives unmount → remount and
   asserts the bar is visible, its height republished, and a play click
   actually reaching the controller. Three separate mutations fail it
   (reusing the controller, skipping the hide, skipping the state reset).
2. **FIXED.** The displayed total now derives from the same resolved duration
   the range announces, so the two cannot disagree; mutation (reading
   `item.durationSec` instead) fails the new null-duration test.
3. **FIXED.** Metadata — title, `href`, meta line, total, the range's
   `aria-label`, and the play button's accessible name — is patched whenever
   it differs, keyed on the fields themselves rather than on `id`. The
   focus-bearing buttons are untouched by a metadata change (asserted).
   Mutation (keying on `item.id`) fails two tests. **Bonus from the split:**
   the markup template interpolates nothing, so `esc()` was deleted — there is
   no escaping left to get wrong.
4. **FIXED.** `mouseup`/`pointerup`/`pointercancel`/`touchend`/`touchcancel`
   on the **document** (a drag routinely ends outside the control), scoped to
   the attachment's abort signal. Two tests: press-and-release-without-moving,
   and release-outside / cancel. Mutation (dropping the listeners) fails both.
5. **FIXED.** `_prev()` mirroring `PlaylistNowPlayingView`'s: >3 s restarts,
   index > 0 steps back, index 0 restarts and plays. Two tests; mutation
   (calling `controller.prev()` directly) fails the queue-start one. The
   shared primitive is untouched.
6. **FIXED, and the reviewer was right twice over.** The missing test exists
   and asserts the property end-to-end. But the interesting part is what
   writing it exposed: a first attempt reasoned that two ids with identical
   metadata would make `_patchMeta()` early-return, leaving the rebuild
   branch's invalidation load-bearing. **That reasoning is wrong** —
   `_buildStructure()` clears `_lastMetaKey`, so `_patchMeta()` always writes
   after a rebuild and always invalidates the controls key itself. A mutation
   run contradicted the claim within a minute (both single-line mutations
   passed 28/28); removing **both** paths does fail the test. The wrong
   reasoning is now recorded in the code comment rather than quietly deleted,
   and the plan's "all seven mutation-checked" line is corrected to "six",
   with the seventh stated at the precision the evidence actually supports.
   That is the second time this stage that a confidently-written claim about
   *other* code's behaviour was falsified by running it instead of arguing it.
7. **HALF APPLIED, as dispositioned.** `FakeResizeObserver.resize()` is now a
   no-op once `disconnect()` has run, and the unmount test asserts that
   behaviourally instead of reading the flag. Async delivery still declined.

Also fixed en route, not a review finding: a literal `0x1f` control byte had
ended up inside the metadata-key separator string, typed as a character rather
than an escape. It is now written as a `\u001f` escape, and the verification
sweep is widened from NUL only to every C0 control character except
tab/newline/CR — the NUL incident recorded in `HANDOFF.md` is the same hazard
one byte over, and this one survived a full green test run without complaint.

Not fixed here, deliberately: the shared one-shot-`AbortController` shape and
the `change`-only seek-end in `player-views.js` / `playlist-views.js`. Finding
4 is a live bug in both shipped surfaces; touching them is Rene's call and a
separate change, since they are on every show, song and playlist page.

---

## Stage 3a-canary Phase A Task 2 post-fix review — 2026-08-16

1. **Medium — Persisted sessions lose the venue that `MiniPlayerView` expects to render.**

   Evidence: [`trackMeta()`](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-views.js:35) includes `item.venue`, but [`encodeItem()`](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:101) and [`decodeItem()`](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:145) omit it. The tests bypass persistence by constructing fixtures containing `venue` directly at [`test-miniplayer-views.mjs:29`](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-views.mjs:29). A real `buildEnvelope()` → JSON → `decodeEnvelope()` → `restoreSession()` probe rendered `Jerry Hannan · 1999-05-27`, silently dropping `Cafe Java`.

   Why it matters: cross-navigation restoration is the feature’s core path. On a page with no fresh page-owned queue to replace the restored item, the missing venue persists indefinitely. This also contradicts `miniplayer-state.js`’s claim that its slim codec omits only fields the mini-bar never renders and the plan’s assertion that Task 2 is done.

   Suggested fix: add a bounded `venue` field to both codec directions and add an integration test that round-trips a realistic item through the envelope codec before rendering it.

2. **Medium — Untrusted persisted `pageUrl` values become executable or external links without validation.**

   Evidence: persisted URLs receive only length truncation at [`miniplayer-state.js:77`](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:77) and [`miniplayer-state.js:161`](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:161); `normalizeItem()` also accepts them verbatim at [`player-controller.js:106`](/home/renedebos/renedebos.com-player-consolidation/scripts/player-controller.js:106). `_patchMeta()` then assigns the value directly to `href` at [`miniplayer-views.js:274`](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-views.js:274). A probe produced `href="javascript:globalThis.__clicked=1"`. This conflicts with the plan’s explicit treatment of `localStorage` as untrusted input at [`player-consolidation-plan.md:640`](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:640).

   Why it matters: corrupted, hand-edited, or obsolete persisted state can turn the mini-player’s prominent title into an unexpected navigation or stored script URL.

   Suggested fix: validate persisted `pageUrl` values as root-relative site paths—reject blank-excepted values beginning with `//`, containing a non-HTTP scheme, or resolving off-origin—and repeat that validation at the rendering boundary. Add `javascript:`, protocol-relative, and external-origin fixtures.

3. **Low — `_patchMeta()`’s delimiter-based cache key can collide and leave stale metadata.**

   Evidence: [`miniplayer-views.js:271`](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-views.js:271) joins untrusted strings using `\u001f`, while the persisted codec preserves that character. Two same-ID items with `(title, pageUrl)` values `("a\u001fb", "c")` and `("a", "b\u001fc")` generate the same key. A probe left the first title and link rendered while `controller.currentItem` held the second. This disproves the applied-review claim that metadata is patched “whenever it differs” at [`player-consolidation-codex.md:5158`](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-codex.md:5158).

   Why it matters: this is a mirror-image bug introduced by the stale-metadata fix itself. It is unlikely with generated catalog data but reachable through the explicitly untrusted persistence path.

   Suggested fix: cache `JSON.stringify([title, pageUrl, meta, total])` or retain and compare the individual output fields. Add a delimiter-containing regression fixture.

4. **Low — Unknown-date tracks regress the metadata shown by both replaced queue surfaces.**

   Evidence: [`trackMeta()`](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-views.js:35) simply filters away a missing date. The popup being replaced renders `"unknown date"` at [`continuous-player.js:92`](/home/renedebos/renedebos.com-player-consolidation/scripts/continuous-player.js:92), as does the current playlist view at [`playlist-views.js:74`](/home/renedebos/renedebos.com-player-consolidation/scripts/playlist-views.js:74). The real catalog contains 18 null-date tracks, while every mini-player fixture supplies a date.

   Why it matters: these real tracks display less information after the mini-player migration, and the convenient fixture hides the parity regression.

   Suggested fix: use `item.dateDisplay || item.date || 'unknown date'` and add a fixture derived from an actual null-date catalog row.

5. **Low — The item-change test still claims to isolate a cache invalidation that it does not test.**

   Evidence: [`test-miniplayer-views.mjs:540`](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-views.mjs:540) says `_patchMeta()` early-returns and deleting the rebuild branch’s `_lastControlsKey = null` fails the test. In reality `_buildStructure()` clears `_lastMetaKey` at [`miniplayer-views.js:250`](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-views.js:250), forcing `_patchMeta()` to run and independently invalidate the controls key at line 287. Mutation probes produced:

   - rebuild invalidation removed: `Play Kilkelly Ireland`
   - metadata invalidation removed: `Play Kilkelly Ireland`
   - both removed: generic `Play`

   Why it matters: the test passes for a different reason than its commentary states, recreating the exact false mutation-confidence problem the first review identified. The plan correctly says only removing both paths fails, but the suite still contradicts it.

   Suggested fix: remove the redundant rebuild invalidation and correct the test commentary, or explicitly mutation-test both removals together. Prefer including the title in the controls cache key so the dependency is direct.

6. **Low — Touch seek-release coverage uses an impossible mixed event sequence.**

   Evidence: the production path begins touch seeking on `touchstart` at [`miniplayer-views.js:116`](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-views.js:116), but the cancellation test starts every iteration with `mousedown` and then dispatches `touchcancel` at [`test-miniplayer-views.mjs:479`](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-views.mjs:479). No test dispatches `touchstart`; deleting that listener leaves the suite green.

   Why it matters: the document-level release listeners are covered for mouse state, but the mobile lifecycle they purport to prove is not.

   Suggested fix: test coherent `touchstart → timeupdate → touchend/touchcancel` sequences, including an assertion that progress remains frozen before release and resumes afterward.

**Verification during this review**

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks.
- All `node scripts/test-*.mjs` suites — passed: 310/310.
- `python3 scripts/verify_markup.py` — passed: 1,427 items across 166 pages.
- `python3 scripts/verify_markup.py --check-allowlist-coverage` — passed: all 30 public shows covered.
- `node --check` on the Task 2 JavaScript files, scoped and worktree-wide `git diff --check` — passed.
- `cmp scripts/miniplayer-views.js assets/miniplayer-views.js` — passed; the registered build asset is byte-identical.
- Focused persisted-codec, cache-collision, unsafe-URL, and cache-invalidation mutation probes — reproduced the findings above.
_Review generated 2026-08-16 11:51:09 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-16)

**All six confirmed by independent reproduction.** This was the deliberately
broad round the project's own record says to run after a narrow one, and it
earned its keep: findings 1 and 4 are *contract* breaks between Task 2's view
and code that shipped in 3a-foundation, which no amount of scrutiny of
`miniplayer-views.js` alone would have surfaced, and finding 3 is precisely
the "a fix opens its own mirror-image bug" pattern this round was asked to
look for — introduced by the previous round's own metadata fix.

1. **CONFIRMED (Medium).** A real `buildEnvelope()` → JSON → `decodeEnvelope()`
   → `restoreSession()` round trip renders `Jerry Hannan · 1999-05-27`: the
   persisted item's keys are `id, kind, streamUrl, title, artist, dateDisplay,
   durationSec, playLabel, pageUrl` — no `venue`. Every test fixture builds
   items directly and so never crosses the codec, which is why the suite is
   green. Note the second half of the damage: `encodeItem()`'s own comment
   says it "omits every field a mini-bar never renders." That was *true* when
   3a-foundation wrote it and Task 2 falsified it, so the comment must move
   with the fix. Restoration across navigation is this feature's whole point,
   so this is a genuine "Task 2 is not done" finding, not a nicety.
2. **CONFIRMED (Medium), with the threat model stated honestly.** Reproduced
   at both boundaries: the codec preserves `javascript:alert(1)` verbatim, and
   `_patchMeta()` assigns it straight to `href`. It is **not** a live exploit
   path — `localStorage` is same-origin, so anything able to write it can
   already run script on the page — which is why this is Medium rather than
   High. It is still worth closing: `decodeItem()`'s stated contract is that it
   re-validates everything *precisely because* the value may not have come
   from `encodeItem()` at all, and a scheme that executes is exactly the class
   of value that contract exists to reject. Fix at both ends (root-relative
   paths only), not just the render boundary.
3. **CONFIRMED (Low), and it is my own fix's mirror image.** Reproduced only
   after correcting my first attempt's construction — the colliding pair has
   to move the separator across the field boundary (`title:"A\u001fB",
   pageUrl:"/one/"` vs `title:"A", pageUrl:"B\u001f/one/"`). With those, the
   bar keeps rendering the OLD title and the OLD href while
   `controller.currentItem` holds the new one. Unreachable from generated
   catalog data; reachable through the explicitly-untrusted persistence path.
   `JSON.stringify` removes the class of bug rather than picking a rarer
   delimiter.
4. **CONFIRMED (Low).** Verified against the real catalog, not the claim:
   `assets/tracks.json` has exactly 18 rows with no `showDate`, all of them
   the `sean-19-broadway-unknown-*` set. The bar renders
   `Jerry Hannan · 19 Broadway`, while both surfaces it replaces render an
   explicit `unknown date` (`continuous-player.js`, `playlist-views.js`). A
   parity regression on real content, hidden by fixtures that all carry a date.
5. **CONFIRMED (Low), and this one is squarely mine.** The previous round
   caught the same wrong reasoning; I corrected it in `miniplayer-views.js`
   and left the identical falsified claim standing in the test's own comment,
   which is the "a test comment can be confidently wrong about the harness"
   gotcha repeating within one session. Taking the reviewer's *stronger*
   suggestion rather than just editing prose: put the title into the controls
   cache key so the button's label depends on it directly, keep the rebuild
   invalidation (fresh nodes genuinely need it), and drop `_patchMeta()`'s
   cross-invalidation — then each path is individually mutation-checkable and
   the redundancy that made the claim untestable is gone.
6. **CONFIRMED (Low).** Verified by mutation rather than by reading: deleting
   the `touchstart` listener outright leaves the suite at 28/28. The touch
   iteration of the release test opens with `mousedown`, so the mobile
   lifecycle it claims to cover is never exercised.

Nothing declined this round. Fixes are not applied here — this is the review
step only.

### Applied (Claude, 2026-08-16)

All six fixed. Suites: 28 → 32 (views) and 122 → 125 (state); **310 → 317
across the whole set**, green on Node 20 and simulated Node 24. Twelve
mutations were run against the fixes; **eleven were caught**, and the one that
was not is documented below rather than papered over.

1. **FIXED.** Bounded `venue` on both codec directions, plus the comment that
   had gone stale under it. No `ENVELOPE_VERSION` bump: an envelope written
   before this decodes to `venue: null`, which is exactly what a genuinely
   venue-less item yields, so one read path handles both and there is no
   migration to get wrong (a test pins that). Three mutations caught, including
   dropping venue from the read path alone. The views suite now imports the
   real `buildEnvelope`/`decodeEnvelope` for one test that crosses the codec
   end to end — the structural fix for *how* this hid, not just for the field.
2. **FIXED at both ends.** `boundedPath()` in the codec (read and write) and
   `isSitePath()` at the render boundary: root-relative only, which rejects
   every scheme, protocol-relative `//host`, and off-origin address in one
   check. Four mutations caught, including allowing `//host` through alone.
   The two rules are duplicated rather than shared because this view imports
   `player-controller.js` and nothing else, deliberately; three lines is
   cheaper than that property.
3. **FIXED.** `JSON.stringify` for the metadata cache key. The regression test
   uses the exact colliding pair (a separator moved across a field boundary)
   and fails when the delimiter join is restored.
4. **FIXED.** `'unknown date'` fallback, matching `playlist-views.js` and
   `continuous-player.js`. Test built from a real null-date catalog row shape.
5. **FIXED, by construction rather than by rewording.** The controls cache key
   is now `verb|state|title` and `_patchMeta()` no longer reaches over to null
   it, so the rebuild-branch invalidation is individually mutation-checkable —
   removing that one line now fails the identical-metadata test, which it did
   not before. The test comment is corrected, and records that its earlier
   version was wrong.

   **The one uncaught mutation.** Removing `+ item.title` from the key leaves
   all 32 tests green. Every reachable title change today arrives with either a
   rebuild (new id) or a state transition (`setQueue()` always moves state),
   either of which rewrites the label anyway, so no test can distinguish the
   two shapes. The title stays in the key as construction, not as a tested
   property, and the code comment says exactly that — the coordinator will soon
   feed this view metadata restored from storage, which is where a same-id,
   same-state title change becomes reachable. Recorded here so a later round
   does not "discover" the same gap and treat it as new.
6. **FIXED.** The release test now walks four coherent pairs
   (`mousedown→mouseup`, `mousedown→pointerup`, `touchstart→touchend`,
   `touchstart→touchcancel`) and asserts the range is frozen *before* release
   as well as moving after it. Deleting either the `touchstart` listener or the
   document-level release listeners now fails it; before, deleting `touchstart`
   left the suite at 28/28.

Verification: `build.py --check`, `build.py` (with its generated-markup check),
`verify_markup.py --check-allowlist-coverage`, `node --check` on both changed
modules, source/asset `cmp` for both, and the C0-control-byte sweep — all
clean. No generated HTML changed; the bar still is not emitted into any page.

Note for whoever reads this next: `miniplayer-state.js` was modified for the
first time since its twelve-round hardening. Both changes are additive
validation inside the codec's own stated contract, its full suite passes
(125/125), and no ownership/lease code was touched.

---

## Stage 3a-canary Phase A Task 2 third-round review — 2026-08-16

1. **Medium — The new root-relative URL guard still accepts paths browsers resolve off-origin.**

   Evidence: [`boundedPath()`](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:96) and [`isSitePath()`](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-views.js:45) reject only a literal second `/`. They accept `"/\\evil.test/shows/a"`, which the URL parser resolves to `https://evil.test/shows/a`; `"/\n/evil.test/"`, `"/\r/evil.test/"`, and `"/\t/evil.test/"` similarly become protocol-relative after URL preprocessing. The codec and view tests cover `//evil`, schemes, and absolute URLs, but none of these normalized forms ([state test](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-state.mjs:295), [view test](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-views.mjs:533)). This contradicts the plan’s claim that only root-relative paths survive at both boundaries ([plan](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:2220)).

   Why it matters: a persisted or controller-supplied value can still turn the title into an external navigation despite the newly documented boundary.

   Suggested fix: require a leading `/`, parse against a trusted sentinel/current origin with `new URL()`, and compare the resulting origin; reject parse failures. Apply the semantic check in both codec directions and at render time. Add `/\\evil.test/` plus tab/newline-before-second-slash cases.

2. **Medium — Previous on an already-playing first track can leave controller state permanently `loading`; the fake audio makes the regression pass.**

   Evidence: `_prev()` seeks and then unconditionally calls `controller.play()` at queue index zero ([miniplayer-views.js:167](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-views.js:167)). `_playIndex()` immediately changes state to `loading` ([player-controller.js:791](/home/renedebos/renedebos.com-player-consolidation/scripts/player-controller.js:791)), relying on a later `playing` event to restore `playing`. For an already-playing media element, the HTML internal play steps resolve the new play promise without firing another `play`/`playing` event ([WHATWG HTML Standard](https://html.spec.whatwg.org/multipage/media.html#internal-play-steps)). By contrast, `FakeAudio.play()` always queues both events, even when `paused` is already false ([test-fake-dom.mjs:280](/home/renedebos/renedebos.com-player-consolidation/scripts/test-fake-dom.mjs:280)). A spec-shaped fake reproduced `state:"loading", paused:false, currentTime:0`; the current regression test only asserts position and `paused` ([test-miniplayer-views.mjs:584](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-views.mjs:584)).

   Why it matters: audio continues while the UI remains in its loading presentation, and the future coordinator may persist play intent from state that no longer matches audible playback.

   Suggested fix: after seeking, call `play()` only when the element is paused or the controller is recovering from `error`; an already-playing track needs only `seek(0)`. Make `FakeAudio.play()` emit transition events only on a paused-to-playing transition, then test both paused and already-playing queue-start Previous behavior, including controller state.

3. **Low — Duplicate attachment registers duplicate controls and leaks the older attachment through teardown.**

   Evidence: each `onAttach()` overwrites `_abort` with a fresh controller without aborting the previous one ([miniplayer-views.js:68](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-views.js:68)), while `PlaybackController.mount()` invokes `onAttach()` even when its `Set` already contains the view ([player-controller.js:686](/home/renedebos/renedebos.com-player-consolidation/scripts/player-controller.js:686)). The remount test covers unmount-then-mount only ([test-miniplayer-views.mjs:399](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-views.mjs:399)). A duplicate-mount probe made one Play click play and immediately pause, and after unmount one click listener remained.

   Why it matters: an overlapping coordinator mount call can make apparently live controls do nothing; teardown then no longer removes every listener created by the view.

   Suggested fix: make `PlaybackController.mount()` idempotent by skipping `onAttach()` when the view is already mounted, or defensively abort the prior attachment before replacing `_abort`. Add a mount-twice test asserting one command per click and complete teardown.

4. **Low — `MiniPlayerView` renders `date`, but the persistence projection cannot carry it.**

   Evidence: `trackMeta()` falls back from `dateDisplay` to `date` ([miniplayer-views.js:49](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-views.js:49)), and the documented playable schema permits both independently ([plan](/home/renedebos/renedebos.com-player-consolidation/plans/player-consolidation/player-consolidation-plan.md:293)). However, both codec directions carry only `dateDisplay` ([encode](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:138), [decode](/home/renedebos/renedebos.com-player-consolidation/scripts/miniplayer-state.js:183)). A date-only item became `unknown date` after an envelope round trip. The venue integration fixture supplies `dateDisplay`, while the unknown-date fixture nulls both fields, so neither catches this ([test-miniplayer-views.mjs:517](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-views.mjs:517), [test-miniplayer-views.mjs:566](/home/renedebos/renedebos.com-player-consolidation/scripts/test-miniplayer-views.mjs:566)).

   Why it matters: the codec’s claim that it omits only fields the bar never renders is still mechanically false. Current producers populate `dateDisplay`, so this is presently a contract/future-input gap rather than a catalog regression.

   Suggested fix: persist a bounded nullable `date` in both directions and add a date-only envelope-to-render regression test, or remove `date` as a supported view/schema fallback and standardize producers on `dateDisplay`.

**Verification during this review**

- `python3 scripts/build.py --check` — passed: 31 shows, 680 curated tracks.
- Every `node scripts/test-*.mjs` suite — passed: 317/317; `test-fake-dom.mjs` loaded successfully as a harness-only module.
- `python3 scripts/verify_markup.py` — passed: 1,427 items across 166 pages.
- `python3 scripts/verify_markup.py --check-allowlist-coverage` — passed: all 30 public shows covered.
- `node --check` on all five requested JavaScript files, source-to-asset `cmp`, and `git diff --check 940a1a6...HEAD` — passed; worktree remained clean.
- Focused URL, date-round-trip, spec-shaped media, and duplicate-mount probes — reproduced all four findings.
- Headless Chromium probe — could not launch because Playwright could not create `/tmp/playwright-artifacts-*` on the read-only filesystem (`EROFS`).
_Review generated 2026-08-16 12:16:16 PDT by `scripts/codex_review.sh` (codex exec, read-only)._

### Disposition (Claude, 2026-08-16)

**All four confirmed by independent reproduction.** Two of them (1 and 2) are
defects in *the previous round's own fixes*, which is the pattern this project
has now hit repeatedly and the reason this round was scoped broadly rather than
as a re-verification pass.

1. **CONFIRMED (Medium) — my own fix's stated property is false.** Reproduced
   against Node's WHATWG URL parser, which is the same algorithm browsers use:
   `"/\evil.test/shows/a"` passes both guards and resolves to
   `https://evil.test/shows/a`; `"/<TAB>/evil.test/"`, `"/<LF>/evil.test/"` and
   `"/<CR>/evil.test/"` do the same, because tab/newline/CR are *stripped*
   before parsing and what remains is protocol-relative. The last round wrote a
   character-level check and then documented it as "only same-origin
   root-relative paths survive"; a character check is not a URL parser, and the
   plan text asserting that property is wrong as written. Fix: keep the leading
   `/` requirement, then resolve against a sentinel origin with `new URL()` and
   require the resulting origin to match, rejecting parse failures — in both
   codec directions and at the render boundary, with these four shapes as
   fixtures.
2. **CONFIRMED (Medium) — and the harness is what hid it.** With a spec-shaped
   media element (WHATWG internal play steps fire `play`/`playing` only on a
   paused → playing transition), pressing Previous on an already-playing first
   track leaves `state: 'loading'` permanently while audio keeps playing:
   `_playIndex()` sets `'loading'` up front and waits for a `playing` event that
   never comes. `FakeAudio.play()` queues both events unconditionally, so the
   fake asserts a transition the platform does not make — the same class of
   problem as the fake `ResizeObserver` that outlived its own `disconnect()`.
   Fix: after `seek(0)`, call `play()` only when the element is actually paused
   (or the controller is recovering from `'error'`), and make `FakeAudio` model
   the transition rule. **Note the blast radius of the harness change** — four
   other suites use `FakeAudio`, so it must be re-run against all of them, and
   that is exactly the point of making it honest.
   **`PlaylistNowPlayingView._prev()` has the identical shape and is shipped**
   (`playlist-views.js`: `c.seek(0); c.play();` at index 0). Same live bug on
   `/playlist/` today. Flagged, not fixed here — same call as the seek-release
   bug in the shipped views.
3. **CONFIRMED (Low).** `PlaybackController.mount()` calls `onAttach()` even for
   a view already in its `Set`, and the per-attachment `AbortController` added
   last round replaces its predecessor without aborting it. Probe: one Play
   click on a doubly-mounted view fired two handlers — toggling twice, so the
   audio ended exactly where it started, a control that looks live and does
   nothing. The first attachment's listeners also survive `unmount()`. Fix
   defensively in the view (abort the previous controller before replacing it);
   making `mount()` idempotent in `player-controller.js` is the tidier fix but
   touches shared code every page runs, so it is a separate decision.
4. **CONFIRMED (Low).** Reproduced end to end: a date-only item renders
   `Jerry Hannan · Cafe Java · 1999-05-27` before persistence and
   `Jerry Hannan · Cafe Java · unknown date` after a round trip, because the
   codec carries `dateDisplay` only. Verified this is **not** a live regression:
   all 1,427 generated items carry `dateDisplay`, so no current producer hits
   it. It is the *same contract gap as venue*, one field over — which is the
   real finding, since venue was supposed to be the last of these. Fix by
   carrying a bounded nullable `date` too, restoring the invariant "whatever the
   bar renders, the codec can carry", rather than by narrowing the view.

Nothing declined. Fixes are not applied here — this is the review step only.

### Applied (Claude, 2026-08-16)

All four fixed, plus three defects that applying them uncovered. Suites went
317 → 327 (miniplayer-views 32→38, miniplayer-state 125→126, player-controller
58→60, playlist-views 15→16), green on Node 20 and simulated Node 24. (The
commit message for this work says 328; it was arithmetic, not a lost test —
the per-suite figures above are the counted ones.) **Nine
mutations run, nine caught.**

1. **FIXED.** Both boundaries now resolve with `new URL()` against a sentinel
   origin (`https://miniplayer.invalid`, reserved TLD) and compare origins,
   instead of inspecting characters. All four reported shapes are rejected, and
   an ordinary path with a space, query and fragment still passes — the rule is
   about origin, not tidiness. The previous round's "only root-relative paths
   survive" wording was false as written; it is true now, and the code comment
   records why a character check cannot answer this question.
2. **FIXED — and it turned out to be the smallest part of the finding.** The
   view now calls `play()` only when the element is actually paused (or the
   controller is in `'error'`, the retry path). The reported symptom is gone,
   but making `FakeAudio` honest is what mattered:
   - `play()` fires `play`/`playing` only on a paused → playing transition, and
     assigning `src` sets `paused = true` (the media load algorithm). Both are
     what the platform does; the fake did neither.
   - That turned **five tests red across four suites**. Four had been relying on
     the lie and pass again once `src` models the load algorithm (a genuine
     track change really is a transition). The fifth was a **live bug on
     `/playlist/`**: `PlaylistNowPlayingView._prev()` had the identical
     unconditional `play()`, so pressing Prev on track 1 of a playing queue left
     `#pl-now` stuck in its loading presentation for the rest of the track —
     shipped since Phase 2, with a green test throughout. Fixed with the same
     guard.
   - It also produced a **nondeterministic** failure, ~1 run in 20, in
     `/playlist/`'s endless-rollover test. Diagnosed rather than retried: when
     the reshuffle happens to put the just-finished track back at index 0,
     `_playIndex()` assigns no `src` (same item), so there is no load, and the
     element was never paused, so there is no `play` event either — the
     controller sat in `'loading'` forever while audio played. **That is a
     `player-controller.js` defect**, equally reachable through repeat-one's
     replay. Fixed at the controller: a replay that neither reloads nor
     transitions sets `'playing'` itself. Two new tests, one of which asserts
     that an ordinary track change still goes through `'loading'` — the
     correction must not short-circuit the normal path.
   - Because the controller fix cures the visible symptom, the two view-level
     guards are no longer provable through state. They are still worth keeping
     and are pinned on the property that IS view-local: a needless `play()`
     mints an ownership `play-attempt` (Task 0.1's contract) and clears
     `lastPlayError`. Both tests assert `ownershipSeq` is unchanged, and both
     fail when their guard is removed.
3. **FIXED.** `onAttach()` aborts the outgoing `AbortController` before
   replacing it. Two tests: one click on a doubly-mounted view performs exactly
   one toggle, and teardown removes listeners from every attachment.
   `PlaybackController.mount()` itself is left alone — making it idempotent is
   the tidier fix but touches shared code every page runs, and the view-level
   guard is sufficient and local.
4. **FIXED.** Bounded nullable `date` in both codec directions, tested at the
   codec and end-to-end through a render. The codec comment now states the
   invariant plainly — *if MiniPlayerView renders a field, this projection
   carries it* — because "omits only what the bar never renders" had by then
   been wrong twice.

**Files changed outside Task 2**, all shipped surfaces, each small and directly
tested: `player-controller.js` (the silent-resume state correction),
`playlist-views.js` (the same `_prev()` guard), and both fakes. A harness
contract test now pins `FakeAudio`'s two spec rules so the fidelity cannot be
quietly reverted — the fake is load-bearing evidence now, not scaffolding.

Verification: 327/327 on Node 20 and simulated Node 24; the two suites that
flaked were each run 25 more times with zero failures; `build.py --check`,
`build.py`, `verify_markup.py --check-allowlist-coverage`, `node --check` and
source/asset `cmp` on all four changed modules, and the control-byte sweep —
all clean. No generated HTML changed.

Also kept: `browser-check-miniplayer.draft.mjs`, the spec-ahead `browser_check`
scenario this review round left in `plans/`. Not wired into any run path (the
bar is emitted into no page yet); it is a Phase C starting point, retained at
Rene's instruction.

**This closes Task 2's review sequence.** Three rounds: seven findings, then
six, then four — and this round's two most serious were defects introduced by
the previous round's fixes, which is the documented signal that the loop has
stopped finding pre-existing problems and started chasing its own tail. The
validation this code needs now is a real consumer (Task 4/5) and a browser,
not a fourth adversarial pass.
