// Playlist generator for /playlist/. Filters the build-generated track catalog
// (/assets/tracks.json) client-side, builds a queue, and plays it through one
// shared <audio> element. Uses the global WORKER + formatTime from player.js.
(function () {
  var filtersEl = document.getElementById("pl-filters");
  var lengthEl = document.getElementById("pl-length");
  var statusEl = document.getElementById("pl-status");
  var goBtn = document.getElementById("pl-generate");
  var nowEl = document.getElementById("pl-now");
  var queueEl = document.getElementById("pl-queue");

  var CATALOG = [];
  var ARTIST_NAMES = { jerry: "Jerry Hannan", sean: "Sean Hannan",
                       mad: "Mad Hannans", seanjerry: "Sean & Jerry Hannan" };
  // Facet tags worth picking a playlist by; the rest stay search-only.
  var TAG_ORDER = ["original", "cover", "traditional", "irish", "ballad",
                   "upbeat", "rocker", "singalong", "folk", "country", "blues",
                   "rock", "story", "guest", "favorite", "rarity"];

  // Every facet is multi-select now: an empty array means "no filter" (all
  // match); a non-empty array is OR'd within the facet, AND'd across facets.
  var filters = { artist: [], venue: [], source: [], tags: [] };
  var mode = "songs";                    // songs | minutes | endless
  var amounts = { songs: 12, minutes: 45 };

  var queue = [];
  var idx = -1;
  var audio = new Audio();
  audio.preload = "none";

  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  };

  function streamUrl(t) {
    return WORKER + "/stream?file=" + encodeURIComponent(t.file)
      + (t.ver ? "&v=" + t.ver : "");
  }

  function matches(t) {
    if (filters.artist.length && filters.artist.indexOf(t.artist) === -1) return false;
    if (filters.venue.length && filters.venue.indexOf(t.venue) === -1) return false;
    if (filters.source.length && filters.source.indexOf(t.sourceType) === -1) return false;
    for (var i = 0; i < filters.tags.length; i++) {
      if (t.tags.indexOf(filters.tags[i]) === -1) return false;
    }
    return true;
  }

  function pool() { return CATALOG.filter(matches); }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  function totalStr(list) {
    var sec = 0;
    list.forEach(function (t) { sec += t.durationSec; });
    var h = Math.floor(sec / 3600), m = Math.round(sec % 3600 / 60);
    return h ? h + "h " + m + "m" : m + " min";
  }

  // ── filter + length UI ────────────────────────────────────────────────────

  function chip(group, value, label, pressed) {
    return '<button type="button" class="chip" data-group="' + group + '" data-value="'
      + esc(value) + '"' + (pressed ? ' aria-pressed="true"' : ' aria-pressed="false"')
      + ">" + esc(label) + "</button>";
  }

  function uniq(key) {
    var seen = [];
    CATALOG.forEach(function (t) {
      if (t[key] && seen.indexOf(t[key]) === -1) seen.push(t[key]);
    });
    return seen;
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
    groups.push(filterGroup("Venue", "venue", "All venues",
      uniq("venue").map(function (v) { return [v, v]; })));
    groups.push(filterGroup("Source", "source", "All sources",
      [["aud", "AUD"], ["sbd", "SBD"]]));
    var present = TAG_ORDER.filter(function (tg) {
      return CATALOG.some(function (t) { return t.tags.indexOf(tg) !== -1; });
    });
    groups.push('<div class="pl-filter-group"><p class="pl-filter-label">Tags</p><div class="chip-row">'
      + present.map(function (tg) {
        return chip("tag", tg, tg, filters.tags.indexOf(tg) !== -1);
      }).join("") + "</div></div>");
    filtersEl.innerHTML = groups.join("");
  }

  function renderLength() {
    lengthEl.innerHTML = '<div class="pl-filter-group"><p class="pl-filter-label">Length</p><div class="chip-row">'
      + chip("mode", "songs", "Songs", mode === "songs")
      + chip("mode", "minutes", "Minutes", mode === "minutes")
      + chip("mode", "endless", "Endless shuffle", mode === "endless")
      + (mode === "endless" ? "" :
        '<input id="pl-amount" class="pl-amount" type="number" min="1" max="999" value="'
        + amounts[mode] + '" aria-label="How many ' + mode + '">')
      + "</div></div>";
  }

  function updateStatus() {
    var p = pool();
    var uniq = dedupe(p).length;
    statusEl.textContent = p.length
      ? p.length + " of " + CATALOG.length + " recordings match — "
        + uniq + (uniq === 1 ? " song" : " different songs")
        + " (one performance of each per playlist)."
      : "No tracks match — loosen the filters.";
    goBtn.disabled = !p.length;
  }

  filtersEl.addEventListener("click", function (e) {
    var b = e.target.closest(".chip");
    if (!b) return;
    var g = b.dataset.group, v = b.dataset.value;
    var key = g === "tag" ? "tags" : g;
    if (v === "all") {
      filters[key] = [];
    } else {
      var i = filters[key].indexOf(v);
      if (i === -1) filters[key].push(v); else filters[key].splice(i, 1);
    }
    renderFilters();
    updateStatus();
  });

  lengthEl.addEventListener("click", function (e) {
    var b = e.target.closest(".chip");
    if (!b || b.dataset.group !== "mode") return;
    mode = b.dataset.value;
    renderLength();
  });
  lengthEl.addEventListener("input", function (e) {
    if (e.target.id !== "pl-amount") return;
    var v = parseInt(e.target.value, 10);
    if (v > 0) amounts[mode] = v;
  });

  // ── queue building ────────────────────────────────────────────────────────

  // One performance per song: shuffle first so which recording represents a
  // song is random each time, then keep only the first occurrence of each.
  function dedupe(list) {
    var seen = {}, out = [];
    list.forEach(function (t) {
      var key = t.song || t.title;
      if (!seen[key]) { seen[key] = true; out.push(t); }
    });
    return out;
  }

  function buildQueue() {
    var p = dedupe(shuffle(pool().slice()));
    if (mode === "songs") return p.slice(0, amounts.songs);
    if (mode === "minutes") {
      var budget = amounts.minutes * 60, out = [], sec = 0;
      for (var i = 0; i < p.length; i++) {
        if (sec + p[i].durationSec <= budget || !out.length) {
          out.push(p[i]); sec += p[i].durationSec;
          if (sec >= budget) break;
        }
      }
      return out;
    }
    return p; // endless: whole pool, reshuffled again when it runs out
  }

  goBtn.addEventListener("click", function () {
    queue = buildQueue();
    if (!queue.length) return;
    renderQueue();
    syncHash();
    playAt(0);
  });

  // ── stateless sharing (#p=id,id,…) ───────────────────────────────────────
  // Track ids are stable and URL-safe, so the exact queue lives in the hash —
  // the address bar is always a share link, fully client-side, no server
  // involved. /play/{slug} (below) shortens it, but only once this exact
  // browser has confirmed the short link actually resolves for it.

  var shareBtn = document.getElementById("pl-share");

  function syncHash() {
    history.replaceState(null, "", queue.length
      ? "#p=" + queue.map(function (t) { return t.id; }).join(",")
      : location.pathname);
    shareBtn.hidden = !queue.length;
  }

  shareBtn.addEventListener("click", function () {
    var longUrl = location.href;
    shareBtn.textContent = "…";
    fetch("/api/playlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: queue.map(function (t) { return t.id; }) }),
    })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function (d) { return verifyShortLink(d.url); })
      .then(function (url) { copyShare(url); },
            function () { copyShare(longUrl); });
  });

  // Confirms /play/{slug} actually resolves from THIS browser/network before
  // ever handing it out — a stale Cloudflare edge node once served a 404 for
  // a correctly-stored link from one machine while working everywhere else
  // (2026-07-07). A plain server-side check can't catch that; only a request
  // from the same path the recipient will use can. Falls back to the long
  // link (resolved entirely client-side, so it can't suffer the same fault)
  // rather than ever copying a link that just failed its own test.
  function verifyShortLink(shortUrl) {
    return fetch(shortUrl, { method: "HEAD", cache: "no-store" })
      .then(function (r) { return (r.ok && r.redirected) ? shortUrl : Promise.reject(); });
  }

  function copyShare(url) {
    var done = function () {
      shareBtn.textContent = "Link copied!";
      setTimeout(function () { shareBtn.textContent = "Copy share link"; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done,
        function () { shareBtn.textContent = "Copy share link"; window.prompt("Copy this link:", url); });
    } else {
      shareBtn.textContent = "Copy share link";
      window.prompt("Copy this link:", url);
    }
  }

  function hydrateFromHash() {
    var m = location.hash.match(/^#p=([\w.,-]+)/);
    if (!m) return false;
    var byId = {};
    CATALOG.forEach(function (t) { byId[t.id] = t; });
    queue = m[1].split(",").map(function (id) { return byId[id]; })
      .filter(function (t) { return t; });
    if (!queue.length) return false;
    renderQueue();
    syncHash();
    // Cue the first track without autoplay — browsers block play() before a
    // user gesture on a fresh page load anyway.
    idx = 0;
    audio.src = streamUrl(queue[0]);
    renderNow();
    highlight();
    syncPlayBtn();
    return true;
  }

  // ── player ────────────────────────────────────────────────────────────────

  function playAt(i) {
    if (i < 0) i = 0;
    if (i >= queue.length) {
      if (mode === "endless" && queue.length) {         // roll a fresh order
        queue = buildQueue(); renderQueue(); i = 0;
      } else { stop(); return; }
    }
    idx = i;
    audio.src = streamUrl(queue[idx]);
    audio.play();
    renderNow();
    highlight();
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: queue[idx].title,
        artist: ARTIST_NAMES[queue[idx].artist] || "",
        album: (queue[idx].venue || "") + " " + (queue[idx].showDate || ""),
      });
    }
  }

  function stop() {
    audio.pause();
    idx = -1;
    renderNow();
    highlight();
  }

  audio.addEventListener("ended", function () { playAt(idx + 1); });
  audio.addEventListener("timeupdate", function () {
    var fill = nowEl.querySelector(".progress-bar-fill");
    var cur = nowEl.querySelector(".pl-time-current");
    if (fill) fill.style.width = (audio.duration ? audio.currentTime / audio.duration * 100 : 0) + "%";
    if (cur) cur.textContent = formatTime(audio.currentTime);
  });
  audio.addEventListener("play", function () { syncPlayBtn(); });
  audio.addEventListener("pause", function () { syncPlayBtn(); });

  function syncPlayBtn() {
    var b = nowEl.querySelector('[data-act="play"]');
    if (b) b.textContent = audio.paused ? "▶" : "❚❚";
  }

  function trackMeta(t) {
    return [ARTIST_NAMES[t.artist] || t.artist, t.venue, t.showDate || "unknown date"]
      .filter(Boolean).join(" · ");
  }

  function renderNow() {
    if (idx === -1) { nowEl.innerHTML = ""; nowEl.hidden = true; return; }
    var t = queue[idx];
    nowEl.hidden = false;
    nowEl.innerHTML =
      '<div class="pl-now-info"><a class="pl-now-title" href="' + esc(t.url) + '">' + esc(t.title) + "</a>"
      + '<span class="pl-now-meta">' + esc(trackMeta(t))
      + (t.songwriter && t.songwriter !== "Jerry Hannan & Sean Hannan"
        ? ' <span class="sr-tag">' + esc(t.songwriter) + "</span>" : "")
      + "</span></div>"
      + '<div class="pl-controls">'
      + '<button type="button" class="pl-btn" data-act="prev" aria-label="Previous">⏮</button>'
      + '<button type="button" class="pl-btn pl-btn-play" data-act="play" aria-label="Play/pause">❚❚</button>'
      + '<button type="button" class="pl-btn" data-act="next" aria-label="Next">⏭</button>'
      + "</div>"
      + '<div class="pl-progress"><span class="pl-time-current">0:00</span>'
      + '<div class="progress-bar-track"><div class="progress-bar-fill"></div></div>'
      + "<span>" + formatTime(t.durationSec) + "</span></div>";
  }

  nowEl.addEventListener("click", function (e) {
    var b = e.target.closest(".pl-btn");
    if (b) {
      if (b.dataset.act === "prev") {
        if (audio.currentTime > 3) audio.currentTime = 0; else playAt(idx - 1);
      } else if (b.dataset.act === "next") playAt(idx + 1);
      else audio.paused ? audio.play() : audio.pause();
      return;
    }
    var bar = e.target.closest(".progress-bar-track");
    if (bar && audio.duration) {
      var r = bar.getBoundingClientRect();
      audio.currentTime = (e.clientX - r.left) / r.width * audio.duration;
    }
  });

  // ── queue list ────────────────────────────────────────────────────────────

  function renderQueue() {
    queueEl.innerHTML = '<p class="search-status">' + queue.length
      + (queue.length === 1 ? " song · " : " songs · ") + totalStr(queue)
      + (mode === "endless" ? " · reshuffles when it runs out" : "") + "</p>"
      + '<div class="search-results">' + queue.map(function (t, i) {
        return '<button type="button" class="sr pl-row" data-i="' + i + '">'
          + '<span class="sr-icon">&#9834;</span>'
          + '<span class="sr-main"><span class="sr-title">' + esc(t.title) + "</span>"
          + '<span class="sr-sub">' + esc(trackMeta(t)) + "</span></span>"
          + '<span class="sr-src src-' + esc(t.sourceType) + '">' + esc(t.sourceType.toUpperCase()) + "</span>"
          + '<span class="sr-meta">' + formatTime(t.durationSec) + "</span></button>";
      }).join("") + "</div>";
  }

  function highlight() {
    queueEl.querySelectorAll(".pl-row").forEach(function (r) {
      r.classList.toggle("pl-playing", +r.dataset.i === idx);
    });
  }

  queueEl.addEventListener("click", function (e) {
    var r = e.target.closest(".pl-row");
    if (r) playAt(+r.dataset.i);
  });

  // ── boot ──────────────────────────────────────────────────────────────────

  fetch("/assets/tracks.json")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      CATALOG = data;
      renderFilters();
      renderLength();
      updateStatus();
      hydrateFromHash();
    })
    .catch(function (e) { statusEl.textContent = "Could not load the track catalog: " + e; });
})();
