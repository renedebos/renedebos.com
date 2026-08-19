// Deterministic tests for /playlist/'s bootstrap state logic (playlist-boot.js,
// Phase 2 Stage 2a of plans/player-consolidation/): hash hydration, saved
// playlists, endless-mode rollover, untrusted-input bounds, and the
// transactional mount-or-teardown gate. Importing playlist-boot.js against a
// fake document/window IS running the bootstrap — same shape as
// test-player-boot.mjs.
//
// Run: node scripts/test-playlist-state.mjs

import assert from 'node:assert/strict';
import { PlaybackController } from './player-controller.js';
import {
  FakeElement, FakeDocument, FakeWindow, FakeAudio, loadPlaylistBoot,
  TEST_CATALOG_FETCH_TIMEOUT_MS,
} from './test-fake-dom.mjs';

globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
const audios = [];
globalThis.Audio = class extends FakeAudio {
  constructor() { super(); audios.push(this); }
};

// Node >=21 defines a getter-only `navigator` global -- plain
// `globalThis.navigator = {...}` throws ("which has only a getter"). See
// test-player-controller.mjs's setGlobalNavigator (added for the same CI
// failure, commit 5078e47).
function setGlobalNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', {
    value, configurable: true, writable: true, enumerable: true,
  });
}

// ── localStorage fake ──────────────────────────────────────────────────
function fakeStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _store: store,
  };
}

// ── fixtures ────────────────────────────────────────────────────────────
function playlistDoc() {
  const doc = new FakeDocument();
  const byId = {};
  const mk = (id, tag = 'div') => { const el = new FakeElement(tag); el.id = id; byId[id] = el; doc.appendChild(el); return el; };
  mk('pl-filters');
  mk('pl-length');
  mk('pl-status');
  const gen = mk('pl-generate', 'button');
  mk('pl-now');
  mk('pl-queue');
  const presets = new FakeElement('div', ['pl-presets']);
  doc.appendChild(presets);
  mk('pl-clear', 'button');
  mk('pl-share', 'button').hidden = true;
  mk('pl-save', 'button').hidden = true;
  mk('pl-download', 'button').hidden = true;
  mk('pl-player', 'button').hidden = true;
  mk('pl-saved');
  return { doc, byId };
}

function catalogRow(id, extra = {}) {
  return {
    id, file: `${id}.mp3`, ver: null, title: `Song ${id}`, artist: 'jerry', song: `Song ${id}`,
    venue: 'Cafe Java', showDate: '1999-05-27', durationSec: 200, url: `/shows/${id}/`,
    sourceType: 'sbd', tags: [], songwriter: 'Traditional', flac: `${id}.flac`, flac_size_mb: 40,
    ...extra,
  };
}

