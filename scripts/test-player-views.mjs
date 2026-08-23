// Deterministic tests for the view layer's controller-state -> DOM logic,
// against fixtures built from the real generated markup shapes in
// sitegen/pages.py (.ws-track and .custom-player track rows) and
// sitegen/fragments.py (the hero recording card).
//
// Like test-player-controller.mjs this runs in plain Node with no browser and
// no CI wiring — re-run by hand when the views change. It deliberately does
// NOT try to verify rendering (canvas output, WaveSurfer internals, real
// media): those need a real browser and stay part of the manual parity
// checklist. What it does verify is the logic that decides what the DOM
// should say — icon/label state, time text, active/error classes, seek
// translation, queue-context routing, and teardown.
//
// Run: node scripts/test-player-views.mjs

import assert from 'node:assert/strict';
import { PlaybackController } from './player-controller.js';

// The DOM/media fakes and the module-loading trick live in test-fake-dom.mjs,
// shared with test-player-boot.mjs.
import {
  FakeElement, FakeAudio, FakeWaveSurfer, wsInstances, loadPlayerViews,
} from './test-fake-dom.mjs';

// Globals player-views.js reads at module load.
globalThis.document = {
  documentElement: {},
  createElement: (tag) => new FakeElement(tag),
  querySelectorAll: () => [],
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.window = { devicePixelRatio: 1 };

const { PlayerView, CompactPlayerView, HeroPlayerView, itemFromRowElement } = await loadPlayerViews();

// ── fixtures mirroring the real generated markup ───────────────────────────
function trackRow({ waveform = false, num = 1, duration = '3:42' } = {}) {
  const row = new FakeElement('div', ['track-row', waveform ? 'ws-track' : 'custom-player']);
  const btn = new FakeElement('button', ['play-btn']);
  btn.dataset.playLabel = `Song ${num}, Jerry Hannan, 1999-05-27`;
  // Mirrors fragments.py's player(): the real button ships with its idle
  // aria-label already baked into the server-rendered markup
  // (aria-label="Play{label}") rather than relying on a first JS render to
  // set it — which is exactly why _render()'s early-return-when-never-active
  // (Finding #1) is safe to skip that redundant initial write.
  btn.setAttribute('aria-label', `Play ${btn.dataset.playLabel}`);
  // The real button ships with an <svg> icon inside it, and that svg -- not
  // the button -- is what a click actually targets. It matters: _render()
  // swaps the button's innerHTML, orphaning it mid-dispatch.
  btn.innerHTML = '<svg><polygon/></svg>';
  row.appendChild(btn);
  row.appendChild(new FakeElement('span', ['track-num']));
  if (waveform) row.appendChild(new FakeElement('div', ['ws-wave']));
  const time = new FakeElement('span', ['time-label', 'current']);
  time.dataset.duration = duration;          // compact rows carry the total here
  time.textContent = `0:00 / ${duration}`;
  row.appendChild(time);
  if (!waveform) {
    const range = new FakeElement('input', ['progress-range']);
    range.max = 1000;
    row.appendChild(range);
  }
  // The inert parts a tap should now play from, plus the interactive ones it
  // must not (CompactPlayerView.ROW_CLICK_EXEMPT).
  const title = new FakeElement('span', ['track-title']);
  title.textContent = `Song ${num}`;
  row.appendChild(title);
  row.appendChild(new FakeElement('a', ['download-btn']));
  row.appendChild(new FakeElement('a', ['track-share']));
  row.appendChild(new FakeElement('button', ['track-add']));
  return row;
}

// Mirrors recording_card() -> player() as actually generated: .recording-item
// wrapping a .custom-player, whose range and time-row live inside a
// .progress-wrap. recording_card() calls player() with NO duration, so there is
// exactly ONE time label (the current one) and it carries no data-duration —
// hence the hero renders bare elapsed rather than "elapsed / total". There are
// also no prev/next controls in the real markup, so the fixture has none.
function heroCard() {
  const card = new FakeElement('div', ['recording-item']);
  const player = new FakeElement('div', ['custom-player']);
  const btn = new FakeElement('button', ['play-btn']);
  btn.dataset.playLabel = 'Complete show, Jerry Hannan, 1999-05-27';
  player.appendChild(btn);
  const wrap = new FakeElement('div', ['progress-wrap']);
  wrap.appendChild(new FakeElement('input', ['progress-range']));
  const timeRow = new FakeElement('div', ['time-row']);
  timeRow.appendChild(new FakeElement('span', ['time-label', 'current']));
  wrap.appendChild(timeRow);
  player.appendChild(wrap);
  card.appendChild(player);
  return card;
}

const item = (id, extra = {}) => ({
  id, streamUrl: `https://example.test/${id}.mp3`, title: id,
  playLabel: `${id}, Jerry Hannan`, durationSec: 222, ...extra,
});
const tick = () => new Promise(r => setTimeout(r, 0));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── tests ──────────────────────────────────────────────────────────────────
test('itemFromRowElement parses data-item and survives malformed JSON', async () => {
  const row = trackRow();
  row.dataset.item = JSON.stringify(item('t1'));
  assert.equal(itemFromRowElement(row).id, 't1');

  const bad = trackRow();
  bad.dataset.item = '{not json';
  assert.equal(itemFromRowElement(bad), null, 'one malformed row must not throw and take down the page');
  assert.equal(itemFromRowElement(trackRow()), null, 'a row with no data-item yields null');
});

test('a compact row renders play/pause/loading icons with track-specific aria-labels', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const row = trackRow();
    const it = item('t1');
    const view = new CompactPlayerView(row, it, { queueItems: [it], queueIndex: 0 });
    c.mount(view);
    const btn = row.querySelector('.play-btn');
    assert.match(btn.getAttribute('aria-label'), /^Play Song 1,/,
      'idle rows read "Play <track>", never a bare "Play"');

    view._onPlayClick();
    assert.equal(c.state, 'loading');
    assert.equal(btn.innerHTML.includes('animation:spin'), true, 'loading shows the spinner icon');

    await tick();
    assert.equal(c.state, 'playing');
    assert.match(btn.getAttribute('aria-label'), /^Pause Song 1,/);
    assert.equal(row.classList.contains('playing'), true);
  } finally { c.destroy(); }
});

