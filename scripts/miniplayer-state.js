// Persisted-session codec + durable cross-tab ownership for the sticky
// mini-player (Phase 3 Stage 3a-foundation of plans/dynamic-hugging-
// rossum.md — see its "Blocker B, redesigned: single-commit fenced lease
// (2026-08-15)" section for the full reasoning this module is built
// against). Pure logic, no DOM/boot dependencies: every function that
// touches storage takes a storage-like object ({getItem,setItem,removeItem})
// as an explicit argument rather than reading `localStorage`/`sessionStorage`
// globals directly, so a test can inject a fake one (see
// scripts/test-miniplayer-state.mjs) the same way test-playlist-state.mjs
// injects a fake localStorage for playlist-boot.js.
//
// ── why this module was rewritten (2026-08-15) ──
// The original design kept an ownership "claim token" durably staged across
// TWO separate Storage objects (sessionStorage for tab identity/claim token,
// localStorage for the shared envelope), committed as a multi-step
// transaction (write one, then the other, roll back on partial failure). Five
// straight review rounds against that implementation each found — or
// confirmed — a real bug, every one the SAME shape: a rollback that could
// itself fail, leaving the two stores disagreeing. The fix here removes the
// shape entirely rather than further narrowing it: claimOwnership() is now
// exactly ONE localStorage.setItem() call, and the fencing credential (a
// "lease": {ownerId, ownerEpoch}) is NEVER persisted anywhere — it lives only
// in the caller's JS memory (wiped by navigation, which is exactly the
// lifetime a "was this write issued under the still-current claim" check
// needs) and is re-derived on a fresh page load by reading the one durable
// envelope (restoreLease()). See the plan doc for the full bug history.
//
// Nothing in this repo calls this module yet — no UI ships this stage. A
// later stage's mini-player boot script is the first real consumer; this is
// implemented and unit-tested now, ahead of it, per the plan.

// ── storage keys ────────────────────────────────────────────────────────
// localStorage (shared across tabs — the envelope itself):
export const STATE_KEY = 'miniPlayerState';
// sessionStorage (private per tab, survives same-tab navigation, resets on a
// new tab/window — exactly the lifetime tab identity and the revoked marker
// both need):
export const TAB_ID_KEY = 'miniPlayerTabId';
// The single most-recently-revoked owner epoch, if any — see
// isEpochRevoked()/revokeLease() below. A single value is safe here
// specifically BECAUSE revokeLease() only ever writes it when the given
// epoch still matches the CURRENT envelope (see revokeLease()'s own
// comment) — two earlier designs (2026-08-15) tried to fix a stale/delayed
// revocation of an OLDER epoch overwriting a NEWER one's already-recorded
// revocation first by comparing a single slot for equality (buggy: a
// stale call could win the overwrite), then by remembering a bounded SET
// of past epochs (still buggy: either an unreadable/corrupt read collapsed
// to "nothing recorded" before a subsequent successful write, silently
// discarding history, or enough stale calls could evict the one entry that
// still mattered via the cap — both confirmed by direct reproduction,
// `/review-step` findings, same day). The actual fix isn't remembering
// MORE — restoreLease() only ever checks revocation against whatever
// epoch the envelope CURRENTLY names, so a revocation for any OTHER epoch
// is provably irrelevant the moment it's attempted; gating the write on
// that check is what makes a single slot both correct and sufficient.
export const REVOKED_EPOCH_KEY = 'miniPlayerRevokedEpoch';

export const ENVELOPE_VERSION = 1;

// ── untrusted-input bounds (persisted-item codec) ──────────────────────────
// Deliberately its own cap, not a re-export of player-controller.js's
// MAX_QUEUE_ITEMS (1000) — this module has no dependency on that file at all
// (kept pure/DOM-free), and a storage-quota-driven bound is a genuinely
// different concern from the controller's own runtime queue cap, even though
// they happen to agree today.
export const MAX_PERSISTED_QUEUE_ITEMS = 1000;
const MAX_ID_LEN = 200;
const MAX_TITLE_LEN = 300;
const MAX_ARTIST_LEN = 200;
const MAX_DATE_LEN = 100;
const MAX_LABEL_LEN = 400;
const MAX_URL_LEN = 2000;

