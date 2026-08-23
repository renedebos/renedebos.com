// The row overflow menu -- one "…" per track row (plans/row-menu/row-menu-plan.md).
//
// Everything except play lives behind it, download included. That was Rene's
// call over my objection (§2 of the plan records both sides); the argument
// that settles it is not tidiness but reach: three of the six things this
// menu holds are today either hover-only or nowhere at all, and `data-info`'s
// seven fields of provenance have never once opened on a touch device.
//
// Two deliveries, chosen by pointer type rather than by browser -- the same
// call share.js already makes:
//   - coarse pointer -> a bottom sheet, thumb-reachable and full width. An
//     anchored popover near the top of a long list is not reachable.
//   - fine pointer   -> a popover anchored to the trigger.
//
// Built ON share.js's popover, not beside it: placeNear() is its geometry and
// attachDismiss() its outside-click/Escape wiring, both exported for this.
// Importing share.js is free here in the way that matters -- the menu's Share
// item calls into it anyway, so the module is needed on this path regardless.
//
// Loaded lazily on the first press of a trigger, as share.js is.

import { placeNear, attachDismiss, shareItem } from './share.js';

// The sheet is chosen on pointer type ALONE -- unlike share.js's wantsSheet(),
// which also requires navigator.share because the sheet it means is the
// SYSTEM one. This sheet is ours; nothing about it needs a platform API.
export function wantsSheet(win) {
  try {
    return !!(win && win.matchMedia && win.matchMedia('(pointer: coarse)').matches);
  } catch (e) {
    return false;
  }
}

// ── icons ─────────────────────────────────────────────────────────────────
// Drawn to match the set already in sitegen/fragments.py (DL_SVG, SHARE_SVG,
// OPEN_SVG, PLUS_SVG): 24x24 viewBox, fill:none, stroke:currentColor,
// stroke-width 2, round caps. Deliberately NOT lifted from another icon
// library -- a menu that mixes two drawing conventions reads as borrowed, and
// this one sits beside those existing glyphs on the same page.
const SVG = (d) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + d + '</svg>';
export const ICONS = {
  download: SVG('<path d="M12 4v13"/><path d="M6 12l6 6 6-6"/><path d="M8 21h8"/>'),
  playlist: SVG('<path d="M3 6h11M3 12h11M3 18h7"/><path d="M18 13v8M14 17h8"/>'),
  share: SVG('<path d="M12 3v13"/><path d="M8 7l4-4 4 4"/>'
             + '<path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>'),
  show: SVG('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/>'),
  song: SVG('<path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>'),
  info: SVG('<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5v.5"/>'),
  chevron: SVG('<path d="M9 5l7 7-7 7"/>'),
  back: SVG('<path d="M15 19l-7-7 7-7"/>'),
};

// ── the one menu-item builder ─────────────────────────────────────────────
// Fed from the row's own data-item plus data-info, so all three renderers
// (show_track_row and _song_occ_html in sitegen/fragments.py, occRowHtml in
// songs.js) get identical menus without any of them deciding contents.
//
// The plan guessed no new plumbing would be needed here. That was wrong in two
// places, both now fixed at the source rather than worked around:
//   - the -14 download's key/name/size lived ONLY on the .download-btn's
//     data-lossy-* attributes -- the very element task 4 deletes. It is now
//     item.downloads.lossy.
//   - "All N recordings" needs a song slug and a play count, which the item
//     did not carry at all and which cannot be derived in the browser
//     (song_slug() normalises parentheticals and a leading "the", canonical
//     titles come from override tables, colliding slugs get "-x"). It is now
//     item.song, from core.song_index().

// player.js reads the key back out of the href with
// `new URL(btn.href).searchParams.get('file')`, so the Download item has to be
// a real anchor with a real query string. The worker origin is taken from the
// item's own streamUrl rather than hardcoded a second time -- there is already
// one copy of that constant in player.js and it does not need a rival.
function downloadHref(item, key) {
  let origin = '';
  try { origin = new URL(item.streamUrl).origin; } catch (e) { origin = ''; }
  return origin + '/stream?file=' + encodeURIComponent(key);
}

function samePath(a, b) {
  if (!a || !b) return false;
  const strip = (p) => String(p).split('#')[0].replace(/\/+$/, '');
  return strip(a) === strip(b);
}

