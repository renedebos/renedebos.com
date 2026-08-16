// Deterministic tests for miniplayer-state.js — the persisted-session codec
// and durable cross-tab ownership logic for the sticky mini-player (Phase 3
// Stage 3a-foundation of plans/dynamic-hugging-rossum.md). No UI ships this
// stage; this proves the codec/ownership contract is correct BEFORE any boot
// script consumes it, per the plan's explicit requirement.
//
// This suite replaces the old claim-token/isOwner()-based suite entirely,
// matching the 2026-08-15 fenced-lease redesign of the module itself (see
// miniplayer-state.js's own module comment) — the old suite's "round 3/4/5"
// regression tests characterized bugs that no longer exist in this shape;
// see git history / HANDOFF.md for that narrative's provenance.
//
// Run: node scripts/test-miniplayer-state.mjs

import assert from 'node:assert/strict';
import {
  STATE_KEY, TAB_ID_KEY, REVOKED_EPOCH_KEY, encodeItem, encodeQueue, buildEnvelope,
  decodeEnvelope, readEnvelope, writeEnvelope, establishTabId, peekTabId, rotateTabId,
  isEpochRevoked, revokeLease, hasValidLease, restoreLease, claimOwnership, writeSession,
  tombstoneIfCurrent, MAX_PERSISTED_QUEUE_ITEMS, OWNERSHIP_LOCK_NAME,
  TAB_PROBE_MESSAGE, TAB_PROBE_REPLY_MESSAGE, generateNonce, isTabProbeCollision,
  isTabProbeReplyForMe, shouldRotateOnCollision, handleIncomingProbe, handleIncomingProbeReply,
} from './miniplayer-state.js';

// ── fake storage — one shared fake localStorage per test (real localStorage
// really is shared across same-origin tabs) and one fake sessionStorage PER
// simulated tab (real sessionStorage really is private per tab, but DOES
// survive that tab navigating to a new page — modeled here by simply reusing
// the same fake sessionStorage instance across a "before/after navigation"
// pair of calls in a test, since nothing in this module keeps any state
// outside the storage objects it's handed). ──────────────────────────────
function fakeStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _store: store,
  };
}

function item(id, extra = {}) {
  return { id, streamUrl: `https://example.test/${id}.mp3`, title: id, ...extra };
}

// Every setItem() throws — models quota-exceeded / private-browsing storage.
function throwingStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: () => { throw new Error('quota exceeded'); },
    removeItem: (k) => { delete store[k]; },
    _store: store,
  };
}

// Every getItem() throws too — models storage entirely inaccessible (some
// restricted/embedded contexts), distinct from "disabled writes only".
function fullyThrowingStorage() {
  return {
    getItem: () => { throw new Error('storage inaccessible'); },
    setItem: () => { throw new Error('storage inaccessible'); },
    removeItem: () => { throw new Error('storage inaccessible'); },
  };
}

// A setItem() that throws for exactly ONE specific key (everything else
// behaves normally) -- isolates a single write's failure from the rest of a
// multi-key call, e.g. proving revokeLease()'s rotateTabId() fallback when
// only the epoch write fails.
function throwingOnKey(initial, failingKey) {
  const store = { ...initial };
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => {
      if (k === failingKey) throw new Error('quota exceeded (isolated to ' + failingKey + ')');
      store[k] = String(v);
    },
    removeItem: (k) => { delete store[k]; },
    _store: store,
  };
}

// getItem() throws on its FIRST call only, then behaves normally -- models a
// transient read failure (e.g. a storage API that throws once while
// initializing) rather than storage being unavailable outright.
function throwingOnFirstGetStorage(initial = {}) {
  const store = { ...initial };
  let calls = 0;
  return {
    getItem: (k) => {
      calls++;
      if (calls === 1) throw new Error('transient read failure');
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
    },
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _store: store,
  };
}

// setItem() never throws but silently does nothing -- models a write that
// "succeeds" (no exception) yet never actually lands, the specific case
// establishTabId()/rotateTabId()'s read-back verification exists to catch.
function silentlyDroppingStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: () => { /* silently dropped */ },
    removeItem: (k) => { delete store[k]; },
    _store: store,
  };
}

// Counts every setItem() call across ALL keys -- used for critical test #1
// (claimOwnership() performs exactly one localStorage.setItem() call).
function countingStorage(initial = {}) {
  const store = { ...initial };
  const counts = { setItem: 0 };
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { counts.setItem++; store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _store: store,
    _counts: counts,
  };
}

// Same as countingStorage() above, but every setItem() call ALSO throws --
// proves a write-FAILURE path attempts exactly one write too, not just that
// the outcome is {ok:false} (which a hypothetical future rollback/second
// write could also produce). test-quality gap flagged by /review-step,
// 2026-08-15: the original write-failed test only asserted the outcome.
function throwingCountingStorage(initial = {}) {
  const store = { ...initial };
  const counts = { setItem: 0 };
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { counts.setItem++; throw new Error('quota exceeded'); },
    removeItem: (k) => { delete store[k]; },
    _store: store,
    _counts: counts,
  };
}

// A getItem() that fires a caller-supplied side effect after capturing the
// read value but BEFORE returning it, on its Nth call — models a genuinely
// concurrent write from another tab landing in the real wall-clock gap
// between this tab's own read and its later write/second read. The HTML
// Standard explicitly does not rule this out (no cross-agent-cluster locking
// for Web Storage).
function interleavedStorageAt(base, triggerOnCall, onTrigger) {
  let calls = 0;
  return {
    getItem: (k) => {
      calls++;
      const value = base.getItem(k);
      if (calls === triggerOnCall) onTrigger();
      return value;
    },
    setItem: (k, v) => base.setItem(k, v),
    removeItem: (k) => base.removeItem(k),
    get _store() { return base._store; },
  };
}

// ── fake Web Locks providers ──────────────────────────────────────────────
// Both match navigator.locks.request's own shape: (name, callback) =>
// Promise<returnValueOfCallback>.
//
// nonSerializingLockProvider(): calls the callback IMMEDIATELY/SYNCHRONOUSLY
// -- i.e. provides no mutual exclusion at all. Proves the module's own
// double-check pattern is NOT what provides safety -- a real serializing
// lock is. A caller that injects a provider like this is opting OUT of the
// safety this module depends on; that's a caller bug, not this module's.
function nonSerializingLockProvider() {
  return (name, callback) => Promise.resolve(callback());
}

// serializingLockProvider(): a real (if minimal) mutex -- a single promise
// chain every request() call appends to, so a SECOND call, even one
// triggered SYNCHRONOUSLY as a side effect from inside the FIRST call's
// still-executing callback, can only actually run once the first one's
// critical section has fully completed.
function serializingLockProvider() {
  let chain = Promise.resolve();
  return (name, callback) => {
    const result = chain.then(() => callback());
    chain = result.then(() => undefined, () => undefined);
    return result;
  };
}

// Most tests below exercise the OWNERSHIP LOGIC, not lock-provider mechanics
// -- they need SOME provider present (this Node environment has no global
// navigator.locks, and the redesign's fail-closed decision means calling
// with none at all always takes the degraded no-lock path; see the two
// tests that specifically target THAT path, which deliberately omit this).
// A non-serializing provider is enough for logic tests: it still runs the
// critical section, it just doesn't queue concurrent callers.
const TEST_LOCK = nonSerializingLockProvider();

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── persisted-item codec (unchanged by the redesign) ──────────────────────
test('encodeItem rejects an item with no id or no streamUrl', () => {
  assert.throws(() => encodeItem({ streamUrl: 'https://x/a.mp3' }), /id/);
  assert.throws(() => encodeItem({ id: 'a' }), /streamUrl/);
});

