// Views for the shared PlaybackController (see player-controller.js and
// plans/player-consolidation/). A view renders controller state into one
// piece of existing generated markup and translates user input back into
// controller commands. Views never own an <audio> element or an audio graph —
// there is exactly one of each per document, inside the controller.
//
// Two densities exist today:
//   CompactPlayerView — a show page's track row (.track-row)
//   HeroPlayerView    — a "Full Recording" / alternate-transfer card
// They share almost everything (play button, time label, seek surface); the
// differences are which progress surface the markup provides and, for the
// hero, queue-dependent controls.
import WaveSurfer from '/assets/wavesurfer.esm.js';
import { PLAY_ICON, PAUSE_ICON, LOADING_ICON, formatTime } from '/assets/player-controller.js';

const RANGE_MAX = 1000;
const WAVE_HEIGHT = 38;

// Read once per document. These are namespaced aliases the two token systems
// (site.css / home.css) both define, so the player never depends on either
// system's own variable names — see the CSS-token row in the plan's gap table.
const rootStyle = getComputedStyle(document.documentElement);
const token = (name, fallback) => (rootStyle.getPropertyValue(name) || fallback).trim();
const ACCENT = token('--player-accent', '#2c4a3e');
const TRACK = token('--player-track', '#dedad3');

// ── item construction from generated markup ────────────────────────────────
// Show pages serialize the whole playable item into one data-item JSON
// attribute at build time, so a page with many rows still costs zero network
// round trips to know what it can play.
export function itemFromRowElement(el) {
  if (!el || !el.dataset.item) return null;
  try {
    return JSON.parse(el.dataset.item);
  } catch (e) {
    return null;   // malformed markup shouldn't take the whole page's player down
  }
}

// ── shared base ────────────────────────────────────────────────────────────
export class PlayerView {
  constructor(root, item, { density = 'compact', peaks = null } = {}) {
    this.root = root;
    this.item = item;
    this.density = density;
    this.peaks = peaks;
    this.controller = null;

    this.btn = root.querySelector('.play-btn');
    this.range = root.querySelector('.progress-range');
    this.waveContainer = root.querySelector('.ws-wave');
    this.timeEl = root.querySelector('.time-label.current');
    // Compact rows show "elapsed / total" from one label; larger players carry
    // the total in a second label and show only elapsed in the first.
    this.totalLabel = this.timeEl ? (this.timeEl.dataset.duration || '') : '';

    this._ws = null;
    this._seeking = false;
    this._wasActive = false;
    this._errorEl = null;
    this._abort = new AbortController();
  }

  // ── lifecycle ──
  onAttach(controller) {
    this.controller = controller;
    const signal = this._abort.signal;

    if (this.btn) {
      this.btn.addEventListener('click', () => this._onPlayClick(), { signal });
    }

    if (this.range) {
      // A native range fires 'input' for drag, click, and arrow keys alike, so
      // one handler covers mouse, touch, and keyboard seeking.
      this.range.addEventListener('mousedown', () => { this._seeking = true; }, { signal });
      this.range.addEventListener('touchstart', () => { this._seeking = true; }, { signal });
      this.range.addEventListener('change', () => { this._seeking = false; }, { signal });
      this.range.addEventListener('input', () => this._onRangeInput(), { signal });
    }

    if (this.waveContainer) {
      // Tapping an INACTIVE row's waveform starts that row at the tapped
      // position — legacy behavior, since every row used to own a live
      // WaveSurfer with dragToSeek. Once a row upgrades, WaveSurfer's own
      // 'interaction' handler takes over and this bails.
      this.waveContainer.addEventListener('click', (e) => this._onInertWaveClick(e), { signal });
      if (this.peaks) this._drawInertWave();
    }

    this._render(controller.snapshot());
  }

  onDetach() {
    this._abort.abort();
    this._teardownWave();
    this.controller = null;
  }

  onControllerUpdate(snapshot) { this._render(snapshot); }

