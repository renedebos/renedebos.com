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

// Every play button carries the track it controls in data-play-label (song,
// artist, date) so a screen reader hears "Play <track>" / "Pause <track>"
// instead of an undifferentiated "Play" repeated on every row.
function setPlayState(btn, playing, iconHtml) {
  btn.innerHTML = iconHtml;
  const label = btn.dataset.playLabel;
  btn.setAttribute('aria-label', label ? `${playing ? 'Pause' : 'Play'} ${label}` : (playing ? 'Pause' : 'Play'));
}

let activePlayer = null;
const RANGE_MAX = 1000;

// ── playback coordination (same page + other tabs/windows) ──────────────────
// Show/song-page track players, waveform rows (driven by the shared
// PlaybackController where mounted, or dormant otherwise — wavesurfer.js,
// the module that used to drive them here, was removed in Step 5c),
// and /playlist/ each own an independent <audio>
// element with no shared engine, so playing one doesn't pause the others.
// A claim announces
// "I'm playing now": it's broadcast to every other tab/window AND delivered
// to every other player on the same page — BroadcastChannel never delivers
// to the posting page itself, and a show page mixes two independent systems
// (waveform track rows + the Full Recording custom player). `owner` is any
// stable per-player value; a claim skips the listener with the same owner so
// a player never pauses itself.
let playbackChannel = null;
try { playbackChannel = new BroadcastChannel('hannan-playback'); } catch (e) { /* unsupported / private browsing */ }
const playbackId = Math.random().toString(36).slice(2);
const claimListeners = [];
function claimPlayback(owner) {
  if (playbackChannel) playbackChannel.postMessage(playbackId);
  claimListeners.forEach(l => { if (l.owner !== owner) l.fn(); });
}
function onExternalClaim(fn, owner) {
  claimListeners.push({ fn, owner });
}
if (playbackChannel) {
  playbackChannel.onmessage = e => {
    if (e.data !== playbackId) claimListeners.forEach(l => l.fn());
  };
}
window.claimPlayback = claimPlayback;
window.onExternalClaim = onExternalClaim;

