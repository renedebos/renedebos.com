// Deterministic tests for the song-page bootstrap (song-boot.js), Phase 3
// Stage 3a-foundation of plans/dynamic-hugging-rossum.md.
//
// Two page shapes matter here: /songs/<slug>/ (every occurrence row present
// at parse time, like a show page) and /songs/ (rows inserted lazily, one
// song's worth at a time, via mountRows() — songs.js's real call pattern).
// Every test imports song-boot.js afresh against a fake document —
// importing it IS running the bootstrap, same shape as test-player-boot.mjs.
//
// Run: node scripts/test-song-boot.mjs

import assert from 'node:assert/strict';
import {
  FakeElement, FakeDocument, FakeWindow, FakeAudio, loadSongBoot, readScript,
} from './test-fake-dom.mjs';

globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
const audios = [];
globalThis.Audio = class extends FakeAudio {
  constructor() { super(); audios.push(this); }
};

// ── fixtures mirroring _song_occ_html()'s/occRowHtml()'s generated markup ──
function occRow(n, itemOverride) {
  const wrap = new FakeElement('div', ['song-occ']);
  const head = new FakeElement('div', ['song-occ-head']);
  wrap.appendChild(head);
  const player = new FakeElement('div', ['custom-player']);
  player.dataset.src = `https://example.test/occ${n}.mp3`;
  player.dataset.item = itemOverride !== undefined ? itemOverride : JSON.stringify({
    id: `song-occ-${n}`,
    kind: 'track',
    streamUrl: `https://example.test/occ${n}.mp3`,
    title: 'A Song',
    artist: 'Jerry Hannan',
    dateDisplay: '1999-05-27',
    playLabel: `A Song, Jerry Hannan, 1999-05-27 (occ ${n})`,
    durationSec: 200,
    peaksKey: null,
  });
  const btn = new FakeElement('button', ['play-btn']);
  btn.dataset.playLabel = `A Song, Jerry Hannan, 1999-05-27 (occ ${n})`;
  player.appendChild(btn);
  const wrapInner = new FakeElement('div', ['progress-wrap']);
  wrapInner.appendChild(new FakeElement('input', ['progress-range']));
  const timeRow = new FakeElement('div', ['time-row']);
  timeRow.appendChild(new FakeElement('span', ['time-label', 'current']));
  wrapInner.appendChild(timeRow);
  player.appendChild(wrapInner);
  wrap.appendChild(player);
  return wrap;
}

// A song DETAIL page: every occurrence row present at parse time inside one
// .song-occs container (build_song_page()'s shape).
function songDetailDoc({ rows = 2, badRow = -1 } = {}) {
  const doc = new FakeDocument();
  const main = new FakeElement('main');
  const container = new FakeElement('div', ['song-occs']);
  for (let n = 1; n <= rows; n++) container.appendChild(occRow(n, n === badRow ? '{not json' : undefined));
  main.appendChild(container);
  doc.appendChild(main);
  return { doc, container };
}

// The songs INDEX page: no rows at all initially — .song-occs containers
// start empty, exactly like build_songs_index()'s markup before any
// <details> has been toggled open. Returns a factory for adding a fresh
// "song group" container later, mirroring songs.js's renderSongOccs().
function songsIndexDoc() {
  const doc = new FakeDocument();
  const list = new FakeElement('div', ['song-list']);
  doc.appendChild(list);
  return {
    doc,
    addGroup(rows, startAt = 1) {
      const container = new FakeElement('div', ['song-occs']);
      for (let n = 0; n < rows; n++) container.appendChild(occRow(startAt + n));
      list.appendChild(container);
      return container;
    },
  };
}

async function boot(doc, { flag = true } = {}) {
  const win = new FakeWindow({});
  if (flag) win.PLAYER_ENGINE = 'controller';
  globalThis.document = doc;
  globalThis.window = win;
  await loadSongBoot();
  return { doc, win, handle: win.SONG_BOOT, c: win.SONG_BOOT && win.SONG_BOOT.controller };
}

const tick = () => new Promise(r => setTimeout(r, 0));
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── song detail page: synchronous mount, all rows present at boot ─────────
test('a song detail page mounts every occurrence row synchronously and claims the page', async () => {
  const { doc } = songDetailDoc({ rows: 3 });
  const { win, c } = await boot(doc);
  try {
    assert.equal(win.PLAYER_ENGINE_MOUNTED, true);
    assert.ok(c, 'a controller must be exposed on the boot handle');
    // Singleton semantics (finding #1 fix): mounting rows must never build a
    // shared queue up front -- each row's queue is only ever itself, created
    // the moment it's clicked. Nothing has been clicked yet, so the queue is
    // empty even though all 3 rows are mounted and playable.
    assert.equal(c.queue.length, 0, 'mounting rows must not pre-build any queue');
  } finally { c.destroy(); }
});