  // Peaks arrive after mount: the page bootstrap has to mount synchronously
  // (before DOMContentLoaded, so the legacy engines stay dormant) while the
  // peaks JSON is a fetch. A view mounted peak-less therefore renders no
  // waveform until this lands — then draws, or upgrades on the spot if it is
  // already the active row.
  setPeaks(peaks) {
    this.peaks = peaks;
    if (!this.waveContainer || !this.controller) return;
    if (this._isActive(this.controller)) this._upgradeWave();
    else this._drawInertWave();
  }

  // Re-draws the inert canvas at the current container width. WaveSurfer
  // handles its own resizing, so an upgraded row is left alone.
  redrawWave() {
    if (this._ws || !this.waveContainer || !this.peaks) return;
    this._drawInertWave();
  }

  // ── input ──
  _onPlayClick() {
    const c = this.controller;
    if (!c) return;
    if (this._isActive(c)) { c.toggle(); return; }
    this._start();
  }

  // Subclasses decide what queue this view's item belongs to — see the
  // queue-origin contract in the plan. Never play(item): after a singleton
  // the item may not be queued at all, and play() would correctly no-op.
  _start() { this.controller.playSingleton(this.item); }

  _onRangeInput() {
    const c = this.controller;
    if (!c) return;
    const pct = this.range.value / RANGE_MAX;
    this._paintRange(pct * 100);
    if (!this._isActive(c)) return;   // seeking an inactive row shouldn't hijack playback
    const dur = c.audioElement.duration;
    if (isFinite(dur)) c.seek(pct * dur);
  }

  _onInertWaveClick(e) {
    const c = this.controller;
    if (!c || this._ws) return;      // upgraded rows are WaveSurfer's to handle
    const rect = this.waveContainer.getBoundingClientRect
      ? this.waveContainer.getBoundingClientRect() : null;
    if (!rect || !rect.width) return;
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    // Start this row (re-asserting its queue), then land on the tapped spot —
    // the same play-then-seek shape the upgraded path uses, and for the same
    // iOS reason: there is nothing to seek until the media has actually loaded.
    Promise.resolve(this._start()).then(() => this._seekFraction(fraction)).catch(() => {});
  }

  // Seeks by proportion once a duration is actually known. Called right after
  // starting playback, where duration is usually still NaN for a beat.
  _seekFraction(fraction) {
    const c = this.controller;
    if (!c) return;
    const audio = c.audioElement;
    if (isFinite(audio.duration) && audio.duration > 0) { c.seek(fraction * audio.duration); return; }
    audio.addEventListener('loadedmetadata', () => {
      if (this.controller && this._isActive(this.controller) && isFinite(audio.duration)) {
        this.controller.seek(fraction * audio.duration);
      }
    }, { once: true, signal: this._abort.signal });
  }

  _isActive(cOrSnapshot) {
    const current = cOrSnapshot && cOrSnapshot.currentItem;
    return !!(current && this.item && current.id === this.item.id);
  }

  // ── rendering ──
  _render(snapshot) {
    if (!snapshot) return;
    const active = this._isActive(snapshot);
    // A row that is not active now and was never active before gets zero DOM
    // writes here — this runs on every controller _notify(), i.e. every
    // timeupdate tick, for every mounted view, so a page of many rows must
    // not churn on every tick (plan.md's explicit claim). A row transitioning
    // FROM active TO inactive still falls through for exactly one final
    // render (this._wasActive is still true on that call) so it can reset to
    // idle below.
    if (!active && !this._wasActive) { this._wasActive = active; return; }
    const state = active ? snapshot.state : 'idle';
    const audio = this.controller ? this.controller.audioElement : null;

    this.root.classList.toggle('playing', active && state === 'playing');
    this.root.classList.toggle('player-error', active && state === 'error');

    if (this.btn) {
      const showLoading = active && state === 'loading';
      const playing = active && (state === 'playing' || state === 'loading');
      this._setPlayState(playing, showLoading ? LOADING_ICON : (playing ? PAUSE_ICON : PLAY_ICON),
        active && state === 'error');
    }

    if (active) {
      this._setError(state === 'error');
      this._upgradeWave();
      const t = audio ? audio.currentTime : 0;
      const dur = audio && isFinite(audio.duration) ? audio.duration : (this.item.durationSec || 0);
      if (!this._seeking) this._setProgress(dur ? t / dur : 0);
      this._setTime(t);
    } else if (this._wasActive) {
      // Reset exactly once, on the active -> inactive transition. Keyed on
      // whether this view WAS active rather than whether it has ever rendered:
      // the latter is true for every inactive row after first mount, which
      // would redraw every row's canvas on every timeupdate tick.
      this._setError(false);
      this._teardownWave();
      this._setProgress(0);
      this._setTime(0);
    }

    this._wasActive = active;
  }

