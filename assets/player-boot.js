// Page bootstrap for show pages running the shared player engine
// (see plans/player-consolidation/, Phase 1 Step 4).
//
// ── how engine selection works ──
// A migrated show page emits `window.PLAYER_ENGINE = 'controller'` inline
// BEFORE player.js. Seeing that, the two legacy engines don't initialize at
// parse time any more; they register their init on DOMContentLoaded and check
// `window.PLAYER_ENGINE_MOUNTED` first. This module is a module script, so it
// runs after the document is parsed but before DOMContentLoaded — it mounts
// the controller inside a try/catch and sets that flag only on success.
//
// The flag is therefore a claim this module makes, not a static "don't init"
// instruction baked into the page. That distinction is the whole point: a
// static flag would leave an unsupported-module browser, a 404 on an asset, or
// any bootstrap exception with NO working player at all — worse than today,
// where a wavesurfer failure still leaves the Full Recording player alive.
// Retained legacy code is only a deploy-time rollback unless something can
// fall back at runtime.
import { PlaybackController, normalizeItem } from '/assets/player-controller.js';
import { CompactPlayerView, HeroPlayerView, itemFromRowElement } from '/assets/player-views.js';

export const MOUNTED_FLAG = 'PLAYER_ENGINE_MOUNTED';

// Track rows live inside .track-list and are the show's own queue, in DOM
// order. Deliberately matches both row shapes (.ws-track and .custom-player) —
// which one a show renders is a per-show build decision, not something the
// engine should care about.
const ROW_SELECTOR = '.track-list [data-item]';
// Full Recording parts and alternate transfers. The attribute sits on
// .recording-item (the card), not the .custom-player inside it.
const HERO_SELECTOR = '.recording-item[data-item]';

// Mounts one controller and every view on the page. Throws if anything is
// wrong with the markup (a malformed data-item, a missing streamUrl) rather
// than mounting a half-working engine — the caller turns that into a clean
// fallback to the legacy engines.
//
// Mounting and decoration (peaks/keyboard/deep-link/resize) share ONE
// try/catch and ONE AbortController (Step 4 review finding #1). Two things
// that finding caught in the earlier version: (a) the decoration steps were
// wired outside the try that covered mounting, so a throw from any of them
// left the caller with a mounted controller and no `handle` to clean it up
// with; (b) `handle.destroy()` destroyed the controller but never removed the
// keyboard/deep-link/resize listeners it had installed on `doc`/`win`, which
// are document/window-scoped and outlive the controller — a leaked Space
// listener could still call a "destroyed" controller's `toggle()` and resume
// its detached audio. `abort` now closes both gaps: every listener below is
// registered against its signal, and destroy() aborts it before destroying
// the controller, so the two cleanups can never drift apart again.
//
// That one-try/catch guarantee covers the SYNCHRONOUS wiring of all four
// decoration steps below -- attachPeaks's own kickoff (registering the fetch)
// and wireKeyboard/wireDeepLink/wireResize's listener registration. It does
// NOT extend to attachPeaks's asynchronous continuation: that promise chain
// resolves later, well after this try/catch's stack frame has already
// returned, so a failure there can't be caught here no matter how it's wired
// (eighth review, finding #2). attachPeaks is exception-isolated internally
// instead -- see the comment on it below.
export function bootShowPage(doc, win) {
  const controller = new PlaybackController();
  const views = [];
  const rowViews = [];
  const abort = new AbortController();
  let rowItems = [];

  try {
    // Normalize up front so a bad row fails the whole boot here, where it can
    // still fall back, rather than at the first click. Every row click
    // re-asserts this same queue (the queue-origin contract in the plan).
    const rowEls = Array.from(doc.querySelectorAll(ROW_SELECTOR));
    rowItems = rowEls.map(el => normalizeItem(itemFromRowElement(el)));

    rowEls.forEach((el, i) => {
      const view = new CompactPlayerView(el, rowItems[i], {
        queueItems: rowItems,
        queueIndex: i,
      });
      controller.mount(view);
      views.push(view);
      rowViews.push(view);
    });

    Array.from(doc.querySelectorAll(HERO_SELECTOR)).forEach(el => {
      const view = new HeroPlayerView(el, normalizeItem(itemFromRowElement(el)));
      controller.mount(view);
      views.push(view);
    });

    // Belt-and-braces with verify_markup.py's build-time check (Step 4 review
    // finding #2): if the selectors above found nothing — every row missing
    // data-item, or genuinely no playable markup on the page — mounting would
    // still set the flag and claim the page with nothing to play. Fail the
    // boot instead, so the caller falls back to the legacy engines rather
    // than silently owning an empty page.
    if (!views.length) {
      throw new Error('player-boot: found no playable rows or recording cards on this page');
    }

    const handle = {
      controller,
      views,
      rowViews,
      rowItems,
      destroy() { abort.abort(); controller.destroy(); },
    };

    // Best-effort decoration. Only attachPeaks's own SYNCHRONOUS kickoff
    // (registering the fetch call) is covered by the try/catch above — a
    // throw there is cleaned up exactly like a malformed-markup throw, same
    // as wireKeyboard/wireDeepLink/wireResize's registration below. Its
    // asynchronous continuation (the fetch resolving and applying peaks)
    // runs later, outside this stack frame entirely, so this catch cannot
    // and does not protect it (eighth review, finding #2) — what actually
    // protects that path is attachPeaks being exception-isolated per view
    // internally, so one row's setPeaks() failure can't cascade into a
    // retry-from-scratch or an unhandled rejection on an already-claimed
    // page. See attachPeaks's own comment for the detail.
    attachPeaks(handle, win);
    wireKeyboard(handle, doc, abort.signal);
    wireDeepLink(handle, doc, win, abort.signal);
    wireResize(handle, win, abort.signal);
    attachMiniPlayer(handle, doc, abort.signal);
    return handle;
  } catch (e) {
    abort.abort();
    controller.destroy();          // unmounts every view mounted so far
    throw e;
  }
}

