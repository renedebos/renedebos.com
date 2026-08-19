// Shared audio player + download logic for all pages.
const WORKER = 'https://wav-download.renedebos.workers.dev';

function formatTime(s) {
  if (!isFinite(s)) return '—';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

const playIcon = `<svg viewBox="0 0 16 16" fill="currentColor"><polygon points="4,2 14,8 4,14"/></svg>`;
const pauseIcon = `<svg viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="2" width="4" height="12"/><rect x="9" y="2" width="4" height="12"/></svg>`;
const loadingIcon = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:spin 0.75s linear infinite;display:block"><circle cx="8" cy="8" r="5.5" stroke-dasharray="20" stroke-dashoffset="6" stroke-linecap="round"/></svg>`;

// Every play button carries the track it controls in data-play-label (song,
// artist, date) so a screen reader hears "Play <track>" / "Pause <track>"
// instead of an undifferentiated "Play" repeated on every row.
function setPlayState(btn, playing, iconHtml) {
  btn.innerHTML = iconHtml;
  const label = btn.dataset.playLabel;
  btn.setAttribute('aria-label', label ? `${playing ? 'Pause' : 'Play'} ${label}` : (playing ? 'Pause' : 'Play'));
}

let activePlayer = null;
const RANGE_MAX = 1000;

// ── playback coordination (same page + other tabs/windows) ──────────────────
// Show/song-page track players, waveform rows (driven by the shared
// PlaybackController where mounted, or dormant otherwise — wavesurfer.js,
// the module that used to drive them here, was removed in Step 5c),
// /playlist/, and the /player/ popup each own an independent <audio>
// element with no shared engine, so playing one doesn't pause the others.
// A claim announces
// "I'm playing now": it's broadcast to every other tab/window AND delivered
// to every other player on the same page — BroadcastChannel never delivers
// to the posting page itself, and a show page mixes two independent systems
// (waveform track rows + the Full Recording custom player). `owner` is any
// stable per-player value; a claim skips the listener with the same owner so
// a player never pauses itself.
let playbackChannel = null;
try { playbackChannel = new BroadcastChannel('hannan-playback'); } catch (e) { /* unsupported / private browsing */ }
const playbackId = Math.random().toString(36).slice(2);
const claimListeners = [];
function claimPlayback(owner) {
  if (playbackChannel) playbackChannel.postMessage(playbackId);
  claimListeners.forEach(l => { if (l.owner !== owner) l.fn(); });
}
function onExternalClaim(fn, owner) {
  claimListeners.push({ fn, owner });
}
if (playbackChannel) {
  playbackChannel.onmessage = e => {
    if (e.data !== playbackId) claimListeners.forEach(l => l.fn());
  };
}
window.claimPlayback = claimPlayback;
window.onExternalClaim = onExternalClaim;

// Wires up every .custom-player under `root` that isn't already initialized.
// Runs once for the whole document on load; the Songs page also calls this
// itself (see songs.js) after inserting a song's performance rows lazily, so
// those newly-added players get the same play/pause/seek wiring.
function initCustomPlayers(root) {
  root.querySelectorAll('.custom-player').forEach(player => {
    if (player._audio) return;
    const src = player.dataset.src;
    // Loudness variant. `data-src` is always the -20 archive URL; the row's
    // data-item (where it has one) carries the -14 render. This is the LEGACY
    // fallback engine — it only runs when the shared PlaybackController never
    // mounted — but the page still says in words which version is playing, so
    // it has to honour the same preference. Read through the window bridge
    // (variant-pref.js) rather than re-implementing it; absent bridge, or a
    // row with no variant, means the archive, which is the safe direction.
    let loudSrc = null;
    try { loudSrc = (JSON.parse(player.dataset.item || '{}') || {}).loudUrl || null; } catch (_) { /* not a playable row */ }
    const resolveSrc = () => {
      const v = window.HannanVariant;
      return (loudSrc && v && v.get() === 'loud') ? loudSrc : src;
    };
    const audio = new Audio();
    audio.preload = 'none';

    const btn = player.querySelector('.play-btn');
    const range = player.querySelector('.progress-range');
    const currentEl = player.querySelector('.current');
    // Compact track rows store their catalog duration on the one available
    // time label. Larger players render elapsed and total in separate labels.
    const compactDuration = currentEl.dataset.duration || '';
    const separateDurationEl = player.querySelector('.time-row .time-label:not(.current)');
    const totalDuration = compactDuration || (separateDurationEl ? separateDurationEl.textContent.trim() : '');

    let loaded = false;
    let seeking = false;

    onExternalClaim(() => {
      if (!audio.paused) { audio.pause(); setPlayState(btn, false, playIcon); }
    }, player);

    function load() {
      if (!loaded) { audio.src = resolveSrc(); loaded = true; }
    }

    // Re-point at the other render of the same performance, keeping position
    // and play state (same contract as PlaybackController._onVariantChanged()).
    // Untouched rows stay unloaded and simply pick the new variant up the
    // first time they're played.
    if (loudSrc) {
      window.addEventListener('hannanvariantchange', () => {
        if (!loaded) return;
        const want = resolveSrc();
        if (want === audio.src) return;
        const at = audio.currentTime || 0;
        const wasPlaying = !audio.paused;
        audio.src = want;
        const restore = () => {
          try { if (at > 0) audio.currentTime = at; } catch (_) { /* unseekable */ }
          if (wasPlaying) { const pr = audio.play(); if (pr && pr.catch) pr.catch(() => {}); }
        };
        if (audio.readyState >= 1) restore();
        else audio.addEventListener('loadedmetadata', restore, { once: true });
      });
    }

    function setFill(pct) {
      // backgroundImage, not the `background` shorthand — see .progress-range
      // in site.css: the shorthand would inflate the 3px rail to 24px.
      range.style.backgroundImage = `linear-gradient(to right, var(--accent) ${pct}%, var(--border) ${pct}%)`;
    }

    function setTime(seconds) {
      const elapsed = formatTime(seconds);
      currentEl.textContent = compactDuration ? `${elapsed} / ${compactDuration}` : elapsed;
      range.setAttribute('aria-valuetext', totalDuration ? `${elapsed} of ${totalDuration}` : elapsed);
    }

    audio.addEventListener('timeupdate', () => {
      const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
      if (!seeking) {
        range.value = Math.round(pct * RANGE_MAX / 100);
        setFill(pct);
      }
      setTime(audio.currentTime);
    });

    audio.addEventListener('waiting', () => {
      btn.innerHTML = loadingIcon;
    });

    audio.addEventListener('playing', () => {
      setPlayState(btn, true, pauseIcon);
      activePlayer = player;
    });

    audio.addEventListener('play', () => {
      player.classList.add('playing');
      claimPlayback(player);
      // A deep-linked track (see focusHashTrack) stays highlighted until some
      // other track actually starts playing.
      document.querySelectorAll('.track-row.target').forEach(r => { if (r !== player) r.classList.remove('target'); });
    });
    audio.addEventListener('pause', () => player.classList.remove('playing'));

    audio.addEventListener('ended', () => {
      setPlayState(btn, false, playIcon);
      range.value = 0;
      setFill(0);
      setTime(0);
      player.classList.remove('playing');
      if (activePlayer === player) activePlayer = null;
      // Auto-advance within lists that opt in (the curated track lists)
      const list = player.closest('[data-autoplay-next]');
      if (list) {
        const items = Array.from(list.querySelectorAll('.custom-player'));
        const next = items[items.indexOf(player) + 1];
        if (next) next.querySelector('.play-btn').click();
      }
    });

    btn.addEventListener('click', () => {
      load();
      if (audio.paused) {
        document.querySelectorAll('.custom-player').forEach(p => {
          if (p !== player) {
            const a = p._audio;
            if (a && !a.paused) { a.pause(); setPlayState(p.querySelector('.play-btn'), false, playIcon); }
          }
        });
        audio.play().catch(() => setPlayState(btn, false, playIcon));
        setPlayState(btn, true, audio.readyState < 3 ? loadingIcon : pauseIcon);
      } else {
        audio.pause();
        setPlayState(btn, false, playIcon);
      }
    });

    // Native range: dragging, clicking, and arrow-key seeking all fire 'input'
    // uniformly, so this one handler covers mouse, touch, and keyboard.
    range.addEventListener('mousedown', () => { seeking = true; });
    range.addEventListener('touchstart', () => { seeking = true; });
    range.addEventListener('input', () => {
      load();
      const pct = (range.value / RANGE_MAX) * 100;
      setFill(pct);
      if (audio.duration) audio.currentTime = (pct / 100) * audio.duration;
    });
    range.addEventListener('change', () => { seeking = false; });

    player._audio = audio;
  });
}
window.initCustomPlayers = initCustomPlayers;

// ── engine selection ─────────────────────────────────────────────────────────
// A page migrated to the shared PlaybackController (see player-boot.js and
// plans/player-consolidation/) sets window.PLAYER_ENGINE = 'controller' inline
// BEFORE this script, so the decision exists before any legacy code runs — a
// guard checked later could never win, since these registrations would already
// have happened.
//
// Rather than bail outright on that flag, this defers: player-boot.js is a
// module and so runs before DOMContentLoaded, setting PLAYER_ENGINE_MOUNTED
// only if it actually mounted. If it 404s, fails to parse, or throws, the flag
// stays unset and everything here initializes normally. A static "don't init"
// flag would instead leave such a page with no player at all on any module or
// asset failure — a regression, not a fallback.
//
// All three playback registrations are gated, not just the mount: two live
// deep-link handlers would both scroll and mutate .target and could both act
// on ?autoplay=1, and the legacy Space listener would swallow Space with no
// legacy player behind it. Downloads, share, and tooltips are untouched —
// they aren't playback.
//
// (Each helper below is a hoisted function declaration, so this block can sit
// where the original unconditional initCustomPlayers(document) call did and
// keep the legacy path's ordering byte-for-byte identical.)
function initLegacyPlayback() {
  initCustomPlayers(document);
  initLegacySpaceBar();
  initLegacyDeepLink();
}

// DOMContentLoaded, not a readyState check: readyState is already 'interactive'
// while deferred/module scripts run, so a "past loading, just go" shortcut would
// initialize this before player-boot.js (a module, and later in the document)
// ever got to claim the page. The actual guarantee (HTML Standard's parsing/
// script-processing model, confirmed in the Step 4 review — see wavesurfer.js
// for the fuller note): build.py emits every script here as an ordinary
// parser-inserted <script> in document order, and that whole ordered list runs
// before DOMContentLoaded is even queued, so registering this listener in the
// same synchronous parse job is always in time. Narrower than "any script
// placement" — a dynamically inserted or differently-scheduled script isn't
// covered by this argument, only build.py's own output is.
if (window.PLAYER_ENGINE === 'controller') {
  document.addEventListener('DOMContentLoaded', () => {
    if (!window.PLAYER_ENGINE_MOUNTED) initLegacyPlayback();
  });
} else {
  initLegacyPlayback();
}

function initLegacySpaceBar() {
  document.addEventListener('keydown', e => {
    if (e.code !== 'Space') return;
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
    e.preventDefault();
    if (!activePlayer) return;
    const audio = activePlayer._audio;
    const btn = activePlayer.querySelector('.play-btn');
    if (audio.paused) {
      audio.play().catch(() => setPlayState(btn, false, playIcon));
      setPlayState(btn, true, loadingIcon);
    } else {
      audio.pause();
      setPlayState(btn, false, playIcon);
    }
  });
}

// ── downloads ────────────────────────────────────────────────────────────────
// All downloads are password protected: every download button goes through
// the password modal (/auth issues an HMAC token for /download). Streaming
// is the only ungated path.

const modal = document.createElement('div');
modal.className = 'pw-overlay';
modal.id = 'pwOverlay';
modal.innerHTML = `
  <div class="pw-modal">
    <h3>Protected Download</h3>
    <p>This recording is password protected. Enter the password to download.</p>
    <input type="password" id="pwInput" placeholder="Password" autocomplete="off">
    <div class="pw-modal-error" id="pwError"></div>
    <div class="pw-modal-actions">
      <button class="pw-cancel" id="pwCancel">Cancel</button>
      <button class="pw-submit" id="pwSubmit">Download</button>
    </div>
  </div>`;
document.body.appendChild(modal);

// Non-blocking progress toast — once a batch ZIP's password is confirmed,
// the modal hands off to this so the visitor can keep browsing/playing
// tracks on the page while the rest fetch/zip in the background. Cancel
// here works the same as the modal's: aborts the in-flight batch.
const toast = document.createElement('div');
toast.className = 'dl-toast';
toast.innerHTML = `
  <span class="dl-toast-text"></span>
  <button type="button" class="dl-toast-cancel" id="toastCancel" aria-label="Cancel download">&times;</button>`;
document.body.appendChild(toast);
const toastText = toast.querySelector('.dl-toast-text');

function showToast() {
  toast.classList.remove('error');
  toast.classList.add('open');
}
function setToastText(text, isError) {
  toastText.textContent = text;
  toast.classList.toggle('error', !!isError);
}
function hideToast() {
  toast.classList.remove('open', 'error');
}
toast.querySelector('#toastCancel').addEventListener('click', () => {
  if (batchAbort) batchAbort.abort();
});

// pendingTarget is either { type: 'single', file, filename } (today's one-file
// flow) or { type: 'batch', manifest: {zipName, files:[{key,name}], infoName,
// infoText} } — a whole show or every performance of a song, assembled into a
// ZIP client-side after a single password entry. See tryBatchDownload below.
let pendingTarget = null;

// Set for the duration of a batch fetch/zip. While the modal is still up
// (validating the password against the first file) this blocks accidental
// dismissal the same way it always has; once that first file succeeds the
// modal hands off to the toast above and closes, so batchAbort staying set
// no longer blocks anything — it just means Cancel (on either the modal or
// the toast) can still stop the in-flight batch.
let batchAbort = null;

function openPasswordModal(target) {
  pendingTarget = target;
  document.getElementById('pwInput').value = '';
  document.getElementById('pwError').textContent = '';
  modal.classList.add('open');
  setTimeout(() => document.getElementById('pwInput').focus(), 50);
}

function closeModal() {
  if (batchAbort) batchAbort.abort();
  modal.classList.remove('open');
  pendingTarget = null;
}

// Hides the modal WITHOUT aborting — used only when handing a validated
// batch off to the background toast, where batchAbort deliberately stays set.
function hideModalKeepBatch() {
  modal.classList.remove('open');
  pendingTarget = null;
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// Mints a token for one R2 key and fetches it — exactly today's single-file
// flow, reused per file in a batch. authFailed is set on a wrong password so
// callers can show the same "Incorrect password" message a single download
// would.
async function fetchWithToken(password, key, signal) {
  const authRes = await fetch(WORKER + '/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password, filename: key }),
    signal,
  });
  if (!authRes.ok) {
    const err = new Error('auth failed');
    err.authFailed = true;
    throw err;
  }
  const { token, expires } = await authRes.json();
  const dlRes = await fetch(WORKER + '/download?file=' + encodeURIComponent(key)
    + '&token=' + encodeURIComponent(token) + '&expires=' + expires, { signal });
  if (!dlRes.ok) throw new Error('download failed: ' + key);
  return dlRes;
}

// Fetches every file in the manifest (small concurrency cap — this is a
// courtesy to the Worker/R2, not a requirement) and assembles a ZIP entirely
// in the browser via the vendored client-zip. No server-side ZIP generation,
// no new Worker route — each file goes through the exact /auth + /download
// pair a single download already uses.
//
// The first file is fetched while the modal is still open, so a wrong
// password still interrupts immediately the way it always has. Once that
// confirms the password, control hands off to the non-blocking toast for
// the rest — a whole show can be a lot of tracks, and there's no reason to
// keep the visitor stuck on a blocking dialog for however long that takes.
async function tryBatchDownload(password, manifest) {
  const abort = new AbortController();
  batchAbort = abort;
  const files = manifest.files;
  const results = new Array(files.length);
  let totalBytes = 0;

  try {
    const firstRes = await fetchWithToken(password, files[0].key, abort.signal);
    totalBytes += parseInt(firstRes.headers.get('content-length') || '0', 10);
    results[0] = { input: firstRes, name: files[0].name };
  } catch (e) {
    batchAbort = null;
    throw e; // still shown in the modal — see tryDownload's catch
  }

  hideModalKeepBatch();
  showToast();
  let doneCount = 1;
  setToastText(`Fetching ${doneCount} / ${files.length} tracks…`);

  try {
    let nextIdx = 1;
    const CONCURRENCY = 4;
    async function worker() {
      while (nextIdx < files.length) {
        const i = nextIdx++;
        const res = await fetchWithToken(password, files[i].key, abort.signal);
        totalBytes += parseInt(res.headers.get('content-length') || '0', 10);
        results[i] = { input: res, name: files[i].name };
        doneCount++;
        setToastText(`Fetching ${doneCount} / ${files.length} tracks…`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(0, files.length - 1)) }, worker));
    if (manifest.infoName && manifest.infoText) {
      results.push({ input: manifest.infoText, name: manifest.infoName });
      totalBytes += new Blob([manifest.infoText]).size;
    }

    const { downloadZip } = await import('/assets/client-zip.js');
    const zipRes = downloadZip(results);
    const reader = zipRes.body.getReader();
    const chunks = [];
    let assembled = 0;
    setToastText('Assembling ZIP…');
    for (;;) {
      if (abort.signal.aborted) {
        reader.cancel();
        throw new DOMException('Cancelled', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      assembled += value.length;
      setToastText(totalBytes
        ? `Assembling ZIP… ${Math.min(99, Math.round(assembled / totalBytes * 100))}%`
        : 'Assembling ZIP…');
    }
    const blob = new Blob(chunks, { type: 'application/zip' });

    setToastText('Starting download…');
    const url = URL.createObjectURL(blob);
    hideToast();
    triggerDownload(url, manifest.zipName);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    if (e && e.name === 'AbortError') {
      hideToast();
    } else {
      setToastText('Download failed — please try again.', true);
      setTimeout(hideToast, 4000);
    }
  } finally {
    batchAbort = null;
  }
}

async function tryDownload() {
  const password = document.getElementById('pwInput').value;
  const submitBtn = document.getElementById('pwSubmit');
  const target = pendingTarget;
  submitBtn.disabled = true;
  submitBtn.textContent = '…';

  try {
    if (target.type === 'batch') {
      try {
        await tryBatchDownload(password, target.manifest);
      } catch (e) {
        if (e && e.name === 'AbortError') {
          // Deliberately cancelled via the Cancel button — closeModal()
          // already handled dismissal, nothing to report.
        } else if (e && e.authFailed) {
          document.getElementById('pwError').textContent = 'Incorrect password. Please try again.';
          document.getElementById('pwInput').value = '';
          document.getElementById('pwInput').focus();
        } else {
          document.getElementById('pwError').textContent = 'Download failed — please try again.';
        }
      }
      return;
    }

    const res = await fetch(WORKER + '/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, filename: target.file }),
    });

    if (!res.ok) {
      document.getElementById('pwError').textContent = 'Incorrect password. Please try again.';
      document.getElementById('pwInput').value = '';
      document.getElementById('pwInput').focus();
      return;
    }

    const { token, expires } = await res.json();
    closeModal();
    triggerDownload(
      WORKER + '/download?file=' + encodeURIComponent(target.file)
        + '&token=' + encodeURIComponent(token) + '&expires=' + expires,
      target.filename);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Download';
  }
}

document.getElementById('pwSubmit').addEventListener('click', tryDownload);
document.getElementById('pwCancel').addEventListener('click', closeModal);
document.getElementById('pwInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') tryDownload();
  // Escape is disabled mid-batch — Cancel is the one deliberate way to stop
  // an in-progress ZIP; a stray keypress shouldn't lose visibility into it.
  if (e.key === 'Escape' && !batchAbort) closeModal();
});
modal.addEventListener('click', e => {
  if (e.target === modal && !batchAbort) closeModal();
});

