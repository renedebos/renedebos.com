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

let activePlayer = null;

document.querySelectorAll('.custom-player').forEach(player => {
  const src = player.dataset.src;
  const audio = new Audio();
  audio.preload = 'none';

  const btn = player.querySelector('.play-btn');
  const fill = player.querySelector('.progress-bar-fill');
  const track = player.querySelector('.progress-bar-track');
  const currentEl = player.querySelector('.current');

  let loaded = false;

  function load() {
    if (!loaded) { audio.src = src; loaded = true; }
  }

  audio.addEventListener('timeupdate', () => {
    const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    fill.style.width = pct + '%';
    currentEl.textContent = formatTime(audio.currentTime);
  });

  audio.addEventListener('waiting', () => {
    btn.innerHTML = loadingIcon;
  });

  audio.addEventListener('playing', () => {
    btn.innerHTML = pauseIcon;
    activePlayer = player;
  });

  audio.addEventListener('play', () => player.classList.add('playing'));
  audio.addEventListener('pause', () => player.classList.remove('playing'));

  audio.addEventListener('ended', () => {
    btn.innerHTML = playIcon;
    fill.style.width = '0%';
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
          if (a && !a.paused) { a.pause(); p.querySelector('.play-btn').innerHTML = playIcon; }
        }
      });
      audio.play();
      btn.innerHTML = audio.readyState < 3 ? loadingIcon : pauseIcon;
    } else {
      audio.pause();
      btn.innerHTML = playIcon;
    }
  });

  track.addEventListener('click', e => {
    load();
    const rect = track.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    if (audio.duration) audio.currentTime = pct * audio.duration;
  });

  player._audio = audio;
});

document.addEventListener('keydown', e => {
  if (e.code !== 'Space') return;
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
  e.preventDefault();
  if (!activePlayer) return;
  const audio = activePlayer._audio;
  const btn = activePlayer.querySelector('.play-btn');
  if (audio.paused) {
    audio.play();
    btn.innerHTML = loadingIcon;
  } else {
    audio.pause();
    btn.innerHTML = playIcon;
  }
});

// ── downloads ────────────────────────────────────────────────────────────────
// MP3/M4A and free files download directly through the Worker; protected
// lossless files (WAV/FLAC) go through the password modal (/auth issues an
// HMAC token for /download).

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

let pendingFile = null;
let pendingFilename = null;

function openPasswordModal(file, filename) {
  pendingFile = file;
  pendingFilename = filename;
  document.getElementById('pwInput').value = '';
  document.getElementById('pwError').textContent = '';
  modal.classList.add('open');
  setTimeout(() => document.getElementById('pwInput').focus(), 50);
}

function closeModal() {
  modal.classList.remove('open');
  pendingFile = null;
  pendingFilename = null;
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function tryDownload() {
  const password = document.getElementById('pwInput').value;
  const submitBtn = document.getElementById('pwSubmit');
  submitBtn.disabled = true;
  submitBtn.textContent = '…';

  try {
    const res = await fetch(WORKER + '/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, filename: pendingFile }),
    });

    if (!res.ok) {
      document.getElementById('pwError').textContent = 'Incorrect password. Please try again.';
      document.getElementById('pwInput').value = '';
      document.getElementById('pwInput').focus();
      return;
    }

    const { token, expires } = await res.json();
    const file = pendingFile;
    const filename = pendingFilename;
    closeModal();
    triggerDownload(
      WORKER + '/download?file=' + encodeURIComponent(file)
        + '&token=' + encodeURIComponent(token) + '&expires=' + expires,
      filename);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Download';
  }
}

document.getElementById('pwSubmit').addEventListener('click', tryDownload);
document.getElementById('pwCancel').addEventListener('click', closeModal);
document.getElementById('pwInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') tryDownload();
  if (e.key === 'Escape') closeModal();
});
modal.addEventListener('click', e => {
  if (e.target === modal) closeModal();
});

document.querySelectorAll('a.download-btn').forEach(btn => {
  if (!btn.querySelector('.dl-label')) {
    const label = document.createElement('span');
    label.className = 'dl-label';
    label.textContent = 'Download';
    btn.appendChild(label);
  }

  const href = (btn.href || '').toLowerCase();
  const isProtected = href.includes('.wav') || href.includes('.flac');
  const isFree = btn.dataset.free === 'true';

  if (isProtected && !isFree) {
    btn.classList.add('wav-protected');
    if (!btn.querySelector('.lock-icon')) {
      const lockSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      lockSvg.setAttribute('viewBox', '0 0 24 24');
      lockSvg.setAttribute('fill', 'none');
      lockSvg.setAttribute('stroke', 'currentColor');
      lockSvg.setAttribute('stroke-width', '2');
      lockSvg.setAttribute('stroke-linecap', 'round');
      lockSvg.setAttribute('stroke-linejoin', 'round');
      lockSvg.classList.add('lock-icon');
      lockSvg.innerHTML = '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>';
      btn.insertBefore(lockSvg, btn.firstChild);
    }
    btn.addEventListener('click', e => {
      e.preventDefault();
      const fileParam = new URL(btn.href).searchParams.get('file');
      const displayName = btn.getAttribute('download') || decodeURIComponent(fileParam.split('/').pop());
      openPasswordModal(fileParam, displayName);
    });
  } else {
    btn.addEventListener('click', e => {
      e.preventDefault();
      const fileParam = new URL(btn.href).searchParams.get('file');
      const filename = btn.getAttribute('download') || decodeURIComponent(fileParam.split('/').pop());
      triggerDownload(WORKER + '/download?file=' + encodeURIComponent(fileParam), filename);
    });
  }
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
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('target');
    setTimeout(() => el.classList.remove('target'), 2000);
  }
}
window.addEventListener('load', focusHashTrack);
window.addEventListener('hashchange', focusHashTrack);