async function boot({ hash = '', search = '', storage = {}, catalogFail = false } = {}) {
  const { doc } = playlistDoc();
  const win = new FakeWindow({ hash, search });
  win.WORKER_ORIGIN = 'https://wav-download.renedebos.workers.dev';
  win.history = { replaceState: (s, t, url) => { win.location.hash = (url || '').startsWith('#') ? url : ''; win.location.pathname = (url || '').startsWith('#') ? win.location.pathname : url; } };
  win.location.pathname = '/playlist/';
  win.location.href = 'https://renedebos.com/playlist/' + hash;
  win.location.origin = 'https://renedebos.com';
  win.prompt = () => null;
  win.confirm = () => true;
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.localStorage = fakeStorage(storage);
  setGlobalNavigator({}); // no 'mediaSession' key at all -- `'mediaSession' in navigator` must be false
  // Readiness-contract resolution (plans/dynamic-hugging-rossum.md) — a test
  // reads `readiness()` to see what playlist-boot.js resolved
  // window.PLAYBACK_HOST_READY to.
  let readiness = null;
  win.__resolvePlaybackHost = (v) => { readiness = v; };
  const CATALOG = ['a', 'b', 'c', 'd', 'e'].map((id) => catalogRow(id));
  globalThis.fetch = (url) => {
    if (String(url).includes('tracks.json')) {
      return catalogFail ? Promise.reject(new Error('offline')) : Promise.resolve({ json: () => Promise.resolve(CATALOG) });
    }
    return Promise.resolve({ ok: false });
  };
  const mod = await loadPlaylistBoot();
  await new Promise((r) => setTimeout(r, 0)); // let the catalog fetch's .then chain resolve
  return {
    doc, win, handle: win.PLAYLIST_BOOT, c: win.PLAYLIST_BOOT && win.PLAYLIST_BOOT.controller, mod,
    readiness: () => readiness,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── mount / transactional gate ─────────────────────────────────────────
test('mounts and sets the flag synchronously; catalog arrives later', async () => {
  const { win, c } = await boot();
  try {
    assert.equal(win.PLAYLIST_ENGINE_MOUNTED, true);
    assert.ok(c, 'a controller must be exposed on the boot handle');
  } finally { if (c) c.destroy(); }
});

// Stage 2c (2026-08-14) deleted the legacy playlist.js engine and its
// `?engine=`/PLAYLIST_ENGINE resolver -- playlist-boot.js is now the only
// engine and mounts unconditionally, with no window.PLAYLIST_ENGINE flag to
// check. A stale `?engine=legacy` link (bookmarked, shared, or cached from
// before the deletion) must not do anything special -- the module doesn't
// read location.search at all anymore, so this proves that by construction
// rather than by absence of a crash.
test('mounts unconditionally even with a stale ?engine=legacy param on the URL', async () => {
  const { win, c } = await boot({ search: '?engine=legacy' });
  try {
    assert.equal(win.PLAYLIST_ENGINE_MOUNTED, true,
      'a leftover ?engine=legacy param must be ignored -- there is no engine selection anymore');
    assert.ok(c, 'the controller must still mount normally');
  } finally { if (c) c.destroy(); }
});

test('a thrown mount failure leaves the flag unset (bootPlaylistPage propagates, does not swallow)', async () => {
  const { doc } = playlistDoc();
  doc.getElementById('pl-queue').remove(); // required element missing
  const win = new FakeWindow({});
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.localStorage = fakeStorage();
  globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve([]) });
  await loadPlaylistBoot();
  assert.equal(win.PLAYLIST_ENGINE_MOUNTED, undefined,
    'the auto-run block must catch the throw and leave the flag unset -- there is no fallback engine to hand off to anymore, the page just stays inert');
});

// Codex review finding (Phase 2 Stage 2a, 2026-08-14): the transactional
// try/catch used to end right after the three controller.mount() calls, so a
// throw ANYWHERE in the DOM-wiring section that follows (13 addEventListener
// registrations) or the fetch kickoff left a live, fully-mounted controller
// and views behind with nothing to tear them down -- playlist.js would then
// initialize on top of that leaked state. This test injects a failure well
// after both views are mounted (in the optional presets-panel wiring), which
// the earlier "required element missing" test above cannot reach (it throws
// before the controller even exists).
test('a mount failure AFTER views are already mounted still tears everything down (not just the missing-markup case)', async () => {
  const { doc } = playlistDoc();
  const win = new FakeWindow({});
  win.WORKER_ORIGIN = 'https://x';
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.localStorage = fakeStorage();
  setGlobalNavigator({});
  globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve([]) });

  // Injected failure: the presets panel exists (so its wiring is reached,
  // well after both views mount) but throws when wired.
  const presetsEl = doc.querySelector('.pl-presets');
  presetsEl.addEventListener = () => { throw new Error('injected post-mount wiring failure'); };

  let destroyCalls = 0;
  const realDestroy = PlaybackController.prototype.destroy;
  PlaybackController.prototype.destroy = function (...args) {
    destroyCalls++;
    return realDestroy.apply(this, args);
  };
  try {
    await loadPlaylistBoot();
    assert.equal(win.PLAYLIST_ENGINE_MOUNTED, undefined,
      'a failure after mounting must still leave the flag unset');
    assert.equal(win.PLAYLIST_BOOT, undefined,
      'bootPlaylistPage must not return a handle to the caller on failure');
    assert.equal(destroyCalls, 1,
      'the controller (and its two mounted views + hash-sync subscriber) must be torn down, not leaked');
  } finally {
    PlaybackController.prototype.destroy = realDestroy;
  }
});