test('encodeQueue caps the queue length BEFORE mapping, not just the output', () => {
  const good = Array.from({ length: 3 }, (_, i) => item(`ok-${i}`));
  const malformed = Array.from({ length: 5 }, () => ({}));
  const input = good.concat(
    Array.from({ length: MAX_PERSISTED_QUEUE_ITEMS - 3 }, (_, i) => item(`filler-${i}`)),
    malformed,
  );
  const out = encodeQueue(input);
  assert.equal(out.length, MAX_PERSISTED_QUEUE_ITEMS);
  assert.ok(out.every((t) => t.id.startsWith('ok-') || t.id.startsWith('filler-')));
});

test('encodeQueue dedupes by id, first occurrence wins', () => {
  const out = encodeQueue([item('a', { title: 'First' }), item('b'), item('a', { title: 'Second' })]);
  assert.deepEqual(out.map((t) => t.id), ['a', 'b']);
  assert.equal(out[0].title, 'First');
});

test('encodeItem bounds string field lengths', () => {
  const out = encodeItem(item('a', { title: 'x'.repeat(5000), artist: 'y'.repeat(5000) }));
  assert.ok(out.title.length <= 300);
  assert.ok(out.artist.length <= 200);
});

test('encodeItem omits fields a mini-bar never renders (peaksKey, full downloads payload)', () => {
  const out = encodeItem(item('a', { peaksKey: '7', downloads: { lossless: { key: 'huge/path.flac' } } }));
  assert.equal(out.peaksKey, undefined);
  assert.equal(out.downloads, undefined);
});

test('decodeEnvelope treats version !== 1 as entirely absent, not migrated or partially trusted', () => {
  assert.equal(decodeEnvelope({ version: 2, queue: [item('a')] }), null);
  assert.equal(decodeEnvelope({ queue: [item('a')] }), null, 'a missing version is also absent, not defaulted to 1');
  assert.equal(decodeEnvelope(null), null);
  assert.equal(decodeEnvelope('not an object'), null);
});

test('decodeEnvelope validates each queue item individually — one corrupt entry does not discard the rest', () => {
  const raw = {
    version: 1,
    queue: [
      { id: 'a', streamUrl: 'https://x/a.mp3', title: 'A' },
      { id: 'b' }, // missing streamUrl -- corrupt
      null, // corrupt
      { id: 'c', streamUrl: 'https://x/c.mp3', title: 'C' },
    ],
  };
  const env = decodeEnvelope(raw);
  assert.deepEqual(env.queue.map((t) => t.id), ['a', 'c']);
});

test('decodeEnvelope resolves currentItemId against the FILTERED queue, falling back to null if it is gone', () => {
  const raw = {
    version: 1,
    queue: [{ id: 'a', streamUrl: 'https://x/a.mp3', title: 'A' }, { id: 'b' }],
    currentItemId: 'b',
  };
  const env = decodeEnvelope(raw);
  assert.equal(env.currentItemId, null, 'an id pointing at a filtered-out entry must not survive as "current"');
});

test('decodeEnvelope caps the queue length BEFORE decoding, not just the output', () => {
  const good = Array.from({ length: 3 }, (_, i) => ({ id: `ok-${i}`, streamUrl: `https://x/ok-${i}.mp3` }));
  const filler = Array.from({ length: MAX_PERSISTED_QUEUE_ITEMS - 3 }, (_, i) => ({ id: `filler-${i}`, streamUrl: `https://x/filler-${i}.mp3` }));
  const pastTheCap = Array.from({ length: 50 }, (_, i) => ({ id: `past-cap-${i}`, streamUrl: `https://x/past-cap-${i}.mp3` }));
  const raw = { version: 1, queue: good.concat(filler, pastTheCap) };

  const env = decodeEnvelope(raw);
  assert.equal(env.queue.length, MAX_PERSISTED_QUEUE_ITEMS);
  assert.ok(env.queue.every((t) => t.id.startsWith('ok-') || t.id.startsWith('filler-')));
});

test('decodeEnvelope resolves currentItemId against the CAPPED queue, not the raw uncapped one', () => {
  const good = Array.from({ length: 2 }, (_, i) => ({ id: `keep-${i}`, streamUrl: `https://x/keep-${i}.mp3` }));
  const filler = Array.from({ length: MAX_PERSISTED_QUEUE_ITEMS - 2 }, (_, i) => ({ id: `filler-${i}`, streamUrl: `https://x/filler-${i}.mp3` }));
  const excluded = { id: 'past-the-cap', streamUrl: 'https://x/past-the-cap.mp3' };
  const raw = { version: 1, queue: good.concat(filler, [excluded]), currentItemId: 'past-the-cap' };

  const env = decodeEnvelope(raw);
  assert.equal(env.queue.length, MAX_PERSISTED_QUEUE_ITEMS);
  assert.equal(env.currentItemId, null);
});

test('decodeEnvelope coerces booleans strictly — a corrupt string value must not silently become true', () => {
  const raw = { version: 1, queue: [], playing: 'true', repeatOne: 1, shuffleOn: 'yes' };
  const env = decodeEnvelope(raw);
  assert.equal(env.playing, false);
  assert.equal(env.repeatOne, false);
  assert.equal(env.shuffleOn, false);
});

test('decodeEnvelope accepts real booleans as-is', () => {
  const raw = { version: 1, queue: [], playing: true, repeatOne: true, shuffleOn: false };
  const env = decodeEnvelope(raw);
  assert.equal(env.playing, true);
  assert.equal(env.repeatOne, true);
  assert.equal(env.shuffleOn, false);
});

test('buildEnvelope / decodeEnvelope round-trip through JSON preserves a healthy session, including the ownerEpoch field', () => {
  const built = buildEnvelope({
    queue: [item('a'), item('b')], currentItemId: 'b', positionSec: 12.5,
    playing: true, repeatOne: false, shuffleOn: true, ownerId: 'tab-1', ownerEpoch: 'epoch-1',
  });
  const decoded = decodeEnvelope(JSON.parse(JSON.stringify(built)));
  assert.deepEqual(decoded.queue.map((t) => t.id), ['a', 'b']);
  assert.equal(decoded.currentItemId, 'b');
  assert.equal(decoded.positionSec, 12.5);
  assert.equal(decoded.playing, true);
  assert.equal(decoded.shuffleOn, true);
  assert.equal(decoded.ownerId, 'tab-1');
  assert.equal(decoded.ownerEpoch, 'epoch-1');
});

// ── readEnvelope: tri-state (finding, 2026-08-15 redesign) ────────────────
test('readEnvelope: absent for a missing key', () => {
  assert.deepEqual(readEnvelope(fakeStorage()), { status: 'absent', envelope: null });
});

test('readEnvelope: absent (not unavailable) for corrupt JSON — a parse failure is a known-empty read, not a broken one', () => {
  assert.deepEqual(readEnvelope(fakeStorage({ [STATE_KEY]: '{not json' })), { status: 'absent', envelope: null });
});

test('readEnvelope: absent for a wrong-version envelope', () => {
  const raw = JSON.stringify({ version: 2, queue: [] });
  assert.deepEqual(readEnvelope(fakeStorage({ [STATE_KEY]: raw })), { status: 'absent', envelope: null });
});

test('readEnvelope: unavailable (never absent) when getItem() itself throws — the read-failure-as-ownership regression', () => {
  const result = readEnvelope(fullyThrowingStorage());
  assert.equal(result.status, 'unavailable');
  assert.equal(result.envelope, null);
});

test('readEnvelope: ok with the decoded envelope for a healthy stored value', () => {
  const built = buildEnvelope({ queue: [item('a')], ownerId: 'tab-1', ownerEpoch: 'epoch-1' });
  const result = readEnvelope(fakeStorage({ [STATE_KEY]: JSON.stringify(built) }));
  assert.equal(result.status, 'ok');
  assert.equal(result.envelope.ownerId, 'tab-1');
});

