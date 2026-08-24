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
  FakeElement, FakeDocument, FakeWindow, FakeAudio, loadPlayerBoot, readScript,
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
  // The number is the button's ::before now (site.css), not a sibling
  // span -- data-num is the whole of it in the markup.
  btn.setAttribute('data-num', String(num).padStart(2, '0'));
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
                      badHero = false, holdPeaks = false, pageAutoplay = false } = {}) {
  const doc = showDoc({ rows, heroes, badRow, badHero });
  const win = new FakeWindow({ hash, search });
  if (flag) win.PLAYER_ENGINE = 'controller';
  if (peaksUrl) win.WS_PEAKS_URL = peaksUrl;
  // The single-song share page's "this page exists to play one thing" flag
  // (plans/share/track-share-plan.md §9.1) -- set by build_track_page().
  if (pageAutoplay) win.PLAYER_AUTOPLAY = true;
  globalThis.document = doc;
  globalThis.window = win;
  // Readiness-contract resolution (plans/dynamic-hugging-rossum.md) — a test
  // reads `readiness` after dispatching 'load' to see what player-boot.js
  // resolved window.PLAYBACK_HOST_READY to.
  let readiness = null;
  win.__resolvePlaybackHost = (v) => { readiness = v; };
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
    readiness: () => readiness,
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

test('one row throwing from setPeaks does not skip/downgrade the others or leak an unhandled rejection', async () => {
  // Eighth review, finding #2: attachPeaks's apply() used to run every
  // view's setPeaks() inside a single Array.prototype.forEach with no
  // per-view isolation. A throw from any one view aborted the whole pass
  // (views after it in iteration order never got decorated), and the outer
  // .catch(() => apply({})) then retried the ENTIRE loop with an empty map —
  // downgrading views that had already been correctly decorated on the first
  // pass. If the same view threw again on retry, the promise rejected with
  // nothing left to catch it.
  const quiet = console.error;
  console.error = () => {};
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const { doc, handle, c, release } = await boot({
      rows: 3,
      peaksUrl: '/assets/peaks/x.json',
      peaks: { 1: { p: [1], d: 100 }, 2: { p: [2], d: 200 }, 3: { p: [3], d: 300 } },
      holdPeaks: true,
    });
    try {
      // Patch AFTER mount, BEFORE the fetch resolves — holdPeaks is exactly
      // what makes that window observable.
      handle.rowViews[1].setPeaks = () => { throw new Error('setPeaks boom'); };

      release();
      // The microtask queue needs more than one drain to fully propagate a
      // rejection through fetch().then().then().catch() — one tick may not
      // be enough.
      await tick();
      await tick();

      assert.equal(unhandled.length, 0,
        'a bad row must never surface as an unhandled rejection on an already-claimed page');
      assert.equal(handle.rowViews[0].peaks.d, 100,
        'the row BEFORE the throwing one must still get its real peaks');
      assert.equal(handle.rowViews[2].peaks.d, 300,
        'the row AFTER the throwing one must still get its real peaks, not be skipped by the abort or downgraded by a retry-from-scratch');

      doc.querySelectorAll('.track-list [data-item]')[0].querySelector('.play-btn').dispatch('click');
      await tick();
      assert.equal(c.state, 'playing',
        'the controller must stay fully usable despite one row failing decoration');
    } finally { c.destroy(); }
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    console.error = quiet;
  }
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

// ── window.PLAYER_AUTOPLAY: the single-song share page (/t/{code}) ────────
// plans/share/track-share-plan.md §9.1. A shared link is deliberately clean --
// no ?autoplay=1, no #track-N -- so the deep-link path can never fire for it
// and the page declares the intent instead.

test('PLAYER_AUTOPLAY starts row 0 on a page with no hash and no query', async () => {
  const { win, c } = await boot({ rows: 1, heroes: 0, pageAutoplay: true });
  try {
    win.dispatch('load');
    await tick();
    assert.equal(c.currentIndex, 0);
    assert.equal(c.queue.length, 1, 'a share page queues exactly the song that was shared');
  } finally { c.destroy(); }
});

test('a deep link still wins over PLAYER_AUTOPLAY -- no double start', async () => {
  // Belt and braces: build_track_page() emits no hash, but a page carrying
  // both must not start twice or start the wrong row.
  const { win, c } = await boot({ rows: 4, hash: '#track-3', search: '?autoplay=1',
                                  pageAutoplay: true });
  try {
    win.dispatch('load');
    await tick();
    assert.equal(c.currentIndex, 2, 'the deep-linked row, not row 0');
  } finally { c.destroy(); }
});

test('PLAYER_AUTOPLAY reports initialIntent "autoplay" to the readiness contract', async () => {
  const { win, c, readiness } = await boot({ rows: 1, heroes: 0, pageAutoplay: true });
  try {
    win.dispatch('load');
    await tick();
    assert.equal(readiness().initialIntent, 'autoplay',
      'a page that started itself must say so, or the bar mis-reads its own state');
  } finally { c.destroy(); }
});

test('without the flag nothing starts -- ordinary show pages are unaffected', async () => {
  const { win, c } = await boot({ rows: 3 });
  try {
    win.dispatch('load');
    await tick();
    assert.equal(c.currentIndex, -1);
    assert.equal(c.state, 'idle');
  } finally { c.destroy(); }
});

// ── readiness contract (Phase 3 Stage 3a-foundation) ─────────────────────
// Show pages resolve PLAYBACK_HOST_READY only AFTER the deep-link/autoplay
// decision, on window.load — not at mount time — specifically so a future
// mini-player can't start restoring a persisted session before that
// decision is made and race it. This is the ordering the plan's round 3
// correction exists for.
test('readiness resolves to controller/autoplay when a deep link actually autoplayed', async () => {
  const { win, readiness } = await boot({ rows: 4, hash: '#track-3', search: '?autoplay=1' });
  try {
    assert.equal(readiness(), null, 'must not resolve before window.load — the deep-link decision has not happened yet');
    win.dispatch('load');
    await tick();
    assert.ok(readiness(), 'must resolve once window.load has run');
    assert.equal(readiness().mode, 'controller');
    assert.equal(readiness().initialIntent, 'autoplay');
    assert.equal(readiness().controller, win.PLAYER_BOOT.controller);
  } finally { win.PLAYER_BOOT.controller.destroy(); }
});

test('readiness resolves to controller/none when there is no deep link at all', async () => {
  const { win, readiness } = await boot({ rows: 4 });
  try {
    win.dispatch('load');
    await tick();
    assert.equal(readiness().mode, 'controller');
    assert.equal(readiness().initialIntent, 'none', 'nothing page-specific happened -- a future mini-player restore is safe');
  } finally { win.PLAYER_BOOT.controller.destroy(); }
});

test('readiness resolves to controller/none for a hash present but without ?autoplay=1 (highlight-only deep link)', async () => {
  const { win, readiness } = await boot({ rows: 4, hash: '#track-2' }); // no ?autoplay=1
  try {
    win.dispatch('load');
    await tick();
    assert.equal(readiness().initialIntent, 'none', 'highlighting a row is not the same as a real autoplay request');
  } finally { win.PLAYER_BOOT.controller.destroy(); }
});

test('readiness resolves to legacy on a mount failure (in-script throw), independent of the later DOMContentLoaded fallback trigger', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const { win, readiness } = await boot({ rows: 3, badRow: 2 });
    assert.equal(win.PLAYER_ENGINE_MOUNTED, undefined);
    assert.ok(readiness(), 'must resolve immediately from the auto-run catch block, not wait for player.js\'s separate DOMContentLoaded listener');
    assert.equal(readiness().mode, 'legacy');
  } finally { console.error = quiet; }
});