test('clicking one occurrence row plays ONLY that occurrence, as a length-1 singleton queue', async () => {
  const { doc } = songDetailDoc({ rows: 3 });
  const { c } = await boot(doc);
  try {
    doc.querySelectorAll('.song-occs [data-item]')[1].querySelector('.play-btn').dispatch('click');
    await tick();
    assert.equal(c.currentIndex, 0, 'a singleton queue has exactly one item, at index 0');
    assert.equal(c.queue.length, 1, 'clicking a row must not queue any other occurrence on the page');
    assert.equal(c.currentItem.id, 'song-occ-2');
  } finally { c.destroy(); }
});

test('a malformed occurrence row is skipped, not fatal to the rest of the page (deliberate divergence from bootShowPage)', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const { doc } = songDetailDoc({ rows: 3, badRow: 2 });
    const { win, c } = await boot(doc);
    try {
      assert.equal(win.PLAYER_ENGINE_MOUNTED, true,
        'one bad row must not take the whole song page back to the legacy engine');
      const rows = doc.querySelectorAll('.song-occs [data-item]');
      // The two good rows (1 and 3) still mount and each plays as its own
      // independent singleton -- row 2 (malformed) never got a view at all,
      // so nothing exercises it here.
      rows[0].querySelector('.play-btn').dispatch('click');
      await tick();
      assert.equal(c.currentItem.id, 'song-occ-1');
      assert.equal(c.queue.length, 1);

      rows[2].querySelector('.play-btn').dispatch('click');
      await tick();
      assert.equal(c.currentItem.id, 'song-occ-3');
      assert.equal(c.queue.length, 1, 'switching to the other good row is still a length-1 singleton');
    } finally { c.destroy(); }
  } finally { console.error = quiet; }
});

test('a page without the engine flag is never claimed', async () => {
  const { doc } = songDetailDoc({ rows: 2 });
  const { win } = await boot(doc, { flag: false });
  assert.equal(win.PLAYER_ENGINE_MOUNTED, undefined);
  assert.equal(win.SONG_BOOT, undefined);
});

// ── songs index page: zero rows at boot is normal, mountRows() extends ────
test('the index page boots with zero rows and an empty (not refused) controller', async () => {
  const { doc } = songsIndexDoc();
  const { win, c } = await boot(doc);
  try {
    assert.equal(win.PLAYER_ENGINE_MOUNTED, true,
      'zero initial rows is the NORMAL starting state on /songs/ -- unlike bootShowPage(), this must not refuse to claim the page');
    assert.equal(c.queue.length, 0);
  } finally { c.destroy(); }
});

// ── singleton queue contract (finding #1 fix) ─────────────────────────────
// Each occurrence row is its own length-1 queue. Opening a later song group
// on /songs/ shares the same PlaybackController instance (so there's still
// only one <audio> element on the page) but must never grow, or otherwise
// touch, whatever singleton queue is currently playing -- that would let
// playback auto-advance from one song's occurrence into a completely
// unrelated song's occurrence, which legacy never did (legacy's auto-advance
// was gated by a [data-autoplay-next] ancestor that only ever wrapped a show
// page's .track-list, never .song-occs).

test('opening a later song group does not mutate the currently-playing singleton queue', async () => {
  const { doc, addGroup } = songsIndexDoc();
  const { handle, c } = await boot(doc);
  try {
    const groupA = addGroup(1, 1); // song-occ-1
    handle.mountRows(groupA);
    doc.querySelector('.song-occs [data-item]').querySelector('.play-btn').dispatch('click');
    await tick();
    assert.equal(c.state, 'playing');
    assert.equal(c.queue.length, 1, 'a singleton queue holds exactly the one clicked occurrence');
    assert.equal(c.currentItem.id, 'song-occ-1');

    const groupB = addGroup(1, 2); // song-occ-2, a totally different song's occurrence
    handle.mountRows(groupB);
    assert.equal(c.queue.length, 1,
      'mounting a later, unrelated group must not grow the currently-playing singleton queue');
    assert.equal(c.currentItem.id, 'song-occ-1', 'the active occurrence must be unchanged');

    // No next/prev makes sense for a length-1 singleton: _advance() sees
    // newIndex (1) >= queue.length (1) and, with no onQueueExhausted handler
    // (song-boot.js passes none), falls through to stop() -- idx resets to
    // -1 and currentItem becomes null. It must NOT land on groupB's item.
    c.next();
    await tick();
    assert.equal(c.currentItem, null,
      'Next on a length-1 singleton has nothing to advance to; it must stop, not reach an unrelated occurrence');
    assert.equal(c.state, 'idle');
  } finally { c.destroy(); }
});

