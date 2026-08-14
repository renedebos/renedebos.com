// Deterministic tests for PlaybackController's state-machine/queue logic —
// no browser needed, just a fake <audio> element. Not wired into any CI
// (this project has no formal test suite/browser matrix by convention), but
// meant to be re-run by hand whenever player-controller.js changes, and is
// the "stale-play and queue-transition tests pass" gate before old engines
// get deleted in a later migration step (see
// plans/player-consolidation/player-consolidation-plan.md).
//
// Run: node scripts/test-player-controller.mjs

import assert from 'node:assert/strict';
import { PlaybackController } from './player-controller.js';

// ── fake <audio> ────────────────────────────────────────────────────────
// Mirrors just enough of HTMLMediaElement for the controller's own logic:
// .paused flips synchronously on play()/pause() (per spec), 'play' fires
// before 'playing', src reassignment is observable, and play()'s returned
// promise can be driven manually to simulate races.
class FakeAudio extends EventTarget {
  constructor() {
    super();
    this.preload = '';
    this._src = '';
    this.currentTime = 0;
    this.duration = NaN;
    this.paused = true;
    this.error = null;
    this.playbackRate = 1;
    this.autoplayBehavior = 'succeed'; // 'succeed' | 'reject' | 'manual'
    this.pendingPlay = null;
  }
  get src() { return this._src; }
  set src(v) { this._src = v; this.error = null; this.loadCount = (this.loadCount || 0) + 1; }
  load() { this.error = null; }
  play() {
    this.paused = false;
    if (this.autoplayBehavior === 'manual') {
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      this.pendingPlay = { resolve, reject };
      return promise;
    }
    if (this.autoplayBehavior === 'reject') {
      const err = new Error('blocked');
      err.name = 'NotAllowedError';
      return Promise.reject(err);
    }
    queueMicrotask(() => {
      this.dispatchEvent(new Event('play'));
      this.dispatchEvent(new Event('playing'));
    });
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
  simulateEnded() { this.dispatchEvent(new Event('ended')); }
  simulateError(code) { this.error = { code }; this.dispatchEvent(new Event('error')); }
}

function item(id, extra = {}) {
  return { id, streamUrl: `https://example.test/${id}.mp3`, title: id, ...extra };
}

const tick = () => new Promise(r => setTimeout(r, 0));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── 1. stale/rejected play() promises don't clobber newer state ──────────
test('stale rejected play() promise is ignored once a newer play() has started', async () => {
  const audio = new FakeAudio();
  audio.autoplayBehavior = 'manual';
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.setQueue([item('a'), item('b')]);
    c.play(0);
    const firstPending = audio.pendingPlay; // capture before it's overwritten below
    c.play(1); // supersedes the first play() before it ever settles
    const secondPending = audio.pendingPlay;
    assert.notEqual(firstPending, secondPending);

    firstPending.reject(Object.assign(new Error('interrupted'), { name: 'AbortError' }));
    await tick();
    assert.equal(c.state, 'loading', 'stale rejection must not flip state to error');

    secondPending.resolve();
    audio.dispatchEvent(new Event('play'));
    audio.dispatchEvent(new Event('playing'));
    await tick();
    assert.equal(c.state, 'playing');
    assert.equal(c.currentItem.id, 'b');
  } finally { c.destroy(); }
});

// ── 2. rapid item changes settle on the last one requested ───────────────
test('rapid consecutive play() calls settle on the last item, not an earlier one', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.setQueue([item('a'), item('b'), item('c')]);
    c.play(0);
    c.play(1);
    c.play(2);
    await tick();
    assert.equal(c.currentItem.id, 'c');
    assert.equal(c.state, 'playing');
  } finally { c.destroy(); }
});

// ── 3. repeat-one replays the same track from 0 at 'ended' ────────────────
test('repeat-one restarts the same item and resets currentTime on ended', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.setQueue([item('a'), item('b')], { startIndex: 0, autoplay: true });
    await tick();
    c.setRepeatOne(true);
    audio.currentTime = 187; // pretend playback ran to the end
    audio.simulateEnded();
    assert.equal(audio.currentTime, 0, 'ended handler must reset currentTime before replaying');
    await tick();
    assert.equal(c.currentItem.id, 'a', 'repeat-one must not advance to the next queue item');
    assert.equal(c.state, 'playing');
  } finally { c.destroy(); }
});

