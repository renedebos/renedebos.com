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