// ── readiness contract (Phase 3 Stage 3a-foundation) ──────────────────────
// /playlist/ resolves window.PLAYBACK_HOST_READY once both hydrateFromHash()
// and the catalog fetch's first .then()/.catch() have settled -- all three
// failure modes need covering explicitly (only the module-tag onerror= case
// is browser-only; the other two are exercised here). See playlist-boot.js's
// own resolveReady()/auto-run comments for the reasoning.
test('readiness resolves to controller/page-queue when the hash had real ids', async () => {
  const { readiness } = await boot({ hash: '#p=b,d' });
  try {
    assert.ok(readiness());
    assert.equal(readiness().mode, 'controller');
    assert.equal(readiness().initialIntent, 'page-queue');
  } finally { const c = readiness().controller; if (c) c.destroy(); }
});

test('readiness resolves to controller/none when there is no hash at all', async () => {
  const { readiness } = await boot();
  try {
    assert.equal(readiness().mode, 'controller');
    assert.equal(readiness().initialIntent, 'none');
  } finally { readiness().controller.destroy(); }
});

// Implementation review finding #5 (2026-08-15): a RECOGNIZED #p= hash whose
// ids are all unknown/stale is a real page-level decision (hydrateFromHash()
// explicitly clears the queue and shows "None of the tracks..."), not the
// same thing as no hash being present at all. This must resolve 'page-queue',
// not 'none' -- a future mini-player would otherwise treat a stale-but-
// explicit share link as "nothing happened, safe to restore my own session",
// silently overriding both the URL the visitor followed and the status
// message just shown to them. (This test used to assert 'none' here, which
// was the bug this finding caught -- it was testing the wrong contract.)
test('readiness resolves to controller/page-queue when the hash was recognized but every id in it is unknown', async () => {
  const { readiness, doc } = await boot({ hash: '#p=nope,also-nope' });
  try {
    assert.equal(readiness().mode, 'controller');
    assert.equal(readiness().initialIntent, 'page-queue',
      'a recognized #p= hash is a page-level decision even when it resolves to zero tracks -- must not be reported the same as "no hash at all"');
    assert.equal(readiness().controller.queue.length, 0);
    assert.ok(doc.getElementById('pl-status').textContent.includes('None of the tracks'));
  } finally { readiness().controller.destroy(); }
});

// Catalog-fetch-only failure: the controller/views still mount fine (there
// is nothing wrong with the page itself), only the catalog request failed --
// still resolves 'controller' (the controller genuinely exists), never
// leaves the promise hanging.
test('readiness still resolves (controller/none) when the catalog fetch itself fails, never hangs', async () => {
  const { readiness, doc } = await boot({ catalogFail: true });
  try {
    assert.ok(readiness(), 'a broken catalog must not leave PLAYBACK_HOST_READY pending forever');
    assert.equal(readiness().mode, 'controller');
    assert.equal(readiness().initialIntent, 'none');
    assert.ok(doc.getElementById('pl-status').textContent.includes('Could not load'));
  } finally { readiness().controller.destroy(); }
});

// Implementation review finding #6 (2026-08-15): the previous test above
// covers a fetch that REJECTS immediately -- it says nothing about a fetch
// that never settles at all (a genuinely stalled connection), which the
// existing .then()/.catch()-only readiness resolution had no fallback for.
// This test's fake fetch never resolves or rejects ON ITS OWN -- it only
// ever settles by having its AbortSignal aborted, exactly mirroring real
// fetch()'s actual abort contract -- so this specifically exercises the
// LOCAL catalog-fetch timeout mechanism, not just "any rejection eventually
// happens." Manual setup (not the shared boot() helper) for full control
// over timing: boot() only waits one tick after loadPlaylistBoot(), nowhere
// near test-fake-dom.mjs's shrunk (but still nonzero) timeout duration.
test('a catalog fetch that never settles at all still resolves readiness via the local timeout, rather than hanging forever', async () => {
  const { doc } = playlistDoc();
  const win = new FakeWindow({});
  win.WORKER_ORIGIN = 'https://x';
  win.history = { replaceState: () => {} };
  win.location.pathname = '/playlist/';
  win.location.href = 'https://renedebos.com/playlist/';
  win.location.origin = 'https://renedebos.com';
  win.prompt = () => null;
  win.confirm = () => true;
  let readiness = null;
  win.__resolvePlaybackHost = (v) => { readiness = v; };
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.localStorage = fakeStorage();
  setGlobalNavigator({});
  globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
    if (opts && opts.signal) {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }
    // Deliberately never calls resolve()/reject() on its own.
  });

  await loadPlaylistBoot();
  try {
    assert.equal(readiness, null,
      'readiness must not resolve immediately -- this proves the test is actually exercising the timeout, not an instant rejection');

    // Wait comfortably past the (test-fake-dom.mjs-shrunk) timeout.
    await new Promise((r) => setTimeout(r, TEST_CATALOG_FETCH_TIMEOUT_MS * 5));

    assert.ok(readiness, 'a catalog fetch that never settles must not leave PLAYBACK_HOST_READY pending forever');
    assert.equal(readiness.mode, 'controller', 'the controller/shell itself mounted fine -- only the catalog stalled');
    assert.equal(readiness.initialIntent, 'none');
    assert.ok(doc.getElementById('pl-status').textContent.includes('Could not load'),
      'the timeout must degrade exactly like any other catalog failure, not a distinct silent path');
  } finally {
    if (win.PLAYLIST_BOOT) win.PLAYLIST_BOOT.controller.destroy();
  }
});

