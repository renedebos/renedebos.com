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

// Mirrors player.js's setPlayState — the accessible name includes the track
// (song/artist/date) from data-play-label, so a screen reader doesn't hear an
// undifferentiated "Play" on every single row.
function setPlayState(btn, playing, iconHtml) {
  btn.innerHTML = iconHtml;
  const label = btn.dataset.playLabel;
  btn.setAttribute('aria-label', label ? `${playing ? 'Pause' : 'Play'} ${label}` : (playing ? 'Pause' : 'Play'));
}

function build(PEAKS) {
  const rows = Array.from(document.querySelectorAll('.ws-row, .ws-track'));
  const instances = [];

  // Deep-link to a track (e.g. the homepage's "Play random tape" or a song
  // page's "open on show page"). Resolved up front so the matching row's
  // WaveSurfer instance can gate autoplay on its own 'ready' event below —
  // calling play() right after creation is too early (media hasn't loaded),
  // so it silently no-ops despite the returned promise resolving.
  let hashEl;
  try { hashEl = location.hash && document.querySelector(location.hash); } catch { hashEl = null; }
  const hashIdx = hashEl ? rows.indexOf(hashEl) : -1;
  const autoplayHash = hashIdx !== -1 && new URLSearchParams(location.search).get('autoplay') === '1';

  rows.forEach((row, idx) => {
    const meta = PEAKS[row.dataset.trackid] || {};
    const btn = row.querySelector('.play-btn');
    const time = row.querySelector('.time-label.current');
    const durLabel = time.dataset.duration;
    const setTime = (seconds) => {
      const elapsed = fmt(seconds);
      time.textContent = durLabel ? `${elapsed} / ${durLabel}` : elapsed;
    };

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

    if (idx === hashIdx) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.add('target');
      if (autoplayHash) ws.once('ready', () => ws.play().catch(() => {}));
    }

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
      setPlayState(btn, true, PAUSE);
      // Pause every OTHER player too — the same page's Full Recording
      // custom player, and any other tab/window (see player.js's
      // coordination block; player.js always loads before this module).
      if (window.claimPlayback) window.claimPlayback(ws);
      // A deep-linked track (see the hash handling above) stays highlighted
      // until some other track actually starts playing.
      rows.forEach(r => { if (r !== row) r.classList.remove('target'); });
    });
    ws.on('pause', () => {
      row.classList.remove('playing');
      setPlayState(btn, false, PLAY);
    });
    ws.on('timeupdate', setTime);
    ws.on('finish', () => {
      row.classList.remove('playing');
      setPlayState(btn, false, PLAY);
      setTime(0);
      // Natural end fires 'finish' twice (reactive duration check + media 'ended'),
      // so advance with an idempotent play() — never the play/pause toggle, which a
      // second finish would use to pause the next track right after starting it.
      // iOS Safari can refuse to load+play a not-yet-started <audio> element outside
      // a direct user gesture (same constraint as the seek handler above); catching
      // the rejection leaves the next row in its normal paused state so a tap on its
      // play button still works, instead of an unhandled rejection and a track that
      // silently never starts.
      const next = instances[idx + 1];
      if (next) next.play().catch(() => {});
    });

    if (window.onExternalClaim) window.onExternalClaim(() => { if (ws.isPlaying()) ws.pause(); }, ws);

    instances.push(ws);
  });
}

// Inline peaks (lab prototype) take precedence; show pages fetch the JSON file. On a
// fetch failure, build with empty peaks so playback still works (waveforms then draw
// from the audio on play).
function start() {
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
}

// Engine selection — the same defer-and-check contract player.js uses (see the
// block there for the full rationale). On a page that asked for the shared
// controller, this module holds off until DOMContentLoaded and then builds only
// if player-boot.js never claimed the page. That's what makes a broken module
// or a 404'd asset fall back to a working waveform player rather than to a page
// with no track players at all — these rows are invisible to player.js, which
// only knows .custom-player.
// DOMContentLoaded is the right barrier and readyState is NOT a usable
// shortcut here: readyState is already 'interactive' while deferred and module
// scripts run, so a "we're past loading, just go" branch would fire this module
// BEFORE player-boot.js (a later module) had any chance to claim the page —
// double-initializing exactly what the flag exists to prevent. The guarantee
// this actually relies on (per the HTML Standard's parsing/script-processing
// model, confirmed in the Step 4 review): every emitted <script> here is a
// parser-inserted module, executed in document order, and DOMContentLoaded is
// only queued after that whole ordered list has run — so registering this
// listener during that same synchronous parse job is always in time. That's
// narrower than "any script placement" (a script inserted dynamically after
// parsing, or added with different scheduling, isn't covered by this
// argument) — it holds because build.py emits these as ordinary parser-
// inserted <script> tags, not because DOMContentLoaded is unconditionally late.
if (window.PLAYER_ENGINE === 'controller') {
  document.addEventListener('DOMContentLoaded', () => {
    if (!window.PLAYER_ENGINE_MOUNTED) start();
  });
} else {
  start();
}