test('a page without the engine flag never touches PLAYBACK_HOST_READY at all (nothing to resolve — that page\'s readiness snippet already resolved "legacy" itself, at build time)', async () => {
  const { readiness } = await boot({ flag: false });
  assert.equal(readiness(), null, 'player-boot.js never even runs its auto-run block on a non-flagged page');
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

// attachMiniPlayer() pushes a MiniPlayerView into handle.views, and that class
// descends from QueueView -- no waveform, so no redrawWave(). Every resize on a
// real show page threw "v.redrawWave is not a function" once the bar's dynamic
// import had landed (reported 2026-08-23).
//
// Two reasons this suite could not see it, both worth naming: showDoc() renders
// no #mini-player, so no bar is ever pushed here; and the test above assigns
// redrawWave onto EVERY view before dispatching, manufacturing the very method
// it should have been checking for. This case models the real, heterogeneous
// array instead, and puts the method-less view FIRST so a regression both
// throws and visibly starves every row behind it.
test('a resize survives a view with no redrawWave (the mini-player bar)', async () => {
  const { win, handle, c } = await boot({ peaksUrl: '/assets/peaks/x.json', peaks: { 1: { p: [1, 2], d: 9 } } });
  const thrown = [];
  const onUncaught = (e) => thrown.push(e);
  // The throw happens inside wireResize's setTimeout, so it surfaces as an
  // uncaught exception rather than anything assert could see -- without this it
  // would take the whole run down instead of failing one case.
  process.on('uncaughtException', onUncaught);
  try {
    await tick();
    let redrawn = 0;
    handle.views.forEach(v => { v.redrawWave = () => { redrawn++; }; });
    handle.views.unshift({ root: {}, onControllerUpdate() {} });
    win.dispatch('resize');
    await new Promise(r => setTimeout(r, 200));
    assert.deepEqual(thrown.map(e => e.message), [],
      'a view without redrawWave must be skipped, never thrown on');
    assert.equal(redrawn, handle.views.length - 1,
      'every wave-bearing view still redraws, including the ones behind the bar');
  } finally {
    process.off('uncaughtException', onUncaught);
    c.destroy();
  }
});

// Step 4 review finding #1: a destroyed boot must actually stay destroyed.
// The controller's own _destroyed guards (player-controller.js) and the boot's
// listener teardown (the shared AbortController in player-boot.js) are two
// separate fixes for the same bug — either alone would have masked the other
// not existing, so each gets its own case.
// All three below call handle.destroy() — the real public teardown entry
// point (window.PLAYER_BOOT.destroy() on a real page) — deliberately NOT
// c.destroy() (the raw controller). Calling the controller directly would
// leave player-boot.js's own AbortController untouched and let the
// controller's _destroyed guards silently backstop the very listener leak
// these tests exist to catch — which is exactly what happened while writing
// this test the first time: the resize case failed until it was corrected to
// call handle.destroy(), proving the distinction matters.
test('destroy() stops a leaked Space listener from restarting playback', async () => {
  const { doc, handle, c } = await boot({ rows: 1 });
  doc.querySelectorAll('.track-list [data-item]')[0].querySelector('.play-btn').dispatch('click');
  await tick();
  assert.equal(c.state, 'playing');

  handle.destroy();
  assert.equal(c.audioElement.paused, true);

  // wireKeyboard's listener on `doc` is document-scoped, not controller-scoped
  // — it outlives destroy() unless something explicitly removes it. This
  // proves it no longer reaches the controller.
  doc.dispatch('keydown', { code: 'Space', preventDefault: () => {} });
  await tick();
  assert.equal(c.audioElement.paused, true,
    'a leaked keyboard listener must not be able to restart a destroyed controller');
});

test('destroy() stops a leaked hashchange/load listener from queuing playback', async () => {
  const { doc, win, handle, c } = await boot({ rows: 2 });
  handle.destroy();

  win.location.hash = '#track-1';
  win.location.search = '?autoplay=1';
  win.dispatch('load');
  win.dispatch('hashchange');
  await tick();
  assert.equal(c.currentIndex, -1,
    'a leaked deep-link listener must not be able to queue/play on a destroyed controller');
});

test('destroy() stops a leaked resize listener from touching torn-down views', async () => {
  const { win, handle, c } = await boot({ peaksUrl: '/assets/peaks/x.json', peaks: { 1: { p: [1], d: 9 } } });
  await tick();
  let redrawn = 0;
  handle.views.forEach(v => { v.redrawWave = () => { redrawn++; }; });
  handle.destroy();

  win.dispatch('resize');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(redrawn, 0, 'a leaked resize listener must not fire after destroy()');
});

test('the controller itself refuses to be driven after destroy(), independent of player-boot.js', async () => {
  // Same property, proven directly against PlaybackController — belt-and-
  // braces with the boot-level tests above, since either fix alone (the
  // controller's guards, or the boot's listener teardown) would have hidden
  // the other one being missing.
  const { c } = await boot({ rows: 1 });
  c.destroy();
  c.play(0);
  c.toggle();
  c.setQueue([{ id: 'x', streamUrl: 'https://example.test/x.mp3', title: 'X' }], { startIndex: 0, autoplay: true });
  await tick();
  assert.equal(c.audioElement.paused, true);
  assert.equal(c.currentIndex, -1);
});

// Step 4 review finding #2: a page where the row/hero selectors find nothing
// must not claim itself. Not just a defensive instinct — verify_markup.py's
// new check_every_row_has_item() only runs at build time; this is the runtime
// backstop for the same invariant (e.g. a hand-edited or corrupted page that
// never went through build.py).
test('a page with no playable rows or recording cards refuses to claim itself', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const { win } = await boot({ rows: 0, heroes: 0 });
    assert.equal(win.PLAYER_ENGINE_MOUNTED, undefined,
      'an empty mount must not set the flag — nothing here for the controller to own');
    assert.equal(win.PLAYER_BOOT, undefined);
  } finally { console.error = quiet; }
});

