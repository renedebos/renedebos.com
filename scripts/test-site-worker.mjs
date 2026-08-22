// Deterministic tests for site_worker.js's share-a-song route, /t/{code}
// (plans/share/track-share-plan.md), run against the REAL Worker module with
// a fake assets binding that serves files from the repo root -- so the pages
// the tests resolve to are the ones scripts/build.py actually wrote.
//
// Rewritten 2026-08-22 for §9: /t/{code} used to 302 to a show-page deep link
// and is now a built single-song page the Worker serves directly. The tests
// that asserted the map's lifecycle are gone with the map; what replaces them
// is a test that the map is NEVER fetched on a request path, which is the
// property §9 actually claims.
//
// Run: node scripts/test-site-worker.mjs   (after scripts/build.py)

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const worker = (await import('../site_worker.js')).default;

// One counter for the whole file, as before: any read of the map on a request
// path is a regression regardless of which env saw it.
let mapFetches = 0;
let pageFetches = [];

function fakeEnv() {
  return {
    ASSETS: {
      // The real binding takes a Request, a URL or a string; the Worker
      // passes a Request for pages and a URL for the share page and the 404.
      async fetch(req) {
        const p = (req instanceof URL ? req : new URL(typeof req === 'string' ? req : req.url)).pathname;
        if (p === '/assets/track-links.json') mapFetches++;
        // Only the share branch's OWN fetch, not the generic asset
        // fallthrough that a non-matching /t/... path also produces.
        if (p.startsWith('/t/') && p.endsWith('/index.html')) pageFetches.push(p);
        const file = path.join(ROOT, p);
        try {
          if (statSync(file).isFile()) return new Response(readFileSync(file), { status: 200 });
        } catch (e) { /* not a file */ }
        return new Response('not found', { status: 404 });
      },
    },
    PLAYLISTS: { async get() { return null; }, async put() {} },
  };
}

const links = JSON.parse(readFileSync(path.join(ROOT, 'assets', 'track-links.json'), 'utf8'));
const [code, target] = Object.entries(links)[0];

const get = (env, url, method = 'GET') => worker.fetch(new Request('https://renedebos.com' + url, { method }), env);

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('a known code serves its page as a 200, edge-cacheable for an hour', async () => {
  const env = fakeEnv();
  const r = await get(env, '/t/' + code);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(r.headers.get('Cache-Control'), 'public, max-age=3600');
  assert.ok(r.headers.get('Content-Security-Policy'), 'dynamic responses carry the security headers');
});

test('no redirect hop: the shared link itself is the 200', async () => {
  const env = fakeEnv();
  const r = await get(env, '/t/' + code);
  assert.equal(r.headers.get('Location'), null, 'a share link must not cost a redirect');
});

test('the page served is the page for THAT code', async () => {
  const env = fakeEnv();
  const body = await (await get(env, '/t/' + code)).text();
  assert.ok(body.includes('https://renedebos.com/t/' + code),
    'the page carries its own canonical/share URL');
  assert.ok(body.includes('window.PLAYER_AUTOPLAY = true'),
    'the page a recipient opens to hear one song starts it');
  assert.ok(body.includes('name="robots" content="noindex"'),
    'share pages stay out of the index (§9.3)');
});

test('the show it came from is still one link away', async () => {
  const env = fakeEnv();
  const body = await (await get(env, '/t/' + code)).text();
  // track-links.json still records the deep link; the page must link there.
  const deep = target.replace('?autoplay=1', '');
  assert.ok(body.includes('href="' + deep + '"'),
    `the page links to ${deep} -- focus, not amputation (§9.2)`);
});

test('every built code has a page the Worker can serve', async () => {
  const env = fakeEnv();
  // Sampled, not exhaustive: verify_markup.py checks all 680 at build time
  // both ways. This asserts the Worker's own path reaches them.
  const codes = Object.keys(links);
  for (const c of [codes[0], codes[Math.floor(codes.length / 2)], codes[codes.length - 1]]) {
    assert.equal((await get(env, '/t/' + c)).status, 200, `/t/${c} serves`);
  }
});

test('uppercase, a trailing slash, and HEAD all resolve (chat apps mangle links)', async () => {
  const env = fakeEnv();
  const r1 = await get(env, '/t/' + code.toUpperCase() + '/');
  assert.equal(r1.status, 200);
  const r2 = await get(env, '/t/' + code, 'HEAD');
  assert.equal(r2.status, 200);
  assert.equal(await r2.text(), '', 'HEAD carries no body');
});

test('an unknown code is the branded 404, uncached -- never someone else\'s song', async () => {
  const env = fakeEnv();
  const r = await get(env, '/t/abcdef');
  assert.equal(r.status, 404);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  const body = await r.text();
  assert.ok(body.includes('<!DOCTYPE html>') || body.includes('<html'), 'the 404 page body is served');
});

test('a malformed code never reaches the asset layer as a share page', async () => {
  const env = fakeEnv();
  pageFetches = [];
  const r = await get(env, '/t/not-hex!');
  assert.equal(r.status, 404);
  assert.deepEqual(pageFetches, [],
    'TRACK_RE rejects it before the share branch fetches any page');
});

test('the code -> deep-link map is never on a request path any more (§9.1)', async () => {
  const env = fakeEnv();
  const before = mapFetches;
  await get(env, '/t/' + code);
  await get(env, '/t/abcdef');
  assert.equal(mapFetches, before,
    'assets/track-links.json is a build artifact now, not a routing table');
});

test('/play/ is untouched by the share route', async () => {
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
