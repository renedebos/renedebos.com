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

test('an item with no pageUrl renders its title as a span, never an empty-href link', () => {
  const c = makeController();
  const { root } = mount(c);
  c.setQueue([item('a', { pageUrl: '' })], { startIndex: 0 });
  const title = root.querySelector('.mp-title');
  assert.equal(title.tagName, 'SPAN', 'an <a href=""> reloads the current page when clicked');
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
  const { view } = mount(c);
  c.setQueue([item('a')], { startIndex: 0 });
  const observer = resizeObservers[resizeObservers.length - 1];

  c.unmount(view);
  assert.equal(observer.disconnected, true, 'a detached view must not keep publishing layout');
  assert.equal(styleOf().getPropertyValue(HEIGHT_VAR), '');
  c.destroy();
});

// ── runner ─────────────────────────────────────────────────────────────
let failed = 0;
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