test('mount() on an already-destroyed controller is inert, not a live view', async () => {
  const { c } = await boot({ rows: 1 });
  c.destroy();
  let attached = false;
  const fakeView = { onAttach() { attached = true; }, onDetach() {} };
  const unmount = c.mount(fakeView);
  assert.equal(attached, false, 'mount() must not attach a view to a destroyed controller');
  unmount(); // must not throw
});

// ── player.js's own gate, executed for real (Step 4 review finding #4) ─────
// Every test above exercises player-boot.js/player-views.js/player-controller.js
// — none of them ever loads player.js, so a regression that deleted its
// engine-selection gate entirely would leave the whole suite green (proven by
// mutation-checking while applying this review's fixes). This runs player.js's
// REAL source — not a reimplementation of what it's supposed to do — against a
// fake DOM, sliced just before the "── downloads" section: everything the gate
// itself needs (the BroadcastChannel block, initCustomPlayers,
// initLegacySpaceBar, initLegacyDeepLink, the gate) is above that marker: the
// download-modal/toast/tooltip code below it calls document.getElementById()
// against raw innerHTML strings our fake DOM doesn't parse, and is unrelated
// to what's under test here. wavesurfer.js shares the identical gate pattern
// (its own comment says so) and isn't separately covered — the review offered
// "player.js OR wavesurfer.js" as sufficient, and player.js is on every page.
function playerJsGateSource() {
  const full = readScript('player.js');
  const downloadsStart = full.indexOf('// ── downloads');
  const deepLinkStart = full.indexOf('// ── deep-link to a track ──');
  assert.ok(downloadsStart > 0 && deepLinkStart > downloadsStart,
    'player.js\'s section markers moved — update the slice points');
  // Excise the downloads/tooltip/share sections: they call
  // document.getElementById() against raw innerHTML strings our fake DOM
  // doesn't parse, and none of it is relevant to the gate under test. Keep
  // everything else, INCLUDING the deep-link section further down — its
  // initLegacyDeepLink() is one of the three functions the gate's
  // initLegacyPlayback() calls, so leaving it out would ReferenceError.
  return full.slice(0, downloadsStart) + full.slice(deepLinkStart);
}