// ── tab identity ────────────────────────────────────────────────────────
test('establishTabId: generates once and persists across repeated calls against the same sessionStorage', () => {
  const session = fakeStorage();
  const id1 = establishTabId(session);
  const id2 = establishTabId(session);
  assert.equal(id1, id2);
  assert.equal(session._store[TAB_ID_KEY], id1);
});

test('establishTabId: two different fake sessionStorage instances get two different ids (two real tabs)', () => {
  const idA = establishTabId(fakeStorage());
  const idB = establishTabId(fakeStorage());
  assert.notEqual(idA, idB);
});

test('establishTabId: tolerates a throwing pre-check read, still successfully establishes an id', () => {
  const id = establishTabId(throwingOnFirstGetStorage());
  assert.notEqual(id, null);
});

test('establishTabId: returns null (never a fabricated id) when the persist itself throws', () => {
  assert.equal(establishTabId(throwingStorage()), null);
});

test('establishTabId: returns null (never a fabricated id) when the write succeeds but the read-back does not confirm it', () => {
  assert.equal(establishTabId(silentlyDroppingStorage()), null);
});

test('peekTabId: read-only — returns the established id without ever generating one', () => {
  const session = fakeStorage();
  assert.equal(peekTabId(session), null, 'nothing established yet -- peekTabId must never mint one');
  const id = establishTabId(session);
  assert.equal(peekTabId(session), id);
});

test('peekTabId: never throws, returns null on a throwing store', () => {
  assert.equal(peekTabId(fullyThrowingStorage()), null);
});

test('rotateTabId: always overwrites with a genuinely new id', () => {
  const session = fakeStorage();
  const original = establishTabId(session);
  const rotated = rotateTabId(session);
  assert.notEqual(rotated, original);
  assert.equal(session._store[TAB_ID_KEY], rotated);
});

test('rotateTabId: returns null (never a fabricated ephemeral id) when the persist itself throws', () => {
  assert.equal(rotateTabId(throwingStorage()), null);
});

test('rotateTabId: returns null (never a fabricated ephemeral id) when the write succeeds but the read-back does not confirm it', () => {
  assert.equal(rotateTabId(silentlyDroppingStorage()), null);
});

// ── revocation: epoch-scoped, not a boolean latch ──────────────────────────
// revokeLease() now takes (localStore, sessionStore, lease) -- gated on
// whether the given epoch still matches the CURRENT envelope, replacing two
// earlier same-day designs each confirmed buggy by direct reproduction: a
// bare single-value overwrite (a stale revoke of an older epoch could win
// the overwrite and un-revoke a newer, still-relevant one) and a bounded
// SET of past epochs (an unreadable/corrupt read collapsed to "nothing
// recorded" before a subsequent successful write silently discarded
// history, and enough stale calls could evict the cap's one relevant
// entry). See revokeLease()'s own comment for the full reasoning.
test('isEpochRevoked: fails closed (true) for a null/empty epoch', () => {
  assert.equal(isEpochRevoked(fakeStorage(), null), true);
  assert.equal(isEpochRevoked(fakeStorage(), ''), true);
});

test('isEpochRevoked: false when nothing has ever been revoked', () => {
  assert.equal(isEpochRevoked(fakeStorage(), 'epoch-1'), false);
});

test('isEpochRevoked: true only for the EXACT epoch recorded as revoked', () => {
  const session = fakeStorage({ [REVOKED_EPOCH_KEY]: 'epoch-1' });
  assert.equal(isEpochRevoked(session, 'epoch-1'), true);
  assert.equal(isEpochRevoked(session, 'epoch-2'), false, 'a DIFFERENT (e.g. freshly reclaimed) epoch is not revoked -- automatic supersession, no clear needed');
});

test('isEpochRevoked: fails closed (true) when the marker itself is unreadable', () => {
  assert.equal(isEpochRevoked(fullyThrowingStorage(), 'epoch-1'), true);
});

test('revokeLease: persists the lease\'s ownerEpoch when it still matches the current envelope, reports {ok:true, escalated:false}', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  const claim = await claimOwnership(local, session, TEST_LOCK);

  const result = revokeLease(local, session, claim.lease);
  assert.deepEqual(result, { ok: true, escalated: false });
  assert.equal(session._store[REVOKED_EPOCH_KEY], claim.lease.ownerEpoch);
  assert.equal(isEpochRevoked(session, claim.lease.ownerEpoch), true);
});

test('revokeLease: no-op (reports {ok:true, escalated:false}, writes nothing) when the epoch no longer matches the current envelope', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  const stale = { ownerId: 'tab-1', ownerEpoch: 'stale-epoch' }; // envelope names something else entirely
  const claim = await claimOwnership(local, session, TEST_LOCK); // envelope now names claim.lease, not `stale`

  const result = revokeLease(local, session, stale);
  assert.deepEqual(result, { ok: true, escalated: false }, 'nothing failed -- there was simply nothing relevant to record');
  assert.equal(session._store[REVOKED_EPOCH_KEY], undefined, 'a provably-irrelevant epoch must never touch storage at all');
});

// ── critical: the /review-step-found bug this fix closes — a stale/delayed
// revocation of an OLDER epoch must never un-revoke a NEWER epoch that was
// already correctly revoked. Goes through REAL claimOwnership()/
// writeSession()/restoreLease() calls (not just isEpochRevoked() in
// isolation) so the envelope genuinely advances between claims, matching
// how a real boot script would drive this. ─────────────────────────────
test('critical: a stale revocation of an OLDER epoch never un-revokes a NEWER, still-current one', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);

  const claimA = await claimOwnership(local, session, TEST_LOCK);
  revokeLease(local, session, claimA.lease); // A revoked (e.g. an external claim arrived while A was current)

  const claimB = await claimOwnership(local, session, TEST_LOCK); // this tab reclaims -- envelope now names B
  revokeLease(local, session, claimB.lease); // B also revoked (envelope still names B at this point)
  assert.equal(restoreLease(local, session).status, 'revoked', 'sanity: B is revoked before the stale call');

  // A STALE/delayed revocation of the OLDER epoch A arrives after B's own
  // revocation already landed (a leftover listener/closure still holding
  // the earlier lease) -- by now the envelope names B, not A, so this must
  // be a no-op rather than disturbing B's still-current revocation.
  const staleResult = revokeLease(local, session, claimA.lease);
  assert.equal(staleResult.ok, true);
  assert.equal(session._store[REVOKED_EPOCH_KEY], claimB.lease.ownerEpoch, 'the stale call for A must never overwrite B\'s still-relevant revocation');
  assert.equal(restoreLease(local, session).status, 'revoked', 'B must remain revoked through restoreLease() itself, not just isEpochRevoked() in isolation');
});

// ── critical: the /review-step-found cap-eviction bug -- many (here, far
// more than the old design's 32-entry cap) stale/irrelevant revocations
// arriving after a legitimate one must never dislodge it, because none of
// them were ever relevant enough to touch storage in the first place. ───
test('critical: many stale/irrelevant revocation calls in a row never dislodge a still-current revocation', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  const claimB = await claimOwnership(local, session, TEST_LOCK);
  revokeLease(local, session, claimB.lease);

  for (let i = 0; i < 100; i++) {
    revokeLease(local, session, { ownerId: 'tab-1', ownerEpoch: `stale-old-${i}` });
  }
  assert.equal(session._store[REVOKED_EPOCH_KEY], claimB.lease.ownerEpoch, 'none of the 100 irrelevant calls may ever have touched storage');
  assert.equal(restoreLease(local, session).status, 'revoked');
});