// ── tapping the row itself plays it ───────────────────────────────────────
// Rene, 2026-08-22, on a phone: the 36px play button was the only target, and
// the title -- the largest thing in the row -- did nothing at all, its info
// card being bound to mouseover in player.js. See CompactPlayerView's
// _onRowClick.

test('tapping the title plays the row', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const row = trackRow();
    const it = item('t1');
    c.mount(new CompactPlayerView(row, it, { queueItems: [it], queueIndex: 0 }));
    const title = row.querySelector('.track-title');
    row.dispatch('click', { target: title });
    await tick();
    assert.equal(c.state, 'playing');
    assert.equal(c.currentIndex, 0);
  } finally { c.destroy(); }
});

test('tapping the time label and the track number play it too', async () => {
  for (const sel of ['.time-label', '.track-num']) {
    const audio = new FakeAudio();
    const c = new PlaybackController({ audio, mediaSession: false });
    try {
      const row = trackRow();
      const it = item('t1');
      c.mount(new CompactPlayerView(row, it, { queueItems: [it], queueIndex: 0 }));
      row.dispatch('click', { target: row.querySelector(sel) });
      await tick();
      assert.equal(c.state, 'playing', `${sel} starts playback`);
    } finally { c.destroy(); }
  }
});

test('tapping a playing row pauses it, exactly as its play button does', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const row = trackRow();
    const it = item('t1');
    c.mount(new CompactPlayerView(row, it, { queueItems: [it], queueIndex: 0 }));
    row.dispatch('click', { target: row.querySelector('.track-title') });
    await tick();
    assert.equal(c.state, 'playing');
    row.dispatch('click', { target: row.querySelector('.track-title') });
    await tick();
    assert.equal(c.state, 'paused', 'a second tap toggles, rather than doing nothing');
  } finally { c.destroy(); }
});

test('the row handler never double-fires with the play button', async () => {
  // The button has its own listener AND the click propagates through the row.
  // Without the exemption that is start-then-toggle: one tap that leaves the
  // track paused, i.e. a play button that does not play.
  //
  // Dispatched on the BUTTON and allowed to propagate for real -- the whole
  // point. An earlier version of this test fired on the button and the row
  // separately, which modelled propagation as two independent events and so
  // could not see the ordering bug at all. It passed while production was
  // firing _onPlayClick twice per click.
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const row = trackRow();
    const it = item('t1');
    const view = new CompactPlayerView(row, it, { queueItems: [it], queueIndex: 0 });
    c.mount(view);
    let calls = 0;
    const orig = view._onPlayClick.bind(view);
    view._onPlayClick = () => { calls++; return orig(); };
    const btn = row.querySelector('.play-btn');
    // Target the ICON inside the button, as a real click does -- _render()
    // replaces the button's innerHTML and orphans it before the event
    // reaches the row, which is what defeats a bubble-phase exemption.
    const icon = btn.children[0];
    icon.dispatch('click');
    await tick();
    assert.equal(calls, 1, 'exactly ONE _onPlayClick per button press');
    assert.equal(c.state, 'playing', 'one tap on the button leaves it PLAYING');
  } finally { c.destroy(); }
});