// The fixed bottom bar: the current track's play/pause, prev/next, seek and
// title, visible wherever the page is scrolled (shipped 2026-08-20, replacing
// the retired /player/ popup's on-THIS-page half; cross-page persistence is
// the parked Stage 3a-canary coordinator, deliberately not built here).
//
// Dynamically imported, deliberately: a static import would put
// miniplayer-views.js on this module's critical path, so a missing or broken
// bar asset would fail the WHOLE boot and drop every show page to the legacy
// engine — a much worse trade than a page without a bar. The bar renders
// nothing until a track is current, so mounting late is invisible.
//
// Runs strictly after the rows-found guard: the bar is chrome, not playable
// markup, and must never keep an otherwise-empty page claimed.
function attachMiniPlayer(handle, doc, signal) {
  const root = doc.getElementById('mini-player');
  if (!root) return;
  import('/assets/miniplayer-views.js').then(({ attachMiniPlayerBar }) => {
    if (signal.aborted) return;
    // Close/remount policy lives in attachMiniPlayerBar — ONE copy, shared
    // with playlist-boot and song-boot, so the three surfaces cannot drift.
    handle.views.push(attachMiniPlayerBar(handle.controller, root, signal));
  }).catch(() => { /* no bar — the page is complete without it */ });
}

// Peaks arrive asynchronously, but the mount above must be synchronous — the
// MOUNTED flag has to be set before DOMContentLoaded or the legacy engines
// will have already taken over. So rows mount peak-less and get decorated when
// the fetch lands; a row the user starts in between simply upgrades to its
// waveform a moment later.
//
// On a fetch failure every waveform row still gets an (empty) peaks object.
// That's deliberate parity with wavesurfer.js's own `build({})` fallback:
// WaveSurfer then downloads and decodes the audio to draw, so the row keeps
// its waveform and its seek surface instead of losing both.
function attachPeaks(handle, win) {
  const url = win && win.WS_PEAKS_URL;
  // Best effort, per view: one row's setPeaks() failing must not stop the
  // rest of the page from decorating and must never surface as an
  // unhandled rejection on an already-claimed page (eighth review, finding
  // #2) -- this whole function resolves well outside bootShowPage's
  // synchronous try/catch (see the comment at its call site), so nothing
  // here can lean on that catch to clean up after it.
  const apply = (map) => {
    handle.views.forEach(v => {
      if (!v.waveContainer) return;
      try {
        v.setPeaks((v.item.peaksKey && map[v.item.peaksKey]) || {});
      } catch (e) {
        console.error('[player-boot] setPeaks failed for one row; the rest still decorate', e);
      }
    });
  };
  if (!url || typeof fetch !== 'function') { apply({}); return Promise.resolve(); }
  return fetch(url)
    .then(r => r.json())
    .then(apply, () => apply({}))
    .catch(e => console.error('[player-boot] peaks decoration failed unexpectedly', e));
}

// Space toggles whatever is actually playing. The legacy handler could only
// ever reach a .custom-player row (waveform rows were invisible to it); with
// one engine per document there is exactly one thing Space can mean.
function wireKeyboard(handle, doc, signal) {
  doc.addEventListener('keydown', e => {
    if (e.code !== 'Space') return;
    const tag = doc.activeElement ? doc.activeElement.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
    e.preventDefault();
    if (!handle.controller.currentItem) return;
    handle.controller.toggle();
  }, { signal });
}

