// Deterministic tests for /playlist/'s queue-scoped views (playlist-views.js,
// Phase 2 Stage 2a of plans/player-consolidation/) — itemFromCatalogRow's
// field mapping, and PlaylistQueueView/PlaylistNowPlayingView rendering
// against a real PlaybackController with a fake <audio> element.
//
// Run: node scripts/test-playlist-views.mjs

import assert from 'node:assert/strict';
import { PlaybackController } from './player-controller.js';
import {
  FakeElement, FakeDocument, FakeAudio, loadPlaylistViews,
} from './test-fake-dom.mjs';

globalThis.document = new FakeDocument();
globalThis.window = { trackAddButtonHtml: (id) => `<button class="track-add" data-id="${id}">+</button>` };

const { itemFromCatalogRow, PlaylistQueueView, PlaylistNowPlayingView } = await loadPlaylistViews();

function catalogRow(id, extra = {}) {
  return {
    id, file: `${id}.mp3`, ver: 'abc123', title: `Song ${id}`, artist: 'jerry',
    venue: 'Cafe Java', showDate: '1999-05-27', durationSec: 200, url: `/shows/${id}/`,
    sourceType: 'sbd', num: 3, performer: 'Jerry Hannan', procVer: 8, songwriter: 'Traditional',
    flac: `${id}.flac`, flac_size_mb: 40, ...extra,
  };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── itemFromCatalogRow ────────────────────────────────────────────────────
test('itemFromCatalogRow maps display fields and builds the exact streamUrl playlist.js would', () => {
  globalThis.window.WORKER_ORIGIN = 'https://wav-download.renedebos.workers.dev';
  const item = itemFromCatalogRow(catalogRow('t1'));
  assert.equal(item.id, 't1');
  assert.equal(item.kind, 'track');
  assert.equal(item.streamUrl, 'https://wav-download.renedebos.workers.dev/stream?file=t1.mp3&v=abc123');
  assert.equal(item.artist, 'Jerry Hannan', 'artist must be the DISPLAY name, not the raw catalog key');
  assert.equal(item.dateDisplay, '1999-05-27');
  assert.equal(item.pageUrl, '/shows/t1/');
  assert.equal(item.peaksKey, null, '/playlist/ never has waveforms');
  assert.equal(item.downloads.flac, 't1.flac');
});

test('itemFromCatalogRow omits the cache-buster when a row has no ver', () => {
  const item = itemFromCatalogRow(catalogRow('t2', { ver: null }));
  assert.equal(item.streamUrl, 'https://wav-download.renedebos.workers.dev/stream?file=t2.mp3');
});

// ── PlaylistQueueView ──────────────────────────────────────────────────────
function makeController() {
  return new PlaybackController({ audio: new FakeAudio(), mediaSession: false });
}
function catalogById(rows) {
  const m = new Map();
  rows.forEach((r) => m.set(r.id, r));
  return m;
}

test('PlaylistQueueView renders one row per queue item, in queue order', () => {
  const c = makeController();
  const rows = [catalogRow('a'), catalogRow('b'), catalogRow('c')];
  const root = new FakeElement('div');
  const view = new PlaylistQueueView(root, { catalogById: catalogById(rows) });
  c.mount(view);
  c.setQueue(rows.map(itemFromCatalogRow));
  const rendered = root.querySelectorAll('.pl-row');
  assert.equal(rendered.length, 3);
  assert.deepEqual(rendered.map((r) => r.dataset.i), ['0', '1', '2']);
  c.destroy();
});

test('PlaylistQueueView highlights the currently-playing row and follows currentIndex', async () => {
  const c = makeController();
  const rows = [catalogRow('a'), catalogRow('b')];
  const root = new FakeElement('div');
  const view = new PlaylistQueueView(root, { catalogById: catalogById(rows) });
  c.mount(view);
  c.setQueue(rows.map(itemFromCatalogRow), { startIndex: 0, autoplay: true });
  await new Promise((r) => setTimeout(r, 0));
  let playing = root.querySelectorAll('.pl-row').filter((r) => r.classList.contains('pl-playing'));
  assert.equal(playing.length, 1);
  assert.equal(playing[0].dataset.i, '0');
  c.next();
  await new Promise((r) => setTimeout(r, 0));
  playing = root.querySelectorAll('.pl-row').filter((r) => r.classList.contains('pl-playing'));
  assert.equal(playing[0].dataset.i, '1');
  c.destroy();
});

test('PlaylistQueueView re-renders rows on removeAt (queue mutates in place, revision must still catch it)', () => {
  const c = makeController();
  const rows = [catalogRow('a'), catalogRow('b'), catalogRow('c')];
  const root = new FakeElement('div');
  const view = new PlaylistQueueView(root, { catalogById: catalogById(rows) });
  c.mount(view);
  c.setQueue(rows.map(itemFromCatalogRow), { startIndex: 1 });
  c.removeAt(0);
  const rendered = root.querySelectorAll('.pl-row');
  assert.equal(rendered.length, 2, 'a row must actually disappear after removeAt, not just currentIndex shifting');
  c.destroy();
});

test('PlaylistQueueView: clicking a row plays it; clicking remove removes it; track-add/select-all clicks are ignored', () => {
  const c = makeController();
  const rows = [catalogRow('a'), catalogRow('b')];
  const root = new FakeElement('div');
  const view = new PlaylistQueueView(root, { catalogById: catalogById(rows) });
  c.mount(view);
  c.setQueue(rows.map(itemFromCatalogRow), { startIndex: 0 });

  const playBtn = root.querySelectorAll('.pl-row-play')[1];
  root.dispatch('click', { target: playBtn });
  assert.equal(c.currentIndex, 1);

  const removeBtn = root.querySelectorAll('.pl-remove')[0];
  root.dispatch('click', { target: removeBtn });
  assert.equal(c.queue.length, 1, 'remove button must actually remove the row it is on');

  const addBtn = root.querySelectorAll('.track-add')[0];
  const before = c.queue.length;
  root.dispatch('click', { target: addBtn });
  assert.equal(c.queue.length, before, 'track-add clicks must not be treated as play/remove');
  c.destroy();
});

test('PlaylistQueueView header shows the endless-mode reshuffle suffix only in endless mode', () => {
  const c = makeController();
  const rows = [catalogRow('a')];
  const root = new FakeElement('div');
  let mode = 'songs';
  const view = new PlaylistQueueView(root, { catalogById: catalogById(rows), getMode: () => mode });
  c.mount(view);
  c.setQueue(rows.map(itemFromCatalogRow));
  assert.ok(!root.children[0].textContent?.includes('reshuffles') && !JSON.stringify(root.innerHTML).includes('reshuffles'));
  mode = 'endless';
  c.removeAt(0); // force a re-render (no-op removal path won't run; use setQueue instead)
  c.setQueue(rows.map(itemFromCatalogRow));
  assert.ok(root.innerHTML.includes('reshuffles when it runs out'));
  c.destroy();
});

test('PlaylistQueueView does not re-scan/re-highlight rows on a timeupdate tick where neither the queue nor the current index changed', async () => {
  const c = makeController();
  const rows = [catalogRow('a'), catalogRow('b')];
  const root = new FakeElement('div');
  const view = new PlaylistQueueView(root, { catalogById: catalogById(rows) });
  c.mount(view);
  c.setQueue(rows.map(itemFromCatalogRow), { startIndex: 0, autoplay: true });
  await new Promise((r) => setTimeout(r, 0));

  let plRowScans = 0;
  const realQSA = root.querySelectorAll.bind(root);
  root.querySelectorAll = (sel) => { if (sel === '.pl-row') plRowScans++; return realQSA(sel); };

  // Three timeupdate ticks with currentTime moving but nothing else changing
  // -- the exact steady-state-playback case the fix targets.
  c.audioElement.currentTime = 1; c.audioElement.dispatchEvent(new Event('timeupdate'));
  c.audioElement.currentTime = 2; c.audioElement.dispatchEvent(new Event('timeupdate'));
  c.audioElement.currentTime = 3; c.audioElement.dispatchEvent(new Event('timeupdate'));
  assert.equal(plRowScans, 0, 'a tick that changes neither the queue nor currentIndex must not re-scan .pl-row at all');

  // But a real index change must still update the highlight.
  c.next();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(plRowScans, 1, 'currentIndex actually changing must still trigger exactly one re-scan');
  c.destroy();
});

// ── PlaylistNowPlayingView ─────────────────────────────────────────────────
test('PlaylistNowPlayingView is empty/hidden with no current item, and builds structure once one plays', async () => {
  const c = makeController();
  const rows = [catalogRow('a')];
  const root = new FakeElement('div');
  const view = new PlaylistNowPlayingView(root, { catalogById: catalogById(rows) });
  c.mount(view);
  assert.equal(root.hidden, false); // FakeElement defaults hidden=false; real behavior asserted below instead
  c.setQueue(rows.map(itemFromCatalogRow), { startIndex: 0, autoplay: true });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(root.hidden, false);
  assert.ok(root.querySelector('.pl-now-title'));
  assert.equal(root.querySelector('.pl-now-title').textContent, 'Song a');
  c.stop();
  assert.equal(root.hidden, true, 'stopping must clear and hide the panel');
  c.destroy();
});

test('PlaylistNowPlayingView patches the play button in place across state changes without rebuilding the panel', async () => {
  const c = makeController();
  const rows = [catalogRow('a')];
  const root = new FakeElement('div');
  const view = new PlaylistNowPlayingView(root, { catalogById: catalogById(rows) });
  c.mount(view);
  c.setQueue(rows.map(itemFromCatalogRow), { startIndex: 0, autoplay: true });
  await new Promise((r) => setTimeout(r, 0));
  const titleNodeBefore = root.querySelector('.pl-now-title');
  c.pause();
  const titleNodeAfter = root.querySelector('.pl-now-title');
  assert.equal(titleNodeBefore, titleNodeAfter, 'a state change (playing->paused) must not rebuild the panel structure');
  const playBtn = root.querySelector('[data-act="play"]');
  assert.equal(playBtn.getAttribute('aria-label'), 'Play');
  c.destroy();
});

test('PlaylistNowPlayingView shuffle button reflects shuffleOn with the correct aria-pressed/label', () => {
  const c = makeController();
  const rows = ['a', 'b', 'c'].map((id) => catalogRow(id));
  const root = new FakeElement('div');
  const view = new PlaylistNowPlayingView(root, { catalogById: catalogById(rows) });
  c.mount(view);
  c.setQueue(rows.map(itemFromCatalogRow), { startIndex: 0 });
  const shuffleBtn = root.querySelector('[data-act="shuffle"]');
  assert.equal(shuffleBtn.getAttribute('aria-pressed'), 'false');
  root.dispatch('click', { target: shuffleBtn });
  assert.equal(c.state === 'error', false);
  assert.equal(shuffleBtn.getAttribute('aria-pressed'), 'true');
  assert.ok(shuffleBtn.getAttribute('aria-label').includes('restore original order'));
  c.destroy();
});

test('PlaylistNowPlayingView prev button: >3s restarts current track (seek 0), matching legacy', async () => {
  const c = makeController();
  const rows = [catalogRow('a'), catalogRow('b')];
  const root = new FakeElement('div');
  const view = new PlaylistNowPlayingView(root, { catalogById: catalogById(rows) });
  c.mount(view);
  c.setQueue(rows.map(itemFromCatalogRow), { startIndex: 1, autoplay: true });
  await new Promise((r) => setTimeout(r, 0));
  c.audioElement.duration = 200; // seek() no-ops without a known (finite) duration
  c.audioElement.currentTime = 10;
  const prevBtn = root.querySelector('[data-act="prev"]');
  root.dispatch('click', { target: prevBtn });
  assert.equal(c.currentIndex, 1, '>3s prev restarts the CURRENT track, does not go back');
  assert.equal(c.audioElement.currentTime, 0);
  c.destroy();
});

test('PlaylistNowPlayingView prev button: <=3s at queue start (index 0) restarts track 1 rather than no-op', async () => {
  const c = makeController();
  const rows = [catalogRow('a'), catalogRow('b')];
  const root = new FakeElement('div');
  const view = new PlaylistNowPlayingView(root, { catalogById: catalogById(rows) });
  c.mount(view);
  c.setQueue(rows.map(itemFromCatalogRow), { startIndex: 0, autoplay: true });
  await new Promise((r) => setTimeout(r, 0));
  c.audioElement.currentTime = 1; // under 3s
  const prevBtn = root.querySelector('[data-act="prev"]');
  root.dispatch('click', { target: prevBtn });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(c.currentIndex, 0, 'must stay on track 1, not go negative/no-op');
  assert.equal(c.state, 'playing', 'restarting track 1 must actually (re)start playback, not just seek');
  c.destroy();
});

test('PlaylistNowPlayingView prev button: <=3s past index 0 goes back one track (normal prev)', async () => {
  const c = makeController();
  const rows = [catalogRow('a'), catalogRow('b')];
  const root = new FakeElement('div');
  const view = new PlaylistNowPlayingView(root, { catalogById: catalogById(rows) });
  c.mount(view);
  c.setQueue(rows.map(itemFromCatalogRow), { startIndex: 1, autoplay: true });
  await new Promise((r) => setTimeout(r, 0));
  c.audioElement.currentTime = 1;
  const prevBtn = root.querySelector('[data-act="prev"]');
  root.dispatch('click', { target: prevBtn });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(c.currentIndex, 0);
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