// Implementation review finding #4 (2026-08-15): the catalog-fetch .catch()
// branch used to hardcode {recognized:false, hadIds:false} regardless of
// what the URL hash actually contained -- a genuine #p=a,b share link, hit
// by a transient network failure, was reported identically to "no hash at
// all." The all-unknown-ids test above (finding #5, previous round) only
// covers the SUCCESS path; this covers the identical failure class on the
// FAILURE path, which that fix did not touch. `catalogFail` here means the
// fetch call itself REJECTS (immediate network failure), not the timeout --
// the next test below covers the timeout mechanism with a hash present too.
test('a catalog fetch REJECTION with an explicit #p= share link in the hash still resolves page-queue intent, not none', async () => {
  const { readiness } = await boot({ hash: '#p=b,d', catalogFail: true });
  try {
    assert.ok(readiness());
    assert.equal(readiness().mode, 'controller');
    assert.equal(readiness().initialIntent, 'page-queue',
      'a genuine share link hit by a transient catalog failure must not be reported the same as "no hash at all" -- a future mini-player could otherwise silently restore an unrelated persisted session over what the URL explicitly asked for');
  } finally { readiness().controller.destroy(); }
});

// Same failure class, but via the LOCAL TIMEOUT mechanism (finding #6,
// previous round) rather than an immediate rejection -- a fetch that never
// settles on its own, with an explicit #p= hash present, must ALSO preserve
// page-queue intent once the timeout aborts it, not just the
// immediate-rejection path covered above.
test('a catalog fetch that never settles, with an explicit #p= hash present, still resolves page-queue intent via the local timeout', async () => {
  const { doc } = playlistDoc();
  const win = new FakeWindow({ hash: '#p=b,d' });
  win.WORKER_ORIGIN = 'https://x';
  win.history = { replaceState: () => {} };
  win.location.pathname = '/playlist/';
  win.location.href = 'https://renedebos.com/playlist/#p=b,d';
  win.location.origin = 'https://renedebos.com';
  win.prompt = () => null;
  win.confirm = () => true;
  let readiness = null;
  win.__resolvePlaybackHost = (v) => { readiness = v; };
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.localStorage = fakeStorage();
  setGlobalNavigator({});
  globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
    if (opts && opts.signal) {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }
    // Deliberately never calls resolve()/reject() on its own.
  });

  await loadPlaylistBoot();
  try {
    assert.equal(readiness, null);
    await new Promise((r) => setTimeout(r, TEST_CATALOG_FETCH_TIMEOUT_MS * 5));
    assert.ok(readiness, 'a catalog fetch that never settles must not leave PLAYBACK_HOST_READY pending forever');
    assert.equal(readiness.initialIntent, 'page-queue',
      'the local-timeout path must ALSO preserve an explicit share-link intent, not just the immediate-rejection path above');
  } finally {
    if (win.PLAYLIST_BOOT) win.PLAYLIST_BOOT.controller.destroy();
  }
});

