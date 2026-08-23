// Deterministic tests for scripts/row-menu.js -- the row overflow menu
// (plans/row-menu/row-menu-plan.md), task 2.
//
// What is pinned here is the CONTRACT, not the markup: which delivery a
// pointer type gets, that the keyboard promises in §5 are real, that a
// download item stays the kind of anchor player.js's delegated listener can
// read, and that a toggle item renders its own state rather than waiting to
// be painted by a load-time pass that will never see it (§7). Every one of
// those is a thing a later "tidy" would quietly undo.
//
// Run: node scripts/test-row-menu.mjs

import assert from 'node:assert/strict';
import { FakeDocument, FakeElement, FakeWindow } from './test-fake-dom.mjs';

const menu = await import('./row-menu.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS - ' + name); passed++; }
  catch (e) { console.log('FAIL - ' + name + ' :: ' + e.message); failed++; }
}

// share.js's popover appends to document.body, and so does this; FakeDocument
// ships without one, same as test-share.mjs found.
function env({ coarse = false } = {}) {
  const win = new FakeWindow({});
  win.matchMedia = () => ({ matches: coarse });
  const timers = [];
  win.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  const doc = new FakeDocument();
  doc.body = new FakeElement('body');
  doc.appendChild(doc.body);
  win.document = doc;
  const trigger = new FakeElement('button', ['row-menu-trigger']);
  doc.body.appendChild(trigger);
  return { win, doc, trigger, deps: { window: win, document: doc },
           flush: () => { while (timers.length) timers.shift()(); } };
}

const SPECS = () => ([
  { label: 'Download', href: 'https://w.example/stream?file=FLAC/x.flac',
    download: '01 Truck.flac', className: 'download-btn',
    dataset: { lossyFile: 'MP3-14/x.mp3', size: '33 MB' } },
  { label: 'Share this song', onSelect: () => {} },
  { label: 'Add to playlist', pressed: true, onSelect: () => {} },
  { kind: 'separator' },
  { kind: 'info', label: 'Track info',
    pairs: [['Venue', '19 Broadway'], ['Format', 'FLAC']] },
]);

function open(e, specs = SPECS()) { return menu.openRowMenu(specs, e.trigger, e.deps); }
function items(e) { return e.doc.body.querySelectorAll('[role="menuitem"]'); }

// ── delivery ──────────────────────────────────────────────────────────────
test('a fine pointer gets the anchored popover', () => {
  const e = env({ coarse: false });
  assert.equal(open(e), 'popover');
  assert.equal(e.doc.body.querySelectorAll('.row-menu-sheet').length, 0);
  assert.equal(e.doc.body.querySelectorAll('.row-menu-dismiss').length, 0);
});

test('a coarse pointer gets the bottom sheet, with an explicit way out', () => {
  const e = env({ coarse: true });
  assert.equal(open(e), 'sheet');
  assert.equal(e.doc.body.querySelectorAll('.row-menu-sheet').length, 1);
  // No Escape key on a phone, and little room outside the sheet to tap.
  assert.equal(e.doc.body.querySelectorAll('.row-menu-dismiss').length, 1);
});

// ── contents ──────────────────────────────────────────────────────────────
test('the download item is a real anchor with its href, download and data-*', () => {
  const e = env();
  open(e);
  const dl = e.doc.body.querySelector('.download-btn');
  // player.js's delegated listener reads btn.href and btn.dataset -- not a
  // data attribute of the menu's own -- so these must survive the move.
  assert.equal(dl.tagName, 'A');
  assert.equal(dl.getAttribute('href'), 'https://w.example/stream?file=FLAC/x.flac');
  assert.equal(dl.getAttribute('download'), '01 Truck.flac');
  assert.equal(dl.dataset.lossyFile, 'MP3-14/x.mp3');
  assert.equal(dl.getAttribute('role'), 'menuitem');
});