function boundedString(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

// Real booleans only — a corrupt string value ("true", 1, "yes") must not
// silently coerce to true. Anything that isn't literally `true`/`false`
// falls back to the caller-supplied default instead.
function strictBool(v, fallback) {
  return typeof v === 'boolean' ? v : fallback;
}

function finiteNonNegative(v, fallback) {
  return typeof v === 'number' && isFinite(v) && v >= 0 ? v : fallback;
}

// ── persisted-item codec ────────────────────────────────────────────────
// A slim projection of a controller queue item (player-controller.js's
// normalizeItem() shape), NOT that shape verbatim — omits every field a
// mini-bar never renders (peaksKey: no waveform in a mini-bar; the full
// downloads payload: a mini-bar links back to the page for downloads rather
// than re-implementing the password-gated flow) and bounds every string
// field's length, since this travels through localStorage (shared-origin,
// anything else on the site could have written it) rather than build-time-
// bounded markup.
export function encodeItem(item) {
  if (!item || typeof item !== 'object') throw new TypeError('playable item must be an object');
  const id = boundedString(item.id, MAX_ID_LEN);
  if (!id) throw new TypeError('playable item requires an id');
  const streamUrl = boundedString(item.streamUrl, MAX_URL_LEN);
  if (!streamUrl) throw new TypeError('playable item requires a streamUrl');
  return {
    id,
    kind: item.kind === 'recording' ? 'recording' : 'track',
    streamUrl,
    title: boundedString(item.title, MAX_TITLE_LEN) || 'Untitled',
    artist: boundedString(item.artist, MAX_ARTIST_LEN),
    dateDisplay: boundedString(item.dateDisplay, MAX_DATE_LEN) || null,
    durationSec: typeof item.durationSec === 'number' && isFinite(item.durationSec) && item.durationSec >= 0
      ? item.durationSec : null,
    playLabel: boundedString(item.playLabel, MAX_LABEL_LEN),
    pageUrl: boundedString(item.pageUrl, MAX_URL_LEN),
  };
}

// Encodes a controller's live queue for persistence: caps the queue length
// BEFORE mapping (verified: normalizeItem() does not cap at all — setQueue()
// does, via player-controller.js's own MAX_QUEUE_ITEMS — so a codec built on
// raw controller.queue output alone would need its own explicit cap; this
// is it), then dedupes by id (first occurrence wins), skipping any single
// malformed entry without discarding the rest of the queue around it.
export function encodeQueue(items) {
  const capped = Array.isArray(items) ? items.slice(0, MAX_PERSISTED_QUEUE_ITEMS) : [];
  const seen = new Set();
  const out = [];
  capped.forEach((raw) => {
    let item;
    try { item = encodeItem(raw); } catch (e) { return; }
    if (seen.has(item.id)) return;
    seen.add(item.id);
    out.push(item);
  });
  return out;
}

// decodeItem() is the read-path counterpart — deliberately re-validates
// everything rather than trusting encodeItem() already did (the value being
// decoded may not have come from encodeItem() at all: it came out of
// localStorage, writable by anything same-origin, possibly hand-edited).
function decodeItem(raw) {
  if (!raw || typeof raw !== 'object') throw new TypeError('persisted item must be an object');
  const id = boundedString(raw.id, MAX_ID_LEN);
  if (!id) throw new TypeError('persisted item requires an id');
  const streamUrl = boundedString(raw.streamUrl, MAX_URL_LEN);
  if (!streamUrl) throw new TypeError('persisted item requires a streamUrl');
  return {
    id,
    kind: raw.kind === 'recording' ? 'recording' : 'track',
    streamUrl,
    title: boundedString(raw.title, MAX_TITLE_LEN) || 'Untitled',
    artist: boundedString(raw.artist, MAX_ARTIST_LEN),
    dateDisplay: boundedString(raw.dateDisplay, MAX_DATE_LEN) || null,
    durationSec: typeof raw.durationSec === 'number' && isFinite(raw.durationSec) && raw.durationSec >= 0
      ? raw.durationSec : null,
    playLabel: boundedString(raw.playLabel, MAX_LABEL_LEN),
    pageUrl: boundedString(raw.pageUrl, MAX_URL_LEN),
  };
}

// ── envelope build/decode ──────────────────────────────────────────────
// Builds a fresh, fully-validated envelope from live session data (a
// controller's own state, plus the ownerId/ownerEpoch the caller has already
// decided on — see claimOwnership()/writeSession() below for how that
// decision gets made).
export function buildEnvelope({ queue, currentItemId, positionSec, playing,
                                  repeatOne, shuffleOn, ownerId, ownerEpoch } = {}) {
  const encodedQueue = encodeQueue(queue);
  const wantId = typeof currentItemId === 'string' ? currentItemId : null;
  return {
    version: ENVELOPE_VERSION,
    queue: encodedQueue,
    // currentItemId resolved against the (already-capped/deduped) queue, not
    // trusted verbatim -- an id for an item that got capped out of the
    // persisted queue must not be recorded as "current" with nothing to back it.
    currentItemId: wantId != null && encodedQueue.some((t) => t.id === wantId) ? wantId : null,
    positionSec: finiteNonNegative(positionSec, 0),
    playing: strictBool(playing, false),
    repeatOne: strictBool(repeatOne, false),
    shuffleOn: strictBool(shuffleOn, false),
    ownerId: typeof ownerId === 'string' && ownerId ? ownerId : null,
    // The specific claim episode ("lease") that produced this envelope --
    // distinct from ownerId so that even the SAME tab reclaiming ownership
    // later (a fresh claimOwnership() call after having lost and regained
    // it) is recognized as a NEWER claim than a stale write issued under an
    // earlier, now-superseded lease. See hasValidLease()'s comment for the
    // full rationale.
    ownerEpoch: typeof ownerEpoch === 'string' && ownerEpoch ? ownerEpoch : null,
    savedAt: Date.now(),
  };
}

// Validates/degrades an arbitrary parsed value into an envelope or null.
// version !== 1 (including a missing/non-numeric version, or genuinely
// malformed JSON that parsed to something else entirely) is treated as
// ENTIRELY ABSENT -- not migrated, not partially trusted -- exactly like no
// session existing at all, per the plan's explicit call. Each queue item is
// individually try/catch-guarded (decodeItem() above) so one corrupt entry
// degrades gracefully instead of discarding the whole session.
export function decodeEnvelope(parsed) {
  if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return null;
  const queue = [];
  const seen = new Set();
  // Capped BEFORE any per-item decode work, not just on the output -- an
  // arbitrary/corrupted/tampered stored value could otherwise force
  // unbounded per-item decode work no matter how large `parsed.queue` claims
  // to be.
  const rawQueue = Array.isArray(parsed.queue) ? parsed.queue.slice(0, MAX_PERSISTED_QUEUE_ITEMS) : [];
  rawQueue.forEach((raw) => {
    let item;
    try { item = decodeItem(raw); } catch (e) { return; }
    if (seen.has(item.id)) return;
    seen.add(item.id);
    queue.push(item);
  });
  const wantId = typeof parsed.currentItemId === 'string' ? parsed.currentItemId : null;
  return {
    version: 1,
    queue,
    // Resolved against the FILTERED queue -- an id surviving filtering
    // unambiguously, unlike a raw index, is exactly why this is an id in the
    // first place (see restoreSession()'s own comment in player-controller.js).
    currentItemId: wantId != null && queue.some((t) => t.id === wantId) ? wantId : null,
    positionSec: finiteNonNegative(parsed.positionSec, 0),
    playing: strictBool(parsed.playing, false),
    repeatOne: strictBool(parsed.repeatOne, false),
    shuffleOn: strictBool(parsed.shuffleOn, false),
    ownerId: typeof parsed.ownerId === 'string' && parsed.ownerId ? parsed.ownerId : null,
    ownerEpoch: typeof parsed.ownerEpoch === 'string' && parsed.ownerEpoch ? parsed.ownerEpoch : null,
    savedAt: typeof parsed.savedAt === 'number' && isFinite(parsed.savedAt) ? parsed.savedAt : null,
  };
}

// ── storage-facing read/write (localStorage — the shared envelope) ───────
// Tri-state, unlike the original two-state (envelope-or-null) version: a
// genuine read failure (getItem() itself throwing) must never be mistaken
// for "no envelope exists" -- the old shape's version of this collapse let a
// broken read be treated as a free-to-claim fresh session (implementation
// review, 2026-08-15). `'absent'` covers both a missing key and a
// corrupt/wrong-version value -- both are, correctly, "nothing to restore",
// just for different reasons than `'unavailable'`.
export function readEnvelope(localStore) {
  let raw;
  try {
    raw = localStore.getItem(STATE_KEY);
  } catch (e) {
    return { status: 'unavailable', envelope: null };
  }
  if (raw == null) return { status: 'absent', envelope: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { status: 'absent', envelope: null };
  }
  const envelope = decodeEnvelope(parsed);
  if (!envelope) return { status: 'absent', envelope: null };
  return { status: 'ok', envelope };
}

export function writeEnvelope(localStore, envelope) {
  try {
    localStore.setItem(STATE_KEY, JSON.stringify(envelope));
    return true;
  } catch (e) {
    return false; // quota exceeded, storage disabled (private browsing), etc.
  }
}

// ── tab identity (sessionStorage) ─────────────────────────────────────────
// NOT player-controller.js's `selfId` — that is a fresh Math.random() value
// regenerated on every document load (verified: player-controller.js:23),
// useless for tracking identity across a same-tab navigation, which is
// exactly the case this whole feature exists to survive. sessionStorage
// gives the opposite lifetime: stable across same-tab navigation, fresh for
// a genuinely new tab/window.
function generateTabId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// Called exactly once per document, at boot, before anything else in this
// module. Idempotent if a value already exists. Unlike the old getTabId(),
// this does not just trust that setItem() didn't throw -- it READS BACK what
// was actually stored, closing the "silent ephemeral id" bug (a write that
// throws, or a write that lands somewhere the very next read doesn't see --
// e.g. storage disabled entirely -- must not hand back a value that looks
// valid but was never durably recorded). A `null` result means: disable
// persistent ownership for this document's entire lifetime; do not call any
// other ownership function below (peekTabId() is the sole exception -- it is
// always safe to call and simply returns null too).
export function establishTabId(sessionStore) {
  let existing;
  try { existing = sessionStore.getItem(TAB_ID_KEY); } catch (e) { existing = null; }
  if (existing) return existing;
  const id = generateTabId();
  try {
    sessionStore.setItem(TAB_ID_KEY, id);
  } catch (e) {
    return null;
  }
  let readBack;
  try { readBack = sessionStore.getItem(TAB_ID_KEY); } catch (e) { readBack = null; }
  return readBack === id ? id : null;
}

// Read-only: never generates, never throws (catches internally, returns
// null). Used by every function below that needs "my established id"
// without the right to mint one -- only establishTabId() (at boot) and
// rotateTabId() (on a detected collision) are allowed to write TAB_ID_KEY.
export function peekTabId(sessionStore) {
  try {
    return sessionStore.getItem(TAB_ID_KEY) || null;
  } catch (e) {
    return null;
  }
}

// Generates and PERSISTS a fresh tab id unconditionally, overwriting
// whatever is already stored — the actual remedy for a detected tab-id
// collision (see the handshake section below). Same read-back verification
// as establishTabId(): on a failed or unverified persist, returns null
// instead of a fabricated ephemeral id that looks valid but was never
// durably recorded.
export function rotateTabId(sessionStore) {
  const id = generateTabId();
  try {
    sessionStore.setItem(TAB_ID_KEY, id);
  } catch (e) {
    return null;
  }
  let readBack;
  try { readBack = sessionStore.getItem(TAB_ID_KEY); } catch (e) { readBack = null; }
  return readBack === id ? id : null;
}

// ── live tab-identity collision detection: request/reply handshake ───────
// NOT part of the 2026-08-15 fenced-lease redesign -- considered solid after
// rounds 3-4 of review, out of scope here, kept as-is (only the boot
// pseudocode's `getTabId()` reference below is updated, to `peekTabId()`,
// since getTabId() no longer exists).
//
// peekTabId()/establishTabId() above assume a fresh tab/window always gets a
// fresh id. That's false: per MDN, a page opened via window.open() WITH an
// opener initially receives a COPY of the opener's sessionStorage, and plain
// browser tab duplication does the same — so two genuinely different,
// simultaneously live tabs can end up sharing the identical stored
// miniPlayerTabId. That defeats any ownership check that only looks at
// storage CONTENT in isolation: a passive clone's storage genuinely,
// byte-for-byte agrees with the real owner's, so NO check of either
// document's storage content alone can ever tell them apart.
//
// The fix: every collision is decided with ONLY a deterministic, symmetric
// nonce tie-break (shouldRotateOnCollision() below) — this can't misidentify
// a clone as "the real owner" because it never tries to; it just guarantees
// exactly one of the two survives with the original tabId, picked by an
// unbiased coin flip neither side can predict or game. A tab that loses the
// flip is not stuck: any real, local user interaction (play/pause/seek/queue
// change) reclaims ownership outright via claimOwnership() regardless of what
// the shared envelope says — so the flip only matters between two
// SIMULTANEOUSLY idle/passive tabs, where either outcome is equally fine
// since nobody is actively using either one at that moment.
//
// Both message types funnel through the SAME decision, resolveCollision()
// below, keyed on the OTHER side's nonce and memoized in `resolvedNonces` —
// a Set the caller creates once at boot and keeps for the document's
// lifetime — so a given opposing nonce is decided exactly ONCE no matter
// how many messages carry word of it. This is what prevents a simultaneous-
// mutual-probe from rotating twice: a tab can learn of the SAME opposing
// nonce via both the other side's raw PROBE and, separately, its own probe's
// REPLY, and must act on it only the first time — otherwise it could rotate
// once from each path.
//
// This whole section is deliberately pure/DOM-free, matching the rest of
// this module: no BroadcastChannel object appears anywhere below. A real
// boot script's channel.onmessage handler is expected to wire this as:
//   let myTabId = peekTabId(sessionStorage);
//   const myNonce = generateNonce();
//   const resolvedNonces = new Set();
//   tabChannel.onmessage = (e) => {
//     if (e.data.type === TAB_PROBE_MESSAGE) {
//       const { reply, rotated } = handleIncomingProbe(e.data, sessionStorage, myTabId, myNonce, resolvedNonces);
//       if (rotated) myTabId = peekTabId(sessionStorage); // rotateTabId() already persisted it
//       if (reply) tabChannel.postMessage(reply);
//     } else if (e.data.type === TAB_PROBE_REPLY_MESSAGE) {
//       const { rotated } = handleIncomingProbeReply(e.data, sessionStorage, myTabId, myNonce, resolvedNonces);
//       if (rotated) myTabId = peekTabId(sessionStorage);
//     }
//   };
//
// CALLER CONTRACT, load-bearing (`/review-step` finding, 2026-08-15): the
// handshake handlers above trust the CALLER-SUPPLIED `myTabId` parameter —
// they never re-read storage themselves — so `myTabId` must be refreshed
// (`= peekTabId(sessionStorage)`) after EVERY function in this module that
// can rotate `TAB_ID_KEY`, not just after a handshake-reported rotation.
// `revokeLease()` below is the other one: its escalation path
// (`{escalated:true}`) calls `rotateTabId()` internally. Reproduced
// directly: a caller that refreshes `myTabId` only on handshake-reported
// rotation, and misses a `revokeLease()` escalation, keeps comparing
// incoming probes against the STALE pre-rotation id — a genuinely
// colliding duplicated tab (now sharing the CURRENT, rotated id) is
// silently not recognized as a collision at all, no reply is sent, and
// the collision goes undetected. The fix is entirely at the caller-wiring
// level (this module cannot reach into a caller's local variable):
//   const revokeResult = revokeLease(localStorage, sessionStorage, lease);
//   if (revokeResult.escalated) myTabId = peekTabId(sessionStorage);
//   tabChannel.postMessage({ type: TAB_PROBE_MESSAGE, tabId: myTabId, nonce: myNonce });
export const TAB_PROBE_MESSAGE = 'mini-player-tab-probe';
export const TAB_PROBE_REPLY_MESSAGE = 'mini-player-tab-probe-reply';

// Purely random output (no orderable/timestamp component -- see
// shouldRotateOnCollision()'s comment for why that matters), via
// crypto.getRandomValues() when available (every secure context this site's
// boot scripts run in), with a same-length Math.random()-only fallback that
// is still free of any orderable prefix.
export function generateNonce() {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('');
  }
  return `${Math.random().toString(36).slice(2).padEnd(16, '0')}${Math.random().toString(36).slice(2).padEnd(16, '0')}`;
}