// Implementation review finding #5 (2026-08-15): destroy() used to clear the
// catalog-fetch timeout but never abort the fetch's own AbortController --
// a page torn down while the catalog request was still in flight left that
// request running past teardown, with its continuation still scheduled to
// act on an already-destroyed controller. This fake fetch deliberately does
// NOT honor the abort signal at all (it only settles when the test manually
// resolves it) -- modeling the review's own scenario ("a never-settling
// fetch therefore remains pending forever after destroy... a later
// successful fetch can resolve readiness with an already-destroyed
// controller") and isolating the SEPARATE "destroyed" flag guard (the fix's
// second half) from whether abort() itself would have been enough.
test('destroy() during an in-flight catalog fetch aborts it directly and prevents the continuation from acting afterward', async () => {
  const { doc } = playlistDoc();
  // Seeded with the real generated page's actual initial text
  // (pages.py's pl-status markup), not left blank -- so the assertion below
  // proves the status line is genuinely UNTOUCHED post-destroy, not merely
  // that it happens to still equal whatever empty default this fixture
  // started with.
  const initialStatusText = 'Loading the track catalog…';
  doc.getElementById('pl-status').textContent = initialStatusText;
  const win = new FakeWindow({});
  win.WORKER_ORIGIN = 'https://x';
  win.history = { replaceState: () => {} };
  win.location.pathname = '/playlist/';
  win.location.href = 'https://renedebos.com/playlist/';
  win.location.origin = 'https://renedebos.com';
  win.prompt = () => null;
  win.confirm = () => true;
  let readiness = null;
  win.__resolvePlaybackHost = (v) => { readiness = v; };
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.localStorage = fakeStorage();
  setGlobalNavigator({});

  let capturedSignal = null;
  let resolveFetch;
  globalThis.fetch = (url, opts) => {
    capturedSignal = opts && opts.signal;
    return new Promise((resolve) => { resolveFetch = resolve; });
  };

  await loadPlaylistBoot();
  const handle = win.PLAYLIST_BOOT;
  assert.ok(handle, 'must have mounted synchronously before the catalog settles');
  assert.equal(readiness, null, 'readiness must still be pending -- the catalog fetch has not settled yet');

  handle.destroy();
  assert.ok(capturedSignal && capturedSignal.aborted,
    'destroy() must abort the in-flight catalog fetch\'s own AbortController directly, not just clear the timeout');

  // The fetch settles SUCCESSFULLY well after destroy() ran (this fake never
  // reacted to the abort signal at all -- see the test's own comment above).
  // Round-3 correction (2026-08-15): json() call-tracking added -- the FIRST
  // .then() previously had no destroyed guard at all, so this fake's json()
  // genuinely got invoked post-destroy even though nothing observable
  // happened afterward. The guard now added to that first .then() must stop
  // json() itself from ever being called on a destroyed handle, not just
  // stop the later data-handling step from acting on its result.
  let jsonCalled = false;
  resolveFetch({ json: () => { jsonCalled = true; return Promise.resolve([]); } });
  await tick(); await tick(); await tick(); // headroom: guard now short-circuits before r.json() ever runs

  assert.equal(jsonCalled, false,
    'a destroyed handle\'s fetch continuation must not even parse the response body, not just avoid acting on it');
  assert.equal(readiness, null,
    'a destroyed handle\'s catalog continuation must never resolve readiness -- nothing should still be listening for it');
  assert.equal(doc.getElementById('pl-status').textContent, initialStatusText,
    'the continuation must not touch the DOM after destroy() either -- the status line must remain exactly what it was');
});

// In-script throw during mount (script loaded fine, something inside it
// threw) -- resolves 'none', destroying any partially-constructed controller
// first. Covers both the "controller was constructed, then something later
// failed" path AND the "required markup missing" path that throws BEFORE
// `new PlaybackController()` even runs (the auto-run block's own backstop).
test('readiness resolves to none on an in-script throw AFTER the controller was constructed', async () => {
  const { doc } = playlistDoc();
  const win = new FakeWindow({});
  win.WORKER_ORIGIN = 'https://x';
  let readiness = null;
  win.__resolvePlaybackHost = (v) => { readiness = v; };
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.localStorage = fakeStorage();
  setGlobalNavigator({});
  globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve([]) });
  const presetsEl = doc.querySelector('.pl-presets');
  presetsEl.addEventListener = () => { throw new Error('injected post-mount wiring failure'); };
  await loadPlaylistBoot();
  assert.equal(win.PLAYLIST_BOOT, undefined);
  assert.ok(readiness, 'must resolve even though the controller that was briefly constructed got destroyed again');
  assert.equal(readiness.mode, 'none');
});

