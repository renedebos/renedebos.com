// Page bootstrap for /playlist/, running on the shared PlaybackController
// (Phase 2 of plans/player-consolidation/). This is now the only playback
// engine on the page -- the legacy playlist.js engine and its
// `?engine=`/PLAYLIST_ENGINE resolver dance were deleted in Stage 2c
// (2026-08-14); this module mounts unconditionally at parse time (see the
// auto-run block at the bottom of this file).
//
// This module is a module script, so it runs after the document is parsed
// but before DOMContentLoaded — it mounts the controller inside a try/catch
// and sets the MOUNTED_FLAG only on success, so other code (tests,
// browser_check.mjs) can observe a successful mount rather than assuming
// one. A mount failure (a parse error, a thrown exception) is logged and
// otherwise silent — there is no fallback engine to hand off to anymore, so
// the page simply stays inert; see the plan doc's Stage 2c section for why
// that's an acceptable failure mode this late in the rollout.
//
// ── the async wrinkle show pages don't have ──
// The catalog fetch (/assets/tracks.json) is asynchronous, but the mounted
// flag has to be set before DOMContentLoaded. Resolution: the flag is set on
// synchronous mount of the SHELL (controller constructed, views mounted,
// every DOM listener wired) — never on catalog arrival. A catalog-fetch
// failure then degrades to a status-line message. This is a deliberate
// divergence from player-boot.js, where everything mountable is synchronous.
import { PlaybackController } from '/assets/player-controller.js';
import { itemFromCatalogRow, PlaylistQueueView, PlaylistNowPlayingView, ARTIST_NAMES } from '/assets/playlist-views.js';

export const MOUNTED_FLAG = 'PLAYLIST_ENGINE_MOUNTED';

// ── untrusted-input bounds ──────────────────────────────────────────────
// /playlist/'s queues come from a URL hash (fully attacker-chosen via a
// shared link) or localStorage (chosen by anything else on the origin) —
// unlike a show page's build-time-bounded markup. Sized generously: the
// catalog is 680 tracks at ~30 chars/id, so a legitimate full-catalog share
// link (track-select.js's goToPlaylist() has no selection cap) already runs
// to ~20K characters; 65536 leaves real headroom as the archive grows.
const MAX_HASH_LENGTH = 65536;
const MAX_QUEUE_IDS = 1000;
const MAX_SAVED_PLAYLISTS = 100;
const MAX_PLAYLIST_NAME = 120;
// Local to the ONE catalog fetch below -- implementation review finding #6
// (2026-08-15). NOT a generic page-wide readiness timeout (that was
// explicitly rejected in the design review for racing a slow-but-healthy
// load into constructing a second controller); see the fetch call's own
// comment. test-fake-dom.mjs's loadPlaylistBoot() substitutes a short
// test-scale value for this constant so the "never resolves" test doesn't
// need to wait out the real duration.
const CATALOG_FETCH_TIMEOUT_MS = 10000;

const SAVED_KEY = 'savedPlaylists';

// Which tags are offered as playlist facets -- deliberately a subset of the
// TAGS.md vocabulary, not all of it (`medley`, `banter` and `beatles` have
// always been catalogued but never offered here). The four genre-flavour tags
// `folk`/`country`/`blues`/`rock` were dropped 2026-08-20: between them they
// cover 94 of 680 tracks, so as facets they mostly produced thin playlists,
// and the chips crowded a page that was already dense. They remain on the
// tracks themselves and still work in /search/.
const TAG_ORDER = ['original', 'cover', 'irish', 'ballad',
  'upbeat', 'rocker', 'guest', 'favorite', 'rarity'];

