// Client-side show listing for the homepage. Loads the build-generated
// assets/home-shows.json and renders it sorted by date/artist/venue —
// merges the old separate /archive/ page into "/" (2026-07-19) so the
// full catalog doesn't live a click away from a stale "recently added" teaser.
(function () {
  var sectionsEl = document.getElementById("sections");
  var segs = document.querySelectorAll(".seg[data-sort]");
  if (!sectionsEl || !segs.length) return;

  var RING_ICON = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none">' +
    '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.2"/>' +
    '<circle cx="12" cy="12" r="6" stroke="currentColor" stroke-width="1.2"/>' +
    '<circle cx="12" cy="12" r="2" fill="currentColor"/></svg>';

  var SHOWS = [];

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function cardHTML(s) {
    var star = s.highlight ? '<span class="star" title="Highlight show">&#9733;</span>' : "";
    var preEdit = s.preEdit
      ? '<span class="pre-edit-badge" title="' + esc(s.preEditTitle) + '">' + esc(s.preEdit) + "</span>"
      : "";
    return '<a class="card" href="' + esc(s.url) + '">' +
      '<div class="card-top"><span class="ring-icon">' + RING_ICON + "</span>" +
      '<span class="count">' + s.n + " TRACK" + (s.n !== 1 ? "S" : "") + "</span></div>" +
      "<h3>" + star + esc(s.artist) + " &mdash; " + esc(s.dateDisplay) + "</h3>" +
      '<div class="venue">' + esc(s.venue) + "</div>" +
      '<div class="card-foot"><span class="stream">Stream</span>' +
      '<span class="foot-meta">' + preEdit + '<span class="src-badge ' + esc((s.source || "").toLowerCase()) +
      '">' + esc(s.source) + "</span>" +
      '<span class="dur">' + esc(s.dur) + "</span></span></div>" +
      "</a>";
  }

  // trueCount is the group's real size (always shown in the header, e.g.
  // "Jerry Hannan · 16 SHOWS"); shownRows is what's actually rendered as
  // cards beneath it — the two differ in the collapsed preview, where every
  // group's header is visible up front but only a few of its cards are.
  function sectionHTML(label, trueCount, shownRows) {
    return '<div class="section-head"><h3>' + esc(label) + '</h3><div class="rule"></div>' +
      '<span class="n">' + trueCount + " SHOW" + (trueCount !== 1 ? "S" : "") + "</span></div>" +
      '<div class="grid">' + shownRows.map(cardHTML).join("") + "</div>";
  }

  function sortKeyDate(s) { return s.date || ""; } // unknown dates sort last (empty < any real date)

  // Each by*Buckets() returns [{label, shows}], most-relevant group first —
  // bucketing logic only, no HTML, so the same buckets can be rendered in
  // full or truncated to a default-collapsed slice.
  function byDateBuckets() {
    var buckets = {};
    SHOWS.forEach(function (s) {
      var year = s.date ? s.date.slice(0, 4) : "Unknown";
      (buckets[year] = buckets[year] || []).push(s);
    });
    var years = Object.keys(buckets).filter(function (y) { return y !== "Unknown"; }).sort().reverse();
    if (buckets.Unknown) years.push("Unknown");
    return years.map(function (y) {
      var rows = buckets[y].slice().sort(function (a, b) { return sortKeyDate(b).localeCompare(sortKeyDate(a)); });
      return { label: y, shows: rows };
    });
  }

  function byArtistBuckets() {
    var buckets = {};
    SHOWS.forEach(function (s) { (buckets[s.artist] = buckets[s.artist] || []).push(s); });
    var artists = Object.keys(buckets).sort(function (a, b) { return buckets[b].length - buckets[a].length; });
    return artists.map(function (a) {
      var rows = buckets[a].slice().sort(function (x, y) { return sortKeyDate(y).localeCompare(sortKeyDate(x)); });
      return { label: a, shows: rows };
    });
  }

  function byVenueBuckets() {
    var buckets = {};
    SHOWS.forEach(function (s) { (buckets[s.venue] = buckets[s.venue] || []).push(s); });
    var venues = Object.keys(buckets).sort(function (a, b) { return buckets[b].length - buckets[a].length; });
    return venues.map(function (v) {
      var rows = buckets[v].slice().sort(function (x, y) { return sortKeyDate(y).localeCompare(sortKeyDate(x)); });
      return { label: v, shows: rows };
    });
  }

  var BUCKETS = { date: byDateBuckets, artist: byArtistBuckets, venue: byVenueBuckets };

  // Default view caps the whole preview at this many cards — walking groups
  // in order, only the group(s) that actually contribute a card get their
  // header shown (with the group's true count), so switching sort doesn't
  // dump every header on screen at once, just the ones behind the visible
  // cards. "Show all" reveals every card in every group.
  var COLLAPSE_LIMIT = 9;
  var currentMode = "date";
  var expanded = false;

  function render(mode) {
    currentMode = mode;
    var buckets = BUCKETS[mode]();
    var fullTotal = buckets.reduce(function (n, b) { return n + b.shows.length; }, 0);
    var html, shownTotal;
    if (expanded) {
      html = buckets.map(function (b) { return sectionHTML(b.label, b.shows.length, b.shows); }).join("");
      shownTotal = fullTotal;
    } else {
      shownTotal = 0;
      var parts = [];
      for (var i = 0; i < buckets.length && shownTotal < COLLAPSE_LIMIT; i++) {
        var b = buckets[i];
        var budget = COLLAPSE_LIMIT - shownTotal;
        var shown = b.shows.slice(0, budget);
        shownTotal += shown.length;
        parts.push(sectionHTML(b.label, b.shows.length, shown));
      }
      html = parts.join("");
    }
    if (shownTotal < fullTotal) {
      html += '<div class="show-more-row"><button type="button" class="show-more" id="showMoreBtn">' +
        "Show all " + fullTotal + " shows</button></div>";
    }
    sectionsEl.innerHTML = html;
    var btn = document.getElementById("showMoreBtn");
    if (btn) btn.addEventListener("click", function () { expanded = true; render(currentMode); });
  }

  // Remembers the sort choice across visits, same pattern as the old
  // /archive/ page's artist/date toggle (localStorage, not a query param).
  var SORT_KEY = "homeSort";

  function setActiveSeg(mode) {
    segs.forEach(function (b) { b.classList.toggle("active", b.dataset.sort === mode); });
  }

  segs.forEach(function (btn) {
    btn.addEventListener("click", function () {
      setActiveSeg(btn.dataset.sort);
      expanded = false;
      render(btn.dataset.sort);
      try { localStorage.setItem(SORT_KEY, btn.dataset.sort); } catch (e) {}
    });
  });

  fetch("/assets/home-shows.json")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      SHOWS = data;
      var initialMode = "date";
      try {
        var saved = localStorage.getItem(SORT_KEY);
        if (saved && BUCKETS[saved]) initialMode = saved;
      } catch (e) {}
      setActiveSeg(initialMode);
      render(initialMode);
    })
    .catch(function (e) {
      sectionsEl.innerHTML = '<p class="grid-error">Could not load the show list: ' + esc(String(e)) + "</p>";
    });
})();