test('readiness resolves to none when required markup is missing, before any controller is ever constructed', async () => {
  const { doc } = playlistDoc();
  doc.getElementById('pl-queue').remove();
  const win = new FakeWindow({});
  let readiness = null;
  win.__resolvePlaybackHost = (v) => { readiness = v; };
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.localStorage = fakeStorage();
  globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve([]) });
  await loadPlaylistBoot();
  assert.equal(win.PLAYLIST_ENGINE_MOUNTED, undefined);
  assert.ok(readiness, 'the auto-run-level backstop must resolve this -- bootPlaylistPage\'s own try/catch never runs (the throw is above it)');
  assert.equal(readiness.mode, 'none');
});

// Codex review finding #2 (same review): the "paused elsewhere" status
// message had no counterpart to legacy's pausedByClaim reset-on-resume, so
// it stayed on screen forever once playback resumed.
test('the "paused elsewhere" status clears once playback resumes after an external claim', async () => {
  const { win, doc, c } = await boot({ hash: '#p=a,b' });
  try {
    await tick();
    c.play(0);
    await tick();
    assert.equal(c.state, 'playing');

    // A second controller on the same page/module claims playback -- the
    // exact mechanism player.js/another PlaybackController uses.
    const other = new PlaybackController({ audio: new FakeAudio(), mediaSession: false });
    other.setQueue([{ id: 'x', streamUrl: 'https://x/x', title: 'X' }], { startIndex: 0, autoplay: true });
    await tick();

    assert.equal(c.audioElement.paused, true, 'the external claim must pause this controller');
    assert.ok(doc.getElementById('pl-status').textContent.includes('Paused'),
      'the paused-elsewhere message must be shown');

    // Resume (a real user action, or the other page giving playback back).
    c.play();
    await tick();
    assert.equal(c.state, 'playing');
    assert.ok(!doc.getElementById('pl-status').textContent.includes('Paused'),
      'the stale paused-elsewhere message must clear once playback actually resumes');

    other.destroy();
  } finally { c.destroy(); }
});

// ── hash hydration ──────────────────────────────────────────────────────
test('hydrates a queue from #p=id,id and cues track 0 without autoplay', async () => {
  const { win, c } = await boot({ hash: '#p=b,d' });
  try {
    assert.deepEqual(c.queue.map((t) => t.id), ['b', 'd']);
    assert.equal(c.currentIndex, 0);
    assert.notEqual(c.state, 'playing', 'hash hydration must not autoplay');
  } finally { c.destroy(); }
});

test('unknown ids in the hash are dropped, known ones still hydrate', async () => {
  const { c } = await boot({ hash: '#p=b,nonexistent,d' });
  try {
    assert.deepEqual(c.queue.map((t) => t.id), ['b', 'd']);
  } finally { c.destroy(); }
});

test('an all-unknown-id hash clears the queue consistently (fixed, not the legacy partial-clear)', async () => {
  const { c, doc } = await boot({ hash: '#p=nope,also-nope' });
  try {
    assert.equal(c.queue.length, 0);
    assert.equal(c.currentIndex, -1);
    assert.ok(doc.getElementById('pl-status').textContent.includes('archive anymore'));
  } finally { c.destroy(); }
});

test('duplicate ids in the hash are deduped before resolving', async () => {
  const { c } = await boot({ hash: '#p=b,b,b,d' });
  try {
    assert.deepEqual(c.queue.map((t) => t.id), ['b', 'd']);
  } finally { c.destroy(); }
});

test('a hash longer than the bound is rejected with a message, not parsed', async () => {
  const hugeId = 'x'.repeat(70000);
  const { c, doc } = await boot({ hash: '#p=' + hugeId });
  try {
    assert.equal(c.queue.length, 0);
    assert.ok(doc.getElementById('pl-status').textContent.includes('too long'));
  } finally { c.destroy(); }
});