// The songwriter FACET was removed from the page 2026-08-20, but this map
// stays: matches() still applies a songwriter filter, and the "Traditional &
// Irish" preset is defined by it (the `traditional` TAG was retired
// 2026-07-19 as redundant with songwriter, so nothing else can express it).
// Mirrors playlist.js's SONGWRITER_MAP exactly — a pre-existing data
// inconsistency it papers over, not fixed here.
const SONGWRITER_MAP = {
  'Jerry Hannan & Sean Hannan': 'original',
  'Traditional': 'traditional',
  'Lennon & McCartney': 'lennon-mccartney',
  'Lennon-McCartney': 'lennon-mccartney',
  'Steve Poltz': 'poltz',
};
const PRESETS = {
  mixed45: { filters: { artist: [], venue: [], source: [], tags: [], songwriter: [] }, mode: 'minutes', amount: 45 },
  traditional: { filters: { artist: [], venue: [], source: [], tags: [], songwriter: ['traditional'] }, mode: 'songs', amount: 12 },
  soundboard: { filters: { artist: [], venue: [], source: ['sbd'], tags: [], songwriter: [] }, mode: 'endless' },
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function validSavedEntry(p) {
  return !!p && typeof p === 'object'
    && typeof p.name === 'string' && p.name.trim().length > 0 && p.name.length <= MAX_PLAYLIST_NAME
    && Array.isArray(p.ids) && p.ids.length > 0 && p.ids.length <= MAX_QUEUE_IDS
    && p.ids.every((id) => typeof id === 'string' && /^[\w.-]+$/.test(id));
}

// Mirrors core.py's sanitize_filename() -- no way to share the Python and JS
// implementations directly in this static-site setup.
function sanitizeFilename(s) {
  return String(s).replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
}

// Mounts one controller and the two queue-scoped views + a boot-level
// hash-sync subscriber over the /playlist/ markup. Throws if the required
// elements are missing, rather than mounting a half-working engine (there is
// no fallback engine to catch the failure anymore, see the auto-run block's
// header comment below) — mirrors player-boot.js's bootShowPage().
export function bootPlaylistPage(doc, win) {
  const filtersEl = doc.getElementById('pl-filters');
  const lengthEl = doc.getElementById('pl-length');
  const statusEl = doc.getElementById('pl-status');
  const goBtn = doc.getElementById('pl-generate');
  const nowEl = doc.getElementById('pl-now');
  const queueEl = doc.getElementById('pl-queue');
  const presetsEl = doc.querySelector('.pl-presets');
  const clearBtn = doc.getElementById('pl-clear');
  const shareBtn = doc.getElementById('pl-share');
  const saveBtn = doc.getElementById('pl-save');
  const downloadBtn = doc.getElementById('pl-download');
  const savedEl = doc.getElementById('pl-saved');

  if (!filtersEl || !lengthEl || !statusEl || !goBtn || !nowEl || !queueEl) {
    throw new Error('playlist-boot: required /playlist/ markup is missing');
  }

  const abort = new AbortController();
  const catalogById = new Map();
  let CATALOG = [];
  const filters = { artist: [], venue: [], source: [], tags: [], songwriter: [] };
  let mode = 'songs';
  const amounts = { songs: 12, minutes: 45 };

  // ── catalog-space helpers (operate on tracks.json rows, never items) ──
  function matches(t) {
    if (filters.artist.length && filters.artist.indexOf(t.artist) === -1) return false;
    if (filters.venue.length && filters.venue.indexOf(t.venue) === -1) return false;
    if (filters.source.length && filters.source.indexOf(t.sourceType) === -1) return false;
    if (filters.songwriter.length && filters.songwriter.indexOf(SONGWRITER_MAP[t.songwriter]) === -1) return false;
    for (let i = 0; i < filters.tags.length; i++) {
      if (t.tags.indexOf(filters.tags[i]) === -1) return false;
    }
    return true;
  }
  function pool() { return CATALOG.filter(matches); }
  function shuffleTracks(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }
  function dedupeTracks(list) {
    const seen = {}; const out = [];
    list.forEach((t) => {
      const key = t.song || t.title;
      if (!seen[key]) { seen[key] = true; out.push(t); }
    });
    return out;
  }
  function totalStr(list) {
    let sec = 0;
    list.forEach((t) => { sec += t.durationSec; });
    const h = Math.floor(sec / 3600); const m = Math.round((sec % 3600) / 60);
    return h ? h + 'h ' + m + 'm' : m + ' min';
  }
  function buildQueue() {
    const p = dedupeTracks(shuffleTracks(pool().slice()));
    if (mode === 'songs') return p.slice(0, amounts.songs);
    if (mode === 'minutes') {
      const budget = amounts.minutes * 60;
      const out = []; let sec = 0;
      for (let i = 0; i < p.length; i++) {
        if (sec + p[i].durationSec <= budget || !out.length) {
          out.push(p[i]); sec += p[i].durationSec;
          if (sec >= budget) break;
        }
      }
      return out;
    }
    return p; // endless: whole pool, reshuffled again when it runs out
  }
  function resolveCatalogRows(ids) {
    return ids.map((id) => catalogById.get(id)).filter(Boolean);
  }
  function rowsFromItems(items) {
    return items.map((t) => catalogById.get(t.id)).filter(Boolean);
  }
  function dedupeIds(ids) {
    const seen = new Set(); const out = [];
    ids.forEach((id) => { if (!seen.has(id)) { seen.add(id); out.push(id); } });
    return out;
  }

  // ── filter/length UI (pure DOM, catalog-space) ──
  function chip(group, value, label, pressed) {
    return '<button type="button" class="chip" data-group="' + group + '" data-value="'
      + esc(value) + '"' + (pressed ? ' aria-pressed="true"' : ' aria-pressed="false"')
      + '>' + esc(label) + '</button>';
  }
  function uniq(key) {
    const seen = [];
    CATALOG.forEach((t) => { if (t[key] && seen.indexOf(t[key]) === -1) seen.push(t[key]); });
    return seen;
  }
  function filterGroup(label, key, allLabel, options) {
    return '<div class="pl-filter-group"><p class="pl-filter-label">' + esc(label) + '</p><div class="chip-row">'
      + chip(key, 'all', allLabel, filters[key].length === 0)
      + options.map((o) => chip(key, o[0], o[1], filters[key].indexOf(o[0]) !== -1)).join('') + '</div></div>';
  }
  function renderFilters() {
    const groups = [];
    groups.push(filterGroup('Artist', 'artist', 'All artists', uniq('artist').map((a) => [a, ARTIST_NAMES[a] || a])));
    groups.push(filterGroup('Venue', 'venue', 'All venues', uniq('venue').map((v) => [v, v])));
    groups.push(filterGroup('Source', 'source', 'All sources', [['aud', 'AUD'], ['sbd', 'SBD']]));
    const present = TAG_ORDER.filter((tg) => CATALOG.some((t) => t.tags.indexOf(tg) !== -1));
    groups.push('<div class="pl-filter-group"><p class="pl-filter-label">Tags</p><div class="chip-row">'
      + present.map((tg) => chip('tag', tg, tg, filters.tags.indexOf(tg) !== -1)).join('') + '</div></div>');
    filtersEl.innerHTML = groups.join('');
  }
  function renderLength() {
    lengthEl.innerHTML = '<div class="pl-filter-group"><p class="pl-filter-label">Length</p><div class="chip-row">'
      + chip('mode', 'songs', 'Songs', mode === 'songs')
      + chip('mode', 'minutes', 'Minutes', mode === 'minutes')
      + chip('mode', 'endless', 'Endless shuffle', mode === 'endless')
      + (mode === 'endless' ? '' :
        '<input id="pl-amount" class="pl-amount" type="number" min="1" max="999" value="'
        + amounts[mode] + '" aria-label="How many ' + mode + '">')
      + '</div></div>';
  }
  function estimateDuration(dedupedPool) {
    if (!dedupedPool.length) return null;
    if (mode === 'minutes') return amounts.minutes + ' min';
    if (mode === 'endless') return '~' + totalStr(dedupedPool) + ' of unique songs';
    const n = Math.min(amounts.songs, dedupedPool.length);
    const avg = dedupedPool.reduce((s, t) => s + t.durationSec, 0) / dedupedPool.length;
    return '~' + totalStr([{ durationSec: avg * n }]);
  }
  function updateStatus() {
    const p = pool();
    const deduped = dedupeTracks(p);
    const uniqCount = deduped.length;
    const est = estimateDuration(deduped);
    statusEl.textContent = p.length
      ? p.length + ' of ' + CATALOG.length + ' recordings match — '
        + uniqCount + (uniqCount === 1 ? ' song' : ' different songs')
        + ' (one performance of each per playlist)'
        + (est ? ' — about ' + est + '.' : '.')
      : 'No tracks match — loosen the filters.';
    goBtn.disabled = !p.length;
    if (clearBtn) {
      clearBtn.hidden = !(filters.artist.length || filters.venue.length
        || filters.source.length || filters.tags.length || filters.songwriter.length);
    }
  }

  // ── saved playlists (flat `savedPlaylists` key, kept through Stages
  // 2a-2c -- see the plan's storage-schema section for why a versioned
  // envelope is deferred rather than dual-written) ──
  function loadSaved() {
    let raw;
    try { raw = localStorage.getItem(SAVED_KEY); } catch (e) { return []; }
    if (raw == null) return [];
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
      console.error('[playlist-boot] saved playlists: corrupt JSON in localStorage -- showing an empty list without overwriting it', e);
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    // Bounded at the read boundary too, not just in storeSaved() -- a
    // localStorage value with far more than MAX_SAVED_PLAYLISTS valid
    // entries (stale from before this bound existed, or hand-edited) would
    // otherwise render unbounded DOM every time the saved-playlists panel
    // draws (Codex post-deploy review finding #3, 2026-08-15).
    return parsed.filter(validSavedEntry).slice(0, MAX_SAVED_PLAYLISTS);
  }
  function storeSaved(list) {
    if (list.length > MAX_SAVED_PLAYLISTS) {
      statusEl.textContent = 'You have reached the ' + MAX_SAVED_PLAYLISTS + '-playlist limit — delete one to save another.';
      return false;
    }
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(list));
    } catch (e) {
      statusEl.textContent = "Couldn't save — your browser's local storage is full or unavailable.";
      return false;
    }
    renderSaved();
    return true;
  }
  function zipLabel(tracks) {
    const withFlac = tracks.filter((t) => t.flac);
    const mb = Math.round(withFlac.reduce((a, t) => a + (t.flac_size_mb || 0), 0));
    return 'Download ' + withFlac.length + (withFlac.length === 1 ? ' track' : ' tracks') + ' (.zip) · ' + mb + ' MB';
  }
  // Appended to a loud ZIP's info file. A download is the one place a visitor
  // ends up holding audio with no page around it to say what it is, so the
  // file has to carry its own provenance. Kept byte-identical to
  // LOUD_ZIP_NOTE in sitegen/fragments.py -- the server builds the show/song
  // ZIPs, this builds the playlist one, and an unpacked ZIP should not reveal
  // which code path made it.
  const LOUD_ZIP_NOTE =
    '\n-- This is the LOUD version --\n'
    + '320 kbps MP3, normalized to -14 LUFS for comfortable listening on phone\n'
    + 'speakers and in a car. It is NOT the archive master: the masters are\n'
    + 'lossless FLAC at -20 LUFS, downloadable from the same button.\n'
    + 'https://renedebos.com/process/\n';

  function buildPlaylistManifest(name, tracks) {
    const withFlac = tracks.filter((t) => t.flac);
    const folder = sanitizeFilename(name);
    const label = (t) => t.showDate + ' - ' + (ARTIST_NAMES[t.artist] || t.artist) + ' - ' + t.venue + ' - ' + t.title;
    const files = withFlac.map((t) => ({ key: t.flac, name: folder + '/' + sanitizeFilename(label(t)) + '.flac' }));
    const totalMb = Math.round(withFlac.reduce((a, t) => a + (t.flac_size_mb || 0), 0));
    const lines = withFlac.map(label).join('\n');
    const info = name + '\n' + withFlac.length + ' tracks · ' + totalMb + ' MB\n\n' + lines + '\n\n'
      + 'Recreate this playlist: ' + win.location.origin + '/playlist/#p=' + withFlac.map((t) => t.id).join(',') + '\n';
    const manifest = {
      zipName: folder + '.zip',
      files,
      infoName: folder + '/playlist-info.txt',
      infoText: info,
    };
    // -14 counterpart, offered in the password modal only when EVERY track in
    // the ZIP has one rendered -- same all-or-nothing rule the server-built
    // show/song ZIPs use (see _loud_zip() in sitegen/fragments.py): a silently
    // mixed archive is indistinguishable from a correct one once unpacked.
    // `loud` is the variant's R2 key, already in assets/tracks.json.
    if (withFlac.length && withFlac.every((t) => t.loud)) {
      const lfolder = folder + ' (loud -14 LUFS)';
      manifest.loud = {
        zipName: lfolder + '.zip',
        files: withFlac.map((t) => ({ key: t.loud, name: lfolder + '/' + sanitizeFilename(label(t)) + '.mp3' })),
        infoName: lfolder + '/playlist-info.txt',
        infoText: info + LOUD_ZIP_NOTE,
      };
    }
    return manifest;
  }
  function renderSaved() {
    if (!savedEl) return;
    const list = loadSaved();
    if (!list.length) { savedEl.innerHTML = ''; return; }
    savedEl.innerHTML = '<p class="pl-filter-label">Your saved playlists</p>'
      + '<div class="search-results">' + list.map((p, i) => {
        const rows = resolveCatalogRows(p.ids);
        return '<div class="pl-saved-row" data-i="' + i + '">'
          + '<button type="button" class="sr pl-saved-load" data-i="' + i + '">'
          + '<span class="sr-icon">&#9834;</span>'
          + '<span class="sr-main"><span class="sr-title">' + esc(p.name) + '</span>'
          + '<span class="sr-sub">' + p.ids.length + (p.ids.length === 1 ? ' song' : ' songs') + '</span></span>'
          + '</button>'
          + '<button type="button" class="pl-saved-act" data-act="download" data-i="' + i
          + '" title="' + esc(zipLabel(rows)) + '">Download</button>'
          + '<button type="button" class="pl-saved-act" data-act="rename" data-i="' + i + '">Rename</button>'
          + '<button type="button" class="pl-saved-act" data-act="delete" data-i="' + i + '">Delete</button>'
          + '</div>';
      }).join('') + '</div>';
  }

  // ── stateless sharing (#p=id,id,...) ──
  function syncHash(queueItems) {
    win.history.replaceState(null, '', queueItems.length
      ? '#p=' + queueItems.map((t) => t.id).join(',')
      : win.location.pathname);
    if (shareBtn) shareBtn.hidden = !queueItems.length;
    if (saveBtn) saveBtn.hidden = !queueItems.length;
    if (downloadBtn) {
      downloadBtn.hidden = !queueItems.length;
      if (queueItems.length) downloadBtn.title = zipLabel(rowsFromItems(queueItems));
    }
  }
  function verifyShortLink(shortUrl) {
    return fetch(shortUrl, { method: 'HEAD', cache: 'no-store' })
      .then((r) => ((r.ok && r.redirected) ? shortUrl : Promise.reject()));
  }
  function copyShareUrl(url) {
    const done = () => {
      shareBtn.textContent = 'Link copied!';
      setTimeout(() => { shareBtn.textContent = 'Copy share link'; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, () => {
        shareBtn.textContent = 'Copy share link';
        window.prompt('Copy this link:', url);
      });
    } else {
      shareBtn.textContent = 'Copy share link';
      window.prompt('Copy this link:', url);
    }
  }

  // Shape-only check for whether the CURRENT url hash is syntactically a
  // recognized #p=id,id,... share link -- deliberately catalog-independent
  // (mirrors hydrateFromHash()'s own early-return shape checks below: hash
  // present, within the length bound, matching the #p= pattern), since it
  // needs to be answerable even when CATALOG has never loaded at all.
  // Implementation review finding #4 (2026-08-15): the catalog-fetch
  // .catch() branch used to hardcode recognized:false regardless of what the
  // hash actually contained, reporting a genuine share link hit by a
  // transient network failure identically to "no hash at all" -- the same
  // failure class the previous round's finding #5 fix addressed for the
  // all-unknown-ids success-path case, just reachable via a different path
  // (network failure instead of stale ids) that fix didn't cover. Resolving
  // ids against CATALOG is NOT needed to answer "is this syntactically a
  // share link" -- only the hash's own shape is.
  function hashIsRecognizedShareLink() {
    const raw = win.location.hash;
    return !!raw && raw.length <= MAX_HASH_LENGTH && /^#p=([\w.,-]+)/.test(raw);
  }

  // ── hash hydration (untrusted input -- see the bounds above) ──
  // Returns { recognized, hadIds }, not a bare boolean (implementation
  // review finding #5, 2026-08-15): `recognized` is true whenever a #p=
  // hash was present and matched the expected shape -- a real page-level
  // decision was made, even when that decision produces an EMPTY queue (the
  // all-unknown-ids branch below, which explicitly clears the queue and
  // shows "None of the tracks..."). `hadIds` is true only when that decision
  // produced a non-empty queue. Conflating the two used to report a
  // recognized-but-all-unknown share link identically to "no hash at all" —
  // a future mini-player restoring its own persisted session onto this
  // controller because initialIntent said that was safe would silently
  // contradict both the URL the visitor followed and the status message
  // just shown to them. See resolveReady() below for how `recognized` alone
  // (not `hadIds`) is what actually decides initialIntent.
  function hydrateFromHash() {
    const raw = win.location.hash;
    if (!raw) return { recognized: false, hadIds: false };
    if (raw.length > MAX_HASH_LENGTH) {
      statusEl.textContent = 'That share link is too long to use.';
      return { recognized: false, hadIds: false };
    }
    const m = raw.match(/^#p=([\w.,-]+)/);
    if (!m) return { recognized: false, hadIds: false };
    let ids = m[1].split(',');
    if (ids.length > MAX_QUEUE_IDS) {
      ids = ids.slice(0, MAX_QUEUE_IDS);
      statusEl.textContent = 'That playlist link had too many tracks — showing the first ' + MAX_QUEUE_IDS + '.';
    }
    ids = dedupeIds(ids);
    const rows = resolveCatalogRows(ids);
    if (!rows.length) {
      // Fixed, not preserved: legacy leaves queue/audio/hash inconsistent
      // here (clears its internal var but returns before touching anything
      // else). setQueue([]) clears all three consistently instead.
      controller.setQueue([]);
      statusEl.textContent = 'None of the tracks in that link are in the archive anymore.';
      return { recognized: true, hadIds: false };
    }
    controller.setQueue(rows.map(itemFromCatalogRow), { startIndex: 0, autoplay: false });
    return { recognized: true, hadIds: true };
  }

  // ── controller + views ──
  // Cleared on the controller audio's next 'play' (mirrors playlist.js's own
  // pausedByClaim, playlist.js:614-621) -- without this, the "paused
  // elsewhere" status message stays on screen forever once playback resumes,
  // contradicting what the controller (and the user's ears) report (Codex
  // review, Phase 2 Stage 2a, finding #2).
  let pausedByClaim = false;
  const controller = new PlaybackController({
    onQueueExhausted(_reason) {
      if (mode !== 'endless') return false;
      const rows = buildQueue();
      if (!rows.length) return false;
      controller.setQueue(rows.map(itemFromCatalogRow), { startIndex: 0, autoplay: true });
      return true;
    },
    onExternalClaim() {
      pausedByClaim = true;
      statusEl.textContent = 'Paused — playback started somewhere else on the site.';
    },
  });

  // Everything below is ONE transaction: constructing/mounting the views,
  // wiring every DOM listener, and kicking off the catalog fetch. On ANY
  // throw, abort + destroy before rethrowing, so a partial mount never
  // leaves a stray live controller/views/listeners behind (Codex review,
  // Phase 2 Stage 2a, finding #1 -- the original version only wrapped the
  // three controller.mount() calls, leaving all DOM wiring and the fetch
  // kickoff unprotected; mirrors player-boot.js's bootShowPage(), which
  // wraps mounting AND decoration wiring in one try, returning `handle`
  // from inside it).
  try {
    const queueView = new PlaylistQueueView(queueEl, { catalogById, getMode: () => mode });
    const nowView = new PlaylistNowPlayingView(nowEl, { catalogById });
    controller.mount(queueView);
    controller.mount(nowView);

    // Hash sync is boot-level, not baked into a view -- both #pl-now and
    // #pl-queue mount/unmount independently (the affordance that makes a
    // future mini state cheap), so neither should gate whether the hash
    // updates. Gated on queueRevision, not currentIndex: the hash encodes
    // queue MEMBERSHIP/ORDER, not playback position, and revision is
    // exactly the signal that changes precisely when membership/order does
    // (see PlaylistQueueView's own gating for why a reference check can't
    // be used -- removeAt()/reorder() mutate the queue array in place).
    let lastHashRevision = -1;
    controller.mount({
      onAttach() {}, onDetach() {},
      onControllerUpdate(snapshot) {
        if (snapshot.queueRevision === lastHashRevision) return;
        lastHashRevision = snapshot.queueRevision;
        syncHash(snapshot.queue);
      },
    });

    // Resuming (a real user play, or another external claim's page giving
    // it back) clears the stale "paused elsewhere" note.
    controller.audioElement.addEventListener('play', () => {
      if (pausedByClaim) { pausedByClaim = false; updateStatus(); }
    }, { signal: abort.signal });

    // ── remaining DOM wiring (filters, length, presets, clear, generate,
    // share/save/download/player, saved-playlist actions, hashchange/storage)
    // -- all registered against `abort.signal` so destroy() removes every
    // window/document-level listener, matching player-boot.js's rationale: a
    // leaked listener could otherwise reach into a "destroyed" controller. ──
    filtersEl.addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      const g = b.dataset.group; const v = b.dataset.value;
      const key = g === 'tag' ? 'tags' : g;
      if (v === 'all') {
        filters[key] = [];
      } else {
        const i = filters[key].indexOf(v);
        if (i === -1) filters[key].push(v); else filters[key].splice(i, 1);
      }
      renderFilters();
      updateStatus();
    }, { signal: abort.signal });

    lengthEl.addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (!b || b.dataset.group !== 'mode') return;
      mode = b.dataset.value;
      renderLength();
      updateStatus();
    }, { signal: abort.signal });
    lengthEl.addEventListener('input', (e) => {
      if (e.target.id !== 'pl-amount') return;
      const v = parseInt(e.target.value, 10);
      if (v > 0) { amounts[mode] = v; updateStatus(); }
    }, { signal: abort.signal });

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        filters.artist = []; filters.venue = []; filters.source = []; filters.tags = []; filters.songwriter = [];
        renderFilters();
        updateStatus();
      }, { signal: abort.signal });
    }

    if (presetsEl) {
      presetsEl.addEventListener('click', (e) => {
        const b = e.target.closest('.pl-preset');
        if (!b) return;
        const preset = PRESETS[b.dataset.preset];
        if (!preset) return;
        filters.artist = preset.filters.artist.slice();
        filters.venue = preset.filters.venue.slice();
        filters.source = preset.filters.source.slice();
        filters.tags = preset.filters.tags.slice();
        filters.songwriter = preset.filters.songwriter.slice();
        mode = preset.mode;
        if (preset.amount) amounts[mode] = preset.amount;
        renderFilters();
        renderLength();
        updateStatus();
        const rows = buildQueue();
        if (!rows.length) return;
        controller.setQueue(rows.map(itemFromCatalogRow), { startIndex: 0, autoplay: true });
      }, { signal: abort.signal });
    }

    goBtn.addEventListener('click', () => {
      const rows = buildQueue();
      if (!rows.length) return;
      controller.setQueue(rows.map(itemFromCatalogRow), { startIndex: 0, autoplay: true });
    }, { signal: abort.signal });

    if (shareBtn) {
      shareBtn.addEventListener('click', () => {
        const ids = controller.queue.map((t) => t.id);
        const longUrl = win.location.href;
        shareBtn.textContent = '…';
        fetch('/api/playlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        })
          .then((r) => (r.ok ? r.json() : Promise.reject()))
          .then((d) => verifyShortLink(d.url))
          .then(copyShareUrl, () => copyShareUrl(longUrl));
      }, { signal: abort.signal });
    }

    if (downloadBtn) {
      downloadBtn.addEventListener('click', () => {
        const rows = rowsFromItems(controller.queue);
        if (!rows.length) return;
        const name = 'Playlist - ' + new Date().toISOString().slice(0, 10);
        window.openPasswordModal({ type: 'batch', manifest: buildPlaylistManifest(name, rows) });
      }, { signal: abort.signal });
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const items = controller.queue;
        if (!items.length) return;
        const name = (window.prompt('Name this playlist:') || '').trim();
        if (!name) return;
        if (name.length > MAX_PLAYLIST_NAME) { statusEl.textContent = 'Playlist name is too long.'; return; }
        const list = loadSaved();
        const existing = list.findIndex((p) => p.name === name);
        if (existing !== -1) {
          if (!window.confirm('Replace the existing playlist "' + name + '"?')) return;
          list.splice(existing, 1);
        }
        list.push({ name, ids: items.map((t) => t.id), created: new Date().toISOString() });
        if (!storeSaved(list)) return;
        saveBtn.textContent = 'Saved!';
        setTimeout(() => { saveBtn.textContent = 'Save playlist'; }, 1600);
      }, { signal: abort.signal });
    }

    if (savedEl) {
      savedEl.addEventListener('click', (e) => {
        const act = e.target.closest('.pl-saved-act');
        const load = e.target.closest('.pl-saved-load');
        const list = loadSaved();
        if (act) {
          const p = list[+act.dataset.i];
          if (!p) return;
          if (act.dataset.act === 'download') {
            window.openPasswordModal({ type: 'batch', manifest: buildPlaylistManifest(p.name, resolveCatalogRows(p.ids)) });
          } else if (act.dataset.act === 'delete') {
            if (!window.confirm('Delete the playlist "' + p.name + '"?')) return;
            list.splice(+act.dataset.i, 1);
            storeSaved(list);
          } else if (act.dataset.act === 'rename') {
            const name = (window.prompt('Rename playlist:', p.name) || '').trim();
            if (!name || name === p.name) return;
            if (name.length > MAX_PLAYLIST_NAME) { statusEl.textContent = 'Playlist name is too long.'; return; }
            let next = list;
            if (list.some((q) => q.name === name)) {
              if (!window.confirm('Replace the existing playlist "' + name + '"?')) return;
              next = list.filter((q) => q.name !== name);
            }
            p.name = name;
            storeSaved(next);
          }
          return;
        }
        if (load) {
          const pl = list[+load.dataset.i];
          if (!pl) return;
          const hash = '#p=' + pl.ids.join(',');
          if (win.location.hash === hash) hydrateFromHash();
          else win.location.hash = hash;
        }
      }, { signal: abort.signal });
    }

    // Selecting tracks via track-select.js's "+" buttons on this same queue
    // and clicking "Build playlist" sets a new #p=... hash without a reload.
    win.addEventListener('hashchange', () => hydrateFromHash(), { signal: abort.signal });
    // Another tab saved/renamed/deleted a playlist -- mirror it here.
    win.addEventListener('storage', (e) => {
      if (e.key === SAVED_KEY) renderSaved();
    }, { signal: abort.signal });

    // Set once the catalog fetch below actually starts; cleared on whichever
    // of {resolves, rejects, destroy() runs first} happens first, so a
    // page torn down before the catalog settles doesn't leave a stray timer
    // around to abort() a fetch nobody cares about anymore (harmless either
    // way -- see the fetch call's own comment -- but needless).
    let catalogTimeoutId = null;
    // Implementation review finding #5 (2026-08-15): destroy() used to clear
    // the TIMEOUT that would eventually abort the catalog fetch, but never
    // aborted the fetch's own AbortController directly -- so a page torn
    // down while the catalog request was still in flight left that request
    // running past teardown, with its .then()/.catch() continuation still
    // scheduled to run later against an already-destroyed controller.
    // Declared here (before `handle`, which references it) so destroy() can
    // reach it; the actual AbortController is constructed below, right next
    // to the fetch() call it belongs to -- by the time destroy() could ever
    // actually be invoked (only via the `handle` this function returns), the
    // synchronous code between here and there has already run, so the
    // closure is never read before it's assigned.
    let destroyed = false;
    const catalogAbort = new AbortController();
    const handle = {
      controller,
      destroy() {
        destroyed = true;
        abort.abort();
        if (catalogTimeoutId != null) clearTimeout(catalogTimeoutId);
        catalogAbort.abort();
        controller.destroy();
      },
    };

    renderSaved();  // needs no catalog -- names/counts come straight from storage

    // Fire-and-forget: the mounted flag (set by the caller right after this
    // function returns) must not wait on this. Still inside the transaction
    // above it, though -- kicking off fetch() itself is synchronous, and its
    // own .then/.catch chain is independently isolated (a catalog failure
    // degrades the status line, same as legacy, rather than throwing here).
    // Readiness-contract resolution (plans/dynamic-hugging-rossum.md's
    // "Blocker A continued"): /playlist/ resolves only once BOTH
    // hydrateFromHash()'s first pass and the catalog fetch's first
    // .then()/.catch() have run -- as this file's structure stands today,
    // hydrateFromHash() is only ever reachable FROM the catalog's success
    // continuation (there is nothing meaningful to hydrate against without a
    // catalog), so the two are already sequenced, not concurrent: both
    // "events" the plan asks to wait for happen together, right here, in the
    // success case. In the failure case only the catalog settles (hydration
    // never gets a chance to run at all, for the same reason) -- resolving
    // there too is what keeps this from hanging forever on a genuinely
    // broken catalog fetch, matching the plan's "never zero (hung)" bar.
    //
    // Takes hydrateFromHash()'s full { recognized, hadIds } result, not just
    // hadIds: initialIntent must be 'page-queue' for ANY recognized #p=
    // decision, including the all-unknown-ids one that clears the queue --
    // see hydrateFromHash()'s own comment (implementation review finding #5).
    function resolveReady(hydration) {
      if (win.__resolvePlaybackHost) {
        win.__resolvePlaybackHost({
          mode: 'controller', controller,
          initialIntent: hydration.recognized ? 'page-queue' : 'none',
        });
      }
    }
    // A local timeout scoped ONLY to this one fetch call -- before this fix,
    // readiness resolved solely from the fetch's own .then()/.catch() chain,
    // so a request that never SETTLES at all (not just one that rejects -- a
    // genuinely stalled connection) left PLAYBACK_HOST_READY pending forever.
    // Aborting on timeout routes straight into the SAME .catch() below as any
    // other network failure -- no separate branch, and critically, no second
    // controller ever gets constructed anywhere as a result (there is only
    // ever the one controller already built above, regardless of catalog
    // outcome) -- this is deliberately NOT the generic page-wide host timeout
    // the design review rejected.
    catalogTimeoutId = setTimeout(() => catalogAbort.abort(), CATALOG_FETCH_TIMEOUT_MS);
    fetch('/assets/tracks.json', { signal: catalogAbort.signal })
      .then((r) => {
        // Round-3 correction (2026-08-15): this guard was previously ONLY on
        // the second .then() below, so a request that settled successfully
        // after destroy() (see the comment on the next .then()) still had
        // its response body parsed here first -- wasted work, and contrary
        // to the "both continuations check destroyed first" claim this file
        // made about itself. Checked here too so a destroyed handle's fetch
        // does nothing at all past this point, not even parse the response.
        if (destroyed) return null;
        return r.json();
      })
      .then((data) => {
        // Finding #5's extra guard: destroy() above aborts catalogAbort
        // directly now, which is normally enough on its own to make this
        // continuation never run at all (an aborted fetch rejects, landing
        // in .catch() below, not here) -- but a request that was already
        // past the point of no return over the network by the time destroy()
        // ran can still settle successfully regardless of the abort signal.
        // This flag is what actually stops a destroyed handle's continuation
        // from touching the (already-destroyed) controller/DOM in that case.
        // (The .then() above already returns null instead of a real body
        // once destroyed, so `data` arrives here as null in that case too --
        // re-checked regardless, since relying on that alone would silently
        // break if the guard above were ever removed.)
        if (destroyed) return;
        clearTimeout(catalogTimeoutId);
        CATALOG = data;
        catalogById.clear();
        data.forEach((row) => catalogById.set(row.id, row));
        renderFilters();
        renderLength();
        updateStatus();
        const hydration = hydrateFromHash();
        // The initial renderSaved() above ran against an empty catalog (by
        // design, so names/counts show immediately from storage alone) --
        // redo it now that resolveCatalogRows() can actually look tracks up,
        // for the Download buttons' size tooltips.
        renderSaved();
        resolveReady(hydration);
      })
      .catch((e) => {
        if (destroyed) return; // see the .then() branch's comment above
        clearTimeout(catalogTimeoutId);
        statusEl.textContent = 'Could not load the track catalog: ' + e;
        // Finding #4 (2026-08-15): a genuine #p=a,b share link, hit by a
        // transient network failure or the timeout above, must not be
        // reported identically to "no hash at all" -- that would let a
        // future mini-player silently restore an unrelated persisted session
        // over what the URL explicitly asked for. hashIsRecognizedShareLink()
        // needs no catalog to answer this -- only the hash's own shape.
        resolveReady({ recognized: hashIsRecognizedShareLink(), hadIds: false });
      });

    return handle;
  } catch (e) {
    abort.abort();
    // Destroy any partially-constructed controller BEFORE resolving --
    // nothing half-built should be left listening/holding the <audio>
    // element by the time a future mini-player might see 'none' and decide
    // to construct its own. Resolves 'none', not 'legacy': /playlist/ has no
    // fallback engine to defer to (see the module tag's onerror= attribute
    // in pages.py's build_playlist() for the same reasoning on the sibling
    // module-load-failure signal).
    controller.destroy();
    if (win.__resolvePlaybackHost) win.__resolvePlaybackHost({ mode: 'none' });
    throw e;
  }
}

