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

// ── minimal DOM ────────────────────────────────────────────────────────────
// Just enough of the DOM surface the views touch. Building this by hand
// (rather than pulling in jsdom) keeps the project dependency-free, matching
// how the rest of these scripts work.
class FakeClassList {
  constructor() { this._set = new Set(); }
  add(...c) { c.forEach(x => this._set.add(x)); }
  remove(...c) { c.forEach(x => this._set.delete(x)); }
  contains(c) { return this._set.has(c); }
  toggle(c, force) {
    const want = force === undefined ? !this._set.has(c) : !!force;
    if (want) this._set.add(c); else this._set.delete(c);
    return want;
  }
}

class FakeElement {
  constructor(tag, classes = [], attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.classList = new FakeClassList();
    classes.forEach(c => this.classList.add(c));
    this.dataset = {};
    this.attributes = {};
    this.children = [];
    this.style = {};
    this.innerHTML = '';
    this.textContent = '';
    this.hidden = false;
    this.value = 0;
    this.clientWidth = 0;           // 0 => inert-canvas draw is skipped (no layout in Node)
    this._listeners = {};
    Object.assign(this, attrs);
  }
  // Real DOM keeps className and classList in sync; the views set className on
  // elements they create, and querySelector then has to find them by class.
  get className() { return [...this.classList._set].join(' '); }
  set className(v) {
    this.classList._set = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  appendChild(el) { this.children.push(el); el._parent = this; return el; }
  remove() {
    if (!this._parent) return;
    const i = this._parent.children.indexOf(this);
    if (i !== -1) this._parent.children.splice(i, 1);
    this._parent = null;
  }
  // Views measure the waveform to turn a click into a position. Node has no
  // layout, so tests set _rect explicitly on the elements they click.
  getBoundingClientRect() { return this._rect || { left: 0, width: 0, top: 0, height: 0 }; }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  dispatch(type, evt = {}) { (this._listeners[type] || []).forEach(fn => fn(evt)); }
  querySelector(sel) { return this._find(sel); }
  querySelectorAll(sel) { return this._findAll(sel); }
  _matches(sel) {
    if (sel.startsWith('[data-act=')) {
      const want = sel.slice('[data-act="'.length, -2);
      return this.dataset.act === want;
    }
    return sel.split('.').filter(Boolean).every(c => this.classList.contains(c));
  }
  _findAll(sel) {
    const out = [];
    for (const c of this.children) {
      if (c._matches(sel)) out.push(c);
      out.push(...c._findAll(sel));
    }
    return out;
  }
  _find(sel) { return this._findAll(sel)[0] || null; }
}

// Globals player-views.js reads at module load.
globalThis.document = {
  documentElement: {},
  createElement: (tag) => new FakeElement(tag),
  querySelectorAll: () => [],
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.window = { devicePixelRatio: 1 };

// The views import WaveSurfer from an absolute /assets/ URL that only resolves
// in the browser; stub the module so this file can import them in Node.
const wsInstances = [];
class FakeWaveSurfer {
  static create(opts) { const ws = new FakeWaveSurfer(opts); wsInstances.push(ws); return ws; }
  constructor(opts) { this.opts = opts; this.destroyed = false; this._on = {}; }
  on(evt, fn) { (this._on[evt] ||= []).push(fn); }
  emit(evt, arg) { (this._on[evt] || []).forEach(fn => fn(arg)); }
  destroy() { this.destroyed = true; }
}
// The views import from absolute /assets/ URLs that only resolve in the
// browser. Rewrite those two specifiers to what Node can resolve — the real
// controller by absolute file: URL, and the WaveSurfer stub above — then
// import the result as a data: URL. (Relative specifiers can't be used here:
// a data: URL has no hierarchical base to resolve them against.)
const viewsSrc = (await import('node:fs')).readFileSync(
  new URL('./player-views.js', import.meta.url), 'utf8');
const controllerUrl = new URL('./player-controller.js', import.meta.url).href;
const stubbed = viewsSrc
  .replace("import WaveSurfer from '/assets/wavesurfer.esm.js';",
    'const WaveSurfer = globalThis.__FakeWaveSurfer;')
  .replace("from '/assets/player-controller.js';", `from '${controllerUrl}';`);
globalThis.__FakeWaveSurfer = FakeWaveSurfer;
const viewsUrl = 'data:text/javascript;base64,' + Buffer.from(stubbed).toString('base64');
const { CompactPlayerView, HeroPlayerView, itemFromRowElement } = await import(viewsUrl);

// ── fixtures mirroring the real generated markup ───────────────────────────
function trackRow({ waveform = false, num = 1, duration = '3:42' } = {}) {
  const row = new FakeElement('div', ['track-row', waveform ? 'ws-track' : 'custom-player']);
  const btn = new FakeElement('button', ['play-btn']);
  btn.dataset.playLabel = `Song ${num}, Jerry Hannan, 1999-05-27`;
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

class FakeAudio extends EventTarget {
  constructor() {
    super();
    this.preload = ''; this._src = ''; this.currentTime = 0; this.duration = NaN;
    this.paused = true; this.error = null; this.playbackRate = 1;
  }
  get src() { return this._src; }
  set src(v) { this._src = v; this.error = null; this.loadCount = (this.loadCount || 0) + 1; }
  load() { this.error = null; }
  play() {
    this.paused = false;
    queueMicrotask(() => { this.dispatchEvent(new Event('play')); this.dispatchEvent(new Event('playing')); });
    return Promise.resolve();
  }
  pause() { if (this.paused) return; this.paused = true; this.dispatchEvent(new Event('pause')); }
  simulateError(code = 4) { this.error = { code }; this.dispatchEvent(new Event('error')); }
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
    audio.duration = 222;
    for (let i = 0; i < 25; i++) {
      audio.currentTime = i;
      audio.dispatchEvent(new Event('timeupdate'));
    }
    assert.equal(writes, 0,
      'a row that was already inactive must not be rewritten on every tick — with waveforms that meant redrawing its canvas 25 times');
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