// Wires up every .custom-player under `root` that isn't already initialized.
// Runs once for the whole document on load; the Songs page also calls this
// itself (see songs.js) after inserting a song's performance rows lazily, so
// those newly-added players get the same play/pause/seek wiring.
function initCustomPlayers(root) {
  root.querySelectorAll('.custom-player').forEach(player => {
    if (player._audio) return;
    const src = player.dataset.src;
    // Loudness variant. `data-src` is always the -20 archive URL; the row's
    // data-item (where it has one) carries the -14 render. This is the LEGACY
    // fallback engine — it only runs when the shared PlaybackController never
    // mounted — but the page still says in words which version is playing, so
    // it has to honour the same preference. Read through the window bridge
    // (variant-pref.js) rather than re-implementing it; absent bridge, or a
    // row with no variant, means the archive, which is the safe direction.
    let loudSrc = null;
    try { loudSrc = (JSON.parse(player.dataset.item || '{}') || {}).loudUrl || null; } catch (_) { /* not a playable row */ }
    const resolveSrc = () => {
      const v = window.HannanVariant;
      return (loudSrc && v && v.get() === 'loud') ? loudSrc : src;
    };
    const audio = new Audio();
    audio.preload = 'none';

    const btn = player.querySelector('.play-btn');
    const range = player.querySelector('.progress-range');
    const currentEl = player.querySelector('.current');
    // Compact track rows store their catalog duration on the one available
    // time label. Larger players render elapsed and total in separate labels.
    const compactDuration = currentEl.dataset.duration || '';
    const separateDurationEl = player.querySelector('.time-row .time-label:not(.current)');
    const totalDuration = compactDuration || (separateDurationEl ? separateDurationEl.textContent.trim() : '');

    let loaded = false;
    let seeking = false;

    onExternalClaim(() => {
      if (!audio.paused) { audio.pause(); setPlayState(btn, false, playIcon); }
    }, player);

    function load() {
      if (!loaded) { audio.src = resolveSrc(); loaded = true; }
    }

    // Re-point at the other render of the same performance, keeping position
    // and play state (same contract as PlaybackController._onVariantChanged()).
    // Untouched rows stay unloaded and simply pick the new variant up the
    // first time they're played.
    if (loudSrc) {
      window.addEventListener('hannanvariantchange', () => {
        if (!loaded) return;
        const want = resolveSrc();
        if (want === audio.src) return;
        const at = audio.currentTime || 0;
        const wasPlaying = !audio.paused;
        audio.src = want;
        const restore = () => {
          try { if (at > 0) audio.currentTime = at; } catch (_) { /* unseekable */ }
          if (wasPlaying) { const pr = audio.play(); if (pr && pr.catch) pr.catch(() => {}); }
        };
        if (audio.readyState >= 1) restore();
        else audio.addEventListener('loadedmetadata', restore, { once: true });
      });
    }

    function setFill(pct) {
      // backgroundImage, not the `background` shorthand — see .progress-range
      // in site.css: the shorthand would inflate the 3px rail to 24px.
      range.style.backgroundImage = `linear-gradient(to right, var(--accent) ${pct}%, var(--border) ${pct}%)`;
    }

    function setTime(seconds) {
      const elapsed = formatTime(seconds);
      currentEl.textContent = compactDuration ? `${elapsed} / ${compactDuration}` : elapsed;
      range.setAttribute('aria-valuetext', totalDuration ? `${elapsed} of ${totalDuration}` : elapsed);
    }

    audio.addEventListener('timeupdate', () => {
      const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
      if (!seeking) {
        range.value = Math.round(pct * RANGE_MAX / 100);
        setFill(pct);
      }
      setTime(audio.currentTime);
    });

    audio.addEventListener('waiting', () => {
      btn.innerHTML = loadingIcon;
    });

    audio.addEventListener('playing', () => {
      setPlayState(btn, true, pauseIcon);
      activePlayer = player;
    });

    audio.addEventListener('play', () => {
      player.classList.add('playing');
      claimPlayback(player);
      // A deep-linked track (see focusHashTrack) stays highlighted until some
      // other track actually starts playing.
      document.querySelectorAll('.track-row.target').forEach(r => { if (r !== player) r.classList.remove('target'); });
    });
    audio.addEventListener('pause', () => player.classList.remove('playing'));

    audio.addEventListener('ended', () => {
      setPlayState(btn, false, playIcon);
      range.value = 0;
      setFill(0);
      setTime(0);
      player.classList.remove('playing');
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
            if (a && !a.paused) { a.pause(); setPlayState(p.querySelector('.play-btn'), false, playIcon); }
          }
        });
        audio.play().catch(() => setPlayState(btn, false, playIcon));
        setPlayState(btn, true, audio.readyState < 3 ? loadingIcon : pauseIcon);
      } else {
        audio.pause();
        setPlayState(btn, false, playIcon);
      }
    });

    // Native range: dragging, clicking, and arrow-key seeking all fire 'input'
    // uniformly, so this one handler covers mouse, touch, and keyboard.
    range.addEventListener('mousedown', () => { seeking = true; });
    range.addEventListener('touchstart', () => { seeking = true; });
    range.addEventListener('input', () => {
      load();
      const pct = (range.value / RANGE_MAX) * 100;
      setFill(pct);
      if (audio.duration) audio.currentTime = (pct / 100) * audio.duration;
    });
    range.addEventListener('change', () => { seeking = false; });

    player._audio = audio;
  });
}
window.initCustomPlayers = initCustomPlayers;

// ── engine selection ─────────────────────────────────────────────────────────
// A page migrated to the shared PlaybackController (see player-boot.js and
// plans/player-consolidation/) sets window.PLAYER_ENGINE = 'controller' inline
// BEFORE this script, so the decision exists before any legacy code runs — a
// guard checked later could never win, since these registrations would already
// have happened.
//
// Rather than bail outright on that flag, this defers: player-boot.js is a
// module and so runs before DOMContentLoaded, setting PLAYER_ENGINE_MOUNTED
// only if it actually mounted. If it 404s, fails to parse, or throws, the flag
// stays unset and everything here initializes normally. A static "don't init"
// flag would instead leave such a page with no player at all on any module or
// asset failure — a regression, not a fallback.
//
// All three playback registrations are gated, not just the mount: two live
// deep-link handlers would both scroll and mutate .target and could both act
// on ?autoplay=1, and the legacy Space listener would swallow Space with no
// legacy player behind it. Downloads, share, and tooltips are untouched —
// they aren't playback.
//
// (Each helper below is a hoisted function declaration, so this block can sit
// where the original unconditional initCustomPlayers(document) call did and
// keep the legacy path's ordering byte-for-byte identical.)
function initLegacyPlayback() {
  initCustomPlayers(document);
  initLegacySpaceBar();
  initLegacyDeepLink();
}

