// Deterministic tests for PlaybackController's state-machine/queue logic —
// no browser needed, just a fake <audio> element. Wired into the deploy
// workflow's Gate 3 (.github/workflows/deploy.yml) as well as being meant
// for re-running by hand whenever player-controller.js changes, and is
// the "stale-play and queue-transition tests pass" gate before old engines
// get deleted in a later migration step (see
// plans/player-consolidation/player-consolidation-plan.md).
//
// Run: node scripts/test-player-controller.mjs

import assert from 'node:assert/strict';
import { PlaybackController } from './player-controller.js';

// Node >=21 defines a getter-only `navigator` global (the Navigator API) —
// plain `globalThis.navigator = {...}` throws against it ("which has only a
// getter"). A real gap between an older local dev Node (where no such
// global exists yet, so the plain assignment silently just works) and CI's
// runner Node -- caught only once this suite actually ran there.
// Object.defineProperty replaces the accessor with a plain data property.
function setGlobalNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', {
    value, configurable: true, writable: true, enumerable: true,
  });
}

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
  // Assigning src runs the media element load algorithm, which sets paused to
  // true (HTML standard). Modelled because play() below only fires its events
  // on a paused -> playing transition, exactly like a browser: that pair of
  // rules is what makes "switch track" and "replay the current track" behave
  // differently, and the difference was a real bug (see the repeat-one test).
  set src(v) { this._src = v; this.error = null; this.paused = true; this.loadCount = (this.loadCount || 0) + 1; }
  // Counted separately from loadCount (which counts src ASSIGNMENTS): the iOS
  // first-play fix turns on whether load() is called explicitly, and assigning
  // src alone is exactly the case that was not enough.
  load() { this.error = null; this.paused = true; this.explicitLoads = (this.explicitLoads || 0) + 1; }
  play() {
    const wasPaused = this.paused;
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
    // WHATWG's internal play steps fire these only when the element was
    // actually paused. An already-playing element is seeked/resumed silently.
    if (wasPaused) {
      queueMicrotask(() => {
        this.dispatchEvent(new Event('play'));
        this.dispatchEvent(new Event('playing'));
      });
    }
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

// ── 0. load() on every source change ─────────────────────────────────────
// Both paths re-select the resource the same documented way: assigning src and
// then calling load(), rather than one relying on the implicit media element
// load algorithm and the other not.
//
// This started life as a fix for an iPhone report ("the first track tapped
// after a refresh always fails, the second works") on the theory that the
// retry path's load() was the only difference between them. That theory was
// WRONG — the real cause was a blocked autoplay from a deep link (see
// player-views.js's _setMessage). The test is kept because the contract it
// pins down is worth having on its own, not because it guards that bug.
test('every source change explicitly loads, not just a retry', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const a = item('t1'), b = item('t2');
    c.setQueue([a, b], { startIndex: 0, autoplay: true });
    await tick();
    assert.equal(audio.explicitLoads, 1, 'the FIRST play of a fresh element must load(), not only assign src');

    c.next();
    await tick();
    assert.equal(audio.explicitLoads, 2, 'switching tracks loads the new source too');

    // The other half of the contract: resuming the SAME source must not reload,
    // which would restart the track from zero instead of continuing it.
    c.pause();
    audio.currentTime = 42;
    const before = audio.explicitLoads;
    await c.play();
    await tick();
    assert.equal(audio.explicitLoads, before, 'resuming an unchanged source must NOT reload');
    assert.equal(audio.currentTime, 42, 'and must not rewind');
  } finally { c.destroy(); }
});

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

// Replaying the CURRENT item assigns no src, so no load happens; and `ended`
// does not set paused, so play() fires no play/playing event either (WHATWG
// internal play steps). Without the correction in _playIndex() the controller
// would sit in 'loading' forever while audio played on — the test above passed
// only because this file's FakeAudio used to fire those events unconditionally.
// Reachable two ways today: repeat-one's replay, and /playlist/'s endless
// rollover when the reshuffle puts the just-finished track back at index 0.
// Mutation that fails this: dropping the `!reloading && wasUnpaused` correction.
test('replaying the current item on an unpaused element ends in playing, never stuck in loading', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.setQueue([item('a'), item('b')], { startIndex: 0, autoplay: true });
    await tick();
    assert.equal(c.state, 'playing', 'premise: playing, and the element is not paused');
    assert.equal(audio.paused, false);
    const loads = audio.loadCount;

    c.play(0);                       // same item, same src: nothing reloads
    await tick();
    assert.equal(audio.loadCount, loads, 'premise: no reload happened, so no load events either');
    assert.equal(c.state, 'playing', 'a silent resume must still leave the controller in playing');
  } finally { c.destroy(); }
});