export function buildRowMenuSpecs(item, info, opts = {}) {
  const specs = [];
  const dl = (item && item.downloads) || {};
  const path = opts.currentPath || '';

  if (dl.lossless && dl.lossless.key) {
    const fmt = String(dl.lossless.format || '').toUpperCase();
    const dataset = {};
    if (dl.lossless.sizeLabel) dataset.size = dl.lossless.sizeLabel;
    // The modal turns these into its Archive/Loud (or Archive/MP3) chooser.
    // Absent on a track with no variant, which is what makes it hide the
    // control rather than offer a dead option.
    if (dl.lossy && dl.lossy.key) {
      dataset.lossyFile = dl.lossy.key;
      dataset.lossyName = dl.lossy.name;
      dataset.lossyKind = dl.lossy.kind;
      if (dl.lossy.sizeLabel) dataset.lossySize = dl.lossy.sizeLabel;
    }
    // No sub-label. Format and size both appear in the password modal, which
    // opens before any byte moves, so repeating them here bought nothing and
    // made Download the only two-line row among six single-line ones (Rene,
    // 2026-08-23). The format survives in the accessible name, where a screen
    // reader user has no dialog to look ahead to.
    specs.push({
      label: 'Download',
      icon: 'download',
      href: downloadHref(item, dl.lossless.key),
      download: dl.lossless.title,
      className: 'download-btn',
      ariaLabel: 'Download ' + (fmt || 'file') + ' (password protected)',
      dataset,
    });
  }

  // Whole-show recordings are not playlist material -- the selection store is
  // keyed on track ids.
  if (item && item.kind === 'track' && item.id && opts.onToggleAdd) {
    const selected = !!(opts.isSelected && opts.isSelected(item.id));
    specs.push({
      label: selected ? 'Remove from playlist' : 'Add to playlist',
      icon: 'playlist',
      pressed: selected,
      onSelect: () => opts.onToggleAdd(item.id),
    });
  }

  specs.push({
    label: 'Share this song',
    icon: 'share',
    // Anchored to the TRIGGER, not to this item: the menu is on its way out by
    // the time the popover paints, and a popover pinned to something hidden
    // lands in the wrong place.
    onSelect: () => (opts.onShare
      ? opts.onShare(item)
      : shareItem(item, opts.anchor || null)),
  });

  // Everything below NAVIGATES rather than acts, so it sits under a rule and
  // each row carries a chevron (the one convention worth taking wholesale from
  // the Amazon Music sheet Rene sent, 2026-08-23).
  const nav = [];

  // "View show" -- the ↗ a song row carries today, suppressed when the row is
  // already on that show page.
  if (item && item.pageUrl && !samePath(path, item.pageUrl)) {
    nav.push({ label: 'View show', icon: 'show', navigates: true, href: item.pageUrl });
  }

  // No Amazon analogue, and the best thing this archive has that a streaming
  // service does not: the same song across nineteen different nights.
  if (item && item.song && item.song.url && !samePath(path, item.song.url)) {
    const n = item.song.plays;
    nav.push({
      label: 'All ' + n + ' recording' + (n === 1 ? '' : 's') + ' of this song',
      icon: 'song',
      navigates: true,
      href: item.song.url,
    });
  }

  // The reason this menu exists at all: seven fields of provenance bound to
  // mouseover in player.js, which has never once opened on a touch device.
  // A pane behind a chevron, not an inline block -- see renderPane()'s note.
  if (info && info.length) {
    nav.push({ kind: 'details', label: 'Recording details', icon: 'info', pairs: info });
  }

  if (nav.length) {
    specs.push({ kind: 'separator' });
    nav.forEach((n) => specs.push(n));
  }
  return specs;
}

// Provenance derived from the item itself, for callers with no row to read --
// the mini-player bar on a /t/ share page or /playlist/, where the playing
// track has no row on the page at all.
//
// Deliberately SHORTER than a row's data-info: "Process version" lives only in
// the build's own tables and never reached the item, so this does not invent
// it. Fewer true rows beats seven rows one of which is a guess.
export function infoFromItem(item) {
  if (!item) return null;
  const dl = item.downloads || {};
  const sizes = [];
  if (dl.lossless && dl.lossless.sizeLabel) {
    sizes.push(String(dl.lossless.format || '').toUpperCase() + ' ' + dl.lossless.sizeLabel);
  }
  if (dl.lossy && dl.lossy.sizeLabel) sizes.push('MP3 ' + dl.lossy.sizeLabel);
  const pairs = [
    ['Artist', item.artist],
    ['Song', item.title],
    ['Venue', item.venue],
    ['Date', item.dateDisplay || item.date],
    ['Duration', item.durationLabel],
    ['Size', sizes.join(' \u00b7 ')],
  ].filter((p) => p[1]);
  return pairs.length ? pairs : null;
}

