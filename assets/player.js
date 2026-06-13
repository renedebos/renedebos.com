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

  audio.addEventListener('ended', () => {
    btn.innerHTML = playIcon;
    fill.style.width = '0%';
    currentEl.textContent = '0:00';
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