// True if an incoming message is a PROBE colliding with THIS document: same
// tabId, different nonce. (Same tabId + same nonce would mean somehow
// receiving an echo of this document's own probe, which BroadcastChannel
// never delivers — treated as "not a collision" defensively rather than
// assumed impossible.)
export function isTabProbeCollision(incoming, myTabId, myNonce) {
  return !!incoming && incoming.type === TAB_PROBE_MESSAGE
    && typeof incoming.tabId === 'string' && incoming.tabId === myTabId
    && incoming.nonce !== myNonce;
}

// True if an incoming message is a REPLY specifically addressed to MY OWN
// probe (matching tabId, and replyToNonce echoing the nonce I sent) — not
// just any reply flying around on the channel.
export function isTabProbeReplyForMe(incoming, myTabId, myNonce) {
  return !!incoming && incoming.type === TAB_PROBE_REPLY_MESSAGE
    && typeof incoming.tabId === 'string' && incoming.tabId === myTabId
    && incoming.replyToNonce === myNonce;
}

// Deterministic, symmetric tie-break — the ONLY thing collision resolution
// depends on. Comparing the two nonces directly (rather than, say, "whoever
// received the message rotates," which isn't symmetric at all — both sides
// can receive each other's message) means both sides compute the SAME
// answer independently with no further coordination: side X sees {mine: nX,
// theirs: nY}, side Y sees {mine: nY, theirs: nX}, and "the lexicographically
// smaller nonce rotates" flips consistently between the two comparisons.
// The specific rule (smaller rotates) is an arbitrary choice — only the
// determinism/symmetry actually matters. Requires both nonces to have no
// shared orderable prefix (see generateNonce()) or the comparison would be
// biased toward whichever side generated its nonce more recently.
export function shouldRotateOnCollision({ myNonce, theirNonce }) {
  if (!myNonce || !theirNonce || myNonce === theirNonce) return false;
  return myNonce < theirNonce;
}