test('reaching "ended" on one occurrence does not start another, unrelated occurrence', async () => {
  const { doc, addGroup } = songsIndexDoc();
  const { handle, c } = await boot(doc);
  try {
    const groupA = addGroup(1, 1); // song-occ-1
    handle.mountRows(groupA);
    doc.querySelector('.song-occs [data-item]').querySelector('.play-btn').dispatch('click');
    await tick();
    assert.equal(c.state, 'playing');
    assert.equal(c.queue.length, 1);

    const groupB = addGroup(1, 2); // song-occ-2, mounted AFTER groupA started playing
    handle.mountRows(groupB);
    assert.equal(c.queue.length, 1, 'mounting groupB must still not touch the live singleton queue');

    // The 'ended' handler auto-advances only when idx + 1 < queue.length --
    // for a length-1 queue that's never true, so it falls through to the
    // terminal 'ended' state instead of starting song-occ-2.
    c.audioElement.dispatchEvent(new Event('ended'));
    await tick();
    assert.equal(c.state, 'ended');
    assert.equal(c.queue.length, 1, 'the queue must still be just the one occurrence');
    assert.equal(c.currentItem.id, 'song-occ-1',
      'ended must leave the same occurrence current, never having started song-occ-2');
  } finally { c.destroy(); }
});

test('mountRows() called twice over the same container does not double-mount already-mounted rows', async () => {
  // Singleton rows never populate a queue at mount time (see the tests
  // above), so a queue-length assertion can no longer detect a double-mount
  // the way it used to -- spy on controller.mount() itself instead: a
  // duplicate mount would wire a second click listener onto the same
  // button, a real (if subtle) bug this must still catch.
  const mod = await import('./player-controller.js');
  const realMount = mod.PlaybackController.prototype.mount;
  let mountCalls = 0;
  mod.PlaybackController.prototype.mount = function (view) {
    mountCalls++;
    return realMount.call(this, view);
  };
  try {
    const { doc, addGroup } = songsIndexDoc();
    const { handle, c } = await boot(doc);
    try {
      const group = addGroup(2, 1);
      handle.mountRows(group);
      handle.mountRows(group); // e.g. a defensive re-call
      assert.equal(mountCalls, 2, 'already-mounted rows must not be mounted a second time');
    } finally { c.destroy(); }
  } finally {
    mod.PlaybackController.prototype.mount = realMount;
  }
});

// ── keyboard ────────────────────────────────────────────────────────────
test('Space toggles whatever is active, and keeps its hands off the search input', async () => {
  const { doc } = songDetailDoc({ rows: 1 });
  const { c } = await boot(doc);
  try {
    doc.querySelector('.song-occs [data-item]').querySelector('.play-btn').dispatch('click');
    await tick();
    assert.equal(c.state, 'playing');

    doc.activeElement = new FakeElement('input'); // e.g. #song-search
    let prevented = 0;
    doc.dispatch('keydown', { code: 'Space', preventDefault: () => { prevented++; } });
    await tick();
    assert.equal(c.state, 'playing', 'Space while the search box is focused must not toggle playback');
    assert.equal(prevented, 0);

    doc.activeElement = new FakeElement('div');
    doc.dispatch('keydown', { code: 'Space', preventDefault: () => { prevented++; } });
    await tick();
    assert.equal(c.state, 'paused');
    assert.equal(prevented, 1);
  } finally { c.destroy(); }
});

// ── readiness contract ──────────────────────────────────────────────────
test('a successful mount resolves PLAYBACK_HOST_READY to controller mode with initialIntent "none"', async () => {
  const { doc } = songDetailDoc({ rows: 1 });
  const win = new FakeWindow({});
  win.PLAYER_ENGINE = 'controller';
  let resolved = null;
  win.__resolvePlaybackHost = (v) => { resolved = v; };
  globalThis.document = doc;
  globalThis.window = win;
  await loadSongBoot();
  try {
    assert.ok(resolved, 'the readiness promise must be resolved on a successful mount');
    assert.equal(resolved.mode, 'controller');
    assert.equal(resolved.initialIntent, 'none', 'song pages never autoplay or establish a page-queue at boot');
    assert.equal(resolved.controller, win.SONG_BOOT.controller);
  } finally { win.SONG_BOOT.controller.destroy(); }
});

