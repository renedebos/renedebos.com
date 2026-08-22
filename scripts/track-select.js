// Cross-page-type playlist selection: the +/checkmark "add" button that
// appears on every track row (show pages, the individual song page, the
// /songs/ matrix expand rows, and the /playlist/ queue itself — see
// PLAYLIST FEATURE.md Phase 5). Selection persists in localStorage across
// page navigations (Phase 5b) — browse a show, pick a few songs, browse to
// a different show or the songs matrix, pick more, then commit the whole
// running selection to a playlist from wherever you are.
//
// trackAddButtonHtml() is exposed as a global so songs.js (a separate IIFE,
// loaded after this file) and playlist-views.js (an ES module, reads it off
// `window` rather than importing it — see its own use of window.trackAddButtonHtml)
// can build the same button markup client-side; scripts/sitegen/fragments.py's
// track_add_button() is the server-side twin — keep all three visually
// identical by convention.
//
// This file also owns the per-row SHARE control (2026-08-22,
// plans/share/track-share-plan.md §5's deferred "share without playing").
// It lives here rather than in the player because it needs nothing from the
// player: everything it shares is already in the row's data-item, so the
// button works on a page whose engine never mounted, and on a row nobody has
// pressed play on — which is the entire point of it.
(function () {
  var STORE_KEY = 'trackSelection';

  function loadSelection() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }

  function saveSelection() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(selected)); } catch (e) {}
  }

  var selected = loadSelection();  // track ids, in the order they were added

  var PLUS_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 2v12M2 8h12"/></svg>';
  var CHECK_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg>';

  // Same glyph as the mini-player bar's share button (miniplayer-views.js's
  // SHARE_ICON) — one action, one drawing.
  var SHARE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" '
    + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="2.6"/>'
    + '<circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/>'
    + '<path d="M8.2 13.3l7.6 4.4M15.8 6.3l-7.6 4.4"/></svg>';

  // An <a href>, not a <button>, for the same reason .download-btn is: with
  // the handler below it opens the share sheet/popover, and with no
  // JavaScript at all it simply navigates to the share page — where the URL
  // is in the address bar and can be copied by hand. A dead <button> would
  // be the alternative, and this is now the PRIMARY way to share a song, so
  // it must not depend on a module load succeeding.
  // Escapes here rather than at the call sites: this builder takes a song
  // title straight from the catalog (apostrophes and quotes are ordinary in
  // them) and drops it into two attributes, so making every caller remember
  // is how one of them eventually forgets.
  function escAttr(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  window.trackShareButtonHtml = function (shareUrl, title) {
    if (!shareUrl) return '';
    var label = title ? 'Share &ldquo;' + escAttr(title) + '&rdquo;' : 'Share this song';
    return '<a class="track-share" href="' + escAttr(shareUrl) + '" aria-label="' + label
      + '" title="' + label + '">' + SHARE_SVG + '</a>';
  };

  window.trackAddButtonHtml = function (id) {
    var on = selected.indexOf(id) !== -1;
    var label = on ? 'Remove from playlist selection' : 'Add to playlist selection';
    return '<button type="button" class="track-add" data-id="' + id + '" aria-pressed="' + on
      + '" aria-label="' + label + '" title="' + label + '">'
      + (on ? CHECK_SVG : PLUS_SVG) + '</button>';
  };

  var bar = null;
  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className = 'track-select-bar';
    bar.hidden = true;
    bar.innerHTML = '<span class="tsb-count"></span>'
      + '<button type="button" class="tsb-clear">Clear</button>'
      + '<button type="button" class="tsb-add pl-generate">Build playlist &rarr;</button>';
    document.body.appendChild(bar);
    bar.querySelector('.tsb-clear').addEventListener('click', clearSelection);
    bar.querySelector('.tsb-add').addEventListener('click', goToPlaylist);
    return bar;
  }

  function renderBar() {
    if (!selected.length) { if (bar) bar.hidden = true; return; }
    var b = ensureBar();
    b.hidden = false;
    b.querySelector('.tsb-count').textContent =
      selected.length + (selected.length === 1 ? ' song selected' : ' songs selected');
  }

  // Repaints every "+"/"✓" button currently in the DOM against `selected` —
  // used instead of touching just the clicked button, since `selected` can
  // change out from under a page (another tab, or a fresh localStorage read)
  // in ways a single button's before/after state doesn't capture.
  // The ids a "Select all" button governs: every "+" button inside its
  // data-target (the show page's .track-list, the song page's .song-occs,
  // /playlist/'s #pl-queue), read from the DOM at click/sync time.
  function selectAllIds(btn) {
    var root = (btn.dataset.target && document.querySelector(btn.dataset.target)) || document;
    return Array.prototype.map.call(root.querySelectorAll('.track-add[data-id]'), function (b) {
      return b.dataset.id;
    });
  }
  function allSelected(ids) {
    return ids.length > 0 && ids.every(function (id) { return selected.indexOf(id) !== -1; });
  }

  function syncAllButtons() {
    // "Select all" is a true toggle (Rene, 2026-08-21): once every track in
    // its list is selected it reads "Unselect all", carries aria-pressed and
    // the filled face, and the click below removes them. A partial selection
    // still reads "Select all" -- clicking then adds whatever is missing.
    document.querySelectorAll('.select-all').forEach(function (b) {
      var on = allSelected(selectAllIds(b));
      b.setAttribute('aria-pressed', on);
      b.textContent = on ? 'Unselect all' : 'Select all';
    });
    document.querySelectorAll('.track-add[data-id]').forEach(function (b) {
      var on = selected.indexOf(b.dataset.id) !== -1;
      var label = on ? 'Remove from playlist selection' : 'Add to playlist selection';
      b.setAttribute('aria-pressed', on);
      b.innerHTML = on ? CHECK_SVG : PLUS_SVG;
      b.setAttribute('aria-label', label);
      b.setAttribute('title', label);
    });
    document.querySelectorAll('.show-add[data-ids]').forEach(function (b) {
      var ids = b.dataset.ids.split(' ');
      var on = ids.every(function (id) { return selected.indexOf(id) !== -1; });
      var label = on ? 'Remove whole show from playlist selection' : 'Add whole show to playlist selection';
      b.setAttribute('aria-pressed', on);
      b.innerHTML = on ? CHECK_SVG : PLUS_SVG;
      b.setAttribute('aria-label', label);
      b.setAttribute('title', label);
    });
  }

  function toggle(id) {
    // Re-read right before mutating: each page/tab only captures `selected`
    // once, at load time, so if a *different* tab (or an earlier page in the
    // same tab, in rare bfcache cases) has since saved a different selection,
    // this page's stale in-memory copy would otherwise silently clobber it on
    // the next save. Re-reading here closes that race.
    selected = loadSelection();
    var i = selected.indexOf(id);
    if (i === -1) selected.push(id); else selected.splice(i, 1);
    saveSelection();
    syncAllButtons();
    renderBar();
  }

  // Archive-page "add whole show" button: true toggle, like a single track's
  // +/checkmark — if every one of the show's tracks is already selected,
  // clicking removes them all; otherwise it adds whatever's missing. Ids come
  // straight off the clicked button's data-ids (build-time-known, see
  // show_add_button() in fragments.py) rather than a DOM scan, since the
  // archive page renders no per-track markup to scan.
  function toggleShow(ids) {
    selected = loadSelection();
    var allIn = ids.every(function (id) { return selected.indexOf(id) !== -1; });
    if (allIn) {
      selected = selected.filter(function (id) { return ids.indexOf(id) === -1; });
    } else {
      ids.forEach(function (id) { if (selected.indexOf(id) === -1) selected.push(id); });
    }
    saveSelection();
    syncAllButtons();
    renderBar();
  }

  function clearSelection() {
    selected = [];
    saveSelection();
    syncAllButtons();
    renderBar();
  }

  function goToPlaylist() {
    selected = loadSelection();  // same race guard as toggle()
    if (!selected.length) return;
    var hash = '#p=' + selected.join(',');
    if (location.pathname === '/playlist/') {
      // playlist-boot.js listens for hashchange and re-hydrates the queue from it —
      // this is the "build a new playlist from a selection within an existing
      // playlist" case. Same-value hash (re-adding the exact current queue)
      // wouldn't fire hashchange, but that's a no-op anyway.
      location.hash = hash;
    } else {
      location.href = '/playlist/' + hash;
    }
    clearSelection();
  }

  document.addEventListener('click', function (e) {
    // Checked ahead of .track-add below: the archive page's show-row is
    // itself a link, so this button's click must not also follow it.
    var showBtn = e.target.closest('.show-add');
    if (showBtn) {
      e.preventDefault(); e.stopPropagation();
      toggleShow(showBtn.dataset.ids.split(' '));
      return;
    }
    // Checked before .track-add for no ordering reason — the two never nest —
    // but grouped with it because both are "row buttons that are not the
    // player". stopPropagation as well as preventDefault: the legacy engine
    // binds click handlers on the row itself, and sharing must not also seek
    // or start playback.
    var shareBtn = e.target.closest('.track-share');
    if (shareBtn) {
      e.preventDefault();
      e.stopPropagation();
      shareRow(shareBtn);
      return;
    }
    var btn = e.target.closest('.track-add');
    if (btn) { e.preventDefault(); toggle(btn.dataset.id); return; }
    var all = e.target.closest('.select-all');
    if (all) {
      selected = loadSelection();  // same race guard as toggle()
      var ids = selectAllIds(all);
      if (!ids.length) return;
      if (allSelected(ids)) {
        selected = selected.filter(function (id) { return ids.indexOf(id) === -1; });
      } else {
        ids.forEach(function (id) { if (selected.indexOf(id) === -1) selected.push(id); });
      }
      saveSelection(); syncAllButtons(); renderBar();
    }
  });

  // The row's data-item already holds everything share.js wants (title,
  // artist, venue, date, shareUrl) — the same normalized item the player
  // reads — so the share control needs no second source of truth and no
  // controller. share.js is imported on the FIRST press, exactly as
  // miniplayer-views.js does it, so pages where nobody shares never fetch it.
  function shareRow(btn) {
    var row = btn.closest('[data-item]');
    var item = null;
    try { item = row && JSON.parse(row.dataset.item); } catch (e) { /* fall through */ }
    // A row with unreadable data-item still has an honest link on the button
    // itself; share.js falls back to pageUrl/origin for anything missing.
    if (!item) item = { title: btn.getAttribute('title') || '', shareUrl: btn.getAttribute('href') };
    import('/assets/share.js')
      .then(function (m) { m.shareItem(item, btn); })
      // The module failed to load: follow the link instead of doing nothing.
      // The share page's own URL is then the thing to copy, which is a worse
      // but real answer rather than a button that visibly does nothing.
      .catch(function () { location.href = btn.getAttribute('href'); });
  }

  // /playlist/ re-renders its queue (and the "Select all" button with it) on
  // every controller change; playlist-views.js calls this afterwards so the
  // fresh buttons are painted against the stored selection. Off `window`
  // because this is a classic script and that one is a module -- the same
  // route trackAddButtonHtml takes.
  window.syncTrackSelection = syncAllButtons;

  // Keep this tab's buttons/bar in sync if the selection changes in another
  // tab while this page stays open — `storage` only fires in other same-
  // origin tabs, never the one that made the change.
  window.addEventListener('storage', function (e) {
    if (e.key !== STORE_KEY) return;
    selected = loadSelection();
    syncAllButtons();
    renderBar();
  });

  // Landing on /playlist/ itself with a pending selection and no hash to
  // follow (i.e. not someone else's shared link) — load it straight away
  // rather than requiring a second, easy-to-miss click on the floating bar.
  // "Go to Playlist" should just show what was picked, not stage it.
  if (location.pathname === '/playlist/' && !location.hash && selected.length) {
    goToPlaylist();
  } else {
    syncAllButtons();
    renderBar();
  }
})();