// A genuine track change DOES reload, so it keeps the ordinary
// loading -> playing path — the correction above must not short-circuit it.
test('switching tracks still goes through loading and lands in playing', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.setQueue([item('a'), item('b')], { startIndex: 0, autoplay: true });
    await tick();
    c.play(1);
    assert.equal(c.state, 'loading', 'a real load is pending, so loading is the truthful state');
    await tick();
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

// Step 5c-era review finding: appendQueue() only pushed onto _queue, never
// onto _unshuffledQueue -- so an item appended while shuffle was ON survived
// in the live (shuffled) queue but was never in the snapshot toggleShuffle()
// restores from, and vanished the instant shuffle was turned back off.
test('appendQueue keeps an item added while shuffled from vanishing on shuffle-off', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.setQueue(['a', 'b'].map(id => item(id)), { startIndex: 0 }); // 'a' current
    c.toggleShuffle();
    assert.equal(c.appendQueue([item('c')]), 1, 'a genuinely new id is appended');
    assert.ok(c.queue.some(t => t.id === 'c'), 'appended item is in the live (shuffled) queue');

    c.toggleShuffle(); // shuffle off -- restores from the pre-shuffle snapshot
    assert.ok(c.queue.some(t => t.id === 'c'),
      'an item appended while shuffled must still be present after shuffle is turned back off');
    assert.equal(c.queue.length, 3, 'no item silently dropped');
  } finally { c.destroy(); }
});

// Codex review finding (Phase 2 Stage 2a, 2026-08-14): appendQueue() used to
// normalize() the FULL input array before bounding it to room, so an
// oversized (untrusted-input-derived) array cost O(items.length) validation
// work even though at most `room` items could ever be kept. Fixed to slice
// the input to `room` before any per-item work. Proven here with items past
// the bound deliberately malformed (missing id, which throws in
// normalizeItem) -- the old order would throw reaching them; the fix must
// never even look at them.
test('appendQueue bounds the INPUT before normalizing, not just the output', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    // Fill to 2 short of the 1000-item cap.
    c.setQueue(Array.from({ length: 998 }, (_, i) => item('existing-' + i)));
    const fresh = Array.from({ length: 2 }, (_, i) => item('fresh-' + i));
    const malformed = Array.from({ length: 50 }, () => ({ /* no id, no streamUrl */ }));
    assert.equal(c.appendQueue(fresh.concat(malformed)), 2,
      'only room (2) items get appended; the malformed excess must never reach normalizeItem');
    assert.equal(c.queue.length, 1000);
  } finally { c.destroy(); }
});

test('appendQueue is a no-op with zero cost when the queue is already at its bound', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.setQueue(Array.from({ length: 1000 }, (_, i) => item('existing-' + i)));
    const malformed = Array.from({ length: 5 }, () => ({}));
    assert.equal(c.appendQueue(malformed), 0, 'room=0 must bail before touching the input at all');
    assert.equal(c.queue.length, 1000);
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
  setGlobalNavigator({
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
  });
  try {
    const audio = new FakeAudio();
    let c;
    assert.doesNotThrow(() => { c = new PlaybackController({ audio }); },
      'one unsupported lock-screen action must not abort the whole controller');
    assert.ok(handlers.play && handlers.pause, 'the supported actions still register');
    c.destroy();
  } finally { setGlobalNavigator(originalNav); }
});

// Step 5c-era review finding: destroy() called _abort.abort() (removing the
// 'pause' listener that calls _syncMediaPlaybackState()) BEFORE audio.pause()
// -- so pausing during teardown never updated navigator.mediaSession's
// playbackState, leaving the OS lock screen reporting "playing" for a
// controller that no longer exists.
test('destroy() leaves the lock screen reporting no active session, not stale "playing"', async () => {
  const originalNav = globalThis.navigator;
  setGlobalNavigator({
    mediaSession: { metadata: null, playbackState: 'none', setActionHandler() {} },
  });
  try {
    const audio = new FakeAudio();
    const c = new PlaybackController({ audio });
    c.setQueue([item('a')], { startIndex: 0, autoplay: true });
    await tick();
    assert.equal(navigator.mediaSession.playbackState, 'playing');

    c.destroy();
    assert.equal(navigator.mediaSession.playbackState, 'none',
      'teardown must clear the lock screen\'s reported state, not leave it stuck at "playing"');
  } finally { setGlobalNavigator(originalNav); }
});