// ── 3b. without repeat-one, ended advances; at the end of the queue it stops ──
test('ended without repeat-one advances, and reaching the end of the queue sets state=ended', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.setQueue([item('a'), item('b')], { startIndex: 0, autoplay: true });
    await tick();
    audio.simulateEnded();
    await tick();
    assert.equal(c.currentItem.id, 'b');
    audio.simulateEnded();
    await tick();
    assert.equal(c.state, 'ended');
    assert.equal(c.currentIndex, 1, 'index stays put — this is state=ended, not stop()/idle');
  } finally { c.destroy(); }
});

// ── 4. shuffle enable/disable restores the exact original order ──────────
test('toggleShuffle preserves played history and restores exact original order on toggle-off', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const items = ['a', 'b', 'c', 'd', 'e'].map(id => item(id));
    c.setQueue(items, { startIndex: 2 }); // 'c' is current, no autoplay
    const before = c.queue.map(t => t.id);

    c.toggleShuffle();
    const afterShuffleOn = c.queue.map(t => t.id);
    assert.deepEqual(afterShuffleOn.slice(0, 3), before.slice(0, 3),
      'shuffle must only reorder the unplayed tail, never history up to and including the current item');
    assert.equal(c.currentItem.id, 'c', 'currently-cued item must not change identity when its tail is shuffled');

    c.toggleShuffle();
    const afterShuffleOff = c.queue.map(t => t.id);
    assert.deepEqual(afterShuffleOff, before, 'toggling off must restore the exact original order');
    assert.equal(c.currentItem.id, 'c', 'toggling off must not lose track of the currently-cued item');
  } finally { c.destroy(); }
});

// ── 5. removal/reorder around the current index ───────────────────────────
test('removeAt adjusts currentIndex correctly depending on position relative to it', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.setQueue(['a', 'b', 'c', 'd'].map(id => item(id)), { startIndex: 2 }); // 'c' current
    c.removeAt(0); // before current -> index shifts down, item unchanged
    assert.equal(c.currentItem.id, 'c');
    assert.equal(c.currentIndex, 1);

    c.removeAt(2); // after current ('d') -> index unaffected
    assert.equal(c.currentItem.id, 'c');
    assert.equal(c.currentIndex, 1);

    // Removing the current item when it's also the LAST one stops — there's
    // nothing left to slide into the slot. (Removing a current item that
    // isn't last slides the next one in instead; covered separately below.)
    c.removeAt(1);
    assert.equal(c.currentIndex, -1);
    assert.equal(c.currentItem, null);
    assert.equal(c.state, 'idle');
  } finally { c.destroy(); }
});

test('reorder keeps currentIndex pointing at the same item as it moves', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.setQueue(['a', 'b', 'c', 'd'].map(id => item(id)), { startIndex: 1 }); // 'b' current
    c.reorder(3, 0); // move 'd' to the front — shifts everything else up by one
    assert.equal(c.queue[0].id, 'd');
    assert.equal(c.currentItem.id, 'b');
    assert.equal(c.currentIndex, 2, 'b was at 1, an item was inserted before it, so it is now at 2');
  } finally { c.destroy(); }
});

// ── 6. singleton-to-queue transitions ─────────────────────────────────────
test('playSingleton replaces the whole queue; play() on an unqueued item no-ops instead', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.setQueue(['a', 'b', 'c'].map(id => item(id)), { startIndex: 0, autoplay: true });
    await tick();
    assert.equal(c.queue.length, 3);

    c.playSingleton(item('hero-full-recording'));
    await tick();
    assert.equal(c.queue.length, 1, 'playSingleton collapses the queue to just this item');
    assert.equal(c.currentItem.id, 'hero-full-recording');

    const before = c.queue.map(t => t.id);
    await c.play(item('not-in-queue'));
    assert.deepEqual(c.queue.map(t => t.id), before,
      'play() on an item not already in the queue must not silently rebuild the queue — that is playSingleton()\'s job');
  } finally { c.destroy(); }
});

// ── 6b. queue-context round trips (the real show-page flows) ──────────────
// The singleton test above only proves an unqueued item no-ops. These prove a
// visitor can actually get BACK to the track queue after the Hero card
// collapsed it — the flow a show page performs constantly.
test('Track -> Hero -> Track returns to the full track queue', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const tracks = ['t1', 't2', 't3'].map(id => item(id));
    c.setQueue(tracks, { startIndex: 0, autoplay: true });
    await tick();
    assert.equal(c.currentItem.id, 't1');

    c.playSingleton(item('full-recording'));
    await tick();
    assert.equal(c.queue.length, 1);

    // A track row re-asserts its own queue rather than calling play(item).
    c.setQueue(tracks, { startIndex: 1, autoplay: true });
    await tick();
    assert.equal(c.queue.length, 3, 'the full track queue must be restored, not left collapsed');
    assert.equal(c.currentItem.id, 't2');
    assert.equal(c.state, 'playing');
  } finally { c.destroy(); }
});