// DOMContentLoaded, not a readyState check: readyState is already 'interactive'
// while deferred/module scripts run, so a "past loading, just go" shortcut would
// initialize this before player-boot.js (a module, and later in the document)
// ever got to claim the page. The actual guarantee (HTML Standard's parsing/
// script-processing model, confirmed in the Step 4 review — see wavesurfer.js
// for the fuller note): build.py emits every script here as an ordinary
// parser-inserted <script> in document order, and that whole ordered list runs
// before DOMContentLoaded is even queued, so registering this listener in the
// same synchronous parse job is always in time. Narrower than "any script
// placement" — a dynamically inserted or differently-scheduled script isn't
// covered by this argument, only build.py's own output is.
if (window.PLAYER_ENGINE === 'controller') {
  document.addEventListener('DOMContentLoaded', () => {
    if (!window.PLAYER_ENGINE_MOUNTED) initLegacyPlayback();
  });
} else {
  initLegacyPlayback();
}

function initLegacySpaceBar() {
  document.addEventListener('keydown', e => {
    if (e.code !== 'Space') return;
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
    e.preventDefault();
    if (!activePlayer) return;
    const audio = activePlayer._audio;
    const btn = activePlayer.querySelector('.play-btn');
    if (audio.paused) {
      audio.play().catch(() => setPlayState(btn, false, playIcon));
      setPlayState(btn, true, loadingIcon);
    } else {
      audio.pause();
      setPlayState(btn, false, playIcon);
    }
  });
}

// ── downloads ────────────────────────────────────────────────────────────────
// All downloads are password protected: every download button goes through
// the password modal (/auth issues an HMAC token for /download). Streaming
// is the only ungated path.

const modal = document.createElement('div');
modal.className = 'pw-overlay';
modal.id = 'pwOverlay';
modal.innerHTML = `
  <div class="pw-modal">
    <h3>Protected Download</h3>
    <p>This recording is password protected. Enter the password to download.</p>
    <p class="pw-size" id="pwSize" hidden></p>
    <fieldset class="pw-variant" id="pwVariant" hidden>
      <legend>Version</legend>
      <label><input type="radio" name="pwVariant" value="archive" checked>
        <span class="pw-variant-name" id="pwArchiveName">Archive</span>
        <span class="pw-variant-sub" id="pwArchiveSub"></span></label>
      <label><input type="radio" name="pwVariant" value="lossy">
        <span class="pw-variant-name" id="pwLossyName"></span>
        <span class="pw-variant-sub" id="pwLossySub"></span></label>
    </fieldset>
    <input type="password" id="pwInput" placeholder="Password" autocomplete="off">
    <div class="pw-modal-error" id="pwError"></div>
    <div class="pw-modal-actions">
      <button class="pw-cancel" id="pwCancel">Cancel</button>
      <button class="pw-submit" id="pwSubmit">Download</button>
    </div>
  </div>`;
document.body.appendChild(modal);

// Non-blocking progress toast — once a batch ZIP's password is confirmed,
// the modal hands off to this so the visitor can keep browsing/playing
// tracks on the page while the rest fetch/zip in the background. Cancel
// here works the same as the modal's: aborts the in-flight batch.
const toast = document.createElement('div');
toast.className = 'dl-toast';
toast.innerHTML = `
  <span class="dl-toast-text"></span>
  <button type="button" class="dl-toast-cancel" id="toastCancel" aria-label="Cancel download">&times;</button>`;
document.body.appendChild(toast);
const toastText = toast.querySelector('.dl-toast-text');

function showToast() {
  toast.classList.remove('error');
  toast.classList.add('open');
}
function setToastText(text, isError) {
  toastText.textContent = text;
  toast.classList.toggle('error', !!isError);
}
function hideToast() {
  toast.classList.remove('open', 'error');
}
toast.querySelector('#toastCancel').addEventListener('click', () => {
  if (batchAbort) batchAbort.abort();
});

// pendingTarget is either { type: 'single', file, filename } (today's one-file
// flow) or { type: 'batch', manifest: {zipName, files:[{key,name}], infoName,
// infoText} } — a whole show or every performance of a song, assembled into a
// ZIP client-side after a single password entry. See tryBatchDownload below.
let pendingTarget = null;

