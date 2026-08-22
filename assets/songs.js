/* Song concordance controls: view (list/grid), sort (plays/A–Z), artist filter.
   Pure DOM reordering + hiding for the list/grid itself — no data fetch there.
   Performance rows (each with its own player) are a separate concern: fetched
   from assets/song-occurrences.json and rendered into a song's .song-occs the
   first time its <details> opens, so the ~400 players across the whole index
   aren't sitting in the page (and initialized) until actually requested.
   Reuses player.js's playIcon/RANGE_MAX/WORKER/initCustomPlayers — both scripts
   are classic (non-module), so top-level const/function declarations in one
   are visible by name in the other as long as player.js loads first. */
(function () {
  var listEl = document.getElementById("song-list");
  var gridEl = document.getElementById("song-grid");
  if (!listEl) return;

  var escOcc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  };

  var occPromise = null;
  function loadOccurrences() {
    if (!occPromise) occPromise = fetch("/assets/song-occurrences.json").then(function (r) { return r.json(); });
    return occPromise;
  }

  var SOURCE_LABEL = { SBD: "Soundboard", AUD: "Audience recording" };

  // "M:SS" -> whole seconds. Mirrors sitegen/core.py's _duration_sec() —
  // keep the two in sync (this is the JS-rendered counterpart to
  // fragments.py's _song_occ_html(), which uses the Python original).
  function durationSec(d) {
    if (!d) return null;
    var parts = String(d).split(":");
    if (parts.length !== 2) return null;
    var m = parseInt(parts[0], 10), s = parseInt(parts[1], 10);
    if (!isFinite(m) || !isFinite(s)) return null;
    return m * 60 + s;
  }

  // Builds the same data-item schema playable_item_attr() (sitegen/
  // fragments.py) produces for a show-page track row / song-page server-
  // rendered occurrence row — see that function's docstring for the field
  // list. Consumed by itemFromRowElement()/normalizeItem() in song-boot.js,
  // exactly like a show page's rows.
  function occItemJson(o, songTitle, trackId, anchor, stream, loudStream) {
    var lossless = o.flac ? { key: o.flac, format: "flac", sizeMb: o.flac_size_mb || null,
      title: o.flac.split("/").pop() } : null;
    return JSON.stringify({
      id: trackId,
      kind: "track",
      streamUrl: stream,
      // The -14 loud render, or null when this track has none — same shape and
      // same rule as the server-rendered row in _song_occ_html(): keep the two
      // builders in sync (see occRowHtml()'s comment).
      loudUrl: loudStream || null,
      title: songTitle,
      artist: o.artist_name || "",
      venue: o.venue || null,
      date: o.date || null,
      dateDisplay: o.date || null,
      durationSec: durationSec(o.duration),
      durationLabel: o.duration || null,
      peaksKey: null,
      pageUrl: anchor,
      // Short share link, from the build's code for this performance (see
      // track_share_url() in sitegen/core.py) -- same absolute form the
      // server-rendered rows carry.
      shareUrl: o.code ? "https://renedebos.com/t/" + o.code + "/" : null,
      playLabel: songTitle + ", " + o.artist_name + ", " + o.date,
      downloads: { lossless: lossless },
      dropouts: false,
    });
  }

  // Up-right arrow for the row's "open on show page" link -- the JS twin of
  // fragments.py's OPEN_SVG.
  var openIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7"/><path d="M8 7h9v9"/></svg>';

  // The show page's own no-waveform track row, byte-for-byte the shape
  // _song_occ_html() (sitegen/fragments.py) renders on a song detail page:
  // chip in the track-number slot, "venue · date" as the title, the
  // show-page link as a ↗ icon where a show row keeps its download button.
  // data-src/data-item ride on the row itself so song-boot.js's PlayerView
  // and the initCustomPlayers() fallback both bind to it exactly as they do
  // to a show page's rows.
  function occRowHtml(o, songTitle) {
    var label = songTitle + ", " + o.artist_name + ", " + o.date;
    var anchor = o.url + "#track-" + o.num;
    var stream = WORKER + "/stream?file=" + encodeURIComponent(o.file) + (o.ver ? "&v=" + o.ver : "");
    var loudStream = o.loud
      ? WORKER + "/stream?file=" + encodeURIComponent(o.loud) + (o.loud_ver ? "&v=" + o.loud_ver : "")
      : null;
    var dur = o.duration || "";
    var trackId = o.slug + "-" + (o.num < 10 ? "0" + o.num : o.num);
    var sizes = [];
    if (o.flac_size_mb) sizes.push("FLAC " + o.flac_size_mb + " MB");
    if (o.size_mb) sizes.push("MP3 " + o.size_mb + " MB");
    var info = JSON.stringify([
      ["Title", songTitle],
      ["Venue", o.venue],
      ["Date", o.date],
      ["Source", SOURCE_LABEL[o.source] || o.source || "—"],
      ["Duration", o.duration || "—"],
      ["Size", sizes.join(" · ") || "—"],
      ["Process version", o.proc_ver ? "v" + o.proc_ver : "Not yet processed"],
    ]);
    var itemJson = occItemJson(o, songTitle, trackId, anchor, stream, loudStream);
    return '<div class="track-row custom-player song-occ" data-src="' + escOcc(stream) + '" data-item="' + escOcc(itemJson) + '">'
      + '<button class="play-btn" aria-label="Play ' + escOcc(label) + '" data-play-label="' + escOcc(label) + '">' + playIcon + "</button>"
      + '<div class="track-main">'
      + '<a class="artist-chip artist-' + o.artist + '" href="' + escOcc(anchor) + '">' + escOcc(o.artist_name) + "</a>"
      + '<span class="track-title song-occ-where" data-info="' + escOcc(info) + '">'
      + '<span class="occ-venue">' + escOcc(o.venue) + '</span><span class="occ-date">' + escOcc(o.date) + "</span></span>"
      + "</div>"
      + '<span class="time-label current" data-duration="' + escOcc(dur) + '">0:00' + (dur ? " / " + escOcc(dur) : "") + "</span>"
      + '<a class="track-open" href="' + escOcc(anchor) + '" title="Open on show page" aria-label="Open ' + escOcc(label) + ' on its show page">' + openIcon + "</a>"
      + '<input type="range" class="progress-range" min="0" max="' + RANGE_MAX + '" value="0" step="1" aria-label="Seek ' + escOcc(label) + '" aria-valuetext="0:00' + (dur ? " of " + escOcc(dur) : "") + '">'
      // Per-row share, on the active row only (track-select.js owns the
      // control and the click; fragments.py's track_share_button() is the
      // server-side twin these rows are meant to match byte-for-byte).
      // Empty string when this performance has no code, same as the server.
      + trackShareButtonHtml(o.code ? "https://renedebos.com/t/" + o.code + "/" : null, songTitle)
      + trackAddButtonHtml(trackId)
      + "</div>";
  }

  // The Archive/Loud control ships hidden on this page and appears the first
  // time a song is opened -- see variant_toggle(deferred=True). At load there
  // is no player here at all (rows are inserted lazily), so showing a note
  // that says "You are hearing the Loud version" would be describing a state
  // the page is not in.
  //
  // Called from renderSongOccs AFTER the rows land, so it covers the
  // song-boot.js path and the initCustomPlayers() fallback alike: if the
  // module engine never mounted, the rows still play and the disclosure still
  // has to appear.
  //
  // Two frames, not one: the element goes from display:none to a collapsed
  // grid row, and the browser needs to have rendered the collapsed state
  // before the transition to 1fr has anything to animate from.
  function revealVariantPick() {
    var wrap = document.querySelector("[data-variant-reveal]");
    if (!wrap || !wrap.hidden) return;
    wrap.hidden = false;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { wrap.classList.add("is-open"); });
    });
  }

  function renderSongOccs(details) {
    var container = details.querySelector(".song-occs");
    if (!container || container.childElementCount) return; // already rendered
    var slug = container.dataset.song;
    loadOccurrences().then(function (data) {
      var entry = data[slug];
      if (!entry) return;
      container.innerHTML = entry.occ.map(function (o) { return occRowHtml(o, entry.title); }).join("\n");
      revealVariantPick();
      // song-boot.js is the primary engine (same handshake show pages use —
      // see its own header comment); initCustomPlayers() is retained
      // specifically as the fallback for when it never mounted (module
      // 404/parse failure, or an in-script throw during its own boot).
      if (window.PLAYER_ENGINE_MOUNTED && window.SONG_BOOT) {
        window.SONG_BOOT.mountRows(container);
      } else {
        initCustomPlayers(container);
      }
    });
  }

  listEl.querySelectorAll(".song-item").forEach(function (details) {
    details.addEventListener("toggle", function () {
      if (details.open) renderSongOccs(details);
    });
  });

  var state = { view: "list", sort: "plays", artist: "all", query: "" };

  document.querySelectorAll(".songs-controls .seg button").forEach(function (b) {
    b.addEventListener("click", function () {
      var role = b.parentNode.getAttribute("data-role");
      state[role] = b.getAttribute("data-" + role);
      b.parentNode.querySelectorAll("button").forEach(function (x) {
        x.classList.toggle("active", x === b);
      });
      apply();
    });
  });

  var searchEl = document.getElementById("song-search");
  if (searchEl) searchEl.addEventListener("input", function () {
    state.query = searchEl.value.trim().toLowerCase();
    apply();
  });

  function sortIn(container, selector) {
    if (!container) return;
    var nodes = [].slice.call(container.querySelectorAll(selector));
    nodes.sort(function (a, b) {
      if (state.sort === "az") return a.dataset.title.localeCompare(b.dataset.title);
      return (+b.dataset.plays) - (+a.dataset.plays) ||
             a.dataset.title.localeCompare(b.dataset.title);
    });
    nodes.forEach(function (n) { container.appendChild(n); });
  }

  function filter(nodes) {
    var shown = 0;
    [].forEach.call(nodes, function (n) {
      var okArtist = state.artist === "all" ||
        (" " + n.dataset.artists + " ").indexOf(" " + state.artist + " ") >= 0;
      var okQuery = !state.query || n.dataset.title.indexOf(state.query) >= 0;
      n.hidden = !(okArtist && okQuery);
      if (!n.hidden) shown++;
    });
    return shown;
  }

  function filterGridCols() {
    // In the grid, an artist filter also hides the other artists' show columns
    // (every cell carries data-artist), so picking "Jerry" leaves only Jerry's
    // shows — otherwise the rows filter but all columns stay and it looks unfiltered.
    if (!gridEl) return;
    var hideOthers = state.artist !== "all";
    gridEl.querySelectorAll("[data-artist]").forEach(function (cell) {
      cell.hidden = hideOthers && cell.dataset.artist !== state.artist;
    });
  }

  function apply() {
    listEl.hidden = state.view !== "list";
    if (gridEl) gridEl.hidden = state.view !== "grid";
    sortIn(listEl, ".song-item");
    if (gridEl) sortIn(gridEl.querySelector("tbody"), "tr");
    var shown = filter(listEl.querySelectorAll(".song-item"));
    if (gridEl) { filter(gridEl.querySelectorAll("tbody tr")); filterGridCols(); }
    var empty = document.getElementById("songs-empty");
    if (empty) empty.hidden = shown !== 0;
  }

  apply();
})();