document.querySelectorAll('a.download-btn').forEach(btn => {
  btn.addEventListener('click', e => {
    e.preventDefault();
    const fileParam = new URL(btn.href).searchParams.get('file');
    const displayName = btn.getAttribute('download') || decodeURIComponent(fileParam.split('/').pop());
    openPasswordModal({ type: 'single', file: fileParam, filename: displayName });
  });
});

document.querySelectorAll('.zip-download-btn').forEach(btn => {
  btn.addEventListener('click', e => {
    e.preventDefault();
    if (!window.ZIP_MANIFEST) return;
    // Only one batch at a time — a second click while one's already running
    // (in the modal or backgrounded to the toast) would race the same
    // batchAbort/toast state.
    if (batchAbort) return;
    openPasswordModal({ type: 'batch', manifest: window.ZIP_MANIFEST });
  });
});

// ── hover info tooltip ───────────────────────────────────────────────────────
// Any element with data-info='[["Label","Value"], ...]' shows a small card.

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const tip = document.createElement('div');
tip.className = 'info-tooltip';
document.body.appendChild(tip);
let tipFor = null;

function showTip(el) {
  if (tipFor === el) return;
  let pairs;
  try { pairs = JSON.parse(el.dataset.info); } catch { return; }
  tipFor = el;
  tip.innerHTML = '<dl>' + pairs.map(([k, v]) =>
    `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('') + '</dl>';
  tip.classList.add('show');
  const r = el.getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = Math.max(8, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 8));
  let top = r.top - th - 8;
  if (top < 8) top = r.bottom + 8;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

function hideTip() { tip.classList.remove('show'); tipFor = null; }

document.addEventListener('mouseover', e => {
  const el = e.target.closest('[data-info]');
  if (el) showTip(el);
});
document.addEventListener('mouseout', e => {
  const el = e.target.closest('[data-info]');
  if (el && !el.contains(e.relatedTarget)) hideTip();
});
window.addEventListener('scroll', hideTip, true);

// ── per-track sharing ────────────────────────────────────────────────────────

const sharePop = document.createElement('div');
sharePop.className = 'share-pop';
document.body.appendChild(sharePop);

function trackUrl(btn) {
  const row = btn.closest('[id]');
  const hash = row && row.id ? '#' + row.id : '';
  return location.origin + location.pathname + hash;
}

function openSharePop(btn) {
  const url = trackUrl(btn);
  const text = btn.dataset.text || document.title;
  const e = encodeURIComponent;
  sharePop.innerHTML = `
    <a href="https://twitter.com/intent/tweet?text=${e(text)}&url=${e(url)}" target="_blank" rel="noopener">Share on X</a>
    <a href="https://www.facebook.com/sharer/sharer.php?u=${e(url)}" target="_blank" rel="noopener">Share on Facebook</a>
    <a href="mailto:?subject=${e(text)}&body=${e(text + '\n\n' + url)}">Email</a>
    <button type="button" data-copy="${escapeHtml(url)}">Copy link</button>`;
  sharePop.classList.add('open');
  const r = btn.getBoundingClientRect();
  const pw = sharePop.offsetWidth, ph = sharePop.offsetHeight;
  let left = Math.max(8, Math.min(r.right - pw, window.innerWidth - pw - 8));
  let top = r.bottom + 6;
  if (top + ph > window.innerHeight - 8) top = r.top - ph - 6;
  sharePop.style.left = left + 'px';
  sharePop.style.top = top + 'px';
}

function closeSharePop() { sharePop.classList.remove('open'); }

document.addEventListener('click', e => {
  const shareBtn = e.target.closest('.share-btn');
  if (shareBtn) {
    e.preventDefault();
    const url = trackUrl(shareBtn);
    const text = shareBtn.dataset.text || document.title;
    if (navigator.share) {
      navigator.share({ title: document.title, text, url }).catch(() => {});
    } else {
      openSharePop(shareBtn);
    }
    return;
  }
  const copyBtn = e.target.closest('.share-pop [data-copy]');
  if (copyBtn) {
    navigator.clipboard.writeText(copyBtn.dataset.copy).then(() => {
      copyBtn.textContent = 'Copied!';
      setTimeout(closeSharePop, 800);
    });
    return;
  }
  if (!e.target.closest('.share-pop')) closeSharePop();
});

// ── deep-link to a track ──────────────────────────────────────────────────────

function focusHashTrack() {
  if (!location.hash) return;
  let el;
  try { el = document.querySelector(location.hash); } catch { return; }
  if (el && el.classList.contains('track-row')) {
    // Persists until a different track starts playing (see the 'play' listener
    // above) rather than fading on a timer — a deep link should stay obvious.
    document.querySelectorAll('.track-row.target').forEach(r => { if (r !== el) r.classList.remove('target'); });
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('target');
    // Waveform rows (.ws-track) never autoplay here on purpose. On a
    // controller-engine page (every public show today) player-boot.js's own
    // deep-link handling covers them instead (see its header comment). On a
    // page rolled back via CONTROLLER_ENGINE_EXCLUDED_SLUGS, no engine
    // drives waveform rows at all since wavesurfer.js was removed in Step
    // 5c — clicking here would silently do nothing, same as before, just
    // for a different reason now.
    if (el.classList.contains('custom-player') && new URLSearchParams(location.search).get('autoplay') === '1') {
      const btn = el.querySelector('.play-btn');
      if (btn) btn.click();
    }
  }
}
function initLegacyDeepLink() {
  window.addEventListener('load', focusHashTrack);
  window.addEventListener('hashchange', focusHashTrack);
}

// ── continuous player popup ─────────────────────────────────────────────────
// Opening a tab/window with a fixed name and an empty URL returns a handle to
// it WITHOUT navigating it away if it already exists — the standard trick for
// "find or create" a named popup. Used from /playlist/'s "Open continuous
// player" button and the track-selection bar's "Add to player" (see
// track-select.js) so either can hand tracks to an already-running player
// (by extending its #p=... hash — continuous-player.js treats an append as
// non-disruptive, see its hashchange handler) without stealing focus from
// whatever page the visitor is actually on, unless they asked to be taken
// there (opts.focus).
//
// opts.startTime only applies when the popup doesn't exist yet (a fresh
// hand-off, not a background append) — it seeds a one-time &t=<seconds>
// alongside the hash so continuous-player.js can resume at the same position
// instead of restarting; it has no meaning for a merge into a queue that's
// already playing something else.
// Returns how many tracks were actually new to the player's queue (the merge
// dedupes, so "add" can be a no-op) — callers can tell the visitor instead of
// silently doing nothing. null means the popup was blocked.
function sendToPlayer(ids, opts) {
  const w = window.open('', 'hannanPlayer');
  if (!w) return null; // popup blocked
  let added;
  if (w.location.pathname === '/player/') {
    const existing = (w.location.hash.match(/^#p=([\w.,-]+)/) || [, ''])[1].split(',').filter(Boolean);
    const fresh = ids.filter((id, i, a) => id && a.indexOf(id) === i && existing.indexOf(id) === -1);
    if (fresh.length) w.location.hash = '#p=' + existing.concat(fresh).join(',');
    added = fresh.length;
  } else {
    const t = opts && opts.startTime ? '&t=' + opts.startTime.toFixed(1) : '';
    w.location.href = '/player/#p=' + ids.join(',') + t;
    added = ids.length;
  }
  if (opts && opts.focus) w.focus();
  return added;
}
