// Deterministic tests for scripts/share.js -- what a shared song actually
// hands to the receiving app.
//
// Written 2026-08-22, when Rene asked "possible to not have that text and
// only paste the link?" and it turned out nothing covered share.js at all.
// The payload is a product decision, not an implementation detail: it is the
// difference between a clean link and a link with the song, artist, venue and
// date pasted above it, duplicating the preview the share page's own og: tags
// already render. That is exactly the kind of choice a later refactor
// "tidies" back, so it is pinned here.
//
// Run: node scripts/test-share.mjs

import assert from 'node:assert/strict';
import { FakeDocument, FakeElement, FakeWindow } from './test-fake-dom.mjs';

// FakeDocument has no `body` (nothing else under test appends to it); the
// popover does, so give it one here rather than widening the shared helper
// for a single consumer.
function docWithBody() {
  const doc = new FakeDocument();
  doc.body = new FakeElement('body');
  doc.appendChild(doc.body);
  return doc;
}

const share = await import('./share.js');

const ITEM = {
  title: 'Slave Woman',
  artist: 'Jerry Hannan',
  venue: '19 Broadway, Fairfax',
  date: '2001-01-15',
  shareUrl: 'https://renedebos.com/t/114685/',
  pageUrl: '/shows/jerry-19-broadway-2001-01-15/#track-27',
};

// A touch device with the Web Share API -- the phone path.
function touchDeps(shareCalls) {
  const win = new FakeWindow({});
  win.matchMedia = () => ({ matches: true });
  return {
    window: win,
    document: docWithBody(),
    navigator: { share: (payload) => { shareCalls.push(payload); return Promise.resolve(); } },
  };
}

// A desktop pointer, or no Web Share API -- the popover path.
function desktopDeps(copied) {
  const win = new FakeWindow({});
  win.matchMedia = () => ({ matches: false });
  win.setTimeout = () => {};
  const doc = docWithBody();
  return {
    window: win,
    document: doc,
    navigator: { clipboard: { writeText: (t) => { copied.push(t); return Promise.resolve(); } } },
  };
}

// className is 'share-pop open' once it is shown, so match on the class list
// rather than the whole string.
function findPop(doc) {
  return doc.body.children.find((el) => el.classList.contains('share-pop'));
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('the phone share sheet is handed the URL and NOTHING to paste beside it', async () => {
  const calls = [];
  const mode = share.shareItem(ITEM, null, touchDeps(calls));
  assert.equal(mode, 'sheet');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls.length, 1);
  const payload = calls[0];
  assert.equal(payload.url, ITEM.shareUrl);
  // The whole point. `text` is what targets paste into the message body.
  assert.ok(!('text' in payload),
    'no `text` field -- it would be pasted above the link, duplicating the preview');
});

test('the sheet still carries a title, for targets that use it as a label', async () => {
  const calls = [];
  share.shareItem(ITEM, null, touchDeps(calls));
  await Promise.resolve(); await Promise.resolve();
  assert.match(calls[0].title, /Slave Woman/);
});

test('a dismissed share sheet is not an error', async () => {
  const win = new FakeWindow({});
  win.matchMedia = () => ({ matches: true });
  const deps = {
    window: win, document: docWithBody(),
    navigator: { share: () => Promise.reject(new Error('AbortError')) },
  };
  assert.doesNotThrow(() => share.shareItem(ITEM, null, deps));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
});

test('desktop gets the popover, and Copy link copies the bare URL', async () => {
  const copied = [];
  const deps = desktopDeps(copied);
  const mode = share.shareItem(ITEM, null, deps);
  assert.equal(mode, 'popover');
  const pop = findPop(deps.document);
  assert.ok(pop, 'a .share-pop element is created');
  const copyBtn = pop.querySelector('.share-copy');
  assert.ok(copyBtn, 'the popover offers Copy link');
  copyBtn.dispatch('click', { target: copyBtn });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(copied, [ITEM.shareUrl], 'the URL alone reaches the clipboard');
});

test("the Email option puts the link in the body and the context in the subject", () => {
  const copied = [];
  const deps = desktopDeps(copied);
  share.shareItem(ITEM, null, deps);
  const pop = findPop(deps.document);
  const mail = pop.querySelector('.share-mail');
  assert.ok(mail, 'the popover offers Email');
  const href = mail.getAttribute('href');
  const body = decodeURIComponent((href.match(/body=([^&]*)/) || [])[1] || '');
  const subject = decodeURIComponent((href.match(/subject=([^&]*)/) || [])[1] || '');
  assert.equal(body, ITEM.shareUrl, 'the body is the link alone, not the link under a repeat of the subject');
  assert.match(subject, /Slave Woman/, 'the subject carries the context');
});

test('shareUrlFor prefers shareUrl, falls back to pageUrl, then the site', () => {
  assert.equal(share.shareUrlFor(ITEM), ITEM.shareUrl);
  assert.equal(share.shareUrlFor({ pageUrl: '/shows/x/#track-1' }),
    'https://renedebos.com/shows/x/#track-1');
  assert.equal(share.shareUrlFor({}), 'https://renedebos.com/');
  assert.equal(share.shareUrlFor(null), 'https://renedebos.com/');
});

test('shareText reads as a label, and degrades when fields are missing', () => {
  assert.equal(share.shareText(ITEM),
    'Slave Woman — Jerry Hannan, 19 Broadway, Fairfax, 2001-01-15 · The Hannan Tapes');
  assert.equal(share.shareText({ title: 'Truck' }), 'Truck · The Hannan Tapes');
  assert.equal(share.shareText({}), 'A song · The Hannan Tapes');
});

// placeNear() is shared with the row overflow menu, whose popover is three
// times the height of this one and anchors to a row anywhere in a long list --
// see its own note about the clipping this caught on the live page 2026-08-23.
test('placeNear keeps a tall popover inside the viewport', () => {
  const el = new FakeElement('div');
  el.offsetWidth = 300; el.offsetHeight = 240;
  const anchor = new FakeElement('button');
  anchor._rect = { left: 900, right: 940, top: 760, bottom: 790 };
  share.placeNear(el, anchor, { innerWidth: 1200, innerHeight: 820 });
  const top = parseInt(el.style.top, 10);
  assert.ok(top + 240 <= 820 - 8, `must stay on screen, got top=${top}`);
  assert.ok(top >= 8, 'and not run off the top either');
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