// ── observable play-result signal (Phase 3 Stage 3a-foundation) ──────────
// Verified bug this exists to fix: _playIndex()'s internal .catch() means
// play() ALWAYS resolves, never rejects, so a caller doing
// controller.play().catch(...) to detect a blocked autoplay attempt cannot
// work — there is nothing to catch. snapshot().lastPlayError is the only
// observable signal, preserving err.name so 'NotAllowedError' is
// distinguishable from any other failure.
test('play() always resolves even on a blocked-autoplay rejection, but snapshot().lastPlayError distinguishes it', async () => {
  const audio = new FakeAudio();
  audio.autoplayBehavior = 'reject'; // err.name = 'NotAllowedError', per FakeAudio
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    await assert.doesNotReject(() => c.setQueue([item('a')], { startIndex: 0, autoplay: true }),
      'play()\'s returned promise must still always resolve — existing call sites must not need to change');
    await tick();
    assert.equal(c.state, 'error');
    assert.equal(c.snapshot().lastPlayError.name, 'NotAllowedError',
      'a blocked autoplay attempt must be distinguishable from a generic failure');
  } finally { c.destroy(); }
});

test('lastPlayError is null for a genuine load failure with no .name (a native MediaError), still distinguishable from NotAllowedError', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.setQueue([item('a')], { startIndex: 0, autoplay: true });
    await tick();
    audio.simulateError(2); // MEDIA_ERR_NETWORK -- a MediaError has no .name at all
    assert.equal(c.state, 'error');
    assert.notEqual(c.snapshot().lastPlayError.name, 'NotAllowedError',
      'a native media error must never be mistaken for a blocked-autoplay rejection');
  } finally { c.destroy(); }
});

test('lastPlayError clears at the start of a fresh play attempt, not left stale from a previous failure', async () => {
  const audio = new FakeAudio();
  audio.autoplayBehavior = 'reject';
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.setQueue([item('a'), item('b')], { startIndex: 0, autoplay: true });
    await tick();
    assert.equal(c.snapshot().lastPlayError.name, 'NotAllowedError');

    audio.autoplayBehavior = 'succeed';
    c.play(1);
    await tick();
    assert.equal(c.state, 'playing');
    assert.equal(c.snapshot().lastPlayError, null,
      'a fresh, successful attempt must not leave a stale error from an earlier one');
  } finally { c.destroy(); }
});

test('snapshot() always carries a lastPlayError key (null, not just absent) even before any failure', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    assert.equal(c.snapshot().lastPlayError, null);
  } finally { c.destroy(); }
});

// ── restoreSession() (Phase 3 Stage 3a-foundation) ────────────────────────
// No caller in this repo yet — a later stage's mini-player boot script is
// the first real consumer. Implemented and unit-tested now per the plan.
test('restoreSession() explicitly assigns audio.src (setQueue({autoplay:false}) deliberately does not)', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    // Prove the contrast first: setQueue() without autoplay does NOT assign src.
    c.setQueue([item('a')], { startIndex: 0 });
    assert.equal(audio.src, '', 'setQueue({autoplay:false}) must not assign src — restoreSession() exists partly because of this');

    c.restoreSession({ queue: [item('x'), item('y')], currentItemId: 'y', positionSec: 0 });
    assert.equal(audio.src, 'https://example.test/y.mp3');
    assert.equal(c.currentItem.id, 'y');
    assert.equal(c.currentIndex, 1);
    assert.equal(c.state, 'idle', 'cued, not playing — matches setQueue()\'s own "idle" convention for a cued-but-not-playing queue');
    assert.equal(audio.paused, true, 'restoreSession() must never start playback itself');
  } finally { c.destroy(); }
});

test('restoreSession() resolves currentItemId against the (possibly filtered) queue, not a raw index', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.restoreSession({ queue: [item('a'), item('b'), item('c')], currentItemId: 'c' });
    assert.equal(c.currentIndex, 2);
    assert.equal(c.currentItem.id, 'c');
  } finally { c.destroy(); }
});

test('restoreSession() falls back to "no current item" when currentItemId is missing/gone from the queue', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.restoreSession({ queue: [item('a'), item('b')], currentItemId: 'deleted-from-archive' });
    assert.equal(c.currentIndex, -1);
    assert.equal(c.currentItem, null);
    assert.equal(c.state, 'idle');
    assert.equal(audio.src, '', 'nothing resolvable — nothing should be loaded either');
  } finally { c.destroy(); }
});

test('restoreSession() seeks to positionSec only after loadedmetadata, not immediately', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.restoreSession({ queue: [item('a')], currentItemId: 'a', positionSec: 42 });
    assert.equal(audio.currentTime, 0, 'seeking before metadata is unreliable/a no-op in real browsers — must not even attempt it yet');

    audio.duration = 200;
    audio.dispatchEvent(new Event('loadedmetadata'));
    assert.equal(audio.currentTime, 42, 'the deferred seek must fire once metadata actually arrives');
  } finally { c.destroy(); }
});

