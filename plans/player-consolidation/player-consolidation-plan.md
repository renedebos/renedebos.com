# Player consolidation: Feature Proposal

Status: **in progress.** Rollout is incremental, one surface at a time —
see §6. Phase 1 (show pages) Steps 1–4 are built: `PlaybackController`, the
view layer, the `data-item` markup every show page carries, and
`player-boot.js` — 61 passing deterministic tests across
`test-player-controller.mjs` (22), `test-player-views.mjs` (16) and
`test-player-boot.mjs` (23). **Three show pages now run the new engine**
(the allowlist in `pages.CONTROLLER_ENGINE_SLUGS`); the other 27 and every
song page are byte-identical to before. **Step 4 is done, including its
browser pass** (2026-08-14, `scripts/browser_check.mjs`, 44/44 against real
Chromium — see §6 Step 4's entry for the full record, including the
corrected, policy-dependent framing of deep-link autoplay). **Step 5a is
also done**: PR #3 merged (`7872882`), deployed, and verified against real
production — see §6 Step 5's entry for the full record, including a ninth
review's findings and fixes made after 5a shipped. The controller engine is
genuinely live on the 3 allowlisted pages today.
Mockup: https://claude.ai/code/artifact/71ae2166-d3ed-471d-9719-abd73fe353ba
Reviewed by Codex eight times, all recorded in
`player-consolidation-codex.md`: the first pass on the original proposal,
followed by reviews of the concrete plan, live controller, view layer, two of
the Step 3 markup, and the built Step 4 implementation. From the fifth review
onward these are produced by `scripts/codex_review.sh` (see §7). This
revision folds in the accepted findings from all seven (noted
inline) and trims process-heavy asks (formal cross-browser test suite, full
CI matrix) down to something proportionate for a two-person hobby project —
while still keeping a real, re-runnable regression suite for the parts that
are actually state-machine logic (§3).

