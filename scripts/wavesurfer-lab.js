// wavesurfer.js prototype glue for the /lab/wavesurfer/ track rows.
// Renders a waveform per row from pre-computed peaks (window.LAB_PEAKS), so no
// audio is downloaded until play. Playback streams lazily through wavesurfer's
// native media element (Range-supported, no CORS needed). Mirrors the existing
// player.js semantics: single active player, play/pause icon, time label,
// autoplay-next within the [data-autoplay-next] list.
import WaveSurfer from '/assets/wavesurfer.esm.js';

const PEAKS = window.LAB_PEAKS || {};
const root = getComputedStyle(document.documentElement);
const accent = (root.getPropertyValue('--accent') || '#b5532b').trim();
const waveColor = (root.getPropertyValue('--border') || '#d8cfc4').trim();

const PLAY = '<svg viewBox="0 0 16 16" fill="currentColor"><polygon points="4,2 14,8 4,14"/></svg>';
const PAUSE = '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="2" width="4" height="12"/><rect x="9" y="2" width="4" height="12"/></svg>';

const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const rows = Array.from(document.querySelectorAll('.ws-row'));
const instances = [];

rows.forEach((row, idx) => {
  const meta = PEAKS[row.dataset.trackid] || {};
  const btn = row.querySelector('.play-btn');
  const time = row.querySelector('.time-label.current');
  const durLabel = time.dataset.duration;

  const ws = WaveSurfer.create({
    container: row.querySelector('.ws-wave'),
    url: row.dataset.src,
    peaks: meta.p ? [meta.p] : undefined,
    duration: meta.d,
    height: 38,
    waveColor,
    progressColor: accent,
    cursorColor: accent,
    cursorWidth: 1,
    barWidth: 2,
    barGap: 1,
    barRadius: 2,
    normalize: true,
    dragToSeek: true,
  });

  btn.addEventListener('click', () => ws.playPause());

  ws.on('play', () => {
    instances.forEach((w, i) => { if (i !== idx) w.pause(); });
    row.classList.add('playing');
    btn.innerHTML = PAUSE;
  });
  ws.on('pause', () => {
    row.classList.remove('playing');
    btn.innerHTML = PLAY;
  });
  ws.on('timeupdate', (t) => { time.textContent = fmt(t); });
  ws.on('finish', () => {
    row.classList.remove('playing');
    btn.innerHTML = PLAY;
    time.textContent = durLabel;
    const next = rows[idx + 1];
    if (next) next.querySelector('.play-btn').click();
  });

  instances.push(ws);
});