test('a click whose target was removed mid-dispatch does not play the row', async () => {
  // The real mechanism behind the double-fire, kept as its own test because
  // it is subtle and entirely invisible in source: the play button's handler
  // calls _render(), which replaces the button's innerHTML, so the <svg> that
  // WAS the click target is detached before the event reaches the row. A
  // detached node has no parent chain, so closest() finds nothing and the
  // button reads as inert row space. Capture-phase registration prevents it;
  // this asserts the guard behind it too.
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const row = trackRow();
    const it = item('t1');
    const view = new CompactPlayerView(row, it, { queueItems: [it], queueIndex: 0 });
    c.mount(view);
    const orphan = new FakeElement('svg');   // never attached to the row
    row.dispatch('click', { target: orphan });
    await tick();
    assert.equal(c.state, 'idle',
      'a target we cannot place in the row must not be treated as inert space');
  } finally { c.destroy(); }
});

test("the row's own controls and links are not play targets", async () => {
  for (const sel of ['.download-btn', '.track-share', '.track-add', '.progress-range']) {
    const audio = new FakeAudio();
    const c = new PlaybackController({ audio, mediaSession: false });
    try {
      const row = trackRow();
      const it = item('t1');
      c.mount(new CompactPlayerView(row, it, { queueItems: [it], queueIndex: 0 }));
      row.dispatch('click', { target: row.querySelector(sel) });
      await tick();
      assert.equal(c.state, 'idle', `${sel} must not start playback`);
    } finally { c.destroy(); }
  }
});

test('the waveform stays a seek surface, not a play target', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const row = trackRow({ waveform: true });
    const it = item('t1');
    c.mount(new CompactPlayerView(row, it, { queueItems: [it], queueIndex: 0 }));
    const wave = row.querySelector('.ws-wave');
    // Its own handler owns this click; the row handler must keep out of it or
    // a seek would also be a play-from-the-start.
    row.dispatch('click', { target: wave });
    await tick();
    assert.equal(c.state, 'idle', 'the row handler ignores the waveform');
  } finally { c.destroy(); }
});

test('finishing a text selection does not play the row', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const row = trackRow();
    const it = item('t1');
    c.mount(new CompactPlayerView(row, it, { queueItems: [it], queueIndex: 0 }));
    // A long-press select on a phone, or a click-drag on desktop, ends with a
    // click on the row.
    const doc = row.ownerDocument || (row.ownerDocument = {});
    doc.defaultView = { getSelection: () => ({ isCollapsed: false, toString: () => 'Song 1' }) };
    row.dispatch('click', { target: row.querySelector('.track-title') });
    await tick();
    assert.equal(c.state, 'idle', 'selecting a title is not a request to play it');
  } finally { c.destroy(); }
});

test('a bare PlayerView row is a play target too — song pages mount one', async () => {
  // The gap this test exists for: the first version of _onRowClick lived on
  // CompactPlayerView, every test here mounted a CompactPlayerView, and the
  // suite was green while song pages and /songs/ did nothing at all -- they
  // mount `new PlayerView(el, item)` (song-boot.js), which is a row by
  // default. Found by tapping a real song page, not by any assertion.
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const row = trackRow();
    const view = new PlayerView(row, item('t1'));
    assert.equal(view.density, 'compact', 'a bare PlayerView IS a row -- that default is the point');
    c.mount(view);
    row.dispatch('click', { target: row.querySelector('.track-title') });
    await tick();
    assert.equal(c.state, 'playing');
  } finally { c.destroy(); }
});

test('a whole-show recording card is NOT a play target (hero, not a row)', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const card = heroCard();
    const it = item('r1');
    c.mount(new HeroPlayerView(card, it));
    // Several inches of title, badges and description; turning all of it into
    // one button would start a 90-minute file on a stray tap.
    const title = card.querySelector('.rec-title') || card.querySelector('.time-label');
    if (title) {
      card.dispatch('click', { target: title });
      await tick();
    }
    assert.equal(c.state, 'idle');
  } finally { c.destroy(); }
});