test('revokeLease: a malformed/null lease is reported as failure without touching storage', () => {
  const local = fakeStorage();
  const session = fakeStorage();
  assert.deepEqual(revokeLease(local, session, null), { ok: false, escalated: false });
  assert.deepEqual(revokeLease(local, session, {}), { ok: false, escalated: false });
  assert.equal(session._store[REVOKED_EPOCH_KEY], undefined);
});

test('revokeLease: escalates via rotateTabId() instead of writing when the envelope read is unavailable', () => {
  const session = fakeStorage();
  const before = establishTabId(session);
  const result = revokeLease(fullyThrowingStorage(), session, { ownerId: before, ownerEpoch: 'epoch-1' });
  assert.equal(result.ok, true);
  assert.equal(result.escalated, true);
  assert.equal(session._store[REVOKED_EPOCH_KEY], undefined, 'cannot confirm this epoch is current, so the marker must never be blindly overwritten');
  assert.notEqual(session._store[TAB_ID_KEY], before, 'must escalate by rotating identity instead');
});

// ── critical: /review-step found the PREVIOUS version of this fix (which
// proceeded with the write on an unavailable read, "erring toward
// revoking") was itself unsafe -- a stale call for an older epoch could hit
// a genuine TRANSIENT read failure and still blindly overwrite a different,
// currently-relevant revocation, same bug class as the two designs before
// it, just a third trigger path. Goes through real claimOwnership()/
// restoreLease() so the envelope genuinely reflects a current, unrelated
// revocation the stale call must not be able to touch. ──────────────────
test('critical: a stale revocation hitting a transient envelope-read failure must never clobber a different, currently-relevant revocation', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  const claimA = await claimOwnership(local, session, TEST_LOCK);
  const claimB = await claimOwnership(local, session, TEST_LOCK); // reclaim as B
  revokeLease(local, session, claimB.lease); // B legitimately, currently revoked
  assert.equal(restoreLease(local, session).status, 'revoked', 'sanity: B is revoked before the stale call');

  // A stale revoke(A) arrives, and this specific read happens to throw --
  // a one-off transient failure, not corruption, not tampering.
  let getCalls = 0;
  const flakyOnceLocal = {
    getItem: (k) => { getCalls++; if (getCalls === 1) throw new Error('transient read failure'); return local.getItem(k); },
    setItem: (k, v) => local.setItem(k, v),
    removeItem: (k) => local.removeItem(k),
  };
  const result = revokeLease(flakyOnceLocal, session, claimA.lease);
  assert.equal(result.escalated, true, 'must escalate (rotate), never blindly write, when it cannot confirm relevance');
  assert.equal(session._store[REVOKED_EPOCH_KEY], claimB.lease.ownerEpoch, 'B\'s still-current revocation marker must be completely untouched');
  assert.equal(restoreLease(local, session).status, 'not-mine', 'this document rotated away its own identity escalating -- it no longer even matches the envelope\'s ownerId, let alone needs the revoked marker');
});

test('revokeLease: falls back to rotateTabId() when the epoch write fails, reports {ok:true, escalated:true}', () => {
  const local = fakeStorage(); // no envelope -- readEnvelope() resolves 'absent', so the write is attempted
  const session = throwingOnKey({}, REVOKED_EPOCH_KEY);
  const before = establishTabId(session);
  const result = revokeLease(local, session, { ownerId: before, ownerEpoch: 'epoch-1' });
  assert.equal(result.ok, true);
  assert.equal(result.escalated, true);
  assert.notEqual(session._store[TAB_ID_KEY], before, 'the rotation fallback must have actually landed');
});

test('revokeLease: reports {ok:false, escalated:true} only when BOTH the epoch write and the rotation fallback fail', () => {
  const session = fullyThrowingStorage();
  const result = revokeLease(fakeStorage(), session, { ownerId: 'tab-1', ownerEpoch: 'epoch-1' });
  assert.deepEqual(result, { ok: false, escalated: true });
});

// ── revokeLease() escalation × the tab-collision handshake: the caller-
// contract interaction (`/review-step` finding, 2026-08-15) — a FOURTH
// distinct bug found in this area today, this time not inside
// revokeLease() itself but in what a boot script must do AFTER calling it.
// handleIncomingProbe()/handleIncomingProbeReply() trust their
// caller-supplied `myTabId` parameter and never re-read storage
// themselves (by design — see the handshake section's own comment) — so a
// caller that refreshes its cached `myTabId` only on a HANDSHAKE-reported
// rotation, and misses a revokeLease() escalation (which also rotates
// TAB_ID_KEY), keeps comparing incoming probes against a STALE id. ───────
test('critical: a stale cached tabId after a revokeLease() escalation causes a genuine collision to go undetected', () => {
  const session = fakeStorage();
  const myTabId = establishTabId(session); // boot-time cached variable, per the documented pseudocode

  // revokeLease() escalates (envelope unavailable) -- rotates TAB_ID_KEY
  // internally. The caller here deliberately does NOT refresh its cached
  // myTabId, modeling exactly the wiring gap the finding describes.
  const result = revokeLease({ getItem: () => { throw new Error('unavailable'); } }, session, { ownerId: myTabId, ownerEpoch: 'e1' });
  assert.equal(result.escalated, true, 'sanity: this must actually be the escalation path');

  // A duplicated tab (byte-identical sessionStorage) now probes using the
  // CURRENT (rotated) id -- a genuine collision.
  const probe = { type: TAB_PROBE_MESSAGE, tabId: peekTabId(session), nonce: 'clone-nonce' };
  const withStaleCached = handleIncomingProbe(probe, session, myTabId, 'my-nonce', new Set());
  assert.equal(withStaleCached.reply, null, 'demonstrates the gap: a stale cached myTabId makes a real collision invisible -- no reply is ever sent');
  assert.equal(withStaleCached.rotated, false);
});

test('critical: refreshing myTabId after a revokeLease() escalation (the documented caller contract) correctly detects the same collision', () => {
  const session = fakeStorage();
  let myTabId = establishTabId(session);

  const result = revokeLease({ getItem: () => { throw new Error('unavailable'); } }, session, { ownerId: myTabId, ownerEpoch: 'e1' });
  if (result.escalated) myTabId = peekTabId(session); // the documented contract, followed correctly this time

  const probe = { type: TAB_PROBE_MESSAGE, tabId: peekTabId(session), nonce: 'clone-nonce' };
  const withFreshId = handleIncomingProbe(probe, session, myTabId, 'my-nonce', new Set());
  assert.ok(withFreshId.reply, 'following the documented contract, the same collision is correctly recognized and replied to');
});

// ── hasValidLease ───────────────────────────────────────────────────────
test('hasValidLease: false for a null or malformed lease', () => {
  const local = fakeStorage();
  const session = fakeStorage();
  assert.equal(hasValidLease(null, local, session), false);
  assert.equal(hasValidLease({ ownerId: 'a' }, local, session), false, 'missing ownerEpoch');
  assert.equal(hasValidLease({ ownerEpoch: 'e' }, local, session), false, 'missing ownerId');
});

test('hasValidLease: false when that exact epoch has been locally revoked', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  const claim = await claimOwnership(local, session, TEST_LOCK);
  revokeLease(local, session, claim.lease);
  assert.equal(hasValidLease(claim.lease, local, session), false);
});

test('hasValidLease: false when the envelope read is unavailable', () => {
  const lease = { ownerId: 'tab-1', ownerEpoch: 'epoch-1' };
  assert.equal(hasValidLease(lease, fullyThrowingStorage(), fakeStorage()), false);
});

test('hasValidLease: false when no envelope exists at all', () => {
  const lease = { ownerId: 'tab-1', ownerEpoch: 'epoch-1' };
  assert.equal(hasValidLease(lease, fakeStorage(), fakeStorage()), false);
});

test('hasValidLease: true when the lease matches the fresh envelope exactly', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  const claim = await claimOwnership(local, session, TEST_LOCK);
  assert.equal(hasValidLease(claim.lease, local, session), true);
});