// Shared decision path for both message types below. `theirNonce` is the
// OTHER side's nonce regardless of whether it arrived via a raw PROBE or a
// REPLY to my own probe — memoized in `resolvedNonces` (caller-owned, one
// Set per document boot) so a given opposing nonce is only ever acted on
// once, however many messages carry word of it.
function resolveCollision(theirNonce, sessionStore, myNonce, resolvedNonces) {
  if (resolvedNonces.has(theirNonce)) return false;
  resolvedNonces.add(theirNonce);
  const rotate = shouldRotateOnCollision({ myNonce, theirNonce });
  if (rotate) rotateTabId(sessionStore);
  return rotate;
}

// Called by a tab that is ALREADY live and listening, upon receiving another
// document's PROBE colliding with its own tabId. MUST reply (never stay
// silent) — replying is what lets a newcomer that joined after this tab's
// own boot-time probe already happened and is gone still learn about the
// collision, since the newcomer is the one actively asking. Returns
// { reply, rotated }: `reply` is the message to postMessage() back (always
// non-null for a genuine collision, null otherwise — a no-op); `rotated` is
// whether THIS tab rotated its own id, decided purely by the nonce
// tie-break.
export function handleIncomingProbe(incoming, sessionStore, myTabId, myNonce, resolvedNonces) {
  if (!isTabProbeCollision(incoming, myTabId, myNonce)) return { reply: null, rotated: false };
  const rotated = resolveCollision(incoming.nonce, sessionStore, myNonce, resolvedNonces);
  const reply = {
    type: TAB_PROBE_REPLY_MESSAGE, tabId: myTabId,
    nonce: myNonce, replyToNonce: incoming.nonce,
  };
  return { reply, rotated };
}