// Set for the duration of a batch fetch/zip. While the modal is still up
// (validating the password against the first file) this blocks accidental
// dismissal the same way it always has; once that first file succeeds the
// modal hands off to the toast above and closes, so batchAbort staying set
// no longer blocks anything — it just means Cancel (on either the modal or
// the toast) can still stop the in-flight batch.
let batchAbort = null;

// Whether this target has a lossy counterpart at all. Two different things
// qualify and they are NOT interchangeable -- see the label table below. A ZIP
// only qualifies when EVERY file in it does; see _loud_zip() in
// sitegen/fragments.py for why that is all-or-nothing.
function targetHasLossy(target) {
  if (!target) return false;
  return target.type === 'batch' ? !!(target.manifest && target.manifest.loud)
                                 : !!target.lossyFile;
}

// What the two options are CALLED depends on what the lossy one actually is.
// Getting this wrong would put a false claim about the audio in front of
// someone at the moment they download it:
//
//   loud -- a curated track's -14 LUFS variant: louder AND lossy, and the
//           archive side is a -20 LUFS mastered FLAC.
//   mp3  -- a whole-show recording's 320 kbps stream proxy: lossy but NOT
//           re-levelled (make_stream_mp3.py applies no gain, only a
//           lossy-overshoot safety trim), and the archive side is the raw
//           transfer, which was never normalized to -20 at all.
//
// So neither label is reusable across the two. `losslessFormat` fills in
// WAV vs FLAC, since whole-show transfers are mostly WAV but not all.
function variantLabels(target) {
  const kind = target && target.type === 'batch' ? 'loud' : (target && target.lossyKind) || 'loud';
  const sizes = targetSizes(target);
  const withSize = (sub, size) => (size ? sub + ' \u00b7 ' + size : sub);
  if (kind === 'mp3') {
    const fmt = (target.filename || '').split('.').pop().toUpperCase() || 'WAV';
    return {
      archiveSub: withSize('lossless ' + fmt + ' \u00b7 the original transfer', sizes.archive),
      lossyName: 'MP3',
      lossySub: withSize('320\u2009kbps \u00b7 not lossless', sizes.lossy),
    };
  }
  return {
    archiveSub: withSize('lossless FLAC \u00b7 \u221220 LUFS \u00b7 the master', sizes.archive),
    lossyName: 'Loud',
    lossySub: withSize('MP3 320\u2009kbps \u00b7 \u221214 LUFS \u00b7 not lossless', sizes.lossy),
  };
}

// The size label of each version of a target, either of which may be missing.
// A whole show is several hundred MB, so someone on cellular deserves the
// number before committing -- and the modal opens before any byte moves, so
// this is still "before the tap". The sizes live HERE rather than on the
// buttons because every download has two formats and one figure on a button
// face could only describe one of them. Batches carry the labels on the
// manifest (sitegen/fragments.py for show/song ZIPs, playlist-boot.js for the
// playlist one); single files carry them as data-size / data-lossy-size on
// the button (dl_button()).
function targetSizes(target) {
  if (!target) return { archive: null, lossy: null };
  if (target.type === 'batch') {
    const m = target.manifest || {};
    return { archive: m.size || null, lossy: (m.loud && m.loud.size) || null };
  }
  return { archive: target.size || null, lossy: target.lossySize || null };
}

// What to call the file on the size line when there is no chooser to put the
// size on: the extension of what will be saved, or ZIP for a batch.
function targetFormat(target) {
  if (target && target.type === 'batch') return 'ZIP';
  const ext = ((target && target.filename) || '').split('.').pop();
  return ext && ext !== target.filename ? ext.toUpperCase() : 'File';
}

// Keep in step with fmt_size_mb() in sitegen/fragments.py: the server builds
// the show/song ZIP size labels, this builds the playlist ZIP's. Integer,
// half-up GB rounding on purpose -- toFixed(1) and Python's :.1f round an
// exact .x5 differently, so a shared integer formula is what keeps a
// playlist's label identical to a show's for the same total.
function formatSizeMb(mb) {
  if (!mb) return null;
  if (mb < 1000) return mb + ' MB';
  const tenths = Math.floor((Math.round(mb) + 50) / 100);
  return Math.floor(tenths / 10) + '.' + (tenths % 10) + ' GB';
}