test('hasValidLease: false when ownerId no longer matches (a different tab claimed) — gate 6', async () => {
  const local = fakeStorage();
  const sessionA = fakeStorage();
  establishTabId(sessionA);
  const sessionB = fakeStorage();
  establishTabId(sessionB);
  const claimA = await claimOwnership(local, sessionA, TEST_LOCK);
  await claimOwnership(local, sessionB, TEST_LOCK); // B displaces A
  assert.equal(hasValidLease(claimA.lease, local, sessionA), false);
});

test('hasValidLease: false when ownerId matches but ownerEpoch does not (same tab reclaimed since) — gate 7', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  const firstClaim = await claimOwnership(local, session, TEST_LOCK);
  await claimOwnership(local, session, TEST_LOCK); // the SAME tab reclaims -- a new epoch, same ownerId
  assert.equal(hasValidLease(firstClaim.lease, local, session), false,
    'the FIRST lease must no longer validate once superseded by the tab\'s own later claim');
});

// ── restoreLease: boot-time restoration, all six statuses ─────────────────
test('restoreLease: no-identity when establishTabId() never succeeded', () => {
  const result = restoreLease(fakeStorage(), fakeStorage()); // nothing established in sessionStore
  assert.deepEqual(result, { status: 'no-identity' });
});

test('restoreLease: unavailable when the envelope read itself throws', () => {
  const session = fakeStorage();
  establishTabId(session);
  const result = restoreLease(fullyThrowingStorage(), session);
  assert.deepEqual(result, { status: 'unavailable' });
});

test('restoreLease: unowned when no envelope exists at all', () => {
  const session = fakeStorage();
  establishTabId(session);
  const result = restoreLease(fakeStorage(), session);
  assert.deepEqual(result, { status: 'unowned', envelope: null });
});

test('restoreLease: unowned when an envelope exists but names no owner', () => {
  const session = fakeStorage();
  establishTabId(session);
  const envelope = buildEnvelope({ queue: [item('a')], ownerId: null, ownerEpoch: null });
  const local = fakeStorage({ [STATE_KEY]: JSON.stringify(envelope) });
  const result = restoreLease(local, session);
  assert.equal(result.status, 'unowned');
  assert.ok(result.envelope);
});

test('restoreLease: not-mine when the envelope names a different tab', async () => {
  const local = fakeStorage();
  const other = fakeStorage();
  establishTabId(other);
  await claimOwnership(local, other, TEST_LOCK);
  const session = fakeStorage();
  establishTabId(session);
  const result = restoreLease(local, session);
  assert.equal(result.status, 'not-mine');
});

test('restoreLease: revoked when the envelope names this tab but this exact epoch was locally revoked', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  const claim = await claimOwnership(local, session, TEST_LOCK);
  revokeLease(local, session, claim.lease);
  const result = restoreLease(local, session);
  assert.equal(result.status, 'revoked');
});

test('restoreLease: restored — adopts {ownerId, ownerEpoch} as the lease, no write performed', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  const claim = await claimOwnership(local, session, TEST_LOCK);
  const writeCountBefore = JSON.stringify(local._store);
  const result = restoreLease(local, session);
  assert.equal(result.status, 'restored');
  assert.deepEqual(result.lease, claim.lease);
  assert.equal(JSON.stringify(local._store), writeCountBefore, 'restoreLease() must never write');
});

// ── claimOwnership ──────────────────────────────────────────────────────
// Critical test 1: exactly one localStorage.setItem() call on the happy path.
test('critical: claimOwnership() performs exactly ONE localStorage.setItem() call on the happy path', async () => {
  const local = countingStorage();
  const session = fakeStorage();
  establishTabId(session);
  const result = await claimOwnership(local, session, TEST_LOCK);
  assert.equal(result.ok, true);
  assert.equal(local._counts.setItem, 1, 'no second store write may ever be part of this commit');
});

test('claimOwnership: fails with no-identity when no tab id has been established', async () => {
  const local = fakeStorage();
  const session = fakeStorage(); // establishTabId() never called
  const result = await claimOwnership(local, session, TEST_LOCK);
  assert.deepEqual(result, { ok: false, lease: null, envelope: null, reason: 'no-identity' });
  assert.equal(readEnvelope(local).status, 'absent', 'nothing may be written when identity is missing');
});

test('claimOwnership: fails with unavailable when the envelope read throws, without attempting a write', async () => {
  const session = fakeStorage();
  establishTabId(session);
  const local = fullyThrowingStorage();
  const result = await claimOwnership(local, session, TEST_LOCK);
  assert.deepEqual(result, { ok: false, lease: null, envelope: null, reason: 'unavailable' });
});

test('claimOwnership: fails with write-failed and leaves the previous envelope completely untouched', async () => {
  const session = fakeStorage();
  establishTabId(session);
  const good = fakeStorage();
  await claimOwnership(good, session, TEST_LOCK);
  const before = JSON.parse(good.getItem(STATE_KEY));

  const failingLocal = throwingStorage({ ...good._store });
  const result = await claimOwnership(failingLocal, session, TEST_LOCK);
  assert.deepEqual(result, { ok: false, lease: null, envelope: null, reason: 'write-failed' });
  assert.deepEqual(JSON.parse(failingLocal.getItem(STATE_KEY)), before, 'nothing to roll back -- the previous envelope must be exactly as it was');
});

test('critical: claimOwnership() attempts exactly ONE localStorage.setItem() call on the write-FAILURE path too, not just on the happy path', async () => {
  const session = fakeStorage();
  establishTabId(session);
  const failingLocal = throwingCountingStorage();
  const result = await claimOwnership(failingLocal, session, TEST_LOCK);
  assert.equal(result.ok, false);
  assert.equal(failingLocal._counts.setItem, 1, 'a hypothetical future rollback/second write on the failure path would show up here');
});

test('claimOwnership: preserves the existing envelope\'s queue/position content on a reclaim, only ownership fields change', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  const first = await claimOwnership(local, session, TEST_LOCK);
  await writeSession(local, session, first.lease, { queue: [item('a1')], currentItemId: 'a1', positionSec: 42, playing: true }, TEST_LOCK);

  const reclaim = await claimOwnership(local, session, TEST_LOCK); // e.g. an explicit local interaction
  assert.equal(reclaim.ok, true);
  assert.notEqual(reclaim.lease.ownerEpoch, first.lease.ownerEpoch, 'reclaiming mints a NEW epoch even for the same tab');
  assert.deepEqual(reclaim.envelope.queue.map((t) => t.id), ['a1'], 'queue content must survive a reclaim');
  assert.equal(reclaim.envelope.positionSec, 42, 'position must survive a reclaim');
});

test('claimOwnership: with no lock provider and no navigator.locks, takes the degraded no-lock path and writes nothing', async () => {
  assert.equal(typeof globalThis.navigator, 'undefined',
    'sanity check on this test\'s own premise -- if a later Node version ships a global navigator.locks, this test needs updating');
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  const result = await claimOwnership(local, session);
  assert.deepEqual(result, { ok: false, lease: null, envelope: null, reason: 'no-lock' });
  assert.equal(readEnvelope(local).status, 'absent', 'the fail-closed no-lock path must never write anything');
});

test('claimOwnership: requests the documented OWNERSHIP_LOCK_NAME from an injected provider', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  const namesSeen = [];
  const recordingProvider = (name, callback) => { namesSeen.push(name); return Promise.resolve(callback()); };
  await claimOwnership(local, session, recordingProvider);
  assert.deepEqual(namesSeen, [OWNERSHIP_LOCK_NAME]);
});