test('restoreSession()\'s deferred seek is generation-guarded — does not fire against a track the user already navigated away from', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.restoreSession({ queue: [item('a'), item('b')], currentItemId: 'a', positionSec: 99 });
    // The user acts before metadata for 'a' ever loads -- a fresh restore/
    // play supersedes the pending deferred seek.
    c.restoreSession({ queue: [item('a'), item('b')], currentItemId: 'b', positionSec: 5 });
    audio.duration = 200;
    audio.currentTime = 0;
    audio.dispatchEvent(new Event('loadedmetadata')); // 'b's metadata landing, not 'a's
    assert.equal(audio.currentTime, 5, 'only the CURRENT (b) restore\'s seek must apply');

    // Now prove the stale one specifically was suppressed, not just
    // coincidentally overwritten: reset currentTime and fire loadedmetadata
    // again -- if the stale listener were still armed, it would jump to 99.
    audio.currentTime = 5;
    audio.dispatchEvent(new Event('loadedmetadata'));
    assert.equal(audio.currentTime, 5, 'the superseded restore\'s deferred seek must never fire at all');
  } finally { c.destroy(); }
});

// Implementation review finding #4 (2026-08-15): _playIndex() bumps `_gen`
// unconditionally on every play() attempt, including one that simply
// RESUMES the exact item restoreSession() just cued — the plan's own
// "attempt play() only when permitted" resume flow. A `_gen`-guarded seek
// would be silently invalidated by that resume call alone, before metadata
// ever has a chance to load, losing the restored position on the most
// common resume path. The fix keys the guard to `_queueRevision` (never
// bumped by play()/pause()/seek()) plus the restored item's own id instead.
test('restoreSession()\'s deferred seek survives calling play() to resume the SAME restored item', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.restoreSession({ queue: [item('a'), item('b')], currentItemId: 'a', positionSec: 42 });
    c.play(); // resume the current (restored) item, before metadata has loaded
    audio.duration = 200;
    audio.dispatchEvent(new Event('loadedmetadata'));
    assert.equal(audio.currentTime, 42,
      'the restored position must not be lost just because play() was called to resume the same item');
  } finally { c.destroy(); }
});

test('restoreSession()\'s deferred seek also survives a BLOCKED (autoplay-rejected) resume attempt on the same item', async () => {
  const audio = new FakeAudio();
  audio.autoplayBehavior = 'reject'; // simulates a blocked-autoplay NotAllowedError
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.restoreSession({ queue: [item('a')], currentItemId: 'a', positionSec: 17 });
    await c.play(); // rejected -- _playIndex() still bumps _gen and sets state 'error'
    assert.equal(c.state, 'error');

    audio.duration = 200;
    audio.dispatchEvent(new Event('loadedmetadata'));
    assert.equal(audio.currentTime, 17,
      'a blocked autoplay attempt on the same restored item must not lose the deferred seek either');
  } finally { c.destroy(); }
});

test('restoreSession() honors shuffleOn/repeatOne flags and clears any stale unshuffled snapshot (honest, documented shuffle-restoration limitation)', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.toggleShuffle(); // give the controller a pre-shuffle snapshot to prove gets cleared
    c.restoreSession({
      queue: [item('a'), item('b')], currentItemId: 'a',
      repeatOne: true, shuffleOn: true,
    });
    assert.equal(c.snapshot().repeatOne, true);
    assert.equal(c.snapshot().shuffleOn, true);
    // toggleShuffle() must degrade gracefully (flip the flag, keep the
    // queue order) rather than resurrect a stale pre-restore snapshot.
    const order = c.queue.map(t => t.id);
    c.toggleShuffle();
    assert.deepEqual(c.queue.map(t => t.id), order,
      'no pre-shuffle snapshot survives a restore -- toggling off must not silently reorder from stale data');
  } finally { c.destroy(); }
});

test('restoreSession() pauses any audio left over from a previous session before loading the restored one', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.setQueue([item('old')], { startIndex: 0, autoplay: true });
    await tick();
    assert.equal(audio.paused, false);

    c.restoreSession({ queue: [item('new1')], currentItemId: 'new1' });
    assert.equal(audio.paused, true);
  } finally { c.destroy(); }
});

test('restoreSession() is a no-op once destroyed', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  c.destroy();
  c.restoreSession({ queue: [item('a')], currentItemId: 'a', positionSec: 10 });
  assert.equal(audio.src, '');
  assert.equal(c.currentIndex, -1);
});

