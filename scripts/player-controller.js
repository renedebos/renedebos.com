// Shared playback engine — one PlaybackController per document, owning the
// sole <audio> element, queue, and transport/shuffle/repeat state for every
// PlayerView mounted on the page. Replaces the per-row/per-page <audio>
// elements and hand-duplicated queue logic in player.js, wavesurfer.js,
// playlist.js, and continuous-player.js (see plans/player-consolidation/).
//
// Show pages are the only consumer so far. The queue/shuffle/repeat/reorder
// surface is deliberately general enough to be the foundation /playlist/ and
// /player/ migrate onto later — but that is an intended foundation, not a
// proven drop-in: only removeAt()'s behavior has actually been verified
// against those engines so far, so expect real adaptation work there.

// ── playback coordination (same page + other tabs/windows) ─────────────────
// A claim announces "I'm playing now": broadcast to every other tab/window
// AND delivered to every other controller on the same page (BroadcastChannel
// never delivers back to the posting page itself). Generalizes player.js's
// listener-registry shape — the more capable of the two shapes that exist in
// the current four engines — as a module-level singleton so every
// controller instance shares one channel connection. `owner` lets a claim
// skip the controller that made it, so a controller never pauses itself.
let channel = null;
try { channel = new BroadcastChannel('hannan-playback'); } catch (e) { /* unsupported / private browsing */ }
const selfId = Math.random().toString(36).slice(2);
const claimListeners = new Set();

function claim(owner) {
  if (channel) channel.postMessage(selfId);
  claimListeners.forEach(l => { if (l.owner !== owner) l.fn(); });
}

function onExternalClaim(owner, fn) {
  const entry = { owner, fn };
  claimListeners.add(entry);
  return () => claimListeners.delete(entry);
}

if (channel) {
  channel.onmessage = e => {
    if (e.data !== selfId) claimListeners.forEach(l => l.fn());
  };
}

// ── shared formatting/icons (previously duplicated in player.js and
// wavesurfer.js) ─────────────────────────────────────────────────────────

