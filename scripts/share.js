// Share one performance (plans/share/track-share-plan.md).
//
// The link is the item's short share URL -- `shareUrl`, a build output of the
// form https://renedebos.com/t/{code} that site_worker.js resolves to the
// performance's deep link -- or, for an item without one (a whole-show
// recording, a restored session from before codes existed), its page link.
//
// Two deliveries, chosen by the device rather than by the browser:
//   - a touch device with the Web Share API gets the system sheet (Messages,
//     WhatsApp, Mail, copy -- whatever the phone offers). It is handed the
//     URL alone: the receiving app renders the song, artist, venue and date
//     from the share page's own og: tags, so anything sent alongside the
//     link only duplicates the preview;
//   - everything else gets a two-row popover anchored to the button: Copy
//     link, then Email. Desktop Chrome and Safari also expose navigator.share,
//     but their OS share dialogs bury "copy", which is the thing a desktop
//     visitor wants (the stated use was pasting into an email).
//
// Loaded lazily by miniplayer-views.js on the first press of the bar's share
// button, so pages where nobody shares never fetch it. No imports: this file
// must stay free-standing for that to hold.

const SITE_NAME = 'The Hannan Tapes';
const ORIGIN = 'https://renedebos.com';

export function shareUrlFor(item) {
  if (item && item.shareUrl) return String(item.shareUrl);
  if (item && item.pageUrl) {
    try { return new URL(item.pageUrl, ORIGIN).href; } catch (e) { /* fall through */ }
  }
  return ORIGIN + '/';
}

// "Truck — Jerry Hannan, 19 Broadway, 1999-02-01 · The Hannan Tapes"
//
// A LABEL, not body content. It is the share sheet's title and the email
// subject; it is deliberately never sent as text a target will paste beside
// the link. See shareItem() for why.
export function shareText(item) {
  const who = [item && item.artist, item && item.venue, item && (item.dateDisplay || item.date)]
    .filter(Boolean).join(', ');
  const title = (item && item.title) || 'A song';
  return (who ? title + ' — ' + who : title) + ' · ' + SITE_NAME;
}

function wantsSheet(nav, win) {
  if (!nav || typeof nav.share !== 'function') return false;
  try {
    return !!(win.matchMedia && win.matchMedia('(pointer: coarse)').matches);
  } catch (e) {
    return false;
  }
}

// Returns which delivery ran ('sheet' | 'popover'), for tests and callers
// that want to know; the UI itself is a side effect.
export function shareItem(item, anchorEl, deps = {}) {
  const win = deps.window || window;
  const doc = deps.document || win.document;
  const nav = deps.navigator || win.navigator;
  const url = shareUrlFor(item);
  const text = shareText(item);
  if (wantsSheet(nav, win)) {
    // `url` and `title` only -- NO `text` field (removed 2026-08-22, Rene:
    // "possible to not have that text and only paste the link?"). Most
    // targets paste `text` and `url` together, so passing both put the song,
    // artist, venue and date in the message body ahead of the link.
    //
    // That was defensible when a shared link was a bare URL with nothing
    // behind it. It stopped being defensible once the share page carried its
    // own og: tags: Facebook, Messages and the rest now render exactly that
    // information themselves, from the page, so the text was duplicating the
    // preview immediately below it.
    //
    // `title` stays because targets use it as a label or subject rather than
    // as body content -- and most ignore it entirely.
    //
    // The cost, accepted: on a target that does NOT unfurl (plain SMS, some
    // mail clients) the recipient now gets a bare link with no context.
    // A rejected share (the user dismissed the sheet) is not an error.
    Promise.resolve().then(() => nav.share({ title: text, url })).catch(() => {});
    return 'sheet';
  }
  openPopover(doc, win, nav, anchorEl, url, text);
  return 'popover';
}

// ── dismissal, shared with the row overflow menu ──────────────────────────
// Outside-click, Escape, and (for anchored things only) scroll/resize. Wired
// once per document by the caller that owns the element.
//
// `closeOnScroll` is a parameter rather than a constant because the two
// callers genuinely differ: an ANCHORED popover must go away when its anchor
// scrolls out from under it, while the row menu's bottom sheet is fixed to
// the viewport and closing it on scroll would fight the finger that opened it
// (plans/row-menu/row-menu-plan.md §5).
export function attachDismiss(doc, win, opts) {
  const isOpen = opts.isOpen;
  const within = opts.within || [];
  const onDismiss = opts.onDismiss;
  const closeOnScroll = opts.closeOnScroll !== false;
  doc.addEventListener('click', (e) => {
    if (!isOpen()) return;
    if (e.target.closest && within.some((sel) => e.target.closest(sel))) return;
    onDismiss('outside-click');
  });
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) onDismiss('escape');
  });
  if (closeOnScroll) {
    win.addEventListener('scroll', () => { if (isOpen()) onDismiss('scroll'); }, true);
  }
  win.addEventListener('resize', () => { if (isOpen()) onDismiss('resize'); });
}

