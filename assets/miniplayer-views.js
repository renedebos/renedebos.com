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

// The one mount policy every boot module shares (player-boot, playlist-boot,
// song-boot). Close is the view's REQUEST; the policy here is pause + unmount
// (which hides the bar and releases --miniplayer-height), and the audio's next
// 'play' event remounts. mount() is idempotent for a view already in the
// controller's set — onAttach() aborts its outgoing listeners first — so the
// 'play' listener needs no mounted-state bookkeeping.
export function attachMiniPlayerBar(controller, root, signal) {
  const bar = new MiniPlayerView(root, {
    onClose() { controller.pause(); controller.unmount(bar); },
    // Share is answered by share.js, imported on the FIRST press rather than
    // up front: this module ships on nearly every page and must not put one
    // more asset on all of them (see the import-boundary test) for a control
    // most visits never touch. A failed import leaves the press a no-op.
    onShare(item, btn) {
      import('/assets/share.js').then(({ shareItem }) => shareItem(item, btn)).catch(() => {});
    },
    // The overflow menu, on the same lazy terms as share above. specsForItem()
    // rather than specsForRow(): the bar paints an item and has no row -- and
    // on a /t/ share page or /playlist/ there may be no row for it anywhere on
    // the page, which that function handles by deriving the provenance from
    // the item instead of finding none.
    onMenu(item, btn) {
      import('/assets/row-menu.js').then((m) => {
        const store = typeof window !== 'undefined' ? window.trackSelection : null;
        m.openRowMenu(m.specsForItem(item, {
          currentPath: typeof location !== 'undefined' ? location.pathname : '',
          isSelected: store ? (id) => store.has(id) : null,
          onToggleAdd: store ? (id) => store.toggle(id) : null,
          anchor: btn,
        }), btn, {});
      }).catch(() => {});
    },
  });
  controller.mount(bar);
  controller.audioElement.addEventListener('play', () => controller.mount(bar), { signal });
  return bar;
}

// Published on <html> so page chrome can make room for the bar. Consumers must
// read it with a fallback — `var(--miniplayer-height, 0px)` — because it is
// REMOVED, not zeroed, whenever the bar isn't showing.
export const HEIGHT_VAR = '--miniplayer-height';

// Same monochrome set the other engines use (kept local — player-controller.js
// only exports the three icons every engine needs).
const PREV_ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="2" width="2" height="12"/><polygon points="14,2 14,14 4,8"/></svg>';
const NEXT_ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><polygon points="2,2 2,14 12,8"/><rect x="12" y="2" width="2" height="12"/></svg>';
const X_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
// The row overflow trigger's glyph, byte-identical to fragments.py's MORE_SVG
// and songs.js's moreIcon -- one control, one drawing, now three renderers.
const MORE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
  + '<circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/>'
  + '<circle cx="19" cy="12" r="1.9"/></svg>';
// The three-dots-and-lines share glyph the per-row share button used before
// the waveform rows retired it (3dc47fb9, 2026-06-13).
const SHARE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" '
  + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="2.6"/>'
  + '<circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/>'
  + '<path d="M8.2 13.3l7.6 4.4M15.8 6.3l-7.6 4.4"/></svg>';
// Identical to playlist-views.js's SHUFFLE_ICON — the same control in two
// engines-worth of chrome should not draw two different glyphs.
const SHUFFLE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/>'
  + '<line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/>'
  + '<line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>';

// Same rule as boundedPath() in the parked coordinator's codec (deleted from
// main 2026-08-22; survives on the miniplayer-parked branch as
// miniplayer-state.js), and for the same reason it
// is resolved with the URL parser rather than by inspecting characters: a
// leading "/" is not proof of same-origin once the parser is involved
// ("/\evil.test/x" resolves off-origin, and a tab/CR/LF before a second slash
// is stripped before parsing). Duplicated rather than imported -- this module
// imports player-controller.js and nothing else, deliberately, and a few lines
// is a cheaper price than that property. Keep the two in step.
const PATH_SENTINEL_ORIGIN = 'https://miniplayer.invalid';

function isSitePath(url) {
  if (typeof url !== 'string' || url.charCodeAt(0) !== 47) return false;
  try {
    return new URL(url, PATH_SENTINEL_ORIGIN).origin === PATH_SENTINEL_ORIGIN;
  } catch (e) {
    return false;
  }
}

