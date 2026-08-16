// The sticky in-page mini-player's view layer (Phase 3 Stage 3a-canary of
// plans/player-consolidation/). One bar per document, fixed to the bottom,
// rendering whatever the controller is currently playing.
//
// A THIRD view module rather than an addition to either existing one, and
// deliberately so (the stage's architecture decision 1):
//   - player-views.js unconditionally imports WaveSurfer (player-views.js:13).
//     The mini-player ships on nearly every page, so a WaveSurfer asset problem
//     must not be able to break /contact/.
//   - playlist-views.js has the right SHAPE (its QueueView base) but also
//     carries itemFromCatalogRow and /playlist/'s queue-list UI. The ~25-line
//     base is duplicated below rather than imported, matching the Stage 2a
//     precedent of not reshaping a shipped primitive for one new surface.
// The only import here is player-controller.js — asserted by a test, not by
// eye, since the whole point is what this file does NOT depend on.
//
// This module is a VIEW only. It emits a close request and never decides what
// closing means: stopping playback, clearing persistence and unmounting are
// the coordinator's (Task 4/5) policy, per the recorded Close contract.
import { PLAY_ICON, PAUSE_ICON, LOADING_ICON, formatTime } from '/assets/player-controller.js';

const RANGE_MAX = 1000;

// Published on <html> so page chrome can make room for the bar. Consumers must
// read it with a fallback — `var(--miniplayer-height, 0px)` — because it is
// REMOVED, not zeroed, whenever the bar isn't showing.
export const HEIGHT_VAR = '--miniplayer-height';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Same monochrome set the other engines use (kept local — player-controller.js
// only exports the three icons every engine needs).
const PREV_ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="2" width="2" height="12"/><polygon points="14,2 14,14 4,8"/></svg>';
const NEXT_ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><polygon points="2,2 2,14 12,8"/><rect x="12" y="2" width="2" height="12"/></svg>';
const X_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

function trackMeta(item) {
  return [item.artist, item.venue, item.dateDisplay || item.date].filter(Boolean).join(' · ');
}

// ── shared base ────────────────────────────────────────────────────────────
// The real mount contract: PlaybackController.mount() calls exactly these three
// methods (player-controller.js's mount()/unmount()). Queue-scoped like
// /playlist/'s views and unlike player-views.js's PlayerView, which binds one
// fixed item at construction — this bar renders whatever the CONTROLLER'S
// current item is, which changes under it.
export class QueueView {
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts;
    this.controller = null;
    this._abort = new AbortController();
  }

  onAttach(controller) {
    this.controller = controller;
    this._wireEvents(this._abort.signal);
    this._render(controller.snapshot());
  }

  onDetach() {
    this._abort.abort();
    this.controller = null;
  }

  onControllerUpdate(snapshot) { this._render(snapshot); }

  // Subclasses override.
  _wireEvents(_signal) {}
  _render(_snapshot) {}
}

// ── the bar ────────────────────────────────────────────────────────────────
export class MiniPlayerView extends QueueView {
  constructor(root, opts = {}) {
    super(root, opts);
    // Close is a REQUEST, not an action — see the header note.
    this.onClose = typeof opts.onClose === 'function' ? opts.onClose : () => {};
    this._currentId = null;
    this._seeking = false;
    this._lastQueueRevision = -1;
    this._lastControlsKey = null;
    this._errorKind = null;
    this._errorEl = null;
    this._ro = null;
    this._publishedHeight = null;
  }