// Called by the PROBER, upon receiving a reply to its own probe. Runs the
// SAME shared decision (resolveCollision(), keyed on the SAME two nonces)
// as the replying side already ran for itself — guaranteed to produce the
// complementary answer, so exactly one of the two ever rotates, never both,
// never neither, regardless of which side happened to send a probe first.
export function handleIncomingProbeReply(incoming, sessionStore, myTabId, myNonce, resolvedNonces) {
  if (!isTabProbeReplyForMe(incoming, myTabId, myNonce)) return { rotated: false };
  const rotated = resolveCollision(incoming.nonce, sessionStore, myNonce, resolvedNonces);
  return { rotated };
}

// ── revocation (sessionStorage — epoch-scoped, not a boolean latch) ───────
// Load-bearing that this lives in sessionStorage rather than a JS variable:
// an in-memory marker resets on exactly the event this whole feature exists
// to survive (navigation), and the thing that revokes ownership might not
// even be a mini-player tab at all — e.g. the /player/ popup, still alive
// during a later soak stage, broadcasts a claim but never writes to the
// shared envelope at all (it isn't part of this module's bookkeeping).
//
// Epoch-scoped rather than a boolean that must later be cleared: a fresh
// epoch (minted by the NEXT successful claimOwnership()) is never equal to
// whatever this holds, so a later legitimate claim automatically reads as
// not-revoked — there is no "clear" operation left to fail, closing the bug
// class where a failed clear left claimOwnership() reporting success while
// the ownership check still failed.
//
// Fails closed (true) for a null epoch or an unreadable marker: a lease
// this module cannot positively clear of revocation must never be trusted.
export function isEpochRevoked(sessionStore, ownerEpoch) {
  if (typeof ownerEpoch !== 'string' || !ownerEpoch) return true;
  let stored;
  try {
    stored = sessionStore.getItem(REVOKED_EPOCH_KEY);
  } catch (e) {
    return true; // unreadable marker -- fail closed, cannot prove this epoch is clean
  }
  if (stored == null) return false;
  return stored === ownerEpoch;
}