// ── onAnyExternalClaim (Phase 3 Stage 3a-foundation) ──────────────────────
// The existing onExternalClaim callback only runs while state is
// 'playing'/'loading' (verified directly, player-controller.js's
// constructor) — correct for its purpose (e.g. not showing a false "paused
// elsewhere" message on an already-paused tab), but that gating means a
// merely-restored, never-played controller can never learn it lost
// ownership under it. onAnyExternalClaim is a second, unconditional hook
// added specifically so ownership-tracking code (miniplayer-state.js, a
// later stage's consumer) can observe a claim regardless of state.
test('onAnyExternalClaim fires on every external claim regardless of state, unlike the gated onExternalClaim', async () => {
  const audioA = new FakeAudio();
  const audioB = new FakeAudio();
  let anyClaims = 0;
  let gatedClaims = 0;
  const a = new PlaybackController({
    audio: audioA, mediaSession: false,
    onExternalClaim: () => { gatedClaims++; },
    onAnyExternalClaim: () => { anyClaims++; },
  });
  const b = new PlaybackController({ audio: audioB, mediaSession: false });
  try {
    // 'a' is idle (never played) when 'b' claims -- the existing gated
    // callback must NOT fire (a was not playing/loading), but the new
    // unconditional one must.
    b.setQueue([item('x')], { startIndex: 0, autoplay: true });
    await tick();
    assert.equal(gatedClaims, 0, 'the existing gated callback is correctly silent for an already-idle controller');
    assert.equal(anyClaims, 1, 'the new unconditional hook must still observe the claim');

    // Now 'a' IS playing -- both must fire.
    a.setQueue([item('y')], { startIndex: 0, autoplay: true });
    await tick();
    b.setQueue([item('z')], { startIndex: 0, autoplay: true }); // b claims again, pausing a (now playing)
    await tick();
    assert.equal(gatedClaims, 1, 'the gated callback fires this time since a was playing');
    assert.equal(anyClaims, 2, 'the unconditional hook keeps firing every time, gated or not');
  } finally { a.destroy(); b.destroy(); }
});

// ── Stage 3a-canary Task 0.1: post-construction subscriptions + ownership
// sequence. The mini-player ADOPTS controllers that player-boot.js:60 and
// song-boot.js:69 construct with no arguments, so the constructor options
// alone are unreachable for it. ───────────────────────────────────────────

test('onAnyExternalClaim() subscribes AFTER construction — the adopt path, where no constructor option was ever passed', async () => {
  const audioA = new FakeAudio();
  const audioB = new FakeAudio();
  // Constructed exactly the way player-boot.js/song-boot.js do it: no options.
  const a = new PlaybackController({ audio: audioA, mediaSession: false });
  const b = new PlaybackController({ audio: audioB, mediaSession: false });
  let claims = 0;
  try {
    const off = a.onAnyExternalClaim(() => { claims++; });
    b.setQueue([item('x')], { startIndex: 0, autoplay: true });
    await tick();
    assert.equal(claims, 1, 'a late subscriber must receive claims on a controller it did not construct');

    off();
    b.setQueue([item('y')], { startIndex: 0, autoplay: true });
    await tick();
    assert.equal(claims, 1, 'unsubscribe must actually detach');
  } finally { a.destroy(); b.destroy(); }
});

test('the constructor option and a post-construction subscriber both fire, and neither displaces the other', async () => {
  const audioA = new FakeAudio();
  const audioB = new FakeAudio();
  let viaOption = 0;
  let viaMethod = 0;
  const a = new PlaybackController({
    audio: audioA, mediaSession: false, onAnyExternalClaim: () => { viaOption++; },
  });
  const b = new PlaybackController({ audio: audioB, mediaSession: false });
  try {
    a.onAnyExternalClaim(() => { viaMethod++; });
    b.setQueue([item('x')], { startIndex: 0, autoplay: true });
    await tick();
    assert.equal(viaOption, 1, 'the retained constructor option must still fire');
    assert.equal(viaMethod, 1, 'and the post-construction subscriber alongside it');
  } finally { a.destroy(); b.destroy(); }
});

test('ownership events arrive in order as {seq, kind}: play-attempt, then local-play', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  const seen = [];
  try {
    c.onOwnershipEvent(e => seen.push(e));
    c.setQueue([item('a')], { startIndex: 0, autoplay: true });
    await tick();
    assert.deepEqual(seen.map(e => e.kind), ['play-attempt', 'local-play'],
      'the synchronous attempt must be observable before the media play event');
    assert.deepEqual(seen.map(e => e.seq), [1, 2], 'one monotonic sequence, not per-kind counters');
  } finally { c.destroy(); }
});

