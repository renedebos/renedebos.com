// Client-side search for /search/. Loads the build-generated index
// (/assets/search-index.json) and searches it entirely in the browser — one row
// per curated track plus one per show. No backend, no external library.
//
// Two modes share one result list. With text in the box the filters narrow
// the query and the list is capped (RESULT_CAP) with a "refine" nudge. With
// an empty box and any filter set, the page BROWSES: it lists everything the
// filters pass, uncapped — "every Sean Hannan track" is a chip click, not a
// search. Both the query and the filters live in the URL (?q=, ?type=,
// ?artist=, ?source=) so a browse view is a link. Empty box + no filters
// still shows nothing but the counts; the index is 700+ rows and nobody
// asked for them yet.
// Hannan originals whose writer credit is the archive default and would be noise
// on every row. 'Jerry Hannan' alone joined the pair on 2026-08-31, when
// "Society" was credited to Jerry solo — still a Hannan original, and it should
// read like one rather than like a cover.
var HANNAN_DEFAULT_WRITERS = ["Jerry Hannan & Sean Hannan", "Jerry Hannan"];

(function () {
  var qEl = document.getElementById("q");
  var filtersEl = document.getElementById("filters");
  var statusEl = document.getElementById("status");
  var resultsEl = document.getElementById("results");

  // Focus the box on arrival, but only where that can't pop a virtual
  // keyboard uninvited: a static `autofocus` attribute did this unconditionally,
  // including on a phone landing here to browse by filter chip, not to type.
  try {
    if (window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches) qEl.focus();
  } catch (e) {}

  var INDEX = [];
  var filters = { type: "all", artist: "all", source: "all" };
  var FILTER_KEYS = ["type", "artist", "source"];
  function anyFilter() {
    return FILTER_KEYS.some(function (k) { return filters[k] !== "all"; });
  }
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

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
    return r.source ? '<span class="sr-src src-tag src-' + r.source.toLowerCase() + '">'
      + esc(r.source) + "</span>" : "";
  }

  function rowHtml(r) {
    if (r.type === "track") {
      var tags = (r.tags || []).map(function (t) {
        return '<span class="sr-tag">' + esc(t) + "</span>";
      }).join("");
      // covers/trad get a songwriter chip; the Hannan default on every original would be noise
      if (r.songwriter && HANNAN_DEFAULT_WRITERS.indexOf(r.songwriter) === -1) {
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

  var RESULT_CAP = 60;

  function run() {
    var q = qEl.value.trim();
    var tokens = norm(q).split(/\s+/).filter(Boolean);
    var pool = INDEX.filter(passFilters);
    // "performance", not "song" -- a type==="track" row is one recording of
    // one show, and the archive has ~5x more of those than distinct songs
    // (the homepage's own "N songs" count is the unique-title one). Calling
    // this count "songs" quoted a bigger number than the site quotes for the
    // same word one click away.
    var nPerformances = pool.filter(function (r) { return r.type === "track"; }).length;
    var nShows = pool.filter(function (r) { return r.type === "show"; }).length;
    var counts = plural(nPerformances, "performance") + " and " + plural(nShows, "show");
    var browsing = !tokens.length;

    if (browsing && !anyFilter()) {
      resultsEl.innerHTML = "";
      statusEl.textContent = counts + " — start typing to search, or pick a filter to browse.";
      syncUrl(q);
      return;
    }
    var hits = [];
    pool.forEach(function (r) {
      var sc = browsing ? 0 : score(r, tokens);
      if (sc >= 0) hits.push([sc, r]);
    });
    // Relevance first (score() was being computed and then silently
    // discarded -- every real search was sorted the same way as a filter
    // browse, found 2026-08-23). Ties -- and every row during a browse,
    // where score is forced to 0 above -- fall through to title, then date,
    // then track number, so every performance of the same song still lands
    // together in chronological order (e.g. searching a songwriter's name).
    hits.sort(function (a, b) {
      if (a[0] !== b[0]) return b[0] - a[0];
      var ra = a[1], rb = b[1];
      var ta = norm(ra.song || ra.artist || ""), tb = norm(rb.song || rb.artist || "");
      if (ta !== tb) return ta < tb ? -1 : 1;
      var da = ra.date || "", db = rb.date || "";
      if (da !== db) return da < db ? -1 : 1;
      return (ra.num || 0) - (rb.num || 0);
    });

    var total = hits.length;
    var shown = browsing ? hits : hits.slice(0, RESULT_CAP);
    statusEl.textContent = browsing
      ? (total ? counts + " matching the filters — type to narrow." : "Nothing matches these filters.")
      : !total ? "No matches for “" + q + "”."
      : shown.length < total
        ? "Showing " + shown.length + " of " + total + " results — refine your search to narrow it down."
        : total + (total === 1 ? " result" : " results");
    resultsEl.innerHTML = shown.map(function (h) { return rowHtml(h[1]); }).join("");
    syncUrl(q);
  }

  function syncUrl(q) {
    var p = new URLSearchParams();
    if (q) p.set("q", q);
    FILTER_KEYS.forEach(function (k) { if (filters[k] !== "all") p.set(k, filters[k]); });
    var s = p.toString();
    history.replaceState(null, "", s ? "?" + s : location.pathname);
  }

  // Sets one filter group and repaints its chips. Returns false (and changes
  // nothing) when no chip carries that value — that's what makes a hand-edited
  // or stale ?artist= in the URL harmless rather than a silent empty page.
  function setFilter(group, value) {
    var chips = filtersEl.querySelectorAll('.chip[data-group="' + group + '"]');
    var found = false;
    chips.forEach(function (c) { if (c.dataset.value === value) found = true; });
    if (!found) return false;
    filters[group] = value;
    chips.forEach(function (c) {
      c.setAttribute("aria-pressed", c.dataset.value === value ? "true" : "false");
    });
    return true;
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
      ["type", [["all", "All"], ["track", "Performances"], ["show", "Shows"]]],
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
    setFilter(b.dataset.group, b.dataset.value);
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
      FILTER_KEYS.forEach(function (k) { if (params.get(k)) setFilter(k, params.get(k)); });
      run();
    })
    .catch(function (e) {
      // Clear the loading skeleton — otherwise it pulses forever on a failure —
      // and route to the server-rendered indexes, which need no JS at all.
      resultsEl.innerHTML = "";
      statusEl.innerHTML = "Could not load the search index (" + esc(String(e))
        + '). You can still browse the <a href="/songs/">Songs index</a> or the '
        + '<a href="/">list of shows</a>.';
    });
})();