// Builds a menu from an ITEM rather than a row -- the entry point for the
// mini-player bar, which paints one item and has no row of its own.
//
// Prefers the page's own row for that item when there is one, so the bar and
// the row show byte-identical provenance rather than two nearly-alike lists,
// and falls back to infoFromItem() where no such row exists.
export function specsForItem(item, opts = {}) {
  const doc = opts.document || (typeof document !== 'undefined' ? document : null);
  let info = null;
  if (doc && item && item.id) {
    const rows = doc.querySelectorAll('.track-row[data-item]');
    for (let i = 0; i < rows.length; i++) {
      let it = null;
      try { it = JSON.parse(rows[i].dataset.item); } catch (e) { continue; }
      if (it && it.id === item.id) {
        const el = rows[i].querySelector('[data-info]');
        if (el) { try { info = JSON.parse(el.dataset.info); } catch (e) { info = null; } }
        break;
      }
    }
  }
  if (!info) info = infoFromItem(item);
  return buildRowMenuSpecs(item, info, opts);
}

// Reads both attributes off a row and builds its menu. The row is the unit the
// three renderers agree on, so this is the entry point task 4 calls.
export function specsForRow(rowEl, opts = {}) {
  let item = {}, info = null;
  try { item = JSON.parse(rowEl.dataset.item || '{}'); } catch (e) { item = {}; }
  const infoEl = rowEl.querySelector('[data-info]');
  if (infoEl) { try { info = JSON.parse(infoEl.dataset.info); } catch (e) { info = null; } }
  return buildRowMenuSpecs(item, info, opts);
}

let menu = null;          // one element per document, reused
let menuDoc = null;
let openTrigger = null;   // the button whose aria-expanded we own while open

export function menuIsOpen() {
  return !!(menu && menu.classList.contains('open'));
}

function ensureMenu(doc, win) {
  if (menu && menuDoc === doc) return menu;
  menu = doc.createElement('div');
  menu.className = 'row-menu';
  menu.setAttribute('role', 'menu');
  menuDoc = doc;
  doc.body.appendChild(menu);
  attachDismiss(doc, win, {
    isOpen: menuIsOpen,
    // The trigger is in `within` so that pressing it again reaches the toggle
    // in openRowMenu() instead of being closed here first and re-opened by
    // the same click.
    // '.mp-menu' is the mini-player bar's trigger. Listed for the same reason
    // the row's is: without it the press that toggles the menu shut would be
    // read as a click outside and close it first, so it would reopen instead.
    within: ['.row-menu', '.row-menu-trigger', '.mp-menu'],
    // An anchored popover must die when its anchor scrolls out from under it;
    // a sheet pinned to the viewport must NOT, or it fights the finger that
    // opened it (plan §5). The delivery is decided per open, so the exemption
    // is checked at fire time rather than by re-wiring the listener.
    //
    // Escape is the one dismissal that hands focus back to the trigger: an
    // outside click has already put focus somewhere deliberate, and a resize
    // is not a focus event at all.
    onDismiss: (reason) => {
      if (reason === 'scroll' && scrollExempt()) return;
      closeRowMenu({ returnFocus: reason === 'escape' });
    },
    closeOnScroll: true,
  });
  doc.addEventListener('keydown', onKeydown);
  return menu;
}

// Scroll-close applies to the anchored popover only. Registered once, so the
// sheet exempts itself here rather than by re-wiring on every open.
function scrollExempt() {
  return menu && menu.classList.contains('row-menu-sheet');
}

function items() {
  return menu ? menu.querySelectorAll('[role="menuitem"]') : [];
}

function onKeydown(e) {
  if (!menuIsOpen()) return;
  const list = Array.prototype.slice.call(items());
  if (!list.length) return;
  const at = list.indexOf(e.target);
  const focus = (el) => { if (el && el.focus) el.focus(); };
  if (e.key === 'ArrowDown') {
    if (e.preventDefault) e.preventDefault();
    focus(list[at < 0 || at === list.length - 1 ? 0 : at + 1]);
  } else if (e.key === 'ArrowUp') {
    if (e.preventDefault) e.preventDefault();
    focus(list[at <= 0 ? list.length - 1 : at - 1]);
  } else if (e.key === 'Home') {
    if (e.preventDefault) e.preventDefault();
    focus(list[0]);
  } else if (e.key === 'End') {
    if (e.preventDefault) e.preventDefault();
    focus(list[list.length - 1]);
  } else if (e.key === 'Tab') {
    // Tabbing out of a menu closes it -- but let the Tab itself through, so
    // focus lands where the visitor asked rather than back on the trigger.
    closeRowMenu({ returnFocus: false });
  }
  // Escape is attachDismiss's, so one handler owns it for both components --
  // but the MENU must hand focus back to its trigger, which is why
  // closeRowMenu's default does that and the outside-click path opts out.
}

