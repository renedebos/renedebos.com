// Deterministic tests for the sticky mini-player's view layer
// (miniplayer-views.js, Phase 3 Stage 3a-canary of plans/player-consolidation/)
// — rendered against a REAL PlaybackController with a fake <audio> element, so
// the state the bar paints is state the shipped controller actually produces.
//
// Every test here was written by first asking what mutation would make it
// fail; the ones whose answer wasn't obvious are named in their own comments.
// Two vacuous tests already shipped in this phase (HANDOFF.md's gotchas) and
// both had the same shape: asserting a consequence some other mechanism
// already guaranteed.
//
// Run: node scripts/test-miniplayer-views.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PlaybackController } from './player-controller.js';
// The real persistence codec, so at least one test crosses it: fixtures built
// by hand are how a field the codec silently drops stays invisible here.
import {
  FakeElement, FakeDocument, FakeAudio, FakeResizeObserver, resizeObservers, loadMiniplayerViews,
} from './test-fake-dom.mjs';

globalThis.document = new FakeDocument();
globalThis.ResizeObserver = FakeResizeObserver;

const { MiniPlayerView, HEIGHT_VAR } = await loadMiniplayerViews();

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function item(id, extra = {}) {
  return {
    id, kind: 'track', streamUrl: `https://example.test/stream?file=${id}.mp3`,
    title: `Song ${id}`, artist: 'Jerry Hannan', venue: 'Cafe Java',
    date: '1999-05-27', dateDisplay: '1999-05-27', durationSec: 200,
    pageUrl: `/shows/show-${id}/`, playLabel: `Song ${id}`, ...extra,
  };
}

function makeController(audio = new FakeAudio()) {
  return new PlaybackController({ audio, mediaSession: false });
}