test('a thrown mount failure resolves PLAYBACK_HOST_READY to legacy mode and leaves the mounted flag unset', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    // A malformed row inside the INITIAL synchronous mountRows(doc) call
    // (not a later mountRows() call) still throws today -- mountRows()
    // isolates per-row failures from EACH OTHER, but bootSongPage()'s outer
    // try/catch is the real safety net for anything unexpected happening
    // during the very first mount, same shape as bootShowPage()'s.
    const { doc } = songDetailDoc({ rows: 1 });
    // Force an unexpected throw during the initial mount by breaking
    // controller.mount() itself, independent of row content.
    const win = new FakeWindow({});
    win.PLAYER_ENGINE = 'controller';
    let resolved = null;
    win.__resolvePlaybackHost = (v) => { resolved = v; };
    globalThis.document = doc;
    globalThis.window = win;
    const mod = await import('./player-controller.js');
    const realMount = mod.PlaybackController.prototype.mount;
    mod.PlaybackController.prototype.mount = function () { throw new Error('injected mount failure'); };
    try {
      await loadSongBoot();
    } finally {
      mod.PlaybackController.prototype.mount = realMount;
    }
    assert.equal(win.PLAYER_ENGINE_MOUNTED, undefined);
    assert.equal(win.SONG_BOOT, undefined);
    assert.ok(resolved, 'the readiness promise must still be resolved on a mount failure');
    assert.equal(resolved.mode, 'legacy');
  } finally { console.error = quiet; }
});

// ── player.js's real fallback gate, executed for real ──────────────────
// Same rationale as test-player-boot.mjs's equivalent: nothing above ever
// loads player.js itself, so a regression that broke its (unchanged, reused)
// engine-selection gate for song pages specifically would go unnoticed.
// song-boot.js deliberately reuses player.js's EXISTING window.PLAYER_ENGINE/
// PLAYER_ENGINE_MOUNTED flag pair rather than inventing a second one -- this
// proves that reuse actually works against player.js's real source, not a
// reimplementation of it.
function playerJsGateSource() {
  const full = readScript('player.js');
  const downloadsStart = full.indexOf('// ── downloads');
  const deepLinkStart = full.indexOf('// ── deep-link to a track ──');
  assert.ok(downloadsStart > 0 && deepLinkStart > downloadsStart,
    'player.js\'s section markers moved — update the slice points');
  return full.slice(0, downloadsStart) + full.slice(deepLinkStart);
}

function fakeCustomPlayerRow() {
  const row = new FakeElement('div', ['custom-player']);
  row.dataset.src = 'https://example.test/occ.mp3';
  row.appendChild(new FakeElement('button', ['play-btn']));
  row.appendChild(new FakeElement('span', ['time-label', 'current']));
  row.appendChild(new FakeElement('input', ['progress-range']));
  return row;
}

test('player.js\'s real gate stays dormant on a song page once song-boot.js has mounted', async () => {
  const doc = new FakeDocument();
  const row = fakeCustomPlayerRow();
  doc.appendChild(row);
  const win = new FakeWindow({});
  win.PLAYER_ENGINE = 'controller';
  win.PLAYER_ENGINE_MOUNTED = true; // simulates a peer song-boot.js success
  globalThis.document = doc;
  globalThis.window = win;

  new Function(playerJsGateSource())();
  doc.dispatch('DOMContentLoaded');
  assert.equal(row._audio, undefined,
    'player.js must NOT wire .custom-player rows when song-boot.js already mounted');
});

test('player.js\'s real gate falls back to initCustomPlayers() when song-boot.js never mounted', async () => {
  const doc = new FakeDocument();
  const row = fakeCustomPlayerRow();
  doc.appendChild(row);
  const win = new FakeWindow({});
  win.PLAYER_ENGINE = 'controller'; // flagged page, but no boot ever claimed it
  globalThis.document = doc;
  globalThis.window = win;

  new Function(playerJsGateSource())();
  doc.dispatch('DOMContentLoaded');
  assert.notEqual(row._audio, undefined,
    'player.js must wire .custom-player rows as the fallback when song-boot.js never mounted');
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
    console.error('       ' + (err && err.stack ? err.stack : err));
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