// ── writeSession ────────────────────────────────────────────────────────
test('writeSession: rejected when lease.ownerId no longer matches (a different tab claimed) — gate 6', async () => {
  const local = fakeStorage();
  const sessionA = fakeStorage();
  establishTabId(sessionA);
  const sessionB = fakeStorage();
  establishTabId(sessionB);
  const claimA = await claimOwnership(local, sessionA, TEST_LOCK);
  await claimOwnership(local, sessionB, TEST_LOCK); // B displaces A

  const wroteA = await writeSession(local, sessionA, claimA.lease, { queue: [item('a-late')], currentItemId: 'a-late', positionSec: 99, playing: true }, TEST_LOCK);
  assert.equal(wroteA, false, 'A\'s write, issued under its now-superseded lease, must be refused');
  assert.equal(readEnvelope(local).envelope.ownerId, peekTabId(sessionB), 'the envelope must still name B -- A\'s refused write left it untouched');
});

// Critical test — this is the sharpest test in the suite: round 5's actual
// bug, re-targeted at the new design. A stale write issued under an OLDER
// episode of the SAME tab's ownership (before it lost and regained the
// session) must be rejected purely because the CLOSURE it captured is no
// longer current -- no coordination with the write itself required.
test('critical: writeSession() rejected when ownerId matches but ownerEpoch does not (same tab reclaimed since) — gate 7 / round-5 regression', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  const firstClaim = await claimOwnership(local, session, TEST_LOCK);
  await writeSession(local, session, firstClaim.lease, { queue: [item('a1')], currentItemId: 'a1', positionSec: 0, playing: true }, TEST_LOCK);

  // The tab loses and regains ownership -- a genuinely NEW episode, same tab.
  const secondClaim = await claimOwnership(local, session, TEST_LOCK);
  await writeSession(local, session, secondClaim.lease, { queue: [item('a2')], currentItemId: 'a2', positionSec: 10, playing: true }, TEST_LOCK);

  // A DELAYED write, still holding the FIRST (now-stale) lease in its
  // closure -- e.g. a throttled position-save timer scheduled before the
  // reclaim, firing after it.
  const staleWrote = await writeSession(local, session, firstClaim.lease, { queue: [item('a-stale')], currentItemId: 'a-stale', positionSec: 999, playing: true }, TEST_LOCK);
  assert.equal(staleWrote, false, 'a write issued under a SUPERSEDED lease must never land, even from the same tab');
  assert.deepEqual(readEnvelope(local).envelope.queue.map((t) => t.id), ['a2'], 'the second, current episode\'s content must be completely unaffected by the stale write');
});

test('writeSession: succeeds when the lease matches the current envelope', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  const claim = await claimOwnership(local, session, TEST_LOCK);
  const wrote = await writeSession(local, session, claim.lease, { queue: [item('a1')], currentItemId: 'a1', positionSec: 5, playing: true }, TEST_LOCK);
  assert.equal(wrote, true);
  assert.deepEqual(readEnvelope(local).envelope.queue.map((t) => t.id), ['a1']);
});

test('writeSession: is a pure gate — never claims ownership itself, only writes when already validly leased', async () => {
  const local = fakeStorage();
  const sessionA = fakeStorage();
  establishTabId(sessionA);
  const sessionB = fakeStorage();
  await claimOwnership(local, sessionA, TEST_LOCK);

  // B never claims -- fabricates a lease naming itself and tries anyway.
  const fakeLease = { ownerId: establishTabId(sessionB), ownerEpoch: 'made-up-epoch' };
  const wroteB = await writeSession(local, sessionB, fakeLease, { queue: [item('sneaky')], currentItemId: 'sneaky', positionSec: 0, playing: true }, TEST_LOCK);
  assert.equal(wroteB, false);
});

test('writeSession: with no lock provider and no navigator.locks, takes the degraded false path and writes nothing', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  const claim = await claimOwnership(local, session, serializingLockProvider()); // claim via an injected provider so it succeeds despite the no-lock default below
  const before = readEnvelope(local).envelope;
  const wrote = await writeSession(local, session, claim.lease, { queue: [item('x')], currentItemId: 'x', positionSec: 1, playing: true });
  assert.equal(wrote, false);
  assert.deepEqual(readEnvelope(local).envelope, before, 'no-lock writeSession() must never touch the envelope');
});

test('tombstoneIfCurrent: with no lock provider and no navigator.locks, takes the degraded false path and attempts zero storage writes', async () => {
  const local = countingStorage();
  const session = fakeStorage();
  establishTabId(session);
  const claim = await claimOwnership(local, session, serializingLockProvider()); // claim via an injected provider so it succeeds despite the no-lock default below
  await writeSession(local, session, claim.lease, { queue: [item('a1')], currentItemId: 'a1', positionSec: 1, playing: true }, serializingLockProvider());
  const before = readEnvelope(local).envelope;
  const setItemCallsBefore = local._counts.setItem;
  const result = await tombstoneIfCurrent(local, session, claim.lease);
  assert.equal(result, false);
  assert.equal(local._counts.setItem, setItemCallsBefore, 'the fail-closed no-lock path must never even attempt a setItem() call, not merely leave the decoded content looking unchanged');
  assert.deepEqual(readEnvelope(local).envelope, before, 'no-lock tombstoneIfCurrent() must never touch the envelope');
});

test('writeSession: requests the documented OWNERSHIP_LOCK_NAME from an injected provider', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  const namesSeen = [];
  const recordingProvider = (name, callback) => { namesSeen.push(name); return Promise.resolve(callback()); };
  const claim = await claimOwnership(local, session, recordingProvider);
  namesSeen.length = 0;
  await writeSession(local, session, claim.lease, { queue: [], currentItemId: null, positionSec: 0, playing: false }, recordingProvider);
  assert.deepEqual(namesSeen, [OWNERSHIP_LOCK_NAME]);
});

// ── the TOCTOU gap between the second check and the write, and the Web
// Locks fix (same underlying concern as the old suite's finding #1, now
// proven against the fenced-lease design) ─────────────────────────────────
test('WITHOUT real serialization, a claim landing between writeSession()\'s second check and its write is wrongly let through', async () => {
  const local = fakeStorage();
  const sessionA = fakeStorage();
  establishTabId(sessionA);
  const sessionB = fakeStorage();
  establishTabId(sessionB);
  const provider = nonSerializingLockProvider();

  const claimA = await claimOwnership(local, sessionA, provider);
  await writeSession(local, sessionA, claimA.lease, { queue: [item('a1')], currentItemId: 'a1', positionSec: 0, playing: true }, provider);

  // writeSession() calls hasValidLease() (and therefore localStore.getItem())
  // exactly TWICE -- once up front, once again immediately before the write.
  // Triggering on the SECOND call lands a competing claim in the real gap
  // that follows it.
  const racyLocal = interleavedStorageAt(local, 2, () => {
    claimOwnership(local, sessionB, provider).then((claimB) =>
      writeSession(local, sessionB, claimB.lease, { queue: [item('b1')], currentItemId: 'b1', positionSec: 0, playing: true }, provider));
  });

  const wroteA = await writeSession(racyLocal, sessionA, claimA.lease, { queue: [item('a-late')], currentItemId: 'a-late', positionSec: 99, playing: true }, provider);

  // Documenting the gap that exists when a caller injects a provider that
  // does not actually serialize -- this is why claimOwnership()/
  // writeSession() fail closed entirely rather than fall back to running
  // unprotected (see the module's fail-closed decision).
  assert.equal(wroteA, true,
    'demonstrates the gap: a non-serializing provider lets A\'s stale write through');
});

