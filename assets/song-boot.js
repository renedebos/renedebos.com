// Page bootstrap for song pages running the shared player engine (Phase 3
// Stage 3a-foundation of plans/dynamic-hugging-rossum.md — the migration off
// songs.js/player.js's independent-<audio>-per-row initCustomPlayers()).
//
// Two page shapes share this one module:
//   - /songs/<slug>/ (build_song_page): every occurrence row is server-
//     rendered and present at parse time — mounts synchronously at boot,
//     same shape as player-boot.js's bootShowPage().
//   - /songs/ (build_songs_index): occurrence rows are inserted lazily, one
//     song's worth at a time, the first time its <details> opens
//     (songs.js's renderSongOccs()). Zero rows exist at initial boot — that
//     is the NORMAL starting state here, not a failure — so this module
//     exposes mountRows(container) on its handle for songs.js to call again
//     each time a fresh batch of rows lands, mounting each newly-inserted
//     group's rows onto the SAME shared controller instance rather than
//     building a new one per song. "Shared" is only about the controller/
//     audio element, though — see the queue-origin contract note below:
//     every occurrence row is its own length-1 singleton queue, never
//     merged with any other row's.
//
// ── engine selection ──────────────────────────────────────────────────────
// Reuses player-boot.js's exact window.PLAYER_ENGINE / PLAYER_ENGINE_MOUNTED
// flag pair rather than inventing a second one: a document is never both a
// show page and a song page, so there is no ambiguity in sharing the name,
// and player.js's engine-selection gate (its `window.PLAYER_ENGINE ===
// 'controller'` check, unchanged) already does exactly what a song page
// needs — defer initCustomPlayers()/initLegacySpaceBar()/initLegacyDeepLink()
// to a DOMContentLoaded check of PLAYER_ENGINE_MOUNTED, so this module gets
// the same "controller claims the page synchronously, legacy falls back only
// if it never did" handshake with zero changes to player.js.
//
// ── per-row isolation, NOT all-or-nothing (deliberate divergence from
// player-boot.js) ──
// bootShowPage() aborts the WHOLE boot if any one row's data-item is
// malformed — correct there, since a show page mounts once, synchronously,
// with nothing yet playing. A song page's mountRows() is called repeatedly
// over a whole browsing session, often while something is already playing —
// aborting the entire controller because ONE freshly-opened song's one
// occurrence row has bad JSON would kill playback that has nothing to do
// with it. mountRows() below isolates each row's normalization in its own
// try/catch instead (same philosophy as player-boot.js's attachPeaks(): one
// bad item must not cascade), logging and skipping rather than throwing.
// Likewise, finding zero rows is never a reason to refuse the page (unlike
// bootShowPage()'s empty-mount guard) — it's the index page's normal
// starting state before any <details> has been opened.
import { PlaybackController, normalizeItem } from '/assets/player-controller.js';
import { PlayerView, itemFromRowElement } from '/assets/player-views.js';

export const MOUNTED_FLAG = 'PLAYER_ENGINE_MOUNTED';

// Unqualified (not '.song-occs [data-item]'): mountRows() is called BOTH
// with the whole document (song detail pages' initial boot) AND with a
// freshly-inserted .song-occs container ITSELF (songs.js's real call site,
// after inserting one song's rows into it) — the latter means the scope
// element IS .song-occs, not an ancestor of it, so a selector requiring
// .song-occs as a strict ancestor of the match would miss every row in that
// second, much more common case. No other markup on a song page ever
// carries data-item, so scoping to the container alone is unambiguous.
const ROW_SELECTOR = '[data-item]';

// Mounts a controller and wires whatever rows already exist in `doc` at call
// time (all of them, on a song detail page; none yet, on the lazy index
// page). Returns a handle exposing mountRows() for later incremental calls.
// Resolves window.PLAYBACK_HOST_READY itself, right after a successful
// mount — song pages have no deep-link/autoplay decision to wait for (no
// occurrence row is ever deep-linkable or autoplayed), so there is nothing
// to defer to, unlike player-boot.js's window.load-timed resolution.
export function bootSongPage(doc, win) {
  const controller = new PlaybackController();
  const mountedEls = typeof WeakSet !== 'undefined' ? new WeakSet() : new Set();
  const abort = new AbortController();

  function mountRows(container) {
    const scope = container || doc;
    const els = Array.from(scope.querySelectorAll(ROW_SELECTOR))
      .filter(el => !mountedEls.has(el));
    const fresh = [];
    els.forEach(el => {
      let item;
      try {
        item = normalizeItem(itemFromRowElement(el));
      } catch (e) {
        console.error('[song-boot] skipping one malformed occurrence row; the rest still mount', e);
        return;
      }
      mountedEls.add(el);
      // Plain PlayerView (not CompactPlayerView): every occurrence row is a
      // standalone recording, not a slot in a shared track list — the
      // Queue-origin contract (player-consolidation-plan.md's "Queue-origin
      // contract" table) assigns lazily-rendered song occurrences
      // playSingleton() semantics specifically to preserve legacy behavior
      // (legacy's auto-advance is gated by a [data-autoplay-next] ancestor
      // that only ever wraps a show page's .track-list, never .song-occs —
      // occurrence rows never auto-advanced into each other or into an
      // unrelated song's occurrence). PlayerView's own base _start() already
      // does exactly this (this.controller.playSingleton(this.item)) — the
      // same mechanism the Hero "Full Recording" card uses — so no override
      // is needed here at all.
      const view = new PlayerView(el, item);
      controller.mount(view);
      fresh.push(item);
    });
    return fresh;
  }

  function resolveReady() {
    if (win.__resolvePlaybackHost) {
      win.__resolvePlaybackHost({ mode: 'controller', controller, initialIntent: 'none' });
    }
  }

  try {
    mountRows(doc);
    const handle = {
      controller,
      mountRows,
      destroy() { abort.abort(); controller.destroy(); },
    };
    wireKeyboard(handle, doc, abort.signal);
    resolveReady();
    return handle;
  } catch (e) {
    abort.abort();
    controller.destroy();
    throw e;
  }
}

// Space toggles whatever is active, same as player-boot.js's wireKeyboard —
// guarding form fields matters more here than on a show page: /songs/ has a
// live search input right on the page.
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

// ── auto-run ────────────────────────────────────────────────────────────
if (typeof window !== 'undefined' && window.PLAYER_ENGINE === 'controller'
    && !window[MOUNTED_FLAG]) {
  try {
    window.SONG_BOOT = bootSongPage(document, window);
    window[MOUNTED_FLAG] = true;
  } catch (e) {
    console.error('[song-boot] controller mount failed, falling back to the legacy player', e);
    if (window.__resolvePlaybackHost) window.__resolvePlaybackHost({ mode: 'legacy' });
  }
}
