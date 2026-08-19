// Queue-scoped views for /playlist/'s shared-controller engine (Phase 2 of
// plans/player-consolidation/, Stage 2a). Deliberately a SEPARATE module from
// player-views.js: that file unconditionally imports WaveSurfer
// (player-views.js:13), which /playlist/ has no use for and must never
// depend on — a WaveSurfer asset problem must not be able to break this page.
//
// PlayerView (player-views.js) is the wrong base for this page: it binds
// `this.item` at construction and compares by id to decide activity, which
// fits a show page's one-row-per-item markup but not /playlist/, where both
// #pl-now and #pl-queue render whatever the CONTROLLER'S QUEUE currently is,
// not one fixed item. QueueView below implements the real 3-method mount
// contract PlaybackController.mount() actually calls
// (onAttach/onDetach/onControllerUpdate — see player-controller.js's mount())
// and nothing else.
import { PLAY_ICON, PAUSE_ICON, LOADING_ICON, formatTime } from '/assets/player-controller.js';

const RANGE_MAX = 1000;

export const ARTIST_NAMES = {
  jerry: 'Jerry Hannan', sean: 'Sean Hannan', mad: 'Mad Hannans', seanjerry: 'Sean & Jerry Hannan',
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Same monochrome set playlist.js already uses (kept local — player-controller.js
// only exports PLAY/PAUSE/LOADING, the three icons every engine needs; prev/
// next/shuffle are /playlist/-specific).
const PREV_ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="2" width="2" height="12"/><polygon points="14,2 14,14 4,8"/></svg>';
const NEXT_ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><polygon points="2,2 2,14 12,8"/><rect x="12" y="2" width="2" height="12"/></svg>';
const SHUFFLE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/>'
  + '<line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/>'
  + '<line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>';
const X_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const LINK_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" '
  + 'stroke-linejoin="round"><path d="M6.5 3H3v10h10V9.5"/><path d="M9.5 3H13v3.5"/><path d="M13 3L7 9"/></svg>';

// ── item construction from the catalog (tracks.json) ───────────────────────
// The counterpart to player-views.js's itemFromRowElement(), but from a
// fetched catalog row instead of build-time markup. Deliberately NOT widened
// with tracks.json's display-only fields (song, tags, sourceType, songwriter,
// flac_size_mb, num, performer, procVer, file/ver) — the item schema stays
// exactly what normalizeItem() already validates, and every view that needs
// one of those extras looks it up via a `catalogById` map instead (see
// QueueView subclasses below). Filtering/dedupe/hash-resolution/ZIP-manifest
// all stay in catalog space in playlist-boot.js for the same reason.
export function itemFromCatalogRow(row) {
  const origin = (typeof window !== 'undefined' && window.WORKER_ORIGIN) || '';
  return {
    id: row.id,
    kind: 'track',
    // Byte-for-byte the same string playlist.js's streamUrl() builds
    // (playlist.js:81-84) — a diverging cache-buster would silently double
    // R2 egress and defeat the `ver` cache key.
    streamUrl: origin + '/stream?file=' + encodeURIComponent(row.file) + (row.ver ? '&v=' + row.ver : ''),
    // The -14 loud render, built the same way from the catalog's own `loud`
    // key — null when that track has no variant, which is what makes
    // srcForItem() fall back to the archive instead of guessing a key.
    loudUrl: row.loud
      ? origin + '/stream?file=' + encodeURIComponent(row.loud) + (row.loudVer ? '&v=' + row.loudVer : '')
      : null,
    title: row.title,
    artist: ARTIST_NAMES[row.artist] || row.artist,
    venue: row.venue,
    date: row.showDate,
    dateDisplay: row.showDate,
    durationSec: row.durationSec,
    durationLabel: null,
    // No waveforms on /playlist/ — peaks are per-show files; a cross-show
    // queue would need N fetches for a UI that has never had waveforms.
    peaksKey: null,
    pageUrl: row.url,
    playLabel: row.title,
    downloads: { flac: row.flac || null },
    dropouts: false,
  };
}

function trackMeta(item) {
  return [item.artist, item.venue, item.dateDisplay || 'unknown date'].filter(Boolean).join(' · ');
}

function totalStr(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? h + 'h ' + m + 'm' : m + ' min';
}

// ── shared base ──────────────────────────────────────────────────────────
// The real mount contract: PlaybackController.mount() calls exactly these
// three methods (player-controller.js's mount()/unmount()).
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

// ── #pl-queue ────────────────────────────────────────────────────────────
export class PlaylistQueueView extends QueueView {
  constructor(root, opts = {}) {
    super(root, opts);
    this.catalogById = opts.catalogById || new Map();
    // A boot-level accessor (not a snapshot) — queue-length mode ("songs" /
    // "minutes" / "endless") is page state, not controller state, but the
    // header line's "reshuffles when it runs out" suffix needs it.
    this.getMode = opts.getMode || (() => 'songs');
    this._lastRevision = -1;
    this._lastIndex = undefined;  // distinct from a real -1 ("no current item")
  }

  _wireEvents(signal) {
    this.root.addEventListener('click', (e) => {
      // track-select.js's own "+"/select-all buttons live inside these rows —
      // let its own document-delegated handler own those clicks entirely.
      if (e.target.closest('.track-add') || e.target.closest('.select-all')) return;
      const rm = e.target.closest('.pl-remove');
      if (rm) { this.controller.removeAt(+rm.dataset.i); return; }
      const b = e.target.closest('.pl-row-play');
      if (b) this.controller.play(+b.dataset.i);
    }, { signal });
  }

  // Gated on queueRevision, NOT queue-array identity: removeAt()/reorder()
  // both mutate the controller's queue array in place (see
  // player-controller.js), so a reference check would silently miss those
  // changes — queueRevision is the correct O(1) signal (bumped by every
  // queue-mutating operation, exposed on snapshot()).
  //
  // _highlight() is gated too, separately — a rebuild always re-highlights
  // (freshly rendered rows carry no .pl-playing class yet), and otherwise
  // only when currentIndex itself changed. Without this, _highlight()'s
  // querySelectorAll + per-row classList.toggle would run on EVERY
  // onControllerUpdate — i.e. every timeupdate, ~4/sec — even on ticks where
  // neither the queue nor the playing index moved (real cost at the queue's
  // upper bound of 1000 items).
  _render(snapshot) {
    let rebuilt = false;
    if (snapshot.queueRevision !== this._lastRevision) {
      this._lastRevision = snapshot.queueRevision;
      this._renderRows(snapshot.queue);
      rebuilt = true;
    }
    if (rebuilt || snapshot.currentIndex !== this._lastIndex) {
      this._lastIndex = snapshot.currentIndex;
      this._highlight(snapshot.currentIndex);
    }
  }

  _renderRows(queue) {
    const total = queue.reduce((s, t) => s + (t.durationSec || 0), 0);
    const header = '<p class="search-status">' + queue.length
      + (queue.length === 1 ? ' song · ' : ' songs · ') + totalStr(total)
      + (this.getMode() === 'endless' ? ' · reshuffles when it runs out' : '') + '</p>'
      + (queue.length ? '<button type="button" class="select-all" data-target="#pl-queue">Select all</button>' : '');
    const rows = queue.map((t, i) => this._rowHtml(t, i)).join('');
    this.root.innerHTML = header + '<div class="search-results">' + rows + '</div>';
  }

  _rowHtml(t, i) {
    const cat = this.catalogById.get(t.id) || {};
    const info = esc(JSON.stringify(this._trackInfoPairs(t, cat)));
    const sourceType = cat.sourceType || '';
    const addBtn = (typeof window !== 'undefined' && window.trackAddButtonHtml) ? window.trackAddButtonHtml(t.id) : '';
    return '<div class="pl-row" data-i="' + i + '">'
      + '<button type="button" class="sr pl-row-play" data-i="' + i + '">'
      + '<span class="sr-icon">&#9834;</span>'
      + '<span class="sr-main"><span class="sr-title" data-info="' + info + '">' + esc(t.title) + '</span>'
      + '<span class="sr-sub">' + esc(trackMeta(t)) + '</span></span>'
      + '<span class="sr-src src-' + esc(sourceType) + '">' + esc(sourceType.toUpperCase()) + '</span>'
      + '<span class="sr-meta">' + formatTime(t.durationSec) + '</span></button>'
      + addBtn
      + '<a class="pl-link" href="' + esc(t.pageUrl) + '" target="_blank" rel="noopener" '
      + 'aria-label="Open ' + esc(t.title) + ' on its show page" title="Open show page">' + LINK_SVG + '</a>'
      + '<button type="button" class="pl-remove" data-i="' + i
      + '" aria-label="Remove ' + esc(t.title) + ' from this playlist" title="Remove from playlist">' + X_SVG + '</button>'
      + '</div>';
  }

  _trackInfoPairs(item, cat) {
    const pairs = [
      ['Artist', cat.performer || item.artist || '—'],
      ['Track', cat.num != null ? ('No. ' + cat.num) : '—'],
      ['Venue', item.venue || '—'],
      ['Date', item.dateDisplay || 'Unknown date'],
      ['Source', cat.sourceType ? cat.sourceType.toUpperCase() : '—'],
      ['Duration', formatTime(item.durationSec)],
      ['Process version', cat.procVer ? ('v' + cat.procVer) : 'Not yet processed'],
    ];
    if (cat.songwriter && cat.songwriter !== 'Jerry Hannan & Sean Hannan') pairs.push(['Songwriter', cat.songwriter]);
    return pairs;
  }

  _highlight(currentIndex) {
    this.root.querySelectorAll('.pl-row').forEach((r) => {
      r.classList.toggle('pl-playing', +r.dataset.i === currentIndex);
    });
  }
}

// ── #pl-now ──────────────────────────────────────────────────────────────
export class PlaylistNowPlayingView extends QueueView {
  constructor(root, opts = {}) {
    super(root, opts);
    this.catalogById = opts.catalogById || new Map();
    this._currentId = null;
    this._seeking = false;
    this._errorEl = null;
  }

  _wireEvents(signal) {
    this.root.addEventListener('click', (e) => {
      const b = e.target.closest('.pl-btn');
      if (!b || !this.controller) return;
      if (b.dataset.act === 'shuffle') this.controller.toggleShuffle();
      else if (b.dataset.act === 'prev') this._prev();
      else if (b.dataset.act === 'next') this.controller.next();
      else this.controller.toggle();
    }, { signal });
    // Native range: dragging, clicking, and arrow keys all fire 'input'
    // uniformly, so one delegated handler covers mouse/touch/keyboard —
    // delegated since the range element itself is only recreated on a
    // currentItem.id change, not on every render.
    this.root.addEventListener('mousedown', (e) => { if (e.target.closest('.progress-range')) this._seeking = true; }, { signal });
    this.root.addEventListener('touchstart', (e) => { if (e.target.closest('.progress-range')) this._seeking = true; }, { signal });
    this.root.addEventListener('change', (e) => { if (e.target.closest('.progress-range')) this._seeking = false; }, { signal });
    this.root.addEventListener('input', (e) => {
      const range = e.target.closest('.progress-range');
      if (!range || !this.controller) return;
      const audio = this.controller.audioElement;
      const pct = (range.value / RANGE_MAX) * 100;
      this._paintRange(pct);
      if (isFinite(audio.duration)) this.controller.seek((pct / 100) * audio.duration);
    }, { signal });
  }

  // Structural rebuild ONLY on a currentItem.id change. Gating on `state`
  // too (as an earlier draft of this design did) is wrong: state changes on
  // every loading->playing->paused transition during ordinary playback, so a
  // rebuild there would replace the play button's DOM node — and its
  // keyboard focus — constantly. Everything else patches existing nodes.
  _render(snapshot) {
    const item = snapshot.currentItem;
    if (!item) {
      if (this._currentId !== null) {
        this.root.innerHTML = '';
        this.root.hidden = true;
        this._currentId = null;
        this._playBtn = this._shuffleBtn = this._range = this._timeCur = null;
        this._errorEl = null;
        this._seeking = false;
      }
      return;
    }
    if (item.id !== this._currentId) {
      this._buildStructure(item);
      this._currentId = item.id;
      // A drag/press-and-hold gesture in progress on the OLD range element
      // (mousedown/touchstart already fired, 'change' has not) leaves
      // _seeking stuck true forever once that element is torn down and
      // replaced -- the new range's value/aria-valuetext would silently
      // freeze in _patch() (Codex post-deploy review finding #4, 2026-08-15).
      // The track just changed out from under any in-progress seek anyway,
      // so there is nothing left to preserve.
      this._seeking = false;
    }
    this._patch(snapshot);
  }

  _buildStructure(item) {
    const cat = this.catalogById.get(item.id) || {};
    this.root.hidden = false;
    const meta = trackMeta(item);
    const swChip = cat.songwriter && cat.songwriter !== 'Jerry Hannan & Sean Hannan'
      ? ' <span class="sr-tag">' + esc(cat.songwriter) + '</span>' : '';
    this.root.innerHTML =
      '<div class="pl-now-info"><a class="pl-now-title" href="' + esc(item.pageUrl) + '">' + esc(item.title) + '</a>'
      + '<span class="pl-now-meta">' + esc(meta) + swChip + '</span></div>'
      + '<div class="pl-controls">'
      + '<button type="button" class="pl-btn" data-act="shuffle" aria-pressed="false" aria-label="Shuffle remaining tracks">' + SHUFFLE_ICON + '</button>'
      + '<button type="button" class="pl-btn" data-act="prev" aria-label="Previous">' + PREV_ICON + '</button>'
      + '<button type="button" class="pl-btn pl-btn-play" data-act="play" aria-label="Play/pause">' + PAUSE_ICON + '</button>'
      + '<button type="button" class="pl-btn" data-act="next" aria-label="Next">' + NEXT_ICON + '</button>'
      + '</div>'
      + '<div class="pl-progress"><span class="pl-time-current">0:00</span>'
      + '<input type="range" class="progress-range" min="0" max="' + RANGE_MAX + '" value="0" step="1" '
      + 'aria-label="Seek ' + esc(item.title) + '" aria-valuetext="0:00 of ' + formatTime(item.durationSec) + '">'
      + '<span>' + formatTime(item.durationSec) + '</span></div>';
    this._shuffleBtn = this.root.querySelector('[data-act="shuffle"]');
    this._playBtn = this.root.querySelector('[data-act="play"]');
    this._range = this.root.querySelector('.progress-range');
    this._timeCur = this.root.querySelector('.pl-time-current');
    this._errorEl = null;
  }

  _patch(snapshot) {
    const state = snapshot.state;
    const audio = this.controller.audioElement;
    if (this._playBtn) {
      const playing = state === 'playing' || state === 'loading';
      this._playBtn.innerHTML = state === 'loading' ? LOADING_ICON : (playing ? PAUSE_ICON : PLAY_ICON);
      this._playBtn.setAttribute('aria-label', state === 'error' ? 'Retry' : (playing ? 'Pause' : 'Play'));
    }
    if (this._shuffleBtn) {
      this._shuffleBtn.setAttribute('aria-pressed', String(!!snapshot.shuffleOn));
      this._shuffleBtn.setAttribute('aria-label', snapshot.shuffleOn
        ? 'Shuffle on — click to restore original order' : 'Shuffle remaining tracks');
    }
    this._setError(state === 'error');
    const t = audio ? audio.currentTime : 0;
    const dur = audio && isFinite(audio.duration) ? audio.duration
      : ((snapshot.currentItem && snapshot.currentItem.durationSec) || 0);
    if (!this._seeking && this._range) {
      const pct = dur ? (t / dur) * 100 : 0;
      this._range.value = Math.round(pct * RANGE_MAX / 100);
      this._paintRange(pct);
      this._range.setAttribute('aria-valuetext', formatTime(t) + ' of ' + formatTime(dur));
    }
    if (this._timeCur) this._timeCur.textContent = formatTime(t);
  }

  _paintRange(pct) {
    if (!this._range) return;
    // backgroundImage, not the `background` shorthand — see .progress-range
    // in site.css: the shorthand would inflate the 3px rail to 24px.
    this._range.style.backgroundImage = 'linear-gradient(to right, var(--accent) ' + pct + '%, var(--border) ' + pct + '%)';
  }

  // Legacy parity (decision recorded in the plan): pressing Prev at queue
  // start (index 0, <=3s elapsed) restarts track 1 rather than no-op.
  // player-controller.js's shared _advance(-1) deliberately no-ops at index
  // 0 (a Phase 1 primitive show pages already rely on) — replicated here at
  // the view level instead of changed there, so this page's parity choice
  // doesn't touch already-shipped, already-reviewed shared code.
  _prev() {
    const c = this.controller;
    const audio = c.audioElement;
    if (audio.currentTime > 3) { c.seek(0); return; }
    if (c.currentIndex > 0) { c.prev(); return; }
    c.seek(0);
    // Only start playback when it is not already running (fixed 2026-08-16;
    // MiniPlayerView._prev() carries the identical guard and the same note).
    // play() on an already-playing element resolves WITHOUT firing
    // play/playing — WHATWG's internal play steps fire those only on a
    // paused -> playing transition — while _playIndex() has already set state
    // 'loading' and is waiting for exactly that event. Pressing Prev on track 1
    // of a playing queue therefore left #pl-now showing its loading spinner for
    // the rest of the track. This shipped in Phase 2 and the test above passed
    // throughout, because FakeAudio.play() used to queue both events
    // unconditionally; making the fake honest is what surfaced it.
    if (audio.paused || c.state === 'error') c.play();
  }

  // Mirrors PlayerView._setError (player-views.js) — a hard failure
  // (404/CORS/decode) is otherwise invisible.
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
}
