# Player consolidation: Feature Proposal

Status: **in progress.** Rollout is incremental, one surface at a time —
see §6. Phase 1 (show pages) Steps 1–4 are built: `PlaybackController`, the
view layer, the `data-item` markup every show page carries, and
`player-boot.js` — 61 passing deterministic tests across
`test-player-controller.mjs` (22), `test-player-views.mjs` (16) and
`test-player-boot.mjs` (23), plus `scripts/browser_check.mjs`'s real-browser
pass (185/185 locally, see below). **Every public show page now runs the
new engine** (Step 5b, `pages.CONTROLLER_ENGINE_SLUGS`); only song pages
stay on the legacy engine this phase. **Steps 4, 5a, 5b, and 5c are all
done, including production verification for each — Phase 1 for show pages
is complete**: PR #3 (Step 4 + the 3-page canary, `7872882`), PR #4 (Step
5b's full rollout, `fd0a68e`), and PR #5 (Step 5c, deleting the legacy
`wavesurfer.js` engine and its `/lab/wavesurfer/` prototype, `1a19160`) all
merged, deployed, and verified against real production.
`scripts/browser_check.mjs --prod` most recently ran 166/167 against all 30
live show pages (the one failure is a pre-existing check-script timing
flake in an unrelated `/playlist/` assertion, investigated and confirmed
not a regression — see Step 5's entry). `player.js` is now the sole legacy
fallback on every show page. See §6 Step 5's entry for the full record,
including a ninth review (5b-readiness), a tenth (the 5b implementation
itself), and two more for 5c's implementation and production verification.
Mockup: https://claude.ai/code/artifact/71ae2166-d3ed-471d-9719-abd73fe353ba
Reviewed by Codex ten times, all recorded in
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

### Phase 1 — show pages (complete)

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
5. [x] **Restructured per a later Codex review's recommendation** (see that
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

       **Implementation done (2026-08-14).** `CONTROLLER_ENGINE_SLUGS` (`pages.py`) is now
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
       catalog (34 tracks, 5 recording cards) — genuinely, not just by
       description, a stress test for the eighth review's inactive-row-DOM-
       churn fix: this page's heavy check attaches a real `MutationObserver`
       to an inactive row through the whole playback/toggle/seek/Space
       sequence and asserts zero mutations (`mutations=0`, confirmed) — an
       actual measurement, not an inference from unrelated checks passing.
       The show list itself is fetched once at runtime from
       `assets/home-shows.json` (the same asset the homepage uses), not
       hardcoded, so this file never needs manual updating again regardless
       of catalog size. Local pass: **185/185**. The `isRemote` code path
       (asset headers, non-allowlisted-page checks) verified against a local
       server standing in for production, without touching real production:
       same 4 known, pre-existing `Cache-Control` non-passes as every prior
       local-server-as-remote run (a bare `python3 -m http.server` doesn't
       set Cloudflare's real headers). Confirmed the non-allowlisted-
       show-page check now correctly self-skips, logging why, since every
       show is allowlisted post-5b — exactly the defensive design built for
       this in the ninth review's fixes, now exercised for real for the
       first time.

       **A tenth review, on this implementation itself, found and fixed one
       real bug plus two lower-stakes gaps before merging (full record:
       `player-consolidation-codex.md`).** The important one:
       `CONTROLLER_ENGINE_EXCLUDED_SLUGS`'s rollback escape hatch, as first
       built, was rejected by `verify_markup.py`'s own coverage check —
       excluding a show dropped it from `CONTROLLER_ENGINE_SLUGS`, which the
       old two-way check then flagged as "missing," meaning
       `build.py --check` would have failed the moment anyone actually used
       the mechanism for a real incident rollback. Fixed with a three-way
       check (allowlisted, or deliberately excluded, or a genuine gap — only
       the last is an error) plus a new `assets/controller-excluded-slugs.json`
       asset so `browser_check.mjs` can tell an intentional exclusion apart
       from a broken page instead of reporting a false mount failure.
       Reproduced the bug directly before fixing it, and simulated a real
       exclusion end-to-end afterward to confirm the fix actually works, not
       just that the unit tests pass. Also added a defensive check that
       `browser_check.mjs` fails loudly rather than silently if
       `home-shows.json` is ever missing one of the 4 heavy-check pages, and
       documented — not yet fixed, out of scope — that `home-shows.json`
       only includes track-listed shows while `CONTROLLER_ENGINE_SLUGS`
       covers every public show; they coincide today but a future trackless
       public show wouldn't be caught by this harness.

       **Production verification: done (2026-08-14).** PR #4 merged
       (`fd0a68e`), deploy Action green including the cache-purge step,
       `scripts/browser_check.mjs --prod` run against `https://renedebos.com`
       covering all 30 live show pages: **197/197 passed** — no failures at
       all this run, not even the known Cloudflare-beacon CSP warning (now
       correctly filtered), and no repeat of 5a's transient first-hit
       anomaly. Every page mounts with the correct view count, both legacy
       engines stay dormant, real playback/toggle/seek/Space/canvas work
       across the heavy-check sample (including the DOM-churn
       `MutationObserver` assertion on the largest page, confirmed
       `mutations=0` against the real production page, not just locally),
       the Hero/deep-link/alt-transfer/cross-tab mechanisms all hold, asset
       headers are correct, and the five non-canary sample pages are
       unaffected. **The controller engine is now genuinely live on every
       public show page**, not just the original 3-page canary.

       5c. [x] **Delete `wavesurfer.js` as its own, later, separate
       decision** — only once confidence from 5b is established, not as part
       of the same step. Implementation and local verification done
       (2026-08-14): `scripts/wavesurfer.js` and `/lab/wavesurfer/` deleted
       (item 6 below folded in, done together as suggested there); `build.py`
       stopped writing `assets/wavesurfer.js`; `build_show()` drops the
       `<script src=/assets/wavesurfer.js>` tag but keeps `WS_PEAKS_URL` +
       the peaks JSON write (shared infra — `player-boot.js`'s
       `attachPeaks()` reads it too, not legacy-only); lab-only CSS removed,
       `.ws-wave`/`.ws-dl` correctly kept (live production classes on
       `.track-row.ws-track`); `browser_check.mjs`'s dormancy check for the
       now-deleted engine removed, breakage Test A3 rewritten to prove
       waveform rows are correctly inert when `player-boot.js` is disabled
       (hardened with a `play()`-spy per a review finding — see codex.md —
       so a detached-audio regression can't hide from `findAudioDeep`'s
       DOM-only search); stale `wavesurfer.js` references in `player.js`
       comments and `pages.py` corrected. Local: build/`--check` clean, all
       4 test suites pass (23/23, 22/22, 16/16, plus build's own markup
       check), `browser_check.mjs` 155/155. Two Codex review passes done,
       all confirmed findings fixed (see codex.md for both). **Production
       verification: done (2026-08-15).** PR #5 (`88df4f8`/`9461e48`, merge
       commit `1a19160`) merged, Action `31857142955` green,
       `browser_check.mjs --prod` against all 30 live show pages: 166/167 —
       the one failure (`/playlist/ real legacy playback works`) was
       investigated directly (a standalone Playwright reproduction against
       production) and confirmed to be a pre-existing tight-timing
       assertion in the check script itself (playback genuinely starts and
       advances, just crosses `0:00` slightly after the check's 2.5s wait
       on a colder run) — `/playlist/`/`playlist.js` are untouched by this
       step's diff, so this isn't a regression; tracked as a known flake,
       not fixed as part of this step. Also confirmed:
       `curl -sI https://renedebos.com/lab/wavesurfer/` → 404 (expected);
       no live show page's HTML references `/assets/wavesurfer.js`;
       `WS_PEAKS_URL` correctly still present. **Phase 1 for show pages is
       now fully complete** — every public show page runs the shared
       controller with `player.js` as the sole legacy fallback.

       This is the point at which "remove only what is
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
6. [x] Deferred housekeeping: `build_wavesurfer_lab()`'s fourth row-markup
       copy (`.ws-row`, zero production traffic) — delete or update to the
       unified shape after parity is proven. Note this is coupled to step 5's
       `wavesurfer.js` deletion (the lab page is its other consumer), so
       either do them together or leave both until this step. **Done
       (2026-08-14), together with 5c as suggested**: `build_wavesurfer_lab()`,
       `WAVESURFER_LAB_SLUG`, `/lab/wavesurfer/index.html`, and the lab-only
       `.ws-list`/`.ws-row*` CSS were all deleted rather than updated — the
       page's own purpose (comparing wavesurfer.js against the alternative)
       was moot once wavesurfer.js itself was gone.

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

### Phase 2 — `/playlist/` (complete: Stage 2c deleted the legacy engine, 2026-08-15)

**Scoping/test-prep pass completed 2026-08-15** (see
`~/.claude/plans/read-handoff-md-fuzzy-rossum.md` for the working copy this
was folded from — full assertion tables, exact `itemFromCatalogRow`
field-by-field mapping, and all `checkPlaylistPage()` checks live there in
more detail than reproduced here). Two agents did the underlying research
(an Explore pass mapping current `scripts/playlist.js` against the Phase 1
architecture; an Opus Plan pass turning that into a design), then a Codex
review of the resulting design was verified line-by-line against the
actual source and found five real, confirmed defects — corrected in place
below, not just noted.

**Stage 2a implemented 2026-08-15** (`scripts/playlist-boot.js`,
`scripts/playlist-views.js`, the `player-controller.js` additions, the
`playlist.js`/`pages.py`/`build.py`/`verify_markup.py`/`browser_check.mjs`
wiring described below) — all as designed, plus one deliberate divergence
found necessary during implementation: `prev()` at queue start is handled
at the view level (`PlaylistNowPlayingView._prev()`), not by changing the
shared `PlaybackController._advance()`, to avoid touching an
already-shipped Phase 1 primitive other pages depend on for a
single-page's parity choice. A Codex review of the implementation
(`player-consolidation-codex.md`'s "Phase 2 Stage 2a implementation
review") found 7 findings; 6 confirmed as real (5 fixed: the transactional
mount-or-teardown gap, the stuck "paused elsewhere" status message, an
unconditional per-tick highlight scan, `verify_markup.py`'s unimplemented
default-match invariant, and `appendQueue()`'s bound-after-normalize
ordering; 1 — fixed browser-check timing waits — declined as out of scope,
pre-existing throughout `browser_check.mjs` since Phase 1) plus a
confirmed test-coverage gap (partially closed: added a `next()`-triggered
endless-rollover test; the rest of the parity matrix — rename, storage
sync, page-level shuffle-restore-by-id, share/ZIP/popup — remains
untested by the new suites, tracked as a known gap, not a shipped-behavior
bug). Local suites: 97/97 passing (24 unchanged Phase 1 tests across three
suites, +2 from the `appendQueue` fix, +27 new across
`test-playlist-views.mjs`/`test-playlist-state.mjs`, +2 from this review's
fixes, +1 coverage addition). `build.py --check`, `build.py`,
`verify_markup.py`, and `--check-allowlist-coverage` all clean.
`browser_check.mjs`'s new `checkPlaylistPage()`/`runPlaylistBreakageTest()`
are syntax-checked only — not run; no `playwright-chromium` in this
environment.

**Deployed 2026-08-15** (PR #10, commit `4400531`) — merging it broke the
deploy workflow: the new `test-playlist-state.mjs` suite used a plain
`globalThis.navigator = {...}` assignment, which throws under CI's Node
(a getter-only accessor there; the same class of bug fixed for
`test-player-controller.mjs` in `5078e47`, but this file predated that fix
and local dev Node has no such global to catch it). Fixed and deployed in
PR #11 (commit `ed01f2f`). **Rene then did a full manual pass on
production** at `?engine=controller`: mount, queue build/play, next/prev,
share-link round-trip, saved playlists, endless rollover, remove/shuffle,
cross-tab external-claim, and `?engine=legacy` fallback all confirmed
working. One thing noticed and deliberately left as-is: playback controls
(play/shuffle/prev/next) disappear entirely once a non-endless queue plays
to its end — traced to `PlaybackController.stop()` setting `currentItem`
to `null`, which `PlaylistNowPlayingView` treats as "hide the whole
panel." Confirmed this is byte-identical to legacy `playlist.js`'s own
`renderNow()` at `idx === -1` (`playlist.js:696`) — faithful parity, not a
Stage 2a regression, so left unfixed per Rene's explicit call.

**Post-deploy Codex review, 2026-08-15** (`player-consolidation-codex.md`'s
"Phase 2 Stage 2a post-deploy review" section — requested via a direct
`mcp__codex__codex` call rather than `scripts/codex_review.sh`, scoped to
what the pre-merge review round missed plus `ed01f2f`, which had no review
pass at all). Found 5 real issues, no high-severity regressions; `ed01f2f`
itself verified correct and complete. 4 fixed: `verify_markup.py`'s
`check_playlist_engine_wiring()` used to accept a template regression that
dropped BOTH the resolver script and the boot-module tag at once (now
gated on `playlist.js`'s presence — the pre-/post-2c signal — instead of
only firing on resolver/boot disagreement); `MAX_SAVED_PLAYLISTS` was
enforced only on write, so an oversized/tampered `localStorage` value
would still render unbounded DOM (now capped in `loadSaved()`, the read
boundary, too); a seek-drag interrupted by a track change left `_seeking`
stuck `true` forever, freezing the progress range (now reset on every
`currentItem.id` change); and the endless-rollover test captured
`firstOrder` but never asserted against it, so a rollover that silently
replayed the same order would still have passed (now proven with scripted
`Math.random` — deterministically different order, still the same pool —
plus a corrected comment that had wrongly claimed `browser_check.mjs`
covers Media Session's `nexttrack` wiring, which it does not). 1 left
open, flagged to Rene rather than auto-fixed: `syncHash()` drops the
`?engine=` query param when the queue empties (`win.location.pathname`
with no search string) — real, but byte-identical to legacy
`playlist.js:338-341`, so fixing it now would be a deliberate departure
from established legacy-parity behavior mid-canary, not a bug fix. Local
suites: 99/99 passing (+2 from this round: one new oversized-saved-array
test, one new seek-drag-freeze test; two existing tests strengthened
without adding to the count). `build.py --check`, `build.py`,
`verify_markup.py`, and `--check-allowlist-coverage` all clean; generated
assets confirmed byte-identical to their `scripts/` sources.

Stage 2a's own "done when" criteria (§ above) are now fully met: parity
tests pass, `--prod`+param confirmed working, no-param behavior
unchanged, and Rene has done the manual production pass.

**Stage 2b: flipped 2026-08-15.** `PLAYLIST_CONTROLLER_ENGINE` is now
`True` in `pages.py`; the resolver's baked-in default literal in the
generated markup confirmed flipped `false` → `true`
(`playlist/index.html`'s resolver snippet). `PlaybackController` is now
the default engine for every visitor to `/playlist/`; `playlist.js`
remains loaded as the runtime fallback, and `?engine=legacy` is the
manual escape hatch — both stay in place through Stage 2c's 2+ week soak
(decision #4, § above). `build.py`, `verify_markup.py`, and
`--check-allowlist-coverage` all clean after the flip.

**Stage 2c: implemented and shipped 2026-08-15, same day as Stage 2b —
Rene explicitly waived the 2+ week soak** (decision #4 above), on the
basis that the only realistic blast radius of a bad Stage 2c is
client-side `savedPlaylists` localStorage state, never the audio files or
any server-side data — a risk profile that doesn't actually benefit from
a calendar-time soak the way a silent-data-loss-in-the-wild scenario
would. **The real-browser gate was NOT waived** — a Codex review of the
waiver request caught that skipping the soak made the (until-then only
syntax-checked) `browser_check.mjs --prod` run the sole remaining
real-world check, so it was closed properly instead of skipped: this
session installed `playwright-chromium` into the environment (previously
absent) and ran `browser_check.mjs --prod` for real against
`https://renedebos.com`, twice — 177/178 the first time, 178/178 after a
genuine bug the run itself surfaced was fixed (see below).

Deleted `scripts/playlist.js`/`assets/playlist.js` and the entire
`?engine=`/`window.PLAYLIST_ENGINE` resolver mechanism (`pages.py`'s
`build_playlist()`, `PLAYLIST_CONTROLLER_ENGINE` constant, and
`playlist-boot.js`'s auto-run gate all simplified to unconditional —
`playlist-boot.js` is now the only engine and mounts at parse time, no
flag to check). `verify_markup.py`'s `check_playlist_engine_wiring()`
rewritten for single-engine reality: playlist-boot.js's script tag present
exactly once, legacy playlist.js and any leftover `PLAYLIST_ENGINE`/
`?engine=` wiring text both absent, `window.WORKER_ORIGIN` still set (that
one's unrelated to engine selection but was previously emitted only
inside the now-deleted resolver script, so its removal was exactly the
kind of edit that could have silently dropped it too). The storage
dual-write question this section describes above is now moot by
construction — there was never any actual dual-write *code* to remove,
only a comment noting the flat key was kept canonical specifically to
avoid needing one; that comment is now simply accurate rather than
forward-looking.

`browser_check.mjs`'s `runPlaylistBreakageTest()` (the "rename
playlist-boot.js, confirm playlist.js takes over" breakage test) was
**deleted outright, not retargeted to a fake-graceful-degradation
assertion** — a Codex review of the deletion plan correctly flagged that
asserting "no mount flag + no crash" after removing the only engine just
blesses a dead page as a pass condition, not a real degradation test; a
missing `playlist-boot.js` is a broken deploy now, already caught by
`verify_markup.py`/`build.py`'s asset-existence checks and by the real
`checkPlaylistPage()` smoke check. `checkPlaylistPage()` itself: dropped
the `?engine=controller` param (no longer meaningful) and the "legacy
playlist.js stayed dormant" step (nothing sets that signal anymore).

**A real, previously-undetected bug surfaced by actually running
`browser_check.mjs --prod` for real for the first time** (it had only
ever been syntax-checked before, per this section's Stage 2a/2b entries
above): the hash round-trip check's "reload" (`page.goto(BASE + url +
hash1, ...)`) navigated to a URL byte-identical to the one the page was
already on — per the HTML spec, navigating to a URL differing only by
fragment (or not at all) is a same-document navigation with no unload/
load and no JS state reset, verified directly against production (a
`window` marker set before the `goto()` survived it, but not a
`page.reload()`). The check had therefore never actually reloaded
anything; it silently re-read the same live, still-mid-playback
controller instance from the previous step and always reported `playing:
true`. Fixed by using `page.reload()` instead of reconstructing the URL.
This is a distinct issue from the pre-existing `browser_check.mjs` timing
flake documented in Phase 1's Step 5c entry above (a tight 2.5s playback
timing assertion) — this one is a same-document-navigation bug in the
hash round-trip check specifically, not a timing issue, and it now passes
for real rather than merely not crashing.

`TAG_ORDER`'s home moved from the deleted `playlist.js` to
`playlist-boot.js`; `PUBLISHING.md`'s two references to it updated
accordingly (and `manual/index.html`, generated from `PUBLISHING.md`,
picked up the fix on rebuild). `track-select.js`'s comments describing
integration with `playlist.js` (the `trackAddButtonHtml()` global
consumer, the hashchange listener) updated to name `playlist-views.js`/
`playlist-boot.js` instead. `site_worker.js:173` still has one stale
`scripts/playlist.js` comment reference — left alone (deploy-infra's
file, not this initiative's to edit) and flagged for that team to clean
up whenever they're next in the file.

`test-playlist-state.mjs` had dead-but-green setup/assertions left over
from the deleted engine-selection mechanism (`win.PLAYLIST_ENGINE =
'controller'` assignments that nothing read anymore, and an assertion
message claiming a mount failure meant "`playlist.js` takes over" when
there both was no `playlist.js` in this test's fixture and, now, no such
file at all) — removed, and replaced with a real test proving the
controller mounts unconditionally even when the URL still carries a
stale `?engine=legacy` param, which the module doesn't read at all
anymore (proven by construction: the test passes `search: '?engine=legacy'`
and asserts the mount flag still ends up `true`).

Local suites: **119/119 passing** (`test-player-boot.mjs` 23,
`test-player-controller.mjs` 26, `test-player-views.mjs` 17,
`test-playlist-state.mjs` 19 [+1 from the `?engine=legacy`-is-ignored
test above], `test-playlist-views.mjs` 15). `build.py`, `build.py
--check`, and `verify_markup.py` (including its own expanded selftest)
all clean. `browser_check.mjs --prod`: **178/178**, real audio playback,
real cross-tab `BroadcastChannel` coordination between `/playlist/` and a
show page, and the hash round-trip fix above all verified against the
live site — the first time this script has ever been run for real rather
than syntax-checked.

**What has to move.** `scripts/playlist.js` (868 lines) does eight
separable jobs; only two are the actual migration:

| Job | Current location | Disposition |
|---|---|---|
| Catalog fetch + facet filters | `playlist.js:60–270` | Moves unchanged into new boot module |
| Queue building (dedupe/modes/amounts) | 279–295 | Moves unchanged, stays in catalog space |
| Hash sync/hydration | `syncHash` (317), `hydrateFromHash` (544) | Re-homed, inverted: hash becomes a projection of controller state |
| Saved playlists (localStorage) | 444–536 | Moves; validation/degrade added to the existing flat shape (versioning deferred, see below) |
| Share link / ZIP manifest / popup | 340–443 | Moves nearly unchanged, reads from `controller.*` instead of local vars |
| Playback engine (`<audio>`, transport, claim/pause, Media Session) | 564–680 | **Deleted**, replaced by `PlaybackController` — the actual migration |
| Queue/now-playing DOM (`renderQueue`, `renderNow`, `removeAt`, `toggleShuffle`) | 703–830 | **Becomes two new view classes** — the genuinely new capability |
| `track-select.js` integration | 792, 779 | Preserved verbatim (string-level class-name contract) |

**Stage plan — 3 stages**, using a `?engine=controller` query-param canary
(there's only one page, so no slug allowlist applies):
- **2a** — ship the whole new engine live, gated OFF by default, reachable
  only via `?engine=controller`. `playlist.js`'s deferral must mirror
  `player.js`'s actual conditional (`player.js:217-223`: defer-and-check
  only when the engine flag could be `'controller'`, otherwise still init
  immediately at parse time — not an unconditional defer, which would
  change 2a's own no-param behavior). New `scripts/playlist-boot.js` mirrors
  `player-boot.js`'s transactional mount-or-teardown (`player-boot.js:59-127`
  — try/catch + `controller.destroy()` on any throw, not just a flag gate;
  test with an injected mid-mount failure, not only a missing asset). Flag
  set synchronously on shell mount, not catalog arrival (catalog fetch is
  async — a deliberate divergence from `player-boot.js`). `pages.py`
  `build_playlist()` gets `PLAYLIST_CONTROLLER_ENGINE`, the resolver script,
  and a `window.WORKER_ORIGIN` emit (`player.js`'s `WORKER` const is a
  lexical binding, not on `window`). `scripts/build.py` needs new
  `write("assets/playlist-boot.js", ...)` and `write("assets/playlist-views.js", ...)`
  lines (every asset there is hand-listed, no directory-copy fallback).
  Done when parity tests pass locally and `--prod`+param, no-param behavior
  (including load-time ordering) is unchanged, and Rene has done a manual
  prod pass.
- **2b** — flip `PLAYLIST_CONTROLLER_ENGINE = True`. `playlist.js` stays as
  dormant fallback; `?engine=legacy` is the manual escape hatch. Done when
  `browser_check.mjs --prod` passes with no param and the legacy path still
  works via the param.
- **2c** — delete `scripts/playlist.js`, after **2+ weeks** of default-on
  production (longer than Phase 1's one-week precedent — saved-playlist
  failure is silent data loss, not a visible error a quick check catches)
  plus a clean `--prod` run. **Amended 2026-08-15: the soak itself was
  explicitly waived by Rene** (client-side `savedPlaylists` localStorage
  is the only realistic blast radius, never audio files or server data);
  the clean `--prod` run was kept as a hard requirement and closed with a
  real (not syntax-checked) `browser_check.mjs --prod` pass — see this
  section's Stage 2c entry above for the full record, including a real
  bug the first real run of that check surfaced and fixed.

**View layer.** `PlayerView` is the wrong base class — both `#pl-now` and
`#pl-queue` are queue-scoped, not item-scoped (`PlayerView` binds `this.item`
at construction). New **`scripts/playlist-views.js`** (a separate file, not
an addition to `player-views.js` — that file unconditionally imports
WaveSurfer at `player-views.js:13`, which `/playlist/` must never depend
on) gets: `QueueView` (new base implementing the real 3-method mount
contract — `onAttach`/`onDetach`/`onControllerUpdate`), `PlaylistQueueView`
(owns `#pl-queue`), `PlaylistNowPlayingView` (owns `#pl-now`, and must
**patch in place** on state changes rather than rebuild — `state` changes
on every `loading→playing→paused` transition, so gating a full rebuild on
it would discard the play button's keyboard focus constantly; rebuild
structure only on `currentItem.id` change), and `itemFromCatalogRow(row)`
(converts a `tracks.json` row to a raw item at exactly one boundary, the
`setQueue()` call — filtering/dedupe/hash/ZIP manifest all stay in catalog
space via a `catalogById` map, the item schema isn't widened). Hash sync
lives in `playlist-boot.js` as a controller-observing boot concern, not
inside a view.

**Controller additions needed** (small, self-contained, show-page-neutral —
existing suites must pass unmodified):
- `onQueueExhausted` constructor option — endless-mode rollover currently
  has no working hook (the controller's `ended`/`stop()` terminal states
  are indistinguishable from a real Stop, and Media Session's `nexttrack`
  is handled inside the controller where the page can't intercept it).
- `onExternalClaim` constructor option — nothing today lets a page
  distinguish an external-claim pause from a user pause
  (`player-controller.js:127-129`), needed to reproduce legacy's "Paused —
  playback started somewhere else" message without calling the ambient
  legacy global.
- `_queueRevision` counter, incremented in `setQueue`/`appendQueue`/
  `removeAt`/`reorder`/`toggleShuffle`, exposed on `snapshot()`. **Required
  correction**: `removeAt()` (`player-controller.js:246`) and `reorder()`
  (278-279) both mutate `this._queue` in place via `.splice()` — a
  "recompute only when the queue array reference changes" check (the
  original design) would silently miss both. A revision counter is the
  correct O(1) signal.
  `PlaylistQueueView` gates its re-render on this, not on identity.
- Explicit `'idle'` state on `setQueue()`'s cued-but-not-playing branch
  (`player-controller.js:196-217` never calls `_setState()` there today, so
  a hash-hydration `setQueue()` arriving after a queue ended/errored
  inherits the stale terminal state).
- Queue-length bound applied to **both** `setQueue()` and `appendQueue()`
  (not just `setQueue()` — `appendQueue()` needs the same bound to actually
  bound anything).

**Parity tests** (`test-playlist-views.mjs`, `test-playlist-state.mjs` +
`browser_check.mjs`'s `checkPlaylistPage()`): hash hydration round-trip
(write/read/round-trip, empty-queue UI state, same-hash special case);
saved playlists (save/load/delete/rename, cross-tab `storage` sync, quota
handling); endless-mode reshuffle-on-rollover via all three entry points
(`ended`, Next, Media Session `nexttrack`); shuffle on/off restoration
(exact restore-by-id of the currently-playing index); `removeAt()`
regression at the page level (**index-shift direction, corrected**: an
earlier-index removal decrements `currentIndex`, a later-index removal
leaves it unchanged — the reverse of the first draft, verified against
`player-controller.js:253-257`); `reorder()` first-time verification (API
tested, no drag-to-reorder UI ships this phase); cross-cutting lift-and-
shift checks (share link, ZIP manifest, popup, status messages).

Two assertions from the first draft were wrong and are corrected: the hash
regex `/^#p=([\w.,-]+)/` (`playlist.js:545`) is a **prefix match**, not a
full match — `#p=validid!junk` hydrates the valid prefix, it doesn't
hydrate nothing; and "shuffle off when never on" isn't a reachable
state — `toggleShuffle()` is a single toggle with no separate off op,
calling it while off turns shuffle **on**.

An all-unknown-id hash (`playlist.js:546-548`) is a genuine bug today (an
inconsistent partial-clear, not a clean wipe), and Phase 2 **fixes it**
rather than reproducing it: clear queue/audio/hash consistently and show a
message.

`prev()` at queue start **restarts track 1**, matching legacy exactly
(decided over the controller's own no-op behavior, for migration-phase
simplicity).

**Untrusted-input hardening.** `MAX_HASH_LENGTH` **must be ~64 KiB, not
8192** — `track-select.js`'s `goToPlaylist()` (~line 130) has no selection
cap, and a full-catalog share link (680 tracks × ~30 chars) already runs to
~20K characters. `MAX_QUEUE_IDS`/`MAX_QUEUE_ITEMS` 1000 (applied to both
`setQueue()` and `appendQueue()`), `MAX_SAVED_PLAYLISTS` 100,
`MAX_PLAYLIST_NAME` 120 chars. Duplicate ids in a hash get deduped at
parse (fixes two latent legacy bugs in `toggleShuffle`/`removeAt`'s
snapshot handling).

**localStorage schema — kept flat through 2a–2c, versioning deferred.**
The original two-key dual-write design (new `savedPlaylists.v2` preferred
whenever present, mirrored to the legacy key) is **not lossless**: during
2a/2b, a `?engine=legacy` tab can still write only the flat key, and the
controller-engine tab would keep trusting a now-stale v2 snapshot and
overwrite the legacy write on its own next mutation. **Fix:** keep the
existing flat `savedPlaylists` array canonical through all three stages
(both engines read/write the same key, no reconciliation problem); add
validation/degrade behavior to that existing shape. Defer the actual `v2`
envelope + version field to a stage **after** `playlist.js` is deleted,
when there's only one writer and no reconciliation problem left to solve.

**BroadcastChannel: no change this phase.** All four current
implementations already agree on the bare-string wire format
(`postMessage(randomId)`, compare-on-receipt); the structured
`{version, type, senderId}` upgrade stays in Phase 3, when `/player/` also
migrates and every participant can change together. Verify: `/playlist/`
will have two `BroadcastChannel` objects open at once (controller's and
`player.js`'s, which stays loaded for the password modal) — a self-claim
must not pause the page's own playback.

**Test infrastructure.** `verify_markup.py` gets
`check_playlist_engine_wiring()` as plain booleans, not the N-page
set/coverage machinery Phase 1 built — and the invariant needs two
**separate** checks, not one: (1) resolver + boot-module script always
present together, true through 2a/2b/2c-inverted; (2) the resolver's
**default decision** (what it emits with no `?engine=` param) matches
`PLAYLIST_CONTROLLER_ENGINE` — a check on the resolver's default, not on
asset presence, since at 2a both assets are present (for the canary) while
the constant is still `False`. `browser_check.mjs` gets one dedicated
`checkPlaylistPage()` (not a `HEAVY_CHECK_SLUGS` slot — that tiering
exists for 30 interchangeable show pages, not one architecturally distinct
one), covering mount, dormancy, real playback, hash round-trip,
saved-playlist ops, cross-tab sync, endless rollover, shuffle, remove,
console-clean, self-claim non-pause, `track-select.js` wiring, and a
breakage test proving the runtime fallback. The existing cross-tab
claim/pause check (`browser_check.mjs:436-454`) and non-allowlisted-page
legacy-playback check (672-690) both currently treat `/playlist/` as a
legacy reference point and need retargeting at 2a/2b respectively — left
as-is they'd keep *passing* while proving nothing once 2b ships.

**Deferred, not resolved this phase:** mini-bar scope / which features
surface in mini vs. expanded state (no mini bar ships; the new
`QueueView`/`PlaylistNowPlayingView` split is the affordance that makes
one cheap later); timestamp URL grammar (`#p=`'s shape doesn't change this
phase, giving a future grammar design a stable baseline); repeat-one/
keyboard-shortcut UI and drag-to-reorder UI (mechanisms exist or get
verified, no new UI ships — this stays a migration, not a feature phase);
loudness (unchanged).

### Phase 3 — sticky in-page mini-player (Stage 3a-foundation shipped and
verified in production 2026-08-15; design finalized after this section's
original "`/player/` popup" approach was rejected)

**Status.** Stage 3a-foundation is complete, merged (PR #15, plus PR #16
for a CI-only test failure), and verified live. Stage 3a-canary is next;
see the stage shape below. This section carries the *design* and the
*residual gaps*; the round-by-round review narrative that used to live
here has been moved to `player-consolidation-codex.md`, which is where
every finding, its verification evidence, and its disposition already
lived — see "Review history" below for the map.

**The original design in this section — a separate `/player/` popup
document — was rejected by Rene**: iOS Safari doesn't support real popup
windows, and popup blockers make `window.open()` unreliable generally.
Replacement direction: a fixed in-page sticky mini-player that persists
session state (queue, current item, position, play/pause intent, queue
modes) across ordinary full-page navigation — explicitly *not* gapless
audio (a new document may need a fresh user gesture per browser autoplay
policy; restore visual state immediately, attempt `play()` only when
permitted, show a "Resume" affordance when blocked). True gapless
cross-page audio is out of scope for this phase, tracked as a separate
future project if ever pursued — this tradeoff (losing the popup's only
genuinely uninterrupted mechanism) is deliberate, not an oversight.
`/player/` becomes a lightweight compatibility redirect once the
mini-player reaches parity and a full production soak (2+ weeks after
Stage 3b ships) passes; the homepage is in scope for the mini-player, not
deferred.

**Scoping process**: an Explore agent mapped the current architecture
(`PlaybackController`'s per-document lifecycle, the three independent
`BroadcastChannel('hannan-playback')` implementations, `page_shell()`'s
shared template, `continuous-player.js`'s existing localStorage-resume
pattern), a Plan agent turned Rene's two initial decisions into a first
design, and that design went through five Codex review rounds — each
verified line-by-line against the actual code before being incorporated,
and each one finding real, code-confirmed architectural gaps rather than
polish. The condensed, final result follows.

**Why a naive "adopt if a controller global exists" design doesn't work.**
Two of this project's existing pages still run a non-`PlaybackController`
engine — `player.js:217`'s `initLegacyPlayback()` (the show-page
degraded-mode fallback for when `player-boot.js` fails to mount; verified
via `CONTROLLER_ENGINE_SLUGS` that every show page runs the controller
engine today, so this exists purely as a safety net) and, until this
phase's foundation work, the Songs page's occurrence rows
(`player.js`'s `initCustomPlayers()`, one independent `new Audio()` per
row). `BroadcastChannel` never delivers a message back to its own sending
document, so two same-page engines can't coordinate a claim/pause between
themselves — a real double-playback risk, not a hypothetical, if a
mini-player naively constructed a second controller on a page already
running one of these.

**The readiness contract.** Every `page_shell()`/`build_home()` page emits
one inline script, first in the document, arming
`window.PLAYBACK_HOST_READY` (a promise resolved by whichever boot module
runs, or immediately for pages with no player at all). It resolves to
`{mode:'controller', controller, initialIntent}` (`initialIntent` one of
`'autoplay'`/`'page-queue'`/`'none'`, carrying the page's own deep-link/
queue decision so a restore never races it), `{mode:'legacy'}`, or
`{mode:'none'}`. Deliberately **no generic, page-wide wall-clock
timeout** — an early design used a ~4s fallback timer covering the whole
readiness decision, which Codex correctly identified as itself unsafe (it
could fire before a slow but healthy `/playlist/` catalog fetch or
show-page mount settled, constructing a second controller). `/playlist/`
does carry one real, narrow exception: a 10s timeout scoped only to its
own `/assets/tracks.json` fetch, which — unlike the rejected generic
timeout — can never construct a second controller (the one controller
already exists regardless of catalog outcome) and only ever routes into
the same failure path a genuine fetch rejection already takes. Every page
type otherwise resolves from a real event instead: script `onerror`, an
existing top-level try/catch, or the actual async operation settling. Show
pages resolve only *after* `wireDeepLink()`'s `window.load`-triggered
decision (`player-boot.js:203`, deliberately deferred for layout reasons)
— resolving at mount, as an earlier draft did, would let a restore start
before that decision is made and race it. `/playlist/` has three distinct
failure paths covered individually (script load failure, in-script throw,
catalog-fetch-only failure) since it has no legacy fallback to defer to
the way show/song pages do.

**Cross-tab session ownership — single-commit fenced lease.** Session
state persists to a versioned `localStorage['miniPlayerState']` envelope
(queue via a dedicated capped/deduped/bounded item codec — not raw
`normalizeItem()` output, which doesn't cap; `setQueue()` does — keyed by
`currentItemId`, not a raw index, since filtering a corrupt entry can
shift indices). Ownership is a "lease" (`{ownerId, ownerEpoch}`) held only
in the caller's JS memory, wiped by navigation (exactly the lifetime a
"was this write issued under the still-current claim" check needs), and
re-derived at boot by `restoreLease()` reading the tuple back out of the
one durable envelope, where it necessarily does appear. **The property
that matters is that no SECOND store needs to be kept in sync with it** —
not that the tuple appears nowhere in storage; an earlier "never
persisted" phrasing was an overclaim and was corrected.

`claimOwnership()` is exactly **one** `localStorage.setItem()` call — no
second-store write is ever part of the commit, so there is nothing to roll
back, ever. This shape is the whole point of the redesign: five straight
review rounds against the prior design each found, or confirmed, a real
bug, and **every one of them was the identical shape** — a multi-step
commit spread across `sessionStorage` and `localStorage`, where the
rollback on partial failure could itself fail. Web Storage gives no
cross-key atomicity, so each individual fix only narrowed the window that
kept producing new instances. The verdict, agreed with Rene, was to stop
patching the shape and remove it.

The rest of the ownership design — every function's contract, the
migration table from the old exports, and the honestly-documented residual
gaps — is in "Blocker B, redesigned: single-commit fenced lease" below.

**The tab-collision handshake — and the constraints that must not be
"tidied" away.** `sessionStorage` is not reliably unique per tab:
`window.open()` and tab duplication can clone it byte-for-byte. That one
platform fact drives the whole handshake design, and several of its
properties look arbitrary until you know why they're there:

- **Decided by a symmetric nonce tie-break only — never by which side
  looks "established."** "Established" ownership is not a signal any
  function can honestly compute from storage content once cloning is
  possible: a clone's envelope check passes exactly as validly as the
  original's. An ownership-based asymmetry therefore protects whichever
  side merely *received a message first*, not whichever side is genuinely
  non-duplicated — reproduced directly, a real owner rebooting after its
  own navigation lost outright to an idle clone. Worse, two clones probing
  each other simultaneously could each conclude "the other is
  established, so I must rotate," both rotate, and orphan the session.
  The guarantee here is deliberately *weaker and more honest* than an
  ownership-based one: an unbiased coin flip between two colliding tabs,
  not a promise that the "real" owner wins, because no such promise is
  achievable once storage cloning is in play.
- **The blast radius that makes that acceptable:** any real local user
  interaction (play/pause/seek/queue change) reclaims ownership outright
  regardless of what the shared envelope says, so the coin flip only ever
  matters between two simultaneously idle/passive tabs, where either
  outcome is equally inconsequential.
- **`generateNonce()` must contain no time component or any other
  orderable prefix.** It deliberately does *not* share
  `generateTabId()`'s/`generateClaimToken()`'s
  `` `${Date.now().toString(36)}-…` `` format. That format is harmless for
  those two (only ever compared for equality) but fatal here, because
  `shouldRotateOnCollision()` compares nonces **lexicographically** and a
  base-36 timestamp prefix of constant digit-length dominates that
  comparison regardless of the trailing random suffix — measured: the
  earlier-generated nonce lost 20/20 trials, making the "coin flip" a
  fully deterministic rule where whoever had been established longer
  always lost. Uses `crypto.getRandomValues()` when available, with a
  same-shape `Math.random()`-only fallback. **Do not unify it with the
  other two generators for consistency.**
- **Memoized per composite `(myTabId, opposing nonce)`, not per nonce
  alone** — so a given collision is never decided twice (closing the
  mutual-rotation case) while a genuinely new collision under a rotated
  identity that happens to reuse a nonce is still decided.
- **`isTabProbeCollision()` takes no `myNonce` parameter**; any same-tabId
  probe is a collision, including an equal-nonce one (an equal nonce means
  a *genuine* clone, not "no collision").
- **`resolveCollision()` reports `failed:true`** when the nonces give no
  tie-break asymmetry, and only reports `rotated:true` on a *verified*
  rotation write.

**Stage shape**:

- **3a-foundation** *(shipped)* — song-page migration onto the shared
  controller, retaining `initCustomPlayers()` only as the `{mode:'legacy'}`
  fallback rather than deleting it; the readiness contract; the observable
  play-result signal (`lastPlayError`, `restoreSession()`, and the
  unconditional `onAnyExternalClaim` hook — see the controller notes
  below); the persisted-item codec and ownership rules, unit-tested with
  no UI consuming them yet.
- **3a-canary** *(next)* — mini-player container + script **always
  emitted**, with `MINI_PLAYER_ENABLED` controlling only the *runtime
  default*. An earlier draft gated emission itself behind the flag, which
  made a `?miniplayer=1` runtime override impossible to honor — don't
  reintroduce that. This is also where `scripts/miniplayer-state.js` gets
  its **first real consumer**, which matters more than it sounds: several
  residual gaps below are explicitly "caller contract" items that no code
  enforces yet because there is no caller. Building that coordinator is
  the point of the stage.
- **3b-default** — primary add/handoff actions (`track-select.js`'s "Add
  to player", `/playlist/`'s `pl-player` button) route into the
  mini-player rather than the popup, which stays as an explicit secondary
  fallback; a tombstoned one-time migration from `continuous-player.js`'s
  old `playerState` key; 2+ week soak.
- **3c-removal** — delete `continuous-player.js`/`sendToPlayer()`/the
  popup code; `build_player()`'s implementation becomes a redirect stub
  (`build.py`'s call site can't be deleted — verified it's called
  unconditionally), with both `sendToPlayer()` call sites confirmed gone
  first.

The BroadcastChannel wire-format upgrade (bare-string → structured
`{version,type,senderId}`) is explicitly **out of this phase entirely**,
not bundled with 3c's destructive deletion — tracked as a separate future
initiative, since Phase 3 no longer requires every claim participant to
change in lockstep the way the original separate-popup-document design
did.

**Controller additions this phase needed** (all shipped in 3a-foundation):
`PlaybackController` gained an unconditional `onAnyExternalClaim` hook —
the existing claim callback only fires while `state === 'playing'/'loading'`,
so a paused restored tab never learned it had lost ownership; this hook is
the wiring point a boot script calls `revokeLease()` from. It also gained
`lastPlayError` and `restoreSession()`, because `controller.play()`'s
returned promise always resolves, even on a browser-blocked autoplay
attempt (`_playIndex()` catches and swallows internally) — so a
`.catch()`-based Resume-affordance detector cannot work without an
explicit observable signal. **Corrected 2026-08-16:** those primitives
shipped, but `onAnyExternalClaim` was constructor-only and the mini-player
*adopts* a controller built elsewhere (`player-boot.js:60` and
`song-boot.js:69` construct with no arguments), so it was unreachable on
the path that matters. Stage 3a-canary Task 0.1 added the
post-construction subscriptions and the ownership sequence — see below.

#### Stage 3a-canary — implementation checklist

Detailed working copy (acceptance criteria, verification, risks) lives in
`~/.claude/plans/imperative-frolicking-widget.md` until the stage ships,
then folds in here — the same pattern `dynamic-hugging-rossum.md` followed.
Phase 0 closes the integration contracts *before* any UI work, after three
Codex review rounds on the plan found 8, 7, and 7 gaps respectively.

**Phase 0 — integration contracts**
Status words are used strictly: **implemented** means code plus a
mutation-checked test; **decided** means a written contract awaiting its
consumer in Task 4. A review round found this section had marked several
contracts as though they were implemented features, so the distinction is
now explicit.

- [x] **0.1 — implemented.** Post-construction `onAnyExternalClaim(fn)` /
      `onOwnershipEvent(fn)` on `PlaybackController`, both returning an
      unsubscribe; one monotonic `ownershipSeq` + `lastOwnershipEvent` on
      `snapshot()` (`play-attempt`/`local-play`/`external-claim`);
      `lastPlayErrorItemId`. Claims hook the media **`play` event**, never the
      `'playing'` state. `play`/`playing` are both ignored when
      `audio.paused` is already true — a queued media event must not publish
      ownership or `state:'playing'` after an intervening pause.
- [~] **0.2 — SUPERSEDED.** `OWNERSHIP_CHANNEL_NAME` exists and its hazard
      test is retained, but the probe/reply handshake is no longer the
      collision mechanism (see 0.3), so the coordinator opens no ownership
      channel. Kept because the hazard generalizes: *any* future channel in
      this feature must avoid `hannan-playback`, where a structured message
      pauses audio site-wide. Not a required mechanism.
- [x] **0.3 — decided; `tabIdentityLockName()` implemented.** The
      quiet-period settle timer is **replaced** by a document-lifetime Web
      Lock keyed by the tab id — positive uniqueness evidence rather than
      absence of a reply. `tabIdentityLockName()` (validated, length-bounded,
      namespaced so no stored id can produce a reserved `-`-leading name) is
      built and tested; the acquisition/retry/BFCache lifecycle is a written
      contract in `miniplayer-state.js` awaiting Task 4.
- [x] **0.4–0.6, 0.9 — decided.** Coordinator policy recorded below.
- [x] **0.7 — decided.** `storage` is a wake-up signal only: re-read and
      re-validate against the captured lease before acting, then route through
      the full loss path. Nothing routes anything yet — Task 4 implements it.
- [x] **0.8 — decided.** Eligible-page set, boot cost, flag ownership,
      height measurement — recorded below.

**Phases A–C** — see the working copy: view + CSS foundations; the
coordinator (identity/ownership, then session apply/save); then markup,
flag, invariants, browser checks, and the canary deploy.

**Review round, 2026-08-16** (`-codex.md`, "Stage 3a-canary Phase 0 and Task
1 review") — five findings, all confirmed and all fixed. Two changed work
this section had already marked complete, which is why the status words
above are now explicit:
- A **queued `play` event delivered after an intervening pause** let a
  paused controller mint a durable ownership epoch and report
  `state:'playing'` while silent. Reproduced with two controllers started in
  the same task. `pause()` flips `paused` synchronously but does not cancel
  an already-queued media task. Guards added to both handlers. (The
  `state:'playing'`-while-paused half predates this stage; attaching
  ownership to it is what made it consequential.)
- The **settle timer was replaced by the tab-identity Web Lock** — see 0.3.
  Silence is absence of evidence, and a throttled tab holding a cloned
  identity can reply after any timer fires, producing exactly the
  double-owner window the mechanism exists to prevent. The lock is the
  **sole** collision arbiter: running it alongside the probe/reply handshake
  would give two independent rotation mechanisms that can disagree, moving
  `TAB_ID_KEY` while the document still holds only the old id's lock.
- The **single-sequence test was vacuous** — splitting `_bumpOwnership()`
  into per-kind counters exposing `Math.max()` left all 57 tests green,
  because it asserted only `lastOwnershipEvent`. Rewritten to run isolated
  controller pairs and assert exact `{seq, kind}` streams with consecutive
  values; the mutation now fails. Second such test in this phase, after the
  `destroy()` one caught earlier the same session.
- `storage` events can carry a **stale `newValue`**; the contract now
  requires a fresh read and re-validation before acting.
- The module claimed **"There is a consumer now"** while line 31 of the same
  file said nothing calls it — corrected, along with the status words above.

#### Stage 3a-canary — recorded coordinator policy

The module-level caller contracts (channel, settlement, storage-event) live
in `miniplayer-state.js` beside the ones they extend. These four are
*coordinator* policy, so they are recorded here instead.

**Close (0.4).** Stops playback, clears persistence, unmounts the mini
view, and leaves page-owned queue UI alone — never `setQueue([])` on an
adopted controller, which would erase `/playlist/`'s working queue. A
separate "dismissed" state, not an empty queue, is what hides the bar. In
order: set dismissed → stop accepting dirty-save events → **`claimOwnership()`
to mint a fresh epoch** → `writeSession()` with an empty session → drop the
lease only once that write settles. The fresh epoch is the fence:
`writeSession()` validates the lease but writes under the *same* epoch, so
without it a save issued earlier under that lease could still validate
afterward and repopulate the session. **If the empty write fails, revoke
the fresh epoch before dropping it** — `claimOwnership()` preserves the old
queue/position (`miniplayer-state.js:1121`), so a dropped-but-unrevoked
fresh epoch reads back as `'restored'` on the next same-tab navigation and
resurrects exactly the session Close was meant to end. A later genuine
`play` brings the bar back.

**Save cadence (0.5).** Dirty on item change, play/pause, seek, queue
change, and repeat/shuffle change; plus a periodic save every **5s while
playing**, which bounds position loss to 5s if the tab dies. **
`visibilitychange → hidden` is the primary pre-navigation checkpoint**;
`pagehide` is best-effort only, because `writeSession()` is `async` on Web
Locks (`miniplayer-state.js:1153`) and a queued lock request cannot be
assumed to complete before teardown. One in-flight write at a time,
coalescing to the latest snapshot rather than queueing every change. Once
dismissed, no save is accepted at all — belt and braces with Close's epoch
fence.

**Restored play (0.6).** `restoreSession()` itself never plays. After
listeners are installed and the lease validated, attempt `play()` **exactly
once**, and only when the restored envelope has `playing: true`;
`playing: false` never attempts. Only a `NotAllowedError` renders
"Resume" — network/decode failures render "Retry"/"Playback failed". The
error is trusted only while `lastPlayErrorItemId === currentItem.id`, since
`lastPlayError` is never cleared on a queue change.

**`initialIntent` disposition (0.9).**
- **`'autoplay'`** — the page's intent supersedes the old session, and it
  **claims immediately at adoption**, without waiting to see whether the
  browser permitted playback. `player-boot.js:212` reports this intent on
  *requesting* autoplay, while a blocked attempt goes `loading → error`
  without ever reaching `'playing'` — so a claim gated on success would
  never fire, and the old session would resurface on the next navigation.
  Deep-linking to a track, seeing it blocked, then finding an unrelated old
  track in the bar is worse than either alternative. Save the page's own
  queue with whatever `playing` value the controller actually holds.
- **`'page-queue'`** — skip restore, hold no restored lease, claim on the
  first genuine `play`.
- **`'none'`** — normal candidate restoration.

#### Stage 3a-canary — recorded emission policy (0.8)

**Eligible pages — enumerated from the source, not assumed.** Every builder
that returns `page_shell(...)`, plus `build_home()`'s `HOME_SHELL` (the
homepage is explicitly in scope for the mini-player, not deferred):
`build_search`, `build_playlist`, `build_updates`, `build_history`,
`build_archive_data`, `build_contact`, `build_show`, `build_songs_index`,
`build_song_page`, `build_404`, and `build_home`.

**Excluded, by name and with reasons** — three builders use bespoke shells
and never call `page_shell()`, so "every generated page" was wrong in an
earlier draft of this stage. The exclusions are also *correct*, which was
luck rather than design until it was checked:
- **`build_process()`** (`PROCESS_SHELL`) and **`build_manual()`**
  (`MANUAL_SHELL`) — internal/dev-facing docs with their own inline styles,
  accent, and font stack, deliberately outside "Hannan Classic" per the
  root `CLAUDE.md`. Folding them in is a separate, bigger decision.
- **`build_player()`** (`PLAYER_SHELL`) — the popup this whole phase
  replaces. It must never host a mini-player: that would put two engines in
  one document, which `BroadcastChannel` cannot coordinate (it never
  delivers to its own sender).

`verify_markup.py` asserts presence on the eligible set **and absence on
those three**, so a future page picking up the wrong shell is caught.

**Boot cost.** The always-emitted asset is a *tiny bootstrap* that reads the
baked default and the `?miniplayer=` override, then dynamically imports the
coordinator and view modules only if it is actually enabling. The claim to
verify is therefore "only the boot asset is fetched; no dependent imports,
no controller, no audio work" — **not** "zero network impact," which an
always-emitted script can never be true of.

**Flag ownership.** `MINI_PLAYER_ENABLED` is passed *into* `page_shell()` as
a parameter, exactly like `playback_ready`. `page_shell()` lives in
`fragments.py` and `pages.py` imports from it, so having `fragments.py`
reach back for a `pages.py` constant would invert that dependency.

**Height.** `--miniplayer-height` is republished by a `ResizeObserver`, not
set once on show/hide: the bar can wrap at 320px, and font loading,
orientation change, zoom, and a changing track title all alter its height
after first paint. It includes `env(safe-area-inset-bottom)`, and consumers
(`.track-select-bar`, page bottom padding) **add** it to their existing
spacing rather than replacing it.

#### Review history (moved to `player-consolidation-codex.md`)

This design was hardened by an unusually long review sequence. Rather than
narrate it here, the map:

| What | Where in `-codex.md` |
|---|---|
| The original 5-round design review (before any code) | "Phase 3 design review", rounds 1–5 |
| Stage 3a-foundation implementation review — 8 findings, incl. the song-page auto-advance regression and the first cross-tab ownership race | "Phase 3 Stage 3a-foundation implementation review" |
| Rounds 2–5 against the old *claim-token* ownership design, each finding the same multi-step-commit bug shape | the four consecutive "fix verification" entries |
| Rene's own interactive Codex session — confirmed round 5 and found three more instances of the identical root cause; produced the "stop patching, redesign" verdict | "interactive review session" |
| The fenced-lease redesign as implemented | "fenced-lease redesign implementation" |
| Twelve `/review-step` rounds against the redesign — five narrowly scoped, six deliberately broad | the "fenced-lease"/"revocation-fix"/"ownership subsystem" review entries, ending with "Final fenced-lease verification review" |

Compressed record of what the broad rounds found, since it's the part
worth remembering: (6) `hasValidLease()` missing its identity check, plus
three others; (7) an active-owner UX gap, a test-harness gap, and
`revokeLease()` missing a read-back; (8) `writeEnvelope()` — the actual
commit path — never reading back its own write, the one storage write that
hadn't already gotten that treatment; (9) `rotateTabId()`/`claimOwnership()`
never verifying a freshly generated id/epoch actually *differed* from the
value being replaced, which under degraded entropy reopened the stale-write
bug via entropy rather than storage (fixed with a shared, bounded
`generateDistinctFrom()`); (10) that same fix not failing closed when its
pre-write read threw, plus `isTabProbeCollision()` treating an equal-nonce
genuine collision as no collision; (11) round 8's fix having introduced its
own mirror image (a landed write plus one transient read throw reported as
failure — fixed with bounded retry), collision memoization keyed by nonce
alone surviving a rotation, and concurrent losers able to generate
identical replacement ids; (12) **no High or Medium findings** — two Low
findings, both about the accuracy of Claude's own claims rather than the
code.

**Why the loop stopped, recorded honestly** (corrected after round 12
pushed back on an earlier, self-flattering version): it is *not* that
everything left is exotic. The *collision-handshake* findings did trend
that way — rounds 6–7 needed only plausible real-world triggers (storage
quota, private browsing), while rounds 9–11's handshake findings required
pinned/degraded entropy or 3+ simultaneously duplicated tabs — but the
*storage* findings did not: round 8's silent-drop bug and round 11's
verification-read bug (item 10 below) each needed just **one ordinary
transient storage failure**. What justifies stopping is that each round's
fix was creating the surface for the next round's finding (round 8's fix
directly caused round 11's item 10; round 9's directly caused round 10's
first finding), and round 12 confirms nothing High/Medium remains. The
validation this module needs now is **a real consumer in Stage
3a-canary**, not a thirteenth adversarial pass.

Two earlier debts recorded in this section are **discharged**, noted here
so nobody goes looking for them: the "at least one genuinely clean
`/review-step` round is still owed against `revokeLease()`" note, and the
broader "another BROAD round is owed before the ownership subsystem is
settled" note — rounds 9–12 were all deliberately broad and covered the
whole module, and round 12 came back with no High or Medium findings.

Test counts through the sequence are recorded per-entry in `-codex.md`;
the current numbers live in `HANDOFF.md`, not here, so they only have to
be updated in one place.

#### Blocker B, redesigned: single-commit fenced lease (2026-08-15)

Supersedes the "claim token" design entirely — see the review history
above for why. The fix removes the multi-step-commit shape, not just the
latest instance of it.

**Storage keys** — removes `CLAIM_TOKEN_KEY`, `PENDING_CLAIM_TOKEN_KEY`,
`REVOKED_KEY` entirely (no replacement for the first two — the lease isn't
stored as a separate credential at all):
```
sessionStorage: TAB_ID_KEY ('miniPlayerTabId', unchanged key, stricter semantics)
                REVOKED_EPOCH_KEY ('miniPlayerRevokedEpoch', new)
localStorage:   STATE_KEY ('miniPlayerState', unchanged) — envelope field
                ownerToken renamed to ownerEpoch
```

**Function-by-function**:

- **`establishTabId(sessionStore)`** — called exactly once per document, at
  boot, before anything else in this module. Idempotent if a value already
  exists. Generates, persists, and **reads back** what was actually
  stored (not just "did `setItem` throw"). Returns the verified id, or
  `null`. A `null` result means: disable persistent ownership for this
  document's entire lifetime; do not call any other ownership function
  below. **The initial existence check itself also fails closed** — an
  earlier version collapsed a transient read failure to "nothing exists"
  and minted a brand-new id, silently destroying a valid identity carried
  in from a prior same-tab page load.
- **`peekTabId(sessionStore)`** — read-only, never generates, never throws.
  Used by every function below that needs "my established id" without the
  right to mint one.
- **`rotateTabId(sessionStore)`** — same external behavior on success; on a
  failed or unverified persist, returns `null` instead of a fabricated
  ephemeral id. **This `null`-on-failure contract is new with the
  redesign** — any caller inside the otherwise-frozen collision-handshake
  code must handle it (one that didn't was exactly residual gap 7(c)).
- **`readEnvelope(localStore)`** — returns `{status, envelope}` where
  `status` is `'ok'`, `'absent'` (key missing, or corrupt/wrong-version
  JSON), or **`'unavailable'`** (the `getItem()` call itself threw) — only
  a genuine read failure is `'unavailable'`; a confirmed-empty read is
  still `'absent'`. This tri-state exists so a broken read can never be
  mistaken for "nothing there, free to claim."
- **`isEpochRevoked(sessionStore, ownerEpoch)`** — fails closed (`true`)
  for a null epoch or an unreadable marker. Otherwise `true` iff the
  stored `revokedEpoch` exactly equals the epoch being checked.
- **`revokeLease(localStore, sessionStore, lease)`** — writes
  `lease.ownerEpoch` to `REVOKED_EPOCH_KEY`, but only after checking it's
  still worth recording. Reads the current envelope; if it's readable
  (`'ok'`) and already names a *different* `ownerEpoch`, **skips the write
  entirely** — that epoch is provably irrelevant, since `restoreLease()`
  only ever checks revocation against whatever epoch the envelope
  *currently* names. If the envelope read is `'unavailable'` — can neither
  confirm the epoch is current nor rule it out — it does **not** write the
  marker either; it escalates via `rotateTabId()`, exactly like a failed
  `sessionStorage` write does. Otherwise (envelope `'absent'`, or `'ok'`
  and still naming this exact epoch) proceeds to `sessionStorage.setItem()`;
  on failure, falls back to `rotateTabId()` (a rotated id makes the next
  boot's ownerId comparison fail regardless of whether the epoch marker
  landed). Returns `{ok, escalated}`; `ok:false` only when both an
  escalation path (unavailable envelope OR failed write) and its own
  `rotateTabId()` fallback fail. A skipped, provably-irrelevant write
  reports `{ok:true, escalated:false}` — nothing failed. `escalated:true`
  means rotation was *attempted*, not that it landed — check `ok` for that.

  **Three earlier versions of this ~15-line function were each found buggy
  by consecutive review rounds, none needing more than one ordinary
  failure to break** (unconditional write; a bounded *set* of revoked
  epochs; skip-on-irrelevant but still writing blindly on `'unavailable'`).
  The current shape — single value, no set, no cap, skip on
  confirmed-irrelevant, **escalate rather than write on unconfirmed** — is
  what finally removed the shape instead of narrowing it again. Do not
  "simplify" any of those three properties back.

  **Caller contract** (boot-script level, not enforced by this pure
  module): on any external claim signal, synchronously drop the in-memory
  `lease` variable to `null` *first* — that's what actually stops this
  document's own further writes this session — then call `revokeLease()`
  with the *previous* lease as a best-effort durability measure for
  surviving navigation. **And, load-bearing:** if the result's `escalated`
  is `true`, refresh any cached copy of this document's own tab id
  (`myTabId = peekTabId(sessionStore)`), the same refresh the collision
  handshake already requires after a handshake-reported rotation — because
  this escalation path is a *second* source of `TAB_ID_KEY` rotation that
  the handshake's wiring never anticipated. Skipping it leaves the
  handshake comparing incoming probes against a stale id and silently
  missing a real collision (residual gap 6).
- **`hasValidLease(lease, localStore, sessionStore)`** — `false` for a
  malformed/null lease; `false` if `peekTabId(sessionStore)` no longer
  equals `lease.ownerId`; `false` if that exact epoch is revoked; `false`
  if the envelope read is `'unavailable'`; else compares
  `(ownerId, ownerEpoch)` against the fresh envelope. Pure read, no lock
  needed. Internally composed from a shared `hasMatchingEnvelopeTuple()`
  predicate (everything above except the revocation check) plus a
  revocation check on top — `tombstoneIfCurrent()` uses the tuple-only
  predicate directly, deliberately without the revocation check.

  **The `peekTabId` check is load-bearing**: this document's own tab id can
  rotate out from under an already-captured in-memory lease (a lost
  collision tie-break, or a `revokeLease()` escalation) without the shared
  envelope changing at all, since nobody else has necessarily written it
  yet. Without it, a captured lease naming the OLD, abandoned id still
  passes every other check and a stale write still lands.
- **`restoreLease(localStore, sessionStore)`** — the "am I the continuing
  owner, and what lease should I hold" check, run once at boot **after**
  the tab-collision handshake has converged. Returns one of
  `{status:'no-identity'}`, `{status:'unavailable'}`,
  `{status:'unowned', envelope}`, `{status:'not-mine', envelope}`,
  `{status:'revoked', envelope}`, or `{status:'restored', lease, envelope}`
  — a **candidate** lease, not a guarantee (a single unlocked read, no
  write needed; a coordinator must install collision/external-claim
  invalidation listeners before applying visible/audio state from it — see
  residual gap 9).
- **`claimOwnership(localStore, sessionStore, lockRequest)`** — return
  shape `{ok, lease, envelope, reason?}`. Under the lock: `peekTabId()`
  (fail if null) → `readEnvelope()` (fail if `'unavailable'`) → mint a
  fresh `ownerEpoch` → **one** `writeEnvelope()` call, preserving existing
  queue/position content if any. No CAS precondition on this call
  specifically — deliberate: an explicit local interaction always wins
  regardless of current envelope content, and a single `setItem()` is
  atomic per the WHATWG spec. On a failure reported *before* the write is
  attempted (`no-identity`, `unavailable`, `epoch-collision`) or on a
  thrown `setItem()`, the *previous* envelope is completely untouched.
  **Not guaranteed for `write-failed` specifically** — if the write lands
  but every bounded verification read throws, `writeEnvelope()` reports
  failure over a mutation that did happen; see residual gap 10.
- **`writeSession(localStore, sessionStore, lease, session, lockRequest)`**
  — takes `lease` explicitly, no longer mints a token internally. Under
  the lock: `hasValidLease(lease, ...)` (reject if false) → build the
  candidate envelope → **re-check `hasValidLease()` immediately before the
  write** → `writeEnvelope()`. This is the mechanism that makes "an old
  same-tab callback writing under a newer claim" structurally impossible:
  the comparison is against the *closure's captured lease*, never against
  "whatever's currently in sessionStorage" — which is what closes both the
  cross-tab case (`lease.ownerId` no longer matches) and the same-tab
  reclaim case (`lease.ownerEpoch` no longer matches even though `ownerId`
  is unchanged).
- **`tombstoneIfCurrent(localStore, sessionStore, lease, lockRequest)`** —
  optional, best-effort, never load-bearing for correctness. Gates on
  `hasMatchingEnvelopeTuple()` — **not** `hasValidLease()` — and clears
  `ownerId`/`ownerEpoch` to `null` while preserving queue/position
  content. Structurally cannot stomp a fresher legitimate claim: a losing
  tab's stale lease already fails the tuple check by the time it would try.
  Purpose is cosmetic only (a passive read-only observer stops showing
  stale "owned by A" content); the correctness-critical property (no
  phantom auto-resume by the losing tab) comes entirely from
  `revokeLease()`'s local marker. **It must not be gated on
  `hasValidLease()`** — that made the module's own documented "tombstone
  after revoke" sequence self-defeating, since `revokeLease()` has just
  revoked that exact epoch. Revocation status was never load-bearing for
  tombstoning's safety (that comes entirely from the tuple match), so
  excluding it closes the self-rejection without weakening anything.
- **`withOwnershipLock()`** — there is **no** best-effort unlocked
  fallback. With no real lock provider available the critical section
  never runs at all; callers surface this as `{ok:false, reason:'no-lock'}`
  / `false`. This is a flagged judgment call, confirmed with Rene, and
  genuinely optional under this design: the OLD multi-step design's
  no-lock race could permanently orphan a claim, whereas this design's
  would be a self-healing one-cycle glitch. Adopted anyway because Web
  Locks support is already broad and it removes an entire class of
  race-characterization tests. **A very old/restricted browser without
  `navigator.locks` gets ordinary in-page playback for that single load,
  with no cross-navigation persistence** — reversing this later only
  touches `withOwnershipLock()`.

**Migration** (old export → new export/signature): `getTabId` → split
into `establishTabId` + `peekTabId`; `isRevoked`/`setRevoked`/
`clearRevoked` → `isEpochRevoked`/`revokeLease` (no clear); `isOwner` →
split into `hasValidLease` + `restoreLease`; `writeSession` gains a
`lease` parameter, no longer mints a token internally; `claimOwnership`'s
return shape gains `lease`/`reason`; `readEnvelope`'s return shape becomes
`{status, envelope}`; `buildEnvelope`/`decodeEnvelope`'s `ownerToken`
field renames to `ownerEpoch`. Fully unchanged: `STATE_KEY`, `TAB_ID_KEY`,
`ENVELOPE_VERSION`, `MAX_PERSISTED_QUEUE_ITEMS`, `encodeItem`,
`encodeQueue`, `OWNERSHIP_LOCK_NAME`. `writeEnvelope` keeps its signature
but gained read-back verification, then bounded retry of that
verification. `isTabProbeCollision` **dropped its `myNonce` parameter**
(nonce equality no longer affects collision-ness).

**Honestly documented residual gaps.** Item numbering is referenced from
`HANDOFF.md` and `-codex.md` — **don't renumber**. (An earlier version of
this line claimed *every* remaining gap requires two independent write
failures with no successful write in between; that blanket claim was
falsified twice by later rounds and is withdrawn — items 9–12 need no
write failure at all.)

1. If *both* `revokeLease()`'s epoch write and its rotation fallback fail,
   and the document navigates before any further `sessionStorage` write
   ever succeeds, a future page load's `restoreLease()` could wrongly
   resolve `'restored'`. The in-memory lease drop (required unconditionally
   on any external claim) fully protects *this* document instance
   regardless; the gap is scoped to a future page load only.
2. If `withOwnershipLock()`'s fail-closed default is later reconfigured
   back to best-effort, the classic stale-write-slips-through race
   returns — but self-healing, not a permanent corruption.
3. `restoreLease()`'s "resolve collisions before restoring" ordering is a
   boot-script sequencing contract this pure, timer-free module cannot
   enforce internally.
4. Revocation is inherently `sessionStorage`-scoped (private per tab,
   doesn't survive a genuinely new tab/window).
5. **Closed, kept for provenance — not a live gap.** `revokeLease()`'s
   three earlier forms were each found buggy by a consecutive review
   round, none needing storage tampering or more than one ordinary
   failure: a single-slot value that let a stale/delayed revocation of an
   older epoch silently un-revoke a newer one; a bounded set of epochs
   that lost history on an unreadable read and could FIFO-evict the one
   entry that still mattered; and a skip-on-irrelevant version that still
   wrote blindly on an `'unavailable'` read, letting a transient failure
   clobber a different, currently-relevant revocation. The current form is
   described under `revokeLease()` above; all three reproductions re-run
   clean against it. Full findings: `-codex.md`'s three consecutive
   revocation-fix review entries. (The "a genuinely clean round is still
   owed" caveat this item used to carry has since been discharged — see
   the review-history note above.)
6. **Closed, kept for provenance.** A finding at the *boundary* between
   `revokeLease()` and the tab-collision handshake, not inside either:
   `revokeLease()`'s escalation path rotates `TAB_ID_KEY`, a second
   trigger the handshake's boot wiring never accounted for, so a caller
   that missed it kept comparing incoming probes against a stale id — a
   genuine collision went completely undetected, reproduced directly.
   **Not a defect in either function individually; nothing connected the
   two.** Fixed entirely at the caller-contract level (see
   `revokeLease()`'s contract above). The lasting lesson: any FUTURE
   function added to this module that can also rotate `TAB_ID_KEY` needs
   the same caller-contract treatment — it is not automatic just because
   the handshake code itself is unchanged.
7. **Closed, kept for provenance.** Four findings from the first
   deliberately broad round, immediately after a narrow round on item 6's
   fix alone came back clean — which proved the narrow framing was hiding
   things, not that the subsystem was settled. **(a) High:**
   `hasValidLease()` never checked this document's own current identity
   against the lease. **(b) Medium:** the documented "tombstone after
   revoke" sequence was self-defeating. **(c) Medium:**
   `resolveCollision()` discarded `rotateTabId()`'s return value, so a
   FAILED rotation still reported `rotated:true` — reproduced, both sides
   of a collision ended up sharing an id and both passed `restoreLease()`
   as `'restored'`, the exact duplicate-ownership outcome the handshake
   exists to prevent. **(d) Low:** `establishTabId()`'s existence check
   applied read-failure-as-absence. All four reproduced and fixed; (a) and
   (b) fell out of one shared fix (the `hasMatchingEnvelopeTuple()`
   predicate). Full disposition: `-codex.md`'s "Full fenced-lease
   ownership subsystem review".
8. **Genuine, permanent residual gap — a suggested fix was explicitly
   REJECTED, not deferred.** If `revokeLease()`'s escalation path fires
   (rotating this document's tab id), an immediately-following
   `tombstoneIfCurrent()` call also fails, since the rotated identity no
   longer matches the lease being tombstoned. The obvious fix (drop the
   `peekTabId()` identity check from `tombstoneIfCurrent()`'s gate) was
   built, tested, and rejected: it reopens a worse bug — a tab that lost a
   COLLISION tie-break holds a stale lease whose tuple can still
   legitimately describe a *different*, still-live document's ongoing
   ownership (collision resolution never touches the shared envelope), so
   removing the check would let that loser wrongly clear the *winner's*
   completely legitimate state, reproduced directly. Purely cosmetic
   either way; no correctness property is affected. Two tests lock in both
   halves: one proving the gap, one proving the protection it would cost
   to "fix" it. **Don't re-fix it.**
9. **`restoreLease()`'s result is a candidate, not a guarantee.** It is a
   single unlocked read — deliberately, since it runs once at boot with no
   consumer yet to wire a lock around — so another tab's claim landing a
   moment later is not reflected in an already-returned `'restored'`
   result. No correctness property is at risk (any subsequent WRITE under
   the stale lease is still rejected by `hasValidLease()`'s always-fresh
   check), but a caller that resumes visible UI/audio state directly from
   `'restored'`, before ever attempting a write, has a narrow window where
   that state could already be stale. **Closing it is Stage 3a-canary's
   coordinator work.** The same round also found the "correctly-wired
   caller never treats itself as restored" test was tautological — reworded
   to honestly document a required caller-side pattern rather than claim to
   prove one is followed; a real coordinator needs its own test.
10. **A landed write whose every verification read throws is reported as
    failure** — the mirror image of the silent-drop bug, introduced by that
    bug's own fix. `writeEnvelope()` reads back its own write to catch a
    silent drop; the single-attempt version turned one transient
    `getItem()` throw into a false FAILURE over a write that genuinely
    landed (reproduced for all three callers). Fixed by bounded retry (3
    attempts) of the verification read. Residual if *every* attempt throws:
    accepted deliberately, because the consequence is bounded and
    self-healing rather than corrupting — `claimOwnership()` has no CAS
    precondition so a retry overwrites cleanly, `writeSession()` self-heals
    on the next periodic save, and `tombstoneIfCurrent()` is already
    best-effort. A full `confirmed`/`not-written`/`indeterminate` tri-state
    threaded through all three public APIs was considered and declined as
    disproportionate.
11. **Concurrent collision losers can generate the identical replacement
    tab id.** `generateDistinctFrom()` can only prove a candidate differs
    from *this* document's own prior id; it cannot know what a different,
    simultaneously-rotating document is independently generating.
    Reproduced with three clones, two losers, and pinned entropy: both
    landed on the same replacement id, and with no re-probe the fresh
    duplication went entirely undetected. Addressed at the **caller
    contract** level rather than internally: a caller MUST broadcast a
    fresh probe under its new identity after any successful rotation,
    which turns the pairwise handshake into a self-converging protocol
    (the duplication resurfaces as an ordinary collision and resolves the
    same way). The test harness's `wireDocument()` models that re-probe,
    and a three-clone test drives the whole cascade through it from a
    single `postMessage` — verified non-vacuous by temporarily removing the
    re-probe and confirming the test fails. Still a *simulated* caller, not
    a real coordinator (see item 9). Residual: this converges by
    repetition, not via a bounded protocol with a give-up state, so a
    pathological entropy source could in principle need several rounds.
    Never *permanently* undetected, only possibly slower; a
    bounded-convergence-with-disable protocol was declined as
    disproportionate for a module with no consumer yet.
12. **Reviewer suggestions deliberately declined**, all recorded with
    reasoning in `-codex.md`'s dispositions: tri-state tab-id/lease results
    throughout the public surface (`peekTabId()` collapsing a read failure
    to `null` is fail-closed everywhere it feeds, never incorrectly
    succeeding); a real DOM-free ownership coordinator to make the
    caller-contract tests non-tautological (that is Stage 3a-canary's work,
    not 3a-foundation's); and items 10 and 11's fuller engineering. The
    recorded judgment for stopping the review loop is in the
    review-history section above.

Implementation record (what actually shipped, test counts, verification):
`player-consolidation-codex.md`'s "Phase 3 Stage 3a-foundation fenced-lease
redesign implementation" section.

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