// A minimal .custom-player row — everything initCustomPlayers() dereferences
// before it unconditionally sets `player._audio = audio` at the end, which is
// this test's external signal that legacy actually ran.
function fakeCustomPlayerRow() {
  const row = new FakeElement('div', ['custom-player']);
  row.dataset.src = 'https://example.test/full.mp3';
  row.appendChild(new FakeElement('button', ['play-btn']));
  row.appendChild(new FakeElement('span', ['time-label', 'current']));
  row.appendChild(new FakeElement('input', ['progress-range']));
  return row;
}

test('player.js\'s real gate stays dormant once a peer boot has already mounted', async () => {
  const doc = new FakeDocument();
  const row = fakeCustomPlayerRow();
  doc.appendChild(row);
  const win = new FakeWindow({});
  win.PLAYER_ENGINE = 'controller';
  win.PLAYER_ENGINE_MOUNTED = true;   // simulates a peer player-boot.js success
  globalThis.document = doc;
  globalThis.window = win;

  new Function(playerJsGateSource())();  // runs the real top-level gate logic
  doc.dispatch('DOMContentLoaded');
  assert.equal(row._audio, undefined,
    'player.js must NOT wire .custom-player rows when a peer boot already mounted');
});

test('player.js\'s real gate initializes legacy playback when no peer boot mounted', async () => {
  const doc = new FakeDocument();
  const row = fakeCustomPlayerRow();
  doc.appendChild(row);
  const win = new FakeWindow({});
  win.PLAYER_ENGINE = 'controller';    // flagged page, but no boot ever claimed it
  globalThis.document = doc;
  globalThis.window = win;

  new Function(playerJsGateSource())();
  doc.dispatch('DOMContentLoaded');
  assert.notEqual(row._audio, undefined,
    'player.js must wire .custom-player rows as the fallback when nothing else mounted');
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