// A bar with layout: Node has none, so the height the view publishes comes
// from a rect the test sets explicitly.
function mount(controller, opts = {}) {
  const root = new FakeElement('div', ['mini-player'], { hidden: true });
  root._rect = { left: 0, width: 800, top: 0, height: 56 };
  const view = new MiniPlayerView(root, opts);
  controller.mount(view);
  return { root, view };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const styleOf = () => globalThis.document.documentElement.style;

// An <audio> whose play() rejects the way a browser blocking autoplay does.
class BlockedAudio extends FakeAudio {
  play() {
    const err = new Error('play() failed because the user did not interact with the document first');
    err.name = 'NotAllowedError';
    return Promise.reject(err);
  }
}

// ── module boundary ────────────────────────────────────────────────────────
// The reason this module exists at all (see its header): player-views.js
// imports WaveSurfer unconditionally, and the bar ships on nearly every page.
// Asserted against the source text rather than by eye — an import added later
// would otherwise be invisible to this suite.
test('miniplayer-views.js imports player-controller.js and nothing else', () => {
  const src = readFileSync(new URL('./miniplayer-views.js', import.meta.url), 'utf8');
  const specifiers = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.deepEqual(specifiers, ['/assets/player-controller.js'],
    'a second import would put another asset — WaveSurfer above all — on every page the bar ships on');
});

// ── structure ──────────────────────────────────────────────────────────────
test('the bar stays hidden while nothing is playing, and reveals itself on the first item', () => {
  const c = makeController();
  const { root } = mount(c);
  assert.equal(root.hidden, true, 'an idle controller must not show a bar');
  assert.equal(root.innerHTML, '');

  c.setQueue([item('a')], { startIndex: 0 });
  assert.equal(root.hidden, false);
  assert.equal(root.querySelector('.mp-title').textContent, 'Song a');
  assert.equal(root.querySelector('.mp-meta').textContent, 'Jerry Hannan · Cafe Java · 1999-05-27');
  assert.equal(root.querySelector('.mp-time-total').textContent, '3:20');
  c.destroy();
});

test('an item with no pageUrl gets a title with no href at all, never an empty one', () => {
  const c = makeController();
  const { root } = mount(c);
  c.setQueue([item('a', { pageUrl: '' })], { startIndex: 0 });
  const title = root.querySelector('.mp-title');
  assert.equal(title.textContent, 'Song a');
  assert.equal(title.getAttribute('href'), undefined,
    'an <a href=""> reloads the current page when clicked; an <a> with no href is inert');
  c.destroy();
});

test('stop() hides the bar and clears its markup', () => {
  const c = makeController();
  const { root } = mount(c);
  c.setQueue([item('a')], { startIndex: 0 });
  c.stop();
  assert.equal(root.hidden, true);
  assert.equal(root.innerHTML, '', 'a hidden bar must not keep stale markup addressable');
  c.destroy();
});

// The PlaylistNowPlayingView lesson: gating the rebuild on `state` as well as
// item id replaces the play button — and its keyboard focus — on every
// loading->playing->paused transition, i.e. constantly during normal playback.
// Mutation that fails this: adding `|| snapshot.state !== this._lastState` to
// _render's rebuild condition.
test('ordinary state changes patch in place — the play button node survives loading→playing→paused', async () => {
  const c = makeController();
  const { root } = mount(c);
  c.setQueue([item('a')], { startIndex: 0, autoplay: true });
  const btn = root.querySelector('.mp-play');
  const loadingIcon = btn.innerHTML;
  await tick();
  const playingIcon = btn.innerHTML;
  c.pause();
  const pausedIcon = btn.innerHTML;

  assert.equal(root.querySelector('.mp-play'), btn, 'the button must be the same DOM node throughout');
  assert.notEqual(playingIcon, loadingIcon, 'the icon must actually be patched, not left stale');
  assert.notEqual(pausedIcon, playingIcon);
  c.destroy();
});

test('a currentItem.id change DOES rebuild the structure, with the new track’s metadata', async () => {
  const c = makeController();
  const { root } = mount(c);
  c.setQueue([item('a'), item('b')], { startIndex: 0, autoplay: true });
  await tick();
  const firstRange = root.querySelector('.progress-range');
  c.next();
  await tick();
  assert.equal(root.querySelector('.mp-title').textContent, 'Song b');
  assert.notEqual(root.querySelector('.progress-range'), firstRange, 'a new track gets fresh controls');
  c.destroy();
});

// ── prev / next ────────────────────────────────────────────────────────────
test('prev/next are hidden for a singleton queue and shown once the queue has more than one item', () => {
  const c = makeController();
  const { root } = mount(c);
  c.playSingleton(item('a'));
  assert.equal(root.querySelector('.mp-prev').hidden, true, 'a singleton has nothing to step to');
  assert.equal(root.querySelector('.mp-next').hidden, true);

  c.setQueue([item('a'), item('b')], { startIndex: 0 });
  assert.equal(root.querySelector('.mp-prev').hidden, false);
  assert.equal(root.querySelector('.mp-next').hidden, false);
  c.destroy();
});

// ── shuffle ────────────────────────────────────────────────────────────────
test('shuffle rides the singleton gate, toggles the controller, and mirrors shuffleOn', () => {
  const c = makeController();
  const { root } = mount(c);
  c.playSingleton(item('a'));
  assert.equal(root.querySelector('.mp-shuffle').hidden, true,
    'reordering a single item is as meaningless as stepping to it');

  c.setQueue([item('a'), item('b'), item('c')], { startIndex: 0 });
  const btn = root.querySelector('.mp-shuffle');
  assert.equal(btn.hidden, false);
  assert.equal(btn.getAttribute('aria-pressed'), 'false');

  // Through the CLICK path, not by calling toggleShuffle() directly — the
  // mutation this must fail on is the data-act handler being dropped. The
  // listener is delegated on the root, so that is where the event goes.
  root.dispatch('click', { target: btn });
  assert.equal(c.snapshot().shuffleOn, true, 'the click reached the controller');
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  assert.match(btn.getAttribute('aria-label'), /restore order/);

  root.dispatch('click', { target: btn });
  assert.equal(c.snapshot().shuffleOn, false);
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  c.destroy();
});

// Gated on queueRevision rather than recomputed per tick, so this proves the
// gate opens for an in-place queue mutation. removeAt() splices the SAME array
// — a queue-identity check would miss it entirely.
test('prev/next hide again when the queue shrinks to one in place', () => {
  const c = makeController();
  const { root } = mount(c);
  c.setQueue([item('a'), item('b')], { startIndex: 0 });
  assert.equal(root.querySelector('.mp-next').hidden, false);
  c.removeAt(1);
  assert.equal(root.querySelector('.mp-next').hidden, true,
    'removeAt mutates the queue array in place — only queueRevision catches it');
  c.destroy();
});

// ── transport ──────────────────────────────────────────────────────────────
test('the play button toggles, and prev/next drive the controller', async () => {
  const c = makeController();
  const { root } = mount(c);
  c.setQueue([item('a'), item('b')], { startIndex: 0, autoplay: true });
  await tick();

  root.dispatch('click', { target: root.querySelector('.mp-play') });
  assert.equal(c.audioElement.paused, true, 'clicking while playing pauses');
  root.dispatch('click', { target: root.querySelector('.mp-play') });
  await tick();
  assert.equal(c.audioElement.paused, false, 'clicking while paused resumes');

  root.dispatch('click', { target: root.querySelector('.mp-next') });
  await tick();
  assert.equal(c.currentIndex, 1);
  root.dispatch('click', { target: root.querySelector('.mp-prev') });
  await tick();
  assert.equal(c.currentIndex, 0);
  c.destroy();
});

test('dragging the range seeks, and the range stops following the audio mid-drag', async () => {
  const c = makeController();
  const { root } = mount(c);
  c.setQueue([item('a')], { startIndex: 0, autoplay: true });
  await tick();
  c.audioElement.duration = 200;

  const range = root.querySelector('.progress-range');
  root.dispatch('mousedown', { target: range });
  range.value = 500;
  root.dispatch('input', { target: range });
  assert.equal(c.audioElement.currentTime, 100, 'half-way along a 200s track');

  // While the drag is live, an incoming timeupdate must not yank the thumb back.
  c.audioElement.currentTime = 12;
  c.audioElement.dispatchEvent(new Event('timeupdate'));
  assert.equal(range.value, 500, 'the thumb belongs to the user until the drag ends');

  root.dispatch('change', { target: range });
  c.audioElement.currentTime = 100;
  c.audioElement.dispatchEvent(new Event('timeupdate'));
  assert.equal(range.value, 500);
  assert.equal(root.querySelector('.mp-time-current').textContent, '1:40');
  c.destroy();
});

// The Phase 2 post-deploy bug, in this file's shape: mousedown fired on the
// OLD range, then the track changed before 'change' ever arrived. Without the
// reset, _seeking stays true forever and the new range freezes at 0:00.
// Mutation that fails this: deleting `this._seeking = false` from _render's
// rebuild branch.
test('an in-progress drag interrupted by a track change does not freeze the new range', async () => {
  const c = makeController();
  const { root } = mount(c);
  c.setQueue([item('a'), item('b')], { startIndex: 0, autoplay: true });
  await tick();

  root.dispatch('mousedown', { target: root.querySelector('.progress-range') });
  c.next();                       // no 'change' event ever arrives for that drag
  await tick();

  c.audioElement.duration = 200;
  c.audioElement.currentTime = 50;
  c.audioElement.dispatchEvent(new Event('timeupdate'));
  assert.equal(root.querySelector('.progress-range').getAttribute('aria-valuetext'), '0:50 of 3:20',
    'the fresh range must keep tracking playback, not stay stuck at 0:00');
  c.destroy();
});

// ── Resume vs Retry (recorded restored-play rule 0.6) ──────────────────────
test('a blocked autoplay offers Resume', async () => {
  const c = makeController(new BlockedAudio());
  const { root } = mount(c);
  c.setQueue([item('a')], { startIndex: 0, autoplay: true });
  await tick();

  assert.equal(c.state, 'error', 'premise: a rejected play() lands in the error state');
  assert.equal(root.querySelector('.mp-play').getAttribute('aria-label'), 'Resume Song a');
  assert.equal(root.querySelector('.player-error-msg').textContent, 'Paused by your browser — tap Resume');
  c.destroy();
});

test('a network/decode failure offers Retry, not Resume', async () => {
  const c = makeController();
  const { root } = mount(c);
  c.setQueue([item('a')], { startIndex: 0, autoplay: true });
  await tick();
  c.audioElement.simulateError(2);            // MEDIA_ERR_NETWORK — a MediaError has no .name

  assert.equal(root.querySelector('.mp-play').getAttribute('aria-label'), 'Retry Song a');
  assert.equal(root.querySelector('.player-error-msg').textContent, 'Playback failed — tap to retry');
  c.destroy();
});

// lastPlayError is cleared at construction and at the start of a play attempt,
// never on a queue change — so the id is what makes the error attributable.
// The controller currently sets the two as a pair, which is exactly why this
// snapshot is handcrafted: the mismatch is only reachable if that pairing is
// ever broken, and this guard is what keeps the breakage from surfacing as a
// Resume button that resumes nothing.
test('an error attributed to a DIFFERENT item never offers Resume', () => {
  const c = makeController();
  const { root, view } = mount(c);
  c.setQueue([item('a')], { startIndex: 0 });
  view.onControllerUpdate({
    ...c.snapshot(),
    state: 'error',
    lastPlayError: { name: 'NotAllowedError', message: 'blocked' },
    lastPlayErrorItemId: 'some-other-track',
  });
  assert.equal(root.querySelector('.mp-play').getAttribute('aria-label'), 'Retry Song a',
    'a stale NotAllowedError must not promise a resume for a track it was never about');
  c.destroy();
});

test('the error message disappears once playback recovers', async () => {
  const c = makeController();
  const { root } = mount(c);
  c.setQueue([item('a')], { startIndex: 0, autoplay: true });
  await tick();
  c.audioElement.simulateError(2);
  assert.ok(root.querySelector('.player-error-msg'));

  c.play();
  await tick();
  assert.equal(root.querySelector('.player-error-msg'), null, 'a stale failure notice outlives its failure');
  assert.equal(root.querySelector('.mp-play').getAttribute('aria-label'), 'Pause Song a');
  c.destroy();
});

// ── close ──────────────────────────────────────────────────────────────────
// The view owns no stop/clear policy: Close's real sequence (dismiss → fence
// with a fresh epoch → write an empty session → drop the lease) is the
// coordinator's, and a view that stopped playback here would pre-empt it.
test('Close emits its callback and changes nothing about playback', async () => {
  const c = makeController();
  let closes = 0;
  const { root } = mount(c, { onClose: () => { closes++; } });
  c.setQueue([item('a'), item('b')], { startIndex: 0, autoplay: true });
  await tick();

  root.dispatch('click', { target: root.querySelector('.mp-close') });
  assert.equal(closes, 1);
  assert.equal(c.state, 'playing', 'the view must not stop playback itself');
  assert.equal(c.queue.length, 2, 'and must never touch the queue — /playlist/ owns its own');
  assert.equal(root.hidden, false, 'nor hide itself before the coordinator says so');
  c.destroy();
});

test('Close still fires after the view is detached from its controller', () => {
  const c = makeController();
  let closes = 0;
  const { root, view } = mount(c, { onClose: () => { closes++; } });
  c.setQueue([item('a')], { startIndex: 0 });
  const closeBtn = root.querySelector('.mp-close');
  c.unmount(view);
  root.dispatch('click', { target: closeBtn });
  assert.equal(closes, 0, 'onDetach aborts the listener — a detached bar is inert');
  c.destroy();
});

// ── published height ───────────────────────────────────────────────────────
test('--miniplayer-height is published when the bar appears and removed when it goes', () => {
  const c = makeController();
  const { root } = mount(c);
  assert.equal(styleOf().getPropertyValue(HEIGHT_VAR), '', 'nothing to make room for yet');

  c.setQueue([item('a')], { startIndex: 0 });
  assert.equal(styleOf().getPropertyValue(HEIGHT_VAR), '56px');

  c.stop();
  assert.equal(styleOf().getPropertyValue(HEIGHT_VAR), '',
    'removed rather than zeroed — consumers read it as var(--miniplayer-height, 0px)');
  c.destroy();
});

// Set-once-on-show is the tempting simplification and it is wrong: the bar
// wraps at 320px, and font loading, orientation change, zoom and a longer
// title all change its height after first paint. Mutation that fails this:
// dropping the ResizeObserver and publishing only from _buildStructure.
test('--miniplayer-height is republished when the bar resizes after first paint', () => {
  const c = makeController();
  const { root } = mount(c);
  c.setQueue([item('a')], { startIndex: 0 });
  assert.equal(styleOf().getPropertyValue(HEIGHT_VAR), '56px');

  const observer = resizeObservers[resizeObservers.length - 1];
  assert.deepEqual(observer.targets, [root], 'the bar itself is what must be observed');
  root._rect = { left: 0, width: 320, top: 0, height: 88 };   // wrapped onto two lines
  observer.resize();
  assert.equal(styleOf().getPropertyValue(HEIGHT_VAR), '88px');
  c.destroy();
});

test('unmounting disconnects the observer and clears the height', () => {
  const c = makeController();
  const { root, view } = mount(c);
  c.setQueue([item('a')], { startIndex: 0 });
  const observer = resizeObservers[resizeObservers.length - 1];

  c.unmount(view);
  assert.equal(observer.disconnected, true);
  assert.equal(styleOf().getPropertyValue(HEIGHT_VAR), '');
  // Behavioural, not just the flag: a disconnected observer that still
  // delivered would republish layout for a bar that is no longer there.
  root._rect = { left: 0, width: 800, top: 0, height: 120 };
  observer.resize();
  assert.equal(styleOf().getPropertyValue(HEIGHT_VAR), '',
    'a detached view must not keep publishing layout');
  c.destroy();
});

// ── review findings, 2026-08-16 ────────────────────────────────────────────
// Finding 1. QueueView's AbortController is created once and aborted for good
// by onDetach(); addEventListener with an already-aborted signal registers
// nothing, so a remounted view was silently inert. The remount path is the
// recorded Close contract's own ("a later genuine play brings it back").
// Mutation that fails this: moving `this._abort = new AbortController()` back
// to the constructor.
test('a view unmounted and remounted comes back fully alive', async () => {
  const c = makeController();
  const { root, view } = mount(c);
  c.setQueue([item('a'), item('b')], { startIndex: 0, autoplay: true });
  await tick();

  c.unmount(view);
  assert.equal(root.hidden, true, 'a detached bar must not stay on screen');
  assert.equal(root.innerHTML, '', 'nor keep stale markup addressable');
  assert.equal(styleOf().getPropertyValue(HEIGHT_VAR), '');

  c.mount(view);
  assert.equal(root.hidden, false, 'remounting rebuilds the bar');
  assert.equal(styleOf().getPropertyValue(HEIGHT_VAR), '56px', 'and re-reserves its space');
  root.dispatch('click', { target: root.querySelector('.mp-play') });
  assert.equal(c.audioElement.paused, true, 'and its controls actually reach the controller again');
  c.destroy();
});

// Finding 2. durationSec is nullable by schema. The total was written once at
// build time, so it showed 0:00 forever while the range announced the real
// duration the moment the browser reported one.
test('a null-duration item shows the real total once the browser reports one', async () => {
  const c = makeController();
  const { root } = mount(c);
  c.setQueue([item('a', { durationSec: null })], { startIndex: 0, autoplay: true });
  await tick();
  assert.equal(root.querySelector('.mp-time-total').textContent, '0:00', 'premise: nothing known yet');

  c.audioElement.duration = 245;
  c.audioElement.currentTime = 5;
  c.audioElement.dispatchEvent(new Event('timeupdate'));
  assert.equal(root.querySelector('.mp-time-total').textContent, '4:05');
  assert.equal(root.querySelector('.progress-range').getAttribute('aria-valuetext'), '0:05 of 4:05',
    'the visible total and the announced one must come from the same resolved duration');
  c.destroy();
});

// Finding 3. setQueue() legitimately replaces the item object under the same
// id — a restored session carrying older metadata, then the page's own fresh
// queue. Keying the whole render on the id alone left every field stale.
test('fresh metadata under an unchanged id is patched, link included', async () => {
  const c = makeController();
  const { root } = mount(c);
  c.setQueue([item('a', { title: 'Old Title', pageUrl: '/shows/old/' })], { startIndex: 0, autoplay: true });
  await tick();
  const btn = root.querySelector('.mp-play');

  c.setQueue([item('a', { title: 'New Title', pageUrl: '/shows/new/', venue: 'Sweetwater' })],
    { startIndex: 0, autoplay: true });
  await tick();
  assert.equal(root.querySelector('.mp-title').textContent, 'New Title');
  assert.equal(root.querySelector('.mp-title').getAttribute('href'), '/shows/new/',
    'a stale link would send the listener to a page for a track that is no longer playing');
  assert.equal(root.querySelector('.mp-meta').textContent, 'Jerry Hannan · Sweetwater · 1999-05-27');
  assert.equal(root.querySelector('.progress-range').getAttribute('aria-label'), 'Seek New Title');
  assert.equal(btn.getAttribute('aria-label'), 'Pause New Title',
    "the button's accessible name carries the title, so it must be re-derived too");
  assert.equal(root.querySelector('.mp-play'), btn, 'and none of that may replace the focus-bearing button');
  c.destroy();
});

// Finding 4. A press that doesn't move the thumb changes no value, so no
// 'change' is emitted and _seeking stayed true for the rest of the track.
// Mutation that fails this: dropping the document-level release listeners.
test('pressing the thumb and releasing without moving it does not freeze the range', async () => {
  const c = makeController();
  const { root } = mount(c);
  c.setQueue([item('a')], { startIndex: 0, autoplay: true });
  await tick();
  c.audioElement.duration = 200;

  const range = root.querySelector('.progress-range');
  root.dispatch('mousedown', { target: range });
  globalThis.document.dispatch('mouseup', { target: range });   // no 'change': nothing moved
  c.audioElement.currentTime = 100;
  c.audioElement.dispatchEvent(new Event('timeupdate'));
  assert.equal(range.value, 500, 'the range must resume following playback after the press ends');
  assert.equal(range.getAttribute('aria-valuetext'), '1:40 of 3:20',
    'the announced position must not diverge from the visible clock');
  c.destroy();
});

// Each pair is a COHERENT lifecycle — the press event that really precedes
// that release. An earlier version opened every iteration with `mousedown` and
// then dispatched `touchcancel`, a sequence no browser produces: the touch
// listener was never exercised at all, and deleting it left the suite green
// (post-fix review finding 6, verified by mutation).
test('a seek that ends outside the control, or is cancelled, ends on every input modality', async () => {
  for (const [startEvent, endEvent] of [['mousedown', 'mouseup'], ['mousedown', 'pointerup'],
    ['touchstart', 'touchend'], ['touchstart', 'touchcancel']]) {
    const c = makeController();
    const { root } = mount(c);
    c.setQueue([item('a')], { startIndex: 0, autoplay: true });
    await tick();
    c.audioElement.duration = 200;

    const range = root.querySelector('.progress-range');
    root.dispatch(startEvent, { target: range });
    // Frozen while the press is live — the thumb belongs to the user.
    c.audioElement.currentTime = 20;
    c.audioElement.dispatchEvent(new Event('timeupdate'));
    assert.equal(range.value, 0, `${startEvent} must start a seek`);

    // Released over the page, not the range — the listener is on the document
    // for exactly this.
    globalThis.document.dispatch(endEvent, { target: globalThis.document });
    c.audioElement.currentTime = 100;
    c.audioElement.dispatchEvent(new Event('timeupdate'));
    assert.equal(range.value, 500, `${startEvent} → ${endEvent} must end the seek`);
    c.destroy();
  }
});

// ── post-fix review findings, 2026-08-16 ──────────────────────────────────
// Findings 1 and 4 (below) originally drove their fixtures through the real
// persistence codec (miniplayer-state.js's buildEnvelope/decodeEnvelope) to
// prove venue/dateDisplay survived a round trip -- worth doing at the time,
// since that codec was the one thing here NOT built by hand. The codec was
// deleted 2026-08-22 (no production consumer; Codex review finding 7,
// Rene's call) along with its own suite; both tests were removed with it.
// The render-layer behavior they were protecting stays covered directly:
// venue rendering at 'the bar reveals...' above, and the dateDisplay-null
// fallback to date at 'idle vs stepping controls' below (line ~602).

// Finding 2. localStorage is same-origin-writable, so a corrupted or
// hand-edited envelope is the threat model the plan already assumes — and this
// is the line that turns a persisted string into a live link.
test('a pageUrl that is not a same-origin path never becomes an href', () => {
  for (const hostile of ['javascript:globalThis.__x=1', '//evil.test/shows/',
    'https://evil.test/shows/', 'data:text/html,<script>alert(1)</script>',
    // These four begin with a single '/' and still resolve off-origin: a
    // character check accepted every one of them (third-round finding 1).
    '/' + String.fromCharCode(92) + 'evil.test/shows/a',
    '/' + String.fromCharCode(9) + '/evil.test/',
    '/' + String.fromCharCode(10) + '/evil.test/',
    '/' + String.fromCharCode(13) + '/evil.test/']) {
    const c = makeController();
    const { root } = mount(c);
    c.setQueue([item('a', { pageUrl: hostile })], { startIndex: 0 });
    assert.equal(root.querySelector('.mp-title').getAttribute('href'), undefined,
      `${hostile} must not become a link`);
    assert.equal(root.querySelector('.mp-title').textContent, 'Song a', 'the title still renders');
    c.destroy();
  }
});

// Finding 3. The mirror image of the stale-metadata fix: a delimiter-joined
// cache key collides when a separator moves across a field boundary, and the
// persisted codec preserves any such character. The pair below produced one
// identical key, leaving the previous track's title AND link on screen.
test('two same-id items whose fields differ only by where a separator falls both render', () => {
  const SEP = String.fromCharCode(31);
  const c = makeController();
  const { root } = mount(c);
  c.setQueue([item('a', { title: 'A' + SEP + 'B', pageUrl: '/one/' })], { startIndex: 0 });
  c.setQueue([item('a', { title: 'A', pageUrl: 'B' + SEP + '/one/' })], { startIndex: 0 });
  assert.equal(root.querySelector('.mp-title').textContent, 'A',
    'the bar must follow the controller, not a colliding cache key');
  assert.equal(root.querySelector('.mp-title').getAttribute('href'), undefined,
    'and the stale link must be gone (this one is not a site path either)');
  c.destroy();
});

// Finding 4. 18 real catalog rows have no date (the sean-19-broadway-unknown-*
// set). Both surfaces this bar replaces say "unknown date" rather than
// dropping the field.
test('a track with no date says so, matching the surfaces this bar replaces', () => {
  const c = makeController();
  const { root } = mount(c);
  c.setQueue([item('a', { venue: '19 Broadway', date: null, dateDisplay: null })], { startIndex: 0 });
  assert.equal(root.querySelector('.mp-meta').textContent, 'Jerry Hannan · 19 Broadway · unknown date');
  c.destroy();
});

// Finding 5's other half — a title change under an unchanged id, with the
// state unchanged too — is already covered by "fresh metadata under an
// unchanged id is patched, link included": its `Pause New Title` assertion is
// exactly what dropping `+ item.title` from the controls cache key breaks.
// Verified by mutation rather than assumed; no second test needed.

// Finding 5. controller.prev() no-ops before index 0 — a deliberate Phase 1
// primitive — but the popup this bar replaces clamps to 0 and plays
// (continuous-player.js's playAt()), and PlaylistNowPlayingView already
// replicates that at the view level.
test('Previous on the first track restarts it instead of doing nothing', async () => {
  const c = makeController();
  const { root } = mount(c);
  c.setQueue([item('a'), item('b')], { startIndex: 0, autoplay: true });
  await tick();
  c.audioElement.duration = 200;
  c.audioElement.currentTime = 2;              // under the 3s restart threshold

  root.dispatch('click', { target: root.querySelector('.mp-prev') });
  await tick();
  assert.equal(c.currentIndex, 0);
  assert.equal(c.audioElement.currentTime, 0, 'Previous at the queue start restarts the track');
  assert.equal(c.audioElement.paused, false, 'and leaves it playing');
  c.destroy();
});

test('Previous more than 3s into any track restarts it rather than stepping back', async () => {
  const c = makeController();
  const { root } = mount(c);
  c.setQueue([item('a'), item('b')], { startIndex: 1, autoplay: true });
  await tick();
  c.audioElement.duration = 200;
  c.audioElement.currentTime = 30;

  root.dispatch('click', { target: root.querySelector('.mp-prev') });
  await tick();
  assert.equal(c.currentIndex, 1, 'the 3s convention wins over stepping back');
  assert.equal(c.audioElement.currentTime, 0);
  c.destroy();
});

// Finding 6. The item can change while `state` does not — removeAt() on the
// current index while paused does exactly that — and the icon/label cache is
// keyed on verb+state, so without invalidation the freshly built button keeps
// the template's generic aria-label="Play". The earlier mutation run pinned
// the cache key to a constant, which is a weaker property and passed this gap.
//
// The two items deliberately carry IDENTICAL metadata (two takes of one song
// at one show: same title, venue, date, duration), differing only by id — so
// _patchMeta() early-returns, the controls key (verb|state|title) is unchanged,
// and the ONLY thing that can re-label the freshly built button is the rebuild
// branch's own invalidation. Mutation that fails this: deleting
// `this._lastControlsKey = null` from the rebuild branch of _render().
//
// An earlier version of this comment claimed the same thing while the code
// ALSO invalidated from _patchMeta(), which made the two paths redundant and
// the claim false — the post-fix review caught it, and the fix was to make the
// controls key depend on the title directly rather than to reword the comment.
test('an item change with NO state change still re-labels the play button', async () => {
  const c = makeController();
  const { root } = mount(c);
  const take1 = item('take1', { title: 'Kilkelly Ireland', pageUrl: '/shows/one-show/' });
  const take2 = item('take2', { title: 'Kilkelly Ireland', pageUrl: '/shows/one-show/' });
  c.setQueue([take1, take2], { startIndex: 0, autoplay: true });
  await tick();
  c.pause();
  await tick();
  assert.equal(c.state, 'paused', 'premise: paused before');

  c.removeAt(0);                               // current item becomes take2, state stays 'paused'
  assert.equal(c.state, 'paused', 'premise: still paused after');
  assert.equal(c.currentItem.id, 'take2');
  assert.equal(root.querySelector('.mp-play').getAttribute('aria-label'), 'Play Kilkelly Ireland',
    'a fresh button left with the template\'s generic "Play" names no track at all');
  c.destroy();
});

// ── third-round review findings, 2026-08-16 ───────────────────────────────
// Finding 2. play() on an element that is already playing resolves without
// firing play/playing (WHATWG internal play steps), while _playIndex() has
// already set state 'loading' and is waiting for exactly that event. The bar
// sat in its loading presentation for the rest of the track while audio played.
// FakeAudio used to queue the events unconditionally and hid this; it now
// models the transition rule, so this test is only meaningful because the fake
// stopped lying. Mutation that fails it: making the play() call unconditional.
test('Previous on an already-playing first track restarts it without stranding the UI in loading', async () => {
  const c = makeController();
  const { root } = mount(c);
  c.setQueue([item('a'), item('b')], { startIndex: 0, autoplay: true });
  await tick();
  c.audioElement.duration = 200;
  c.audioElement.currentTime = 2;              // under the 3s threshold

  const seqBefore = c.snapshot().ownershipSeq;
  root.dispatch('click', { target: root.querySelector('.mp-prev') });
  await tick();
  assert.equal(c.currentIndex, 0);
  assert.equal(c.audioElement.currentTime, 0, 'it must still restart the track');
  assert.equal(c.audioElement.paused, false, 'and keep playing');
  assert.equal(c.state, 'playing', 'and NOT be stranded in loading, waiting for an event that never comes');
  // The view's own guard, asserted where it is still individually observable:
  // _playIndex() bumps the ownership sequence on EVERY attempt, so calling
  // play() on an already-playing element mints a spurious 'play-attempt' the
  // coordinator would have to reason about (Task 0.1's contract), and clears
  // lastPlayError as a side effect. The controller-level correction fixes the
  // stuck-loading symptom but cannot un-bump this.
  assert.equal(c.snapshot().ownershipSeq, seqBefore,
    'restarting an already-playing track must not mint a fresh ownership event');
  c.destroy();
});

test('Previous on a paused first track does start it', async () => {
  const c = makeController();
  const { root } = mount(c);
  c.setQueue([item('a'), item('b')], { startIndex: 0, autoplay: true });
  await tick();
  c.audioElement.duration = 200;
  c.audioElement.currentTime = 2;
  c.pause();
  await tick();

  root.dispatch('click', { target: root.querySelector('.mp-prev') });
  await tick();
  assert.equal(c.audioElement.paused, false, 'a paused track genuinely needs the play() call');
  assert.equal(c.audioElement.currentTime, 0);
  c.destroy();
});

// Finding 3. PlaybackController.mount() calls onAttach() even for a view
// already in its set, and a per-attachment AbortController that does not abort
// its predecessor leaves the earlier attachment's listeners live.
test('mounting the same view twice does not double up its controls', async () => {
  const c = makeController();
  const { root, view } = mount(c);
  c.setQueue([item('a')], { startIndex: 0, autoplay: true });
  await tick();
  c.mount(view);                               // duplicate mount, same instance
  await tick();

  root.dispatch('click', { target: root.querySelector('.mp-play') });
  await tick();
  assert.equal(c.audioElement.paused, true,
    'two live click handlers would toggle twice, leaving playback exactly as it was');
  c.destroy();
});

test('unmounting a doubly-mounted view removes every listener it ever added', async () => {
  const c = makeController();
  let closes = 0;
  const root = new FakeElement('div', ['mini-player'], { hidden: true });
  root._rect = { left: 0, width: 800, top: 0, height: 56 };
  const view = new MiniPlayerView(root, { onClose: () => { closes++; } });
  c.mount(view);
  c.mount(view);
  c.setQueue([item('a')], { startIndex: 0 });
  const closeBtn = root.querySelector('.mp-close');

  c.unmount(view);
  root.dispatch('click', { target: closeBtn });
  assert.equal(closes, 0, 'a listener from the first attachment must not survive teardown');
  c.destroy();
});

// ── harness contract ──────────────────────────────────────────────────────
// The fake is load-bearing now: two real bugs (this bar's Previous, and
// /playlist/'s) were invisible while FakeAudio fired play/playing on every
// call, and a third (the controller's silent-resume state) surfaced the moment
// it stopped. Pin both spec rules here so nobody "simplifies" the fake back.
test('FakeAudio models the two rules the real bugs depended on', async () => {
  const audio = new FakeAudio();
  const seen = [];
  ['play', 'playing'].forEach((t) => audio.addEventListener(t, () => seen.push(t)));

  audio.src = 'https://example.test/a.mp3';
  assert.equal(audio.paused, true, 'assigning src runs the load algorithm, which pauses');
  await audio.play();
  await tick();
  assert.deepEqual(seen, ['play', 'playing'], 'a paused -> playing transition fires both');

  await audio.play();                          // already playing
  await tick();
  assert.deepEqual(seen, ['play', 'playing'], 'a second play() on a playing element fires nothing');
  assert.equal(audio.paused, false);
});

// ── runner ─────────────────────────────────────────────────────────────
let failed = 0;
// ── share ──────────────────────────────────────────────────────────────────
// The bar only hands the current item and the pressed button to opts.onShare;
// share.js (lazily imported by attachMiniPlayerBar) owns the sheet/popover.
test('the share button renders in the controls and hands the CURRENT item to onShare', () => {
  const c = makeController();
  const calls = [];
  const { root } = mount(c, { onShare: (item, btn) => calls.push([item, btn]) });
  c.setQueue([item('a', { shareUrl: 'https://renedebos.com/t/abc123' }), item('b')], { startIndex: 0 });
  const btn = root.querySelector('.mp-share');
  assert.ok(btn, 'a .mp-share button is part of the bar');
  assert.equal(btn.getAttribute('aria-label'), 'Share this song');
  root.dispatch('click', { target: btn });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].id, 'a');
  assert.equal(calls[0][0].shareUrl, 'https://renedebos.com/t/abc123', 'shareUrl survives normalizeItem');
  assert.equal(calls[0][1], btn);
  // After advancing, the handler sees the NEW current item, not the first.
  c.next();
  root.dispatch('click', { target: root.querySelector('.mp-share') });
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0].id, 'b');
  c.destroy();
});

test('without an onShare handler the share button is inert, never a throw', () => {
  const c = makeController();
  const { root } = mount(c);
  c.setQueue([item('a')], { startIndex: 0 });
  assert.doesNotThrow(() => root.dispatch('click', { target: root.querySelector('.mp-share') }));
  c.destroy();
});

test('share.js is reached only by a dynamic import on press, never a static one', () => {
  const src = readFileSync(new URL('./miniplayer-views.js', import.meta.url), 'utf8');
  assert.ok(src.includes("import('/assets/share.js')"), 'attachMiniPlayerBar lazily imports share.js');
});

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok   - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error('       ' + (err && err.message ? err.message : err));
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