test('same-hash reload re-hydrates via the saved-playlist load path (no hashchange fires for an unchanged hash)', async () => {
  const { win, doc, c } = await boot({ hash: '#p=b,d' });
  try {
    const savedEl = doc.getElementById('pl-saved');
    // Simulate: saved playlist row for the same ids, loaded while the hash
    // already matches -- must hydrate explicitly, not rely on 'hashchange'.
    globalThis.localStorage.setItem('savedPlaylists', JSON.stringify([{ name: 'Same', ids: ['b', 'd'], created: 'x' }]));
    const row = new FakeElement('button', ['sr', 'pl-saved-load']);
    row.dataset.i = '0';
    savedEl.appendChild(row);
    // Re-render to pick up the freshly-stored entry, then click it.
    win.dispatch('storage', { key: 'savedPlaylists' });
    const loadBtn = doc.getElementById('pl-saved').querySelectorAll('.pl-saved-load')[0];
    doc.getElementById('pl-saved').dispatch('click', { target: loadBtn });
    assert.deepEqual(c.queue.map((t) => t.id), ['b', 'd'], 'same-hash load must still hydrate');
  } finally { c.destroy(); }
});

// ── saved playlists ──────────────────────────────────────────────────────
test('save writes to the flat savedPlaylists key and renders the saved list', async () => {
  const { win, doc, c } = await boot({ hash: '#p=b,d' });
  try {
    win.prompt = () => 'My set';
    doc.getElementById('pl-save').dispatch('click', {});
    const stored = JSON.parse(globalThis.localStorage.getItem('savedPlaylists'));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].name, 'My set');
    assert.deepEqual(stored[0].ids, ['b', 'd']);
    assert.ok(doc.getElementById('pl-saved').innerHTML.includes('My set'));
  } finally { c.destroy(); }
});

test('a corrupt savedPlaylists value degrades to an empty list without overwriting storage', async () => {
  const { doc, c } = await boot({ storage: { savedPlaylists: '{not json' } });
  try {
    assert.equal(doc.getElementById('pl-saved').innerHTML, '');
    assert.equal(globalThis.localStorage.getItem('savedPlaylists'), '{not json',
      'a corrupt value must be left untouched, not silently overwritten');
  } finally { c.destroy(); }
});

// Codex post-deploy review finding #3 (2026-08-15): MAX_SAVED_PLAYLISTS was
// only enforced in storeSaved() (the write path) -- a stored value that
// already exceeds the bound (stale from before this cap existed, or
// hand-edited) rendered every entry regardless. loadSaved() now caps the
// READ result too.
test('an oversized stored savedPlaylists array is capped when read/rendered, not just when written', async () => {
  const oversized = Array.from({ length: 130 }, (_, i) => (
    { name: 'set-' + i, ids: ['a'], created: new Date().toISOString() }
  ));
  const { doc, c } = await boot({ storage: { savedPlaylists: JSON.stringify(oversized) } });
  try {
    const rendered = doc.getElementById('pl-saved').innerHTML;
    const count = (rendered.match(/pl-saved-row/g) || []).length;
    assert.equal(count, 100, 'render must be capped at MAX_SAVED_PLAYLISTS even though storage holds more');
  } finally { c.destroy(); }
});

test('an oversized playlist name is rejected before writing', async () => {
  const { win, doc, c } = await boot({ hash: '#p=b' });
  try {
    win.prompt = () => 'x'.repeat(200);
    doc.getElementById('pl-save').dispatch('click', {});
    assert.equal(globalThis.localStorage.getItem('savedPlaylists'), null);
    assert.ok(doc.getElementById('pl-status').textContent.includes('too long'));
  } finally { c.destroy(); }
});

test('quota failure on save is surfaced, not silently swallowed', async () => {
  const { win, doc, c } = await boot({ hash: '#p=b' });
  try {
    globalThis.localStorage.setItem = () => { throw new Error('quota exceeded'); };
    win.prompt = () => 'My set';
    doc.getElementById('pl-save').dispatch('click', {});
    assert.ok(doc.getElementById('pl-status').textContent.toLowerCase().includes("couldn't save"));
  } finally { c.destroy(); }
});

// ── endless-mode rollover ────────────────────────────────────────────────
// Math.random is monkey-patched here (restored in `finally`) so the rollover
// reshuffle is provably a DIFFERENT order, not just a same-order replay.
// (Codex post-deploy review finding #5, 2026-08-15: the previous version of
// this test captured `firstOrder` but never asserted against it, so a
// rollover that quietly kept the original order would still have passed.)
// buildQueue()'s shuffleTracks() is a Fisher-Yates over 5 items — 4 calls to
// Math.random() per shuffle. Values just under 1 make every swap index equal
// its own position (j=i, no-op), leaving the pool's natural a/b/c/d/e order;
// values at 0 always swap with index 0, producing a known different order.
function withScriptedRandom(values, fn) {
  const original = Math.random;
  let i = 0;
  Math.random = () => values[i++ % values.length];
  try { return fn(); } finally { Math.random = original; }
}