test('compact time label shows "elapsed / total"; hero shows elapsed only', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const row = trackRow({ duration: '3:42' });
    const it = item('t1');
    c.mount(new CompactPlayerView(row, it, { queueItems: [it], queueIndex: 0 }));
    c.setQueue([it], { startIndex: 0, autoplay: true });
    await tick();
    audio.duration = 222; audio.currentTime = 61;
    audio.dispatchEvent(new Event('timeupdate'));
    assert.equal(row.querySelector('.time-label.current').textContent, '1:01 / 3:42');

    const card = heroCard();
    const hero = item('full-recording', { kind: 'recording' });
    c.mount(new HeroPlayerView(card, hero));
    c.playSingleton(hero);
    await tick();
    audio.currentTime = 61;
    audio.dispatchEvent(new Event('timeupdate'));
    assert.equal(card.querySelector('.time-label.current').textContent, '1:01',
      'the hero card carries its total in a separate label, so the elapsed one stays bare');
  } finally { c.destroy(); }
});

test('clicking a track row re-asserts the whole show queue (not playSingleton)', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const items = ['t1', 't2', 't3'].map(id => item(id));
    const rows = items.map((it, i) => {
      const row = trackRow({ num: i + 1 });
      c.mount(new CompactPlayerView(row, it, { queueItems: items, queueIndex: i }));
      return row;
    });

    // Hero first, collapsing the queue to a singleton...
    const card = heroCard();
    const hero = item('full-recording', { kind: 'recording' });
    const heroView = new HeroPlayerView(card, hero);
    c.mount(heroView);
    heroView._onPlayClick();
    await tick();
    assert.equal(c.queue.length, 1);

    // ...then a track row click must restore the full queue, not no-op.
    rows[1].querySelector('.play-btn').dispatch('click');
    await tick();
    assert.equal(c.queue.length, 3, 'the row re-asserts its show queue rather than playing an unqueued item');
    assert.equal(c.currentItem.id, 't2');
    c.next();
    await tick();
    assert.equal(c.currentItem.id, 't3', 'auto-advance works in the restored queue');
  } finally { c.destroy(); }
});

test('a hero plays as a singleton and goes inactive when a track queue takes over', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const card = heroCard();
    const hero = item('recording:show-x:complete', { kind: 'recording' });
    c.mount(new HeroPlayerView(card, hero));
    c.playSingleton(hero);
    await tick();
    assert.equal(c.queue.length, 1, 'an active hero is always a queue of one, so prev/next could never apply');
    assert.equal(card.classList.contains('playing'), true);

    c.setQueue(['a', 'b'].map(id => item(id)), { startIndex: 0, autoplay: true });
    await tick();
    assert.equal(card.classList.contains('playing'), false,
      'an unrelated multi-item queue must leave the hero inactive, not make it look playable');
  } finally { c.destroy(); }
});

test('two alternate recording cards stay independently active (unique recording IDs)', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    // Recording IDs must be unique per card: a view decides it is active by
    // comparing currentItem.id to its own, so a shared/blank id would light up
    // every alternate transfer at once.
    const cardA = heroCard(), cardB = heroCard();
    const recA = item('recording:show-x:canonical', { kind: 'recording' });
    const recB = item('recording:show-x:alt-1', { kind: 'recording' });
    c.mount(new HeroPlayerView(cardA, recA));
    c.mount(new HeroPlayerView(cardB, recB));

    cardA.querySelector('.play-btn').dispatch('click');
    await tick();
    assert.equal(cardA.classList.contains('playing'), true);
    assert.equal(cardB.classList.contains('playing'), false, 'only the selected transfer may render as active');

    cardB.querySelector('.play-btn').dispatch('click');
    await tick();
    assert.equal(cardA.classList.contains('playing'), false);
    assert.equal(cardB.classList.contains('playing'), true);
  } finally { c.destroy(); }
});

test('only the active row shows playing state; a superseded row resets', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const items = ['t1', 't2'].map(id => item(id));
    const rows = items.map((it, i) => {
      const row = trackRow({ num: i + 1 });
      c.mount(new CompactPlayerView(row, it, { queueItems: items, queueIndex: i }));
      return row;
    });
    rows[0].querySelector('.play-btn').dispatch('click');
    await tick();
    audio.duration = 222; audio.currentTime = 61;
    audio.dispatchEvent(new Event('timeupdate'));
    assert.equal(rows[0].classList.contains('playing'), true);

    rows[1].querySelector('.play-btn').dispatch('click');
    await tick();
    assert.equal(rows[0].classList.contains('playing'), false, 'the superseded row must clear its playing state');
    assert.equal(rows[1].classList.contains('playing'), true);
    assert.equal(rows[0].querySelector('.time-label.current').textContent, '0:00 / 3:42',
      'a row that stops being active resets its own elapsed time');
  } finally { c.destroy(); }
});

