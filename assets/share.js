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
  doc.addEventListener('click', (e) => {
    if (!pop.classList.contains('open')) return;
    if (e.target.closest && (e.target.closest('.share-pop') || e.target.closest('.mp-share'))) return;
    closePopover();
  });
  doc.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopover(); });
  win.addEventListener('scroll', closePopover, true);
  win.addEventListener('resize', closePopover);
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
  place(el, anchorEl, win);
  const first = el.querySelector('.share-copy');
  if (first && first.focus) first.focus();
}

// Above the anchor when there is room -- the bar lives at the foot of the
// viewport, so "above" is the normal case -- else below it.
function place(el, anchorEl, win) {
  if (!anchorEl || !anchorEl.getBoundingClientRect) return;
  const r = anchorEl.getBoundingClientRect();
  const pw = el.offsetWidth || 168, ph = el.offsetHeight || 80;
  const vw = win.innerWidth || 1024, vh = win.innerHeight || 768;
  let left = Math.max(8, Math.min(r.right - pw, vw - pw - 8));
  let top = r.top - ph - 8;
  if (top < 8) top = Math.min(r.bottom + 8, vh - ph - 8);
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