test('Hero -> Track -> Next advances within the restored queue', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const tracks = ['t1', 't2', 't3'].map(id => item(id));
    c.playSingleton(item('full-recording'));
    await tick();
    c.setQueue(tracks, { startIndex: 0, autoplay: true });
    await tick();
    c.next();
    await tick();
    assert.equal(c.currentItem.id, 't2', 'next() must advance in the restored queue, not the discarded singleton');
  } finally { c.destroy(); }
});

test('Alternate recording -> Track also restores the track queue', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const tracks = ['t1', 't2'].map(id => item(id));
    c.setQueue(tracks, { startIndex: 0, autoplay: true });
    await tick();
    c.playSingleton(item('alternate-transfer', { kind: 'recording' }));
    await tick();
    assert.equal(c.currentItem.kind, 'recording');
    c.setQueue(tracks, { startIndex: 0, autoplay: true });
    await tick();
    assert.equal(c.queue.length, 2);
    assert.equal(c.currentItem.id, 't1');
  } finally { c.destroy(); }
});

// ── legacy removeAt parity: removing the playing item slides the next in ──
test('removing the currently-playing item cues the next one and keeps playing (legacy parity)', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.setQueue(['a', 'b', 'c'].map(id => item(id)), { startIndex: 1, autoplay: true }); // 'b' playing
    await tick();
    assert.equal(c.currentItem.id, 'b');

    c.removeAt(1); // remove the playing item — legacy engines slide 'c' in and keep going
    await tick();
    assert.equal(c.currentItem.id, 'c', 'the next item must slide into the slot, not stop playback');
    assert.equal(c.currentIndex, 1);
    assert.equal(c.state, 'playing');
  } finally { c.destroy(); }
});

test('removing the last item while it plays stops, and emptying the queue stops', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.setQueue(['a', 'b'].map(id => item(id)), { startIndex: 1, autoplay: true }); // 'b' (last) playing
    await tick();
    c.removeAt(1);
    assert.equal(c.currentIndex, -1, 'nothing can slide in past the end — this stops');
    assert.equal(c.state, 'idle');

    c.setQueue([item('solo')], { startIndex: 0, autoplay: true });
    await tick();
    c.removeAt(0);
    assert.equal(c.queue.length, 0);
    assert.equal(c.state, 'idle');
  } finally { c.destroy(); }
});

// ── setQueue while playing must not leave stale audio running ─────────────
test('setQueue without autoplay halts audio left over from the discarded queue', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.setQueue([item('old')], { startIndex: 0, autoplay: true });
    await tick();
    assert.equal(audio.paused, false);

    c.setQueue([item('new1'), item('new2')]); // cue only, no autoplay
    assert.equal(audio.paused, true,
      'audio from the replaced queue must not keep playing while currentItem points elsewhere');
    assert.equal(c.currentIndex, -1);
  } finally { c.destroy(); }
});

// ── reorder bounds + shuffle-snapshot invalidation ────────────────────────
test('reorder clamps an out-of-range target and drops the stale shuffle snapshot', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.setQueue(['a', 'b', 'c'].map(id => item(id)), { startIndex: 0 });
    c.toggleShuffle();
    c.reorder(0, 99); // out of range — must clamp to the last slot, not append oddly
    assert.equal(c.queue.length, 3, 'no items lost or duplicated by an out-of-range drop target');
    assert.equal(c.queue[2].id, 'a');
    // Toggling shuffle off now must not resurrect the pre-reorder order.
    const afterReorder = c.queue.map(t => t.id);
    c.toggleShuffle();
    assert.deepEqual(c.queue.map(t => t.id), afterReorder,
      'a manual reorder invalidates the pre-shuffle snapshot; restoring it would silently undo the reorder');
  } finally { c.destroy(); }
});

// ── normalizeItem validation ──────────────────────────────────────────────
test('normalizeItem rejects unusable items and sanitizes bad numbers', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    assert.throws(() => c.setQueue([{ id: 'x' }]), /streamUrl/,
      'a missing streamUrl is never recoverable and must fail loudly');
    assert.throws(() => c.setQueue([{ streamUrl: 'https://e.test/a.mp3' }]), /id/);
    c.setQueue([item('a', { durationSec: NaN }), item('b', { durationSec: -5 })]);
    assert.equal(c.queue[0].durationSec, null, 'NaN duration must normalize to null, not reach seek math');
    assert.equal(c.queue[1].durationSec, null, 'negative duration must normalize to null');
  } finally { c.destroy(); }
});