test('a hard load failure marks the active row, not every row', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const items = ['t1', 't2'].map(id => item(id));
    const rows = items.map((it, i) => {
      const row = trackRow({ num: i + 1 });
      c.mount(new CompactPlayerView(row, it, { queueItems: items, queueIndex: i }));
      return row;
    });
    rows[0].querySelector('.play-btn').dispatch('click');
    await tick();
    audio.simulateError();
    assert.equal(rows[0].classList.contains('player-error'), true,
      'the failing row gets an error affordance instead of a permanently stuck spinner');
    assert.equal(rows[1].classList.contains('player-error'), false);
  } finally { c.destroy(); }
});

test('a failed row shows a visible message and offers retry, which reloads the source', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const it = item('t1');
    const row = trackRow();
    c.mount(new CompactPlayerView(row, it, { queueItems: [it], queueIndex: 0 }));
    row.querySelector('.play-btn').dispatch('click');
    await tick();
    audio.simulateError();

    const msg = row.querySelector('.player-error-msg');
    assert.ok(msg, 'the failure must be visible, not just a class nothing styles');
    assert.equal(msg.textContent, 'Playback failed — tap to retry');
    assert.equal(msg.getAttribute('role'), 'status');
    assert.match(row.querySelector('.play-btn').getAttribute('aria-label'), /^Retry /,
      'the button should say what pressing it will actually do');

    const loadsBefore = audio.loadCount;
    row.querySelector('.play-btn').dispatch('click');
    await tick();
    assert.ok(audio.loadCount > loadsBefore,
      'retry must force a fresh load — a media element holding an error will not recover from play() alone');
    assert.equal(c.state, 'playing');
    assert.equal(row.querySelector('.player-error-msg'), null, 'a successful retry clears the message');
  } finally { c.destroy(); }
});

// ── blocked autoplay is not a failure ──────────────────────────────────────
// "Play random tape" navigates to /shows/<slug>/?autoplay=1#track-N, and user
// activation does not survive a navigation — so play() on arrival rejects with
// NotAllowedError on any browser that enforces the policy (iOS Safari always;
// desktop only without media-engagement credit, which is why this reached
// production). It must read as "cued, waiting for a tap", never as a failure.
class BlockingAudio extends FakeAudio {
  play() {
    const err = new Error('play() can only be initiated by a user gesture.');
    err.name = 'NotAllowedError';
    return Promise.reject(err);
  }
}

test('a blocked autoplay cues the row instead of reporting a failure', async () => {
  const audio = new BlockingAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const items = ['t1', 't2'].map(id => item(id));
    const rows = items.map((it, i) => {
      const row = trackRow({ num: i + 1 });
      c.mount(new CompactPlayerView(row, it, { queueItems: items, queueIndex: i }));
      return row;
    });
    // Exactly what player-boot.js's deep-link handler does on arrival.
    c.setQueue(items, { startIndex: 0, autoplay: true });
    await tick();

    assert.equal(c.state, 'error', 'the controller still uses one state for both — the view is what separates them');
    assert.equal(rows[0].classList.contains('player-error'), false,
      'nothing failed, so the row must not take the failure styling');
    assert.equal(rows[0].classList.contains('is-active'), true,
      'the cued track is still the active row — that is what makes it obvious which one is waiting');
    assert.equal(rows[0].querySelector('.player-error-msg'), null);

    const msg = rows[0].querySelector('.player-cue-msg');
    assert.ok(msg, 'the row must say why it is silent rather than just sitting there');
    assert.equal(msg.textContent, 'Tap play to start');
    assert.equal(msg.getAttribute('role'), 'status');
    assert.match(rows[0].querySelector('.play-btn').getAttribute('aria-label'), /^Play /,
      'the button is an ordinary Play, not a Retry — nothing needs retrying');

    assert.equal(rows[1].querySelector('.player-cue-msg'), null, 'only the cued row is marked');
  } finally { c.destroy(); }
});

test('a real failure is still reported as a failure, not a cue', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const it = item('t1');
    const row = trackRow();
    c.mount(new CompactPlayerView(row, it, { queueItems: [it], queueIndex: 0 }));
    row.querySelector('.play-btn').dispatch('click');
    await tick();
    // A native MediaError carries no .name, so it can never be mistaken for a
    // NotAllowedError — the distinguishing check must not swallow it.
    audio.simulateError();
    assert.equal(row.classList.contains('player-error'), true);
    assert.ok(row.querySelector('.player-error-msg'));
    assert.equal(row.querySelector('.player-cue-msg'), null);
  } finally { c.destroy(); }
});