The third review's three migration blockers are resolved: the queue-origin
contract that keeps the Hero card from stranding the track queue (§2), and
the two sequencing corrections to Steps 4 and 5 that would otherwise have
double-initialized players and broken untouched song pages/`/playlist/`
(§6). So are the fourth's (four view-layer defects — see Step 2's record in
§6) and the fifth/sixth's, which between them caught a dead retry condition,
a download schema publishing guaranteed-403 URLs and mislabelling 64 WAVs as
FLAC, an unenforced peaks invariant, an overstated test fixture, and a Step 4
design that would have degraded to silence instead of falling back. The
seventh, against the built Step 4 code, found a destroyed controller that
could be reactivated by a leaked listener (fixed with a real `_destroyed`
guard plus a shared `AbortController` in `player-boot.js`, both proven
independently necessary — see Step 4's fifth revision), an unenforced
"every playable row carries a valid item" invariant (now a build failure,
matching how the peaks-coverage invariant already works), and an overclaim
about what a `wavesurfer.esm.js` failure specifically survives (corrected
throughout Step 4 below, not just here).

This single file is the project's one living plan document — architecture,
concrete design, and the running implementation checklist all in one place,
revised in place as work progresses (per this project's own `plans/`
convention: one `<topic>-plan.md` per initiative, not one file per phase).

## 1. Objective

Replace the site's four independent audio players with one shared
implementation, rendered at different densities depending on context. Add a
client-side loudness control and a small set of other player functions
along the way — loudness is currently a **fully deferred** later phase, not
part of the active work (see §4, §6).

**Clarified scope (Codex catch):** "one component" means one shared
implementation, not one browser-wide `<audio>` element. A normal page and
the `/player/` popup are separate documents and cannot share an in-memory
audio engine — each document gets its own controller instance, built from
the same module/state schema, still coordinated by `BroadcastChannel`.
*Within* one document, the target is one playback engine with multiple
views — a show page with many track rows plus a hero view should not create
an audio graph per row.

**Success criterion:** all current playback and handoff behavior survives
(see the parity checklist in §3), every document has at most one active
playback engine, and density changes affect presentation only, not
media/queue semantics.

## 2. Architecture

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
for the same change. Two of the four (`player.js`'s registry-based claim
and `continuous-player.js`'s simpler inline claim) already implement that
protocol two structurally different ways despite an identical wire format —
one of several small drifts consolidation fixes as a side effect (§3).

There are also existing lifecycle races worth designing out rather than
carrying forward: a `play()` promise can resolve after the user has picked
another track or another tab has claimed playback, and lazily-rendered song
rows add listeners with no unsubscribe path today. The shared engine uses a
generation token to ignore stale async results and gives views an explicit
mount/destroy API — built and regression-tested as of Phase 1 Step 1 (§3).

### Controller + views, three densities

- A `PlaybackController` per document owns the sole `<audio>` element,
  queue, current item/index, repeat/shuffle state, playback claim, Media
  Session integration, and error state. **Not** Web Audio/loudness state —
  that's a fully separate, deferred concern (Loudness control, below);
  nothing in the controller assumes it will ever exist.
- Compact, hero, and mini `PlayerView` instances subscribe to controller
  state and dispatch commands. They do not own media elements or audio
  graphs. A playing item can be reflected in its compact row *and* a
  mini/hero view simultaneously without duplicating playback.
- The `/player/` popup gets its own controller (separate document) using the
  identical module and state schema, in its own later migration phase.
- A small explicit state machine (`idle`, `loading`, `playing`, `paused`,
  `ended`, `error`) replaces icon-state changes scattered across event
  handlers.

**Runtime granularity — resolved, not an open question.** One controller
with many views. The alternative once considered (a simpler reusable view
class that still owns one audio element per instance) is rejected outright:
it contradicts the whole point of consolidation — one playback engine per
document — and isn't on the table for any phase.

**Concrete `PlaybackController` API** (built — `scripts/player-controller.js`):

```js
class PlaybackController {
  constructor({ audio = new Audio(), mediaSession = true } = {}) {}

  // queue
  setQueue(items, { startIndex = -1, autoplay = false } = {}) {}
  appendQueue(items) {}
  removeAt(index) {}
  reorder(fromIndex, toIndex) {}   // unused by show pages; intended foundation for /playlist//player/, parity not yet proven

  // transport
  play(itemOrIndex) {}    // plays something already in the queue (by index or matching id); no-ops otherwise
  playSingleton(item) {}  // explicit queue-REPLACING play — the Hero "Full Recording"/alternate-transfer card
  pause() {}
  toggle() {}
  stop() {}
  seek(seconds) {}
  seekBy(deltaSeconds) {}
  next() {}
  prev() {}                        // ">3s => seek 0" convention preserved

  // modes
  setRepeatOne(on) {}              // checked first in the 'ended' handler
  toggleShuffle() {}               // exact existing algorithm: shuffle only queue.slice(idx+1); off restores snapshot

  // views
  mount(view) {}
  unmount(view) {}

  // read-only
  get state() {}                   // 'idle'|'loading'|'playing'|'paused'|'ended'|'error'
  get currentItem() {}
  get currentIndex() {}
  get queue() {}
  get audioElement() {}            // exposed so a view's WaveSurfer instance can wrap it

  destroy() {}
}
```

**`play()` vs. `playSingleton()`.** An earlier design had `play(item)`
silently rebuild the whole queue to length 1 whenever the item wasn't
already in it — correct for the Hero card, but an id-mismatch bug anywhere
else would then silently discard the rest of the page's queue instead of
failing in a noticeable way (Codex catch, second review). `play(item)` now
only plays something already in the queue and no-ops if it isn't;
`playSingleton(item)` is the explicit, named queue-replacing operation
`HeroPlayerView` calls for the Full Recording / alternate-transfer card.
This is how the Hero's prev/next semantics resolve (a previously open
question): a standalone whole-show recording collapses the queue to length
1 via `playSingleton()`. **Corrected wording (a later Codex review flagged
this): "hides prev/next" describes conditional show/hide logic that doesn't
exist.** `recording_card()` never emits prev/next controls in Phase 1 at
all — there's nothing to hide, because nothing is ever rendered.
`HeroPlayerView` itself has no prev/next-related code whatsoever. The
`queue.length <= 1` framing below is the *contract a future non-singleton
Hero would have to satisfy*, not a mechanism Phase 1 implements.

**Queue-origin contract — what each context supplies, and how it switches.**
Codex's second review caught a real flaw here: `playSingleton()` discards
the queue, so if a track row then tried to resume with `play(item)`, the row
would be unqueued and correctly no-op — a dead-looking row. The rule that
resolves it, and which Step 2's views must follow:

| Context | Operation | Effect on the existing queue |
|---|---|---|
| Show-page track row (any row, any time) | `setQueue(allRowsInDomOrder, { startIndex, autoplay: true })` | **Replaces** — always re-asserts the show's own full track list, which is both correct for "click a track on a show page" and what makes returning from the Hero card work |
| Hero Full Recording / alternate transfer | `playSingleton(item)` | **Replaces** with a length-1 queue; prev/next unavailable |
| Lazily rendered song occurrence (future phase) | `playSingleton(item)` | **Replaces** — preserves today's singleton behavior; "all performances of this song" would be a deliberate later decision, not a side effect |
| `/playlist/` (future phase) | `setQueue(generatedOrRestoredQueue, …)` | **Replaces** |
| `/player/` handoff append (future phase) | `appendQueue(items)` | **Extends**, playback uninterrupted — matches today's `sendToPlayer()` merge semantics |

A track row must never call `play(item)` to start playback; `play()` is for
acting on something already known to be queued (Media Session handlers,
`next()`/`prev()`, a row click when the show queue is already loaded — where
re-asserting is harmless anyway). The three round-trip flows (Track → Hero →
Track, Hero → Track → Next, Alternate → Track) are regression-tested.

**Generation token** (`this._gen`): incremented in `setQueue()`,
`play()`/`playSingleton()`, `pause()`, and `stop()`. Every async
continuation (the `play()` promise's `.then`/`.catch`, and the WaveSurfer
upgrade path below) captures and checks it before acting, so a stale
promise from a superseded `play()` call can't clobber newer state — a real
race (rapid double-click between two rows) no current engine guards
against. Regression-tested in `scripts/test-player-controller.mjs`.

**BroadcastChannel claim protocol** — generalizes `player.js`'s
listener-registry shape (the more capable of the two existing
implementations) as a module-level singleton:

```js
let channel = null;
try { channel = new BroadcastChannel('hannan-playback'); } catch {}
const selfId = Math.random().toString(36).slice(2);
const listeners = new Set();
function claim(owner) {
  if (channel) channel.postMessage(selfId);
  listeners.forEach(l => { if (l.owner !== owner) l.fn(); });
}
function onExternalClaim(owner, fn) {
  const entry = { owner, fn };
  listeners.add(entry);
  return () => listeners.delete(entry);
}
if (channel) channel.onmessage = e => { if (e.data !== selfId) listeners.forEach(l => l.fn()); };
```

Each controller registers itself as one `owner` in its constructor and
unregisters in `destroy()`. `continuous-player.js`'s simpler inline
"pause on any message" shape (used once `/player/` migrates) is a strict
specialization — correct only because that page has exactly one controller
— and collapses into this general form with zero behavior change; no
separate design work needed for it later.

Codex's second review suggested replacing the bare-random-string wire
message with a structured, validated shape (`{version, type, senderId}`).
**Deliberately not done yet**: the not-yet-migrated `playlist.js`/
`continuous-player.js` both still expect a bare string — changing the
format now would break cross-tab claim/pause between a migrated page and
either of those two, a real currently-working behavior the parity checklist
tests for. Do this once, when `/playlist/` and `/player/` migrate and the
wire format changes for every participant at once, not as a
dual-format-supporting change mid-migration.

**State machine** — six states, standard transitions off native `<audio>`
events plus explicit calls. The one genuinely new piece: **one `'error'`
listener per controller** (a real reduction from zero anywhere today),
reading `audio.error` and flipping to `'error'` state so views can render
an inline "Playback failed — tap to retry" affordance — structurally fixes
today's bug where a hard load failure leaves the UI stuck showing the
loading spinner forever (`'waiting'` fires, but nothing ever un-sets it,
since no current engine listens for `'error'`).

A bug found while writing the deterministic tests, fixed before it shipped:
repeat-one's `ended` handler replayed the *same* item by calling
`_playIndex()` again, but that function only reassigns `audio.src` (which
resets `currentTime` as a side effect) when the item actually changes — so
without an explicit `audio.currentTime = 0`, repeat-one would have resumed
from the end instead of restarting. This is exactly the kind of bug manual
QA tends to miss and a state-machine test catches by construction.

**Media Session** — generalizes the existing `playlist.js`/
`continuous-player.js` pattern (metadata, position state, `play`/`pause`/
`previoustrack`/`nexttrack` handlers), enabled by default. Show pages get
Media Session/lock-screen support for the first time — currently zero.

**Playable-item schema:**

```ts
{
  id: string,                  // tracks: "{show-slug}-{2-digit-track}" (matches assets/tracks.json);
                               // recordings: "recording:{show-slug}:{r2-key}" (see below)
  kind: 'track' | 'recording', // 'recording' = Full Recording / hero card item
  streamUrl: string,           // fully resolved at build time (sitegen.core.stream_url()), never assembled client-side
  title: string,
  artist: string,
  venue: string | null,
  date: string | null,
  dateDisplay: string | null,
  durationSec: number | null,
  durationLabel: string | null,
  peaksKey: string | null,     // key into the page's already-fetched peaks map
  pageUrl: string,
  playLabel: string,           // pre-composed a11y string, same convention fragments.py already uses
  downloads: { lossless: { key, format, sizeMb, title } | null },
  dropouts: boolean,
}
```

**`downloads.lossless` carries an R2 key, not a URL** (Codex catch). The
lossless original is reachable *only* through the worker's `/auth` +
`/download` pair — `/stream` deliberately 403s every `.wav`/`.flac`
(`worker/index.js`) — so a stream URL here would be an address guaranteed to
fail. (The legacy download button's `href` looks like a stream URL but is never
fetched: `player.js` intercepts the click and reads the key out of it.) The
field is named `lossless` rather than `flac` because **64 of the 747 items are
WAV**, which the earlier `downloads.flac` shape silently misreported.

**Peaks coverage is a build invariant, not a runtime fallback** (Codex catch).
An earlier draft claimed a missing peaks entry degrades to a plain range at
per-row granularity. It doesn't: `build_show()` picks waveform-vs-range markup
per *show*, and a `.ws-track` row has no `.progress-range` at all — so a track
missing from the peaks map would render with neither a waveform nor a seek bar,
silently unseekable. Rather than write a fallback for what would mean a corrupt
peaks file, `validate()` now fails the build if any track-listed show's peaks
JSON is missing a track number (`core.py`). Zero shows violate it today.

**Recording IDs must be unique per card, and the scheme has to exist before
Step 3 generates any markup** (Codex catch). Every view decides whether it is
the active one by comparing `currentItem.id` against its own item's `id`, so
two recording cards sharing an id — or both defaulting to a show-level one —
would render as active simultaneously. Shows can carry several: one or more
canonical "Full Recording" parts plus any number of alternate transfers.
Scheme: **`recording:{show-slug}:{lossless-r2-key}`** — keyed on the
recording's `file` (the lossless original), which is its real identity,
stable across rebuilds, and needs no new identifier invented or stored.

Deliberately **not** the stream key, which is not unique:
`mad-sweetwater-2000-10-17` offers a WAV and a FLAC transfer of the same tape
that share a single MP3 stream proxy, so a stream-keyed id made both cards
render as active. Found by the Step 3 build-output check, not by inspection.
Regression-tested with two alternate transfer cards in
`test-player-views.mjs`.

`normalizeItem()` validates/defaults this shape without knowing where data
came from: `id` and `streamUrl` are required (a missing stream URL throws
rather than silently becoming `''`, which would surface as a confusing
decode error instead of the data problem it is), and `durationSec` is
rejected to `null` unless finite and non-negative — it feeds seek math and
Media Session's `setPositionState()`, which throws on non-finite input, and
later phases will feed this from persisted/URL-derived state that can't be
trusted the way build-time markup can. Bounding queue *length* for those
untrusted sources is a later-phase concern (show-page queues are
build-generated and inherently bounded).

For show pages: `itemFromRowElement(el)` reads a single
`data-item` JSON attribute rendered server-side onto each row — **zero
network round trip**, preserving today's property that show pages never
fetch a JSON catalog for row data (same convention already used for
`data-info` tooltips and `window.ZIP_MANIFEST`). Peaks stay out of the item
schema as inline data — `peaksKey` is a pointer; the page fetches
`window.WS_PEAKS_URL` once per page (unchanged from today) and passes the
parsed map into view construction. **Corrected (flagged by a later Codex
review, §6 Step 4's entry has the full record): there is no per-row runtime
fallback for missing peaks coverage.** A `.ws-track` row has no
`.progress-range` element at all, so a row missing from the peaks map would
render with neither a waveform nor a seek bar — silently unseekable. Peaks
coverage is a **build-time invariant** instead: `validate()` fails the build
if any track-listed show's peaks JSON is missing a track number (`core.py`).
Zero shows violate it today.

(`itemFromCatalogRow(row)`, mapping `assets/tracks.json` rows to the same
shape for `/playlist/`/`/player/`, is designed now for forward-compatibility
but not built until those phases. A richer, versioned persisted-state shape
for those two pages — also raised by Codex's second review — is likewise a
later-phase concern: show pages don't persist controller state to
`localStorage` at all, so there's nothing to version yet.)

**View lifecycle** (built — `scripts/player-views.js`):

```js
class PlayerView {
  constructor(root, item, { density = 'compact', peaks = null } = {}) {}
  onAttach(controller) {}          // wires DOM listeners, paints from controller.snapshot()
  onControllerUpdate(snapshot) {}
  onDetach() {}                    // aborts all its listeners, tears down any waveform
}
// Track rows. Given the show's full ordered queue, so a click re-asserts it
// (see the queue-origin contract above) rather than playing a lone item.
class CompactPlayerView extends PlayerView {} // (root, item, { queueItems, queueIndex, peaks })
// Full Recording / alternate transfer: calls playSingleton(). No prev/next
// controls in Phase 1 — recording_card() never emits them.
class HeroPlayerView extends PlayerView {}
```

Views own no media element and no audio graph — they read
`controller.snapshot()` and dispatch commands. Each holds an
`AbortController` so `onDetach()` removes every listener it added in one
call. A view only rewrites its row's DOM while it is the active item, or
once on the transition away from active, so a page of many rows doesn't
churn on every `timeupdate` tick.

**Waveform upgrade/downgrade — the one real behavior change, not just a
refactor.** Today *every* row eagerly gets its own `WaveSurfer` instance on
page load (confirmed, not lazy/`IntersectionObserver`-gated). Built design:
a compact row renders an inert canvas from its precomputed peaks by default
(drawn to match WaveSurfer's own `barWidth: 2` / `barGap: 1` / `normalize`
output, so upgrading isn't visually jarring); only the currently-active row
gets an actual `WaveSurfer` instance, created by wrapping
`controller.audioElement` (verified supported — the vendored
`wavesurfer.esm.js` accepts `media:` and sets `isExternalMedia = true`,
correctly skipping teardown of an externally-owned element on `destroy()`).

**Ordering correction found while building Step 2 — the earlier plan's
"construct the WaveSurfer *before* `audio.play()`, inside the gesture" was
wrong and would have broken playback.** WaveSurfer captures
`options.url || this.getSrc() || ""` at construction and defers its
`load()` to a microtask. Construct it before the controller assigns
`audio.src` and it captures `url = ""`; the deferred
`setSrc("", peaks)` then reaches
`if (i && this.media.removeAttribute("src"))` — sees the src that appeared
in the meantime, and strips it, killing playback. Constructing it *after*
assignment makes `i === t` and returns early instead.

The stated iOS rationale was also subtly wrong: the gesture constraint
applies to whoever calls `play()`, which is now the controller — WaveSurfer
here is purely a renderer wrapping an already-playing element, so it never
needs the gesture itself. `_playIndex()` therefore orders operations
**assign `src` → notify views (upgrade happens here) → `play()`**: still
synchronous, still within the user gesture, but with a source WaveSurfer
can safely adopt. The controller also tracks `_currentSrc` separately,
because the `audio.src` DOM getter returns a resolved absolute URL that
won't reliably string-compare against what was assigned.

The existing iOS "tap-while-paused plays first, then seeks in the
`.then()`" workaround is preserved, now routed through
`controller.play()`/`controller.seek()` inside the same tap.

Control-matrix decisions:

- **Download policy:** FLAC is the protected/gated download; MP3 is the
  ungated streaming proxy and isn't currently presented as a download.
  "FLAC/MP3 download" in the mockup conflicts with that boundary — preserve
  the existing split unless changing it is a deliberate, separate decision.
- Repeat-one must take precedence over queue auto-advance/reshuffling;
  turning it off restores the previous queue mode.
- "Persistent mini bar" means sticky *within* the current page unless
  site-wide sticky navigation is separately approved (§5 — deferred).
- The existing playlist-selection bar also sits at the bottom of pages —
  define stacking/overlap behavior if both are present, once mini density
  is actually built (`/playlist/`/`/player/` phases).
- Mini density is not a third view class — a `HeroPlayerView` configuration
  flag (no waveform ever, condensed layout). Out of scope for show pages;
  sketched now for the later phases.

### Loudness control — fully deferred, not simplified

**Confirmed with Rene 2026-08-13: loudness is a separate future phase, not
part of the active consolidation work at all** (stronger than "not yet
decided" — no Web Audio graph, no `GainNode`, no limiter work happens until
that phase is deliberately scoped). Kept here because the design thinking
already done is worth preserving for whenever that happens, and because the
controller above is deliberately built with zero assumptions about it.

Not a remaster — a live, client-side gain stage, so it never touches the
stored master. **Revised after the first Codex review — the original
"brick-wall, never clips" claim overstated what a `DynamicsCompressorNode`
guarantees.**

- `DynamicsCompressorNode` has threshold/ratio/attack/knee, but no output
  ceiling guarantee — it doesn't provably keep true/inter-sample peaks under
  a chosen bound. Don't promise "never clips" on that basis alone. A real
  guarantee needs either a tested look-ahead limiter (likely an
  `AudioWorklet`) or a deliberately conservative gain derived from each
  track's known peak headroom.
- **New data point (Codex's second review, ran real numbers against
  `assets/track-spec.json`'s `mp3TruePeak` field across all 680 tracks):**
  only **18** tracks have enough headroom for a flat +4 dB boost while
  staying under −1 dBTP, only **4** have enough for +6 dB, and **61**
  already exceed −1 dBTP before any boost at all. This rules out
  "conservative gain-only, no limiter" as a clean fit for more than a
  couple dozen tracks archive-wide — whoever scopes this phase should start
  from this number, not re-derive it. `assets/tracks.json` (what
  `/playlist/`/`/player/` actually consume) doesn't currently carry
  `mp3TruePeak`; joining it into the playable-item data path is this
  phase's problem to solve, one way or another (tested limiter, or a
  per-track variable boost capped by known headroom).
- **Archive mode needs a true bypass**, not "gain node at 0 dB through the
  compressor" — routing archive-target audio through a compressor with a
  threshold near −1 dBFS can still alter tracks that reach that threshold
  even at unity gain. Bypass dynamics processing entirely for Archive mode
  (a direct `MediaElementAudioSourceNode → destination` branch).
- Set `audio.crossOrigin = "anonymous"` **before** assigning the (cross-
  origin) stream URL — otherwise `createMediaElementSource()` can be
  silenced by CORS. The production Worker already emits the right headers;
  local/preview hosts need the same treatment, including on Range
  responses, and this needs real local-preview testing (the Worker
  currently allows only production site origins, not arbitrary localhost
  ones).
- One lazily-created `AudioContext` per document, resumed synchronously
  from the user's play/loudness gesture; handle `suspended`/interrupted
  states. Never create a second `MediaElementAudioSourceNode` for the same
  media element — build one graph, then change routing/parameters.
- If Web Audio is unavailable/blocked, Archive playback must still work
  through the native media element, with boosted modes simply unavailable —
  a loudness feature must never make a previously playable recording
  silent, and must not leave an element hung off a failed cross-origin Web
  Audio fetch.
- Convert dB to gain with `10 ** (dB / 20)`, ramp over ~20–50 ms when
  switching modes to avoid clicks.
- Open, unscoped: is loudness mode global, per-queue, or per-item — and
  does it persist / sync with the popup? The −20/−16/−14 numbers in the
  mockup remain illustrative only. Before finalizing: test against real
  corpus material including transient-capped tracks, consider a
  conservative default or first-use notice given headphone-volume risk on
  "Loudest," and whole-show recordings need their own headroom policy since
  they lack the track-level `mp3TruePeak` provenance above.

### Why controller-first is worth it regardless of the deferred phases

Agreed by both Codex reviews. This refactor has value independent of
sticky-navigation or loudness. Build order: extract and prove the
controller first, adapt existing views to it, *then* replace markup — keeps
behavior parity observable instead of combining engine, UI, and navigation
changes in one step. This is now the literal Phase 1 step order in §6, not
just a principle.

## 3. Technical Details

**Files in scope:**

Built: `scripts/player-controller.js` (the shared engine),
`scripts/player-views.js` (compact/hero views), `scripts/player-boot.js`
(page-level bootstrap for show pages), and their dev-only test harnesses
`scripts/test-fake-dom.mjs` (shared DOM/media fakes + the module-loading
trick), `scripts/test-player-controller.mjs`, `scripts/test-player-views.mjs`,
`scripts/test-player-boot.mjs` (not shipped — no `build.py` line, no
`assets/` copy; see Verification below). `scripts/site.css` gained the three
`--player-*` alias tokens the views read.

Existing files touched across the full initiative: `scripts/player.js`
(trimmed as each phase migrates its consumers off it, never converted to a
module — three other classic scripts still read its top-level bindings as
ambient globals), `scripts/playlist.js`, `scripts/continuous-player.js`,
`scripts/wavesurfer.js` (deleted once show pages fully migrate),
`scripts/songs.js`, `scripts/track-select.js`, `scripts/site.css` /
`scripts/home.css` (two token systems the component must work under — see
root `CLAUDE.md`; resolved via three alias custom properties,
`--player-accent`/`--player-track`/`--player-surface`, added to `site.css`
first since show pages need them, so the shared component never touches
the two systems' non-identical dark-mode tokens directly), and the
generators in `scripts/sitegen/` (`fragments.py`'s `player()` at line 78
and `recording_card()`; `pages.py`'s `build_show()`, row templates at lines
777/787) plus `scripts/build.py`. `worker/index.js` enters scope only if
CORS or stream metadata needs to change (not needed while loudness stays
deferred — no Web Audio consumer exists yet). `site_worker.js` enters scope
only if timestamp-sharing changes `/play/{slug}` short-link behavior (not
built yet). Generated output under `assets/`, `/playlist/`, `/player/`,
show pages, and song pages gets rebuilt, never hand-edited.

Module boundaries: no classic script calls `claimPlayback`/`onExternalClaim`
synchronously at parse time (verified against the real code — every call
site is inside a later event handler), so a module-script bootstrap can
safely install bridge globals (`window.claimPlayback`/
`window.onExternalClaim`) before any classic script needs them, without
converting `songs.js`/`track-select.js`/`playlist.js` to modules
themselves. Where a classic script needs to trigger controller behavior it
doesn't own, use a DOM `CustomEvent` bridge rather than a direct call.

A separate `downloads.js` file (splitting the password modal/batch-ZIP
logic out of `player.js`) was suggested by Codex's second review. **Declined
for now**: the separation actually being asked for — playback logic
isolated from download/auth logic — already holds, since that logic lives
in `player-controller.js`, a different file entirely. The stated reason for
a further split ("so `/player/` doesn't inherit machinery it doesn't use")
doesn't apply — `/player/`'s `build_player()` bypasses `page_shell()`
entirely and has never loaded `player.js`. Worth doing later as a tidy-up;
not blocking any current phase.

**Migration-parity checklist (Codex catch, verified against the actual
code — all of these are real, working behavior today, not hypothetical).
Kept as two literal lists per Codex's second review, so a test failure is
unambiguous about which bucket it's in:**

*Must not regress:*
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
- cross-tab claim/pause between any two of the four current surfaces

*Hardening introduced by consolidation (new, not previously true anywhere —
don't describe these as "already working" the way an earlier draft of this
checklist did; Codex's second review caught that inaccuracy):*
- a genuine `'error'`-state (404/CORS/decode failure) instead of a
  permanently-stuck loading spinner
- Space-bar reaching whatever's actually active, including a waveform row
  (today it only reaches `.custom-player` rows)
- stale-play/generation-token races (rapid double-click between rows)
  resolving on the last request, not whichever promise happens to settle
  first
- waveform instances created only for the active row, only after a real
  user gesture (today every row eagerly gets one on page load)
- Media Session on show pages (currently zero there)
- unified BroadcastChannel claim shape (currently two structurally
  different implementations behind the same wire format)

**Other functions (still to design/build, no phase committed yet):**

- **Share timestamp** — copies a link that opens straight to the current
  second. Needs one canonical URL grammar across queued tracks, show-page
  tracks, and whole shows — the site already uses `#p=id,...`, `&t=...`,
  `#track-N`, and `?autoplay=1`; a timestamp scheme must not collide with
  those or break existing short playlist links. `site_worker.js` owns
  playlist short links; `worker/index.js` owns audio streaming/CORS — a
  timestamp feature touches the former only if it changes `/play/{slug}`
  redirect behavior.
- **Repeat** — restarts the current track on end instead of advancing the
  queue. Plain repeat-one, not a loop-region editor. The controller-level
  mechanism (`setRepeatOne`) is already built; no view surfaces a toggle
  for it yet.
- **Keyboard shortcuts** — `space` play/pause, `←`/`→` seek ±5s, `↑`/`↓`
  next/prev in queue. Scope shortcuts to an active/focused player; ignore
  links, inputs, selects, `contenteditable`, and modifier chords — global
  Up/Down would otherwise fight page scrolling and assistive-tech
  conventions.

**Boundaries to keep, not re-litigate here:**

- Download authorization (password verification, token expiry, filename
  authorization, WAV/FLAC rejection on `/stream`) stays entirely
  server-side, exactly as today — the player UI never becomes the security
  boundary. Worth a regression test that lossless keys can't be played
  through the streaming route, whenever a formal test layer exists for
  that boundary.
- Treat URL fragments, query params, `localStorage`, and `BroadcastChannel`
  messages as untrusted input the same way the current code already should:
  validate IDs against the catalog, clamp indices/times/gain, bound queue
  length. The random playback id in the claim protocol prevents
  self-pausing; it is not an authentication mechanism.
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
- Fetch and index `tracks.json` once per document, once `/playlist/`/
  `/player/` are in scope; avoid full queue rerenders for every time tick.

**Deterministic controller tests (built —
`scripts/test-player-controller.mjs`, `node scripts/test-player-controller.mjs`,
not wired into CI):** state-machine/queue logic doesn't need a browser to
verify, and manual checks alone are weak for it (Codex's second review).
Twenty-two cases against a fake `<audio>` element, all currently passing:

- *Async races:* a stale/rejected `play()` promise doesn't clobber newer
  state once a later `play()` supersedes it; rapid consecutive `play()`
  calls settle on the last item.
- *Queue/transport:* repeat-one restarts the same item from
  `currentTime = 0` at `ended` (the test that caught the bug above);
  `ended` without repeat-one advances and running off the end sets
  `state = 'ended'`; `toggleShuffle()` only reorders the unplayed tail and
  restores the exact original order on toggle-off.
- *Queue-context round trips* (the show-page flows Codex flagged):
  Track → Hero → Track restores the full track queue; Hero → Track → Next
  advances within the restored queue; Alternate recording → Track likewise.
- *Legacy parity:* removing the currently-playing item slides the next one
  in and keeps playing (matching `playlist.js:803-828` /
  `continuous-player.js:339-356` exactly), while removing the last item, or
  emptying the queue, stops; `reorder()` clamps an out-of-range target and
  invalidates the now-meaningless pre-shuffle snapshot.
- *Consistency/teardown:* `setQueue()` without autoplay halts audio left
  over from the discarded queue rather than leaving it audible while
  `currentItem` points elsewhere; `normalizeItem()` rejects items missing
  `id`/`streamUrl` and sanitizes NaN/negative durations; `destroy()` pauses
  playback and detaches every listener so a destroyed controller can't be
  driven by later media events.
- *Coordination:* an external claim from another controller pauses one that
  was playing; a hard load failure surfaces as `state = 'error'`.
- *Failure recovery / capability guards:* `toggle()` on a failed item retries
  with a genuinely fresh load rather than pausing (an element that errored
  mid-playback can still report `paused === false`, which would otherwise
  make the only visible control pause something that isn't playing); a
  browser that throws on an unsupported `setActionHandler` action still
  constructs a working controller.

**Deterministic view tests (built — `scripts/test-player-views.mjs`,
`node scripts/test-player-views.mjs`):** sixteen cases driving real view
instances against a hand-rolled fake DOM, with fixtures mirroring the actual
generated markup (a `.ws-track` row, a `.custom-player` row, and a hero card
built from `recording_card()`'s real shape — `.progress-wrap` and all,
with the single bare time label it actually emits (it calls `player()` with no
duration, so there is no separate total label), and no prev/next controls). Covered:
`data-item` parsing including malformed JSON; icon/aria-label state across
idle/loading/playing; the two time-label formats; a track row re-asserting
its whole show queue rather than calling `play()` on a possibly-unqueued
item; a hero playing as a singleton and going inactive when a track queue
takes over; two alternate recording cards staying independently active
(the unique-recording-ID requirement); a superseded row clearing its state;
error state landing on the active row only, rendering a visible
`role="status"` message, relabelling the button to "Retry", and clearing on
a successful retry; **inactive rows not being rewritten across repeated
`timeupdate` ticks**; **tapping an inactive waveform starting that row,
re-asserting its queue, and landing at the tapped position**; range seeking
that refuses to hijack playback from an inactive row; waveform upgrade only
for the active row (wrapping the shared element, passing no `url`) with
teardown of the previous one; the iOS tap-while-paused play-then-seek path;
unmount detaching a view from further updates; and, added for the seventh
review's finding #4, `setPeaks()` actually invoking `_upgradeWave()` on an
active row and `_drawInertWave()` on an inactive one — not just storing the
value, which is all the earlier "failed peaks fetch" boot test checked.

**Deterministic bootstrap tests (built — `scripts/test-player-boot.mjs`,
`node scripts/test-player-boot.mjs`):** twenty-two cases, each importing
`player-boot.js` afresh against a fake show-page document — importing it *is*
running the bootstrap, which is the behavior under test. Covered: one
controller mounted over every row and hero card, with the queue in DOM order;
refusing to claim a page where the row/hero selectors found nothing to mount;
the mounted flag being set **synchronously**, before the peaks fetch resolves
(the load-bearing property — the legacy engines check that flag at
DOMContentLoaded, which the same-synchronous-parse-job guarantee below always
beats); peaks landing afterwards, and a
failed peaks fetch still handing every waveform row an empty `{}`; a malformed
row aborting the whole boot with the flag left unset; a failure *after* some
views mounted tearing those views back down, proven by the markup being unable
to start playback afterwards; a page without the engine flag never being
claimed; a row click re-asserting the whole show queue; the Hero → row → next
round trip through the real markup; Space reaching a waveform row while
keeping its hands off form fields (and not swallowing the keystroke there);
`?autoplay=1#track-N` starting inside the full queue on load while a later
`hashchange` only re-targets; a debounced resize redrawing inert waveforms;
and, added for the seventh review's finding #1, `handle.destroy()` actually
stopping a leaked Space/hashchange-load/resize listener from reaching a
destroyed controller — plus a direct check that `PlaybackController` itself
refuses every mutating call once destroyed, and that `mount()` on an
already-destroyed controller never calls `onAttach`. The two halves (the
controller's own `_destroyed` guards, and `player-boot.js`'s shared
`AbortController`) were proven independently necessary, not just present:
reverting either one in isolation left a different subset of these tests
failing, never all of them.

Also added for the seventh review's finding #4 — the earlier suite never
loaded `player.js` at all, so deleting its engine gate entirely left every
test green: two more cases execute `player.js`'s **real source** (not a
reimplementation), sliced to exclude the download-modal/tooltip/share code
that needs a real `innerHTML` parser our fake DOM doesn't have, run via
`new Function(...)`. One proves the gate stays dormant once a peer boot has
mounted; the other proves it still initializes legacy playback when nothing
else claimed the page — together covering both directions the gate can fail
in. `wavesurfer.js`'s gate is structurally identical (its own comment says
so) and isn't separately covered — deliberately scoped to one file, since
`player.js` is on every page and the review offered "player.js or
wavesurfer.js" as sufficient.

The DOM/media fakes and the module-loading trick now live in
`scripts/test-fake-dom.mjs`, shared with `test-player-views.mjs`; it also
exports `readScript()`, used by the two `player.js`-source tests above.

**What these tests do not cover** — deliberately, since they need a real
browser and stay part of the manual parity checklist: canvas rendering
output, real WaveSurfer internals, actual media loading/decoding, layout, and
the one failure mode the whole Step 4 design is built around — an actual
module/asset load failure, which no fake can produce.
The fake DOM reports `clientWidth: 0`, so the inert-canvas draw path in
particular is exercised only in a browser.

These prove the controller's and views' own chosen behavior and (for
`removeAt`) one verified point of legacy parity — they are not a substitute
for the
`/playlist/`-phase work of demonstrating full behavioral parity with the
legacy queued players.

**Manual verification:** spot-check on Safari, Chrome, and Firefox before
shipping each phase — matching how the rest of this project already ships
(build fails the integrity checks, then a manual check on the live site).
Not proposing a formal automated *browser* test suite or CI matrix; that's
disproportionate for this project's size. The deterministic tests above are
a different, narrower thing — pure controller logic, no DOM/media/network —
and don't replace manual checks for actual media/autoplay/CORS/Media
Session/mobile-backgrounding/visual behavior.

## 4. Rejected / Out of Scope

- **Playback speed control** — doesn't apply to this archive (live acoustic
  recordings, not spoken word/lecture content).
- **Loop-region (drag-select a span to repeat)** — not useful for this use
  case; replaced by the simpler repeat-one above.
- **A reusable view class owning its own audio element per instance** —
  contradicts the one-engine-per-document success criterion; not a live
  alternative for any phase (§2).
- **SPA/client-side navigation and iframe-shell work** — see sticky
  navigation in §5; a separate decision, confirmed deferred.
- **Client-side loudness control, this phase** — confirmed fully deferred
  with Rene 2026-08-13, not merely simplified; see §2's Loudness section
  for the design thinking preserved for whenever it's scoped.
- **Cross-device playback sync, server-side remastering, in-browser EQ/
  crossfade/loudness analysis, per-track user presets, and any redesign of
  the download-authentication policy** — all out of scope, no phase.

The existing `/player/` popup is **not** out of scope in the sense of being
disposable early — it's the current practical mechanism for uninterrupted
listening while browsing, and stays functional until/unless a separate
sticky-navigation project replaces it.

## 5. Open Questions

**Resolved (2026-08-13, with Rene, before Phase 1 began):**

- ~~Sticky playback across page navigation~~ — confirmed deferred. The site
  is a static multi-page site (`scripts/build.py` generates full separate
  HTML pages) — every internal link is a full page load, tearing down all
  JS state including any playing `<audio>` element, true of the *current*
  four-player setup too. A service worker alone doesn't fix this either —
  it can't preserve a live audio element across a full document navigation.
  `/player/` is the baseline during consolidation. If client-side
  navigation is pursued later, it needs its own scope covering
  History/`popstate`, scroll/focus restoration, title/meta updates,
  same-origin URL filtering, and a real-navigation fallback on error — a
  genuinely separate architectural decision, not a side effect of this one.
- ~~Runtime granularity~~ — one controller with many views; see §2.
- ~~Hero queue semantics~~ — `playSingleton()` collapses the queue to
  length 1; no prev/next controls exist in Phase 1 to begin with; see §2.
- ~~Rollout structure~~ — incremental, one surface at a time, riskiest
  first (show pages, then `/playlist/`, then `/player/`); see §6.
- ~~Loudness control, this pass~~ — fully deferred, not just weakened; see
  §2/§4.

**Still open (deferred to the phase that actually needs the answer):**

- **Mini bar scope:** sticky on `/playlist/` only, or site-wide? Site-wide
  is part of the sticky-navigation decision above, not a `/playlist/`-phase
  decision.
- **Which playlist features surface in the mini/expanded states** — shuffle,
  queue editing, saved playlists, endless mode, open-in-popup? — a
  `/playlist/`/`/player/`-phase question.
- **Loudness control default/options, values, persistence** — everything in
  §2's Loudness section; unscoped until that phase starts.
- **Web Audio fallback behavior** — moot until loudness is scoped, since
  it's currently the only Web Audio consumer anywhere in the plan.
- **Timestamp URL grammar** — not yet designed; see §3's "Other functions."

## 6. Implementation Steps

Rollout is incremental and per-surface, riskiest surface first — confirmed
with Rene 2026-08-13. Old engines for a surface stay live and unmodified
until that surface's parity checklist (§3) passes; they are the fallback
during migration, not removed speculatively.

- [x] Codex review (first pass) — findings recorded in
      `player-consolidation-codex.md`, accepted findings folded into this
      revision
- [x] Codex review (second pass, against the live implementation) —
      findings recorded in `player-consolidation-codex.md`, accepted
      findings folded into this revision
- [x] Sticky-navigation scope decided — deferred, `/player/` stays baseline
- [x] Loudness scope decided — fully deferred, not part of active work
- [x] Controller API, playable-item schema, state machine, view
      subscribe/teardown API specified (§2)
- [x] Migration-parity checklist turned into the two literal lists in §3

### Phase 1 — show pages (in progress)

1. [x] `scripts/player-controller.js`, no DOM. Full controller: queue,
       transport, shuffle-tail algorithm, BroadcastChannel registry,
       generation token, state machine, `'error'` listener, Media Session,
       `play()`/`playSingleton()` split, legacy-parity `removeAt()`,
       complete `destroy()` teardown, `normalizeItem()` validation,
       `build.py` wiring. *Verified:*
       `node scripts/test-player-controller.mjs`, 22/22 passing; full
       `python3 scripts/build.py` confirmed byte-identical output elsewhere.
2. [x] `scripts/player-views.js`, no DOM change on real pages: `PlayerView`
       base, `CompactPlayerView`, `HeroPlayerView`, `itemFromRowElement()`,
       plus the `--player-*` alias tokens and error-state CSS in `site.css`,
       and `build.py` wiring. Forced the `_playIndex` ordering correction
       documented in §2. A fourth Codex review then found four real defects
       in the first cut, all fixed and regression-tested: inactive rows were
       being rewritten (and their canvases redrawn) on every `timeupdate`
       tick; tapping an inactive row's waveform silently did nothing (a
       legacy-behavior regression); the promised error affordance was an
       unstyled class with a retry path that couldn't actually recover a
       failed media element; and the hero fixture invented prev/next controls
       the real `recording_card()` markup doesn't emit. *Verified:*
       `test-player-views.mjs` 15/15, `test-player-controller.mjs` 22/22,
       full build byte-identical except the intended `site.css` additions.
3. [x] Additive markup only. `fragments.py` gained `playable_item_attr()`
       (one builder for the whole schema, returning the already-escaped
       attribute so no caller can forget to escape) and
       `recording_item_id()`. `build_show()`'s two row templates and
       `recording_card()` now carry `data-item`.

       **Deviation from the earlier plan, for the better:** `player()` was
       *not* given an `item_json` param. The hero's view root is
       `.recording-item`, which `recording_card()` builds directly — so the
       attribute goes there, and `player()` (shared with song pages) stays
       completely untouched, which serves this phase's "don't touch song
       pages" boundary better than the original sketch did. `recording_card()`
       takes an optional `show=None`; callers that omit it emit byte-identical
       markup to before.

       *Verified:* `build.py --check` passes; all 747 emitted items
       (680 track + 67 recording, across 30 pages) parse as valid JSON with
       required fields present and **ids unique within every page**; every
       item's `streamUrl` matches the legacy `data-src` on the same element
       exactly, so the new engine cannot play different audio than the old
       one; song pages emit no `data-item` at all; and stripping the new
       attribute from the whole build reproduces HEAD's HTML **byte for
       byte**, proving the change is purely additive.

       The uniqueness check immediately caught a real collision that
       validated Codex's finding #4: `mad-sweetwater-2000-10-17` offers a WAV
       and a FLAC transfer of the same tape *sharing one MP3 stream proxy*,
       so an id keyed on the stream key made both cards render as active.
       Recording ids are therefore keyed on the lossless original's R2 key —
       the recording's real identity — not the stream key.
4. [x] `player-boot.js`, flagged to a small allowlist of show slugs. Mounts
       `CompactPlayerView` on every `[data-item]` element inside
       `.track-list` (deliberately matches both `.ws-track` and
       `.custom-player`), mounts `HeroPlayerView` on `.recording-item`,
       wires Space-bar/deep-link/Media Session.

       **Engine selection must be transactional, and must gate every legacy
       playback registration — not just the initial mount.** Two Codex catches,
       in successive reviews, both against earlier drafts of this step:

       *(a) Timing.* `player.js:173` calls `initCustomPlayers(document)` at
       classic-script parse time and `wavesurfer.js` auto-builds on module
       execution, so a `dataset.mounted` guard set later by a deferred module
       can never win — the legacy pass has already run.

       *(b) A static flag alone is a regression, not a fallback.* Setting
       `window.PLAYER_ENGINE = 'controller'` before `player.js` and having the
       legacy code bail means an unsupported-module browser, a 404 on an asset,
       a parse error, or any bootstrap exception leaves the page with **no
       working player at all** — worse than today, where a `wavesurfer.js`
       failure still leaves the Full Recording player alive via classic
       `player.js`. Retained legacy code is only a *deploy-time* rollback
       unless something can fall back at *runtime*.

       Design that satisfies both: **legacy defers, controller claims.**
       - `build_show()` emits `window.PLAYER_ENGINE = 'controller'` inline
         before the `player.js` tag (fixes (a) — the decision exists before any
         legacy code runs).
       - Seeing that flag, `player.js` does not initialize immediately; it
         registers its auto-init on `DOMContentLoaded` instead. Same for the
         Space and `focusHashTrack` handlers (see below).
       - `player-boot.js` (a module, so it executes after parsing but *before*
         `DOMContentLoaded` — deferred scripts are guaranteed to run first)
         mounts the controller inside a `try`/`catch`. On success it sets a
         "controller mounted" marker; on failure it tears down any partial
         mounts and leaves the marker unset.
       - At `DOMContentLoaded`, legacy checks the marker: set → stay dormant;
         unset → initialize normally, exactly as it does today.

       This makes a module/asset/boot failure degrade to the current engine
       rather than to silence, and it is testable without a browser matrix.

       **Gate all three legacy playback registrations, not just the mount**
       (the second catch): `initCustomPlayers` at `player.js:173`, the Space
       handler at `player.js:175-190`, and `focusHashTrack`'s load/hashchange
       listeners at `player.js:579-601` are registered independently. Gating
       only the first leaves two live: both deep-link handlers would scroll and
       mutate `.target`, both could act on `?autoplay=1` (a double start on a
       non-waveform row), and the legacy Space listener would swallow Space
       even with no legacy player active. Download, share, and tooltip code
       stays untouched — it isn't playback.

       **Built. Four things came out differently than the design above, all
       for the better:**

       *(i) `wavesurfer.js` is gated too — the design's "three legacy playback
       registrations" was one short.* Every published show has a peaks file, so
       every show-page track row is a `.ws-track`, and `.ws-track` rows are
       **invisible to `player.js`** (`initCustomPlayers` only knows
       `.custom-player`; on a show page the only ones are inside the recording
       cards). Gating just `player.js` would therefore have made a boot failure
       degrade to a page with a working Full Recording card and *no track
       players at all* — the exact silent-degradation failure this step's
       redesign exists to avoid. `wavesurfer.js` now takes the identical
       defer-and-check branch, so a failed `player-boot.js`/`player-views.js`/
       `player-controller.js` falls back to today's complete engine pair. Its
       build is a module and its show-page path is behind a fetch, so
       deferring it costs nothing.
       **Correction (seventh review): this is not true of every failure.**
       `wavesurfer.js` and `player-views.js` both statically import the
       identical vendored `/assets/wavesurfer.esm.js`. If THAT one file 404s
       or fails to parse, both waveform engines fail together — the "complete
       engine pair" claim above holds for a failure in the new engine's own
       files, not for its one dependency shared with the old engine. This
       isn't fragility Step 4 introduced: waveform rows have depended solely
       on that module since before this initiative existed, on every show
       page, flagged or not — the correction is to the plan's wording, not to
       runtime behavior. See the "Still to verify" note below for what the
       browser pass should actually test.

       *(ii) `document.readyState` is not a usable shortcut for the
       DOMContentLoaded barrier.* readyState is already `'interactive'` while
       deferred and module scripts execute, so an "if we're past loading, just
       initialize" branch would fire the legacy engine **before** `player-boot.js`
       (a later module) ever got the chance to claim the page — double-initializing
       precisely what the flag prevents. **Wording corrected per the seventh
       review's finding #6:** the actual guarantee is narrower than "any script
       placement" — every script here is a parser-inserted `<script>` in
       document order (build.py's own output, not a dynamically inserted one),
       and DOMContentLoaded is only queued after that whole ordered list runs,
       so registering the listener in that same synchronous parse job is
       always in time. Both gates now say so precisely, not just "under any
       script placement"; don't "simplify" it back to the vaguer claim.

       *(iii) Views mount peak-less and are decorated afterwards.* The marker
       has to be set synchronously in that same parse-job window described
       above, but the peaks map is a fetch — so the boot mounts first, sets the flag, then
       applies peaks via a new `PlayerView.setPeaks()`. A row started in the
       gap simply upgrades to its waveform a moment later. A *failed* peaks
       fetch hands every waveform row an empty `{}` rather than `null`,
       matching `wavesurfer.js`'s own `build({})` fallback: with `{}` the row
       still upgrades to a WaveSurfer that decodes the audio to draw, so it
       keeps its waveform **and its only seek surface** (a `.ws-track` row has
       no range input); with `null` it would have had neither.

       *(iv) Deep-link autoplay fires on initial load only.* Exact parity with
       what the two legacy engines produce between them today —
       `focusHashTrack` never autoplays a waveform row, and `wavesurfer.js`
       reads the hash once, at build time — so a later `hashchange`
       re-highlights and scrolls but never starts playback.

       Also added: `page_shell(pre_scripts=...)` (the flag must precede
       `player.js`), `PlayerView.redrawWave()` on a debounced resize (an inert
       canvas is drawn at one fixed pixel size and would otherwise stretch),
       and `window.PLAYER_BOOT` as a console handle for the manual checks.

       Allowlist (`pages.CONTROLLER_ENGINE_SLUGS`), chosen to cover the shapes
       that differ: `jerry-cafe-java-1999-05-27` (plain), `jerry-cafe-java-1999-03-25`
       (two canonical Full Recording parts = two hero cards at once), and
       `mad-sweetwater-2000-10-17` (the alternate transfer sharing a stream
       proxy, inside a collapsed `<details>`). A page with no track list at all
       is *not* covered — the only track-less show is hidden and generates no
       page.

       *Verified at the time of this build* (superseded below by the seventh
       review's fixes — see the current counts near the top of this file):
       `test-player-boot.mjs` 14/14, `test-player-views.mjs` 15/15,
       `test-player-controller.mjs` 22/22. Each of the boot tests was
       mutation-checked — the fix reverted, the test confirmed failing — which
       is how the partial-mount teardown test got fixed: the original fixture
       put the malformed item on a *row*, and rows are normalized before
       anything mounts, so nothing was ever torn down and removing the teardown
       still passed. The malformed item has to be on a **hero** card (mounted
       after every row) to exercise that path at all. `build.py` +
       `verify_markup.py` pass; exactly three show pages changed, by exactly the
       two intended script lines each; every other page byte-identical.
       `verify_markup.py` now also asserts the engine handshake itself — flag
       and boot module always travel together, only on allowlisted slugs, flag
       before `player.js`, `player.js` still present (it *is* the fallback) —
       plus that every `/assets/` script a page loads, and everything those
       scripts import, is actually written by `build.py`.
       **Extended for the seventh review's findings #2 and #5:** it now
       enumerates every `.track-row`/`.recording-item` ELEMENT independently
       of whether a `data-item` attribute is present, rather than only
       validating attributes it happens to find — the earlier version would
       have silently passed a build regression that dropped
       `playable_item_attr()` from one row. And its import-graph scan now
       catches dynamic `import()`, side-effect imports, and `export … from`
       (both quote styles), not just single-quoted static `from` — the gap
       that had already let `player.js:401`'s `await import('/assets/
       client-zip.js')` go unchecked. Both fixes carry their own in-memory
       self-test (`_selftest()`, run automatically on every invocation), so
       the fix itself stays regression-tested without needing a Python test
       framework this project doesn't otherwise have.

       **Browser pass done (2026-08-14).** No browser was available in the
       session that built the above; one turned out to be reachable in a
       later session via `playwright-chromium`/`playwright-webkit` (globally
       installed, not a project dependency — this project still has no
       package.json). Rather than a one-off manual check, this is now a
       permanent, reproducible, checked-in harness:
       **`scripts/browser_check.mjs`** (dev-only, same status as
       `test-player-*.mjs` — not part of `build.py` or any deploy gate, run
       by hand: `NODE_PATH="$(npm root -g)" node scripts/browser_check.mjs`).
       It serves the real repo locally and drives real Chromium (and WebKit,
       if `playwright-webkit` is present) against it — real production audio
       (`streamUrl` points at the live worker, nothing mocked), real
       `WaveSurfer` rendering, real `BroadcastChannel` delivery. The two
       breakage scenarios run against a temp copy of `assets/`+`shows/`, so
       the script never touches the working tree.

       **44/44 passed** (Chromium; a WebKit smoke pass — mount, a real
       click-gesture play, canvas rendering — also passed separately, not
       yet folded into the default run since `playwright-webkit` isn't
       reliably available via a plain global install). Covered: controller
       mounts *every* row and hero card, not a partial set (view count
       checked against the real markup, not just captured and printed); both
       legacy engines provably stay dormant — `player.js` (no `_audio`
       marker) and, separately, `wavesurfer.js` (zero real `<audio>`
       elements exist anywhere pre-interaction, since neither the
       controller's own shared audio element nor an eagerly-built legacy
       WaveSurfer instance is in the document until something actually
       plays) — on all three allowlisted pages; real playback
       actually advances, `toggle()`/`seek()`/Space all work against it; a
       real `WaveSurfer` canvas renders (had to pierce a Shadow DOM —
       WaveSurfer v7 uses one by default, worth knowing for future
       debugging); the Hero → track → next round trip, with real audio at
       each step; the `mad-sweetwater-2000-10-17` alternate-transfer case
       (the one that originally motivated keying recording IDs on the
       lossless file) — only the clicked card ever shows active; and real
       cross-tab claim/pause between a controller-engine show page and
       `/playlist/` via genuine `BroadcastChannel`.

       **Both breakage tests, run for real, not just reasoned about:**
       renaming `assets/player-boot.js` away → full legacy fallback,
       confirmed with real playing audio in both the Full Recording card
       (`player.js`) and a waveform row (`wavesurfer.js`). Renaming the
       vendored `assets/wavesurfer.esm.js` away → the corrected claim from
       the seventh review, confirmed exactly: Full Recording card keeps
       playing real audio via classic `player.js`; every waveform row is
       genuinely dead in both engines, because they share that one file.

       **Deep-link autoplay: describe this as policy-dependent, not
       "passed."** `?autoplay=1#track-N` reliably queues the right track and
       highlights the right row — that part is asserted and passes
       unconditionally. Whether the browser actually *starts* playback on
       arrival is outside the app's control: a fresh headless session has
       zero Media Engagement Index, so Chromium blocks the resulting
       `play()` call. Confirmed this is a genuine browser-policy interaction
       and not a code defect by reproducing the identical block against the
       legacy `wavesurfer.js` engine on an unflagged page. What IS asserted
       and passes: the controller correctly surfaces this as a visible
       `'error'` state (not a silent hang or a crash) — the row's button
       relabels to "Retry `<track>`" and a `role="status"` message appears —
       and **a real user-gesture click on that Retry button successfully
       starts playback** (confirmed: `state` goes to `'playing'`,
       `currentTime` advances against the real stream). That recovery path,
       not raw autoplay success, is the thing actually being guaranteed by
       the code and now verified.

       **Not covered, still needs a real device:** real Firefox, and real
       iOS/Android — WebKit-the-engine approximates Safari but isn't
       identical, particularly for mobile-specific autoplay/backgrounding
       behavior. And this was all against the **local** build — the
       production-origin verification (real caching, real headers, real
       deployed Worker) is a separate, still-outstanding step; see Step 5's
       5a below, which is where that belongs, not here.

       **Eighth Codex review, fixed same day (2026-08-14).** Requested focus
       was the `--prod` extension to `browser_check.mjs` built for Step 5a
       and PR #3's readiness to merge; it surfaced three findings in the
       *existing* Step 4 code instead, all confirmed and fixed, each with a
       fail-then-pass-proven regression test (full disposition:
       `player-consolidation-codex.md`):

       1. **Inactive-row DOM churn.** `_render()` only gated the
          progress/canvas paint path on active state — the button icon
          (`innerHTML`) and `aria-label` were rewritten unconditionally on
          every `timeupdate` tick, for every row, active or not,
          contradicting this doc's own "doesn't churn on every tick" claim
          above and a test that only ever watched the time label. Fixed
          with one early return in `_render()`, gated on the exact same
          `active`/`_wasActive` condition the progress block already used.
          The regression test now also watches `innerHTML`/`aria-label`
          writes, not just the time label.
       2. **Async peaks decoration wasn't actually inside the "one shared
          try/catch."** `attachPeaks()`'s fetch resolves after
          `bootShowPage()` has already returned and the page has already
          been claimed — a throw from one view's `setPeaks()` used to abort
          the whole per-view loop (views after it never decorated) and its
          own `.catch()` fallback then retried the *entire* loop from
          scratch, downgrading views that had already decorated correctly;
          a repeat throw on retry produced a genuine unhandled rejection on
          an already-claimed page. Fixed by making `apply()`
          exception-isolated per view (one bad row logs and moves on, the
          rest still decorate, no retry-from-scratch) with a trailing catch
          so the returned promise can no longer reject at all. Both
          overclaiming comments (the `bootShowPage` header and the
          `attachPeaks` call site) corrected to say plainly that the shared
          try/catch covers the decoration steps' synchronous *wiring* only,
          never `attachPeaks`'s asynchronous continuation.
       3. **`browser_check.mjs`'s "mounted"/"legacy dormant" checks didn't
          prove what their names claimed.** Fixed and reflected in the
          44/44 browser-pass numbers above.

       Local suite grew to 61 (`test-player-boot.mjs` 22 → 23). No
       overclaims survived — items 1 and 2 are now true exactly as
       originally documented; item 3 is why the browser-pass description
       above reads the way it now does.
5. [ ] **Restructured per a later Codex review's recommendation** (see that
       review's "the proposed Step 5 rollout is too compressed" concern in
       `player-consolidation-codex.md`): the original single checklist item
       below bundled "trust the 3-page canary enough to go site-wide" with
       "give up the waveform fallback" into one decision — and the canary
       has never actually been *deployed*, so it has never done canary duty.
       Split into an explicit sequence; each sub-step gates the next.

       5a. [x] **Deploy the existing 3-page allowlist as-is** (no widening,
       no deletions) and verify it on the production origin — real caching,
       real asset headers, real devices/browsers, not just the local browser
       pass from Step 4. This is the first time the canary actually functions
       as one.

       **Done (2026-08-14).** PR #3 merged (`7872882`), deploy Action green
       including the cache-purge step, `scripts/browser_check.mjs --prod`
       run against `https://renedebos.com`: **55/58 passed** on the second
       run (see below for the first). Confirmed for real against production:
       controller mounts with the correct view count and both legacy engines
       stay dormant (the corrected finding-#3 checks) on all three
       allowlisted pages; real playback/toggle/seek/Space/canvas against the
       real production stream; Hero → track → next; deep-link + Retry
       recovery; the `mad-sweetwater-2000-10-17` alt-transfer case; real
       cross-tab `BroadcastChannel` claim/pause with `/playlist/`; the four
       new JS assets serve with correct `Content-Type` and `Cache-Control`;
       and the five non-allowlisted sample pages are unaffected, three with
       confirmed real legacy playback.

       **One transient anomaly, did not reproduce.** The very first
       production hit (run immediately after the deploy Action's cache-purge
       step went green) failed broadly — `views=0`, both legacy engines
       appeared active, and the script crashed on an unguarded locator
       timeout. A direct `curl` of the same URL at that same moment showed
       the correct HTML (`cf-cache-status: MISS`, 21 real `data-item`
       occurrences, the right inline flag and script tag) — so the deployed
       page itself was never wrong; whatever the first Playwright hit saw
       didn't match reality. A minimal standalone diagnostic script and a
       full second `--prod` run, both a few minutes later, came back clean.
       Likely a cold-start/edge-propagation timing artifact specific to the
       very first request after a fresh deploy+purge, not a defect in the
       code — but logged here rather than discarded, since "didn't reproduce
       twice" is evidence, not proof. Worth a longer post-green buffer (the
       plan's open judgment call #5) if this is ever seen again.

       **Real, reproducible, pre-existing finding — not from this PR.** All
       three canary pages show one console error: Cloudflare's own
       auto-injected analytics beacon
       (`static.cloudflareinsights.com/beacon.min.js`) is blocked by the
       site's existing CSP (`script-src 'self' 'unsafe-inline'` has no
       exception for it). Confirmed this is site-wide and unrelated to
       player-consolidation by checking `/contact/` (untouched by this
       initiative) — identical error. Never seen before because no prior
       deploy ever ran a real-browser console-error check against the live
       Cloudflare-proxied origin; the local `python3 -m http.server` pass
       can't reproduce it (Cloudflare only injects the beacon on the real
       proxied origin). Reported, not fixed here — `_headers`/CSP is
       `deploy-infra` territory, per this step's own scope discipline.

       5b. [x] **Expand the allowlist to all show pages, keeping
       `wavesurfer.js` as the dormant fallback.** Every show page emits the
       engine flag and `player-boot.js`; `wavesurfer.js`'s module tag keeps
       being emitted too, so a page whose controller mount fails still has
       its full runtime fallback (module/asset failures in `player-boot.js`/
       `player-views.js`/`player-controller.js` specifically — see the
       caveat below for what this does and doesn't cover). Verify the wider
       rollout the same way as 5a before treating it as settled.

       **Done (2026-08-14).** `CONTROLLER_ENGINE_SLUGS` (`pages.py`) is now
       `{s["slug"] for s in PUBLIC_SHOWS} - CONTROLLER_ENGINE_EXCLUDED_SLUGS`
       — computed, not hand-listed, so a future new show is covered
       automatically with no manual sync step. `CONTROLLER_ENGINE_EXCLUDED_SLUGS`
       (currently empty) is the escape hatch for a targeted single-page
       rollback without reverting the whole rollout. A ninth Codex review
       (before this step started — see below) had already caught and fixed a
       comment that got this backwards ("empties this out... flips the
       engine on everywhere" — the gate is a membership check, so emptying
       it would have disabled the controller everywhere).
       `verify_markup.py`'s default build gate now also asserts full
       coverage (previously an opt-in-only flag, since the 3-page rollout
       was intentionally partial before this step).

       **`browser_check.mjs` restructured for the full catalog, not just
       widened.** Running the complete real-audio-playback sequence on all
       30 pages would be slow and, for `--prod`, would mean streaming real
       production audio 30 times for what's fundamentally the same engine
       code on every page. Split into two tiers: a **light** check (mount,
       real view count vs. markup, both legacy engines' dormancy, console
       errors) on every one of the 30 pages, and the full **heavy** check
       (real playback/toggle/seek/Space/canvas) on 4 pages chosen for
       genuinely different markup shapes — the original 3 (plain waveform
       rows; two hero cards; an alternate-transfer stream-proxy collision)
       plus `jerry-19-broadway-1999-03-29`, the largest page in the whole
       catalog (34 tracks, 5 recording cards) — a real stress test for the
       eighth review's inactive-row-DOM-churn fix at a materially larger
       row count. The show list itself is fetched once at runtime from
       `assets/home-shows.json` (the same asset the homepage uses), not
       hardcoded, so this file never needs manual updating again regardless
       of catalog size. Local pass: **184/184**. The `isRemote` code path
       (asset headers, non-allowlisted-page checks) verified against a local
       server standing in for production, without touching real production:
       **192/196** — same 4 known, pre-existing `Cache-Control` non-passes
       as every prior local-server-as-remote run (a bare `python3 -m
       http.server` doesn't set Cloudflare's real headers). Confirmed the
       non-allowlisted-show-page check now correctly self-skips, logging why,
       since every show is allowlisted post-5b — exactly the defensive
       design built for this in the ninth review's fixes, now exercised for
       real for the first time.

       **Production verification for this step is still pending** — the
       process is identical to 5a's (merge the PR, watch the deploy Action
       including cache purge, then `browser_check.mjs --prod`), not a new
       procedure; this section will be updated with the result once it runs.

       5c. [ ] **Delete `wavesurfer.js` as its own, later, separate
       decision** — only once confidence from 5b is established, not as part
       of the same step. This is the point at which "remove only what is
       provably unreferenced" (below) actually applies. **What this step
       actually costs, and one qualifier on that cost (seventh review):**
       until this point, a `player-boot.js`/`player-views.js`/
       `player-controller.js` failure degrades to today's full legacy pair;
       after it, to `player.js` alone, which can only drive the recording
       cards. But even before this step, "today's full legacy pair" was
       never the fallback for a `wavesurfer.esm.js` failure specifically —
       that shared dependency has always been a single point of failure for
       waveform rows in both engines, since before this initiative existed.
       This step doesn't create a new gap there; it just removes the code
       (`wavesurfer.js`) that made the gap easy to describe as "the waveform
       half" in the first place.
       (`wavesurfer.js`'s engine-selection branch goes with the file. The
       `pre_scripts` flag and `player.js`'s gate stay — `player.js` is still
       the fallback, and still serves song pages and `/playlist/`.)

       The verification/cleanup notes below were written for the original,
       unsplit step and still apply — read them as covering 5b (the allowlist
       widening) and 5c (the `wavesurfer.js` deletion) together.

       **Do NOT delete `initCustomPlayers` or the claim globals from
       `player.js` in this phase** (Codex catch — an earlier draft of this
       step would have broken untouched pages the same phase claimed not to
       touch). `songs.js:72` still calls bare `initCustomPlayers(container)`
       for lazily-inserted song-page rows, and those rows deliberately don't
       get `data-item` markup until song pages migrate; `/playlist/` still
       calls `claimPlayback`/`onExternalClaim` as ambient globals. Both keep
       working untouched because the legacy code stays. Note also that the
       legacy signature is `onExternalClaim(fn, owner)` while the new
       internal helper is `onExternalClaim(owner, fn)` — transposed. That
       mismatch is a real trap for any future bridge/facade, and is precisely
       why this phase builds no such bridge: nothing on a migrated show page
       calls the legacy globals at all, and cross-document coordination
       already works because both implementations post to the same
       `BroadcastChannel` name with the same wire format.

       `scripts/wavesurfer.js` **can** be deleted here — verified that
       nothing else in the site references it (its only consumers are the
       show-page rows this phase migrates, plus `build_wavesurfer_lab()`,
       handled in step 6). *Verify:* full build + `--check` passes; a real
       song page and `/playlist/` still play correctly with the legacy engine
       untouched; cross-tab claim/pause still works between a migrated show
       page and `/playlist/`.
6. [ ] Deferred housekeeping: `build_wavesurfer_lab()`'s fourth row-markup
       copy (`.ws-row`, zero production traffic) — delete or update to the
       unified shape after parity is proven. Note this is coupled to step 5's
       `wavesurfer.js` deletion (the lab page is its other consumer), so
       either do them together or leave both until this step.

**Legacy-removal debt this phase deliberately leaves behind** (not
oversights — each waits for the phase that makes it safe):
`initCustomPlayers`, the `activePlayer`/Space-bar block, and the
BroadcastChannel implementation all stay in `player.js` until song pages
(for the first) and `/playlist/`/`/player/` (for the rest) have migrated.
The final cleanup — including collapsing the transposed
`onExternalClaim` signatures into one — belongs to whichever phase migrates
the last consumer.

**Implementation gate before Step 5 deletes any old engine (Codex's second
review):**
- [x] queue-origin semantics for show pages written down (page load →
      `setQueue()` with every row; Hero card → `playSingleton()`)
- [x] controller API and module-loading strategy settled: legacy `player.js`
      stays a classic script and keeps its globals for unmigrated consumers,
      while migrated show pages are gated off it entirely by a page-level
      engine flag — **no bridge/facade is built**, since nothing on a migrated
      page calls the legacy globals (§3, Step 4)
- [x] literal parity checklist exists (§3)
- [x] the shared controller works with existing show-page markup (Step 4) —
      built, covered by deterministic tests, and confirmed against real
      Chromium/WebKit (`scripts/browser_check.mjs`, 2026-08-14, 44/44)
- [x] stale-play and queue-transition tests pass
      (`test-player-controller.mjs` 22/22, `test-player-views.mjs` 16/16)
- [x] the old engine remains available as a fallback during the allowlist
      step — by design (Step 4 keeps both live until Step 5), and now
      confirmed for real by the two breakage tests in
      `scripts/browser_check.mjs`, not just reasoned about

**Explicitly not touched this phase:** song pages (`_song_occ_html`,
`songs.js`'s `initCustomPlayers` re-invocation for lazily-inserted rows),
`/playlist/`, `/player/`. Their eventual migration reuses the same
schema/controller — the intended foundation for it, though (per Phase 2's
note) only `removeAt` parity has actually been demonstrated, so expect real
adaptation work rather than a drop-in. `songs.js`'s lazy re-mount becomes
`window.PlayerController.mountCompactRows(container)`, wrapping
`container.querySelectorAll('[data-item]').forEach(...)`, same
call-repeatedly-safely contract as today's `if (player._audio) return;`
guard.

### Phase 2 — `/playlist/` (not started)

Migrate onto the same `PlaybackController`/view classes without losing
shuffle, saved queues (`localStorage['savedPlaylists']`), restore, or Media
Session behavior. `itemFromCatalogRow(row)` (mapping `assets/tracks.json`
rows to the playable-item schema) gets built here. Not detailed further
until Phase 1 proves the controller/view split end-to-end.

Known parity work waiting for this phase, rather than assumed-free:
`removeAt()`'s legacy slide-in semantics are already ported and tested, but
the rest of the queue-editing surface (`reorder()`, endless-mode reshuffle,
`#p=` hash resync, saved-playlist round trips) has **not** been demonstrated
against the real `playlist.js` behavior — treat the controller as the
intended foundation, not a proven drop-in. This is also where the
`localStorage` state shape gets versioned (with invalid/future versions
degrading to a clean queue rather than partially restoring), and where
queue length from persisted/URL-derived sources needs an explicit bound.

### Phase 3 — `/player/` popup (not started)

Separate document, own controller instance, identical module/state schema.
This is also the natural point to switch the BroadcastChannel wire format
to a structured/validated message shape (§2), since every claim-protocol
participant changes together instead of needing a dual-format bridge.

### Phase 4 — loudness control (not started, not scoped)

See §2's Loudness section for everything already known, including the
mp3TruePeak headroom data. Genuinely unscoped until deliberately picked up.

### Cross-phase, not yet assigned to a specific phase

- [ ] Define the timestamp URL grammar against existing `#p=`/`&t=`/
      `#track-N`/`?autoplay=1` usage
- [ ] Build repeat-one and keyboard-shortcut UI surfaces on top of the
      controller-level mechanisms that already exist
- [ ] Manual spot-check on Safari/Chrome/Firefox, mobile and desktop, once
      each phase has something to check
- [ ] **Wire the deterministic Node suites into an actual deployment gate**
      (a later Codex review's suggestion). `build.py` already runs
      `verify_markup.py` automatically as a build-integrity gate — running
      `node scripts/test-*.mjs` alongside it before deploy is the same
      philosophy one step further. A full cross-browser matrix stays
      disproportionate for this project (§3 already declines that); running
      the 60+ already-written, already-fast, already-passing tests before
      shipping is not. Not urgent while Phase 1 is still mid-rollout, but
      worth doing once Step 5 stabilizes rather than continuing to run them
      by hand.

## 7. Review loop

Reviews from the fifth onward are produced by **`scripts/codex_review.sh`**,
which runs `codex exec -s read-only`, captures the result, and appends it to
this initiative's `*-codex.md`. Codex cannot modify the repo; only the script
writes, and only by appending — the plan itself is never touched. Path
derivation is generic (`*-plan.md` → `*-codex.md`), so it works for future
`plans/` initiatives too.

```
scripts/codex_review.sh plans/<initiative>/<topic>-plan.md "<what to focus on>"
```

`/review-step` (`.claude/commands/review-step.md`) runs that script, verifies
each finding against the code, and records a disposition (confirmed / declined
/ already handled) in the review log — **then stops**, deliberately. It never
applies anything itself. `/apply-review` is the separate command that
implements the confirmed findings, run only after a human has seen the
disposition and approved acting on it. This split (corrected here — an earlier
draft of this section described a single command that both verified and
applied) is what keeps the judgment step human-gated: replacing what used to
be a four-message manual relay with two commands, not one that quietly does
both jobs.

**Deciding which findings hold is deliberately not automated.** Several Codex
suggestions here have been correctly declined (a separate `downloads.js`, a
structured `BroadcastChannel` wire format mid-migration), and several real bugs
were caught only because a claim was traced rather than trusted — including a
test that passed for the wrong reason. Applying findings wholesale would lose
exactly the thing that has made this loop valuable.

## 8. Session & Branch Workflow

This project uses its own dedicated branch and worktree, same pattern as the
home-page project (fuller writeup: `plans/home-page/home-page-codex.md` in
the `home-page` branch/worktree):

- Branch: `player-consolidation`
- Worktree: `/home/renedebos/renedebos.com-player-consolidation`

Sync with `main` at the start of a session — not on a fixed schedule —
`git fetch origin && git merge origin/main` (not `git fetch origin main &&
git merge main`, which can merge a stale local `main` depending on which
checkout most recently advanced it — `origin/main` after a fresh fetch is
unambiguous). This keeps the branch from
drifting too far from what `main` picks up elsewhere (audio-processing
work, other projects' merges) and lets any conflict surface while someone
is actually present to resolve it, rather than piling up silently. Do this
again right before opening or updating this project's pull request, even if
it was done recently.