test('WITH real serialization, the identical race construction cannot corrupt state', async () => {
  const local = fakeStorage();
  const sessionA = fakeStorage();
  establishTabId(sessionA);
  const sessionB = fakeStorage();
  establishTabId(sessionB);
  const provider = serializingLockProvider();

  const claimA = await claimOwnership(local, sessionA, provider);
  await writeSession(local, sessionA, claimA.lease, { queue: [item('a1')], currentItemId: 'a1', positionSec: 0, playing: true }, provider);

  let bWritePromise = null;
  const racyLocal = interleavedStorageAt(local, 2, () => {
    bWritePromise = (async () => {
      const claimB = await claimOwnership(local, sessionB, provider);
      return writeSession(local, sessionB, claimB.lease, { queue: [item('b1')], currentItemId: 'b1', positionSec: 0, playing: true }, provider);
    })();
  });

  const wroteA = await writeSession(racyLocal, sessionA, claimA.lease, { queue: [item('a-late')], currentItemId: 'a-late', positionSec: 99, playing: true }, provider);
  assert.equal(wroteA, true, 'A\'s own critical section still completes and succeeds on its own terms');

  const wroteB = await bWritePromise;
  assert.equal(wroteB, true, 'B\'s claim+write, properly serialized behind A\'s, must still succeed');
  assert.deepEqual(readEnvelope(local).envelope.queue.map((t) => t.id), ['b1'],
    'the lock forces B\'s claim to be evaluated strictly AFTER A\'s -- B correctly stands');
});

// ── tombstoneIfCurrent ──────────────────────────────────────────────────
// Critical test: proves a losing tab's tombstone can never stomp a fresher
// legitimate claim -- falls straight out of the same hasValidLease() gate
// writeSession() uses, not a separate safety argument.
test('critical: tombstoneIfCurrent() is a no-op when the lease no longer matches the current envelope', async () => {
  const local = fakeStorage();
  const sessionA = fakeStorage();
  establishTabId(sessionA);
  const sessionB = fakeStorage();
  establishTabId(sessionB);
  const claimA = await claimOwnership(local, sessionA, TEST_LOCK);
  await claimOwnership(local, sessionB, TEST_LOCK); // B displaces A
  const beforeTombstone = readEnvelope(local).envelope;

  const result = await tombstoneIfCurrent(local, sessionA, claimA.lease, TEST_LOCK);
  assert.equal(result, false);
  assert.deepEqual(readEnvelope(local).envelope, beforeTombstone, 'B\'s fresher claim must be completely unaffected');
});

test('tombstoneIfCurrent: clears ownerId/ownerEpoch while preserving queue/position content when the lease is current', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  const claim = await claimOwnership(local, session, TEST_LOCK);
  await writeSession(local, session, claim.lease, { queue: [item('a1')], currentItemId: 'a1', positionSec: 30, playing: true }, TEST_LOCK);

  const result = await tombstoneIfCurrent(local, session, claim.lease, TEST_LOCK);
  assert.equal(result, true);
  const envelope = readEnvelope(local).envelope;
  assert.equal(envelope.ownerId, null);
  assert.equal(envelope.ownerEpoch, null);
  assert.deepEqual(envelope.queue.map((t) => t.id), ['a1'], 'queue content must survive a tombstone');
  assert.equal(envelope.positionSec, 30);
});

// ── critical test 8: end-to-end sequencing through the (unchanged) collision
// handshake, converging into restoreLease() with neither side ever calling
// writeSession() in between ────────────────────────────────────────────────
function fakeChannel() {
  const members = [];
  return {
    join(onMessage) {
      const port = { onMessage };
      port.postMessage = (data) => members.forEach((m) => { if (m !== port) m.onMessage(data); });
      members.push(port);
      return port;
    },
  };
}

function wireDocument(channel, session, ref, nonce) {
  const resolved = new Set();
  let port;
  port = channel.join((msg) => {
    if (msg.type === TAB_PROBE_MESSAGE) {
      const { reply, rotated } = handleIncomingProbe(msg, session, ref.tabId, nonce, resolved);
      if (rotated) ref.tabId = peekTabId(session);
      if (reply) port.postMessage(reply);
    } else if (msg.type === TAB_PROBE_REPLY_MESSAGE) {
      const { rotated } = handleIncomingProbeReply(msg, session, ref.tabId, nonce, resolved);
      if (rotated) ref.tabId = peekTabId(session);
    }
  });
  return port;
}

test('critical: establishTabId -> collision handshake -> restoreLease() resolves exactly one duplicated tab to "restored", the other to "not-mine"', async () => {
  const local = fakeStorage();
  const channel = fakeChannel();
  const sharedTabId = establishTabId(fakeStorage());

  const firstSession = fakeStorage({ [TAB_ID_KEY]: sharedTabId });
  const firstRef = { tabId: sharedTabId };
  const firstNonce = 'nonce-zzz'; // larger -- first document wins
  const firstPort = wireDocument(channel, firstSession, firstRef, firstNonce);
  await claimOwnership(local, firstSession, TEST_LOCK);
  firstPort.postMessage({ type: TAB_PROBE_MESSAGE, tabId: firstRef.tabId, nonce: firstNonce });

  // A cloned tab (byte-identical sessionStorage) boots later and probes.
  const newcomerSession = fakeStorage({ ...firstSession._store });
  const newcomerRef = { tabId: sharedTabId };
  const newcomerNonce = 'nonce-aaa'; // smaller -- newcomer loses
  const newcomerPort = wireDocument(channel, newcomerSession, newcomerRef, newcomerNonce);
  newcomerPort.postMessage({ type: TAB_PROBE_MESSAGE, tabId: newcomerRef.tabId, nonce: newcomerNonce });

  assert.notEqual(firstRef.tabId, newcomerRef.tabId, 'the collision must be resolved -- different ids afterward');

  const firstResult = restoreLease(local, firstSession);
  const newcomerResult = restoreLease(local, newcomerSession);
  assert.equal(firstResult.status, 'restored');
  assert.equal(newcomerResult.status, 'not-mine');
  assert.deepEqual(firstResult.lease, { ownerId: firstRef.tabId, ownerEpoch: firstResult.lease.ownerEpoch });
});

// ── live tab-identity collision detection (unchanged by the redesign,
// carried forward verbatim except getTabId() -> peekTabId()/establishTabId()) ─
test('isTabProbeCollision: a same-tabId, different-nonce PROBE is a real collision', () => {
  assert.equal(isTabProbeCollision({ type: TAB_PROBE_MESSAGE, tabId: 'x', nonce: 'n2' }, 'x', 'n1'), true);
});

test('isTabProbeCollision: a different tabId is never a collision', () => {
  assert.equal(isTabProbeCollision({ type: TAB_PROBE_MESSAGE, tabId: 'y', nonce: 'n2' }, 'x', 'n1'), false);
});

test('isTabProbeCollision: the same nonce is never treated as a collision', () => {
  assert.equal(isTabProbeCollision({ type: TAB_PROBE_MESSAGE, tabId: 'x', nonce: 'n1' }, 'x', 'n1'), false);
});

test('isTabProbeCollision: ignores a message of the wrong type', () => {
  assert.equal(isTabProbeCollision({ type: TAB_PROBE_REPLY_MESSAGE, tabId: 'x', nonce: 'n2' }, 'x', 'n1'), false);
});

test('isTabProbeCollision: tolerates a malformed/missing message without throwing', () => {
  assert.equal(isTabProbeCollision(null, 'x', 'n1'), false);
  assert.equal(isTabProbeCollision({}, 'x', 'n1'), false);
  assert.equal(isTabProbeCollision({ type: TAB_PROBE_MESSAGE, tabId: 42, nonce: 'n2' }, 'x', 'n1'), false);
});

