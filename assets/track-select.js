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
      + '<button type="button" class="tsb-player pl-generate pl-share">Add to player</button>'
      + '<button type="button" class="tsb-add pl-generate">Build playlist &rarr;</button>';
    document.body.appendChild(bar);
    bar.querySelector('.tsb-clear').addEventListener('click', clearSelection);
    bar.querySelector('.tsb-player').addEventListener('click', addToPlayer);
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
  function syncAllButtons() {
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

  // Hands the selection to the continuous-player popup (see sendToPlayer()
  // in player.js, loaded globally on every page this bar appears on) instead
  // of navigating to /playlist/ — stays on whatever page you're browsing,
  // and doesn't steal focus from it (opts.focus: false), unlike "Build
  // playlist" which is a deliberate "take me there" action.
  function addToPlayer() {
    selected = loadSelection();  // same race guard as toggle()/goToPlaylist()
    if (!selected.length) return;
    var added = sendToPlayer(selected, { focus: false });
    if (added === null) return;  // popup blocked — the browser surfaces that itself
    // Clear the selection but keep the bar visible long enough to say what
    // happened — sendToPlayer dedupes, so "add" can be a no-op and silence
    // here would look broken. clearSelection() would hide the bar instantly.
    selected = [];
    saveSelection();
    syncAllButtons();
    var btn = bar.querySelector('.tsb-player');
    bar.querySelector('.tsb-count').textContent = '';
    btn.textContent = added
      ? 'Added ' + added + (added === 1 ? ' song' : ' songs')
      : 'Already in player';
    setTimeout(function () {
      btn.textContent = 'Add to player';
      renderBar();
    }, 1600);
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
    var btn = e.target.closest('.track-add');
    if (btn) { e.preventDefault(); toggle(btn.dataset.id); return; }
    var all = e.target.closest('.select-all');
    if (all) {
      selected = loadSelection();
      var root = (all.dataset.target && document.querySelector(all.dataset.target)) || document;
      var changed = false;
      root.querySelectorAll('.track-add[data-id]').forEach(function (b) {
        if (selected.indexOf(b.dataset.id) === -1) { selected.push(b.dataset.id); changed = true; }
      });
      if (changed) { saveSelection(); syncAllButtons(); renderBar(); }
    }
  });

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