// Deep links (#track-N, optionally with ?autoplay=1) — same behavior the two
// legacy engines produce between them today: highlight and scroll on every
// hash change, but autoplay only on the initial arrival. (player.js's
// focusHashTrack never autoplays a waveform row, and wavesurfer.js only ever
// looks at the hash once, at build time.)
//
// Also where window.PLAYBACK_HOST_READY gets resolved for a successfully
// mounted show page (readiness-contract, plans/dynamic-hugging-rossum.md's
// "Blocker A continued") — deliberately HERE, on 'load', not at mount time:
// resolving earlier would let a future mini-player start restoring a
// persisted session before this deep-link decision is made, racing it. focus()
// now returns whether it just fired setQueue(...,{autoplay:true}) so the
// resolved initialIntent can tell "a real autoplay just happened" apart from
// "nothing page-specific happened, restoration is safe" — module-load-failure
// and in-script-throw are two separate, real signals handled elsewhere (the
// module tag's onerror= attribute pages.py emits, and this file's own
// auto-run catch block below), so between the three, every outcome is
// covered without a generic timeout.
function wireDeepLink(handle, doc, win, signal) {
  const focus = (allowAutoplay) => {
    if (!win.location || !win.location.hash) return false;
    let el;
    try { el = doc.querySelector(win.location.hash); } catch (e) { return false; }
    if (!el || !el.classList.contains('track-row')) return false;
    doc.querySelectorAll('.track-row.target').forEach(r => {
      if (r !== el) r.classList.remove('target');
    });
    if (el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('target');
    if (!allowAutoplay) return false;
    if (new URLSearchParams(win.location.search).get('autoplay') !== '1') return false;
    const index = handle.rowViews.findIndex(v => v.root === el);
    if (index === -1) return false;
    handle.controller.setQueue(handle.rowItems, { startIndex: index, autoplay: true });
    return true;
  };
  // Deliberately on 'load', matching player.js: scrollIntoView wants layout
  // settled, and a module runs well before that.
  win.addEventListener('load', () => {
    let autoplayed = focus(true);
    // The single-song share page (/t/{code}, plans/share/track-share-plan.md
    // §9) exists to play one thing, and its URL is deliberately clean -- no
    // ?autoplay=1, no #track-N -- so focus() above can never fire for it.
    // The page states the intent directly instead. Strictly a fallback: a
    // deep link that already started something wins, so a page carrying both
    // can't double-start, and initialIntent stays truthful either way.
    if (!autoplayed && win.PLAYER_AUTOPLAY && handle.rowViews.length) {
      handle.controller.setQueue(handle.rowItems, { startIndex: 0, autoplay: true });
      autoplayed = true;
    }
    if (win.__resolvePlaybackHost) {
      win.__resolvePlaybackHost({
        mode: 'controller', controller: handle.controller,
        initialIntent: autoplayed ? 'autoplay' : 'none',
      });
    }
  }, { signal });
  win.addEventListener('hashchange', () => focus(false), { signal });
}

// An inert canvas is drawn at one fixed pixel size; WaveSurfer re-renders
// itself on resize but the peak-drawn canvases would just stretch.
function wireResize(handle, win, signal) {
  let timer = null;
  win.addEventListener('resize', () => {
    if (timer) clearTimeout(timer);
    // A resize that fires right before destroy() can still have a pending
    // timer when abort() runs; the 'resize' listener itself is removed by
    // then, but this guards the already-scheduled callback too.
    timer = setTimeout(() => {
      if (signal.aborted) return;
      handle.views.forEach(v => v.redrawWave());
    }, 150);
  }, { signal });
}

// ── auto-run ────────────────────────────────────────────────────────────────
// Only claims the page if the build asked for the controller engine. Any
// failure here leaves MOUNTED_FLAG unset, which is what the legacy engines
// check at DOMContentLoaded before initializing themselves.
if (typeof window !== 'undefined' && window.PLAYER_ENGINE === 'controller'
    && !window[MOUNTED_FLAG]) {
  try {
    // Exposed so "is exactly one engine mounted, and on what?" is answerable
    // from a console during the manual parity checks.
    window.PLAYER_BOOT = bootShowPage(document, window);
    window[MOUNTED_FLAG] = true;
  } catch (e) {
    // Left deliberately visible: this path means the page just fell back to
    // the legacy engine, which is a thing worth seeing in a console.
    console.error('[player-boot] controller mount failed, falling back to the legacy player', e);
    // Readiness-contract in-script-throw signal (plans/dynamic-hugging-
    // rossum.md's "Blocker A continued"): resolved directly here, not by
    // piggybacking on player.js's own separate, later-firing
    // DOMContentLoaded listener that checks MOUNTED_FLAG and calls
    // initLegacyPlayback() — that listener triggers the actual fallback
    // engine, but 'legacy' mode here just means "a future mini-player should
    // stay dormant on this page load," which is already true the instant
    // this catch runs, regardless of when that separate listener gets to it.
    if (window.__resolvePlaybackHost) window.__resolvePlaybackHost({ mode: 'legacy' });
  }
}