// Called from a future mini-player boot script's external-claim hook
// (player-controller.js's onExternalClaim/onAnyExternalClaim — unrelated to
// and unaffected by this redesign) when another tab/document claims
// playback. Deliberately does NOT touch the shared envelope -- an incoming
// claim only ever records that THIS epoch is no longer trusted, never
// rewrites/clears ownerId from the losing side.
//
// Caller contract (boot-script pseudocode, not enforced by this pure
// module): on any external claim signal, synchronously drop the in-memory
// `lease` variable to `null` FIRST -- that's what actually stops this
// document's OWN further writes this session (writeSession() below always
// re-validates the lease it's given against the fresh envelope, so a null
// lease can never pass). Only THEN call revokeLease() with the PREVIOUS
// lease, as a best-effort durability measure for surviving a same-tab
// navigation that might carry a stale in-memory lease-restoration attempt
// forward otherwise.
//
// ── why this takes localStore, and skips the write when the epoch is
// already stale (2026-08-15 fix, replacing three earlier attempts) ──
// restoreLease() only ever calls isEpochRevoked() against whatever epoch
// the envelope CURRENTLY names — never against any other epoch. So a
// revocation call for an epoch that ALREADY no longer matches the fresh
// envelope is PROVABLY irrelevant the moment it's attempted: writing it
// anyway is exactly what let a stale/delayed call (e.g. a leftover
// listener still holding an earlier lease) overwrite a still-relevant
// revocation recorded after it — reproduced directly, three times, in
// three earlier single-write designs (a bare single-value overwrite; a
// bounded set whose cap could still be evicted by enough stale calls; and
// an EARLIER version of this exact function, which correctly skipped the
// write on a confirmed-irrelevant epoch but still unconditionally wrote on
// a merely-UNCERTAIN one — a genuine envelope-read failure — which a stale
// call could hit by pure chance, overwriting a different, still-relevant
// revocation with no tampering and no write failure at all, same bug,
// third path).
//
// A single `setItem()` when the check passes -- still exactly one
// sessionStorage write, same as every design before it; the fix is WHETHER
// that write happens, not how many writes there are. The write proceeds
// ONLY when the envelope is readable and confirms this epoch is still
// current ('ok' + matching ownerEpoch) or when there's genuinely nothing
// to compare against ('absent' -- nothing else could possibly be at risk
// of being clobbered). On a genuine envelope READ failure ('unavailable'),
// this can neither confirm the epoch is current NOR rule it out, and a
// blind write risks the exact clobber this function exists to prevent --
// so it does NOT write the marker at all, instead escalating exactly like
// a failed sessionStorage WRITE already does: rotateTabId(). A rotated tab
// id makes the NEXT boot's restoreLease() ownerId comparison fail
// regardless of whether the epoch marker itself ever landed, since
// restoreLease() compares the envelope's ownerId against peekTabId(), and
// a rotated id can never match an envelope written under the old one.
// Returns {ok, escalated}; `ok:false` only when BOTH the escalation path
// (envelope unavailable OR sessionStorage write failed) AND its own
// rotateTabId() fallback fail. A skipped (already-stale) write reports
// {ok:true, escalated:false} — nothing failed, there was simply nothing to
// do.
//
// CALLER CONTRACT (`/review-step` finding, 2026-08-15): `escalated:true`
// means rotation was ATTEMPTED — check `ok` to know whether it actually
// landed (`ok:true`) or the rotation itself also failed (`ok:false`); it
// does NOT by itself mean TAB_ID_KEY changed. A caller holding a cached
// copy of its own tab id (the tab-collision handshake's documented
// `myTabId` variable above is exactly this) MUST refresh it — `=
// peekTabId(sessionStore)` — whenever this returns `escalated:true`, the
// same as it already must for a handshake-reported rotation: refreshing
// unconditionally on `escalated` (rather than gating on `ok` too) is
// still correct either way, since peekTabId() simply re-reads whatever is
// actually there. Skipping this leaves the handshake comparing incoming
// probes against a stale id, silently failing to detect a real collision
// — see the handshake section's own comment above for the full reasoning
// and reproduction.
export function revokeLease(localStore, sessionStore, lease) {
  if (!lease || typeof lease.ownerEpoch !== 'string' || !lease.ownerEpoch) {
    return { ok: false, escalated: false };
  }
  const { status, envelope } = readEnvelope(localStore);
  if (status === 'ok' && envelope.ownerEpoch !== lease.ownerEpoch) {
    return { ok: true, escalated: false }; // provably irrelevant -- nothing written, nothing to clobber
  }
  if (status === 'unavailable') {
    // Can neither confirm this epoch is current nor rule it out -- a blind
    // write here risks clobbering a DIFFERENT, genuinely-current revocation
    // (the exact bug this function exists to prevent, via a transient read
    // failure instead of stale-call ordering). Escalate instead of writing.
    const rotated = rotateTabId(sessionStore);
    return { ok: rotated != null, escalated: true };
  }
  try {
    sessionStore.setItem(REVOKED_EPOCH_KEY, lease.ownerEpoch);
    return { ok: true, escalated: false };
  } catch (e) {
    const rotated = rotateTabId(sessionStore);
    return { ok: rotated != null, escalated: true };
  }
}

// ── lease validity ────────────────────────────────────────────────────────
// The single predicate every write path (writeSession(), tombstoneIfCurrent())
// gates on. Pure read, no lock needed. `false` for a malformed/null lease;
// `false` if that exact epoch has been locally revoked; `false` if the
// envelope read itself is `'unavailable'` (cannot positively confirm
// validity against a store that just threw) or `'absent'` (nothing to match
// against); otherwise compares `(ownerId, ownerEpoch)` against the FRESH
// envelope -- always re-read here, never cached, so this can be called
// immediately before a write as a second, defense-in-depth check.
//
// Why BOTH ownerId and ownerEpoch, not just ownerId: the HTML Standard
// explicitly does not guarantee any cross-agent-cluster locking for Web
// Storage, so a stale write issued under an OLDER lease -- even one held by
// the SAME tab, from BEFORE it lost and regained ownership -- must not be
// allowed to land just because ownerId still happens to match. ownerEpoch
// identifies the specific claim EPISODE, not just the tab; comparing it
// against the lease captured in the WRITING CALLER'S OWN CLOSURE (never
// "whatever's currently in sessionStorage") is what makes a delayed write
// from a superseded claim structurally impossible to land -- this is the
// exact mechanism that closes the round-5 bug this module was redesigned to
// eliminate (see writeSession()'s comment for the two gates this proves).
export function hasValidLease(lease, localStore, sessionStore) {
  if (!lease || typeof lease.ownerId !== 'string' || !lease.ownerId
      || typeof lease.ownerEpoch !== 'string' || !lease.ownerEpoch) {
    return false;
  }
  if (isEpochRevoked(sessionStore, lease.ownerEpoch)) return false;
  const { status, envelope } = readEnvelope(localStore);
  if (status !== 'ok') return false;
  return envelope.ownerId === lease.ownerId && envelope.ownerEpoch === lease.ownerEpoch;
}

