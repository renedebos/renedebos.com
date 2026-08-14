// Deterministic tests for the show-page bootstrap (player-boot.js), Phase 1
// Step 4 of plans/player-consolidation/.
//
// What matters here is the engine handshake, not rendering: the module has to
// mount one controller over the real generated markup shapes and set
// PLAYER_ENGINE_MOUNTED *synchronously*, because the two legacy engines check
// that flag at DOMContentLoaded and take over if it's unset. Every test below
// imports player-boot.js afresh against a fake document — importing it IS
// running the bootstrap, which is the behavior under test.
//
// Not covered (needs a real browser, stays on the manual checklist): actual
// module-loading failure, canvas/WaveSurfer rendering, real media, layout.
//
// Run: node scripts/test-player-boot.mjs

import assert from 'node:assert/strict';
import {
  FakeElement, FakeDocument, FakeWindow, FakeAudio, loadPlayerBoot,
} from './test-fake-dom.mjs';

globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
// Every controller builds its own `new Audio()`; keeping the instances lets a
// test prove that a torn-down boot really is inert (nothing ever loads).
const audios = [];
globalThis.Audio = class extends FakeAudio {
  constructor() { super(); audios.push(this); }
};

// ── fixtures mirroring build_show()'s generated markup ─────────────────────
function trackRow(num, itemOverride) {
  const row = new FakeElement('div', ['track-row', 'ws-track']);
  row.id = `track-${num}`;
  row.dataset.trackid = String(num);
  row.dataset.src = `https://example.test/t${num}.mp3`;
  row.dataset.item = itemOverride !== undefined ? itemOverride : JSON.stringify({
    id: `show-0${num}`,
    kind: 'track',
    streamUrl: `https://example.test/t${num}.mp3`,
    title: `Song ${num}`,
    playLabel: `Song ${num}, Jerry Hannan, 1999-05-27`,
    durationSec: 222,
    peaksKey: String(num),
  });
  const btn = new FakeElement('button', ['play-btn']);
  btn.dataset.playLabel = `Song ${num}, Jerry Hannan, 1999-05-27`;
  row.appendChild(btn);
  row.appendChild(new FakeElement('span', ['track-num']));
  row.appendChild(new FakeElement('div', ['ws-wave']));
  const time = new FakeElement('span', ['time-label', 'current']);
  time.dataset.duration = '3:42';
  row.appendChild(time);
  return row;
}