// A block recorded against a DIFFERENT track must not relabel this one — the
// controller clears _lastPlayError only on the next attempt, so the item-id
// guard is the only thing keeping a stale block off an unrelated row.
test('a stale block from another track does not cue the current one', async () => {
  const audio = new BlockingAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const items = ['t1', 't2'].map(id => item(id));
    const rows = items.map((it, i) => {
      const row = trackRow({ num: i + 1 });
      c.mount(new CompactPlayerView(row, it, { queueItems: items, queueIndex: i }));
      return row;
    });
    c.setQueue(items, { startIndex: 0, autoplay: true });
    await tick();
    assert.ok(rows[0].querySelector('.player-cue-msg'), 'precondition: track 1 is the blocked one');

    // Move to track 2 WITHOUT a fresh play attempt clearing the stored error.
    c.setQueue(items, { startIndex: 1, autoplay: false });
    await tick();
    assert.equal(rows[1].querySelector('.player-cue-msg'), null,
      'track 2 never attempted playback — it must not inherit track 1 error');
    assert.equal(rows[0].querySelector('.player-cue-msg'), null,
      'and the row that lost active status clears its message');
  } finally { c.destroy(); }
});

test('inactive rows are not rewritten on every timeupdate tick', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const items = ['t1', 't2'].map(id => item(id));
    const rows = items.map((it, i) => {
      const row = trackRow({ waveform: true, num: i + 1 });
      c.mount(new CompactPlayerView(row, it, { queueItems: items, queueIndex: i, peaks: { p: [0.3, 0.7], d: 222 } }));
      return row;
    });
    rows[0].querySelector('.play-btn').dispatch('click');
    await tick();

    // Count DOM writes on the inactive row across many ticks.
    const inactive = rows[1];
    let writes = 0;
    const timeEl = inactive.querySelector('.time-label.current');
    Object.defineProperty(timeEl, 'textContent', {
      get() { return this._t || ''; },
      set(v) { writes++; this._t = v; },
      configurable: true,
    });
    // Also instrument the play button's icon/aria-label churn — _setPlayState
    // runs unconditionally on every _render() call today, independent of the
    // active-gating that already protects progress/time/canvas above.
    let iconWrites = 0;
    let ariaWrites = 0;
    const btn = inactive.querySelector('.play-btn');
    Object.defineProperty(btn, 'innerHTML', {
      get() { return this._html || ''; },
      set(v) { iconWrites++; this._html = v; },
      configurable: true,
    });
    const realSetAttribute = btn.setAttribute.bind(btn);
    btn.setAttribute = (k, v) => {
      if (k === 'aria-label') ariaWrites++;
      return realSetAttribute(k, v);
    };
    audio.duration = 222;
    for (let i = 0; i < 25; i++) {
      audio.currentTime = i;
      audio.dispatchEvent(new Event('timeupdate'));
    }
    assert.equal(writes, 0,
      'a row that was already inactive must not be rewritten on every tick — with waveforms that meant redrawing its canvas 25 times');
    assert.equal(iconWrites, 0,
      'an inactive row\'s play button icon must not be rewritten on every tick either');
    assert.equal(ariaWrites, 0,
      'an inactive row\'s aria-label must not be rewritten on every tick either');
  } finally { c.destroy(); }
});

test('tapping an INACTIVE waveform starts that row at the tapped position', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const items = ['t1', 't2'].map(id => item(id));
    const rows = items.map((it, i) => {
      const row = trackRow({ waveform: true, num: i + 1 });
      c.mount(new CompactPlayerView(row, it, { queueItems: items, queueIndex: i, peaks: { p: [0.3, 0.7], d: 200 } }));
      return row;
    });
    rows[0].querySelector('.play-btn').dispatch('click');
    await tick();

    // Tap 25% into the second (inactive) row's waveform. The legacy engine gave
    // every row a live WaveSurfer, so this worked; losing it would be a silent
    // regression.
    const wave = rows[1].querySelector('.ws-wave');
    wave._rect = { left: 0, width: 400 };
    audio.duration = 200;
    wave.dispatch('click', { clientX: 100 });
    await tick();
    await tick();

    assert.equal(c.currentItem.id, 't2', 'the tapped row must start playing');
    assert.equal(c.queue.length, 2, 'and its show queue must be re-asserted, not collapsed');
    assert.equal(audio.currentTime, 50, 'and playback lands at the tapped position (25% of 200s)');
  } finally { c.destroy(); }
});

test('range input seeks the active row and never hijacks playback from an inactive one', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const items = ['t1', 't2'].map(id => item(id));
    const views = items.map((it, i) => {
      const row = trackRow({ num: i + 1 });             // no waveform => range seek
      const v = new CompactPlayerView(row, it, { queueItems: items, queueIndex: i });
      c.mount(v);
      return v;
    });
    c.setQueue(items, { startIndex: 0, autoplay: true });
    await tick();
    audio.duration = 200;

    views[0].range.value = 500;                          // half way
    views[0].range.dispatch('input');
    assert.equal(audio.currentTime, 100, 'seeking the active row moves playback');

    const before = audio.currentTime;
    views[1].range.value = 900;
    views[1].range.dispatch('input');
    assert.equal(audio.currentTime, before,
      'dragging an inactive row\'s range must not seek whatever is actually playing');
  } finally { c.destroy(); }
});