  // Mirrors the legacy setPlayState: the accessible name carries the track so a
  // screen reader hears "Pause <song, artist, date>", not a bare "Pause"
  // repeated identically on every row. On a failed item the verb becomes
  // "Retry", so the control says what pressing it will actually do.
  _setPlayState(playing, iconHtml, errored = false) {
    this.btn.innerHTML = iconHtml;
    const label = this.btn.dataset.playLabel;
    const verb = errored ? 'Retry' : (playing ? 'Pause' : 'Play');
    this.btn.setAttribute('aria-label', label ? `${verb} ${label}` : verb);
  }

  // A hard failure (404/CORS/decode) is otherwise invisible — the legacy
  // engines left the row showing a spinner forever. role="status" announces it
  // once to assistive tech without narrating every timeupdate.
  _setError(on) {
    if (on && !this._errorEl) {
      const el = document.createElement('span');
      el.className = 'player-error-msg';
      el.setAttribute('role', 'status');
      el.textContent = 'Playback failed — tap to retry';
      this.root.appendChild(el);
      this._errorEl = el;
    } else if (!on && this._errorEl) {
      this._errorEl.remove();
      this._errorEl = null;
    }
  }

  _setTime(seconds) {
    if (!this.timeEl) return;
    const elapsed = formatTime(seconds);
    this.timeEl.textContent = this.totalLabel ? `${elapsed} / ${this.totalLabel}` : elapsed;
    if (this.range) {
      this.range.setAttribute('aria-valuetext',
        this.totalLabel ? `${elapsed} of ${this.totalLabel}` : elapsed);
    }
  }

  _setProgress(fraction) {
    const pct = Math.max(0, Math.min(1, fraction || 0)) * 100;
    if (this.range) {
      this.range.value = Math.round(pct * RANGE_MAX / 100);
      this._paintRange(pct);
    }
    if (this._ws) return;            // an upgraded waveform paints its own progress
    if (this.waveContainer && this.peaks) this._drawInertWave(pct / 100);
  }

  _paintRange(pct) {
    if (!this.range) return;
    this.range.style.background =
      `linear-gradient(to right, ${ACCENT} ${pct}%, ${TRACK} ${pct}%)`;
  }

