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

// Wires up every .custom-player under `root` that isn't already initialized.
// Runs once for the whole document on load; the Songs page also calls this
// itself (see songs.js) after inserting a song's performance rows lazily, so
// those newly-added players get the same play/pause/seek wiring.
function initCustomPlayers(root) {
  root.querySelectorAll('.custom-player').forEach(player => {
    if (player._audio) return;
    const src = player.dataset.src;
    const audio = new Audio();
    audio.preload = 'none';

    const btn = player.querySelector('.play-btn');
    const range = player.querySelector('.progress-range');
    const currentEl = player.querySelector('.current');

    let loaded = false;
    let seeking = false;

    function load() {
      if (!loaded) { audio.src = src; loaded = true; }
    }

    function setFill(pct) {
      range.style.background = `linear-gradient(to right, var(--accent) ${pct}%, var(--border) ${pct}%)`;
    }

    audio.addEventListener('timeupdate', () => {
      const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
      if (!seeking) {
        range.value = Math.round(pct * RANGE_MAX / 100);
        setFill(pct);
      }
      currentEl.textContent = formatTime(audio.currentTime);
      range.setAttribute('aria-valuetext', formatTime(audio.currentTime));
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
      // A deep-linked track (see focusHashTrack) stays highlighted until some
      // other track actually starts playing.
      document.querySelectorAll('.track-row.target').forEach(r => { if (r !== player) r.classList.remove('target'); });
    });
    audio.addEventListener('pause', () => player.classList.remove('playing'));

    audio.addEventListener('ended', () => {
      setPlayState(btn, false, playIcon);
      range.value = 0;
      setFill(0);
      currentEl.textContent = currentEl.dataset.duration || '0:00';
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
initCustomPlayers(document);

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

// pendingTarget is either { type: 'single', file, filename } (today's one-file
// flow) or { type: 'batch', manifest: {zipName, files:[{key,name}], infoName,
// infoText} } — a whole show or every performance of a song, assembled into a
// ZIP client-side after a single password entry. See tryBatchDownload below.
let pendingTarget = null;

// Set for the duration of a batch fetch/zip so accidental dismissal (an
// overlay click, Escape) can't silently strand the download running in the
// background with no visible progress — an in-progress batch can only be
// stopped through the Cancel button, which now actually aborts it instead of
// just hiding the dialog on top of still-running work.
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
// Two distinct slow phases, each with its own progress label — without this
// split the button freezes on "N / N" for however long the ZIP assembly
// takes (client-zip still has to stream every byte through to compute each
// entry's CRC32), which reads as a hang on a large show.
async function tryBatchDownload(password, manifest, submitBtn) {
  const abort = new AbortController();
  batchAbort = abort;
  try {
    const files = manifest.files;
    const results = new Array(files.length);
    let doneCount = 0;
    let nextIdx = 0;
    let totalBytes = 0;
    const CONCURRENCY = 4;
    async function worker() {
      while (nextIdx < files.length) {
        const i = nextIdx++;
        const res = await fetchWithToken(password, files[i].key, abort.signal);
        const len = parseInt(res.headers.get('content-length') || '0', 10);
        totalBytes += len;
        results[i] = { input: res, name: files[i].name };
        doneCount++;
        submitBtn.textContent = `Fetching ${doneCount} / ${files.length} tracks…`;
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
    if (manifest.infoName && manifest.infoText) {
      results.push({ input: manifest.infoText, name: manifest.infoName });
      totalBytes += new Blob([manifest.infoText]).size;
    }

    const { downloadZip } = await import('/assets/client-zip.js');
    const zipRes = downloadZip(results);
    const reader = zipRes.body.getReader();
    const chunks = [];
    let assembled = 0;
    submitBtn.textContent = 'Assembling ZIP…';
    for (;;) {
      if (abort.signal.aborted) {
        reader.cancel();
        throw new DOMException('Cancelled', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      assembled += value.length;
      submitBtn.textContent = totalBytes
        ? `Assembling ZIP… ${Math.min(99, Math.round(assembled / totalBytes * 100))}%`
        : 'Assembling ZIP…';
    }
    const blob = new Blob(chunks, { type: 'application/zip' });

    submitBtn.textContent = 'Starting download…';
    const url = URL.createObjectURL(blob);
    closeModal();
    triggerDownload(url, manifest.zipName);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
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
        await tryBatchDownload(password, target.manifest, submitBtn);
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
    // Waveform rows (.ws-track) are wired up asynchronously by wavesurfer.js,
    // which handles its own hash-autoplay once its rows are actually ready —
    // clicking here before then would silently do nothing.
    if (el.classList.contains('custom-player') && new URLSearchParams(location.search).get('autoplay') === '1') {
      const btn = el.querySelector('.play-btn');
      if (btn) btn.click();
    }
  }
}
window.addEventListener('load', focusHashTrack);
window.addEventListener('hashchange', focusHashTrack);
