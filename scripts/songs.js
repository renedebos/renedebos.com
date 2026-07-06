/* Song concordance controls: view (list/grid), sort (plays/A–Z), artist filter.
   Pure DOM reordering + hiding — no data fetch. Players are handled by player.js. */
(function () {
  var listEl = document.getElementById("song-list");
  var gridEl = document.getElementById("song-grid");
  if (!listEl) return;

  var state = { view: "list", sort: "plays", artist: "all" };

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
    [].forEach.call(nodes, function (n) {
      n.hidden = !(state.artist === "all" ||
        (" " + n.dataset.artists + " ").indexOf(" " + state.artist + " ") >= 0);
    });
  }

  function apply() {
    listEl.hidden = state.view !== "list";
    if (gridEl) gridEl.hidden = state.view !== "grid";
    sortIn(listEl, ".song-item");
    if (gridEl) sortIn(gridEl.querySelector("tbody"), "tr");
    filter(listEl.querySelectorAll(".song-item"));
    if (gridEl) filter(gridEl.querySelectorAll("tbody tr"));
  }

  apply();
})();