test('an action without an href is a real <button type=button>', () => {
  const e = env();
  open(e);
  const share = items(e).find((el) => el.textContent !== 'Download' && el.tagName === 'BUTTON');
  assert.equal(share.getAttribute('type'), 'button');
});

test('a toggle item renders its own pressed state at build time', () => {
  // track-select.js paints row buttons at load; a menu built on first press
  // does not exist then, so it must arrive already correct (plan §7).
  const e = env();
  open(e);
  const add = items(e).find((el) => el.getAttribute('aria-pressed') !== undefined);
  assert.equal(add.getAttribute('aria-pressed'), 'true');
});

test('the info block is a group, not a menuitem -- arrow keys skip it', () => {
  const e = env();
  open(e);
  assert.equal(e.doc.body.querySelectorAll('.row-menu-info').length, 1);
  assert.equal(e.doc.body.querySelector('.row-menu-info').getAttribute('role'), 'group');
  assert.equal(items(e).length, 3);   // download, share, add -- not the info rows
});

// ── the trigger ───────────────────────────────────────────────────────────
test('the trigger carries aria-expanded through open and close', () => {
  const e = env();
  open(e);
  assert.equal(e.trigger.getAttribute('aria-expanded'), 'true');
  menu.closeRowMenu();
  assert.equal(e.trigger.getAttribute('aria-expanded'), 'false');
});

test('pressing the same trigger again closes instead of reopening', () => {
  const e = env();
  open(e);
  assert.equal(menu.openRowMenu(SPECS(), e.trigger, e.deps), '');
  assert.equal(menu.menuIsOpen(), false);
});

// ── keyboard contract (§5) ────────────────────────────────────────────────
test('opening focuses the first item', () => {
  const e = env();
  open(e);
  assert.equal(e.doc.activeElement, items(e)[0]);
});

test('ArrowDown and ArrowUp move and wrap', () => {
  const e = env();
  open(e);
  const list = items(e);
  e.doc.dispatch('keydown', { key: 'ArrowDown', target: list[0], preventDefault() {} });
  assert.equal(e.doc.activeElement, list[1]);
  e.doc.dispatch('keydown', { key: 'ArrowUp', target: list[1], preventDefault() {} });
  assert.equal(e.doc.activeElement, list[0]);
  e.doc.dispatch('keydown', { key: 'ArrowUp', target: list[0], preventDefault() {} });
  assert.equal(e.doc.activeElement, list[list.length - 1], 'wraps to the end');
});

test('Home and End jump to the ends', () => {
  const e = env();
  open(e);
  const list = items(e);
  e.doc.dispatch('keydown', { key: 'End', target: list[0], preventDefault() {} });
  assert.equal(e.doc.activeElement, list[list.length - 1]);
  e.doc.dispatch('keydown', { key: 'Home', target: list[list.length - 1], preventDefault() {} });
  assert.equal(e.doc.activeElement, list[0]);
});

test('Escape closes AND returns focus to the trigger', () => {
  const e = env();
  open(e);
  e.doc.dispatch('keydown', { key: 'Escape', target: items(e)[0] });
  assert.equal(menu.menuIsOpen(), false);
  assert.equal(e.doc.activeElement, e.trigger, 'a keyboard visitor is not dropped at the top of the page');
});

test('Tab closes but does NOT drag focus back to the trigger', () => {
  const e = env();
  open(e);
  e.doc.dispatch('keydown', { key: 'Tab', target: items(e)[0] });
  assert.equal(menu.menuIsOpen(), false);
  assert.notEqual(e.doc.activeElement, e.trigger);
});

// ── dismissal ─────────────────────────────────────────────────────────────
test('an outside click closes without stealing focus back', () => {
  const e = env();
  open(e);
  const elsewhere = new FakeElement('div');
  e.doc.body.appendChild(elsewhere);
  e.doc.dispatch('click', { target: elsewhere });
  assert.equal(menu.menuIsOpen(), false);
  assert.notEqual(e.doc.activeElement, e.trigger);
});