test('a waveform row upgrades only when active, wraps the shared element, and tears down', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    wsInstances.length = 0;
    const items = ['t1', 't2'].map(id => item(id));
    const peaks = { p: [0.1, 0.5, 0.9, 0.4], d: 222 };
    const views = items.map((it, i) => {
      const row = trackRow({ waveform: true, num: i + 1 });
      const v = new CompactPlayerView(row, it, { queueItems: items, queueIndex: i, peaks });
      c.mount(v);
      return v;
    });
    assert.equal(wsInstances.length, 0,
      'mounting must NOT build a WaveSurfer per row — that is the legacy behavior being replaced');

    views[0].root.querySelector('.play-btn').dispatch('click');
    await tick();
    assert.equal(wsInstances.length, 1, 'exactly the active row upgrades');
    assert.equal(wsInstances[0].opts.media, audio,
      'the instance must wrap the controller\'s single element, not create a second one');
    assert.equal(wsInstances[0].opts.url, undefined,
      'passing no url is what stops WaveSurfer clearing the src the controller just assigned');

    views[1].root.querySelector('.play-btn').dispatch('click');
    await tick();
    assert.equal(wsInstances[0].destroyed, true, 'the previously active row downgrades');
    assert.equal(wsInstances.length, 2);
    assert.equal(wsInstances[1].destroyed, false);
  } finally { c.destroy(); }
});

// Step 5c-era review finding: _playIndex() calls _notify() (which drives
// _upgradeWave() -> WaveSurfer.create()) BEFORE audio.play(). An unguarded
// construction failure there used to throw all the way back up through
// _notify() and _playIndex(), so audio.play() was never reached -- a
// waveform-rendering problem silently blocked audio. This proves both the
// guard in _upgradeWave() (falls back to the inert canvas, doesn't throw)
// and _notify()'s per-view isolation (one view's exception can't stop
// _playIndex() from reaching play()).
test('a WaveSurfer construction failure does not block audio.play() or leave the row broken', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    wsInstances.length = 0;
    const it = item('t1');
    const row = trackRow({ waveform: true, num: 1 });
    const peaks = { p: [0.1, 0.5, 0.9], d: 200 };
    const view = new CompactPlayerView(row, it, { queueItems: [it], queueIndex: 0, peaks });
    c.mount(view);
    // clientWidth is 0 in this fake DOM (documented above _drawInertWave's
    // real early-return), so the inert-canvas draw itself is out of scope
    // here same as elsewhere in this suite -- just confirm the fallback path
    // is actually taken, not that it visibly draws.
    let drawnFallback = 0;
    view._drawInertWave = () => { drawnFallback++; };

    FakeWaveSurfer.failNext = true;
    // Assert SYNCHRONOUSLY, before any microtask runs: _playIndex() calls
    // _notify() (which fails to build the WaveSurfer here) and THEN
    // audio.play() in the same synchronous call stack, before the click
    // dispatch even returns. Waiting for a tick would let FakeAudio.play()'s
    // queued 'playing' event fire a second, un-failed _notify() and mask
    // exactly the ordering bug this test exists to catch.
    assert.doesNotThrow(() => { row.querySelector('.play-btn').dispatch('click'); },
      'a WaveSurfer construction failure must not escape as an uncaught exception from a click handler');

    assert.equal(audio.paused, false,
      'audio.play() must still be reached even though the waveform failed to construct');
    assert.equal(wsInstances.length, 0, 'no WaveSurfer instance was actually created');
    assert.equal(view._ws, null, 'the view must not hold a half-constructed instance');
    // >= 1, not a fixed count: _upgradeWave()'s own catch draws it once, and
    // _setProgress() (later in the same render) also falls back to it
    // whenever this._ws is null -- both are correct, independent call sites.
    assert.ok(drawnFallback >= 1, 'falls back to drawing the inert waveform instead of showing nothing');

    await tick(); // let the queued 'playing' event settle so destroy() below is clean
  } finally { c.destroy(); }
});

