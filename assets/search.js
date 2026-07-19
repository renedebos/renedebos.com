// Client-side search for /search/. Loads the build-generated index
// (/assets/search-index.json) and searches it entirely in the browser — one row
// per curated track plus one per show. No backend, no external library.
(function () {
  var qEl = document.getElementById("q");
  var filtersEl = document.getElementById("filters");
  var statusEl = document.getElementById("status");
  var resultsEl = document.getElementById("results");

  var INDEX = [];
  var filters = { type: "all", artist: "all", source: "all" };

  var norm = function (s) { return (s == null ? "" : String(s)).toLowerCase(); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  };

  function haystack(r) {
    return [r.song, r.artist, r.showArtist, r.venue, r.venueFull, r.city,
            r.date, r.source, r.subtitle, r.songwriter, (r.tags || []).join(" ")]
      .map(norm).join(" ");
  }

  function score(r, tokens) {
    var hay = r._h;
    for (var i = 0; i < tokens.length; i++) {
      if (hay.indexOf(tokens[i]) === -1) return -1; // every token must appear
    }
    var s = 0, song = norm(r.song), artist = norm(r.artist), venue = norm(r.venue);
    tokens.forEach(function (t) {
      if (song.indexOf(t) === 0) s += 14;
      else if (song.indexOf(t) !== -1) s += 9;
      if (artist.indexOf(t) !== -1) s += 5;
      if (venue.indexOf(t) !== -1) s += 3;
      (r.tags || []).forEach(function (tag) { if (norm(tag).indexOf(t) !== -1) s += 6; });
      if (r.songwriter && norm(r.songwriter).indexOf(t) !== -1) s += 6;
    });
    if (r.type === "track") s += 1; // songs edge out shows on ties
    return s;
  }

  function passFilters(r) {
    if (filters.type !== "all" && r.type !== filters.type) return false;
    if (filters.artist !== "all" && r.showArtist !== filters.artist) return false;
    if (filters.source !== "all" && r.source !== filters.source) return false;
    return true;
  }

  function srcTag(r) {
    return r.source ? '<span class="sr-src src-' + r.source.toLowerCase() + '">'
      + esc(r.source) + "</span>" : "";
  }

  function rowHtml(r) {
    if (r.type === "track") {
      var tags = (r.tags || []).map(function (t) {
        return '<span class="sr-tag">' + esc(t) + "</span>";
      }).join("");
      // covers/trad get a songwriter chip; the Hannan default on every original would be noise
      if (r.songwriter && r.songwriter !== "Jerry Hannan & Sean Hannan") {
        tags = '<span class="sr-tag">' + esc(r.songwriter) + "</span>" + tags;
      }
      return '<a class="sr" href="' + esc(r.url) + '">'
        + '<span class="sr-icon">&#9834;</span>'
        + '<span class="sr-main"><span class="sr-title">' + esc(r.song) + "</span>"
        + '<span class="sr-sub">' + esc(r.context) + tags + "</span></span>"
        + srcTag(r)
        + '<span class="sr-meta">' + esc(r.duration || "") + "</span></a>";
    }
    var sub = (r.date || "Unknown date") + (r.tracks ? " &middot; " + r.tracks + " tracks" : "")
      + (r.subtitle ? " &middot; " + esc(r.subtitle) : "");
    return '<a class="sr sr-show" href="' + esc(r.url) + '">'
      + '<span class="sr-icon">&#9673;</span>'
      + '<span class="sr-main"><span class="sr-title">' + esc(r.artist) + " &middot; " + esc(r.venue) + "</span>"
      + '<span class="sr-sub">Show &middot; ' + sub + "</span></span>"
      + srcTag(r)
      + '<span class="sr-meta">show</span></a>';
  }

  // A song played many times (e.g. "Truck", 25+ performances) used to show one
  // near-identical row per performance. Above GROUP_MIN matches, collapse them
  // into a single row linking to the song's own page instead.
  var GROUP_MIN = 3;
  var RESULT_CAP = 60;

  function groupHtml(g) {
    var tags = {};
    g.forEach(function (r) { (r.tags || []).forEach(function (t) { tags[t] = true; }); });
    var tagHtml = Object.keys(tags).map(function (t) {
      return '<span class="sr-tag">' + esc(t) + "</span>";
    }).join("");
    var sw = g.map(function (r) { return r.songwriter; })
      .find(function (s) { return s && s !== "Jerry Hannan & Sean Hannan"; });
    if (sw) tagHtml = '<span class="sr-tag">' + esc(sw) + "</span>" + tagHtml;
    return '<a class="sr" href="/songs/' + esc(g[0].songSlug) + '/">'
      + '<span class="sr-icon">&#9834;</span>'
      + '<span class="sr-main"><span class="sr-title">' + esc(g[0].song) + "</span>"
      + '<span class="sr-sub">' + g.length + " performances" + tagHtml + "</span></span>"
      + '<span class="sr-meta">' + g.length + "&times;</span></a>";
  }

  function run() {
    var q = qEl.value.trim();
    var tokens = norm(q).split(/\s+/).filter(Boolean);
    var pool = INDEX.filter(passFilters);

    if (!tokens.length) {
      resultsEl.innerHTML = "";
      var nSongs = pool.filter(function (r) { return r.type === "track"; }).length;
      var nShows = pool.filter(function (r) { return r.type === "show"; }).length;
      statusEl.textContent = nSongs + " songs and " + nShows + " shows — start typing to search.";
      syncUrl(q);
      return;
    }
    var hits = [];
    pool.forEach(function (r) {
      var sc = score(r, tokens);
      if (sc >= 0) hits.push([sc, r]);
    });

    // A song with many matching performances (e.g. "Truck") collapses into one
    // grouped row instead of one near-identical row per performance.
    var bySong = {}; // songSlug -> [hit index, ...]
    hits.forEach(function (h, i) {
      var r = h[1];
      if (r.type === "track" && r.songSlug) {
        (bySong[r.songSlug] = bySong[r.songSlug] || []).push(i);
      }
    });
    var folded = {}; // hit index -> true once folded into a group row
    var combined = [];
    Object.keys(bySong).forEach(function (slug) {
      var idxs = bySong[slug];
      if (idxs.length < GROUP_MIN) return;
      idxs.forEach(function (i) { folded[i] = true; });
      var recs = idxs.map(function (i) { return hits[i][1]; });
      var maxScore = Math.max.apply(null, idxs.map(function (i) { return hits[i][0]; }));
      combined.push([maxScore, { grouped: true, records: recs, sortDate: recs[0].date || "" }]);
    });
    hits.forEach(function (h, i) { if (!folded[i]) combined.push(h); });

    combined.sort(function (a, b) {
      if (b[0] !== a[0]) return b[0] - a[0];
      var ad = a[1].grouped ? a[1].sortDate : (a[1].date || "");
      var bd = b[1].grouped ? b[1].sortDate : (b[1].date || "");
      return bd.localeCompare(ad); // newer first on ties
    });

    var total = combined.length;
    var shown = combined.slice(0, RESULT_CAP);
    statusEl.textContent = !total ? "No matches for “" + q + "”."
      : shown.length < total
        ? "Showing " + shown.length + " of " + total + " results — refine your search to narrow it down."
        : total + (total === 1 ? " result" : " results");
    resultsEl.innerHTML = shown.map(function (h) {
      return h[1].grouped ? groupHtml(h[1].records) : rowHtml(h[1]);
    }).join("");
    syncUrl(q);
  }

  function syncUrl(q) {
    var u = q ? "?q=" + encodeURIComponent(q) : location.pathname;
    history.replaceState(null, "", u);
  }

  function chip(group, value, label) {
    return '<button type="button" class="chip" data-group="' + group + '" data-value="'
      + esc(value) + '"' + (filters[group] === value ? ' aria-pressed="true"' : "")
      + ">" + esc(label) + "</button>";
  }

  function renderFilters() {
    var artists = [];
    INDEX.forEach(function (r) {
      if (r.showArtist && artists.indexOf(r.showArtist) === -1) artists.push(r.showArtist);
    });
    var groups = [
      ["type", [["all", "All"], ["track", "Songs"], ["show", "Shows"]]],
      ["artist", [["all", "All artists"]].concat(artists.map(function (a) { return [a, a]; }))],
      ["source", [["all", "All sources"], ["AUD", "AUD"], ["SBD", "SBD"]]],
    ];
    filtersEl.innerHTML = groups.map(function (g) {
      return '<div class="chip-row">' + g[1].map(function (o) {
        return chip(g[0], o[0], o[1]);
      }).join("") + "</div>";
    }).join("");
  }

  filtersEl.addEventListener("click", function (e) {
    var b = e.target.closest(".chip");
    if (!b) return;
    filters[b.dataset.group] = b.dataset.value;
    filtersEl.querySelectorAll('.chip[data-group="' + b.dataset.group + '"]').forEach(function (c) {
      c.setAttribute("aria-pressed", c.dataset.value === b.dataset.value ? "true" : "false");
    });
    run();
  });

  qEl.addEventListener("input", run);

  fetch("/assets/search-index.json")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      INDEX = data;
      INDEX.forEach(function (r) { r._h = haystack(r); });
      renderFilters();
      var params = new URLSearchParams(location.search);
      if (params.get("q")) qEl.value = params.get("q");
      run();
    })
    .catch(function (e) { statusEl.textContent = "Could not load the search index: " + e; });
})();