  // ── waveform ──
  // Inactive rows get a cheap, inert canvas drawn straight from precomputed
  // peaks. Only the active row is upgraded to a real WaveSurfer instance
  // wrapping the controller's single <audio> element — the legacy engine
  // instead built one WaveSurfer (and one media element) for every row on
  // page load.
  _drawInertWave(progress = 0) {
    if (!this.waveContainer || !this.peaks || !this.peaks.p) return;
    const peaks = this.peaks.p;
    const width = this.waveContainer.clientWidth;
    if (!width) return;              // not laid out yet (e.g. inside a closed <details>)

    const dpr = window.devicePixelRatio || 1;
    let canvas = this._canvas;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.width = '100%';
      canvas.style.height = WAVE_HEIGHT + 'px';
      canvas.style.display = 'block';
      this.waveContainer.appendChild(canvas);
      this._canvas = canvas;
    }
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(WAVE_HEIGHT * dpr);

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, WAVE_HEIGHT);

    // Match the legacy WaveSurfer options: barWidth 2, barGap 1, normalize.
    const barWidth = 2, barGap = 1, step = barWidth + barGap;
    const bars = Math.max(1, Math.floor(width / step));
    const peak = peaks.reduce((m, v) => (v > m ? v : m), 0) || 1;   // normalize: true
    const mid = WAVE_HEIGHT / 2;
    const playedX = width * progress;

    for (let i = 0; i < bars; i++) {
      const v = peaks[Math.floor(i / bars * peaks.length)] || 0;
      const h = Math.max(1, (v / peak) * WAVE_HEIGHT);
      const x = i * step;
      ctx.fillStyle = x + barWidth <= playedX ? ACCENT : TRACK;
      const y = mid - h / 2;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, h, 2);
        ctx.fill();
      } else {
        ctx.fillRect(x, y, barWidth, h);
      }
    }
  }

  _upgradeWave() {
    if (this._ws || !this.waveContainer || !this.peaks || !this.controller) return;
    if (this._canvas) { this._canvas.remove(); this._canvas = null; }

    // `media` wraps the controller's element rather than creating a second
    // one; the vendored build sets isExternalMedia and correspondingly leaves
    // that element alone on destroy(). No `url` is passed — the controller has
    // already assigned src by the time this runs (see _playIndex's ordering
    // note), so WaveSurfer adopts the existing source instead of clearing it.
    this._ws = WaveSurfer.create({
      container: this.waveContainer,
      media: this.controller.audioElement,
      peaks: this.peaks.p ? [this.peaks.p] : undefined,
      duration: this.peaks.d,
      height: WAVE_HEIGHT,
      waveColor: TRACK,
      progressColor: ACCENT,
      cursorColor: ACCENT,
      cursorWidth: 1,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      dragToSeek: true,
    });

    // Seek-on-tap, iOS-safe. With precomputed peaks the audio loads lazily, and
    // iOS Safari won't load a media element outside a user gesture — so a tap
    // while paused has nothing to seek (readyState 0). Starting playback from
    // the tapped position within the same gesture makes it load and seek
    // reliably; on desktop this matches how players like SoundCloud behave.
    this._ws.on('interaction', (newTime) => {
      const c = this.controller;
      if (!c) return;
      if (c.state === 'playing') { c.seek(newTime); return; }
      Promise.resolve(c.play()).then(() => c.seek(newTime)).catch(() => {});
    });
  }

  _teardownWave() {
    if (this._ws) {
      this._ws.destroy();          // leaves the external media element alone
      this._ws = null;
      if (this.waveContainer) this.waveContainer.innerHTML = '';
    }
    if (this._canvas) { this._canvas.remove(); this._canvas = null; }
    if (this.waveContainer && this.peaks) this._drawInertWave();
  }
}

// ── compact: a show page's track row ───────────────────────────────────────
export class CompactPlayerView extends PlayerView {
  constructor(root, item, opts = {}) {
    super(root, item, { ...opts, density: 'compact' });
    // The full ordered track list this row belongs to, supplied by the page
    // bootstrap. Clicking any row re-asserts this whole queue, which is both
    // correct for "click a track on a show page" and what lets playback return
    // to the track list after a hero card collapsed the queue to a singleton.
    this.queueItems = opts.queueItems || [item];
    this.queueIndex = opts.queueIndex || 0;
  }

  _start() {
    this.controller.setQueue(this.queueItems, { startIndex: this.queueIndex, autoplay: true });
  }

  _render(snapshot) {
    super._render(snapshot);
    // A deep-linked row stays highlighted until some other track actually
    // starts playing.
    if (snapshot && this._isActive(snapshot) && snapshot.state === 'playing') {
      document.querySelectorAll('.track-row.target').forEach(r => {
        if (r !== this.root) r.classList.remove('target');
      });
    }
  }
}

// ── hero: a "Full Recording" / alternate-transfer card ─────────────────────
export class HeroPlayerView extends PlayerView {
  constructor(root, item, opts = {}) {
    super(root, item, { ...opts, density: 'hero' });
  }

  // A standalone whole-show recording is its own queue of one, so playing it
  // replaces whatever was queued.
  //
  // No prev/next controls exist here in Phase 1, deliberately: recording_card()
  // emits none, and they'd have nothing to step through anyway — an active hero
  // always got that way via playSingleton(), so its queue length is always 1.
  // Any future non-singleton hero would need to gate such controls on BOTH
  // "this hero is the active item" and queue.length > 1; keying on queue length
  // alone would show them whenever an unrelated track queue happened to be
  // playing.
  _start() { return this.controller.playSingleton(this.item); }
}