test('onQueueExhausted rebuilds and reshuffles the queue in endless mode, and keeps playing', async () => {
  const { win, doc, c } = await boot();
  try {
    // Drive mode to 'endless' the same way a real click would: dispatch a
    // chip click on the length panel after it's rendered.
    doc.getElementById('pl-length').dispatch('click', {
      target: Object.assign(new FakeElement('button', ['chip']), { dataset: { group: 'mode', value: 'endless' } }),
    });
    withScriptedRandom([0.999, 0.999, 0.999, 0.999], () => {
      doc.getElementById('pl-generate').dispatch('click', {});
    });
    await tick();
    assert.equal(c.queue.length, 5, 'endless mode queues the whole pool');
    const firstOrder = c.queue.map((t) => t.id);
    assert.deepEqual(firstOrder, ['a', 'b', 'c', 'd', 'e'],
      'sanity check on the scripted-random setup -- near-1 values must leave the pool order unchanged');
    c.play(c.queue.length - 1);
    await tick();
    withScriptedRandom([0, 0, 0, 0], () => {
      c.audioElement.dispatchEvent(new Event('ended'));
    });
    await tick();
    assert.equal(c.currentIndex, 0, 'rollover restarts at index 0');
    assert.equal(c.state, 'playing', 'rollover must keep playing, not stop');
    assert.equal(c.queue.length, 5, 'rollover queue is still the full pool');
    const secondOrder = c.queue.map((t) => t.id);
    assert.notDeepEqual(secondOrder, firstOrder,
      'a real rollover reshuffle must produce a different order, not silently replay the same one');
    assert.deepEqual([...secondOrder].sort(), [...firstOrder].sort(),
      'the reshuffle must still be a permutation of the same pool, not a different set of tracks');
  } finally { c.destroy(); }
});

// Review disposition addition (finding #5, 2026-08-15): the plan calls for
// endless rollover to be proven via all three entry points -- ended, Next,
// and Media Session nexttrack -- since the controller handles them at two
// separate call sites (player-controller.js's 'ended' listener vs.
// _advance()). next() and Media Session's nexttrack handler both funnel
// through the SAME _advance(1) call (verified: player-controller.js's
// mediaSession action handlers register `nexttrack: () => this.next()`), so
// this test exercises the shared code path Media Session's hardware button
// also depends on. It does NOT exercise the browser's actual MediaSession
// API surface (registration, OS lock-screen integration) -- that stays
// browser-only, unverified by any suite in this repo (a prior version of
// this comment incorrectly claimed browser_check.mjs covered it; grepping
// browser_check.mjs for `nexttrack`/`mediaSession` turns up zero matches).
test('next() at the end of an endless queue rolls over the same way ended does', async () => {
  const { doc, c } = await boot();
  try {
    doc.getElementById('pl-length').dispatch('click', {
      target: Object.assign(new FakeElement('button', ['chip']), { dataset: { group: 'mode', value: 'endless' } }),
    });
    doc.getElementById('pl-generate').dispatch('click', {});
    await tick();
    assert.equal(c.queue.length, 5);
    c.play(c.queue.length - 1);
    await tick();
    c.next(); // NOT 'ended' -- the same call Media Session's nexttrack handler makes
    await tick();
    assert.equal(c.currentIndex, 0, 'next() past the end must roll over, same as ended');
    assert.equal(c.state, 'playing', 'rollover via next() must keep playing, not stop');
    assert.equal(c.queue.length, 5);
  } finally { c.destroy(); }
});

test('non-endless mode does NOT roll over -- reaching the end stops', async () => {
  const { doc, c } = await boot();
  try {
    doc.getElementById('pl-generate').dispatch('click', {}); // default mode: songs
    await tick();
    const last = c.queue.length - 1;
    c.play(last);
    await tick();
    c.audioElement.dispatchEvent(new Event('ended'));
    await tick();
    assert.equal(c.state, 'ended', 'songs/minutes mode must stop at the end, not roll over');
  } finally { c.destroy(); }
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