let rootSpecs = [];

// Never restructure this menu while a click on it is still bubbling.
//
// Found the hard way on 2026-08-23: swapping panes synchronously ORPHANS the
// item that was clicked, so by the time the document-level dismiss handler
// runs, `e.target.closest('.row-menu')` walks a detached node, finds no menu,
// concludes the click was outside, and closes everything -- the pane opens and
// vanishes in the same tick. Exactly the mechanism behind the 2026-08-22
// row-click double-fire (see test-fake-dom.mjs's innerHTML note), and the
// reason item activation already defers its close. Deferring the swap too
// keeps the whole component to one rule: the DOM changes after the event, not
// during it.
function defer(win, fn) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  if (w && w.setTimeout) w.setTimeout(fn, 0); else fn();
}

// One pane of the menu. The menu can show two: its item list, and the
// Recording-details pane behind that list's last item. A second pane rather
// than an inline block because seven rows of provenance nearly DOUBLED the
// menu's height -- measured on the live page, where it pushed the desktop
// popover off the bottom of the viewport -- and because a chevron that opens
// a pane is the convention every music app's visitors already know.
function renderPane(doc, win, el, specs, sheet) {
  while (el.children.length) el.children[0].remove();
  (specs || []).forEach((spec) => {
    if (!spec) return;
    if (spec.kind === 'info') { el.appendChild(makeInfo(doc, spec)); return; }
    if (spec.kind === 'separator') {
      const hr = doc.createElement('div');
      hr.className = 'row-menu-sep';
      el.appendChild(hr);
      return;
    }
    if (spec.kind === 'details') {
      el.appendChild(makeItem(doc, {
        label: spec.label, icon: spec.icon || 'info', navigates: true, keepOpen: true,
        onSelect: () => defer(win, () => showDetails(doc, win, el, spec, sheet)),
      }, { window: win }));
      return;
    }
    el.appendChild(makeItem(doc, spec, { window: win }));
  });
  if (sheet) {
    // A sheet needs an explicit way out: on a phone there is no Escape key and
    // little room outside it to tap. Plain centred text, not a bordered
    // button -- it is a way out, not a ninth action competing for the eye.
    const dismiss = doc.createElement('button');
    dismiss.className = 'row-menu-dismiss';
    dismiss.setAttribute('type', 'button');
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => closeRowMenu());
    el.appendChild(dismiss);
  }
  const first = el.querySelector('[role="menuitem"]');
  if (first && first.focus) first.focus();
}

function showDetails(doc, win, el, spec, sheet) {
  renderPane(doc, win, el, [
    { label: 'Back', icon: 'back', keepOpen: true,
      onSelect: () => defer(win, () => renderPane(doc, win, el, rootSpecs, sheet)) },
    { kind: 'info', label: spec.label, pairs: spec.pairs },
  ], sheet);
}