// ── destroy() teardown ────────────────────────────────────────────────────
test('destroy() pauses audio and detaches listeners so a dead controller cannot act', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  c.setQueue([item('a'), item('b')], { startIndex: 0, autoplay: true });
  await tick();
  assert.equal(c.state, 'playing');

  c.destroy();
  assert.equal(audio.paused, true, 'destroy() must stop playback, not leave it audible');

  // Events from the element must no longer drive the destroyed controller.
  const stateAfterDestroy = c.state;
  audio.simulateEnded();
  await tick();
  assert.equal(c.state, stateAfterDestroy, 'a destroyed controller must not respond to media events');
  assert.equal(c.currentIndex, 0, 'a destroyed controller must not advance its queue');
});

// ── 7. external playback claims pause the other controller on the page ────
test('claiming playback on one controller pauses another that was playing', async () => {
  const audioA = new FakeAudio();
  const audioB = new FakeAudio();
  const a = new PlaybackController({ audio: audioA, mediaSession: false });
  const b = new PlaybackController({ audio: audioB, mediaSession: false });
  try {
    b.setQueue([item('x')], { startIndex: 0, autoplay: true });
    await tick();
    assert.equal(b.state, 'playing');

    a.setQueue([item('y')], { startIndex: 0, autoplay: true });
    await tick();
    assert.equal(a.state, 'playing');
    assert.equal(b.state, 'paused', 'a claiming playback must pause b, which was still playing');
  } finally { a.destroy(); b.destroy(); }
});

// ── hard load failure surfaces as state=error, not a stuck spinner ────────
test('a hard load failure (audio error event) surfaces as state=error', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.setQueue([item('a')], { startIndex: 0, autoplay: true });
    await tick();
    audio.simulateError(4); // MEDIA_ERR_SRC_NOT_SUPPORTED
    assert.equal(c.state, 'error');
  } finally { c.destroy(); }
});

test('toggle() on a failed item retries with a fresh load instead of pausing', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.setQueue([item('a')], { startIndex: 0, autoplay: true });
    await tick();
    audio.simulateError(2);           // MEDIA_ERR_NETWORK, mid-playback
    assert.equal(c.state, 'error');
    assert.equal(audio.paused, false, 'an element can still report paused===false after erroring');

    const loadsBefore = audio.loadCount;
    c.toggle();
    await tick();
    assert.ok(audio.loadCount > loadsBefore,
      'retry must reassign/reload the source — play() alone will not clear a media error');
    assert.equal(c.state, 'playing');
  } finally { c.destroy(); }
});

test('retry reloads even when play() rejected without setting audio.error', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    // A rejected play() promise (autoplay block, decode refusal) puts the
    // controller in 'error' WITHOUT populating audio.error. The earlier retry
    // check ran after _setState('loading'), so the state half of the condition
    // was dead and only the audio.error half worked — meaning exactly this path
    // silently skipped the reload. The existing error test used a native error
    // event, so it passed without covering this.
    audio.autoplayBehavior = 'reject';
    c.setQueue([item('a')], { startIndex: 0, autoplay: true });
    await tick();
    assert.equal(c.state, 'error');
    assert.equal(audio.error, null, 'a rejected play() leaves audio.error unset');

    audio.autoplayBehavior = 'succeed';
    const loadsBefore = audio.loadCount;
    c.toggle();
    await tick();
    assert.ok(audio.loadCount > loadsBefore, 'the retry must still force a fresh load on this path');
    assert.equal(c.state, 'playing');
  } finally { c.destroy(); }
});

test('a browser that rejects an unsupported Media Session action still constructs', async () => {
  const originalNav = globalThis.navigator;
  const handlers = {};
  globalThis.navigator = {
    mediaSession: {
      metadata: null,
      playbackState: 'none',
      setActionHandler(action, fn) {
        // Safari-shaped partial support: some actions simply throw.
        if (action === 'previoustrack' || action === 'nexttrack') {
          throw new TypeError(`unsupported action: ${action}`);
        }
        handlers[action] = fn;
      },
    },
  };
  try {
    const audio = new FakeAudio();
    let c;
    assert.doesNotThrow(() => { c = new PlaybackController({ audio }); },
      'one unsupported lock-screen action must not abort the whole controller');
    assert.ok(handlers.play && handlers.pause, 'the supported actions still register');
    c.destroy();
  } finally { globalThis.navigator = originalNav; }
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
// player-controller.js's module-level BroadcastChannel singleton is never
// closed (it's meant to live for the whole page lifetime in a browser), so
// Node's event loop never drains on its own here — exit explicitly rather
// than hang.
process.exit(failed ? 1 : 0);