function heroCard(n, malformed = false) {
  const card = new FakeElement('div', ['recording-item']);
  card.dataset.item = malformed ? '{not json' : JSON.stringify({
    id: `recording:show:hannans/full-${n}.flac`,
    kind: 'recording',
    streamUrl: `https://example.test/full-${n}.mp3`,
    title: n === 1 ? 'Complete show' : `Part ${n}`,
    playLabel: 'Complete show, Jerry Hannan, 1999-05-27',
  });
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

function showDoc({ rows = 3, heroes = 1, badRow = -1, badHero = false } = {}) {
  const doc = new FakeDocument();
  const main = new FakeElement('main');
  const list = new FakeElement('div', ['track-list']);
  for (let n = 1; n <= rows; n++) list.appendChild(trackRow(n, n === badRow ? '{not json' : undefined));
  main.appendChild(list);
  const recList = new FakeElement('div', ['recording-list']);
  for (let n = 1; n <= heroes; n++) recList.appendChild(heroCard(n, badHero && n === heroes));
  main.appendChild(recList);
  doc.appendChild(main);
  return doc;
}

// Installs the globals player-boot.js reads, then imports it — which runs the
// bootstrap. Returns everything a test needs to poke at afterwards.
async function boot({ rows = 3, heroes = 1, flag = true, hash = '', search = '',
                      peaksUrl = null, peaks = {}, peaksFail = false, badRow = -1,
                      badHero = false, holdPeaks = false } = {}) {
  const doc = showDoc({ rows, heroes, badRow, badHero });
  const win = new FakeWindow({ hash, search });
  if (flag) win.PLAYER_ENGINE = 'controller';
  if (peaksUrl) win.WS_PEAKS_URL = peaksUrl;
  globalThis.document = doc;
  globalThis.window = win;
  const body = { json: () => Promise.resolve(peaks) };
  // holdPeaks keeps the response pending until the test releases it — the only
  // way to observe the window between "mounted" and "peaks applied", since
  // awaiting the import alone drains every already-resolved microtask.
  let release = () => {};
  globalThis.fetch = () => {
    if (peaksFail) return Promise.reject(new Error('offline'));
    if (!holdPeaks) return Promise.resolve(body);
    return new Promise(res => { release = () => res(body); });
  };
  await loadPlayerBoot();
  return {
    doc, win, release,
    handle: win.PLAYER_BOOT,
    c: win.PLAYER_BOOT && win.PLAYER_BOOT.controller,
  };
}

const tick = () => new Promise(r => setTimeout(r, 0));
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── tests ──────────────────────────────────────────────────────────────────
test('mounts one controller over every row and hero card, and claims the page', async () => {
  const { win, handle, c } = await boot({ rows: 3, heroes: 2 });
  try {
    assert.equal(win.PLAYER_ENGINE_MOUNTED, true,
      'the legacy engines stay dormant only if this flag is set');
    assert.equal(handle.views.length, 5, '3 track rows + 2 hero cards');
    assert.equal(handle.rowViews.length, 3);
    assert.equal(handle.rowItems.length, 3);
    assert.deepEqual(handle.rowItems.map(i => i.id), ['show-01', 'show-02', 'show-03'],
      'the queue is the track list in DOM order');
  } finally { c.destroy(); }
});

test('the mounted flag is set synchronously, before the peaks fetch resolves', async () => {
  // Load-bearing: the legacy engines check this flag at DOMContentLoaded, which
  // fires before any fetch can land. A bootstrap that waited for peaks would
  // lose the handshake and end up double-initialized.
  const { win, handle, c, release } = await boot({
    peaksUrl: '/assets/peaks/x.json', peaks: { 1: { p: [1], d: 100 } }, holdPeaks: true });
  try {
    assert.equal(win.PLAYER_ENGINE_MOUNTED, true);
    assert.equal(handle.rowViews[0].peaks, null, 'peaks have not landed yet');
    release();
    await tick();
    assert.equal(handle.rowViews[0].peaks.d, 100, 'and land afterwards');
  } finally { c.destroy(); }
});

test('a failed peaks fetch still hands every waveform row an empty peaks object', async () => {
  // Parity with wavesurfer.js's own build({}) fallback: with an empty object a
  // row still upgrades to a WaveSurfer that decodes the audio to draw, so it
  // keeps its waveform and its only seek surface. Left null it would have
  // neither — a .ws-track row has no range input.
  const { handle, c } = await boot({ peaksUrl: '/assets/peaks/x.json', peaksFail: true });
  try {
    await tick();
    handle.rowViews.forEach(v => assert.deepEqual(v.peaks, {}));
  } finally { c.destroy(); }
});

test('a malformed row aborts the whole boot, leaving the flag unset for the legacy engine', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const { win, doc } = await boot({ rows: 3, badRow: 2 });
    assert.equal(win.PLAYER_ENGINE_MOUNTED, undefined,
      'a half-mounted engine must not claim the page');
    assert.equal(win.PLAYER_BOOT, undefined);
    // Whatever was mounted before the failure has been detached, so the markup
    // is inert and safe for the legacy engine to wire up from scratch. Rows 1
    // and 2 DID mount before row 2's item threw; clicking one must not load
    // anything, or the page would end up with two engines fighting over it.
    const first = doc.querySelectorAll('.track-list [data-item]')[0];
    first.querySelector('.play-btn').dispatch('click');
    await tick();
    assert.equal(audios[audios.length - 1].src, '',
      'a torn-down boot must leave nothing that can still start playback');
  } finally { console.error = quiet; }
});

test('a failure AFTER some views mounted tears those views back down', async () => {
  // The rows mount fine and only the hero card's item is malformed, so this is
  // the partial-mount path: without the teardown in bootShowPage's catch, three
  // live row views would survive a boot that never set the flag — and the
  // legacy engine would then wire the same rows a second time.
  const quiet = console.error;
  console.error = () => {};
  try {
    const { win, doc } = await boot({ rows: 3, heroes: 1, badHero: true });
    assert.equal(win.PLAYER_ENGINE_MOUNTED, undefined);
    doc.querySelectorAll('.track-list [data-item]')[0].querySelector('.play-btn').dispatch('click');
    await tick();
    assert.equal(audios[audios.length - 1].src, '',
      'the rows that did mount must no longer be able to start playback');
  } finally { console.error = quiet; }
});

test('a page without the engine flag is never claimed', async () => {
  const { win } = await boot({ flag: false });
  assert.equal(win.PLAYER_ENGINE_MOUNTED, undefined);
  assert.equal(win.PLAYER_BOOT, undefined);
});

