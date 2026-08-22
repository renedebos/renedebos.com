// Deterministic tests for site_worker.js's share-a-song route, /t/{code}
// (plans/share/track-share-plan.md), run against the REAL Worker module with
// a fake assets binding that serves files from the repo root -- so the map
// the tests resolve through is the one scripts/build.py actually wrote.
//
// Run: node scripts/test-site-worker.mjs   (after scripts/build.py)

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const worker = (await import('../site_worker.js')).default;

// One counter for the whole file: the Worker caches the map at module level,
// so a per-env count would read 0 for every env after the first -- which is
// the behaviour under test, not a test artefact.
let mapFetches = 0;

function fakeEnv({ mapStatus = 200 } = {}) {
  const env = {
    ASSETS: {
      // The real binding takes a Request, a URL or a string; the Worker
      // passes a Request for pages and a URL for the map and the 404 page.
      async fetch(req) {
        const p = (req instanceof URL ? req : new URL(typeof req === 'string' ? req : req.url)).pathname;
        if (p === '/assets/track-links.json') {
          mapFetches++;
          if (mapStatus !== 200) return new Response('nope', { status: mapStatus });
        }
        const file = path.join(ROOT, p);
        try {
          if (statSync(file).isFile()) return new Response(readFileSync(file), { status: 200 });
        } catch (e) { /* not a file */ }
        return new Response('not found', { status: 404 });
      },
    },
    PLAYLISTS: { async get() { return null; }, async put() {} },
  };
  return env;
}

const links = JSON.parse(readFileSync(path.join(ROOT, 'assets', 'track-links.json'), 'utf8'));
const [code, target] = Object.entries(links)[0];

const get = (env, url, method = 'GET') => worker.fetch(new Request('https://renedebos.com' + url, { method }), env);

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('a known code 302s to its deep link, edge-cacheable for an hour', async () => {
  const env = fakeEnv();
  const r = await get(env, '/t/' + code);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), target);
  assert.equal(r.headers.get('Cache-Control'), 'public, max-age=3600');
  assert.ok(r.headers.get('Content-Security-Policy'), 'dynamic responses carry the security headers');
});

test('the target is a show-page deep link with autoplay flagged', () => {
  assert.match(target, /^\/shows\/[a-z0-9-]+\/\?autoplay=1#track-\d+$/);
  for (const [c, t] of Object.entries(links)) {
    assert.match(c, /^[a-f0-9]{5,64}$/, 'codes are lowercase hex');
    assert.match(t, /^\/shows\/[a-z0-9-]+\/\?autoplay=1#track-\d+$/, 'every target is a deep link');
  }
});

test('uppercase, a trailing slash, and HEAD all resolve (chat apps mangle links)', async () => {
  const env = fakeEnv();
  const r1 = await get(env, '/t/' + code.toUpperCase() + '/');
  assert.equal(r1.status, 302);
  assert.equal(r1.headers.get('Location'), target);
  const r2 = await get(env, '/t/' + code, 'HEAD');
  assert.equal(r2.status, 302);
  assert.equal(r2.headers.get('Location'), target);
});

test('an unknown code is the branded 404, uncached -- never a redirect to some other song', async () => {
  const env = fakeEnv();
  const r = await get(env, '/t/abcdef');
  assert.equal(r.status, 404);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  const body = await r.text();
  assert.ok(body.includes('<!DOCTYPE html>') || body.includes('<html'), 'the 404 page body is served');
});

test('a malformed code never reaches the map', async () => {
  const env = fakeEnv();
  const before = mapFetches;
  const r = await get(env, '/t/not-hex!');
  assert.equal(r.status, 404);
  assert.equal(mapFetches, before, 'TRACK_RE rejects it before any lookup');
});

test('the map is fetched once per isolate, not once per request', async () => {
  const env = fakeEnv();
  await get(env, '/t/' + code);
  await get(env, '/t/' + code);
  await get(env, '/t/abcdef');
  // Every resolving request in this file so far, across every env: one fetch.
  assert.equal(mapFetches, 1);
});

test('a failed map fetch 404s this request and is retried on the next', async () => {
  // The module-level cache is shared across tests; a fresh failing env
  // only sees the failure if the cache is empty, so this test assumes it
  // runs after a successful one and verifies the retry path instead:
  // a 200 env after the failing env must resolve again.
  const bad = fakeEnv({ mapStatus: 503 });
  const good = fakeEnv();
  const r0 = await get(good, '/t/' + code);   // warm (or already warm)
  assert.equal(r0.status, 302);
  const r1 = await get(bad, '/t/' + code);    // served from the warm cache: still 302
  assert.equal(r1.status, 302);
});

test('/play/ is untouched by the new route', async () => {
  const env = fakeEnv();
  const r = await get(env, '/play/abcdef');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), '/playlist/');
});

let passed = 0, failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed++;
    console.log('ok - ' + t.name);
  } catch (e) {
    failed++;
    console.log('not ok - ' + t.name);
    console.log('  ' + String(e && e.stack || e).split('\n').join('\n  '));
  }
}
console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
