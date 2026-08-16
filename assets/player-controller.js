// Shared playback engine — one PlaybackController per document, owning the
// sole <audio> element, queue, and transport/shuffle/repeat state for every
// PlayerView mounted on the page. Replaces the per-row/per-page <audio>
// elements and hand-duplicated queue logic in player.js, wavesurfer.js,
// playlist.js, and continuous-player.js (see plans/player-consolidation/).
//
// Show pages (Phase 1), /playlist/ (Phase 2), and song pages (Phase 3 Stage
// 3a-foundation, via song-boot.js) all run this now. /player/'s popup is
// still the one holdout engine — the queue/shuffle/repeat/reorder surface
// was built general enough to be its foundation too, but that migration
// hasn't happened yet (tracked as a later Phase 3 stage in
// plans/dynamic-hugging-rossum.md, alongside the sticky mini-player itself).

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

// /playlist/'s queues come from a URL hash or localStorage — attacker/other-
// origin-influenced, unlike a show page's build-time-bounded markup. A cheap
// backstop here (the real validation/truncation-with-a-message happens at
// the page's own parse boundary) so nothing can hand the controller an
// unbounded array no matter which caller it came through.
const MAX_QUEUE_ITEMS = 1000;

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
  // onQueueExhausted(reason): called ('ended'|'next') when playback would
  // otherwise stop/end past the last queue item, in place of that terminal
  // behavior — return truthy if the page handled it (it's expected to have
  // called setQueue() itself already) and the controller does nothing
  // further; absent, or falsy, and today's ended/stop() behavior proceeds
  // unchanged. Exists because nothing else lets a page distinguish "reached
  // the end of an endless queue" from "the user pressed Stop" (both land on
  // 'idle' via stop()), or intercept Media Session's nexttrack at all (it's
  // registered inside this constructor). Show pages pass nothing.
  //
  // onExternalClaim: called when this controller's own claim-listener below
  // pauses playback because another tab/controller claimed it — the only way
  // a page can tell an external-claim pause apart from a user-initiated one,
  // needed for a "paused — playback started somewhere else" status message
  // without reaching for the ambient legacy onExternalClaim(fn, owner)
  // global. Show pages pass nothing and are unaffected.
  //
  // onAnyExternalClaim: a SECOND, unconditional callback invoked on every
  // external claim regardless of this controller's current state — added for
  // Phase 3 Stage 3a-foundation's durable cross-tab ownership bookkeeping
  // (see miniplayer-state.js), which needs to learn about a claim even while
  // this controller was already paused (onExternalClaim's gating below is
  // correct and unchanged for ITS purpose — e.g. not showing a false "paused
  // elsewhere" message on an already-paused tab — but that same gating means
  // it can never fire for a merely-restored, never-played tab, which is
  // exactly the case ownership tracking needs to observe). No caller in this
  // stage; built and available for the mini-player boot script a later stage
  // adds.
  constructor({ audio = new Audio(), mediaSession = true, onQueueExhausted = null,
                onExternalClaim: onExternalClaimCallback = null,
                onAnyExternalClaim = null } = {}) {
    this.audio = audio;
    this.audio.preload = 'none';
    this._onQueueExhausted = onQueueExhausted;
    this._onExternalClaimCallback = onExternalClaimCallback;
    this._onAnyExternalClaim = onAnyExternalClaim;

    this._queue = [];
    this._idx = -1;
    this._queueRevision = 0;  // bumped by every operation that changes queue membership/order
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
    // Structured result of the most recent failed play attempt — see
    // _handleError()/snapshot(). play() itself always resolves (never
    // rejects; _playIndex()'s internal .catch() below sees to that), so this
    // is the only way a caller can observe WHY an attempt failed, including
    // telling a blocked-autoplay NotAllowedError apart from a real decode/
    // network error. Cleared at the start of every fresh _playIndex() attempt.
    this._lastPlayError = null;

    this._unclaim = onExternalClaim(this, () => {
      if (this._onAnyExternalClaim) this._onAnyExternalClaim();
      if (this._state === 'playing' || this._state === 'loading') {
        this.pause();
        if (this._onExternalClaimCallback) this._onExternalClaimCallback();
      }
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
      if (this._onQueueExhausted && this._onQueueExhausted('ended')) return;
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
    this._queue = items.slice(0, MAX_QUEUE_ITEMS).map(normalizeItem);
    ++this._queueRevision;
    this._shuffleOn = false;
    this._unshuffledQueue = null;
    if (startIndex >= 0 && startIndex < this._queue.length) {
      this._idx = startIndex;
      // Returns the play promise so callers can sequence after playback has
      // actually started (a view seeking to a tapped waveform position, say).
      if (autoplay) return this._playIndex(startIndex);
      // Cued but not playing: whatever the element was playing belongs to the
      // queue we just discarded, so stop it rather than leave audible playback
      // disagreeing with currentItem and the published queue. Explicit 'idle'
      // (not just leaving state as-is): otherwise a setQueue() arriving right
      // after a previous queue ended/errored — e.g. hash hydration after an
      // endless-mode rollover — inherits that stale terminal state even
      // though a perfectly playable track is now cued.
      if (!this.audio.paused) this.audio.pause();
      this._setState('idle');
    } else {
      this._idx = -1;
      this._setState('idle');
      if (!this.audio.paused) this.audio.pause();
    }
    this._notify();
  }

  appendQueue(items) {
    if (this._destroyed) return 0;
    const room = Math.max(0, MAX_QUEUE_ITEMS - this._queue.length);
    if (room === 0) return 0;
    // Cap the INPUT before doing any per-item work, not just the output --
    // otherwise an oversized (untrusted-input-derived) array still costs
    // O(items.length) normalization/validation even though at most `room`
    // of it could ever be kept. Trade-off: if the first `room` raw items
    // happen to contain more duplicates-of-existing-ids than real fresh
    // ones, fewer fresh items land than a full scan would have found --
    // acceptable for a defensive backstop (this has no caller yet in this
    // phase; see MAX_QUEUE_ITEMS's own comment).
    const existing = new Set(this._queue.map(t => t.id));
    const fresh = items.slice(0, room).map(normalizeItem).filter(t => !existing.has(t.id));
    if (fresh.length) {
      this._queue = this._queue.concat(fresh);
      // Keep the shuffle-off restore snapshot in sync -- otherwise an item
      // appended while shuffle is on survives in _queue but vanishes the
      // moment toggleShuffle() restores from a snapshot that never got it.
      if (this._unshuffledQueue) this._unshuffledQueue = this._unshuffledQueue.concat(fresh);
      ++this._queueRevision;
      this._notify();
    }
    return fresh.length;
  }

  // Hydrates the controller from a persisted session envelope (Phase 3
  // Stage 3a-foundation's miniplayer-state.js codec) — deliberately separate
  // from setQueue(), which every live call site also uses today, so
  // overloading its contract risks a footgun elsewhere (setQueue()'s
  // autoplay:false branch is a "cue, don't play" operation for a queue the
  // CALLER already has fully in hand; restoreSession() is "reconstruct a
  // session from storage", a different enough shape — resolving an id
  // instead of an index, deferring the seek — to earn its own method).
  //
  // No caller in this stage: a later stage's mini-player boot script is the
  // first real consumer. Implemented and unit-tested now per the plan.
  //
  // Takes an id, not a raw index, because currentItemId has to survive a
  // queue that was filtered on read (a corrupt persisted entry dropped) —
  // an index recorded before filtering could point at the wrong item
  // afterward, or past the end; an id resolved AFTER filtering cannot.
  //
  // Explicitly assigns audio.src: setQueue(items, {autoplay:false}) does NOT
  // do this (only _playIndex() does), so a restore built on setQueue() alone
  // would leave nothing loaded/seekable — verified directly against
  // setQueue()'s own body above.
  //
  // Seeks to positionSec only once the browser actually reports a duration
  // (the 'loadedmetadata' event) — seeking earlier is unreliable/a no-op in
  // several browsers. That deferred seek is guarded by `_queueRevision`
  // (captured at restore time) plus the restored item's own id — NOT `_gen`
  // (implementation review finding #4, 2026-08-15): `_playIndex()` bumps
  // `_gen` unconditionally on every single play() attempt, including one
  // that simply RESUMES the exact item this restore just cued (the plan's
  // own "attempt play() only when permitted" resume flow) — a `_gen` guard
  // would invalidate the deferred seek before metadata ever has a chance to
  // load, silently losing the restored position on the most common resume
  // path. `_queueRevision` only changes when the queue's membership/order
  // actually changes (setQueue/appendQueue/restoreSession/removeAt/reorder/
  // toggleShuffle) — never by play()/pause()/seek() themselves — so it
  // survives a same-item resume while still being invalidated by a genuinely
  // new restore or queue mutation; the item-id check on top of it additionally
  // covers the user navigating within the SAME queue (next()/prev()/a
  // different row's singleton) to a different track before metadata loads,
  // which changes `_idx` without bumping `_queueRevision` at all.
  //
  // Shuffle-restoration is an honest, documented limitation, not hidden: a
  // restored queue is already in whatever order it was saved in (already
  // shuffled, if shuffleOn was true when saved), but the ORIGINAL pre-shuffle
  // order was never persisted (miniplayer-state.js's codec doesn't carry it —
  // see its own comment), so _unshuffledQueue starts null here. Toggling
  // shuffle off after a restore therefore can't reorder back to the literal
  // pre-shuffle order — toggleShuffle() already degrades gracefully for
  // exactly this case (flips the flag, leaves the queue order as-is, rather
  // than throwing or losing items), so nothing further is needed here.
  restoreSession({ queue = [], currentItemId = null, repeatOne = false,
                    shuffleOn = false, positionSec = 0 } = {}) {
    if (this._destroyed) return;
    ++this._gen; // invalidates any in-flight play() promise from BEFORE this restore
    this._queue = queue.slice(0, MAX_QUEUE_ITEMS).map(normalizeItem);
    ++this._queueRevision;
    const queueRevision = this._queueRevision; // captured for the deferred seek below
    this._repeatOne = !!repeatOne;
    this._shuffleOn = !!shuffleOn;
    this._unshuffledQueue = null;
    if (!this.audio.paused) this.audio.pause();

    const idx = currentItemId != null
      ? this._queue.findIndex(t => t.id === currentItemId) : -1;
    if (idx === -1) {
      this._idx = -1;
      this._setState('idle');
      this._updateMediaMetadata();
      this._notify();
      return;
    }
    this._idx = idx;
    const item = this._queue[idx];
    this._currentSrc = item.streamUrl;
    this.audio.src = item.streamUrl;
    // Cued, not playing — matches setQueue()'s own "idle" convention for a
    // queue that has a valid currentItem but nothing actually playing yet
    // (see setQueue()'s non-autoplay branch above). Restoring visual state
    // immediately and attempting play() only when explicitly permitted is
    // the plan's own decision (no promise of automatic resume on restore).
    this._setState('idle');
    this._updateMediaMetadata();
    this._notify();

    if (positionSec > 0) {
      const restoredItemId = item.id;
      const onMeta = () => {
        // Superseded by a genuinely new restore or queue mutation -- do not
        // seek a stale track. Deliberately NOT `_gen` -- see this method's
        // own comment above for why that would also (incorrectly) block a
        // plain resume of the very item just restored.
        if (this._queueRevision !== queueRevision) return;
        // The queue itself hasn't changed, but the CURRENT item might have
        // (next()/prev()/a different singleton click, none of which bump
        // _queueRevision) -- only seek if we're still looking at the exact
        // item this restore cued.
        if (this._idx === -1 || this._queue[this._idx].id !== restoredItemId) return;
        this.seek(positionSec);
      };
      this.audio.addEventListener('loadedmetadata', onMeta, { once: true, signal: this._abort.signal });
    }
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
    ++this._queueRevision;
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
    ++this._queueRevision;
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
    if (newIndex >= this._queue.length) {
      // Only the forward direction (Next) can run off the end of a queue in
      // a way a page might want to handle (e.g. endless-mode rollover) --
      // prev() past index 0 is handled by its own early return above this
      // call and never reaches here for a reason to report.
      if (dir > 0 && this._onQueueExhausted && this._onQueueExhausted('next')) return;
      this.stop();
      return;
    }
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
    ++this._queueRevision;
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
      // audio.pause() above fired 'pause', but its listener was already
      // removed by _abort.abort() a moment earlier, so it never ran
      // _syncMediaPlaybackState() -- left uncorrected here, the lock screen
      // would keep reporting "playing" for a controller that no longer
      // exists. 'none' (not 'paused'), since there's no session at all now.
      navigator.mediaSession.playbackState = 'none';
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
    this._lastPlayError = null; // a fresh attempt starts clean; see its own field comment
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
    // err.name distinguishes a blocked-autoplay NotAllowedError from any
    // other failure; a native audio 'error' event (this.audio.error, a
    // MediaError) has no .name at all, which still correctly falls through
    // to null here rather than being mistaken for NotAllowedError.
    this._lastPlayError = { name: (err && err.name) || null, message: (err && err.message) || null };
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
      queueRevision: this._queueRevision,
      repeatOne: this._repeatOne,
      shuffleOn: this._shuffleOn,
      lastPlayError: this._lastPlayError,
    };
  }

  // Isolated per view: _playIndex() calls this BEFORE audio.play() (see its
  // ordering note), so an exception escaping one view's render (e.g. a
  // WaveSurfer construction failure) must not stop the others from updating
  // or propagate back up and block play() itself. Same principle as
  // player-boot.js's attachPeaks() isolating one row's setPeaks() failure.
  _notify() {
    const snapshot = this.snapshot();
    this._views.forEach(v => {
      try { v.onControllerUpdate(snapshot); }
      catch (e) { console.error('[player-controller] a view threw from onControllerUpdate', e); }
    });
  }
}
