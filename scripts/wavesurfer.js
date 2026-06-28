// wavesurfer.js glue for waveform track rows (show pages and the /lab/ prototype).
// Renders a waveform per row from pre-computed peaks, so no audio is downloaded until
// play. Show pages fetch the peaks from a cacheable JSON file (window.WS_PEAKS_URL);
// the /lab/ prototype still inlines them (window.WS_PEAKS). Playback streams lazily
// through wavesurfer's native media element (Range-supported, no CORS needed). Mirrors
// the existing player.js semantics: single active player, play/pause icon, time label,
// autoplay-next within the [data-autoplay-next] list.
import WaveSurfer from '/assets/wavesurfer.esm.js';

const root = getComputedStyle(document.documentElement);
const accent = (root.getPropertyValue('--accent') || '#b5532b').trim();
const waveColor = (root.getPropertyValue('--border') || '#d8cfc4').trim();

const PLAY = '<svg viewBox="0 0 16 16" fill="currentColor"><polygon points="4,2 14,8 4,14"/></svg>';
const PAUSE = '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="2" width="4" height="12"/><rect x="9" y="2" width="4" height="12"/></svg>';

const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function build(PEAKS) {
  const rows = Array.from(document.querySelectorAll('.ws-row, .ws-track'));
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

    // Seek-on-tap, iOS-safe. With pre-computed peaks the audio is loaded lazily,
    // and iOS Safari refuses to load an <audio> element until play() runs inside a
    // user gesture. So tapping the waveform while paused moves the cursor but the
    // seek is dropped — there's no loaded media to seek (readyState 0). Starting
    // playback from the tapped position (within the tap gesture) makes the media
    // load and seek reliably; on desktop a click on the waveform then plays from
    // that point, matching how players like SoundCloud behave. While already
    // playing we leave wavesurfer's own seek alone.
    ws.on('interaction', (newTime) => {
      if (!ws.isPlaying()) {
        ws.play().then(() => ws.setTime(newTime)).catch(() => {});
      }
    });

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
      // Natural end fires 'finish' twice (reactive duration check + media 'ended'),
      // so advance with an idempotent play() — never the play/pause toggle, which a
      // second finish would use to pause the next track right after starting it.
      const next = instances[idx + 1];
      if (next) next.play();
    });

    instances.push(ws);
  });
}

// Inline peaks (lab prototype) take precedence; show pages fetch the JSON file. On a
// fetch failure, build with empty peaks so playback still works (waveforms then draw
// from the audio on play).
const inline = window.WS_PEAKS || window.LAB_PEAKS;
if (inline) {
  build(inline);
} else if (window.WS_PEAKS_URL) {
  fetch(window.WS_PEAKS_URL)
    .then((r) => r.json())
    .then(build)
    .catch(() => build({}));
} else {
  build({});
}