test('isTabProbeReplyForMe: matches only a REPLY whose tabId AND replyToNonce both match mine', () => {
  assert.equal(isTabProbeReplyForMe({ type: TAB_PROBE_REPLY_MESSAGE, tabId: 'x', replyToNonce: 'n1' }, 'x', 'n1'), true);
  assert.equal(isTabProbeReplyForMe({ type: TAB_PROBE_REPLY_MESSAGE, tabId: 'y', replyToNonce: 'n1' }, 'x', 'n1'), false);
  assert.equal(isTabProbeReplyForMe({ type: TAB_PROBE_REPLY_MESSAGE, tabId: 'x', replyToNonce: 'other' }, 'x', 'n1'), false);
  assert.equal(isTabProbeReplyForMe({ type: TAB_PROBE_MESSAGE, tabId: 'x', replyToNonce: 'n1' }, 'x', 'n1'), false);
  assert.equal(isTabProbeReplyForMe(null, 'x', 'n1'), false);
});

test('shouldRotateOnCollision is deterministic and symmetric between the two colliding sides', () => {
  const decisionForSmaller = shouldRotateOnCollision({ myNonce: 'aaa', theirNonce: 'zzz' });
  const decisionForLarger = shouldRotateOnCollision({ myNonce: 'zzz', theirNonce: 'aaa' });
  assert.notEqual(decisionForSmaller, decisionForLarger);
  assert.equal(decisionForSmaller, true);
});

test('shouldRotateOnCollision never rotates when there is no real difference to break a tie on', () => {
  assert.equal(shouldRotateOnCollision({ myNonce: 'n1', theirNonce: 'n1' }), false);
  assert.equal(shouldRotateOnCollision({ myNonce: null, theirNonce: 'n1' }), false);
  assert.equal(shouldRotateOnCollision({ myNonce: 'n1', theirNonce: null }), false);
});

test('generateNonce() output is NOT biased by generation order', () => {
  let earlierWinCount = 0;
  const trials = 30;
  for (let i = 0; i < trials; i++) {
    const earlier = generateNonce();
    const later = generateNonce();
    if (!shouldRotateOnCollision({ myNonce: earlier, theirNonce: later })) earlierWinCount++;
  }
  assert.ok(earlierWinCount >= 5 && earlierWinCount <= trials - 5,
    `expected roughly half of ${trials} trials to go either way (got ${earlierWinCount} "earlier wins")`);
});

test('generateNonce() output has no shared prefix across calls (no orderable time component)', () => {
  const a = generateNonce();
  const b = generateNonce();
  let commonPrefixLen = 0;
  while (commonPrefixLen < a.length && commonPrefixLen < b.length && a[commonPrefixLen] === b[commonPrefixLen]) {
    commonPrefixLen++;
  }
  assert.ok(commonPrefixLen <= 2, `two nonces share a ${commonPrefixLen}-character prefix ("${a.slice(0, commonPrefixLen)}")`);
});

test('a real durable owner is NOT immune to losing the tie-break — the outcome tracks the nonce, not "who is real"', async () => {
  const local = fakeStorage();
  const sharedTabId = establishTabId(fakeStorage());
  const ownerSession = fakeStorage({ [TAB_ID_KEY]: sharedTabId });
  await claimOwnership(local, ownerSession, TEST_LOCK);

  const cloneSession = fakeStorage({ ...ownerSession._store });
  const cloneResolved = new Set();
  const ownerResolved = new Set();
  const ownerNonce = 'nonce-aaa'; // smaller -- owner loses this time
  const cloneNonce = 'nonce-zzz';

  const probeFromOwner = { type: TAB_PROBE_MESSAGE, tabId: sharedTabId, nonce: ownerNonce };
  const { reply, rotated: cloneRotated } =
    handleIncomingProbe(probeFromOwner, cloneSession, sharedTabId, cloneNonce, cloneResolved);
  assert.equal(cloneRotated, false);

  const { rotated: ownerRotated } =
    handleIncomingProbeReply(reply, ownerSession, sharedTabId, ownerNonce, ownerResolved);
  assert.equal(ownerRotated, true, 'the REAL owner must be able to lose -- no role-based immunity');
  assert.equal(restoreLease(local, ownerSession).status, 'not-mine',
    'having rotated to a fresh id, the envelope (still naming the OLD shared id, now the clone\'s) no longer names this document');
  assert.equal(restoreLease(local, cloneSession).status, 'restored', 'the clone (winner of the coin flip) is now the confirmed owner');
});

test('simultaneous mutual probe between two clones — exactly one side rotates, never both, never neither', async () => {
  const local = fakeStorage();
  const sharedTabId = establishTabId(fakeStorage());
  const xSession = fakeStorage({ [TAB_ID_KEY]: sharedTabId });
  await claimOwnership(local, xSession, TEST_LOCK);
  const ySession = fakeStorage({ ...xSession._store });

  const xNonce = 'nonce-aaa';
  const yNonce = 'nonce-zzz';
  const xResolved = new Set();
  const yResolved = new Set();

  const probeFromX = { type: TAB_PROBE_MESSAGE, tabId: sharedTabId, nonce: xNonce };
  const probeFromY = { type: TAB_PROBE_MESSAGE, tabId: sharedTabId, nonce: yNonce };

  const { reply: replyFromY, rotated: yRotatedFromProbe } =
    handleIncomingProbe(probeFromX, ySession, sharedTabId, yNonce, yResolved);
  const { reply: replyFromX, rotated: xRotatedFromProbe } =
    handleIncomingProbe(probeFromY, xSession, sharedTabId, xNonce, xResolved);

  const { rotated: xRotatedFromReply } =
    handleIncomingProbeReply(replyFromY, xSession, sharedTabId, xNonce, xResolved);
  const { rotated: yRotatedFromReply } =
    handleIncomingProbeReply(replyFromX, ySession, sharedTabId, yNonce, yResolved);

  const xRotatedAtAll = xRotatedFromProbe || xRotatedFromReply;
  const yRotatedAtAll = yRotatedFromProbe || yRotatedFromReply;
  assert.equal(xRotatedAtAll, true);
  assert.equal(yRotatedAtAll, false);
  assert.notEqual(xSession._store[TAB_ID_KEY], sharedTabId);
  assert.equal(ySession._store[TAB_ID_KEY], sharedTabId);
});

test('handleIncomingProbe: no collision at all is a complete no-op', () => {
  const session = fakeStorage({ [TAB_ID_KEY]: 'x' });
  const { reply, rotated } = handleIncomingProbe({ type: TAB_PROBE_MESSAGE, tabId: 'y', nonce: 'n2' }, session, 'x', 'n1', new Set());
  assert.equal(reply, null);
  assert.equal(rotated, false);
  assert.equal(session._store[TAB_ID_KEY], 'x');
});

test('handleIncomingProbeReply: a reply not addressed to me is a complete no-op', () => {
  const session = fakeStorage({ [TAB_ID_KEY]: 'x' });
  const { rotated } = handleIncomingProbeReply({ type: TAB_PROBE_REPLY_MESSAGE, tabId: 'x', replyToNonce: 'someone-elses-nonce' }, session, 'x', 'n1', new Set());
  assert.equal(rotated, false);
  assert.equal(session._store[TAB_ID_KEY], 'x');
});

test('handleIncomingProbe: the same opposing nonce is only ever decided once (memoization)', () => {
  const sharedTabId = 'shared';
  const session = fakeStorage({ [TAB_ID_KEY]: sharedTabId });
  const resolved = new Set();
  const probe = { type: TAB_PROBE_MESSAGE, tabId: sharedTabId, nonce: 'nonce-zzz' };
  const first = handleIncomingProbe(probe, session, sharedTabId, 'nonce-aaa', resolved);
  assert.equal(first.rotated, true);
  const rotatedId = session._store[TAB_ID_KEY];

  const second = handleIncomingProbe(probe, session, sharedTabId, 'nonce-aaa', resolved);
  assert.equal(second.rotated, false);
  assert.equal(session._store[TAB_ID_KEY], rotatedId);
});

// ── runner ─────────────────────────────────────────────────────────────
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok   - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error('       ' + (err && err.stack ? err.stack : err));
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