export function formatTime(s) {
  if (!isFinite(s)) return '—';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

export const PLAY_ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><polygon points="4,2 14,8 4,14"/></svg>';
export const PAUSE_ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="2" width="4" height="12"/><rect x="9" y="2" width="4" height="12"/></svg>';
export const LOADING_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:spin 0.75s linear infinite;display:block"><circle cx="8" cy="8" r="5.5" stroke-dasharray="20" stroke-dashoffset="6" stroke-linecap="round"/></svg>';

function shuffleArray(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

// ── playable-item schema ────────────────────────────────────────────────
// Validates/defaults a raw item into the normalized shape every view and
// the controller itself can rely on. Doesn't know or care where the raw
// data came from (a row's data-item JSON today; a catalog row once
// /playlist//player/ migrate) — see plans/player-consolidation/ for the
// full field-by-field rationale.
export function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') throw new TypeError('playable item must be an object');
  const id = String(raw.id || '');
  if (!id) throw new TypeError('playable item requires an id');
  // A missing/blank streamUrl is never recoverable — silently defaulting it to
  // '' would assign audio.src = '' and surface as a confusing decode error
  // rather than the data problem it actually is.
  const streamUrl = String(raw.streamUrl || '');
  if (!streamUrl) throw new TypeError(`playable item ${id} requires a streamUrl`);
  // Guard the numeric fields against NaN/Infinity/negatives — these reach
  // seek math and Media Session's setPositionState(), which throws on
  // non-finite input, and later phases feed this from persisted/URL-derived
  // state that can't be trusted the way build-time markup can.
  const durationSec = typeof raw.durationSec === 'number'
    && isFinite(raw.durationSec) && raw.durationSec >= 0 ? raw.durationSec : null;
  return {
    id,
    kind: raw.kind === 'recording' ? 'recording' : 'track',
    streamUrl,
    title: raw.title ? String(raw.title) : 'Untitled',
    artist: raw.artist ? String(raw.artist) : '',
    venue: raw.venue || null,
    date: raw.date || null,
    dateDisplay: raw.dateDisplay || null,
    durationSec,
    durationLabel: raw.durationLabel || null,
    peaksKey: raw.peaksKey || null,
    pageUrl: raw.pageUrl || '',
    playLabel: raw.playLabel || raw.title || '',
    downloads: raw.downloads || { flac: null },
    dropouts: !!raw.dropouts,
  };
}

// ── PlaybackController ──────────────────────────────────────────────────
export class PlaybackController {
  constructor({ audio = new Audio(), mediaSession = true } = {}) {
    this.audio = audio;
    this.audio.preload = 'none';

    this._queue = [];
    this._idx = -1;
    // Tracked separately from audio.src because the DOM property getter
    // returns a resolved absolute URL, which won't always compare equal to the
    // string we assigned.
    this._currentSrc = null;
    this._state = 'idle';       // 'idle'|'loading'|'playing'|'paused'|'ended'|'error'
    this._gen = 0;               // bumped by anything that changes "what should currently be happening";
                                  // async continuations capture it and no-op if it's moved on
    this._repeatOne = false;
    this._shuffleOn = false;
    this._unshuffledQueue = null;
    this._views = new Set();
    this._destroyed = false;
    this._mediaSessionEnabled = mediaSession && typeof navigator !== 'undefined' && 'mediaSession' in navigator;

    this._unclaim = onExternalClaim(this, () => {
      if (this._state === 'playing' || this._state === 'loading') this.pause();
    });

    // Every listener below is registered against this signal so destroy() can
    // detach all of them in one call rather than needing a named reference per
    // handler.
    this._abort = new AbortController();
    const on = (type, fn) => this.audio.addEventListener(type, fn, { signal: this._abort.signal });

    on('play', () => { claim(this); this._syncMediaPlaybackState(); });
    on('playing', () => { this._setState('playing'); this._notify(); });
    on('waiting', () => { this._setState('loading'); this._notify(); });
    on('pause', () => {
      this._syncMediaPlaybackState();
      // stop() already set 'idle' (and bumped gen) before calling audio.pause();
      // an 'error' state is likewise set explicitly and shouldn't be overwritten here.
      if (this._idx === -1 || this._state === 'error') { this._notify(); return; }
      this._setState('paused');
      this._notify();
    });
    on('ended', () => {
      // _playIndex only reassigns audio.src (which resets currentTime as a
      // side effect) when the item actually changes — repeat-one replays the
      // same item, so currentTime needs an explicit reset or playback would
      // resume from the end instead of restarting.
      if (this._repeatOne) { this.audio.currentTime = 0; this._playIndex(this._idx); return; }
      if (this._idx + 1 < this._queue.length) { this.play(this._idx + 1); return; }
      ++this._gen;
      this._setState('ended');
      this._notify();
    });
    on('timeupdate', () => {
      if (this._mediaSessionEnabled && isFinite(this.audio.duration)) {
        try {
          navigator.mediaSession.setPositionState({
            duration: this.audio.duration, playbackRate: this.audio.playbackRate, position: this.audio.currentTime,
          });
        } catch (e) { /* not all browsers support this yet */ }
      }
      this._notify();
    });
    // The one genuine addition none of the four current engines have: every
    // other engine leaves a hard load failure (404/CORS/decode error) stuck
    // showing a loading spinner forever, since 'waiting' fires but nothing
    // ever un-sets it. One listener per controller (not per row) now covers
    // every item that plays through it.
    on('error', () => this._handleError(this.audio.error));

    // Registered individually: setActionHandler throws on an action the browser
    // doesn't support, and an unguarded throw here would abort construction of
    // the whole controller over a missing lock-screen button.
    if (this._mediaSessionEnabled) {
      const actions = {
        play: () => this.play(), pause: () => this.pause(),
        previoustrack: () => this.prev(), nexttrack: () => this.next(),
      };
      Object.keys(actions).forEach(action => {
        try { navigator.mediaSession.setActionHandler(action, actions[action]); } catch (e) { /* unsupported action */ }
      });
    }
  }

  // ── queue ──
  // Replaces the queue wholesale. This is also the "switch queue context and
  // start playing" operation — a show page's track row re-asserts its own
  // full track queue this way on every click, which is what lets playback
  // return to the track list after the Hero card's playSingleton() collapsed
  // it (see playSingleton's note).
  setQueue(items, { startIndex = -1, autoplay = false } = {}) {
    if (this._destroyed) return;
    ++this._gen;
    this._queue = items.map(normalizeItem);
    this._shuffleOn = false;
    this._unshuffledQueue = null;
    if (startIndex >= 0 && startIndex < this._queue.length) {
      this._idx = startIndex;
      // Returns the play promise so callers can sequence after playback has
      // actually started (a view seeking to a tapped waveform position, say).
      if (autoplay) return this._playIndex(startIndex);
      // Cued but not playing: whatever the element was playing belongs to the
      // queue we just discarded, so stop it rather than leave audible playback
      // disagreeing with currentItem and the published queue.
      if (!this.audio.paused) this.audio.pause();
    } else {
      this._idx = -1;
      this._setState('idle');
      if (!this.audio.paused) this.audio.pause();
    }
    this._notify();
  }

  appendQueue(items) {
    if (this._destroyed) return 0;
    const existing = new Set(this._queue.map(t => t.id));
    const fresh = items.map(normalizeItem).filter(t => !existing.has(t.id));
    if (fresh.length) { this._queue = this._queue.concat(fresh); this._notify(); }
    return fresh.length;
  }

  // Drops one item in place. Deliberately reproduces the existing
  // playlist.js/continuous-player.js removeAt() semantics exactly (both are
  // byte-identical today, playlist.js:803-828 / continuous-player.js:339-356):
  // removing the CURRENTLY PLAYING item does not stop playback — the next
  // item slides into that slot, gets cued, and keeps playing if the removed
  // one had been. Only an emptied queue, or removing the last item while it
  // plays, actually stops.
  removeAt(index) {
    if (this._destroyed) return;
    if (index < 0 || index >= this._queue.length) return;
    const wasPlaying = this._idx !== -1 && !this.audio.paused;
    const removed = this._queue[index];
    this._queue.splice(index, 1);
    // Keep the shuffle-off restore snapshot from resurrecting a track that was
    // explicitly removed after shuffling.
    if (this._unshuffledQueue) {
      this._unshuffledQueue = this._unshuffledQueue.filter(t => t.id !== removed.id);
    }
    if (!this._queue.length) { this.stop(); return; }
    if (index < this._idx) {
      this._idx -= 1;                       // playing item shifted down one slot
    } else if (index === this._idx) {
      if (this._idx >= this._queue.length) { this.stop(); return; }
      if (wasPlaying) { this._playIndex(this._idx); return; }
      // Cued but paused: point the element at the item that slid in, without
      // starting it.
      ++this._gen;
      this._currentSrc = this._queue[this._idx].streamUrl;
      this.audio.src = this._currentSrc;
      this._setState('paused');
      this._updateMediaMetadata();
    }
    this._notify();
  }

  // Unused by show pages — the intended foundation for /playlist//player/'s
  // queue-editing UI, not yet proven against their real behavior.
  reorder(fromIndex, toIndex) {
    if (this._destroyed) return;
    if (fromIndex < 0 || fromIndex >= this._queue.length) return;
    // Clamp rather than trust the caller: a drag-and-drop UI can hand over an
    // out-of-range drop target, and splice() would silently append instead.
    const to = Math.max(0, Math.min(toIndex, this._queue.length - 1));
    if (fromIndex === to) return;
    const [item] = this._queue.splice(fromIndex, 1);
    this._queue.splice(to, 0, item);
    if (this._idx === fromIndex) this._idx = to;
    else if (fromIndex < this._idx && to >= this._idx) this._idx -= 1;
    else if (fromIndex > this._idx && to <= this._idx) this._idx += 1;
    // A manual reorder makes the pre-shuffle snapshot meaningless: restoring
    // it later would silently undo the reorder. Drop it and clear the toggle
    // rather than restore a stale order.
    if (this._unshuffledQueue) { this._unshuffledQueue = null; this._shuffleOn = false; }
    this._notify();
  }

  // ── transport ──
  // Every method below is a no-op once destroy() has run — the whole point of
  // finding #1 in the Step 4 review: a leaked listener (a document/window one
  // player-boot.js installed, a leftover Media Session action handler, a stray
  // reference held by calling code) could otherwise reach into a "destroyed"
  // controller and start its detached <audio> element playing again. Reading
  // state (the getters/snapshot() below) stays open after destroy — only
  // driving the controller further is refused.
  play(itemOrIndex) {
    if (this._destroyed) return Promise.resolve();
    if (itemOrIndex == null) {
      if (this._idx === -1) {
        return this._queue.length ? this._playIndex(0) : Promise.resolve();
      }
      return this._playIndex(this._idx);
    }
    if (typeof itemOrIndex === 'number') return this._playIndex(itemOrIndex);
    const item = normalizeItem(itemOrIndex);
    const foundIndex = this._queue.findIndex(t => t.id === item.id);
    // Not queued — callers wanting queue-replacing ("singleton") semantics
    // use playSingleton() explicitly. Silently rebuilding the whole page's
    // queue here would turn an id-mismatch bug elsewhere into a playback
    // engine that quietly discards the rest of the queue instead of failing
    // in a noticeable way.
    if (foundIndex === -1) return Promise.resolve();
    return this._playIndex(foundIndex);
  }

  // Explicit queue-replacement operation — used by the Hero "Full Recording"
  // / alternate-transfer card, which isn't part of a show page's track-row
  // queue. Collapses the queue to this one item, so prev/next become
  // unavailable (queue.length <= 1).
  //
  // IMPORTANT for view authors: this DISCARDS whatever queue was loaded. A
  // track row must therefore never resume via play(item) — after a singleton
  // it isn't queued any more, so play() would correctly no-op and the row
  // would appear dead. Track rows always re-assert their own full queue with
  // setQueue(allRows, { startIndex, autoplay: true }), which is both the
  // correct semantics for "click a track on a show page" and what makes
  // Hero -> track -> next work. Covered by the queue-context tests in
  // test-player-controller.mjs.
  playSingleton(item) {
    if (this._destroyed) return Promise.resolve();
    this.setQueue([normalizeItem(item)]);
    return this._playIndex(0);
  }

  pause() {
    if (this._destroyed || this._idx === -1) return;
    ++this._gen; // invalidate any in-flight play() promise so its rejection doesn't surface as an error
    this.audio.pause();
  }

  toggle() {
    if (this._destroyed) return Promise.resolve();
    if (this._idx === -1) return this.play(0);
    // A failed item retries rather than toggling. Don't infer this from
    // audio.paused: an element that errored mid-playback can still report
    // paused === false, which would make the only visible control pause
    // something that isn't playing instead of retrying it.
    if (this._state === 'error') return this.play();
    return this.audio.paused ? this.play() : this.pause();
  }

  stop() {
    if (this._destroyed) return;
    ++this._gen;
    this._idx = -1;
    this._setState('idle');
    this.audio.pause();
    this._notify();
  }

  seek(seconds) {
    if (this._destroyed || !isFinite(this.audio.duration)) return;
    this.audio.currentTime = Math.max(0, Math.min(seconds, this.audio.duration));
  }

  seekBy(deltaSeconds) {
    if (this._destroyed) return;
    this.seek(this.audio.currentTime + deltaSeconds);
  }

  next() { if (!this._destroyed) this._advance(1); }

  prev() {
    if (this._destroyed) return;
    // Matches the existing playlist.js/continuous-player.js convention:
    // more than 3s in, restart the current track instead of going back.
    if (this.audio.currentTime > 3) { this.seek(0); return; }
    this._advance(-1);
  }

  _advance(dir) {
    if (this._idx === -1) return;
    const newIndex = this._idx + dir;
    if (newIndex < 0) return;
    if (newIndex >= this._queue.length) { this.stop(); return; }
    this.play(newIndex);
  }

  // ── modes ──
  setRepeatOne(on) {
    if (this._destroyed) return;
    this._repeatOne = !!on;
    this._notify();
  }

  // Exact existing algorithm (ported from playlist.js): shuffles only the
  // unplayed tail so playback history is never rewritten; turning shuffle
  // off restores the pre-shuffle snapshot verbatim and relocates the
  // currently-playing item in it so playback position doesn't jump.
  toggleShuffle() {
    if (this._destroyed) return;
    if (this._shuffleOn) {
      if (this._unshuffledQueue) {
        const playingId = this._idx !== -1 ? this._queue[this._idx].id : null;
        this._queue = this._unshuffledQueue;
        this._unshuffledQueue = null;
        if (playingId != null) {
          const restoredIdx = this._queue.findIndex(t => t.id === playingId);
          if (restoredIdx !== -1) this._idx = restoredIdx;
        }
      }
      this._shuffleOn = false;
    } else {
      this._unshuffledQueue = this._queue.slice();
      this._queue = this._idx === -1
        ? shuffleArray(this._queue.slice())
        : this._queue.slice(0, this._idx + 1).concat(shuffleArray(this._queue.slice(this._idx + 1)));
      this._shuffleOn = true;
    }
    this._notify();
  }

  // ── views ──
  mount(view) {
    if (this._destroyed) return () => {};
    this._views.add(view);
    view.onAttach(this);
    return () => this.unmount(view);
  }

  unmount(view) {
    if (this._views.delete(view)) view.onDetach();
  }

  // ── read-only state ──
  get state() { return this._state; }
  get currentItem() { return this._idx === -1 ? null : this._queue[this._idx]; }
  get currentIndex() { return this._idx; }
  get queue() { return this._queue.slice(); }
  get audioElement() { return this.audio; }

  // Full teardown. Without this, the native-audio listeners and Media Session
  // action handlers registered in the constructor would keep a reference to a
  // supposedly-destroyed controller alive and could still call back into it —
  // Media Session handlers in particular are global to the document, so a
  // stale one would hijack the lock-screen controls of whatever replaced it.
  destroy() {
    if (this._destroyed) return;
    ++this._gen;                       // invalidate any in-flight play() promise
    this._unclaim();
    this._views.forEach(v => v.onDetach());
    this._views.clear();
    this._abort.abort();               // removes every audio listener added in the constructor
    if (!this.audio.paused) this.audio.pause();
    if (this._mediaSessionEnabled) {
      ['play', 'pause', 'previoustrack', 'nexttrack'].forEach(action => {
        try { navigator.mediaSession.setActionHandler(action, null); } catch (e) { /* unsupported action */ }
      });
      navigator.mediaSession.metadata = null;
    }
    this._destroyed = true;
  }

  // ── internals ──
  _playIndex(index) {
    const item = this._queue[index];
    if (!item) return Promise.resolve();
    const gen = ++this._gen;
    this._idx = index;
    // Capture BEFORE _setState('loading') overwrites it. A rejected play()
    // promise puts the controller in 'error' without ever setting audio.error,
    // so checking after would silently skip the reload on exactly that path.
    const retrying = this._state === 'error' || !!this.audio.error;
    this._setState('loading');
    // Assign src BEFORE notifying views, and notify BEFORE play().
    //
    // Order matters in both directions and is load-bearing:
    //  - src before notify, because a view that upgrades to a WaveSurfer
    //    instance wrapping this element reads its src at construction. If the
    //    element has no src yet, WaveSurfer captures url="" and its deferred
    //    init calls setSrc("", peaks) — which, seeing a src that appeared in
    //    the meantime, calls removeAttribute("src") and kills playback.
    //    Constructing it after assignment makes that call a no-op early return.
    //  - notify before play(), so views can render the pending/active state
    //    synchronously within whatever user gesture led here.
    // Retrying a failed item needs a genuinely fresh load: a media element
    // holding an error won't recover on play() alone, and the src it failed on
    // is the same string we'd otherwise skip reassigning.
    if (retrying) this._currentSrc = null;
    if (this._currentSrc !== item.streamUrl) {
      this._currentSrc = item.streamUrl;
      this.audio.src = item.streamUrl;
      if (retrying && this.audio.load) this.audio.load();
    }
    this._updateMediaMetadata();
    this._notify();
    const p = this.audio.play();
    if (p && p.catch) {
      return p.catch(err => { if (gen === this._gen) this._handleError(err); });
    }
    return Promise.resolve();
  }

  _handleError(err) {
    if (err && err.name === 'AbortError') return; // pause()/a newer play() interrupted this one — not a real failure
    this._setState('error');
    this._notify();
  }

  _setState(state) { this._state = state; }

  _syncMediaPlaybackState() {
    if (this._mediaSessionEnabled) navigator.mediaSession.playbackState = this.audio.paused ? 'paused' : 'playing';
  }

  // Guarded separately from the action handlers: a browser can expose
  // mediaSession without MediaMetadata, and metadata is the more expendable
  // half — losing it must not cost the lock-screen controls too.
  _updateMediaMetadata() {
    if (!this._mediaSessionEnabled || typeof MediaMetadata === 'undefined') return;
    const item = this.currentItem;
    if (!item) { navigator.mediaSession.metadata = null; return; }
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: item.title,
        artist: item.artist,
        album: [item.venue, item.dateDisplay].filter(Boolean).join(' '),
        artwork: [{ src: 'https://renedebos.com/assets/artwork.png', sizes: '512x512', type: 'image/png' }],
      });
    } catch (e) { /* metadata is a nicety; never let it break playback */ }
  }

  // The state views render from. Public so a view mounting mid-playback can
  // paint the correct state immediately instead of waiting for the next event.
  snapshot() {
    return {
      state: this._state,
      currentItem: this.currentItem,
      currentIndex: this._idx,
      queue: this._queue,
      repeatOne: this._repeatOne,
      shuffleOn: this._shuffleOn,
    };
  }

  _notify() {
    const snapshot = this.snapshot();
    this._views.forEach(v => v.onControllerUpdate(snapshot));
  }
}