function openPasswordModal(target) {
  pendingTarget = target;
  document.getElementById('pwInput').value = '';
  document.getElementById('pwError').textContent = '';
  // Reset to Archive on every open, never carrying the last choice forward:
  // the two versions are different FORMATS, not just levels, so a sticky
  // preference would silently hand out lossy files for the rest of a session.
  // Archive is the master and the default everywhere.
  const archiveRadio = modal.querySelector('input[name="pwVariant"][value="archive"]');
  if (archiveRadio) archiveRadio.checked = true;
  const labels = variantLabels(target);
  document.getElementById('pwArchiveSub').textContent = labels.archiveSub;
  document.getElementById('pwLossyName').textContent = labels.lossyName;
  document.getElementById('pwLossySub').textContent = labels.lossySub;
  const hasLossy = targetHasLossy(target);
  document.getElementById('pwVariant').hidden = !hasLossy;
  // With the chooser hidden the sizes on its options are hidden too, so the
  // one size there is gets its own line: "WAV \u00b7 631 MB", "ZIP \u00b7 25.3 GB".
  const sizeEl = document.getElementById('pwSize');
  const size = targetSizes(target).archive;
  sizeEl.hidden = hasLossy || !size;
  sizeEl.textContent = sizeEl.hidden ? '' : targetFormat(target) + ' \u00b7 ' + size;
  modal.classList.add('open');
  setTimeout(() => document.getElementById('pwInput').focus(), 50);
}

// Reads the chooser at SUBMIT time, not at open time -- the visitor can change
// it after typing the password. Returns 'archive' when the control is hidden,
// which is the only correct answer for a target with no variant.
function chosenVariant() {
  const el = document.getElementById('pwVariant');
  if (!el || el.hidden) return 'archive';
  const picked = modal.querySelector('input[name="pwVariant"]:checked');
  return picked && picked.value === 'lossy' ? 'lossy' : 'archive';
}

// The (file, filename) or manifest actually being downloaded, after the
// version choice is applied. Resolving this in ONE place keeps /auth's
// filename, /download's key and the saved filename from ever disagreeing --
// /auth is called with the same key that /download is asked for.
function resolveTarget(target) {
  if (chosenVariant() !== 'lossy') return target;
  if (target.type === 'batch') {
    return { type: 'batch', manifest: target.manifest.loud || target.manifest };
  }
  return { type: 'single', file: target.lossyFile, filename: target.lossyName || target.filename };
}

function closeModal() {
  if (batchAbort) batchAbort.abort();
  modal.classList.remove('open');
  pendingTarget = null;
}

// Hides the modal WITHOUT aborting — used only when handing a validated
// batch off to the background toast, where batchAbort deliberately stays set.
function hideModalKeepBatch() {
  modal.classList.remove('open');
  pendingTarget = null;
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// Mints a token for one R2 key and fetches it — exactly today's single-file
// flow, reused per file in a batch. authFailed is set on a wrong password so
// callers can show the same "Incorrect password" message a single download
// would.
async function fetchWithToken(password, key, signal) {
  const authRes = await fetch(WORKER + '/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password, filename: key }),
    signal,
  });
  if (!authRes.ok) {
    const err = new Error('auth failed');
    err.authFailed = true;
    throw err;
  }
  const { token, expires } = await authRes.json();
  const dlRes = await fetch(WORKER + '/download?file=' + encodeURIComponent(key)
    + '&token=' + encodeURIComponent(token) + '&expires=' + expires, { signal });
  if (!dlRes.ok) throw new Error('download failed: ' + key);
  return dlRes;
}