test('play-attempt is observable synchronously, before the play promise settles', async () => {
  const audio = new FakeAudio();
  audio.autoplayBehavior = 'manual'; // play() never settles
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    assert.equal(c.snapshot().ownershipSeq, 0);
    c.setQueue([item('a')], { startIndex: 0, autoplay: true });
    // No await: this is the whole point. A row click (player-views.js:406)
    // starts playback synchronously, and the consumer must be able to see that
    // an attempt happened without waiting for playback to actually begin.
    const snap = c.snapshot();
    assert.equal(snap.ownershipSeq, 1, 'the attempt must be visible with zero awaits');
    assert.equal(snap.lastOwnershipEvent, 'play-attempt');
  } finally { c.destroy(); }
});

test('a REBUFFER (waiting -> playing) does NOT bump the ownership sequence — the epoch-storm guard', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.setQueue([item('a')], { startIndex: 0, autoplay: true });
    await tick();
    const afterPlay = c.snapshot().ownershipSeq;
    assert.equal(c.state, 'playing');

    // Exactly what an ordinary network stall produces: the state machine goes
    // 'playing' -> 'loading' -> 'playing' (player-controller.js's 'waiting' and
    // 'playing' listeners). Claiming on the STATE would mint a fresh ownership
    // epoch here — a lock acquisition, a write and a read-back — on every
    // buffering hiccup. Claiming on the 'play' EVENT, which does not fire on
    // rebuffer recovery, must not.
    audio.dispatchEvent(new Event('waiting'));
    assert.equal(c.state, 'loading', 'premise: a rebuffer really does move the state machine');
    audio.dispatchEvent(new Event('playing'));
    assert.equal(c.state, 'playing', 'premise: and back again');

    assert.equal(c.snapshot().ownershipSeq, afterPlay,
      'no ownership event may be emitted for recovery within the same playback episode');
  } finally { c.destroy(); }
});

// Rewritten 2026-08-16 after a review round proved the previous version
// vacuous: splitting _bumpOwnership() into per-kind counters exposing
// Math.max(localSeq, externalSeq) — a direct violation of the single-sequence
// contract this test is named for — left all 57 tests green, because it only
// ever asserted lastOwnershipEvent, which split counters also get right.
//
// Its comment was wrong too. claimListeners is module-scope
// (player-controller.js:25), so four simultaneously-live controllers share one
// registry and each receives THREE external claims, not the one the comment
// claimed. The scenarios now run one ISOLATED PAIR at a time, torn down before
// the next is built, and assert the exact {seq, kind} stream.
test('the ownership stream is ONE monotonic sequence spanning local and external events, with consecutive seq values', async () => {
  const mk = () => {
    const audio = new FakeAudio();
    const c = new PlaybackController({ audio, mediaSession: false });
    const seen = [];
    c.onOwnershipEvent(e => seen.push(e));
    return { audio, c, seen };
  };

  // Scenario 1 — this tab plays, then loses to another tab.
  let mine = mk(); let rival = mk();
  try {
    mine.c.setQueue([item('a')], { startIndex: 0, autoplay: true });
    await tick();
    rival.c.setQueue([item('r')], { startIndex: 0, autoplay: true });
    await tick();
    assert.deepEqual(mine.seen.map(e => e.kind), ['play-attempt', 'local-play', 'external-claim'],
      'exact stream, not just its last element');
    assert.deepEqual(mine.seen.map(e => e.seq), [1, 2, 3],
      'consecutive across BOTH local and external kinds — per-kind counters cannot produce this');
    assert.equal(mine.c.state, 'paused');
  } finally { mine.c.destroy(); rival.c.destroy(); }

  // Scenario 2 — another tab claims first, then this tab plays, then pauses.
  // Torn down and rebuilt so the shared claim registry holds exactly one pair.
  mine = mk(); rival = mk();
  try {
    rival.c.setQueue([item('r')], { startIndex: 0, autoplay: true });
    await tick();
    mine.c.setQueue([item('a')], { startIndex: 0, autoplay: true });
    await tick();
    mine.c.pause();
    await tick();
    assert.deepEqual(mine.seen.map(e => e.kind), ['external-claim', 'play-attempt', 'local-play'],
      'the mirror-image ordering');
    assert.deepEqual(mine.seen.map(e => e.seq), [1, 2, 3], 'one shared counter, still consecutive');
    assert.equal(mine.c.state, 'paused');
  } finally { mine.c.destroy(); rival.c.destroy(); }

  // The two scenarios end identically under any per-kind scheme (both paused,
  // both one local + one external), and are told apart ONLY by event order.
  // Only the second tab legitimately still owns the session.
});