test('waveform tap while paused starts playback first, then seeks (iOS gesture rule)', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    wsInstances.length = 0;
    const it = item('t1');
    const row = trackRow({ waveform: true });
    const view = new CompactPlayerView(row, it, {
      queueItems: [it], queueIndex: 0, peaks: { p: [0.2, 0.8], d: 222 },
    });
    c.mount(view);
    view._onPlayClick();
    await tick();
    c.pause();
    await tick();
    assert.equal(audio.paused, true);

    audio.duration = 200;
    wsInstances[0].emit('interaction', 120);
    await tick();
    assert.equal(audio.paused, false, 'a tap while paused must start playback, not silently drop the seek');
    assert.equal(audio.currentTime, 120, 'and then land on the tapped position');
  } finally { c.destroy(); }
});

// Step 4 review finding #4: the existing "failed peaks fetch" boot test only
// checked that setPeaks() STORED the value — a mutation that dropped the
// draw/upgrade calls entirely still passed it. This tests the actual
// behavior: which of _upgradeWave/_drawInertWave setPeaks() invokes, keyed on
// whether the row happens to be active when the (asynchronous, in the real
// bootstrap) peaks arrive.
test('setPeaks() upgrades an active row and draws nothing on an inactive one — not just stores the value', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const items = ['t1', 't2'].map(id => item(id));
    const views = items.map((it, i) => {
      const row = trackRow({ waveform: true, num: i + 1 });
      // No peaks at construction — mirrors player-boot.js mounting before the
      // peaks fetch resolves.
      const v = new CompactPlayerView(row, it, { queueItems: items, queueIndex: i, peaks: null });
      c.mount(v);
      return v;
    });

    views[0].root.querySelector('.play-btn').dispatch('click');
    await tick(); // views[0] is now the active row; views[1] stays inactive

    let upgraded = 0, drawn = 0;
    views[0]._upgradeWave = () => { upgraded++; };
    views[0]._drawInertWave = () => { drawn++; };
    views[1]._upgradeWave = () => { upgraded++; };
    views[1]._drawInertWave = () => { drawn++; };

    const peaks = { p: [0.1, 0.5, 0.9], d: 200 };
    views[0].setPeaks(peaks);
    assert.equal(views[0].peaks, peaks, 'the value is still stored');
    assert.equal(upgraded, 1, 'the ACTIVE row must upgrade to a real WaveSurfer, not just store peaks');
    assert.equal(drawn, 0);

    // An inactive row's waveform is display:none now (only the active row shows
    // one), so drawing its canvas would be work thrown into a hidden box on
    // every row of a 30-track show. It stores the peaks and draws nothing.
    // This assertion was inverted on 2026-08-20 when active-only waveforms
    // shipped; it previously required drawn === 1.
    views[1].setPeaks(peaks);
    assert.equal(views[1].peaks, peaks, 'the value is still stored');
    assert.equal(drawn, 0, 'an INACTIVE row must NOT draw: its waveform is hidden');
    assert.equal(upgraded, 1, 'still just the one upgrade from the active row');

    // The coverage that mattered is not lost, only moved: the row must still
    // get its waveform when it becomes the active one, using the peaks it
    // stored while hidden.
    const before = upgraded;
    views[1].root.querySelector('.play-btn').dispatch('click');
    await tick();
    // `>` rather than an exact count: _render() runs on every state change, so
    // a row going idle -> loading -> playing legitimately calls _upgradeWave
    // more than once. What matters is that a row which drew nothing while
    // hidden gets its waveform on becoming active.
    assert.ok(upgraded > before, 'the row upgrades once it becomes active, from the peaks it stored');
    // Deliberately no assertion on `drawn` here: with _upgradeWave stubbed out,
    // the now-active row legitimately falls back to painting its inert canvas
    // (that is the real WaveSurfer-unavailable path). The claim under test is
    // that nothing draws while a row is HIDDEN, which the assertion above the
    // click already makes.
  } finally { c.destroy(); }
});

test('unmount detaches the view so later controller updates cannot touch its DOM', async () => {
  const audio = new FakeAudio();
  const c = new PlaybackController({ audio, mediaSession: false });
  try {
    const it = item('t1');
    const row = trackRow();
    const view = new CompactPlayerView(row, it, { queueItems: [it], queueIndex: 0 });
    c.mount(view);
    c.setQueue([it], { startIndex: 0, autoplay: true });
    await tick();
    assert.equal(row.classList.contains('playing'), true);

    c.unmount(view);
    const labelBefore = row.querySelector('.play-btn').getAttribute('aria-label');
    c.pause();
    await tick();
    assert.equal(row.querySelector('.play-btn').getAttribute('aria-label'), labelBefore,
      'an unmounted view must stop receiving updates');
  } finally { c.destroy(); }
});

// ── runner ─────────────────────────────────────────────────────────────────
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