test('scroll closes the anchored popover', () => {
  const e = env({ coarse: false });
  open(e);
  e.win.dispatch('scroll', {});
  assert.equal(menu.menuIsOpen(), false);
});

test('scroll does NOT close the sheet', () => {
  // It is pinned to the viewport, and closing it would fight the finger that
  // opened it (plan §5).
  const e = env({ coarse: true });
  open(e);
  e.win.dispatch('scroll', {});
  assert.equal(menu.menuIsOpen(), true);
});

// ── the download hand-off ─────────────────────────────────────────────────
test('activating an item defers the close, so a delegated handler still sees it', () => {
  // Synchronous teardown would tear the anchor out from under the document
  // listener mid-dispatch, and would hand the password modal a focus fight
  // (plan §5). The menu must still be open when the click finishes bubbling.
  const e = env();
  open(e);
  const dl = e.doc.body.querySelector('.download-btn');
  let openAtDispatch = null;
  e.doc.addEventListener('click', () => { openAtDispatch = menu.menuIsOpen(); });
  dl.dispatch('click', { target: dl, preventDefault() {} });
  assert.equal(openAtDispatch, true, 'still open while the click is bubbling');
  e.flush();
  assert.equal(menu.menuIsOpen(), false, 'closed on the next tick');
});

// ── the item builder (task 3) ─────────────────────────────────────────────
// The fixture is a real data-item, copied from the built page rather than
// invented, so a schema change in fragments.py shows up here.
const ITEM = {
  id: 'jerry-cafe-java-1999-05-27-01',
  kind: 'track',
  streamUrl: 'https://wav-download.renedebos.workers.dev/stream?file=MP3/x.mp3&v=abc',
  title: 'Illegal Smile',
  artist: 'Jerry Hannan',
  venue: 'Cafe Java, Larkspur',
  date: '1999-05-27',
  pageUrl: '/shows/jerry-cafe-java-1999-05-27/#track-1',
  shareUrl: 'https://renedebos.com/t/e0baad/',
  downloads: {
    lossless: { key: 'FLAC/JerryHannan - Cafe Java 1999-05-27/01 Illegal Smile.flac',
                format: 'flac', sizeMb: 33, sizeLabel: '33 MB', title: '01 Illegal Smile.flac' },
    lossy: { key: 'MP3-14/JerryHannan - Cafe Java 1999-05-27/01 Illegal Smile.mp3',
             name: '01 Illegal Smile.mp3', kind: 'loud', sizeLabel: '7 MB' },
  },
  song: { url: '/songs/illegal-smile/', plays: 7, canonical: 'Illegal Smile' },
};
const INFO = [['Artist', 'Jerry Hannan'], ['Format', 'FLAC + MP3']];
const labels = (specs) => specs.filter((x) => x.label).map((x) => x.label);

test('the Download item rebuilds the href player.js parses the key out of', () => {
  const spec = menu.buildRowMenuSpecs(ITEM, INFO, {}).find((x) => x.className === 'download-btn');
  const url = new URL(spec.href);
  assert.equal(url.origin, 'https://wav-download.renedebos.workers.dev', 'origin taken from streamUrl, not hardcoded twice');
  assert.equal(url.pathname, '/stream');
  assert.equal(url.searchParams.get('file'), ITEM.downloads.lossless.key);
  assert.equal(spec.download, '01 Illegal Smile.flac');
  // Deliberately no sub-label: the modal shows format and size before any byte
  // moves, and a second line made this the only two-line row (Rene 2026-08-23).
  assert.equal(spec.sub, undefined);
  assert.match(spec.ariaLabel, /FLAC/, 'format survives in the accessible name');
});