// ── the desktop popover ───────────────────────────────────────────────────
// One element per document, created on first use; site.css's .share-pop
// rules (kept from the 2026-06 per-row button) style it.
let pop = null;
let popDoc = null;

function ensurePop(doc, win) {
  if (pop && popDoc === doc) return pop;
  pop = doc.createElement('div');
  pop.className = 'share-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Share this song');
  doc.body.appendChild(pop);
  popDoc = doc;
  attachDismiss(doc, win, {
    isOpen: () => pop.classList.contains('open'),
    // '.row-menu' is here because the overflow menu's Share item opens this
    // popover from inside itself: without it, the very click that opened the
    // popover would reach this dismiss handler, see a target outside
    // '.share-pop', and close it again in the same tick.
    within: ['.share-pop', '.row-menu'],
    onDismiss: closePopover,
  });
  return pop;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function openPopover(doc, win, nav, anchorEl, url, text) {
  const el = ensurePop(doc, win);
  if (el.classList.contains('open') && el.dataset.url === url) { closePopover(); return; }
  const enc = encodeURIComponent;
  el.dataset.url = url;
  el.innerHTML =
    '<button type="button" class="share-copy" data-copy="' + escapeHtml(url) + '">Copy link</button>'
    // Subject carries the context; the BODY is the link alone. The body used
    // to repeat the subject above the URL, which is the same duplication the
    // share sheet had (2026-08-22).
    + '<a class="share-mail" href="mailto:?subject=' + enc(text) + '&amp;body=' + enc(url) + '">Email</a>';
  el.querySelector('.share-copy').addEventListener('click', () => copyLink(nav, win, url, el));
  el.classList.add('open');
  placeNear(el, anchorEl, win);
  const first = el.querySelector('.share-copy');
  if (first && first.focus) first.focus();
}

// Above the anchor when there is room -- the bar lives at the foot of the
// viewport, so "above" is the normal case -- else below it.
//
// Exported because the row overflow menu (plans/row-menu/row-menu-plan.md §3)
// anchors the same way, and the plan is explicit that it should generalise
// this rather than grow a second copy of the geometry.
export function placeNear(el, anchorEl, win) {
  if (!anchorEl || !anchorEl.getBoundingClientRect) return;
  const r = anchorEl.getBoundingClientRect();
  const pw = el.offsetWidth || 168, ph = el.offsetHeight || 80;
  const vw = win.innerWidth || 1024, vh = win.innerHeight || 768;
  let left = Math.max(8, Math.min(r.right - pw, vw - pw - 8));
  let top = r.top - ph - 8;
  if (top < 8) top = r.bottom + 8;
  // Clamp in BOTH directions, not just the below-the-anchor branch.
  //
  // The old version only clamped when it fell through to "below", which was
  // safe while the only caller was the mini-player's two-row popover anchored
  // to a bar at the foot of the viewport. The row overflow menu is five or six
  // rows tall and anchors to a row anywhere in a long list, so "above" can run
  // off the bottom just as easily -- measured on the live page 2026-08-23,
  // where the menu's last two items were cut off.
  //
  // A menu TALLER than the viewport still overflows; that wants a max-height
  // and internal scrolling, which belongs with the real CSS.
  top = Math.max(8, Math.min(top, vh - ph - 8));
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

export function closePopover() {
  if (pop) pop.classList.remove('open');
}

function copyLink(nav, win, url, el) {
  const btn = el.querySelector('.share-copy');
  const done = () => {
    if (btn) btn.textContent = 'Link copied';
    win.setTimeout(closePopover, 900);
  };
  const fallback = () => {
    closePopover();
    if (win.prompt) win.prompt('Copy this link:', url);
  };
  if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
    nav.clipboard.writeText(url).then(done, fallback);
  } else {
    fallback();
  }
}