test('a queued play event delivered after an intervening pause claims nothing and reports nothing playing', async () => {
  const a = { audio: new FakeAudio() };
  const b = { audio: new FakeAudio() };
  a.c = new PlaybackController({ audio: a.audio, mediaSession: false });
  b.c = new PlaybackController({ audio: b.audio, mediaSession: false });
  try {
    // Both started in the SAME task, before either queued 'play' event runs —
    // play()/pause() flip `paused` synchronously but deliver 'play'/'playing'
    // as queued tasks, and pause() does not cancel an already-queued one.
    a.c.setQueue([item('a')], { startIndex: 0, autoplay: true });
    b.c.setQueue([item('b')], { startIndex: 0, autoplay: true });
    await tick();

    // Whichever one lost is paused; it must not have re-claimed on the way out.
    for (const [name, x] of [['a', a], ['b', b]]) {
      if (!x.audio.paused) continue;
      assert.equal(x.c.snapshot().lastOwnershipEvent, 'external-claim',
        `${name} is paused, so its last ownership event must be the claim that paused it — `
        + 'a stale queued play event must not mint a fresh ownership epoch for silent audio');
      assert.notEqual(x.c.state, 'playing',
        `${name} reports playing while its audio is paused`);
    }
    assert.ok(a.audio.paused || b.audio.paused, 'premise: one of them really did lose');
  } finally { a.c.destroy(); b.c.destroy(); }
});

test('a late subscriber recovers a pre-subscription event by comparing snapshot().ownershipSeq', async () => {
  const audioA = new FakeAudio();
  const audioB = new FakeAudio();
  const a = new PlaybackController({ audio: audioA, mediaSession: false });
  const b = new PlaybackController({ audio: audioB, mediaSession: false });
  try {
    // This is the pre-adoption window: player-boot.js:60 constructs the
    // controller, but readiness only resolves on window.load (player-boot.js:217).
    // Everything here happens before the mini-player ever sees the controller.
    b.setQueue([item('x')], { startIndex: 0, autoplay: true });
    await tick();

    // Now the consumer finally adopts. Subscribe FIRST, read the snapshot
    // SECOND, then process by sequence.
    const received = [];
    a.onOwnershipEvent(e => received.push(e.seq));
    const adoptedAt = a.snapshot().ownershipSeq;

    assert.ok(adoptedAt > 0, 'the missed claim is still visible in the sequence');
    assert.equal(a.snapshot().lastOwnershipEvent, 'external-claim',
      'and its kind is recoverable, so the consumer knows not to restore as owner');
    assert.deepEqual(received, [], 'nothing was replayed as a live event — recovery is by comparison');
  } finally { a.destroy(); b.destroy(); }
});

test('lastPlayErrorItemId pins an error to its item, so a stale failure cannot mislabel a different track', async () => {
  const audio = new FakeAudio();
  audio.autoplayBehavior = 'reject';
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.setQueue([item('a'), item('b')], { startIndex: 0, autoplay: true });
    await tick();
    let snap = c.snapshot();
    assert.equal(snap.lastPlayError.name, 'NotAllowedError');
    assert.equal(snap.lastPlayErrorItemId, 'a', 'the error is pinned to the item it happened on');
    assert.equal(snap.lastPlayErrorItemId, snap.currentItem.id,
      'and matches the current item, so a Resume affordance is correct here');

    // Move to a different item WITHOUT playing: setQueue(no autoplay) does not
    // start an attempt, so nothing clears the error. Before this field existed
    // the stale NotAllowedError would have rendered "Resume" against item b.
    c.setQueue([item('b')], { startIndex: 0, autoplay: false });
    snap = c.snapshot();
    assert.equal(snap.lastPlayError.name, 'NotAllowedError', 'the error itself is still there (unchanged behavior)');
    assert.notEqual(snap.lastPlayErrorItemId, snap.currentItem.id,
      'but it no longer matches the current item, which is how a consumer knows to ignore it');
  } finally { c.destroy(); }
});

test('lastPlayError and lastPlayErrorItemId are cleared as a pair by a fresh attempt', async () => {
  const audio = new FakeAudio();
  audio.autoplayBehavior = 'reject';
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    c.setQueue([item('a')], { startIndex: 0, autoplay: true });
    await tick();
    assert.equal(c.snapshot().lastPlayErrorItemId, 'a');

    audio.autoplayBehavior = 'succeed';
    c.play(0);
    await tick();
    const snap = c.snapshot();
    assert.equal(snap.lastPlayError, null);
    assert.equal(snap.lastPlayErrorItemId, null, 'never an id left behind without its error');
  } finally { c.destroy(); }
});