test('the -14 variant rides along as the data-lossy-* the modal reads', () => {
  const spec = menu.buildRowMenuSpecs(ITEM, INFO, {}).find((x) => x.className === 'download-btn');
  assert.equal(spec.dataset.lossyFile, ITEM.downloads.lossy.key);
  assert.equal(spec.dataset.lossyName, '01 Illegal Smile.mp3');
  assert.equal(spec.dataset.lossyKind, 'loud');
  assert.equal(spec.dataset.lossySize, '7 MB');
  assert.equal(spec.dataset.size, '33 MB');
});

test('a track with no variant carries no lossy data at all', () => {
  // What makes the modal HIDE its version chooser rather than offer a dead one.
  const bare = { ...ITEM, downloads: { lossless: ITEM.downloads.lossless, lossy: null } };
  const spec = menu.buildRowMenuSpecs(bare, null, {}).find((x) => x.className === 'download-btn');
  assert.equal(spec.dataset.lossyFile, undefined);
  assert.equal(spec.dataset.lossyKind, undefined);
});

test('a stream-only item gets no Download item', () => {
  const specs = menu.buildRowMenuSpecs({ ...ITEM, downloads: {} }, null, {});
  assert.equal(specs.filter((x) => x.className === 'download-btn').length, 0);
});

test('Add to playlist renders the stored state, and its label follows', () => {
  const opts = { onToggleAdd: () => {}, isSelected: () => true };
  const on = menu.buildRowMenuSpecs(ITEM, null, opts).find((x) => typeof x.pressed === 'boolean');
  assert.equal(on.pressed, true);
  assert.equal(on.label, 'Remove from playlist');
  const off = menu.buildRowMenuSpecs(ITEM, null, { ...opts, isSelected: () => false })
    .find((x) => typeof x.pressed === 'boolean');
  assert.equal(off.label, 'Add to playlist');
});

test('a whole-show recording gets no playlist item', () => {
  // The selection store is keyed on track ids; a recording has none.
  const rec = { ...ITEM, kind: 'recording', song: null };
  const specs = menu.buildRowMenuSpecs(rec, null, { onToggleAdd: () => {}, isSelected: () => false });
  assert.equal(specs.filter((x) => typeof x.pressed === 'boolean').length, 0);
});

test('"All N recordings" is present, pluralised, and links to the song page', () => {
  const spec = menu.buildRowMenuSpecs(ITEM, null, {}).find((x) => /All \d+ recording/.test(x.label));
  assert.equal(spec.label, 'All 7 recordings of this song');
  assert.equal(spec.href, '/songs/illegal-smile/');
  const one = menu.buildRowMenuSpecs({ ...ITEM, song: { ...ITEM.song, plays: 1 } }, null, {})
    .find((x) => /All \d+ recording/.test(x.label));
  assert.equal(one.label, 'All 1 recording of this song');
});

test('"All N recordings" is suppressed on the song\'s own page', () => {
  const specs = menu.buildRowMenuSpecs(ITEM, null, { currentPath: '/songs/illegal-smile/' });
  assert.equal(specs.filter((x) => /All \d+ recording/.test(x.label || '')).length, 0);
});

test('"View show" is suppressed when the row is already on it', () => {
  const away = menu.buildRowMenuSpecs(ITEM, null, { currentPath: '/songs/illegal-smile/' });
  assert.ok(labels(away).includes('View show'));
  const there = menu.buildRowMenuSpecs(ITEM, null, { currentPath: '/shows/jerry-cafe-java-1999-05-27/' });
  assert.ok(!labels(there).includes('View show'), 'trailing slash and #anchor must not fool the comparison');
});

test('provenance is a details PANE, not an inline block', () => {
  // Seven inline rows nearly doubled the menu's height and pushed the desktop
  // popover off the bottom of the live page. Behind a chevron instead.
  const specs = menu.buildRowMenuSpecs(ITEM, INFO, {});
  const det = specs.find((x) => x.kind === 'details');
  assert.equal(det.label, 'Recording details');
  assert.deepEqual(det.pairs, INFO);
  assert.equal(specs.filter((x) => x.kind === 'info').length, 0, 'nothing inline');
});