// Fetches every file in the manifest (small concurrency cap — this is a
// courtesy to the Worker/R2, not a requirement) and assembles a ZIP entirely
// in the browser via the vendored client-zip. No server-side ZIP generation,
// no new Worker route — each file goes through the exact /auth + /download
// pair a single download already uses.
//
// The first file is fetched while the modal is still open, so a wrong
// password still interrupts immediately the way it always has. Once that
// confirms the password, control hands off to the non-blocking toast for
// the rest — a whole show can be a lot of tracks, and there's no reason to
// keep the visitor stuck on a blocking dialog for however long that takes.
async function tryBatchDownload(password, manifest) {
  const abort = new AbortController();
  batchAbort = abort;
  const files = manifest.files;
  const results = new Array(files.length);
  let totalBytes = 0;

  try {
    const firstRes = await fetchWithToken(password, files[0].key, abort.signal);
    totalBytes += parseInt(firstRes.headers.get('content-length') || '0', 10);
    results[0] = { input: firstRes, name: files[0].name };
  } catch (e) {
    batchAbort = null;
    throw e; // still shown in the modal — see tryDownload's catch
  }

  hideModalKeepBatch();
  showToast();
  let doneCount = 1;
  setToastText(`Fetching ${doneCount} / ${files.length} tracks…`);

  try {
    let nextIdx = 1;
    const CONCURRENCY = 4;
    async function worker() {
      while (nextIdx < files.length) {
        const i = nextIdx++;
        const res = await fetchWithToken(password, files[i].key, abort.signal);
        totalBytes += parseInt(res.headers.get('content-length') || '0', 10);
        results[i] = { input: res, name: files[i].name };
        doneCount++;
        setToastText(`Fetching ${doneCount} / ${files.length} tracks…`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(0, files.length - 1)) }, worker));
    if (manifest.infoName && manifest.infoText) {
      results.push({ input: manifest.infoText, name: manifest.infoName });
      totalBytes += new Blob([manifest.infoText]).size;
    }

    const { downloadZip } = await import('/assets/client-zip.js');
    const zipRes = downloadZip(results);
    const reader = zipRes.body.getReader();
    const chunks = [];
    let assembled = 0;
    setToastText('Assembling ZIP…');
    for (;;) {
      if (abort.signal.aborted) {
        reader.cancel();
        throw new DOMException('Cancelled', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      assembled += value.length;
      setToastText(totalBytes
        ? `Assembling ZIP… ${Math.min(99, Math.round(assembled / totalBytes * 100))}%`
        : 'Assembling ZIP…');
    }
    const blob = new Blob(chunks, { type: 'application/zip' });

    setToastText('Starting download…');
    const url = URL.createObjectURL(blob);
    hideToast();
    triggerDownload(url, manifest.zipName);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    if (e && e.name === 'AbortError') {
      hideToast();
    } else {
      setToastText('Download failed — please try again.', true);
      setTimeout(hideToast, 4000);
    }
  } finally {
    batchAbort = null;
  }
}

async function tryDownload() {
  const password = document.getElementById('pwInput').value;
  const submitBtn = document.getElementById('pwSubmit');
  // Resolve the Archive/lossy choice ONCE, here, and use only the result
  // below: /auth is called with the same key /download is then asked for.
  const target = resolveTarget(pendingTarget);
  submitBtn.disabled = true;
  submitBtn.textContent = '…';

  try {
    if (target.type === 'batch') {
      try {
        await tryBatchDownload(password, target.manifest);
      } catch (e) {
        if (e && e.name === 'AbortError') {
          // Deliberately cancelled via the Cancel button — closeModal()
          // already handled dismissal, nothing to report.
        } else if (e && e.authFailed) {
          document.getElementById('pwError').textContent = 'Incorrect password. Please try again.';
          document.getElementById('pwInput').value = '';
          document.getElementById('pwInput').focus();
        } else {
          document.getElementById('pwError').textContent = 'Download failed — please try again.';
        }
      }
      return;
    }

    const res = await fetch(WORKER + '/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, filename: target.file }),
    });

    if (!res.ok) {
      document.getElementById('pwError').textContent = 'Incorrect password. Please try again.';
      document.getElementById('pwInput').value = '';
      document.getElementById('pwInput').focus();
      return;
    }

    const { token, expires } = await res.json();
    closeModal();
    triggerDownload(
      WORKER + '/download?file=' + encodeURIComponent(target.file)
        + '&token=' + encodeURIComponent(token) + '&expires=' + expires,
      target.filename);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Download';
  }
}

document.getElementById('pwSubmit').addEventListener('click', tryDownload);
document.getElementById('pwCancel').addEventListener('click', closeModal);
document.getElementById('pwInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') tryDownload();
  // Escape is disabled mid-batch — Cancel is the one deliberate way to stop
  // an in-progress ZIP; a stray keypress shouldn't lose visibility into it.
  if (e.key === 'Escape' && !batchAbort) closeModal();
});
modal.addEventListener('click', e => {
  if (e.target === modal && !batchAbort) closeModal();
});

