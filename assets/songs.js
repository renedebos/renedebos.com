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

  function occRowHtml(o, songTitle) {
    var label = songTitle + ", " + o.artist_name + ", " + o.date;
    var anchor = o.url + "#track-" + o.num;
    var stream = WORKER + "/stream?file=" + encodeURIComponent(o.file) + (o.ver ? "&v=" + o.ver : "");
    var dur = o.duration ? '<span class="time-label">' + escOcc(o.duration) + "</span>" : "";
    return '<div class="song-occ">'
      + '<div class="song-occ-head">'
      + '<a class="artist-chip artist-' + o.artist + '" href="' + escOcc(anchor) + '">' + escOcc(o.artist_name) + "</a>"
      + '<span class="song-occ-where">' + escOcc(o.venue) + " &middot; " + escOcc(o.date) + "</span>"
      + '<a class="song-occ-open" href="' + escOcc(anchor) + '">open on show page &rarr;</a>'
      + "</div>"
      + '<div class="custom-player" data-src="' + escOcc(stream) + '">'
      + '<button class="play-btn" aria-label="Play ' + escOcc(label) + '" data-play-label="' + escOcc(label) + '">' + playIcon + "</button>"
      + '<div class="progress-wrap">'
      + '<input type="range" class="progress-range" min="0" max="' + RANGE_MAX + '" value="0" step="1" aria-label="Seek ' + escOcc(label) + '" aria-valuetext="0:00">'
      + '<div class="time-row"><span class="time-label current">0:00</span>' + dur + "</div>"
      + "</div>"
      + "</div>"
      + "</div>";
  }

  function renderSongOccs(details) {
    var container = details.querySelector(".song-occs");
    if (!container || container.childElementCount) return; // already rendered
    var slug = container.dataset.song;
    loadOccurrences().then(function (data) {
      var entry = data[slug];
      if (!entry) return;
      container.innerHTML = entry.occ.map(function (o) { return occRowHtml(o, entry.title); }).join("\n");
      initCustomPlayers(container);
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