  _wireEvents(signal) {
    this.root.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('.mp-btn');
      if (!b) return;
      const act = b.dataset.act;
      // Close is answered even with no controller attached — it's the one
      // control that must never appear dead.
      if (act === 'close') { this.onClose(); return; }
      if (!this.controller) return;
      if (act === 'prev') { this.controller.prev(); return; }
      if (act === 'next') { this.controller.next(); return; }
      // Play/pause, Resume (blocked autoplay) and Retry (a real failure) are
      // one control: toggle() already routes an 'error' state to play() rather
      // than toggling (player-controller.js's toggle()), so the button's LABEL
      // is what changes, never its behavior.
      this.controller.toggle();
    }, { signal });

    // Native range: dragging, clicking, and arrow keys all fire 'input'
    // uniformly, so one handler covers mouse/touch/keyboard. Delegated because
    // the range element itself is recreated on every currentItem.id change.
    this.root.addEventListener('mousedown', (e) => { if (this._isRange(e)) this._seeking = true; }, { signal });
    this.root.addEventListener('touchstart', (e) => { if (this._isRange(e)) this._seeking = true; }, { signal });
    this.root.addEventListener('change', (e) => { if (this._isRange(e)) this._seeking = false; }, { signal });
    this.root.addEventListener('input', (e) => {
      const range = this._isRange(e);
      if (!range || !this.controller) return;
      const audio = this.controller.audioElement;
      const pct = (range.value / RANGE_MAX) * 100;
      this._paintRange(pct);
      if (isFinite(audio.duration)) this.controller.seek((pct / 100) * audio.duration);
    }, { signal });
  }

  _isRange(e) {
    return e.target && e.target.closest ? e.target.closest('.progress-range') : null;
  }

  onDetach() {
    this._teardownHeight();
    super.onDetach();
  }

  // Structural rebuild ONLY on a currentItem.id change — never on `state`,
  // which changes on every loading->playing->paused transition during ordinary
  // playback and would replace the play button's DOM node, and its keyboard
  // focus, constantly (the PlaylistNowPlayingView lesson, playlist-views.js).
  // Everything else patches existing nodes.
  _render(snapshot) {
    const item = snapshot.currentItem;
    if (!item) { this._hide(); return; }
    if (item.id !== this._currentId) {
      this._buildStructure(item);
      this._currentId = item.id;
      // A drag/press-and-hold in progress on the OLD range element (mousedown
      // fired, 'change' has not) would leave this stuck true forever once that
      // element is torn down, silently freezing the new range (Phase 2
      // post-deploy finding #4). The track changed out from under the seek
      // anyway, so there is nothing to preserve.
      this._seeking = false;
      // Both caches describe nodes that no longer exist.
      this._lastQueueRevision = -1;
      this._lastControlsKey = null;
      this._errorKind = null;
    }
    this._patch(snapshot);
  }

  _hide() {
    this.root.hidden = true;
    this._clearHeight();
    if (this._currentId === null) return;   // nothing was ever built
    this.root.innerHTML = '';
    this._currentId = null;
    this._playBtn = this._prevBtn = this._nextBtn = this._range = this._timeCur = null;
    this._errorEl = null;
    this._errorKind = null;
    this._seeking = false;
    this._lastQueueRevision = -1;
    this._lastControlsKey = null;
  }

  _buildStructure(item) {
    this.root.hidden = false;
    // pageUrl defaults to '' in normalizeItem(); an <a href=""> would reload
    // the current page, so the title is only a link when there is a real one.
    const title = item.pageUrl
      ? '<a class="mp-title" href="' + esc(item.pageUrl) + '">' + esc(item.title) + '</a>'
      : '<span class="mp-title">' + esc(item.title) + '</span>';
    this.root.innerHTML =
      '<button type="button" class="mp-btn mp-play" data-act="play" aria-label="Play">' + PLAY_ICON + '</button>'
      + '<div class="mp-info">' + title
      + '<span class="mp-meta">' + esc(trackMeta(item)) + '</span></div>'
      + '<div class="mp-progress"><span class="mp-time mp-time-current">0:00</span>'
      + '<input type="range" class="progress-range" min="0" max="' + RANGE_MAX + '" value="0" step="1" '
      + 'aria-label="Seek ' + esc(item.title) + '" aria-valuetext="0:00 of ' + formatTime(item.durationSec) + '">'
      + '<span class="mp-time mp-time-total">' + formatTime(item.durationSec) + '</span></div>'
      + '<div class="mp-controls">'
      + '<button type="button" class="mp-btn mp-prev" data-act="prev" aria-label="Previous track">' + PREV_ICON + '</button>'
      + '<button type="button" class="mp-btn mp-next" data-act="next" aria-label="Next track">' + NEXT_ICON + '</button>'
      + '<button type="button" class="mp-btn mp-close" data-act="close" aria-label="Close player">' + X_SVG + '</button>'
      + '</div>';
    this._playBtn = this.root.querySelector('.mp-play');
    this._prevBtn = this.root.querySelector('.mp-prev');
    this._nextBtn = this.root.querySelector('.mp-next');
    this._range = this.root.querySelector('.progress-range');
    this._timeCur = this.root.querySelector('.mp-time-current');
    this._errorEl = null;
    this._observeHeight();
  }

  _patch(snapshot) {
    const item = snapshot.currentItem;
    const state = snapshot.state;
    const audio = this.controller ? this.controller.audioElement : null;
    const failure = this._failureKind(snapshot, item);

    if (this._playBtn) {
      const playing = state === 'playing' || state === 'loading';
      const verb = failure === 'blocked' ? 'Resume'
        : failure === 'failed' ? 'Retry'
        : playing ? 'Pause' : 'Play';
      // The icon SVG is only rewritten when it would actually differ: _patch()
      // runs on every timeupdate (~4/sec), and the label/icon pair changes a
      // handful of times per track.
      const key = verb + '|' + state;
      if (key !== this._lastControlsKey) {
        this._lastControlsKey = key;
        this._playBtn.innerHTML = state === 'loading' ? LOADING_ICON : (playing ? PAUSE_ICON : PLAY_ICON);
        this._playBtn.setAttribute('aria-label', verb + ' ' + item.title);
      }
    }

    // Gated on queueRevision, not recomputed per tick: removeAt()/reorder()
    // mutate the queue array in place, so the revision is the only O(1) signal
    // that catches every membership change (playlist-views.js's note).
    if (snapshot.queueRevision !== this._lastQueueRevision) {
      this._lastQueueRevision = snapshot.queueRevision;
      // A singleton queue — the Hero card's playSingleton(), a song-page
      // occurrence — has nothing to step to in either direction.
      const stepping = snapshot.queue.length > 1;
      if (this._prevBtn) this._prevBtn.hidden = !stepping;
      if (this._nextBtn) this._nextBtn.hidden = !stepping;
    }

    const t = audio ? audio.currentTime : 0;
    const dur = audio && isFinite(audio.duration) ? audio.duration : (item.durationSec || 0);
    if (!this._seeking && this._range) {
      const pct = dur ? (t / dur) * 100 : 0;
      this._range.value = Math.round(pct * RANGE_MAX / 100);
      this._paintRange(pct);
      this._range.setAttribute('aria-valuetext', formatTime(t) + ' of ' + formatTime(dur));
    }
    if (this._timeCur) this._timeCur.textContent = formatTime(t);
    this._setError(failure);
  }

  // Which failure the bar is looking at, or null.
  //
  // Only a blocked autoplay (NotAllowedError) offers "Resume"; a network or
  // decode failure is "Retry" (recorded restored-play rule, task 0.6). The
  // error is trusted only while lastPlayErrorItemId still matches the current
  // item: lastPlayError is cleared at construction and at the start of a play
  // attempt, never on a queue change (player-controller.js), so a stale
  // NotAllowedError would otherwise render "Resume" against a different track.
  // An 'error' state whose error can't be attributed falls back to the more
  // conservative "Retry" rather than promising a resume that won't happen.
  _failureKind(snapshot, item) {
    if (snapshot.state !== 'error') return null;
    const err = snapshot.lastPlayError;
    if (!err || !item || snapshot.lastPlayErrorItemId !== item.id) return 'failed';
    return err.name === 'NotAllowedError' ? 'blocked' : 'failed';
  }

  _paintRange(pct) {
    if (!this._range) return;
    // The --player-* aliases, not either design system's own token names: this
    // bar renders on home.css pages and site.css pages alike (Task 1 added the
    // aliases home.css had never defined).
    this._range.style.background =
      'linear-gradient(to right, var(--player-accent) ' + pct + '%, var(--player-track) ' + pct + '%)';
  }

  // A hard failure is otherwise invisible — the legacy engines left a row
  // showing a spinner forever. role="status" announces it once to assistive
  // tech without narrating every timeupdate.
  _setError(kind) {
    if (kind === this._errorKind) return;
    this._errorKind = kind;
    if (!kind) {
      if (this._errorEl) { this._errorEl.remove(); this._errorEl = null; }
      return;
    }
    if (!this._errorEl) {
      const el = document.createElement('span');
      el.className = 'player-error-msg';
      el.setAttribute('role', 'status');
      this.root.appendChild(el);
      this._errorEl = el;
    }
    this._errorEl.textContent = kind === 'blocked'
      ? 'Paused by your browser — tap Resume'
      : 'Playback failed — tap to retry';
  }

  // ── published height ──
  // Republished on every resize rather than set once on show/hide: the bar
  // wraps at 320px, and font loading, orientation change, zoom, and a longer
  // track title all change its height after first paint (recorded emission
  // policy 0.8). The measurement is the border-box height, which already
  // includes the env(safe-area-inset-bottom) the bar carries as its own bottom
  // padding — consumers ADD this variable to their existing spacing.
  _observeHeight() {
    if (!this._ro && typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._publishHeight());
      this._ro.observe(this.root);
    }
    // Also published directly: a ResizeObserver's first callback is async, and
    // browsers without one get the one-shot value at least.
    this._publishHeight();
  }

  _publishHeight() {
    const rect = this.root.getBoundingClientRect ? this.root.getBoundingClientRect() : null;
    const h = this.root.hidden || !rect ? 0 : (rect.height || 0);
    if (h === this._publishedHeight) return;
    this._publishedHeight = h;
    const style = typeof document !== 'undefined' && document.documentElement
      ? document.documentElement.style : null;
    if (!style || !style.setProperty) return;
    // Removed rather than zeroed when there's nothing to make room for, so a
    // page that never mounts a bar and one whose bar is hidden behave
    // identically — hence the required var(--miniplayer-height, 0px) fallback.
    if (h > 0) style.setProperty(HEIGHT_VAR, h + 'px');
    else style.removeProperty(HEIGHT_VAR);
  }

  _clearHeight() {
    this._publishedHeight = 0;
    const style = typeof document !== 'undefined' && document.documentElement
      ? document.documentElement.style : null;
    if (style && style.removeProperty) style.removeProperty(HEIGHT_VAR);
  }

  _teardownHeight() {
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    this._clearHeight();
  }
}