// ── boot-time restoration ─────────────────────────────────────────────────
// The "am I the continuing owner, and what lease should I hold" check --
// run ONCE at boot, AFTER the tab-collision handshake above has converged
// (documented sequencing contract; this pure, timer-free module cannot
// enforce that internally, same category as the handshake's own onmessage
// wiring already being caller-owned pseudocode).
//
// Returns exactly one of:
//   {status:'no-identity'}          peekTabId() found nothing -- establishTabId()
//                                    never succeeded; ownership is disabled
//                                    for this document's whole lifetime.
//   {status:'unavailable'}          the envelope read itself threw.
//   {status:'unowned', envelope}    no envelope, or an envelope with
//                                    ownerId:null -- free to originate via
//                                    claimOwnership(), no lease exists yet.
//   {status:'not-mine', envelope}   the envelope names a different tab.
//   {status:'revoked', envelope}    names THIS tab, but this exact epoch was
//                                    locally revoked (the durable-latch case
//                                    -- e.g. the /player/ popup claimed
//                                    playback and this tab then navigated).
//   {status:'restored', lease, envelope}
//                                    safe to resume -- adopt {ownerId,
//                                    ownerEpoch} from the envelope as this
//                                    document's operating lease. No write
//                                    performed; the caller holds the
//                                    returned lease in memory from here on.
export function restoreLease(localStore, sessionStore) {
  const tabId = peekTabId(sessionStore);
  if (!tabId) return { status: 'no-identity' };

  const { status, envelope } = readEnvelope(localStore);
  if (status === 'unavailable') return { status: 'unavailable' };
  if (status === 'absent') return { status: 'unowned', envelope: null };
  if (envelope.ownerId == null) return { status: 'unowned', envelope };
  if (envelope.ownerId !== tabId) return { status: 'not-mine', envelope };
  if (isEpochRevoked(sessionStore, envelope.ownerEpoch)) return { status: 'revoked', envelope };
  return { status: 'restored', lease: { ownerId: envelope.ownerId, ownerEpoch: envelope.ownerEpoch }, envelope };
}

// ── cross-tab mutual exclusion (Web Locks API) ─────────────────────────────
// navigator.locks.request(name, callback) is the only real mutual-exclusion
// primitive available for same-origin cross-tab exclusion: while one tab
// holds a named lock, no other same-origin tab's navigator.locks.request()
// callback for that SAME name can run until it's released — broadly
// supported in evergreen browsers since 2022.
//
// Matches this module's existing "pure logic, no DOM/boot dependencies"
// design: navigator.locks is a global browser API, not naturally injectable
// like the storage objects above, so writeSession()/claimOwnership()/
// tombstoneIfCurrent() below accept an OPTIONAL lock-provider argument
// matching navigator.locks.request's own shape — (name, callback) =>
// Promise<returnValueOfCallback> — so a test can inject a FAKE provider (a
// simple in-memory queue is enough) that actually serializes concurrent
// calls, proving the wrapped logic genuinely serializes under it. When no
// provider is given, a real navigator.locks-backed one is used automatically
// if navigator.locks exists.
//
// ── the fail-closed decision (2026-08-15, supersedes the old best-effort
// fallback) ──
// When NO lock provider is available at all (no override injected AND no
// navigator.locks global), the critical section now never runs -- callers
// surface this as a documented degraded-path result ({ok:false,
// reason:'no-lock'} / false / false) rather than running unprotected. Under
// the OLD multi-step design a no-lock race could permanently orphan a claim,
// which was the reason for the old best-effort fallback; under THIS design a
// no-lock race would in principle just be a self-healing one-cycle glitch
// (claimOwnership() is a single atomic setItem(), so there's nothing
// half-written to corrupt) -- so fail-closed here is a genuine judgment
// call, not forced by risk of corruption. Adopted anyway because Web Locks
// support is already broad and this removes an entire class of
// race-characterization tests and behavior. A very old/restricted browser
// without navigator.locks gets ordinary in-page playback for that single
// load, with no cross-navigation ownership persistence -- reversing this
// later only touches withOwnershipLock() below.
export const OWNERSHIP_LOCK_NAME = 'miniplayer-ownership';

function resolveLockRequest(lockRequest) {
  if (typeof lockRequest === 'function') return lockRequest;
  if (typeof navigator !== 'undefined' && navigator.locks
      && typeof navigator.locks.request === 'function') {
    return (name, callback) => navigator.locks.request(name, callback);
  }
  return null;
}

// Runs `fn` (the actual critical section) under the named lock when a
// provider is available. When none is, returns `noLockResult` (a value, or a
// zero-arg function producing one, since each caller's degraded-path shape
// differs) WITHOUT ever invoking `fn` -- see the fail-closed decision above.
// Always returns a Promise either way — callers (writeSession(),
// claimOwnership(), tombstoneIfCurrent()) are async either way, matching the
// eventual real caller (a future mini-player boot script, for which async
// storage-writing operations are already the norm).
async function withOwnershipLock(lockRequest, fn, noLockResult) {
  const request = resolveLockRequest(lockRequest);
  if (!request) return typeof noLockResult === 'function' ? noLockResult() : noLockResult;
  return request(OWNERSHIP_LOCK_NAME, fn);
}

