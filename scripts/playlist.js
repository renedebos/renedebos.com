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
  var presetsEl = document.querySelector(".pl-presets");
  var clearBtn = document.getElementById("pl-clear");

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
  var seeking = false;
  var RANGE_MAX = 1000;

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

  // A rough preview of what Generate would actually produce, so the mode/
  // amount inputs aren't a guessing game. Exact for "minutes" (buildQueue
  // fills to the budget by design); an average-based estimate for "songs"
  // (the real pick is random each time); the pool's own total for "endless".
  function estimateDuration(dedupedPool) {
    if (!dedupedPool.length) return null;
    if (mode === "minutes") return amounts.minutes + " min";
    if (mode === "endless") return "~" + totalStr(dedupedPool) + " of unique songs";
    var n = Math.min(amounts.songs, dedupedPool.length);
    var avg = dedupedPool.reduce(function (s, t) { return s + t.durationSec; }, 0) / dedupedPool.length;
    return "~" + totalStr([{ durationSec: avg * n }]);
  }

  function updateStatus() {
    var p = pool();
    var deduped = dedupe(p);
    var uniq = deduped.length;
    var est = estimateDuration(deduped);
    statusEl.textContent = p.length
      ? p.length + " of " + CATALOG.length + " recordings match — "
        + uniq + (uniq === 1 ? " song" : " different songs")
        + " (one performance of each per playlist)"
        + (est ? " — about " + est + "." : ".")
      : "No tracks match — loosen the filters.";
    goBtn.disabled = !p.length;
    if (clearBtn) {
      clearBtn.hidden = !(filters.artist.length || filters.venue.length
        || filters.source.length || filters.tags.length);
    }
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
    updateStatus();
  });
  lengthEl.addEventListener("input", function (e) {
    if (e.target.id !== "pl-amount") return;
    var v = parseInt(e.target.value, 10);
    if (v > 0) { amounts[mode] = v; updateStatus(); }
  });

  if (clearBtn) {
    clearBtn.addEventListener("click", function () {
      filters = { artist: [], venue: [], source: [], tags: [] };
      renderFilters();
      updateStatus();
    });
  }

  // One-click starting points: set filters/mode/amount, then generate right
  // away — most visitors want a set to press play on, not a pre-filled form.
  var PRESETS = {
    mixed45: { filters: { artist: [], venue: [], source: [], tags: [] }, mode: "minutes", amount: 45 },
    traditional: { filters: { artist: [], venue: [], source: [], tags: ["traditional"] }, mode: "songs", amount: 12 },
    soundboard: { filters: { artist: [], venue: [], source: ["sbd"], tags: [] }, mode: "endless" },
  };
  if (presetsEl) {
    presetsEl.addEventListener("click", function (e) {
      var b = e.target.closest(".pl-preset");
      if (!b) return;
      var preset = PRESETS[b.dataset.preset];
      if (!preset) return;
      filters = { artist: preset.filters.artist.slice(), venue: preset.filters.venue.slice(),
                  source: preset.filters.source.slice(), tags: preset.filters.tags.slice() };
      mode = preset.mode;
      if (preset.amount) amounts[mode] = preset.amount;
      renderFilters();
      renderLength();
      updateStatus();
      queue = buildQueue();
      if (!queue.length) return;
      renderQueue();
      syncHash();
      playAt(0);
    });
  }

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
  var saveBtn = document.getElementById("pl-save");
  var downloadBtn = document.getElementById("pl-download");
  var playerBtn = document.getElementById("pl-player");

  function syncHash() {
    history.replaceState(null, "", queue.length
      ? "#p=" + queue.map(function (t) { return t.id; }).join(",")
      : location.pathname);
    shareBtn.hidden = !queue.length;
    if (saveBtn) saveBtn.hidden = !queue.length;
    if (playerBtn) playerBtn.hidden = !queue.length;
    if (downloadBtn) {
      downloadBtn.hidden = !queue.length;
      // Keep the visible label short ("Download ZIP") — the count/size
      // detail lives in the hover title instead, same as the saved-playlist
      // rows below, so this doesn't dwarf Save/Copy-share-link next to it.
      if (queue.length) downloadBtn.title = zipLabel(queue);
    }
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

  // ── ZIP download (whole playlist, lossless) ──────────────────────────────
  // Reuses the batch password modal + toast + client-zip pipeline in
  // player.js (openPasswordModal({type:'batch', manifest}) — already global
  // on this page the same way WORKER/formatTime are) — nothing new there,
  // just building the {zipName, files, infoName, infoText} manifest a
  // playlist's scattered tracks need.

  // Mirrors core.py's sanitize_filename() — no way to share the Python and
  // JS implementations directly in this static-site setup.
  function sanitizeFilename(s) {
    return String(s).replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, " ").trim().replace(/\.+$/, "");
  }

  function zipLabel(tracks) {
    var withFlac = tracks.filter(function (t) { return t.flac; });
    var mb = Math.round(withFlac.reduce(function (a, t) { return a + (t.flac_size_mb || 0); }, 0));
    return "Download " + withFlac.length + (withFlac.length === 1 ? " track" : " tracks") + " (.zip) · " + mb + " MB";
  }

  function buildPlaylistManifest(name, tracks) {
    var withFlac = tracks.filter(function (t) { return t.flac; });
    var folder = sanitizeFilename(name);
    var label = function (t) {
      return t.showDate + " - " + (ARTIST_NAMES[t.artist] || t.artist) + " - " + t.venue + " - " + t.title;
    };
    var files = withFlac.map(function (t) {
      return { key: t.flac, name: folder + "/" + sanitizeFilename(label(t)) + ".flac" };
    });
    var totalMb = Math.round(withFlac.reduce(function (a, t) { return a + (t.flac_size_mb || 0); }, 0));
    var lines = withFlac.map(label).join("\n");
    return {
      zipName: folder + ".zip",
      files: files,
      infoName: folder + "/playlist-info.txt",
      infoText: name + "\n" + withFlac.length + " tracks · " + totalMb + " MB\n\n" + lines + "\n\n"
        + "Recreate this playlist: " + location.origin + "/playlist/#p="
        + withFlac.map(function (t) { return t.id; }).join(",") + "\n",
    };
  }

  if (downloadBtn) {
    downloadBtn.addEventListener("click", function () {
      if (!queue.length) return;
      var name = "Playlist - " + new Date().toISOString().slice(0, 10);
      openPasswordModal({ type: "batch", manifest: buildPlaylistManifest(name, queue) });
    });
  }

  // Opens (or focuses/extends) the /player/ popup with this queue — see
  // sendToPlayer() in player.js, already loaded globally on this page. This
  // is a genuine hand-off, not a copy: pause this page's audio (otherwise
  // both it and the popup end up playing at once) and rotate the queue so
  // the popup starts on whatever was actually playing here, at the same
  // position, instead of restarting the whole queue from track 1.
  if (playerBtn) {
    playerBtn.addEventListener("click", function () {
      if (!queue.length) return;
      var from = idx === -1 ? 0 : idx;
      var startTime = idx === -1 ? 0 : audio.currentTime;
      audio.pause();
      var ids = queue.slice(from).concat(queue.slice(0, from)).map(function (t) { return t.id; });
      sendToPlayer(ids, { focus: true, startTime: startTime });
    });
  }

  // ── personal saved playlists (localStorage only) ─────────────────────────
  // Saving stores {name, ids, created} locally; nothing goes to the server.
  // The ids load via the same #p= hash as everything else, and sharing a
  // saved playlist is just: load it, then use the existing Share button.

  var savedEl = document.getElementById("pl-saved");
  var SAVED_KEY = "savedPlaylists";

  function loadSaved() {
    try {
      var v = JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }

  function storeSaved(list) {
    try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)); } catch (e) {}
    renderSaved();
  }

  function renderSaved() {
    if (!savedEl) return;
    var list = loadSaved();
    if (!list.length) { savedEl.innerHTML = ""; return; }
    savedEl.innerHTML = '<p class="pl-filter-label">Your saved playlists</p>'
      + '<div class="search-results">' + list.map(function (p, i) {
        return '<div class="pl-saved-row" data-i="' + i + '">'
          + '<button type="button" class="sr pl-saved-load" data-i="' + i + '">'
          + '<span class="sr-icon">&#9834;</span>'
          + '<span class="sr-main"><span class="sr-title">' + esc(p.name) + "</span>"
          + '<span class="sr-sub">' + p.ids.length + (p.ids.length === 1 ? " song" : " songs") + "</span></span>"
          + "</button>"
          + '<button type="button" class="pl-saved-act" data-act="download" data-i="' + i
          + '" title="' + esc(zipLabel(resolveIds(p.ids))) + '">Download</button>'
          + '<button type="button" class="pl-saved-act" data-act="rename" data-i="' + i + '">Rename</button>'
          + '<button type="button" class="pl-saved-act" data-act="delete" data-i="' + i + '">Delete</button>'
          + "</div>";
      }).join("") + "</div>";
  }

  if (saveBtn) {
    saveBtn.addEventListener("click", function () {
      if (!queue.length) return;
      var name = (window.prompt("Name this playlist:") || "").trim();
      if (!name) return;
      var list = loadSaved();
      var existing = list.findIndex(function (p) { return p.name === name; });
      if (existing !== -1) {
        if (!window.confirm('Replace the existing playlist "' + name + '"?')) return;
        list.splice(existing, 1);
      }
      list.push({ name: name, ids: queue.map(function (t) { return t.id; }),
                  created: new Date().toISOString() });
      storeSaved(list);
      saveBtn.textContent = "Saved!";
      setTimeout(function () { saveBtn.textContent = "Save playlist"; }, 1600);
    });
  }

  if (savedEl) {
    savedEl.addEventListener("click", function (e) {
      var act = e.target.closest(".pl-saved-act");
      var load = e.target.closest(".pl-saved-load");
      var list = loadSaved();
      if (act) {
        var p = list[+act.dataset.i];
        if (!p) return;
        if (act.dataset.act === "download") {
          openPasswordModal({ type: "batch", manifest: buildPlaylistManifest(p.name, resolveIds(p.ids)) });
        } else if (act.dataset.act === "delete") {
          if (!window.confirm('Delete the playlist "' + p.name + '"?')) return;
          list.splice(+act.dataset.i, 1);
          storeSaved(list);
        } else if (act.dataset.act === "rename") {
          var name = (window.prompt("Rename playlist:", p.name) || "").trim();
          if (!name || name === p.name) return;
          if (list.some(function (q) { return q.name === name; })) {
            if (!window.confirm('Replace the existing playlist "' + name + '"?')) return;
            list = list.filter(function (q) { return q.name !== name; });
          }
          p.name = name;
          storeSaved(list);
        }
        return;
      }
      if (load) {
        var pl = list[+load.dataset.i];
        if (!pl) return;
        var hash = "#p=" + pl.ids.join(",");
        if (location.hash === hash) hydrateFromHash();   // same hash: no hashchange fires
        else location.hash = hash;                        // hashchange listener hydrates
      }
    });
  }

  // Another tab saved/renamed/deleted a playlist — mirror it here.
  window.addEventListener("storage", function (e) {
    if (e.key === SAVED_KEY) renderSaved();
  });

  function resolveIds(ids) {
    var byId = {};
    CATALOG.forEach(function (t) { byId[t.id] = t; });
    return ids.map(function (id) { return byId[id]; }).filter(function (t) { return t; });
  }

  function hydrateFromHash() {
    var m = location.hash.match(/^#p=([\w.,-]+)/);
    if (!m) return false;
    queue = resolveIds(m[1].split(","));
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
    attemptPlay();
    renderNow();
    highlight();
    setMediaMetadata();
  }

  function stop() {
    audio.pause();
    idx = -1;
    renderNow();
    highlight();
  }

  audio.addEventListener("ended", function () { playAt(idx + 1); });
  audio.addEventListener("timeupdate", function () {
    var range = nowEl.querySelector(".progress-range");
    var cur = nowEl.querySelector(".pl-time-current");
    var pct = audio.duration ? audio.currentTime / audio.duration * 100 : 0;
    if (range && !seeking) {
      range.value = Math.round(pct * RANGE_MAX / 100);
      range.style.background = "linear-gradient(to right, var(--accent) " + pct + "%, var(--border) " + pct + "%)";
      range.setAttribute("aria-valuetext", formatTime(audio.currentTime));
    }
    if (cur) cur.textContent = formatTime(audio.currentTime);
    if ("mediaSession" in navigator && audio.duration) {
      try {
        navigator.mediaSession.setPositionState({
          duration: audio.duration, playbackRate: audio.playbackRate, position: audio.currentTime,
        });
      } catch (e) { /* not all browsers support this yet */ }
    }
  });
  audio.addEventListener("play", function () { syncPlayBtn(); syncMediaPlaybackState(); claimPlayback(audio); });
  audio.addEventListener("pause", function () { syncPlayBtn(); syncMediaPlaybackState(); });
  // Another player (a show-page track, or the /player/ popup) started
  // playing — this page's own <audio> is no longer the active one.
  onExternalClaim(function () { if (!audio.paused) audio.pause(); }, audio);

  function syncPlayBtn() {
    var b = nowEl.querySelector('[data-act="play"]');
    if (b) b.textContent = audio.paused ? "▶" : "❚❚";
  }

  // ── Media Session — lock-screen/headset controls ─────────────────────────
  // Previously metadata-only here (continuous-player.js, the /player/ popup,
  // got the full action-handler treatment first) — that meant playing a
  // queue directly on this page, without opening the popup, had no
  // lock-screen controls at all. Same treatment here now so the two players
  // don't drift.

  function setMediaMetadata() {
    if (!("mediaSession" in navigator) || idx === -1) return;
    var t = queue[idx];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: ARTIST_NAMES[t.artist] || "",
      album: (t.venue || "") + " " + (t.showDate || ""),
      artwork: [{ src: "https://renedebos.com/assets/og.png", sizes: "1200x630", type: "image/png" }],
    });
  }
  function syncMediaPlaybackState() {
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = audio.paused ? "paused" : "playing";
  }
  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", function () { attemptPlay(); });
    navigator.mediaSession.setActionHandler("pause", function () { audio.pause(); });
    navigator.mediaSession.setActionHandler("previoustrack", function () {
      if (audio.currentTime > 3) audio.currentTime = 0; else playAt(idx - 1);
    });
    navigator.mediaSession.setActionHandler("nexttrack", function () { playAt(idx + 1); });
  }

  // audio.play() returns a promise that rejects on autoplay blocks, decode
  // errors, or a dropped connection — unhandled, that fails silently and the
  // UI just looks stuck. Surface it in the status line instead.
  function attemptPlay() {
    var p = audio.play();
    if (p && p.catch) {
      p.catch(function () {
        statusEl.textContent = "Couldn't start playback — tap play to try again.";
      });
    }
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
      + '<input type="range" class="progress-range" min="0" max="' + RANGE_MAX + '" value="0" step="1" '
      + 'aria-label="Seek ' + esc(t.title) + '" aria-valuetext="0:00">'
      + "<span>" + formatTime(t.durationSec) + "</span></div>";
  }

  nowEl.addEventListener("click", function (e) {
    var b = e.target.closest(".pl-btn");
    if (b) {
      if (b.dataset.act === "prev") {
        if (audio.currentTime > 3) audio.currentTime = 0; else playAt(idx - 1);
      } else if (b.dataset.act === "next") playAt(idx + 1);
      else if (audio.paused) attemptPlay(); else audio.pause();
    }
  });

  // Native range: dragging, clicking, and arrow-key seeking all fire 'input'
  // uniformly, so one delegated handler covers mouse, touch, and keyboard —
  // delegated since renderNow() replaces the element on every track change.
  nowEl.addEventListener("mousedown", function (e) { if (e.target.closest(".progress-range")) seeking = true; });
  nowEl.addEventListener("touchstart", function (e) { if (e.target.closest(".progress-range")) seeking = true; });
  nowEl.addEventListener("change", function (e) { if (e.target.closest(".progress-range")) seeking = false; });
  nowEl.addEventListener("input", function (e) {
    var range = e.target.closest(".progress-range");
    if (!range || !audio.duration) return;
    var pct = (range.value / RANGE_MAX) * 100;
    range.style.background = "linear-gradient(to right, var(--accent) " + pct + "%, var(--border) " + pct + "%)";
    audio.currentTime = (pct / 100) * audio.duration;
  });

  // ── queue list ────────────────────────────────────────────────────────────

  var X_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

  function renderQueue() {
    queueEl.innerHTML = '<p class="search-status">' + queue.length
      + (queue.length === 1 ? " song · " : " songs · ") + totalStr(queue)
      + (mode === "endless" ? " · reshuffles when it runs out" : "") + "</p>"
      + (queue.length ? '<button type="button" class="select-all" data-target="#pl-queue">Select all</button>' : "")
      + '<div class="search-results">' + queue.map(function (t, i) {
        // .pl-row is a plain container (not a button — it holds three
        // separate interactive children): the play button, the "+" selection
        // toggle (see track-select.js), and the × remove button.
        return '<div class="pl-row" data-i="' + i + '">'
          + '<button type="button" class="sr pl-row-play" data-i="' + i + '">'
          + '<span class="sr-icon">&#9834;</span>'
          + '<span class="sr-main"><span class="sr-title">' + esc(t.title) + "</span>"
          + '<span class="sr-sub">' + esc(trackMeta(t)) + "</span></span>"
          + '<span class="sr-src src-' + esc(t.sourceType) + '">' + esc(t.sourceType.toUpperCase()) + "</span>"
          + '<span class="sr-meta">' + formatTime(t.durationSec) + "</span></button>"
          + trackAddButtonHtml(t.id)
          + '<button type="button" class="pl-remove" data-i="' + i
          + '" aria-label="Remove ' + esc(t.title) + ' from this playlist">' + X_SVG + "</button>"
          + "</div>";
      }).join("") + "</div>";
  }

  // Drop one track from the queue in place. The queue is the single source of
  // truth — the hash, share button, and playing-index all resync from it.
  function removeAt(i) {
    if (i < 0 || i >= queue.length) return;
    var wasPlaying = idx !== -1 && !audio.paused;
    queue.splice(i, 1);
    if (!queue.length) {
      stop();
    } else if (i < idx) {
      idx--;                       // playing track shifted down one slot
    } else if (i === idx) {
      // the next track slid into this slot; cue it (keep playing only if we were)
      if (idx >= queue.length) {
        stop();
      } else {
        audio.src = streamUrl(queue[idx]);
        if (wasPlaying) attemptPlay();
        renderNow();
      }
    }
    renderQueue();
    syncHash();
    highlight();
  }

  function highlight() {
    queueEl.querySelectorAll(".pl-row").forEach(function (r) {
      r.classList.toggle("pl-playing", +r.dataset.i === idx);
    });
  }

  queueEl.addEventListener("click", function (e) {
    if (e.target.closest(".track-add") || e.target.closest(".select-all")) return;
    var rm = e.target.closest(".pl-remove");
    if (rm) { removeAt(+rm.dataset.i); return; }
    var b = e.target.closest(".pl-row-play");
    if (b) playAt(+b.dataset.i);
  });

  // ── boot ──────────────────────────────────────────────────────────────────

  // Selecting tracks via the "+" buttons on this same queue (track-select.js)
  // and clicking "Build playlist" sets a new #p=... hash without a page
  // reload — re-hydrate the queue from it, same as a fresh page load would.
  window.addEventListener("hashchange", hydrateFromHash);

  renderSaved();  // needs no catalog — names/counts come straight from storage

  fetch("/assets/tracks.json")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      CATALOG = data;
      renderFilters();
      renderLength();
      updateStatus();
      hydrateFromHash();
      // The initial renderSaved() above ran against an empty CATALOG (by
      // design, so names/counts show immediately from storage alone) — its
      // Download buttons' size tooltips needed real tracks, so redo it now
      // that resolveIds() can actually look them up.
      renderSaved();
    })
    .catch(function (e) { statusEl.textContent = "Could not load the track catalog: " + e; });
})();
