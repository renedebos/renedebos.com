// Cross-page-type playlist selection: the +/checkmark "add" button that
// appears on every track row (show pages, the individual song page, the
// /songs/ matrix expand rows, and the /playlist/ queue itself — see
// PLAYLIST FEATURE.md Phase 5). Selection persists in localStorage across
// page navigations (Phase 5b) — browse a show, pick a few songs, browse to
// a different show or the songs matrix, pick more, then commit the whole
// running selection to a playlist from wherever you are.
//
// trackAddButtonHtml() is exposed as a global so songs.js and playlist.js
// (separate IIFEs, both loaded after this file) can build the same button
// markup client-side; scripts/sitegen/fragments.py's track_add_button() is
// the server-side twin — keep the two visually identical by convention.
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
    return '<button type="button" class="track-add" data-id="' + id + '" aria-pressed="' + on
      + '" aria-label="' + (on ? 'Remove from playlist selection' : 'Add to playlist selection') + '">'
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
      + '<button type="button" class="tsb-add pl-generate">Add to playlist &rarr;</button>';
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

  function setButtonState(id, on) {
    document.querySelectorAll('.track-add[data-id="' + CSS.escape(id) + '"]').forEach(function (b) {
      b.setAttribute('aria-pressed', on);
      b.innerHTML = on ? CHECK_SVG : PLUS_SVG;
      b.setAttribute('aria-label', on ? 'Remove from playlist selection' : 'Add to playlist selection');
    });
  }

  function toggle(id) {
    var i = selected.indexOf(id);
    var on = i === -1;
    if (on) selected.push(id); else selected.splice(i, 1);
    setButtonState(id, on);
    saveSelection();
    renderBar();
  }

  function clearSelection() {
    selected.slice().forEach(function (id) { setButtonState(id, false); });
    selected = [];
    saveSelection();
    renderBar();
  }

  function goToPlaylist() {
    if (!selected.length) return;
    var hash = '#p=' + selected.join(',');
    if (location.pathname === '/playlist/') {
      // playlist.js listens for hashchange and re-hydrates the queue from it —
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
    var btn = e.target.closest('.track-add');
    if (btn) { e.preventDefault(); toggle(btn.dataset.id); return; }
    var all = e.target.closest('.select-all');
    if (all) {
      var root = (all.dataset.target && document.querySelector(all.dataset.target)) || document;
      root.querySelectorAll('.track-add[aria-pressed="false"]').forEach(function (b) {
        toggle(b.dataset.id);
      });
    }
  });

  // Server-rendered rows (show pages, the individual song page) always paint
  // the unselected state at build time — sync them against a selection
  // carried over from a previous page now that it persists. Client-rendered
  // rows (songs matrix, playlist queue) don't need this: trackAddButtonHtml()
  // already reads `selected` at the moment they're built.
  document.querySelectorAll('.track-add[data-id]').forEach(function (b) {
    if (selected.indexOf(b.dataset.id) !== -1) {
      b.setAttribute('aria-pressed', 'true');
      b.innerHTML = CHECK_SVG;
      b.setAttribute('aria-label', 'Remove from playlist selection');
    }
  });
  renderBar();
})();