// A fresh, unguessable value identifying one claim EPISODE (not a tab --
// the same tab holds a NEW epoch after losing and reclaiming ownership).
// Only ever compared for equality (isEpochRevoked(), hasValidLease()), never
// ordered, so a timestamp-prefixed shape (unlike generateNonce(), which IS
// compared ordinally) is harmless here.
function generateEpoch() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// ── claiming ownership ────────────────────────────────────────────────────
// Exactly ONE localStorage.setItem() call on the happy path -- no second
// store write is ever part of this commit, so there is nothing to roll back,
// ever (the entire reason this module was redesigned; see the module
// comment). Under the lock: peekTabId() (fail if no established identity) ->
// readEnvelope() (fail if 'unavailable' -- cannot safely build on a store
// that just threw) -> mint a fresh ownerEpoch -> ONE writeEnvelope() call,
// preserving the existing envelope's queue/position/etc. content if any (an
// explicit local claim reclaims OWNERSHIP, it is not a full session write --
// the caller is expected to follow up with writeSession(), now gated to
// pass, to persist fresh session content).
//
// Deliberately NO compare-and-swap precondition on this call: an explicit
// local interaction always wins regardless of current envelope content (this
// is grant-case 3 of the ownership model -- a real, local, user-triggered
// action), and a single setItem() is atomic per the WHATWG spec (throws
// before the map changes, never partially applies), so there is nothing that
// can go stale between a read and this write to re-check.
//
// On failure, returns {ok:false, lease:null, envelope:null, reason} with the
// PREVIOUS envelope completely untouched -- nothing to roll back, because
// this was the only write attempted.
export async function claimOwnership(localStore, sessionStore, lockRequest) {
  return withOwnershipLock(lockRequest, () => {
    const tabId = peekTabId(sessionStore);
    if (!tabId) return { ok: false, lease: null, envelope: null, reason: 'no-identity' };

    const { status, envelope: existing } = readEnvelope(localStore);
    if (status === 'unavailable') return { ok: false, lease: null, envelope: null, reason: 'unavailable' };

    const ownerEpoch = generateEpoch();
    const next = existing
      ? { ...existing, ownerId: tabId, ownerEpoch, savedAt: Date.now() }
      : buildEnvelope({ queue: [], currentItemId: null, positionSec: 0, playing: false,
                         repeatOne: false, shuffleOn: false, ownerId: tabId, ownerEpoch });
    if (!writeEnvelope(localStore, next)) {
      return { ok: false, lease: null, envelope: null, reason: 'write-failed' };
    }
    return { ok: true, lease: { ownerId: tabId, ownerEpoch }, envelope: next };
  }, { ok: false, lease: null, envelope: null, reason: 'no-lock' });
}

// ── the gated session write ───────────────────────────────────────────────
// Takes the caller's `lease` EXPLICITLY -- no longer mints or reads any
// token internally. Under the lock: hasValidLease(lease, ...) (reject if
// false) -> build the candidate envelope -> re-check hasValidLease()
// IMMEDIATELY BEFORE the write (defense in depth, closes the gap between
// building the envelope and writing it) -> writeEnvelope().
//
// This is the mechanism that makes "a stale write from a superseded claim"
// structurally impossible to land: the comparison is always against the
// CALLER'S OWN CLOSURE lease, never against "whatever's currently in
// sessionStorage" -- closes both:
//   gate 6: A loses to B -- lease.ownerId no longer matches the fresh
//           envelope's ownerId.
//   gate 7: A loses, reclaims as a NEW episode A2 -- lease.ownerEpoch no
//           longer matches even though ownerId is unchanged. This is the
//           test that most directly exercises the round-5 bug this
//           redesign exists to close at the root: a delayed write issued
//           under A's FIRST lease, arriving after A itself reclaimed under
//           a second lease, is rejected purely because the closure it was
//           built from is no longer the current one -- no coordination
//           with the write itself was ever required.
export async function writeSession(localStore, sessionStore, lease, session, lockRequest) {
  return withOwnershipLock(lockRequest, () => {
    if (!hasValidLease(lease, localStore, sessionStore)) return false;
    const envelope = buildEnvelope({ ...session, ownerId: lease.ownerId, ownerEpoch: lease.ownerEpoch });
    if (!hasValidLease(lease, localStore, sessionStore)) return false;
    return writeEnvelope(localStore, envelope);
  }, false);
}

// ── best-effort cosmetic cleanup ──────────────────────────────────────────
// Optional -- never load-bearing for correctness. Same CAS precondition as
// writeSession() (hasValidLease()), so it is STRUCTURALLY unable to stomp a
// fresher legitimate claim: a losing tab's now-stale lease already fails
// hasValidLease() by the time it would try to tombstone, for the identical
// reason a stale writeSession() call would be rejected -- there is no
// separate safety argument to make here, it falls straight out of the same
// gate. Clears ownerId/ownerEpoch to null while preserving queue/position
// content, so a passive read-only observer (e.g. the mini-player view on a
// tab that never owned this session) stops showing stale "owned by someone"
// content once something OUTSIDE this module's own bookkeeping takes over
// (e.g. the /player/ popup during the 3b soak, which never writes here at
// all). The correctness-critical property -- no phantom auto-resume by the
// losing tab -- is already fully provided by revokeLease()'s local marker
// alone; call this best-effort, after revokeLease(), and never gate any
// correctness decision on its return value beyond logging.
export async function tombstoneIfCurrent(localStore, sessionStore, lease, lockRequest) {
  return withOwnershipLock(lockRequest, () => {
    if (!hasValidLease(lease, localStore, sessionStore)) return false;
    const { status, envelope: existing } = readEnvelope(localStore);
    if (status !== 'ok') return false;
    const next = { ...existing, ownerId: null, ownerEpoch: null, savedAt: Date.now() };
    if (!hasValidLease(lease, localStore, sessionStore)) return false;
    return writeEnvelope(localStore, next);
  }, false);
}
