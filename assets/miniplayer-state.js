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
// "lease": {ownerId, ownerEpoch}) is never persisted as a SEPARATE credential
// requiring its own cross-key synchronization — it lives only in the
// caller's JS memory (wiped by navigation, which is exactly the lifetime a
// "was this write issued under the still-current claim" check needs). The
// tuple itself IS necessarily readable inside the one durable envelope
// (that's how restoreLease() re-derives a lease on a fresh page load at
// all) — "never persisted" describes the credential's storage SHAPE, not
// its visibility. See the plan doc for the full bug history.
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

// Reads back its own write and requires exact equality before reporting
// success (2026-08-15 fix — a `/review-step` round found this was the one
// storage write in the module that DIDN'T do this: establishTabId() and
// revokeLease() were both already fixed earlier the same day for the
// identical reason, but this is the actual commit path underneath
// claimOwnership()/writeSession()/tombstoneIfCurrent(), so the gap was
// wider than either of those. Reproduced directly with a setItem() that
// never throws but silently drops the write: claimOwnership() reported
// {ok:true} while readEnvelope() still saw 'absent', and both
// writeSession()/tombstoneIfCurrent() reported true on a healthy claim
// while the durable envelope stayed byte-for-byte unchanged underneath).
// Still exactly one setItem() call either way -- the read-back is a
// getItem(), not a second write -- so the "one write, nothing to roll
// back" property this module was redesigned around is unaffected.
//
// The verification read RETRIES a bounded number of times (2026-08-15 fix
// — a later `/review-step` round found the original single-attempt version
// had introduced the exact MIRROR IMAGE of the bug above: a write that
// genuinely LANDED, followed by one transient getItem() throw, was
// reported as `false`, so claimOwnership() returned
// {ok:false, reason:'write-failed'} while the envelope durably showed its
// new owner, writeSession() returned false while the item was saved, and
// tombstoneIfCurrent() returned false while ownership was actually
// cleared — all three reproduced directly). Same bounded-retry shape as
// generateDistinctFrom() below.
//
// HONEST RESIDUAL (deliberately not chased further): if EVERY retry also
// throws, this still reports `false` for a write that may have landed.
// Accepted because the consequence is bounded and self-healing rather than
// corrupting, traced per caller: claimOwnership() has no CAS precondition,
// so a retried claim simply overwrites cleanly; writeSession() self-heals
// on the caller's next periodic save; tombstoneIfCurrent() is already
// documented as best-effort and explicitly never load-bearing for
// correctness. A full `confirmed`/`not-written`/`indeterminate` tri-state
// threaded through all three public APIs was considered and declined as
// disproportionate to that bounded risk.
const MAX_WRITE_VERIFY_ATTEMPTS = 3;
export function writeEnvelope(localStore, envelope) {
  const serialized = JSON.stringify(envelope);
  try {
    localStore.setItem(STATE_KEY, serialized);
  } catch (e) {
    return false; // quota exceeded, storage disabled (private browsing), etc.
  }
  for (let attempt = 0; attempt < MAX_WRITE_VERIFY_ATTEMPTS; attempt++) {
    let readBack;
    try {
      readBack = localStore.getItem(STATE_KEY);
    } catch (e) {
      continue; // transient read blip -- retry rather than misreport a landed write as failed
    }
    return readBack === serialized; // a successful READ is decisive either way, match or not
  }
  return false; // every verification attempt threw -- see the honest residual above
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

// Regenerates via `generate` until the result differs from `existingValue`,
// up to a small bounded number of attempts, returning null if it never
// manages to (2026-08-15 fix — a `/review-step` round found rotateTabId()
// and claimOwnership() both minted a fresh id/epoch without ever comparing
// it against the value being replaced. Reproduced directly with pinned
// Date.now()/Math.random(): rotateTabId() reported success while leaving a
// genuine collision completely unresolved, and two consecutive
// claimOwnership() calls minted the IDENTICAL ownerEpoch, letting a stale
// write from the first claim land after the second — reopening the exact
// round-5 bug this whole redesign exists to structurally close. Real
// entropy makes a first-attempt collision astronomically unlikely, so this
// is defense-in-depth against degraded/predictable entropy sources, not an
// expected path — but the module's own standing principle is to make a
// guarantee structural rather than merely probabilistic, same as every
// storage read-back check elsewhere in this file). Shared by rotateTabId()
// (below) and claimOwnership()'s epoch minting (further down).
const MAX_DISTINCT_VALUE_ATTEMPTS = 5;
function generateDistinctFrom(generate, existingValue) {
  for (let attempt = 0; attempt < MAX_DISTINCT_VALUE_ATTEMPTS; attempt++) {
    const candidate = generate();
    if (candidate !== existingValue) return candidate;
  }
  return null; // could not produce a value distinct from existingValue -- caller fails closed
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
//
// The initial existence check fails closed too (2026-08-15 fix — a
// `/review-step` round found the original version collapsed a transient
// read failure to "nothing exists" and proceeded to generate/persist a
// BRAND NEW id, destroying a perfectly valid identity carried in from a
// prior same-tab page load; reproduced directly). A read failure here
// means "cannot confirm whether an identity already exists," which must
// never be treated as license to overwrite one that might.
export function establishTabId(sessionStore) {
  let existing;
  try {
    existing = sessionStore.getItem(TAB_ID_KEY);
  } catch (e) {
    return null; // cannot positively confirm no identity exists -- refuse rather than risk overwriting one
  }
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
// durably recorded. Also requires the new id to actually DIFFER from
// whatever was there before persisting (see generateDistinctFrom()'s
// comment above) -- which means a FAILED pre-write read must fail closed
// too (2026-08-15 fix — a `/review-step` round found the previous version
// collapsed a throwing pre-write read to "nothing there," comparing the
// fresh candidate against `null` instead of the real, unreadable prior
// value; combined with pinned/degraded entropy, reproduced directly:
// rotateTabId() reported success while returning the EXACT SAME id that
// was already stored, leaving a genuine collision completely unresolved
// but reported resolved. The original reasoning here -- "not itself fatal,
// the read-back verification below is unaffected either way" -- conflated
// "verified to have landed" with "verified to have actually changed
// anything," the same distinction the writeEnvelope() fix, round 8, exists
// to enforce). Safe to fail closed: the caller contract already disables
// ownership entirely on a null/failed rotation, so this just routes an
// unconfirmable pre-read through that already-tested path instead of a
// false-success one.
export function rotateTabId(sessionStore) {
  let existing;
  try {
    existing = sessionStore.getItem(TAB_ID_KEY);
  } catch (e) {
    return null; // cannot confirm the value being replaced -- refuse rather than risk an undetected no-op "rotation"
  }
  const id = generateDistinctFrom(generateTabId, existing);
  if (id == null) return null;
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
// NOT part of the 2026-08-15 fenced-lease redesign's original scope --
// considered solid after rounds 3-4 of review at the time, kept as-is
// beyond the boot pseudocode's `getTabId()` reference below being updated
// to `peekTabId()` (getTabId() no longer exists) -- EXCEPT for one later
// fix (`/review-step`, 2026-08-15): round 9's deterministic nonce tests
// (fixed/injected entropy, replacing ones that sampled real randomness)
// made it provable that two GENUINELY DIFFERENT documents can end up with
// EQUAL nonces, not just equal-by-self-echo. isTabProbeCollision() treated
// that as "not a collision" (see its own comment for the original,
// insufficient reasoning), so two real, distinctly-live colliding
// documents that happened to draw the same nonce would each silently
// ignore the other's probe and both later restore as owner -- reproduced
// directly. Fixed below (isTabProbeCollision()/resolveCollision()); the
// deterministic tie-break itself (shouldRotateOnCollision()) is unchanged
// and still solid -- this was specifically the "equal nonces mean no
// collision at all" classification, not the tie-break logic.
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
// the shared envelope says.
//
// CORRECTION (2026-08-15, `/review-step`): the flip does NOT only matter
// between two idle/passive tabs, as an earlier version of this comment
// claimed — a tab that is ACTIVELY, AUDIBLY PLAYING can also receive a
// newly-duplicated tab's probe and lose. Losing immediately invalidates its
// in-memory lease via peekTabId() (see hasValidLease()'s own comment below),
// so any further save attempt silently stops landing — but nothing in this
// module stops the audio itself from continuing to play. See the CALLER
// CONTRACT below: on `rotated:true`, treat it the same as any other
// external-claim signal — drop the lease and, per the caller's own
// playback-layer wiring (outside this module's scope), pause/relinquish
// active playback. Left as a caller-contract requirement rather than
// module behavior because this module has no PlaybackController dependency
// by design (see the module's own header comment) — reaching into
// playback state here would break that boundary.
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
//   let ownershipDisabled = false; // set once, never cleared -- see the failed-rotation contract below
//   const myNonce = generateNonce();
//   const resolvedNonces = new Set();
//   const onRotated = () => {                 // see the rotated:true contract below
//     myTabId = peekTabId(sessionStorage);
//     lease = null;
//     pauseOrRelinquishPlayback();
//     // MANDATORY re-probe under the NEW identity -- see the contract below
//     tabChannel.postMessage({ type: TAB_PROBE_MESSAGE, tabId: myTabId, nonce: myNonce });
//   };
//   tabChannel.onmessage = (e) => {
//     if (e.data.type === TAB_PROBE_MESSAGE) {
//       const { reply, rotated, failed } = handleIncomingProbe(e.data, sessionStorage, myTabId, myNonce, resolvedNonces);
//       if (reply) tabChannel.postMessage(reply);  // reply BEFORE re-probing, so ordering stays sane
//       if (rotated) onRotated();
//       if (failed) ownershipDisabled = true; // see below -- the collision could not be resolved
//     } else if (e.data.type === TAB_PROBE_REPLY_MESSAGE) {
//       const { rotated, failed } = handleIncomingProbeReply(e.data, sessionStorage, myTabId, myNonce, resolvedNonces);
//       if (rotated) onRotated();
//       if (failed) ownershipDisabled = true;
//     }
//   };
//
// CALLER CONTRACT — `rotated:true` (added 2026-08-15, `/review-step`
// finding): treat this the same as any other external-claim signal — drop
// the in-memory `lease` variable to `null` synchronously, and (via the
// caller's own playback-layer wiring, outside this module's scope) pause
// or relinquish any actively playing audio. Losing a collision tie-break
// while genuinely active/playing is a real, reproducible case (not just a
// theoretical one between two idle tabs, despite the section comment
// above's original, corrected wording) — this module already makes any
// further WRITE under the stale lease structurally impossible
// (hasValidLease()'s peekTabId() check), but nothing stops audio already
// playing from continuing to play silently out of sync with what's
// durably recorded, unless the caller acts on this signal.
//
// CALLER CONTRACT — MANDATORY RE-PROBE after `rotated:true` (2026-08-15,
// `/review-step` finding — load-bearing, not optional polish). After
// refreshing `myTabId`, the caller MUST broadcast a fresh PROBE under the
// NEW identity. Reason: rotateTabId()/generateDistinctFrom() can only
// guarantee the replacement differs from THIS document's own previous id —
// they have no way to know what a DIFFERENT, concurrently-rotating
// document is independently generating at the same moment. Reproduced
// directly: with three duplicated documents where TWO lose the same
// tie-break and both rotate, both independently generated the IDENTICAL
// replacement id under degraded entropy, and (with no re-probe) that fresh
// duplication went completely undetected — one claimed under it and the
// other still passed restoreLease() as `'restored'`. Re-probing turns the
// pairwise handshake into a genuinely self-converging protocol: any
// duplication created BY a rotation surfaces as an ordinary new collision
// under the new identity and is resolved by the exact same mechanism,
// including the composite-key memoization fix (see resolveCollision()) that
// makes a second collision under a new identity visible at all.
//
// HONEST RESIDUAL (deliberately not engineered against): this converges by
// repetition rather than by a bounded protocol with a give-up state, so a
// pathological entropy source could in principle keep producing identical
// replacements across successive rounds. Requires 3+ genuinely
// simultaneous duplicated tabs AND repeated identical independent draws;
// with the re-probe above, it is never permanently undetected, only
// possibly slower to converge. A bounded-convergence protocol with an
// explicit disable-on-non-convergence state was considered and declined as
// disproportionate for a module that, as of this stage, has no consumer
// to exercise it.
//
// CALLER CONTRACT — `failed:true` (2026-08-15 fix — a `/review-step` round
// found this branch didn't exist at all: rotateTabId()'s return value used
// to be silently discarded, so a FAILED rotation was reported as
// `rotated:true` regardless, and BOTH sides of a genuine collision could
// end up sharing the identical id and BOTH pass restoreLease() as
// `'restored'` — reproduced directly). `failed:true` means this side
// needed to rotate away from a collision but the underlying sessionStorage
// write could not be verified — the collision was NOT actually resolved.
// Treat this exactly like establishTabId() returning null: disable
// persistent ownership for this document's entire lifetime (do not call
// claimOwnership()/writeSession()/tombstoneIfCurrent()/revokeLease() again
// this load) — there is no way to safely continue participating in
// ownership while still sharing an unresolved, possibly-duplicated
// identity with another live document.
//
// CALLER CONTRACT — `escalated:true` from `revokeLease()`, load-bearing
// (`/review-step` finding, 2026-08-15): the
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
// tabId, well-formed nonce. Does NOT require the nonce to differ from mine
// (2026-08-15 fix — see the section comment above): the original version
// excluded an equal nonce on the theory that same-tabId+same-nonce could
// only be a self-echo, since BroadcastChannel structurally never delivers
// a sender its own message. That reasoning is correct as far as it goes —
// a TRUE self-echo can't reach this code path in a real deployment — but
// it does not rule out two DIFFERENT documents whose independently-drawn
// nonces happen to collide, which round 9's deterministic entropy tests
// made directly provable. Any same-tabId, well-formed probe is now
// unconditionally a collision; resolveCollision() below is what decides
// whether the two nonces provide a usable tie-break or not. No longer
// takes `myNonce` -- it's genuinely unused now that nonce equality doesn't
// affect collision-ness, and this module doesn't keep unused parameters
// around for signature stability (see its one call site, updated below).
export function isTabProbeCollision(incoming, myTabId) {
  return !!incoming && incoming.type === TAB_PROBE_MESSAGE
    && typeof incoming.tabId === 'string' && incoming.tabId === myTabId
    && typeof incoming.nonce === 'string' && !!incoming.nonce;
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
//
// Returns {rotated, failed}. `rotated:true` only when this side needed to
// rotate AND the rotation was verified to actually land. `failed:true`
// covers TWO distinct cases, both meaning "this collision could not
// actually be resolved" — the documented caller contract for either is to
// treat it the same as establishTabId() returning null: disable persistent
// ownership for this document's entire lifetime, since any further
// ownership activity risks the exact duplicate-restoration outcome this
// whole handshake exists to prevent:
//   - this side needed to rotate (it lost the tie-break) but the
//     underlying sessionStorage write could not be verified (2026-08-15
//     fix — a `/review-step` round found rotateTabId()'s return value used
//     to be silently discarded here, reporting `rotated:true` regardless:
//     reproduced directly, BOTH sides of a collision ended up sharing the
//     identical id and BOTH could subsequently pass restoreLease() as
//     `'restored'`);
//   - the two nonces provide no usable asymmetry for
//     shouldRotateOnCollision() to decide a winner with at all -- equal, or
//     either one missing/malformed (2026-08-15 fix — a `/review-step`
//     round found the equal-nonce case was previously a silent
//     `{rotated:false, failed:false}` no-op, INDISTINGUISHABLE from "no
//     collision happened": reproduced directly, two genuinely different
//     documents sharing a tabId whose independently-drawn nonces happened
//     to collide each silently ignored the other's probe, and BOTH later
//     restored as owner — a real collision (matching tabId) undeniably
//     occurred, it just couldn't be broken, which is not the same thing as
//     "nothing to resolve" and must not be reported that way). Checked the
//     same way shouldRotateOnCollision() itself already guards against a
//     malformed/missing nonce -- handleIncomingProbeReply()'s `theirNonce`
//     specifically is NOT otherwise validated before reaching here (only
//     `replyToNonce` is, by isTabProbeReplyForMe()).
//
// The memoization key is the COMPOSITE `(myTabId, theirNonce)`, not
// `theirNonce` alone (2026-08-15 fix — a `/review-step` round found the
// nonce-only key conflated "this nonce" with "this collision": after THIS
// document loses a collision on nonce N and rotates to a new identity, a
// LATER, genuinely different collision under the NEW id that happens to
// carry the same opposing nonce N was silently skipped as "already
// resolved," returning {rotated:false, failed:false} without even
// consulting the tie-break, and this document then wrongly restored as
// owner — reproduced directly. Nonce reuse is exactly the degraded-entropy
// case rounds 9-10 established as reachable, so this is not hypothetical).
// A collision is identified by WHICH IDENTITY it occurred under, not just
// by the opposing nonce; scoping the key to `myTabId` means a stale entry
// from a previous identity generation can never shadow a real collision
// under the current one. `|` is an unambiguous separator here: tab ids are
// base36 + a single hyphen (generateTabId()) and nonces are base36
// (generateNonce()), so neither part can ever contain it and two different
// (id, nonce) pairs can never collapse to the same key.
function resolveCollision(theirNonce, sessionStore, myNonce, resolvedNonces, myTabId) {
  const memoKey = `${myTabId}|${theirNonce}`;
  if (resolvedNonces.has(memoKey)) return { rotated: false, failed: false };
  resolvedNonces.add(memoKey);
  if (!myNonce || !theirNonce || myNonce === theirNonce) return { rotated: false, failed: true };
  if (!shouldRotateOnCollision({ myNonce, theirNonce })) return { rotated: false, failed: false };
  const rotated = rotateTabId(sessionStore);
  return rotated != null ? { rotated: true, failed: false } : { rotated: false, failed: true };
}

// Called by a tab that is ALREADY live and listening, upon receiving another
// document's PROBE colliding with its own tabId. MUST reply (never stay
// silent) — replying is what lets a newcomer that joined after this tab's
// own boot-time probe already happened and is gone still learn about the
// collision, since the newcomer is the one actively asking. Returns
// { reply, rotated, failed }: `reply` is the message to postMessage() back
// (always non-null for a genuine collision, null otherwise — a no-op);
// `rotated`/`failed` are resolveCollision()'s own result (see its comment).
export function handleIncomingProbe(incoming, sessionStore, myTabId, myNonce, resolvedNonces) {
  if (!isTabProbeCollision(incoming, myTabId)) return { reply: null, rotated: false, failed: false };
  const { rotated, failed } = resolveCollision(incoming.nonce, sessionStore, myNonce, resolvedNonces, myTabId);
  const reply = {
    type: TAB_PROBE_REPLY_MESSAGE, tabId: myTabId,
    nonce: myNonce, replyToNonce: incoming.nonce,
  };
  return { reply, rotated, failed };
}

// Called by the PROBER, upon receiving a reply to its own probe. Runs the
// SAME shared decision (resolveCollision(), keyed on the SAME two nonces)
// as the replying side already ran for itself — guaranteed to produce the
// complementary answer, so exactly one of the two ever rotates, never both,
// never neither, regardless of which side happened to send a probe first.
export function handleIncomingProbeReply(incoming, sessionStore, myTabId, myNonce, resolvedNonces) {
  if (!isTabProbeReplyForMe(incoming, myTabId, myNonce)) return { rotated: false, failed: false };
  return resolveCollision(incoming.nonce, sessionStore, myNonce, resolvedNonces, myTabId);
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
  } catch (e) {
    const rotated = rotateTabId(sessionStore);
    return { ok: rotated != null, escalated: true };
  }
  // Read back to confirm the write actually landed -- same discipline as
  // establishTabId()/rotateTabId() (2026-08-15 fix, a `/review-step` round
  // found this missing: a `setItem()` that "succeeds" without throwing but
  // silently doesn't persist -- the exact `silentlyDroppingStorage()` case
  // this suite already models elsewhere -- made revokeLease() report
  // {ok:true} while nothing was actually recorded, reproduced directly
  // letting a subsequent restoreLease() wrongly resolve 'restored').
  let readBack;
  try { readBack = sessionStore.getItem(REVOKED_EPOCH_KEY); } catch (e) { readBack = null; }
  if (readBack !== lease.ownerEpoch) {
    const rotated = rotateTabId(sessionStore);
    return { ok: rotated != null, escalated: true };
  }
  return { ok: true, escalated: false };
}

// ── lease validity ────────────────────────────────────────────────────────
// Shared by hasValidLease() (below) and tombstoneIfCurrent() -- `false` for
// a malformed/null lease; `false` if THIS DOCUMENT's own current identity
// (peekTabId()) no longer equals lease.ownerId; `false` if the envelope
// read itself is `'unavailable'` or `'absent'`; otherwise compares
// `(ownerId, ownerEpoch)` against the FRESH envelope -- always re-read
// here, never cached.
//
// The peekTabId() check (2026-08-15 fix — a `/review-step` round found it
// missing) closes a gap distinct from the envelope/epoch checks below: THIS
// document's own tab id can rotate out from under an already-captured
// in-memory lease -- either by losing the tab-collision tie-break, or by a
// revokeLease() escalation -- without the shared envelope changing at all
// (nobody else has written it yet). Without this check, a captured lease
// naming the OLD, now-abandoned id could still pass every other check
// (the envelope may well still name that old id too) and a stale write
// would land under an identity this document no longer holds. Reproduced
// directly: rotate this document's own id, then confirm the OLD lease
// still (wrongly) validated and a write under it still (wrongly) landed.
//
// Why BOTH ownerId and ownerEpoch in the envelope comparison, not just
// ownerId: the HTML Standard explicitly does not guarantee any
// cross-agent-cluster locking for Web Storage, so a stale write issued
// under an OLDER lease -- even one held by the SAME tab, from BEFORE it
// lost and regained ownership -- must not be allowed to land just because
// ownerId still happens to match. ownerEpoch identifies the specific claim
// EPISODE, not just the tab; comparing it against the lease captured in
// the WRITING CALLER'S OWN CLOSURE (never "whatever's currently in
// sessionStorage") is what makes a delayed write from a superseded claim
// structurally impossible to land -- this is the exact mechanism that
// closes the round-5 bug this module was redesigned to eliminate (see
// writeSession()'s comment for the two gates this proves).
function hasMatchingEnvelopeTuple(lease, localStore, sessionStore) {
  if (!lease || typeof lease.ownerId !== 'string' || !lease.ownerId
      || typeof lease.ownerEpoch !== 'string' || !lease.ownerEpoch) {
    return false;
  }
  if (peekTabId(sessionStore) !== lease.ownerId) return false;
  const { status, envelope } = readEnvelope(localStore);
  if (status !== 'ok') return false;
  return envelope.ownerId === lease.ownerId && envelope.ownerEpoch === lease.ownerEpoch;
}

// The single predicate writeSession() gates on. Everything
// hasMatchingEnvelopeTuple() checks, PLUS: `false` if that exact epoch has
// been locally revoked. tombstoneIfCurrent() below deliberately uses
// hasMatchingEnvelopeTuple() directly instead of this function -- see its
// own comment for why revocation must NOT be part of its gate.
export function hasValidLease(lease, localStore, sessionStore) {
  if (!hasMatchingEnvelopeTuple(lease, localStore, sessionStore)) return false;
  return !isEpochRevoked(sessionStore, lease.ownerEpoch);
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
//                                    a CANDIDATE lease to adopt -- {ownerId,
//                                    ownerEpoch} from the envelope, as read
//                                    at this exact moment. No write
//                                    performed. This is a single unlocked
//                                    read (deliberately -- see below), so it
//                                    is NOT a guarantee that no other tab's
//                                    claim has landed a moment later; the
//                                    only hard guarantee is what always
//                                    holds regardless of restoreLease()'s
//                                    result: any WRITE later attempted under
//                                    a superseded lease is still correctly
//                                    rejected by hasValidLease()'s always-
//                                    fresh envelope re-check. A caller that
//                                    resumes visible UI/audio state directly
//                                    from 'restored', before ever attempting
//                                    a write, has a narrow window where that
//                                    resumed state could already be stale --
//                                    closing that window requires a real
//                                    boot-time coordinator wiring collision/
//                                    external-claim listeners BEFORE trusting
//                                    a restoration, which is out of scope
//                                    here (`/review-step` finding,
//                                    2026-08-15: no such coordinator exists
//                                    yet -- this module has no consumer).
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
// that just threw) -> mint a fresh ownerEpoch, VERIFIED distinct from any
// existing envelope's (reason: 'epoch-collision' on the vanishingly rare
// failure to do so -- see generateDistinctFrom()'s comment) -> ONE
// writeEnvelope() call, preserving the existing envelope's queue/position/
// etc. content if any (an explicit local claim reclaims OWNERSHIP, it is
// not a full session write -- the caller is expected to follow up with
// writeSession(), now gated to pass, to persist fresh session content).
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

    // Must differ from the epoch being replaced (2026-08-15 fix — see
    // generateDistinctFrom()'s comment; without this a degraded/predictable
    // entropy source could mint the SAME epoch twice in a row, making a
    // stale write from the first claim indistinguishable from the second).
    const ownerEpoch = generateDistinctFrom(generateEpoch, existing ? existing.ownerEpoch : null);
    if (ownerEpoch == null) return { ok: false, lease: null, envelope: null, reason: 'epoch-collision' };
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
// Optional -- never load-bearing for correctness. Gates on
// hasMatchingEnvelopeTuple(), NOT hasValidLease() (2026-08-15 fix — a
// `/review-step` round found the documented "call it best-effort after
// revokeLease()" sequence was self-defeating: revokeLease() marks THIS
// EXACT epoch revoked, and hasValidLease() rejects a revoked epoch, so
// tombstoneIfCurrent() would always immediately reject itself on its own
// documented normal path, reproduced directly). Revocation must not be
// part of this gate: tombstoning is purely cosmetic (a passive observer
// no longer shows stale "owned by someone" content), and its safety comes
// entirely from the envelope-tuple/identity match — a losing tab's
// now-stale lease already fails hasMatchingEnvelopeTuple() by the time it
// would try to tombstone, for the identical reason a stale writeSession()
// call would be rejected, with or without revocation in the picture.
// Clears ownerId/ownerEpoch to null while preserving queue/position
// content, so a passive read-only observer (e.g. the mini-player view on a
// tab that never owned this session) stops showing stale "owned by someone"
// content once something OUTSIDE this module's own bookkeeping takes over
// (e.g. the /player/ popup during the 3b soak, which never writes here at
// all). The correctness-critical property -- no phantom auto-resume by the
// losing tab -- is already fully provided by revokeLease()'s local marker
// alone; call this best-effort, after revokeLease(), and never gate any
// correctness decision on its return value beyond logging.
//
// HONEST RESIDUAL GAP (2026-08-15, `/review-step` finding, deliberately
// NOT fixed): hasMatchingEnvelopeTuple()'s peekTabId() check means that if
// revokeLease()'s OWN escalation path fires (rotating this document's tab
// id as its failure fallback), the immediately-following tombstoneIfCurrent()
// call will ALSO now fail -- reproduced directly. Removing the peekTabId()
// check to fix this was considered and REJECTED: it would let a tab that
// LOST a collision tie-break (a genuinely different scenario, where the
// stale lease's tuple can still legitimately describe a DIFFERENT, still-
// live document's ongoing ownership, since collision resolution never
// touches the envelope) wrongly clear that other document's completely
// legitimate state -- also reproduced directly, and clearly worse (cross-
// document interference vs. a cosmetic display staying stale). Left as a
// narrow, purely cosmetic limitation on the escalation path specifically:
// the durable envelope may continue showing an abandoned owner until a
// fresh claim overwrites it, but no correctness property (no phantom
// auto-resume; no wrong document ever validates the stale lease for a
// WRITE) is affected either way.
export async function tombstoneIfCurrent(localStore, sessionStore, lease, lockRequest) {
  return withOwnershipLock(lockRequest, () => {
    if (!hasMatchingEnvelopeTuple(lease, localStore, sessionStore)) return false;
    const { status, envelope: existing } = readEnvelope(localStore);
    if (status !== 'ok') return false;
    const next = { ...existing, ownerId: null, ownerEpoch: null, savedAt: Date.now() };
    if (!hasMatchingEnvelopeTuple(lease, localStore, sessionStore)) return false;
    return writeEnvelope(localStore, next);
  }, false);
}