function makeItem(doc, spec, deps) {
  // An <a> when there is an href, so the no-JavaScript answer still works and
  // so player.js's delegated download listener sees a real anchor with a real
  // href -- that listener reads btn.href and btn.dataset, not a data attribute
  // of our own (see task 1, and plan §4).
  const el = doc.createElement(spec.href ? 'a' : 'button');
  el.className = 'row-menu-item' + (spec.className ? ' ' + spec.className : '');
  el.setAttribute('role', 'menuitem');
  if (spec.href) {
    el.setAttribute('href', spec.href);
    if (spec.download) el.setAttribute('download', spec.download);
  } else {
    el.setAttribute('type', 'button');
  }
  // A toggle item (Add to playlist) renders its own state at BUILD time. It
  // cannot be painted afterwards the way track-select.js paints row buttons:
  // syncAllButtons() runs at load over elements that exist, and a menu built
  // on first press does not exist then (plan §7). Silent if missed -- the
  // item would read "Add" for an already-selected track.
  if (typeof spec.pressed === 'boolean') el.setAttribute('aria-pressed', String(spec.pressed));
  if (spec.ariaLabel) el.setAttribute('aria-label', spec.ariaLabel);
  if (spec.dataset) {
    Object.keys(spec.dataset).forEach((k) => { el.dataset[k] = spec.dataset[k]; });
  }
  // Icon first, then the text column, then a trailing chevron on anything
  // that NAVIGATES rather than acts -- the one convention in the Amazon sheet
  // doing real work: it tells you before you press whether the menu is about
  // to do something or take you somewhere.
  if (spec.icon && ICONS[spec.icon]) {
    const ic = doc.createElement('span');
    ic.className = 'row-menu-icon';
    ic.innerHTML = ICONS[spec.icon];
    el.appendChild(ic);
  }
  const text = doc.createElement('span');
  text.className = 'row-menu-text';
  const label = doc.createElement('span');
  label.className = 'row-menu-label';
  label.textContent = spec.label;
  text.appendChild(label);
  if (spec.sub) {
    const sub = doc.createElement('span');
    sub.className = 'row-menu-sub';
    sub.textContent = spec.sub;
    text.appendChild(sub);
  }
  el.appendChild(text);
  if (spec.navigates) {
    const ch = doc.createElement('span');
    ch.className = 'row-menu-chevron';
    ch.innerHTML = ICONS.chevron;
    el.appendChild(ch);
  }
  el.addEventListener('click', (e) => {
    if (spec.onSelect) {
      if (e.preventDefault) e.preventDefault();
      spec.onSelect(e, spec);
    }
    // Deferred, never synchronous. Two reasons, both real:
    //  - a download item is an <a class="download-btn"> whose handler lives on
    //    document; tearing the menu down mid-dispatch is the kind of thing
    //    that works until it doesn't;
    //  - the password modal is itself a dialog, and two focus owners must not
    //    overlap (plan §5). The menu is gone before the modal takes focus.
    // A spec that opens a second pane inside this menu keeps it open; only
    // terminal actions tear it down.
    if (spec.keepOpen) return;
    defer((deps && deps.window) || null, () => closeRowMenu({ returnFocus: false }));
  });
  return el;
}

function makeInfo(doc, spec) {
  // Not a menuitem: arrow keys must skip it, and there is nothing to activate.
  const group = doc.createElement('div');
  group.className = 'row-menu-info';
  group.setAttribute('role', 'group');
  if (spec.label) group.setAttribute('aria-label', spec.label);
  (spec.pairs || []).forEach((pair) => {
    const row = doc.createElement('div');
    row.className = 'row-menu-info-row';
    const k = doc.createElement('span');
    k.className = 'row-menu-info-key';
    k.textContent = pair[0];
    const v = doc.createElement('span');
    v.className = 'row-menu-info-val';
    v.textContent = pair[1];
    row.appendChild(k);
    row.appendChild(v);
    group.appendChild(row);
  });
  return group;
}

// `specs` is the menu's contents, already decided by the caller -- this module
// renders and drives, it does not know what a track is. Returns which delivery
// ran ('sheet' | 'popover'), or '' if the same trigger toggled it shut.
export function openRowMenu(specs, triggerEl, deps = {}) {
  const win = deps.window || window;
  const doc = deps.document || win.document;
  const el = ensureMenu(doc, win);

  // Toggle: the same trigger pressed twice closes, like share.js's popover.
  if (menuIsOpen() && openTrigger === triggerEl) {
    closeRowMenu();
    return '';
  }

  rootSpecs = specs || [];
  const sheet = wantsSheet(win);
  el.className = 'row-menu' + (sheet ? ' row-menu-sheet' : '');
  el.setAttribute('aria-label', deps.label || 'Track options');
  renderPane(doc, win, el, rootSpecs, sheet);

  openTrigger = triggerEl || null;
  if (openTrigger && openTrigger.setAttribute) openTrigger.setAttribute('aria-expanded', 'true');
  el.classList.add('open');
  // The sheet is positioned by CSS (fixed to the foot of the viewport); only
  // the anchored popover needs geometry.
  if (!sheet) placeNear(el, triggerEl, win);
  return sheet ? 'sheet' : 'popover';
}

// `returnFocus` defaults true: Escape and an explicit Close must put focus
// back on the trigger, or a keyboard visitor is dropped at the top of the
// document. An outside CLICK already moved focus somewhere deliberate, so
// those paths pass false.
export function closeRowMenu(opts = {}) {
  if (!menu) return;
  const wasOpen = menuIsOpen();
  menu.classList.remove('open');
  const trigger = openTrigger;
  openTrigger = null;
  if (trigger && trigger.setAttribute) trigger.setAttribute('aria-expanded', 'false');
  if (wasOpen && opts.returnFocus !== false && trigger && trigger.focus) trigger.focus();
}
