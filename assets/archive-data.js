// /archive-data/ — every track's catalog + audio-processing spec data in one
// filterable, sortable table. Fetches assets/track-spec.json (built by
// build_track_spec_catalog() in sitegen/feeds.py) and renders entirely
// client-side — same fetch-a-flat-JSON-catalog pattern as playlist.js, since
// this table needs numeric column sorting, which is far simpler against a
// plain array than reordering server-rendered rows (see /songs/'s approach).
(function () {
  var filtersEl = document.getElementById("ad-filters");
  var clearBtn = document.getElementById("ad-clear");
  var statusEl = document.getElementById("ad-status");
  var qEl = document.getElementById("ad-q");
  var headEl = document.getElementById("ad-head");
  var bodyEl = document.getElementById("ad-tbody");

  var CATALOG = [];
  var ARTIST_NAMES = { jerry: "Jerry Hannan", sean: "Sean Hannan",
                       mad: "Mad Hannans", seanjerry: "Sean & Jerry Hannan" };
  var TREAT_LABEL = { linear: "Linear", "linear-reduced": "Linear ↓",
                      "applause-limiter": "Applause-limited",
                      "sparse-transient-cap": "Transient-capped" };

  // Every multi-select facet: empty array = no filter, OR'd within a facet,
  // AND'd across facets — same convention as playlist.js's `filters`.
  var filters = { artist: [], procVer: [], treatment: [] };
  var damagedOnly = false;
  // track id -> true for rows with their transient-cap detail row open.
  // Keyed by id (not array index) so state survives a re-sort/re-filter.
  var expandedIds = {};
  var sortKey = null, sortDir = 1;

  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  };

  function fmt1(v) { return v == null ? "—" : v.toFixed(1); }
  function fmtSigned(v) { return v == null ? "—" : (v > 0 ? "+" : "") + v.toFixed(1); }

  // Column definitions drive both the header row and every body row — one
  // place to add/remove a spec field. `get` supplies the raw sort value;
  // `render` supplies the cell HTML (often formatted differently).
  var COLUMNS = [
    { key: "venue", label: "Show", numeric: false,
      get: function (t) { return (t.showDate || "") + " " + t.venue; },
      render: function (t) { return esc(t.venue) + (t.showDate ? " · " + esc(t.showDate) : ""); } },
    { key: "artist", label: "Artist", numeric: false,
      get: function (t) { return ARTIST_NAMES[t.artist] || t.artist; },
      render: function (t) { return esc(ARTIST_NAMES[t.artist] || t.artist); } },
    { key: "num", label: "#", numeric: true, cls: "tnum",
      get: function (t) { return t.num; }, render: function (t) { return t.num; } },
    { key: "title", label: "Song", numeric: false,
      get: function (t) { return t.title; },
      render: function (t) { return '<a href="' + esc(t.url) + '">' + esc(t.title) + "</a>"; } },
    { key: "songwriter", label: "Songwriter", numeric: false,
      get: function (t) { return t.songwriter || ""; },
      render: function (t) { return esc(t.songwriter || "—"); } },
    { key: "tags", label: "Tags", numeric: false, sortable: false,
      get: function () { return 0; },
      render: function (t) { return esc(t.tags.join(", ")); } },
    { key: "duration", label: "Time", numeric: false, cls: "tnum",
      get: function (t) { return t.duration || ""; },
      render: function (t) { return esc(t.duration || "—"); } },
    { key: "mp3SizeMb", label: "MP3", numeric: true, cls: "tnum",
      get: function (t) { return t.mp3SizeMb; },
      render: function (t) { return t.mp3SizeMb ? t.mp3SizeMb + " MB" : "—"; } },
    { key: "flacSizeMb", label: "FLAC", numeric: true, cls: "tnum",
      get: function (t) { return t.flacSizeMb; },
      render: function (t) { return t.flacSizeMb ? t.flacSizeMb + " MB" : "—"; } },
    { key: "sourceType", label: "Src", numeric: false,
      get: function (t) { return t.sourceType; },
      render: function (t) { return esc((t.sourceType || "").toUpperCase() || "—"); } },
    { key: "inLufs", label: "In LUFS", numeric: true, cls: "tnum",
      get: function (t) { return t.inLufs; }, render: function (t) { return fmt1(t.inLufs); } },
    { key: "outLufs", label: "Out LUFS", numeric: true, cls: "tnum",
      get: function (t) { return t.outLufs; }, render: function (t) { return fmt1(t.outLufs); } },
    { key: "gain", label: "Gain", numeric: true, cls: "tnum",
      get: function (t) { return t.gain; }, render: function (t) { return fmtSigned(t.gain); } },
    { key: "truePeak", label: "True Pk", numeric: true, cls: "tnum",
      get: function (t) { return t.truePeak; }, render: function (t) { return fmt1(t.truePeak); } },
    { key: "mp3TruePeak", label: "MP3 Pk", numeric: true, cls: "tnum",
      get: function (t) { return t.mp3TruePeak; }, render: function (t) { return fmt1(t.mp3TruePeak); } },
    { key: "lra", label: "LRA", numeric: true, cls: "tnum",
      get: function (t) { return t.lra; }, render: function (t) { return fmt1(t.lra); } },
    // ── the -14 loud variant ────────────────────────────────────────────
    // Its own columns, never merged into the archive's: these describe a
    // different render (see CLAUDE.md, "The -14 loud variant"). Placed right
    // after the archive's LRA because ΔLRA is the number that says what the
    // extra loudness cost, and it only means anything next to the LRA it moved.
    { key: "loudLufs", label: "Loud LUFS", numeric: true, cls: "tnum loud-col",
      get: function (t) { return t.loud ? t.loud.lufs : null; },
      render: function (t) { return fmt1(t.loud ? t.loud.lufs : null); } },
    { key: "loudLraDelta", label: "Loud ΔLRA", numeric: true, cls: "tnum loud-col",
      get: function (t) { return t.loud ? t.loud.lraDelta : null; },
      render: function (t) {
        if (!t.loud || t.loud.lraDelta == null) return "—";
        // Negative = dynamic range lost. Flagged past 1 LU: the mode was
        // sanctioned at ≤0.3 LU and the campaign's worst case is 3.10, so a
        // reader should be able to find the outliers without sorting.
        var d = t.loud.lraDelta;
        var cls = d <= -1 ? ' class="loud-delta-flag"' : "";
        return "<span" + cls + ' title="Loudness range vs the archive master">'
          + fmtSigned(d) + "</span>";
      } },
    { key: "loudTreatment", label: "Loud Treat", numeric: false, cls: "ttreat loud-col",
      get: function (t) { return t.loud ? (t.loud.treatment || "") : ""; },
      render: function (t) {
        if (!t.loud || !t.loud.treatment) return "—";
        var label = TREAT_LABEL[t.loud.treatment] || t.loud.treatment;
        if (t.loud.tcap) {
          return '<span class="treat treat-' + esc(t.loud.treatment) + ' treat-expandable" '
            + 'data-id="' + esc(t.id) + '" title="Click for the full cap breakdown">'
            + esc(label) + '<span class="treat-toggle" aria-hidden="true"></span></span>';
        }
        return '<span class="treat treat-' + esc(t.loud.treatment) + '">' + esc(label) + "</span>";
      } },
    { key: "plr", label: "PLR", numeric: true, cls: "tnum",
      get: function (t) { return t.plr; }, render: function (t) { return fmt1(t.plr); } },
    { key: "maxM", label: "Max M", numeric: true, cls: "tnum",
      get: function (t) { return t.maxM; }, render: function (t) { return fmt1(t.maxM); } },
    { key: "maxS", label: "Max S", numeric: true, cls: "tnum",
      get: function (t) { return t.maxS; }, render: function (t) { return fmt1(t.maxS); } },
    { key: "treatment", label: "Treatment", numeric: false, cls: "ttreat",
      get: function (t) { return t.treatment || ""; },
      render: function (t) {
        if (!t.treatment) return "—";
        var label = TREAT_LABEL[t.treatment] || t.treatment;
        // transient-capped tracks carry their guardrail record (v8) — full
        // detail lives in the expandable row below (see renderDetailRow),
        // not hidden in a hover-only tooltip. The tooltip here stays as a
        // quick hint pointing at that, plus the raw chain for everything else.
        if (t.tcap) {
          var override = t.tcap.override ? " · extended cap" : "";
          return '<span class="treat treat-' + esc(t.treatment) + ' treat-expandable" '
            + 'data-id="' + esc(t.id) + '" title="Click for the full cap breakdown">'
            + esc(label) + override
            + '<span class="treat-toggle" aria-hidden="true"></span></span>';
        }
        var note = t.chain ? ' title="' + esc(t.chain) + '"' : "";
        return '<span class="treat treat-' + esc(t.treatment) + '"' + note + ">" + esc(label) + "</span>";
      } },
    { key: "procVer", label: "Ver", numeric: true, cls: "tver",
      get: function (t) { return t.procVer; },
      render: function (t) {
        if (t.procVer == null) return "—";
        var note = t.chain ? ' title="' + esc(t.chain) + '"' : "";
        return "<span" + note + ">v" + t.procVer + "</span>";
      } },
    { key: "dropouts", label: "Damage", numeric: false,
      get: function (t) { return t.dropouts ? 1 : 0; },
      render: function (t) {
        return t.dropouts
          ? '<span class="track-badge" title="Audible tape damage / dropouts">dropouts</span>' : "";
      } },
  ];

  var TCAP_FIELD_LABELS = [
    ["gr_db", "Attenuation applied", " dB"],
    ["p95_gr_db", "P95 attenuation", " dB"],
    ["engaged_pct", "Engaged", "%"],
    ["events", "Events", ""],
    ["longest_s", "Longest event", " s"],
    ["near_peak_pct", "Near-peak density", "%"],
    ["policy_max_gr_db", "Policy ceiling in effect", " dB"],
  ];

  // Full numeric breakdown for a transient-capped track, shown in an
  // expandable row rather than a hover-only tooltip (see the Treatment
  // column's render) — same disclosure idiom as the show page's own
  // technical-data table, just per-row instead of per-show.
  function capBlock(cap, heading, extra) {
    var fields = TCAP_FIELD_LABELS.map(function (f) {
      var v = cap[f[0]];
      if (v == null) return "";
      return '<div class="ad-detail-field"><span class="ad-detail-k">' + esc(f[1])
        + '</span><span class="ad-detail-v">' + esc(v) + esc(f[2]) + "</span></div>";
    }).join("");
    var override = cap.override
      ? '<p class="ad-detail-override">' + esc(cap.override_note || "Ceiling raised for this track.") + "</p>"
      : "";
    return (heading ? '<p class="ad-detail-head">' + esc(heading) + "</p>" : "")
      + '<div class="ad-detail-grid">' + fields + "</div>" + override + (extra || "");
  }

  function renderDetailRow(t) {
    var blocks = "";
    if (t.tcap) {
      blocks += capBlock(t.tcap, t.loud && t.loud.tcap ? "Archive master (−20 LUFS)" : "",
        t.chain ? '<p class="ad-detail-chain">' + esc(t.chain) + "</p>" : "");
    }
    if (t.loud && t.loud.tcap) {
      // The derivation proof belongs here, next to the numbers it qualifies:
      // loudSrcMd5 is the decoded md5 of what the variant render READ, and it
      // equals the archive master's own md5. The build refuses to run if they
      // ever disagree — this line is that guarantee made visible.
      var proof = t.loud.loudSrcMd5
        ? '<p class="ad-detail-chain">Rendered from the published archive master'
          + ' · source audio md5 ' + esc(String(t.loud.loudSrcMd5).slice(0, 12)) + "</p>"
        : "";
      blocks += capBlock(t.loud.tcap, "Loud variant (−14 LUFS, streaming only)", proof);
    }
    if (!blocks) return "";
    return '<tr class="ad-detail-row" data-detail-for="' + esc(t.id) + '"><td colspan="' + COLUMNS.length + '">'
      + blocks + "</td></tr>";
  }

  function uniq(key) {
    var seen = [];
    CATALOG.forEach(function (t) {
      var v = t[key];
      if (v != null && seen.indexOf(v) === -1) seen.push(v);
    });
    return seen;
  }

  function matches(t) {
    if (filters.artist.length && filters.artist.indexOf(t.artist) === -1) return false;
    if (filters.procVer.length) {
      var pv = t.procVer == null ? "none" : String(t.procVer);
      if (filters.procVer.indexOf(pv) === -1) return false;
    }
    if (filters.treatment.length) {
      var tr = t.treatment || "none";
      if (filters.treatment.indexOf(tr) === -1) return false;
    }
    if (damagedOnly && !t.dropouts) return false;
    var q = (qEl.value || "").trim().toLowerCase();
    if (q) {
      var hay = (t.title + " " + t.venue + " " + (t.songwriter || "")).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  }

  function chip(group, value, label, pressed) {
    return '<button type="button" class="chip" data-group="' + group + '" data-value="'
      + esc(value) + '"' + (pressed ? ' aria-pressed="true"' : ' aria-pressed="false"')
      + ">" + esc(label) + "</button>";
  }

  function filterGroup(label, key, allLabel, options) {
    return '<div class="pl-filter-group"><p class="pl-filter-label">' + esc(label) + '</p><div class="chip-row">'
      + chip(key, "all", allLabel, filters[key].length === 0)
      + options.map(function (o) {
        return chip(key, o[0], o[1], filters[key].indexOf(o[0]) !== -1);
      }).join("") + "</div></div>";
  }

  function renderFilters() {
    var groups = [];
    groups.push(filterGroup("Artist", "artist", "All artists",
      uniq("artist").map(function (a) { return [a, ARTIST_NAMES[a] || a]; })));
    var vers = uniq("procVer").sort(function (a, b) { return a - b; }).map(function (v) { return ["" + v, "v" + v]; });
    if (CATALOG.some(function (t) { return t.procVer == null; })) vers.push(["none", "Not processed"]);
    groups.push(filterGroup("Workflow version", "procVer", "All versions", vers));
    var treats = Object.keys(TREAT_LABEL).filter(function (m) {
      return CATALOG.some(function (t) { return t.treatment === m; });
    }).map(function (m) { return [m, TREAT_LABEL[m]]; });
    if (CATALOG.some(function (t) { return !t.treatment; })) treats.push(["none", "Not processed"]);
    groups.push(filterGroup("Treatment", "treatment", "All treatments", treats));
    groups.push('<div class="pl-filter-group"><p class="pl-filter-label">Damage</p><div class="chip-row">'
      + chip("damaged", "1", "Damaged only", damagedOnly) + "</div></div>");
    filtersEl.innerHTML = groups.join("");
  }

  function renderHead() {
    headEl.innerHTML = COLUMNS.map(function (c) {
      var arrow = sortKey === c.key ? (sortDir === 1 ? " ↑" : " ↓") : "";
      var cls = (c.cls ? c.cls : "") + (c.sortable === false ? "" : " sortable");
      return '<th class="' + cls.trim() + '" data-key="' + c.key + '">' + esc(c.label) + arrow + "</th>";
    }).join("");
  }

  // Before any column header is clicked, sort for browsing rather than in
  // whatever order track-spec.json happens to list rows: title, then date,
  // then track number — same convention as /search/.
  function defaultSort(a, b) {
    var ta = (a.title || "").toLowerCase(), tb = (b.title || "").toLowerCase();
    if (ta !== tb) return ta < tb ? -1 : 1;
    var da = a.showDate || "", db = b.showDate || "";
    if (da !== db) return da < db ? -1 : 1;
    return (a.num || 0) - (b.num || 0);
  }

  function render() {
    var rows = CATALOG.filter(matches);
    if (sortKey) {
      var col = COLUMNS.filter(function (c) { return c.key === sortKey; })[0];
      rows = rows.slice().sort(function (a, b) {
        var av = col.get(a), bv = col.get(b);
        if (av == null && bv == null) return 0;
        if (av == null) return 1;   // nulls sort last regardless of direction
        if (bv == null) return -1;
        if (av < bv) return -1 * sortDir;
        if (av > bv) return 1 * sortDir;
        return 0;
      });
    } else {
      rows = rows.slice().sort(defaultSort);
    }
    bodyEl.innerHTML = rows.map(function (t) {
      var row = "<tr>" + COLUMNS.map(function (c) {
        return '<td class="' + (c.cls || "") + '">' + c.render(t) + "</td>";
      }).join("") + "</tr>";
      if ((t.tcap || (t.loud && t.loud.tcap)) && expandedIds[t.id]) row += renderDetailRow(t);
      return row;
    }).join("");
    statusEl.textContent = rows.length + " of " + CATALOG.length + " tracks match";
    if (clearBtn) {
      clearBtn.hidden = !(filters.artist.length || filters.procVer.length
        || filters.treatment.length || damagedOnly || qEl.value);
    }
  }

  bodyEl.addEventListener("click", function (e) {
    var t = e.target.closest(".treat-expandable");
    if (!t) return;
    var id = t.dataset.id;
    expandedIds[id] = !expandedIds[id];
    render();
  });

  filtersEl.addEventListener("click", function (e) {
    var b = e.target.closest(".chip");
    if (!b) return;
    var g = b.dataset.group, v = b.dataset.value;
    if (g === "damaged") {
      damagedOnly = !damagedOnly;
    } else if (v === "all") {
      filters[g] = [];
    } else {
      var i = filters[g].indexOf(v);
      if (i === -1) filters[g].push(v); else filters[g].splice(i, 1);
    }
    renderFilters();
    render();
  });

  headEl.addEventListener("click", function (e) {
    var th = e.target.closest("th.sortable");
    if (!th) return;
    var key = th.dataset.key;
    if (sortKey === key) { sortDir = -sortDir; } else { sortKey = key; sortDir = 1; }
    renderHead();
    render();
  });

  qEl.addEventListener("input", render);

  if (clearBtn) {
    clearBtn.addEventListener("click", function () {
      filters = { artist: [], procVer: [], treatment: [] };
      damagedOnly = false;
      qEl.value = "";
      renderFilters();
      render();
    });
  }

  fetch("/assets/track-spec.json").then(function (r) { return r.json(); }).then(function (rows) {
    CATALOG = rows;
    renderFilters();
    renderHead();
    render();
  }).catch(function () {
    statusEl.textContent = "Couldn't load the archive data.";
  });
})();
