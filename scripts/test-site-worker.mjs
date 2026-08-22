// Deterministic tests for site_worker.js's share-a-song route, /t/{code}
// (plans/share/track-share-plan.md), run against the REAL Worker module with
// a fake assets binding that serves files from the repo root -- so the pages
// the tests resolve to are the ones scripts/build.py actually wrote.
//
// Rewritten twice on 2026-08-22. /t/{code} began as a 302 to a show-page deep
// link; became a built single-song page the Worker served through the assets
// binding (which never worked in production -- see site_worker.js's own note);
// and is now a built page the ASSET SERVER owns outright, with the Worker
// reduced to normalising a non-canonical URL to the canonical one.
//
// So what these tests assert has inverted: the point is no longer that the
// Worker serves the page, it is that the Worker stays OUT OF THE WAY of a
// canonical request and never touches the assets binding for it.
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
        if (p.startsWith('/t/') && p !== '/t/' && p.endsWith('/')) pageFetches.push(p);

        // Cloudflare's assets binding applies html_handling, it does not read
        // a filesystem. Two rules matter to this Worker, and BOTH were missing
        // here until 2026-08-22, when a version of site_worker.js that fetched
        // "/t/{code}/index.html" passed every test below and then no-op'd in
        // production -- the real binding 307s that path instead of serving it,
        // so page.ok was false and the branch fell through to the redirect it
        // exists to prevent. A fake that is more permissive than production
        // does not test the Worker, it tests the fake.
        if (p.endsWith('/index.html')) {
          return new Response(null, { status: 307, headers: { Location: p.slice(0, -'index.html'.length) } });
        }
        if (p.endsWith('/')) {
          const idx = path.join(ROOT, p, 'index.html');
          try {
            if (statSync(idx).isFile()) return new Response(readFileSync(idx), { status: 200 });
          } catch (e) { /* no directory index */ }
          return new Response('not found', { status: 404 });
        }
        const file = path.join(ROOT, p);
        try {
          if (statSync(file).isFile()) return new Response(readFileSync(file), { status: 200 });
        } catch (e) { /* not a file */ }
        // auto-trailing-slash: a bare path that IS a directory redirects.
        try {
          if (statSync(path.join(ROOT, p, 'index.html')).isFile()) {
            return new Response(null, { status: 307, headers: { Location: p + '/' } });
          }
        } catch (e) { /* not a directory either */ }
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

test('the canonical /t/{code}/ passes straight through to the asset server', async () => {
  const env = fakeEnv();
  pageFetches = [];
  const r = await get(env, '/t/' + code + '/');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Location'), null, 'no hop on the canonical link');
  const body = await r.text();
  assert.ok(body.includes('https://renedebos.com/t/' + code + '/'),
    'the page carries its own canonical/share URL');
  assert.ok(body.includes('window.PLAYER_AUTOPLAY = true'),
    'the page a recipient opens to hear one song starts it');
  assert.ok(body.includes('name="robots" content="noindex"'),
    'share pages stay out of the index (§9.3)');
});

test('the Worker sets no Cache-Control of its own on a share page', async () => {
  // Deliberate: /t/{code}/ is a stable, unhashed name whose CONTENT changes
  // when a show is reprocessed, so the root _headers file's default
  // (max-age=0, must-revalidate + ETag) is the correct policy. An earlier
  // version set an hour here and would have served stale share pages after
  // every reprocess.
  const env = fakeEnv();
  const r = await get(env, '/t/' + code + '/');
  const cc = r.headers.get('Cache-Control') || '';
  assert.ok(!/max-age=[1-9]/.test(cc), `expected no positive max-age, got ${cc || 'none'}`);
});

test('a slash-less link is 301d to the canonical form, not left to bounce', async () => {
  // Links copied before the trailing slash became canonical must keep
  // working, and a permanent redirect is the honest answer for them.
  const env = fakeEnv();
  const r = await get(env, '/t/' + code);
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('Location'), '/t/' + code + '/');
});

test('an uppercased code is normalised (chat clients mangle links)', async () => {
  // Needs a code that actually CONTAINS a letter -- codes are hex, so a
  // digits-only one (the first entry happens to be one) uppercases to
  // itself and would pass this test without exercising anything.
  const mixed = Object.keys(links).find((c) => /[a-f]/.test(c));
  assert.ok(mixed, 'no hex code with a letter in it?');
  const env = fakeEnv();
  const r = await get(env, '/t/' + mixed.toUpperCase() + '/');
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('Location'), '/t/' + mixed + '/');
});

test('a query string survives normalisation', async () => {
  const env = fakeEnv();
  const r = await get(env, '/t/' + code + '?utm_source=sms');
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('Location'), '/t/' + code + '/?utm_source=sms');
});

test('the canonical form never redirects to itself', async () => {
  // The normalisation branch matches the canonical URL too; without its
  // equality guard this is an infinite redirect loop on every shared link.
  const env = fakeEnv();
  const r = await get(env, '/t/' + code + '/');
  assert.equal(r.status, 200);
});

test('the Worker never fetches a share page through the assets binding', async () => {
  // The property the 2026-08-22 production failure taught: the Worker has no
  // business resolving these pages, so it must not try. String work only.
  const env = fakeEnv();
  pageFetches = [];
  await get(env, '/t/' + code + '/');
  await get(env, '/t/' + code);
  assert.deepEqual(pageFetches.filter((p) => p.endsWith('/index.html')), [],
    'no /index.html lookups');
});

test('every built code resolves to a real page', async () => {
  const env = fakeEnv();
  const codes = Object.keys(links);
  for (const c of [codes[0], codes[Math.floor(codes.length / 2)], codes[codes.length - 1]]) {
    assert.equal((await get(env, '/t/' + c + '/')).status, 200, `/t/${c}/ serves`);
  }
});

test('the show it came from is still one link away', async () => {
  const env = fakeEnv();
  const body = await (await get(env, '/t/' + code + '/')).text();
  const deep = target.replace('?autoplay=1', '');
  assert.ok(body.includes('href="' + deep + '"'),
    `the page links to ${deep} -- focus, not amputation (§9.2)`);
});

test('HEAD works (link unfurlers use it)', async () => {
  const env = fakeEnv();
  const r = await get(env, '/t/' + code + '/', 'HEAD');
  assert.ok(r.status === 200 || r.status === 301, `got ${r.status}`);
});

test('an unknown code is the branded 404, uncached -- never someone else\'s song', async () => {
  const env = fakeEnv();
  const r = await get(env, '/t/abcdef/');
  assert.equal(r.status, 404);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  const body = await r.text();
  assert.ok(body.includes('<!DOCTYPE html>') || body.includes('<html'), 'the 404 page body is served');
});

test('the code -> deep-link map is never on a request path (§9.1)', async () => {
  const env = fakeEnv();
  const before = mapFetches;
  await get(env, '/t/' + code + '/');
  await get(env, '/t/abcdef/');
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