test('actions and navigation are separated, and only navigation gets a chevron', () => {
  const specs = menu.buildRowMenuSpecs(ITEM, INFO, { currentPath: '/somewhere/else/' });
  const sepAt = specs.findIndex((x) => x.kind === 'separator');
  assert.ok(sepAt > 0, 'a rule divides them');
  assert.ok(specs.slice(0, sepAt).every((x) => !x.navigates), 'actions do not navigate');
  assert.ok(specs.slice(sepAt + 1).every((x) => x.navigates || x.kind === 'details'));
});

test('every action carries an icon from the house set', () => {
  const specs = menu.buildRowMenuSpecs(ITEM, INFO, { onToggleAdd: () => {}, isSelected: () => false });
  const acts = specs.filter((x) => x.label && x.kind !== 'details');
  assert.ok(acts.length >= 3);
  acts.forEach((a) => assert.ok(menu.ICONS[a.icon], `no icon for ${a.label}`));
});

test('specsForRow reads data-item and data-info off a real row', () => {
  const row = new FakeElement('div', ['track-row']);
  row.dataset.item = JSON.stringify(ITEM);
  const title = new FakeElement('span', ['track-title']);
  title.dataset.info = JSON.stringify(INFO);
  row.appendChild(title);
  const specs = menu.specsForRow(row, {});
  assert.ok(labels(specs).includes('Download'));
  assert.deepEqual(specs.find((x) => x.kind === 'details').pairs, INFO);
});

test('a row with unparseable data-item still yields a usable menu', () => {
  const row = new FakeElement('div', ['track-row']);
  row.dataset.item = '{not json';
  const specs = menu.specsForRow(row, {});
  assert.ok(labels(specs).includes('Share this song'), 'never throws mid-render');
});

test('Share hands the item to share.js, anchored to the trigger', () => {
  const seen = [];
  const spec = menu.buildRowMenuSpecs(ITEM, null, { onShare: (i) => seen.push(i) })
    .find((x) => x.label === 'Share this song');
  spec.onSelect();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].shareUrl, ITEM.shareUrl);
});

test('opening Recording details swaps the pane and keeps the menu open', () => {
  const e = env();
  menu.openRowMenu(menu.buildRowMenuSpecs(ITEM, INFO, {}), e.trigger, e.deps);
  const det = items(e).find((el) => el.textContent === '' && el.querySelectorAll('.row-menu-chevron').length
    && el.querySelectorAll('.row-menu-label')[0].textContent === 'Recording details');
  det.dispatch('click', { target: det, preventDefault() {} });
  e.flush();
  assert.equal(menu.menuIsOpen(), true, 'a pane push must not close the menu');
  assert.equal(e.doc.body.querySelectorAll('.row-menu-info').length, 1);
  assert.equal(e.doc.body.querySelectorAll('.row-menu-info-row').length, INFO.length);
});

test('Back returns to the item list', () => {
  const e = env();
  menu.openRowMenu(menu.buildRowMenuSpecs(ITEM, INFO, {}), e.trigger, e.deps);
  const before = items(e).length;
  const det = items(e).filter((el) => el.querySelectorAll('.row-menu-label')[0].textContent === 'Recording details')[0];
  det.dispatch('click', { target: det, preventDefault() {} });
  e.flush();
  const back = items(e)[0];
  assert.equal(back.querySelectorAll('.row-menu-label')[0].textContent, 'Back');
  back.dispatch('click', { target: back, preventDefault() {} });
  e.flush();
  assert.equal(items(e).length, before);
  assert.equal(e.doc.body.querySelectorAll('.row-menu-info').length, 0);
});

test('the sheet says Dismiss', () => {
  const e = env({ coarse: true });
  menu.openRowMenu(menu.buildRowMenuSpecs(ITEM, INFO, {}), e.trigger, e.deps);
  assert.equal(e.doc.body.querySelector('.row-menu-dismiss').textContent, 'Dismiss');
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
