// Continuous player for /player/ — a dedicated popup window a visitor opens
// once (see player.js's sendToPlayer()) and leaves alone so playback survives
// navigating away in every OTHER tab, which a plain page-scoped <audio>
// element on the main site never could. Deliberately self-contained: no
// dependency on player.js (whose password-modal/download machinery this
// page doesn't need) or playlist.js (whose filter-builder this page doesn't
// need) — a small, intentional duplication of the handful of shared bits
// (WORKER, formatTime, ARTIST_NAMES) rather than pulling in either file's
// full surface. The playback engine (streamUrl/playAt/stop/attemptPlay, the
// audio event listeners, the #p=... hash format) mirrors playlist.js, which
// is the fuller reference implementation if either drifts.
(function () {
  var WORKER = "https://wav-download.renedebos.workers.dev";
  var RANGE_MAX = 1000;
  var ARTIST_NAMES = { jerry: "Jerry Hannan", sean: "Sean Hannan",
                       mad: "Mad Hannans", seanjerry: "Sean & Jerry Hannan" };

  var nowEl = document.getElementById("cp-now");
  var queueEl = document.getElementById("cp-queue");
  var statusEl = document.getElementById("cp-status");

  var CATALOG = [];
  var queue = [];
  var idx = -1;
  // Persistent shuffle mode — mirrors playlist.js's toggleShuffle()/renderNow()
  // (the fuller reference implementation, see file header).
  var shuffleOn = false;
  var unshuffledQueue = null;
  function resetShuffle() { shuffleOn = false; unshuffledQueue = null; }
  var audio = new Audio();
  audio.preload = "none";
  var seeking = false;

  // ── cross-tab/window playback coordination (mirrors player.js) ───────────
  // This popup isn't loaded alongside player.js (see the file header), so it
  // duplicates the small BroadcastChannel coordinator rather than sharing it.
  var playbackChannel = null;
  try { playbackChannel = new BroadcastChannel("hannan-playback"); } catch (e) { /* unsupported / private browsing */ }
  var playbackId = Math.random().toString(36).slice(2);
  function claimPlayback() {
    if (playbackChannel) playbackChannel.postMessage(playbackId);
  }
  if (playbackChannel) {
    playbackChannel.onmessage = function (e) {
      if (e.data !== playbackId && !audio.paused) {
        audio.pause();
        // Say why it went quiet, or the pause looks like a glitch. Cleared
        // the next time playback starts (see the 'play' listener).
        if (statusEl) statusEl.textContent = "Paused — playback started somewhere else on the site.";
      }
    };
  }

  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  };

  // Monochrome SVGs, same style/weight as player.js's playIcon/pauseIcon and
  // playlist.js's mirror of them — ⏮/⏭ text glyphs render as full-color emoji
  // on some platforms while ▶/❚❚ stayed plain text, so prev/next looked
  // nothing like play/pause. One icon set for all four fixes that everywhere.
  var PLAY_ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><polygon points="4,2 14,8 4,14"/></svg>';
  var PAUSE_ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="2" width="4" height="12"/><rect x="9" y="2" width="4" height="12"/></svg>';
  var PREV_ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="2" width="2" height="12"/><polygon points="14,2 14,14 4,8"/></svg>';
  var NEXT_ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><polygon points="2,2 2,14 12,8"/><rect x="12" y="2" width="2" height="12"/></svg>';
  var SHUFFLE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
    + 'stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/>'
    + '<line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/>'
    + '<line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>';

  // Mirrors playlist.js's shuffle().
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  function formatTime(s) {
    if (!isFinite(s)) return "—";
    var m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ":" + (sec < 10 ? "0" : "") + sec;
  }

  function streamUrl(t) {
    return WORKER + "/stream?file=" + encodeURIComponent(t.file) + (t.ver ? "&v=" + t.ver : "");
  }

  function trackMeta(t) {
    return [ARTIST_NAMES[t.artist] || t.artist, t.venue, t.showDate || "unknown date"]
      .filter(Boolean).join(" · ");
  }

  function totalStr(list) {
    var sec = 0;
    list.forEach(function (t) { sec += t.durationSec; });
    var h = Math.floor(sec / 3600), m = Math.round(sec % 3600 / 60);
    return h ? h + "h " + m + "m" : m + " min";
  }

  function resolveIds(ids) {
    var byId = {};
    CATALOG.forEach(function (t) { byId[t.id] = t; });
    return ids.map(function (id) { return byId[id]; }).filter(function (t) { return t; });
  }

  // ── player engine (mirrors playlist.js) ──────────────────────────────────

  function playAt(i) {
    if (i < 0) i = 0;
    if (i >= queue.length) { stop(); return; }
    idx = i;
    audio.src = streamUrl(queue[idx]);
    attemptPlay();
    renderNow();
    highlight();
    setMediaMetadata();
    saveState();
  }

  function stop() {
    audio.pause();
    idx = -1;
    renderNow();
    highlight();
    saveState();
  }

  // audio.play() rejects on autoplay blocks/decode errors/dropped
  // connections — unhandled, that fails silently and the UI just looks stuck.
  function attemptPlay() {
    var p = audio.play();
    if (p && p.catch) {
      p.catch(function () {
        if (statusEl) statusEl.textContent = "Couldn't start playback — tap play to try again.";
      });
    }
  }

  audio.addEventListener("ended", function () { playAt(idx + 1); });
  audio.addEventListener("play", function () {
    syncPlayBtn(); syncMediaPlaybackState(); claimPlayback();
    // Playing clears any transient note (paused-by-another-player, restored-
    // queue hint, or a stale playback error) — all one-shot by design.
    if (statusEl) statusEl.textContent = "";
  });
  audio.addEventListener("pause", function () { syncPlayBtn(); syncMediaPlaybackState(); saveState(); });
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
    if (Date.now() - lastStateSave > 5000) saveState();
  });

  function syncPlayBtn() {
    var b = nowEl.querySelector('[data-act="play"]');
    if (b) b.innerHTML = audio.paused ? PLAY_ICON : PAUSE_ICON;
  }

  function highlight() {
    queueEl.querySelectorAll(".pl-row").forEach(function (row, i) {
      row.classList.toggle("pl-playing", i === idx);
    });
  }

  // ── Media Session — lock-screen/headset controls ─────────────────────────
  // playlist.js only ever sets metadata; no action handlers exist anywhere in
  // that file today. This popup is the one place that needs them, since it's
  // the only page meant to keep playing while the visitor's elsewhere.

  function setMediaMetadata() {
    if (!("mediaSession" in navigator) || idx === -1) return;
    var t = queue[idx];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: ARTIST_NAMES[t.artist] || "",
      album: (t.venue || "") + " " + (t.showDate || ""),
      // No per-track/per-show artwork exists in this archive — the site's
      // own social-share image is a reasonable generic fallback.
      artwork: [{ src: "https://renedebos.com/assets/artwork.png", sizes: "512x512", type: "image/png" }],
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

  // ── now-playing UI ────────────────────────────────────────────────────────

  function renderNow() {
    document.title = idx === -1 ? "The Hannan Tapes — Player" : queue[idx].title + " — Player";
    if (idx === -1) {
      nowEl.innerHTML = '<p class="cp-empty">Nothing queued yet. Use &ldquo;Open continuous '
        + 'player&rdquo; on <a href="/playlist/">/playlist/</a>, or the + button on any show or '
        + "song page, then &ldquo;Add to player.&rdquo;</p>";
      return;
    }
    var t = queue[idx];
    nowEl.innerHTML =
      '<div class="pl-now-info"><a class="pl-now-title" href="' + esc(t.url) + '" target="_blank" rel="noopener">'
      + esc(t.title) + "</a>"
      + '<span class="pl-now-meta">' + esc(trackMeta(t))
      + (t.songwriter && t.songwriter !== "Jerry Hannan & Sean Hannan"
        ? ' <span class="sr-tag">' + esc(t.songwriter) + "</span>" : "")
      + "</span></div>"
      + '<div class="pl-controls">'
      + '<button type="button" class="pl-btn" data-act="shuffle" aria-pressed="' + shuffleOn + '" aria-label="'
      + (shuffleOn ? "Shuffle on — click to restore original order" : "Shuffle remaining tracks") + '">' + SHUFFLE_ICON + "</button>"
      + '<button type="button" class="pl-btn" data-act="prev" aria-label="Previous">' + PREV_ICON + "</button>"
      + '<button type="button" class="pl-btn pl-btn-play" data-act="play" aria-label="Play/pause">' + PAUSE_ICON + "</button>"
      + '<button type="button" class="pl-btn" data-act="next" aria-label="Next">' + NEXT_ICON + "</button>"
      + "</div>"
      + '<div class="pl-progress"><span class="pl-time-current">0:00</span>'
      + '<input type="range" class="progress-range" min="0" max="' + RANGE_MAX + '" value="0" step="1" '
      + 'aria-label="Seek ' + esc(t.title) + '" aria-valuetext="0:00">'
      + "<span>" + formatTime(t.durationSec) + "</span></div>";
    syncPlayBtn();
  }

  // Persistent on/off toggle — mirrors playlist.js's toggleShuffle().
  function toggleShuffle() {
    if (shuffleOn) {
      if (unshuffledQueue) {
        var playingId = idx !== -1 ? queue[idx].id : null;
        queue = unshuffledQueue;
        unshuffledQueue = null;
        if (playingId != null) {
          var restoredIdx = queue.findIndex(function (t) { return t.id === playingId; });
          if (restoredIdx !== -1) idx = restoredIdx;
        }
      }
      shuffleOn = false;
    } else {
      unshuffledQueue = queue.slice();
      queue = idx === -1 ? shuffle(queue.slice())
                          : queue.slice(0, idx + 1).concat(shuffle(queue.slice(idx + 1)));
      shuffleOn = true;
    }
    renderQueue();
    renderNow();
    syncHash();
    highlight();
  }

  nowEl.addEventListener("click", function (e) {
    var b = e.target.closest(".pl-btn");
    if (!b) return;
    if (b.dataset.act === "shuffle") toggleShuffle();
    else if (b.dataset.act === "prev") {
      if (audio.currentTime > 3) audio.currentTime = 0; else playAt(idx - 1);
    } else if (b.dataset.act === "next") playAt(idx + 1);
    else if (audio.paused) attemptPlay(); else audio.pause();
  });
  // Keyboard control — this window doesn't load player.js (see the file
  // header), so it needs its own: space toggles play/pause, arrows skip
  // ±10s. Inputs/buttons keep their native key behavior (the seek bar's own
  // arrow-key seeking included — it's an <input>, so it's excluded here).
  document.addEventListener("keydown", function (e) {
    var tag = document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON") return;
    if (e.code === "Space") {
      e.preventDefault();
      if (idx === -1) { if (queue.length) playAt(0); }
      else if (audio.paused) attemptPlay();
      else audio.pause();
    } else if (e.code === "ArrowRight" && audio.duration) {
      audio.currentTime = Math.min(audio.duration, audio.currentTime + 10);
    } else if (e.code === "ArrowLeft" && audio.duration) {
      audio.currentTime = Math.max(0, audio.currentTime - 10);
    }
  });

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

  var X_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" '
    + 'stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

  function renderQueue() {
    if (!queue.length) { queueEl.innerHTML = ""; return; }
    queueEl.innerHTML = '<p class="search-status">' + queue.length
      + (queue.length === 1 ? " song · " : " songs · ") + totalStr(queue) + "</p>"
      + '<div class="search-results">' + queue.map(function (t, i) {
        return '<div class="pl-row" data-i="' + i + '">'
          + '<button type="button" class="sr pl-row-play" data-i="' + i + '">'
          + '<span class="sr-icon">&#9834;</span>'
          + '<span class="sr-main"><span class="sr-title">' + esc(t.title) + "</span>"
          + '<span class="sr-sub">' + esc(trackMeta(t)) + "</span></span>"
          + '<span class="sr-meta">' + formatTime(t.durationSec) + "</span></button>"
          + '<button type="button" class="pl-remove" data-i="' + i
          + '" aria-label="Remove ' + esc(t.title) + ' from this queue">' + X_SVG + "</button>"
          + "</div>";
      }).join("") + "</div>";
    highlight();
  }

  queueEl.addEventListener("click", function (e) {
    var play = e.target.closest(".pl-row-play");
    var remove = e.target.closest(".pl-remove");
    if (play) { playAt(+play.dataset.i); return; }
    if (remove) removeAt(+remove.dataset.i);
  });

  // Drop one track in place — the queue is the source of truth; the hash and
  // playing index both resync from it (mirrors playlist.js's removeAt()).
  function removeAt(i) {
    if (i < 0 || i >= queue.length) return;
    var wasPlaying = idx !== -1 && !audio.paused;
    var removedId = queue[i].id;
    queue.splice(i, 1);
    if (unshuffledQueue) unshuffledQueue = unshuffledQueue.filter(function (t) { return t.id !== removedId; });
    if (!queue.length) {
      stop();
    } else if (i < idx) {
      idx--;
    } else if (i === idx) {
      if (idx >= queue.length) { stop(); }
      else { audio.src = streamUrl(queue[idx]); if (wasPlaying) attemptPlay(); }
    }
    renderQueue();
    renderNow();
    syncHash();
  }

  // ── hash sync ─────────────────────────────────────────────────────────────
  // Same #p=id,id,... format as /playlist/, so any page can hand this window
  // a queue by URL alone. Unlike /playlist/, an incoming hash here is
  // asymmetric on purpose: if it's exactly the current queue plus more ids
  // appended (sendToPlayer()'s "add to the running player" case), splice the
  // new ones on without touching playback; anything else (a wholly different
  // list) is treated as a fresh load, same as opening the page cold.

  function syncHash() {
    history.replaceState(null, "", queue.length
      ? "#p=" + queue.map(function (t) { return t.id; }).join(",")
      : location.pathname);
    saveState();
  }

  // ── session persistence ───────────────────────────────────────────────────
  // The queue only lives in this window's URL hash — accidentally close the
  // popup and it's gone. Mirror queue + position to localStorage (saved on
  // queue changes, pause, and every ~5s while playing) so a cold /player/
  // visit with no hash can pick up where the last session left off (cued,
  // never autoplaying — see the boot block).

  var STATE_KEY = "playerState";
  var lastStateSave = 0;

  function saveState() {
    lastStateSave = Date.now();
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        ids: queue.map(function (t) { return t.id; }),
        idx: idx,
        t: idx === -1 ? 0 : (audio.currentTime || 0),
      }));
    } catch (e) { /* storage full/blocked — persistence is best-effort */ }
  }

  function loadState() {
    try {
      var s = JSON.parse(localStorage.getItem(STATE_KEY) || "null");
      return (s && s.ids && s.ids.length) ? s : null;
    } catch (e) { return null; }
  }

  function loadFreshQueue(ids) {
    queue = resolveIds(ids);
    resetShuffle();
    renderQueue();
    if (!queue.length) { idx = -1; renderNow(); saveState(); return; }
    idx = 0;
    audio.src = streamUrl(queue[0]);
    renderNow();
    highlight();
    setMediaMetadata();
    saveState();
    // No autoplay — browsers block play() before a user gesture anyway, same
    // reasoning as playlist.js's hydrateFromHash().
  }

  window.addEventListener("hashchange", function () {
    var m = location.hash.match(/^#p=([\w.,-]+)/);
    var ids = m ? m[1].split(",").filter(Boolean) : [];
    var currentIds = queue.map(function (t) { return t.id; });
    var isAppend = ids.length > currentIds.length
      && currentIds.every(function (id, i) { return ids[i] === id; });
    if (isAppend) {
      var added = resolveIds(ids.slice(currentIds.length));
      queue = queue.concat(added);
      // Keep the shuffle-off restore snapshot complete — otherwise turning
      // shuffle off later would silently drop whatever got appended while it
      // was on, rather than just leaving shuffle mode alone as intended here.
      if (unshuffledQueue) unshuffledQueue = unshuffledQueue.concat(added);
      renderQueue();
      highlight();
      saveState();
    } else {
      loadFreshQueue(ids);
    }
  });

  // ── boot ──────────────────────────────────────────────────────────────────

  fetch("/assets/tracks.json")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      CATALOG = data;
      var m = location.hash.match(/^#p=([\w.,-]+)/);
      var t = location.hash.match(/[&#]t=([\d.]+)/);
      var ids = m ? m[1].split(",").filter(Boolean) : [];
      // Cold visit with no hash: pick up where the last session left off
      // (queue, track, and position — cued, not playing; there's no user
      // gesture here to justify autoplay, unlike the hand-off case below).
      var restored = ids.length ? null : loadState();
      if (restored) ids = restored.ids;
      loadFreshQueue(ids);
      if (restored && queue.length) {
        if (restored.idx > 0 && restored.idx < queue.length) {
          idx = restored.idx;
          audio.src = streamUrl(queue[idx]);
          renderNow();
          highlight();
          setMediaMetadata();
        }
        if (restored.t > 0) {
          audio.addEventListener("loadedmetadata", function once() {
            audio.currentTime = restored.t;
            audio.removeEventListener("loadedmetadata", once);
          });
        }
        if (statusEl) statusEl.textContent = "Restored your last queue — press play to resume.";
      }
      // A hand-off from /playlist/ (sendToPlayer's opts.startTime) rotates
      // the queue to start on whatever was already playing there and seeds
      // this one-time position — resume there instead of at 0:00. Only
      // meaningful for a fresh load; syncHash() below drops it from the URL
      // either way so it can't linger and get reapplied on a later reload.
      if (t && queue.length) {
        var startTime = parseFloat(t[1]);
        audio.addEventListener("loadedmetadata", function once() {
          audio.currentTime = startTime;
          audio.removeEventListener("loadedmetadata", once);
        });
        // Unlike a cold /player/ visit (no user gesture to point to, so no
        // autoplay attempt below), this boot is a direct consequence of a
        // click on /playlist/ — the popup's "sticky activation" carries
        // that gesture over, so browsers generally allow resuming playback
        // here without another tap. attemptPlay()'s existing rejection
        // handler covers the browsers that still say no.
        attemptPlay();
      }
      syncHash();
    })
    .catch(function (e) {
      if (statusEl) statusEl.textContent = "Could not load the track catalog: " + e;
    });
})();