// 'unknown date' rather than silently dropping the field: 18 real catalog rows
// have no date (the sean-19-broadway-unknown-* set), and BOTH surfaces this bar
// replaces say so explicitly — playlist-views.js's trackMeta() and
// continuous-player.js's now-playing line. Omitting it shows less than what it
// replaces, on real content. Every field read here must survive persistence;
// see encodeItem() in the parked coordinator's codec (miniplayer-state.js,
// deleted from main 2026-08-22 -- survives on the miniplayer-parked branch),
// where venue and date each had to be added after this line started reading
// them.
function trackMeta(item) {
  return [item.artist, item.venue, item.dateDisplay || item.date || 'unknown date']
    .filter(Boolean).join(' · ');
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
    // A FRESH AbortController per attachment. onDetach() aborts permanently,
    // and addEventListener with an already-aborted signal registers nothing at
    // all — so reusing the constructor's one made a remounted view silently
    // inert, every control dead (Task 2 review finding 1, reproduced). The
    // sibling view modules get away with one because no view of theirs is ever
    // remounted; this bar's Close-then-play cycle is exactly a remount.
    //
    // Aborting the OUTGOING one first is what makes a duplicate mount safe:
    // PlaybackController.mount() calls onAttach() even for a view already in
    // its set, so simply replacing the controller left the previous
    // attachment's listeners live — one click then ran two handlers, toggling
    // twice, so the control looked alive and did nothing (reproduced), and
    // unmount() no longer removed everything the view had added.
    if (this._abort) this._abort.abort();
    this._abort = new AbortController();
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
    // Share hands the CURRENT item and the pressed button to whoever owns the
    // share UI (attachMiniPlayerBar wires share.js); the bar itself only knows
    // what is playing. Absent handler: the button still renders and does
    // nothing -- a dead control is better than a bar missing a slot on one
    // surface and not another.
    this.onShare = typeof opts.onShare === 'function' ? opts.onShare : () => {};
    this.onMenu = typeof opts.onMenu === 'function' ? opts.onMenu : () => {};
    this._currentId = null;
    this._currentItem = null;
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
      if (act === 'share') {
        // The item the bar is currently painting (set in _patch), not a fresh
        // controller read: what the visitor sees is what they mean to share.
        if (this._currentItem) this.onShare(this._currentItem, b);
        return;
      }
      if (act === 'menu') {
        // Same rule as share: the painted item, not a fresh controller read.
        if (this._currentItem) this.onMenu(this._currentItem, b);
        return;
      }
      if (!this.controller) return;
      if (act === 'prev') { this._prev(); return; }
      if (act === 'next') { this.controller.next(); return; }
      if (act === 'shuffle') { this.controller.toggleShuffle(); return; }
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
    // 'change' alone is not enough to END a seek: a press that doesn't move the
    // thumb changes no value, so no 'change' is ever emitted and _seeking would
    // stay true for the rest of the track — the range and its aria-valuetext
    // frozen while the visible clock kept counting (Task 2 review finding 4,
    // reproduced). Release and cancellation are listened for on the DOCUMENT
    // because a drag routinely ends with the pointer outside the control.
    // Scoped to the same abort signal, so a detached view leaves nothing behind.
    if (typeof document !== 'undefined') {
      const endSeek = () => { this._seeking = false; };
      ['mouseup', 'pointerup', 'pointercancel', 'touchend', 'touchcancel'].forEach((type) => {
        document.addEventListener(type, endSeek, { signal });
      });
    }
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

  // Previous at the START of the queue restarts the current track rather than
  // doing nothing. controller.prev() no-ops before index 0 — a deliberate
  // Phase 1 primitive show pages rely on — so the parity is replicated at the
  // view level, exactly as PlaylistNowPlayingView._prev() already does, rather
  // than changing shared code. It matches the popup this bar replaces:
  // continuous-player.js calls playAt(idx - 1), and playAt() clamps a negative
  // index to 0 and plays it.
  _prev() {
    const c = this.controller;
    const audio = c.audioElement;
    if (audio.currentTime > 3) { c.seek(0); return; }
    if (c.currentIndex > 0) { c.prev(); return; }
    c.seek(0);
    // Only start playback when it is not already running. play() on an element
    // that is already playing resolves WITHOUT firing play/playing — WHATWG's
    // internal play steps fire those only on a paused -> playing transition —
    // while _playIndex() has already set state 'loading' and is waiting for
    // exactly that event. An unconditional call therefore left the bar showing
    // its loading spinner forever while the audio played on. Reproduced with a
    // spec-shaped fake; the old FakeAudio queued the events unconditionally and
    // hid it. An 'error' state still needs the call — that is the retry path.
    if (c.audioElement.paused || c.state === 'error') c.play();
  }

  // A detached view must leave nothing rendered and nothing reserved: the bar
  // is hidden, its markup dropped, and its render state reset, so a later
  // remount rebuilds the structure (and restarts height observation) instead
  // of short-circuiting on a currentItem.id that never changed.
  onDetach() {
    this._hide();
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
      this._buildStructure();
      this._currentId = item.id;
      // A drag/press-and-hold in progress on the OLD range element (mousedown
      // fired, 'change' has not) would leave this stuck true forever once that
      // element is torn down, silently freezing the new range (Phase 2
      // post-deploy finding #4). The track changed out from under the seek
      // anyway, so there is nothing to preserve.
      this._seeking = false;
      // Every cache below describes nodes that no longer exist — and the
      // controls one is load-bearing now that its key depends on the title
      // instead of being invalidated from _patchMeta(): two different ids can
      // carry identical metadata (two takes of one song, same venue, date and
      // duration), and without this the freshly built button would keep the
      // template's generic "Play" for the whole track. Directly tested, and
      // the test fails when this line alone is removed.
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
    this._currentItem = null;
    this._playBtn = this._shuffleBtn = this._prevBtn = this._nextBtn = this._range = null;
    this._timeCur = this._titleEl = this._metaEl = this._totalEl = null;
    this._errorEl = null;
    this._errorKind = null;
    this._seeking = false;
    this._lastQueueRevision = -1;
    this._lastControlsKey = null;
    this._lastMetaKey = null;
  }

  // Structure only — every piece of item data is written by _patchMeta()
  // below. That split is deliberate: the template interpolates nothing, so
  // there is no escaping to get wrong, and metadata can change under a stable
  // currentItem.id without a rebuild (finding 3).
  _buildStructure() {
    this.root.hidden = false;
    this.root.innerHTML =
      '<button type="button" class="mp-btn mp-play" data-act="play" aria-label="Play">' + PLAY_ICON + '</button>'
      + '<div class="mp-info"><a class="mp-title"></a><span class="mp-meta"></span></div>'
      + '<div class="mp-progress"><span class="mp-time mp-time-current">0:00</span>'
      + '<input type="range" class="progress-range" min="0" max="' + RANGE_MAX + '" value="0" step="1">'
      + '<span class="mp-time mp-time-total"></span></div>'
      + '<div class="mp-controls">'
      + '<button type="button" class="mp-btn mp-shuffle" data-act="shuffle" aria-pressed="false" aria-label="Shuffle">' + SHUFFLE_ICON + '</button>'
      + '<button type="button" class="mp-btn mp-prev" data-act="prev" aria-label="Previous track">' + PREV_ICON + '</button>'
      + '<button type="button" class="mp-btn mp-next" data-act="next" aria-label="Next track">' + NEXT_ICON + '</button>'
      + '<button type="button" class="mp-btn mp-share" data-act="share" aria-label="Share this song" title="Share this song">' + SHARE_ICON + '</button>'
      + '<button type="button" class="mp-btn mp-menu" data-act="menu" aria-haspopup="menu" aria-expanded="false" aria-label="More options" title="More options">' + MORE_ICON + '</button>'
      + '<button type="button" class="mp-btn mp-close" data-act="close" aria-label="Close player">' + X_SVG + '</button>'
      + '</div>';
    this._playBtn = this.root.querySelector('.mp-play');
    this._shuffleBtn = this.root.querySelector('.mp-shuffle');
    this._prevBtn = this.root.querySelector('.mp-prev');
    this._nextBtn = this.root.querySelector('.mp-next');
    this._range = this.root.querySelector('.progress-range');
    this._timeCur = this.root.querySelector('.mp-time-current');
    this._titleEl = this.root.querySelector('.mp-title');
    this._metaEl = this.root.querySelector('.mp-meta');
    this._totalEl = this.root.querySelector('.mp-time-total');
    this._errorEl = null;
    this._lastMetaKey = null;              // nothing has been written into it yet
    this._observeHeight();
  }

  // Item data, patched whenever it actually differs — NOT written once at
  // build time. Two reasons, both reproduced (findings 2 and 3):
  //   - setQueue() legitimately replaces the item object under the same id
  //     (a restored session carrying older metadata, then the page's own
  //     fresh queue), which left a stale title and, worse, a stale link to a
  //     track the controller was no longer playing;
  //   - `durationSec` is nullable by schema, so a total written once showed a
  //     permanent 0:00 while the range announced the real duration the moment
  //     the browser reported one. The displayed total now comes from the SAME
  //     resolved duration the range uses, so the two cannot disagree.
  _patchMeta(item, dur) {
    const meta = trackMeta(item);
    const total = formatTime(dur);
    // JSON, not a delimiter join. Any separator character can itself occur in
    // the data — persisted titles and URLs are explicitly untrusted — and a pair
    // that moves the separator across a field boundary then produces an
    // identical key, leaving the bar rendering the previous track's title and
    // link (reproduced). JSON.stringify cannot collide that way, and this runs
    // only when something actually changed.
    const key = JSON.stringify([item.title, item.pageUrl, meta, total]);
    if (key === this._lastMetaKey) return;
    this._lastMetaKey = key;
    if (this._titleEl) {
      this._titleEl.textContent = item.title;
      // pageUrl defaults to '' in normalizeItem(); an <a href=""> reloads the
      // current page, while an <a> with no href at all is inert and unfocusable
      // — the correct degradation, and it keeps one node type across the change.
      //
      // The path check is the second of two: the parked coordinator's codec
      // (miniplayer-state.js, deleted from main 2026-08-22, survives on the
      // miniplayer-parked branch) already rejects anything that isn't
      // root-relative on both its read and write paths. Repeated here because
      // this is the line that actually creates the link, and an item can
      // reach a controller from somewhere other than that codec (a page's own
      // data-item markup today, a future
      // hash- or catalog-derived queue). A value that executes is not worth
      // leaving to one layer.
      if (isSitePath(item.pageUrl)) this._titleEl.setAttribute('href', item.pageUrl);
      else this._titleEl.removeAttribute('href');
    }
    if (this._metaEl) this._metaEl.textContent = meta;
    if (this._totalEl) this._totalEl.textContent = total;
    if (this._range) this._range.setAttribute('aria-label', 'Seek ' + item.title);
  }

  _patch(snapshot) {
    const item = snapshot.currentItem;
    this._currentItem = item;
    const state = snapshot.state;
    const audio = this.controller ? this.controller.audioElement : null;
    const failure = this._failureKind(snapshot, item);
    // The one duration both the visible total and the range's announcement are
    // derived from — see _patchMeta().
    const dur = audio && isFinite(audio.duration) ? audio.duration : (item.durationSec || 0);
    this._patchMeta(item, dur);

    if (this._playBtn) {
      const playing = state === 'playing' || state === 'loading';
      const verb = failure === 'blocked' ? 'Resume'
        : failure === 'failed' ? 'Retry'
        : playing ? 'Pause' : 'Play';
      // The icon SVG is only rewritten when it would actually differ: _patch()
      // runs on every timeupdate (~4/sec), and the label/icon pair changes a
      // handful of times per track.
      // The title is IN the key rather than invalidated from elsewhere when it
      // changes: the accessible name is 'Pause <title>', so the key deciding
      // whether to rewrite it depends on every input it uses. The earlier shape
      // kept verb+state here and had _patchMeta() reach over and null this key
      // — correct, but it made the two paths redundant and therefore
      // individually un-mutation-testable (post-fix review finding 5).
      //
      // Honest limit: **no test distinguishes this from plain verb+state**, and
      // removing `+ item.title` leaves the suite green. Every reachable title
      // change today arrives with either a rebuild (a new id) or a state
      // transition (setQueue always moves state), each of which rewrites the
      // label anyway. It is kept as construction rather than as a tested
      // property, because the coordinator will soon feed this view metadata
      // restored from storage, which is exactly where a same-id, same-state
      // title change becomes reachable. Don't claim it is covered.
      const key = verb + '|' + state + '|' + item.title;
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
      // Shuffle rides the same gate: reordering a single item is meaningless,
      // exactly like stepping to it.
      if (this._shuffleBtn) this._shuffleBtn.hidden = !stepping;
    }
    // Outside the queueRevision gate: toggleShuffle() flips state without
    // changing queue membership on an unstarted queue (its graceful-degrade
    // path), so the pressed state has to track the snapshot, not the
    // revision. Unconditional attribute writes at ~4/sec, matching
    // playlist-views.js's shuffle button exactly.
    if (this._shuffleBtn) {
      this._shuffleBtn.setAttribute('aria-pressed', String(!!snapshot.shuffleOn));
      this._shuffleBtn.setAttribute('aria-label', snapshot.shuffleOn
        ? 'Shuffle on — restore order' : 'Shuffle');
    }

    const t = audio ? audio.currentTime : 0;
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
    // backgroundImage, never the `background` shorthand — the shorthand
    // resets background-size/-repeat/-position, and an inline style beats a
    // stylesheet longhand, so it would inflate the 3px rail to the full 24px
    // pointer target (the Task 3 review's open defect 1, fixed here the same
    // way player-views.js and playlist-views.js already were on main).
    // Still the --player-* aliases, not a design system's own token names:
    // that is what keeps this module portable to home.css pages if the bar
    // ever ships there.
    this._range.style.backgroundImage =
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