// Delegated on document, deliberately NOT a load-time
// querySelectorAll().forEach() snapshot. The row overflow menu
// (plans/row-menu/row-menu-plan.md) builds its Download item on first press,
// long after this file has run — a per-element binding would simply never
// reach it. The click would then follow the href to /stream, which the
// wav-download Worker 403s for every .flac by design, so the visitor gets a
// 403 instead of the password modal with nothing thrown and every test green.
// closest() also means the handler survives the icon <svg> inside the button
// being the actual event target.
document.addEventListener('click', e => {
  const btn = e.target.closest('a.download-btn');
  if (btn) {
    e.preventDefault();
    const fileParam = new URL(btn.href).searchParams.get('file');
    const displayName = btn.getAttribute('download') || decodeURIComponent(fileParam.split('/').pop());
    // data-lossy-* is emitted by dl_button() (sitegen/fragments.py): the -14
    // render on a curated track, the 320 kbps stream proxy on a whole-show
    // recording. data-lossy-kind says which, because the modal labels them
    // differently. Absent on anything with neither, which is what makes the
    // modal hide its version control there.
    openPasswordModal({
      type: 'single',
      file: fileParam,
      filename: displayName,
      lossyFile: btn.dataset.lossyFile || null,
      lossyName: btn.dataset.lossyName || null,
      lossyKind: btn.dataset.lossyKind || null,
      size: btn.dataset.size || null,
      lossySize: btn.dataset.lossySize || null,
    });
    return;
  }

  const zipBtn = e.target.closest('.zip-download-btn');
  if (zipBtn) {
    e.preventDefault();
    if (!window.ZIP_MANIFEST) return;
    // Only one batch at a time — a second click while one's already running
    // (in the modal or backgrounded to the toast) would race the same
    // batchAbort/toast state.
    if (batchAbort) return;
    openPasswordModal({ type: 'batch', manifest: window.ZIP_MANIFEST });
  }
});

// ── hover info tooltip ───────────────────────────────────────────────────────
// Any element with data-info='[["Label","Value"], ...]' shows a small card.

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const tip = document.createElement('div');
tip.className = 'info-tooltip';
document.body.appendChild(tip);
let tipFor = null;

function showTip(el) {
  if (tipFor === el) return;
  let pairs;
  try { pairs = JSON.parse(el.dataset.info); } catch { return; }
  tipFor = el;
  tip.innerHTML = '<dl>' + pairs.map(([k, v]) =>
    `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('') + '</dl>';
  tip.classList.add('show');
  const r = el.getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = Math.max(8, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 8));
  let top = r.top - th - 8;
  if (top < 8) top = r.bottom + 8;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

function hideTip() { tip.classList.remove('show'); tipFor = null; }

document.addEventListener('mouseover', e => {
  const el = e.target.closest('[data-info]');
  if (el) showTip(el);
});
document.addEventListener('mouseout', e => {
  const el = e.target.closest('[data-info]');
  if (el && !el.contains(e.relatedTarget)) hideTip();
});
window.addEventListener('scroll', hideTip, true);

// Per-track sharing used to live here (a .share-btn on every row, 3dc47fb9).
// Its markup went with the waveform rows on 2026-06-24 and the handler sat
// unreachable until 2026-08-21, when sharing moved to the mini-player bar:
// scripts/share.js, loaded by miniplayer-views.js on the first press.

// ── deep-link to a track ──────────────────────────────────────────────────────

function focusHashTrack() {
  if (!location.hash) return;
  let el;
  try { el = document.querySelector(location.hash); } catch { return; }
  if (el && el.classList.contains('track-row')) {
    // Persists until a different track starts playing (see the 'play' listener
    // above) rather than fading on a timer — a deep link should stay obvious.
    document.querySelectorAll('.track-row.target').forEach(r => { if (r !== el) r.classList.remove('target'); });
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('target');
    // Waveform rows (.ws-track) never autoplay here on purpose. On a
    // controller-engine page (every public show today) player-boot.js's own
    // deep-link handling covers them instead (see its header comment). On a
    // page rolled back via CONTROLLER_ENGINE_EXCLUDED_SLUGS, no engine
    // drives waveform rows at all since wavesurfer.js was removed in Step
    // 5c — clicking here would silently do nothing, same as before, just
    // for a different reason now.
    if (el.classList.contains('custom-player') && new URLSearchParams(location.search).get('autoplay') === '1') {
      const btn = el.querySelector('.play-btn');
      if (btn) btn.click();
    }
  }
}
function initLegacyDeepLink() {
  window.addEventListener('load', focusHashTrack);
  window.addEventListener('hashchange', focusHashTrack);
}