test('a throwing subscriber cannot break the claim/pause path or the other subscribers', async () => {
  const audioA = new FakeAudio();
  const audioB = new FakeAudio();
  const a = new PlaybackController({ audio: audioA, mediaSession: false });
  const b = new PlaybackController({ audio: audioB, mediaSession: false });
  const realError = console.error;
  console.error = () => {};
  let secondRan = 0;
  try {
    a.setQueue([item('a')], { startIndex: 0, autoplay: true });
    await tick();
    a.onAnyExternalClaim(() => { throw new Error('subscriber blew up'); });
    a.onAnyExternalClaim(() => { secondRan++; });
    a.onOwnershipEvent(() => { throw new Error('ownership subscriber blew up'); });

    b.setQueue([item('x')], { startIndex: 0, autoplay: true });
    await tick();

    assert.equal(secondRan, 1, 'a later subscriber still runs after an earlier one threw');
    assert.equal(a.state, 'paused', 'and the external-claim pause itself still happened');
  } finally { console.error = realError; a.destroy(); b.destroy(); }
});

test('no ownership event can reach a destroyed controller (via _unclaim/_abort, NOT via the subscriber sets)', async () => {
  const audioA = new FakeAudio();
  const audioB = new FakeAudio();
  const a = new PlaybackController({ audio: audioA, mediaSession: false });
  const b = new PlaybackController({ audio: audioB, mediaSession: false });
  let claims = 0;
  try {
    a.onAnyExternalClaim(() => { claims++; });
    a.destroy();
    b.setQueue([item('x')], { startIndex: 0, autoplay: true });
    await tick();
    assert.equal(claims, 0, 'destroy() detaches the claim listener itself, so nothing is left to deliver');
  } finally { b.destroy(); }
});

// Deliberately a white-box assertion, and deliberately NOT phrased as
// "subscribers stop firing after destroy" — that phrasing passes with the
// clearing removed entirely, because destroy()'s _unclaim()/_abort.abort()
// already make it impossible for any event to be raised (verified by mutation:
// deleting the two .clear() calls leaves a behavioural test fully green).
// What the clearing actually buys is reference release: a mini-player
// coordinator subscribes with a closure over itself, so a controller that kept
// its subscriber set populated would pin that whole object graph for as long as
// the controller is reachable. Same reason _views.clear() sits directly above.
test('destroy() RELEASES subscriber references, so a coordinator holding a back-reference is collectable', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  c.onAnyExternalClaim(() => {});
  c.onOwnershipEvent(() => {});
  assert.equal(c._anyExternalClaimSubs.size, 1, 'premise: the subscription really was retained');
  assert.equal(c._ownershipSubs.size, 1);

  c.destroy();
  assert.equal(c._anyExternalClaimSubs.size, 0, 'destroy() must not leave subscriber closures pinned');
  assert.equal(c._ownershipSubs.size, 0);
});

test('subscribing after destroy retains nothing, and still returns an unsubscribe so callers need no special case', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  c.destroy();

  const off = c.onAnyExternalClaim(() => {});
  const offOwn = c.onOwnershipEvent(() => {});
  assert.equal(typeof off, 'function');
  assert.equal(typeof offOwn, 'function');
  assert.equal(c._anyExternalClaimSubs.size, 0, 'a late subscription on a dead controller must not re-pin references');
  assert.equal(c._ownershipSubs.size, 0);
  off(); offOwn(); // must not throw
});

// Stage 3a-canary Task 0.2's three ownership-channel tests were removed when
// Phase 3 was parked -- they imported miniplayer-state.js's channel-name and
// probe-message constants, which now live only on the `miniplayer-parked`
// branch. They asserted that the mini-player's ownership handshake used a
// channel separate from 'hannan-playback'; with no handshake there is no
// second channel to keep separate. Restore them alongside the module.

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
test('normalizeItem carries `song` through for the overflow menu', () => {
  // The whitelist is the schema. A field the build emits but this drops is
  // invisible everywhere downstream -- which is how the mini-player bar came
  // to offer one menu item fewer than the row for the same track.
  const withSong = normalizeItem({ id: 't1', streamUrl: 'https://x/s.mp3',
    song: { url: '/songs/truck/', plays: 25, canonical: 'Truck' } });
  assert.deepEqual(withSong.song, { url: '/songs/truck/', plays: 25, canonical: 'Truck' });
  // A whole-show recording is not a song, and must normalise to null rather
  // than undefined so consumers can test it the same way every time.
  const without = normalizeItem({ id: 'r1', streamUrl: 'https://x/s.mp3', kind: 'recording' });
  assert.equal(without.song, null);
});

console.log(`\n${tests.length - failed}/${tests.length} passed`);
// player-controller.js's module-level BroadcastChannel singleton is never
// closed (it's meant to live for the whole page lifetime in a browser), so
// Node's event loop never drains on its own here — exit explicitly rather
// than hang.
process.exit(failed ? 1 : 0);
