/* Song concordance controls: view (list/grid), sort (plays/A–Z), artist filter.
   Pure DOM reordering + hiding — no data fetch. Players are handled by player.js. */
(function () {
  var listEl = document.getElementById("song-list");
  var gridEl = document.getElementById("song-grid");
  if (!listEl) return;

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

  function apply() {
    listEl.hidden = state.view !== "list";
    if (gridEl) gridEl.hidden = state.view !== "grid";
    sortIn(listEl, ".song-item");
    if (gridEl) sortIn(gridEl.querySelector("tbody"), "tr");
    var shown = filter(listEl.querySelectorAll(".song-item"));
    if (gridEl) filter(gridEl.querySelectorAll("tbody tr"));
    var empty = document.getElementById("songs-empty");
    if (empty) empty.hidden = shown !== 0;
  }

  apply();
})();