// ── auto-run ─────────────────────────────────────────────────────────────
// Unconditional as of Stage 2c -- this is the only engine on the page now,
// so there's no `?engine=`/PLAYLIST_ENGINE flag to check and no legacy
// engine to defer to. The `!window[MOUNTED_FLAG]` guard stays: it keeps a
// second load of this module (e.g. a stray duplicate <script> tag) from
// mounting a second controller instance on top of the first.
if (typeof window !== 'undefined' && !window[MOUNTED_FLAG]) {
  try {
    window.PLAYLIST_BOOT = bootPlaylistPage(document, window);
    window[MOUNTED_FLAG] = true;
  } catch (e) {
    console.error('[playlist-boot] controller mount failed', e);
    // Readiness-contract backstop: bootPlaylistPage()'s own try/catch
    // already resolves 'none' for anything that throws AFTER its controller
    // is constructed — but the required-markup-missing check at the very
    // top of that function throws BEFORE `new PlaybackController(...)` even
    // runs, bypassing that catch entirely. Resolving here too closes that
    // gap; a second resolve() call on an already-settled promise is a
    // harmless no-op, so this is safe to run unconditionally alongside it.
    if (window.__resolvePlaybackHost) window.__resolvePlaybackHost({ mode: 'none' });
  }
}