test('clicking a row plays it and re-asserts the whole show queue', async () => {
  const { doc, c } = await boot({ rows: 4 });
  try {
    doc.querySelectorAll('.track-list [data-item]')[2].querySelector('.play-btn').dispatch('click');
    await tick();
    assert.equal(c.currentIndex, 2);
    assert.equal(c.queue.length, 4, 'a row click queues the whole show, not just itself');
    assert.equal(c.currentItem.id, 'show-03');
    assert.equal(c.state, 'playing');
  } finally { c.destroy(); }
});

test('hero -> row -> next: the hero collapses the queue and a row click restores it', async () => {
  const { doc, c } = await boot({ rows: 4, heroes: 1 });
  try {
    doc.querySelector('.recording-item[data-item]').querySelector('.play-btn').dispatch('click');
    await tick();
    assert.equal(c.queue.length, 1, 'the hero plays as a singleton');
    assert.equal(c.currentItem.kind, 'recording');

    doc.querySelectorAll('.track-list [data-item]')[1].querySelector('.play-btn').dispatch('click');
    await tick();
    assert.equal(c.queue.length, 4, 'the row re-asserts the show queue rather than dying unqueued');
    assert.equal(c.currentIndex, 1);

    c.next();
    await tick();
    assert.equal(c.currentItem.id, 'show-03');
  } finally { c.destroy(); }
});

test('Space toggles whatever is active, and keeps its hands off form fields', async () => {
  const { doc, c } = await boot();
  try {
    doc.querySelectorAll('.track-list [data-item]')[0].querySelector('.play-btn').dispatch('click');
    await tick();
    assert.equal(c.state, 'playing');

    let prevented = 0;
    doc.dispatch('keydown', { code: 'Space', preventDefault: () => { prevented++; } });
    await tick();
    assert.equal(c.state, 'paused', 'Space reaches a waveform row — the legacy handler could not');
    assert.equal(prevented, 1);

    doc.activeElement = new FakeElement('input');
    doc.dispatch('keydown', { code: 'Space', preventDefault: () => { prevented++; } });
    await tick();
    assert.equal(c.state, 'paused', 'Space in a text field must not reach the player');
    assert.equal(prevented, 1, 'and must not swallow the keystroke either');
  } finally { c.destroy(); }
});

test('Space is inert with nothing loaded', async () => {
  const { doc, c } = await boot();
  try {
    doc.dispatch('keydown', { code: 'Space', preventDefault: () => {} });
    await tick();
    assert.equal(c.state, 'idle');
    assert.equal(c.currentIndex, -1);
  } finally { c.destroy(); }
});

test('?autoplay=1#track-N starts that row inside the full queue on load', async () => {
  const { doc, win, c } = await boot({ rows: 4, hash: '#track-3', search: '?autoplay=1' });
  try {
    win.dispatch('load');
    await tick();
    const row = doc.querySelector('#track-3');
    assert.equal(row.classList.contains('target'), true);
    assert.equal(row.scrolledIntoView, true);
    assert.equal(c.currentIndex, 2);
    assert.equal(c.queue.length, 4, 'a deep link still gets the whole show queued behind it');
  } finally { c.destroy(); }
});

test('a later hashchange re-targets but never autoplays', async () => {
  // Exact parity with today: player.js's focusHashTrack never autoplays a
  // waveform row, and wavesurfer.js only reads the hash once, at build time.
  const { doc, win, c } = await boot({ rows: 4, hash: '#track-3', search: '?autoplay=1' });
  try {
    win.dispatch('load');
    await tick();
    assert.equal(c.currentIndex, 2);

    win.location.hash = '#track-1';
    win.dispatch('hashchange');
    await tick();
    assert.equal(doc.querySelector('#track-1').classList.contains('target'), true);
    assert.equal(doc.querySelector('#track-3').classList.contains('target'), false,
      'the previous deep-link highlight is cleared');
    assert.equal(c.currentIndex, 2, 'the newly hashed row must not start playing');
  } finally { c.destroy(); }
});

test('a hash pointing at something that is not a track row is ignored', async () => {
  const { win, c } = await boot({ hash: '#technical-data', search: '?autoplay=1' });
  try {
    win.dispatch('load');
    await tick();
    assert.equal(c.currentIndex, -1);
  } finally { c.destroy(); }
});

test('a window resize redraws inert waveforms', async () => {
  const { win, handle, c } = await boot({ peaksUrl: '/assets/peaks/x.json', peaks: { 1: { p: [1, 2], d: 9 } } });
  try {
    await tick();
    let redrawn = 0;
    handle.views.forEach(v => { v.redrawWave = () => { redrawn++; }; });
    win.dispatch('resize');
    await new Promise(r => setTimeout(r, 200));
    assert.equal(redrawn, handle.views.length);
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
    console.error('       ' + (err && err.stack ? err.stack : err));
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
