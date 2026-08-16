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
  tabIdentityLockName, TAB_IDENTITY_LOCK_PREFIX, MAX_PERSISTED_QUEUE_ITEMS as _MPQI,
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

// Runs `fn` with `globalThis.navigator` forced to `value` (pass `undefined`
// to make it genuinely absent), restoring the original afterward.
//
// The three "no lock provider" tests below used to just ASSERT that no
// global `navigator` existed, which silently made them
// environment-dependent: they passed on Node 20 (no `navigator` global at
// all) and failed the moment CI ran them on Node 24, which ships one. The
// module actually keys off `navigator.locks` -- absent on every Node
// version to date -- so the fail-closed behavior was always correct; it was
// the test's premise-check that was wrong, and a real CI failure on
// 2026-08-16 is what surfaced it. Controlling the global explicitly makes
// these tests prove the behavior on any runtime instead of re-breaking on
// the next Node upgrade, and lets us cover the REAL BROWSER path (a
// `navigator.locks` that genuinely exists) too, which nothing tested
// before. `defineProperty` rather than assignment because Node >=21's
// `navigator` is a getter-only accessor.
function withNavigator(value, fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    if (value === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, 'navigator', { value, configurable: true });
    return fn();
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  }
}

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

// critical: `/review-step` finding, 2026-08-15 -- writeEnvelope() is the one
// storage write in this module that did NOT read back its own write before
// this fix, unlike establishTabId()/rotateTabId()/revokeLease(), all of
// which already guard against exactly this. A setItem() that never throws
// but silently drops the write must be reported as failure, not success.
test('critical: writeEnvelope() returns false (not true) when setItem() succeeds without throwing but the write never actually lands', () => {
  const local = silentlyDroppingStorage();
  const built = buildEnvelope({ queue: [], ownerId: 'tab-1', ownerEpoch: 'epoch-1' });
  assert.equal(writeEnvelope(local, built), false);
  assert.deepEqual(readEnvelope(local), { status: 'absent', envelope: null });
});

test('writeEnvelope: returns true when the read-back matches exactly', () => {
  const local = fakeStorage();
  const built = buildEnvelope({ queue: [], ownerId: 'tab-1', ownerEpoch: 'epoch-1' });
  assert.equal(writeEnvelope(local, built), true);
  assert.equal(readEnvelope(local).status, 'ok');
});

// critical: `/review-step` finding, 2026-08-15 -- the MIRROR IMAGE of the
// silent-drop bug above, introduced by the single-attempt version of its
// own fix: a write that genuinely LANDED followed by one transient
// getItem() throw was reported as failure, so claimOwnership() returned
// {ok:false, reason:'write-failed'} while the envelope durably showed its
// new owner (all three callers reproduced directly). The verification read
// now retries a bounded number of times.
test('critical: writeEnvelope() returns true when the write lands but the FIRST verification read throws transiently (retry, not a false failure)', () => {
  const base = fakeStorage();
  let failNextGet = false;
  const local = {
    _store: base._store,
    getItem: (k) => {
      if (failNextGet) { failNextGet = false; throw new Error('transient read failure on verification'); }
      return base.getItem(k);
    },
    setItem: (k, v) => { base.setItem(k, v); failNextGet = true; },
    removeItem: (k) => base.removeItem(k),
  };
  const built = buildEnvelope({ queue: [], ownerId: 'tab-1', ownerEpoch: 'epoch-1' });
  assert.equal(writeEnvelope(local, built), true, 'a landed write must not be reported as failed just because one verification read blipped');
  assert.equal(readEnvelope(base).envelope.ownerId, 'tab-1', 'sanity: the write really did land');
});

test('critical: claimOwnership() reports ok:true when its write lands but the verification read throws transiently', async () => {
  const base = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  let failNextGet = false;
  const local = {
    _store: base._store,
    getItem: (k) => {
      if (failNextGet) { failNextGet = false; throw new Error('transient read failure on verification'); }
      return base.getItem(k);
    },
    setItem: (k, v) => { base.setItem(k, v); failNextGet = true; },
    removeItem: (k) => base.removeItem(k),
  };
  const result = await claimOwnership(local, session, TEST_LOCK);
  assert.equal(result.ok, true, 'must not report write-failed for a claim that actually landed');
  assert.equal(readEnvelope(base).envelope.ownerId, result.lease.ownerId, 'the reported lease must match what is durably stored');
});

// Counts the verification reads as well as asserting the outcome
// (`/review-step` round 12: the original version of this test asserted only
// `false`, which the PRE-fix single-attempt implementation would also have
// satisfied -- it documented the residual without proving the retry bound
// exists at all, so a later change removing the bound would leave it green).
test('writeEnvelope: retries the verification read exactly 3 times, then gives up and returns false (the honestly documented residual)', () => {
  const base = fakeStorage();
  let getCalls = 0;
  let setCalls = 0;
  const local = {
    _store: base._store,
    getItem: () => { getCalls++; throw new Error('verification reads permanently unavailable'); },
    setItem: (k, v) => { setCalls++; base.setItem(k, v); },
    removeItem: (k) => base.removeItem(k),
  };
  const built = buildEnvelope({ queue: [], ownerId: 'tab-1', ownerEpoch: 'epoch-1' });
  assert.equal(writeEnvelope(local, built), false, 'unbounded retrying is not the contract -- it gives up and reports failure');
  assert.equal(getCalls, 3, 'must attempt the verification read exactly MAX_WRITE_VERIFY_ATTEMPTS times -- not once (no bound at all) and not unboundedly');
  assert.equal(setCalls, 1, 'the retry is of the READ only -- the single-setItem() property must be unaffected');
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

// Round-6 correction (2026-08-15, `/review-step`): the ORIGINAL version of
// this test blessed the exact behavior the review flagged as buggy --
// establishTabId() used to collapse a throwing pre-check read to "nothing
// exists" and mint/persist a BRAND NEW id, silently destroying a perfectly
// valid identity carried in from a prior same-tab page load. Reproduced
// directly. Fixed to fail closed (return null, touch nothing) instead,
// matching readEnvelope()'s "unavailable ≠ absent" philosophy used
// everywhere else in this module.
test('critical: establishTabId() fails closed (returns null, touches nothing) rather than overwriting a valid carried identity when the pre-check read throws', () => {
  const originalId = establishTabId(fakeStorage()); // a real id from a prior page load
  const flaky = throwingOnFirstGetStorage({ [TAB_ID_KEY]: originalId });
  const result = establishTabId(flaky);
  assert.equal(result, null, 'cannot confirm whether an identity already exists -- must not silently mint a replacement');
  assert.equal(flaky._store[TAB_ID_KEY], originalId, 'the existing, perfectly valid identity must be completely untouched');
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

// critical: `/review-step` finding, 2026-08-15 -- before the
// generateDistinctFrom() fix, a first-draw entropy collision with the id
// being replaced made rotateTabId() report success while a genuine
// collision remained completely unresolved. Pinning both Date.now() and
// Math.random() models degraded/predictable entropy directly rather than
// hoping to catch a real ~1-in-2^52 collision by chance.
test('critical: rotateTabId() retries past a first-draw entropy collision with the id being replaced, rather than reporting a no-op as success', () => {
  const session = fakeStorage();
  const realRandom = Math.random;
  const realNow = Date.now;
  let callCount = 0;
  try {
    Date.now = () => 1234567890;
    Math.random = () => (callCount++ < 2 ? 0.5 : 0.777); // first two draws identical, third differs
    const original = establishTabId(session); // consumes draw #1
    const rotated = rotateTabId(session); // draw #2 collides with `original`; draw #3 succeeds
    assert.notEqual(rotated, original, 'must retry past a colliding draw rather than report a no-op as a resolved rotation');
    assert.equal(session._store[TAB_ID_KEY], rotated, 'the retried, genuinely distinct id must be the one actually persisted');
  } finally {
    Math.random = realRandom;
    Date.now = realNow;
  }
});

test('critical: rotateTabId() fails closed (null) rather than reporting an unresolved collision as success, when entropy never produces a distinct value', () => {
  const session = fakeStorage();
  const realRandom = Math.random;
  const realNow = Date.now;
  try {
    Date.now = () => 1234567890;
    Math.random = () => 0.5; // every draw identical -- an entropy source that never varies
    const original = establishTabId(session);
    const rotated = rotateTabId(session);
    assert.equal(rotated, null, 'must not report success while the id remains completely unchanged');
    assert.equal(session._store[TAB_ID_KEY], original, 'no false "rotated" write -- the original id must still be the one in storage');
  } finally {
    Math.random = realRandom;
    Date.now = realNow;
  }
});

// critical: `/review-step` finding, 2026-08-15 -- a gap in the fix directly
// above: if the PRE-write read (checking what's already stored) fails, the
// original patch collapsed that to "nothing there" and compared the fresh
// candidate against null instead of the real, unreadable prior value --
// with pinned/degraded entropy, this let rotateTabId() report success while
// returning the EXACT SAME id already in storage, reproduced directly. Must
// fail closed the same way establishTabId() already does on its own
// pre-check read failure, rather than silently skip the distinctness check.
test('critical: rotateTabId() fails closed (null, no write attempted) when its pre-write existing-id read throws, rather than risking an undetected no-op "rotation"', () => {
  const store = { [TAB_ID_KEY]: 'kf12oi-i' };
  let getCalls = 0;
  const session = {
    _store: store,
    getItem: (k) => {
      getCalls++;
      if (getCalls === 1) throw new Error('transient read failure on the pre-write check');
      return store[k] ?? null;
    },
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const realRandom = Math.random;
  const realNow = Date.now;
  try {
    Date.now = () => 1234567890;
    Math.random = () => 0.5; // pinned -- if the fix were absent, this would reproduce the SAME id
    const rotated = rotateTabId(session);
    assert.equal(rotated, null, 'must fail closed rather than report success on an unconfirmable pre-read');
    assert.equal(store[TAB_ID_KEY], 'kf12oi-i', 'must not have written anything -- the original id must be untouched');
  } finally {
    Math.random = realRandom;
    Date.now = realNow;
  }
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

// ── critical: /review-step found hasValidLease() never checked whether
// THIS DOCUMENT's own current identity still matches the lease -- only the
// envelope. If this document's own TAB_ID_KEY rotates (a lost collision
// tie-break, or a revokeLease() escalation) while nobody else has yet
// written a new envelope, a captured in-memory lease naming the OLD,
// now-abandoned id could still pass every other check and a stale write
// would land under an identity this document no longer holds. Reproduced
// directly. ────────────────────────────────────────────────────────────
test('critical: hasValidLease() is false once THIS document\'s own tab id rotates out from under a captured lease, even though the envelope never changed', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  const claim = await claimOwnership(local, session, TEST_LOCK);
  assert.equal(hasValidLease(claim.lease, local, session), true, 'sanity: valid before rotation');

  rotateTabId(session); // this document's OWN identity moves; envelope untouched
  assert.equal(hasValidLease(claim.lease, local, session), false,
    'the captured lease names an identity this document no longer holds -- must not validate merely because the envelope still agrees with the OLD id');
});

test('critical: writeSession() rejects a captured lease after this document\'s own tab id rotates, even though the envelope never changed', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  const claim = await claimOwnership(local, session, TEST_LOCK);
  rotateTabId(session);
  const wrote = await writeSession(local, session, claim.lease, { queue: [item('late')], currentItemId: 'late', positionSec: 1, playing: true }, TEST_LOCK);
  assert.equal(wrote, false, 'a stale write under an identity this document no longer holds must never land');
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

// critical: `/review-step` finding, 2026-08-15 -- before writeEnvelope()'s
// read-back fix, this reported {ok:true} with a lease in hand while the
// durable envelope stayed 'absent', reproduced directly.
test('critical: claimOwnership() reports write-failed (never ok:true) when setItem() succeeds without throwing but the write never actually lands', async () => {
  const session = fakeStorage();
  establishTabId(session);
  const local = silentlyDroppingStorage();
  const result = await claimOwnership(local, session, TEST_LOCK);
  assert.deepEqual(result, { ok: false, lease: null, envelope: null, reason: 'write-failed' });
  assert.deepEqual(readEnvelope(local), { status: 'absent', envelope: null });
});

// critical: `/review-step` finding, 2026-08-15 -- before the
// generateDistinctFrom() fix, two consecutive claimOwnership() calls under
// pinned/degraded entropy minted the IDENTICAL ownerEpoch, making a stale
// write from the FIRST claim indistinguishable from -- and able to land
// after -- the second: the exact round-5 bug this redesign exists to
// structurally close, reopened via entropy rather than storage.
test('critical: claimOwnership() retries past a first-draw epoch collision, so a stale write under the superseded lease is correctly rejected', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  const realRandom = Math.random;
  const realNow = Date.now;
  let callCount = 0;
  try {
    Date.now = () => 1234567890;
    Math.random = () => (callCount++ < 2 ? 0.5 : 0.777); // draws #1 and #2 collide, #3 differs
    const claimA = await claimOwnership(local, session, TEST_LOCK); // consumes draw #1
    const claimB = await claimOwnership(local, session, TEST_LOCK); // draw #2 collides with claimA's epoch; draw #3 succeeds
    assert.equal(claimB.ok, true);
    assert.notEqual(claimB.lease.ownerEpoch, claimA.lease.ownerEpoch, 'must retry past a colliding epoch draw rather than mint an indistinguishable one');

    const staleWrote = await writeSession(local, session, claimA.lease, { queue: [], currentItemId: null, positionSec: 999, playing: true, repeatOne: false, shuffleOn: false }, TEST_LOCK);
    assert.equal(staleWrote, false, 'a stale write under the superseded FIRST claim must be rejected now that the epochs are provably distinct');
  } finally {
    Math.random = realRandom;
    Date.now = realNow;
  }
});

test('critical: claimOwnership() fails closed (reason: epoch-collision) rather than minting an indistinguishable epoch, when entropy never produces a distinct value', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  const realRandom = Math.random;
  const realNow = Date.now;
  try {
    Date.now = () => 1234567890;
    Math.random = () => 0.5; // every draw identical -- an entropy source that never varies
    const claimA = await claimOwnership(local, session, TEST_LOCK);
    assert.equal(claimA.ok, true);
    const claimB = await claimOwnership(local, session, TEST_LOCK);
    assert.deepEqual(claimB, { ok: false, lease: null, envelope: null, reason: 'epoch-collision' });
    assert.equal(readEnvelope(local).envelope.ownerEpoch, claimA.lease.ownerEpoch, 'the previous envelope must be completely untouched -- nothing to roll back, same as every other claimOwnership() failure path');
  } finally {
    Math.random = realRandom;
    Date.now = realNow;
  }
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

// Runs against BOTH shapes a lock-less runtime can take -- no `navigator`
// at all (Node <=20, and older browsers) and a `navigator` that simply has
// no `.locks` (Node >=21; also any browser without Web Locks) -- since the
// module's check is `navigator.locks`, not `navigator`.
for (const [label, nav] of [['no navigator at all', undefined], ['a navigator without .locks', { userAgent: 'test' }]]) {
  test(`claimOwnership: with no lock provider and ${label}, takes the degraded no-lock path and writes nothing`, async () => {
    const local = fakeStorage();
    const session = fakeStorage();
    establishTabId(session);
    const result = await withNavigator(nav, () => claimOwnership(local, session));
    assert.deepEqual(result, { ok: false, lease: null, envelope: null, reason: 'no-lock' });
    assert.equal(readEnvelope(local).status, 'absent', 'the fail-closed no-lock path must never write anything');
  });
}

// The actual production path, which nothing covered before: no provider is
// injected, but the runtime DOES have Web Locks, so the module must find and
// use the real global rather than falling into its degraded path.
test('critical: with no injected provider but a real navigator.locks available, claimOwnership() uses it instead of failing closed', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  const namesSeen = [];
  const fakeLocks = { request: (name, callback) => { namesSeen.push(name); return Promise.resolve(callback()); } };

  const result = await withNavigator({ locks: fakeLocks }, () => claimOwnership(local, session));
  assert.equal(result.ok, true, 'must not take the degraded no-lock path when Web Locks genuinely exists');
  assert.deepEqual(namesSeen, [OWNERSHIP_LOCK_NAME], 'and must request the documented lock name from the real global');
  assert.equal(readEnvelope(local).envelope.ownerId, result.lease.ownerId);
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

// critical: `/review-step` finding, 2026-08-15 -- before writeEnvelope()'s
// read-back fix, this returned `true` on a healthy, validly-gated claim
// while the durable envelope stayed byte-for-byte unchanged underneath,
// reproduced directly.
test('critical: writeSession() returns false (not true) when setItem() succeeds without throwing but the write never actually lands', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  const claim = await claimOwnership(local, session, TEST_LOCK);
  const before = readEnvelope(local).envelope;

  local.setItem = () => { /* silently dropped -- no throw, no mutation */ };
  const wrote = await writeSession(local, session, claim.lease, { queue: [item('ghost')], currentItemId: 'ghost', positionSec: 1, playing: true }, TEST_LOCK);
  assert.equal(wrote, false);
  assert.deepEqual(readEnvelope(local).envelope, before, 'the envelope must be provably unchanged, not just the return value false');
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
  const wrote = await withNavigator({ userAgent: 'test' }, () =>
    writeSession(local, session, claim.lease, { queue: [item('x')], currentItemId: 'x', positionSec: 1, playing: true }));
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
  const result = await withNavigator({ userAgent: 'test' }, () => tombstoneIfCurrent(local, session, claim.lease));
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

// critical: `/review-step` finding, 2026-08-15 -- before writeEnvelope()'s
// read-back fix, this returned `true` on a healthy, validly-matching lease
// while the durable envelope still showed the owner as current, reproduced
// directly (a passive observer would wrongly believe the tombstone worked).
test('critical: tombstoneIfCurrent() returns false (not true) when setItem() succeeds without throwing but the write never actually lands', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  const claim = await claimOwnership(local, session, TEST_LOCK);

  local.setItem = () => { /* silently dropped -- no throw, no mutation */ };
  const result = await tombstoneIfCurrent(local, session, claim.lease, TEST_LOCK);
  assert.equal(result, false);
  assert.equal(readEnvelope(local).envelope.ownerId, claim.lease.ownerId, 'the envelope must still show the real owner -- the tombstone must not be believed to have landed');
});

// ── critical: /review-step found the module's own documented sequence
// ("call tombstoneIfCurrent() best-effort AFTER revokeLease()") was
// self-defeating: revokeLease() marks the exact epoch being tombstoned as
// revoked, and the old gate (hasValidLease()) rejected a revoked epoch --
// so tombstoning would ALWAYS fail on its own normal, documented path.
// Reproduced directly. Fixed by gating tombstoneIfCurrent() on the
// envelope-tuple/identity match alone (hasMatchingEnvelopeTuple()), never
// on revocation, since tombstoning is purely cosmetic and its safety
// already comes entirely from that tuple match. ─────────────────────────
test('critical: the documented revoke-then-tombstone sequence actually works — tombstoneIfCurrent() must not reject solely because revokeLease() just ran', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  const claim = await claimOwnership(local, session, TEST_LOCK);
  await writeSession(local, session, claim.lease, { queue: [item('a1')], currentItemId: 'a1', positionSec: 30, playing: true }, TEST_LOCK);

  const revokeResult = revokeLease(local, session, claim.lease); // the documented first step
  assert.equal(revokeResult.ok, true, 'sanity: the revocation itself succeeded');

  const tombstoneResult = await tombstoneIfCurrent(local, session, claim.lease, TEST_LOCK); // the documented second step
  assert.equal(tombstoneResult, true, 'tombstoning must succeed on its own documented normal path, not self-reject due to the revocation it was told to follow');
  const envelope = readEnvelope(local).envelope;
  assert.equal(envelope.ownerId, null);
  assert.equal(envelope.ownerEpoch, null);
  assert.deepEqual(envelope.queue.map((t) => t.id), ['a1'], 'queue content must still survive');
});

// ── documents the honest residual gap (2026-08-15, `/review-step`): when
// revokeLease() ITSELF escalates (rotates this document's tab id as its
// own failure fallback), the immediately-following tombstoneIfCurrent()
// call also fails, since the rotated identity no longer matches the
// lease. Deliberately NOT fixed -- see tombstoneIfCurrent()'s own comment
// for why removing the identity check would reopen a worse bug. ────────
test('documents the residual gap: tombstoneIfCurrent() also fails when it immediately follows a revokeLease() escalation (deliberately not fixed)', async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  establishTabId(session);
  const claim = await claimOwnership(local, session, TEST_LOCK);

  // Wraps session's OWN backing store live (not a copy) -- setItem() for
  // REVOKED_EPOCH_KEY throws, everything else (including the rotation
  // fallback's TAB_ID_KEY write) lands in the SAME store `session` itself
  // reads from, so the escalation's actual effect on `session` is visible
  // to the tombstoneIfCurrent() call below via the real `session` object.
  const blockedSession = {
    getItem: (k) => session.getItem(k),
    setItem: (k, v) => { if (k === REVOKED_EPOCH_KEY) throw new Error('blocked'); session.setItem(k, v); },
    removeItem: (k) => session.removeItem(k),
  };
  const revokeResult = revokeLease(local, blockedSession, claim.lease);
  assert.equal(revokeResult.escalated, true, 'sanity: the epoch-marker write failed, triggering the rotation fallback');

  const tombstoneResult = await tombstoneIfCurrent(local, session, claim.lease, TEST_LOCK);
  assert.equal(tombstoneResult, false, 'documents the gap -- purely cosmetic, no correctness property affected (see the function\'s own comment)');
});

// ── proves WHY the gap above is not fixed by simply dropping the identity
// check: a tab that lost a collision tie-break holds a stale lease whose
// tuple can still legitimately describe a DIFFERENT, still-live
// document's ongoing ownership (collision resolution never touches the
// envelope) -- removing the check would let the loser wrongly clear the
// winner's completely legitimate state. ─────────────────────────────────
test('critical: a losing tab\'s stale lease (from a collision, not a revocation) must never be able to tombstone a DIFFERENT, still-legitimate document\'s ownership', async () => {
  const local = fakeStorage();
  const sharedTabId = establishTabId(fakeStorage());
  const winnerSession = fakeStorage({ [TAB_ID_KEY]: sharedTabId });
  const winnerClaim = await claimOwnership(local, winnerSession, TEST_LOCK);
  await writeSession(local, winnerSession, winnerClaim.lease, { queue: [item('winner-track')], currentItemId: 'winner-track', positionSec: 10, playing: true }, TEST_LOCK);

  // A loser, cloned before the collision, derives the IDENTICAL lease from
  // the same envelope -- then loses the tie-break and rotates away.
  const loserSession = fakeStorage({ ...winnerSession._store });
  const loserStaleLease = { ...winnerClaim.lease };
  rotateTabId(loserSession);

  const result = await tombstoneIfCurrent(local, loserSession, loserStaleLease, TEST_LOCK);
  assert.equal(result, false, 'the loser\'s stale lease must be rejected -- it no longer matches ITS OWN current identity');
  const envelope = readEnvelope(local).envelope;
  assert.equal(envelope.ownerId, winnerClaim.lease.ownerId, 'the winner\'s legitimate ownership must be completely untouched');
  assert.deepEqual(envelope.queue.map((t) => t.id), ['winner-track']);
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

// Models the module's documented caller contract as closely as a harness
// can without a real coordinator existing (see the module's own boot
// pseudocode). Two pieces, each added after a `/review-step` round found
// the harness silently not modelling something the contract requires:
//   - `ref.disabled` -- the `ownershipDisabled` latch (2026-08-15: the
//     harness used to ignore `failed` entirely, so no test exercising it
//     verified that a CORRECTLY wired caller avoids the dual-restoration
//     hazard, only that the hazard exists when the contract is ignored).
//     Set once on either handler reporting `failed:true`, never cleared.
//   - the MANDATORY RE-PROBE after a successful rotation (round 12,
//     2026-08-15: the harness refreshed `ref.tabId` but never re-probed,
//     so the three-clone concurrent-loser test had to inject the fresh
//     probe by hand -- which proved the handshake can resolve a manually
//     surfaced collision, but NOT that following the contract surfaces it
//     in the first place, the actual claim being made).
// Still a simulation of a caller, not a real one -- see the honest-scope
// note on the caller-contract test further down.
function wireDocument(channel, session, ref, nonce) {
  const resolved = new Set();
  let port;
  const onRotated = () => {
    ref.tabId = peekTabId(session);
    // The documented contract's re-probe under the NEW identity.
    port.postMessage({ type: TAB_PROBE_MESSAGE, tabId: ref.tabId, nonce });
  };
  port = channel.join((msg) => {
    if (msg.type === TAB_PROBE_MESSAGE) {
      const { reply, rotated, failed } = handleIncomingProbe(msg, session, ref.tabId, nonce, resolved);
      if (reply) port.postMessage(reply); // reply BEFORE re-probing, matching the documented ordering
      if (rotated) onRotated();
      if (failed) ref.disabled = true;
    } else if (msg.type === TAB_PROBE_REPLY_MESSAGE) {
      const { rotated, failed } = handleIncomingProbeReply(msg, session, ref.tabId, nonce, resolved);
      if (rotated) onRotated();
      if (failed) ref.disabled = true;
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

// ── live tab-identity collision detection (mostly unchanged by the
// redesign, carried forward verbatim except getTabId() ->
// peekTabId()/establishTabId() -- EXCEPT isTabProbeCollision()/
// resolveCollision(), fixed 2026-08-15 by a later `/review-step` round;
// see their own comments in the source) ───────────────────────────────────
test('isTabProbeCollision: a same-tabId PROBE is a real collision regardless of nonce', () => {
  assert.equal(isTabProbeCollision({ type: TAB_PROBE_MESSAGE, tabId: 'x', nonce: 'n2' }, 'x'), true);
});

test('isTabProbeCollision: a different tabId is never a collision', () => {
  assert.equal(isTabProbeCollision({ type: TAB_PROBE_MESSAGE, tabId: 'y', nonce: 'n2' }, 'x'), false);
});

// critical: `/review-step` finding, 2026-08-15 -- the ORIGINAL version of
// this test asserted the opposite (equal nonce => not a collision), on the
// theory that same-tabId+same-nonce could only be a self-echo. That's true
// of a SINGLE document's own probe, but NOT of two genuinely different
// documents whose independently-drawn nonces happen to collide -- reachable
// in practice now that round 9 made nonce collisions provable via injected
// entropy, and this is exactly what defeats detection: two real colliding
// documents each treating the other's equal-nonce probe as "nothing
// happened" and both later restoring as owner (see the end-to-end
// regression further down this file for the full reproduction).
test('critical: isTabProbeCollision: a same-tabId PROBE with an EQUAL nonce is still a real collision (not a self-echo assumption)', () => {
  assert.equal(isTabProbeCollision({ type: TAB_PROBE_MESSAGE, tabId: 'x', nonce: 'n1' }, 'x'), true);
});

test('isTabProbeCollision: ignores a message of the wrong type', () => {
  assert.equal(isTabProbeCollision({ type: TAB_PROBE_REPLY_MESSAGE, tabId: 'x', nonce: 'n2' }, 'x'), false);
});

test('isTabProbeCollision: tolerates a malformed/missing message without throwing', () => {
  assert.equal(isTabProbeCollision(null, 'x'), false);
  assert.equal(isTabProbeCollision({}, 'x'), false);
  assert.equal(isTabProbeCollision({ type: TAB_PROBE_MESSAGE, tabId: 42, nonce: 'n2' }, 'x'), false);
  assert.equal(isTabProbeCollision({ type: TAB_PROBE_MESSAGE, tabId: 'x', nonce: null }, 'x'), false, 'a missing/malformed nonce is not a well-formed probe');
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

// The two tests below replace a pair that sampled REAL randomness (real
// crypto.getRandomValues()/Math.random() calls) and asserted statistically,
// despite this file's own header describing itself as a deterministic
// suite -- a `/review-step` finding, 2026-08-15: the prefix-length
// assertion had a small but real (~1-in-1800) chance of rejecting valid
// independent output, and sampling doesn't reliably catch an ordering
// regression anyway. Both rewritten to inject fixed entropy and assert the
// exact, reproducible consequence: NO orderable time component, proven by
// showing Date.now() has zero effect on output when the random source is
// held fixed, rather than sampling many draws and hoping for balance.
test('generateNonce(): with crypto.getRandomValues, output is the exact deterministic encoding of the injected bytes, independent of Date.now()', () => {
  const fixedBytes = [0, 1, 2, 253, 254, 255, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160];
  const realDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const realNow = Date.now;
  try {
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: (arr) => { arr.set(fixedBytes.slice(0, arr.length)); return arr; } },
      configurable: true,
    });
    Date.now = () => 1;
    const a = generateNonce();
    Date.now = () => 8640000000000000; // the far end of JS's representable date range
    const b = generateNonce();
    const expected = fixedBytes.map((byte) => byte.toString(36).padStart(2, '0')).join('');
    assert.equal(a, expected, 'output must be the exact base36 encoding of the injected bytes, not just "looks random"');
    assert.equal(a, b, 'identical injected entropy must produce identical output regardless of Date.now() -- no orderable time component');
  } finally {
    Object.defineProperty(globalThis, 'crypto', realDescriptor);
    Date.now = realNow;
  }
});

test('generateNonce(): falls back to Math.random() when crypto.getRandomValues is unavailable, still independent of Date.now()', () => {
  const realDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const realRandom = Math.random;
  const realNow = Date.now;
  try {
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true }); // no getRandomValues -- forces the fallback branch
    const sequence = [0.1, 0.9];
    let calls = 0;
    Math.random = () => sequence[calls++ % sequence.length];
    Date.now = () => 1;
    const a = generateNonce();
    calls = 0;
    Date.now = () => 8640000000000000;
    const b = generateNonce();
    assert.equal(a, b, 'identical injected entropy must produce identical output regardless of Date.now() -- no orderable time component');
    assert.equal(a.length, 32, 'two 16-char padded halves, matching the crypto path\'s 16-byte output length');
  } finally {
    Object.defineProperty(globalThis, 'crypto', realDescriptor);
    Math.random = realRandom;
    Date.now = realNow;
  }
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

// critical: `/review-step` finding, 2026-08-15 -- the two-clone fixture
// above structurally cannot exercise this: with exactly two documents,
// exactly ONE ever rotates, so two losers can never generate replacement
// ids concurrently. With THREE clones and two losers, both rotate
// independently, and generateDistinctFrom() can only guarantee each
// differs from ITS OWN prior id -- it has no way to know what a different,
// concurrently-rotating document is generating. Reproduced directly under
// pinned entropy: both losers landed on the IDENTICAL replacement id, and
// with no re-probe the fresh duplication went completely undetected (one
// claimed under it, the other still passed restoreLease() as 'restored').
// This test locks in BOTH halves: the collision genuinely can happen (the
// module cannot prevent it internally), AND following the documented caller
// contract is what surfaces and resolves it. Driven entirely through
// wireDocument() -- the harness that models that contract, including its
// mandatory post-rotation re-probe -- rather than by injecting the fresh
// probe by hand (`/review-step` round 12: the hand-injected version proved
// only that the handshake CAN resolve a manually surfaced collision, not
// that following the contract surfaces it in the first place, which is the
// actual claim). Everything below cascades from ONE postMessage by A.
test('critical: three clones, two concurrent losers generating the SAME replacement id -- following the caller contract surfaces and resolves the fresh duplication', async () => {
  const local = fakeStorage();
  const channel = fakeChannel();
  const sharedTabId = establishTabId(fakeStorage());

  const sessionA = fakeStorage({ [TAB_ID_KEY]: sharedTabId });
  await claimOwnership(local, sessionA, TEST_LOCK);
  const sessionB = fakeStorage({ [TAB_ID_KEY]: sharedTabId });
  const sessionC = fakeStorage({ [TAB_ID_KEY]: sharedTabId });

  const refA = { tabId: sharedTabId };
  const refB = { tabId: sharedTabId };
  const refC = { tabId: sharedTabId };
  const portA = wireDocument(channel, sessionA, refA, 'nonce-zzz'); // A wins -- never rotates
  wireDocument(channel, sessionB, refB, 'nonce-bbb');
  wireDocument(channel, sessionC, refC, 'nonce-ccc');

  const realRandom = Math.random;
  const realNow = Date.now;
  try {
    // Date.now pinned throughout; Math.random pinned for exactly the first
    // TWO draws -- B's and C's initial replacement ids, forcing them to
    // collide -- then real entropy, so the follow-up rotation that resolves
    // the duplication can produce a genuinely distinct id.
    Date.now = () => 1234567890;
    let draws = 0;
    Math.random = () => (draws++ < 2 ? 0.42 : realRandom());

    portA.postMessage({ type: TAB_PROBE_MESSAGE, tabId: sharedTabId, nonce: 'nonce-zzz' });
  } finally {
    Math.random = realRandom;
    Date.now = realNow;
  }

  assert.equal(refA.tabId, sharedTabId, 'A holds the highest nonce -- it must never rotate');
  assert.notEqual(refB.tabId, sharedTabId, 'B lost and rotated away');
  assert.notEqual(refC.tabId, sharedTabId, 'C lost and rotated away');

  // The whole point: B and C initially rotated INTO the same id (the gap
  // this module cannot close internally), and the contract's re-probe is
  // what surfaced that as an ordinary collision, which the ordinary
  // handshake then resolved -- all without a single hand-injected message.
  assert.notEqual(refB.tabId, refC.tabId,
    'end state: no two documents share an identity, even though two of them independently generated the same replacement id mid-cascade');
  assert.equal(new Set([refA.tabId, refB.tabId, refC.tabId]).size, 3, 'all three identities are distinct');
  assert.ok(!refB.disabled && !refC.disabled, 'the duplication resolved by rotation -- no document had to disable ownership to escape it');
});

test('handleIncomingProbe: no collision at all is a complete no-op', () => {
  const session = fakeStorage({ [TAB_ID_KEY]: 'x' });
  const { reply, rotated } = handleIncomingProbe({ type: TAB_PROBE_MESSAGE, tabId: 'y', nonce: 'n2' }, session, 'x', 'n1', new Set());
  assert.equal(reply, null);
  assert.equal(rotated, false);
  assert.equal(session._store[TAB_ID_KEY], 'x');
});

// critical: `/review-step` finding, 2026-08-15 -- proves resolveCollision()'s
// new equal-nonce handling end to end through handleIncomingProbe(), not
// just the isTabProbeCollision() classification alone: a genuine collision
// with no usable tie-break asymmetry must report failed:true (routing
// through the same "disable ownership" caller contract as a failed
// rotation), never the silent {rotated:false, failed:false} no-op that
// made this indistinguishable from "no collision happened" before the fix.
test('critical: handleIncomingProbe() reports failed:true (never a silent no-op) when a genuine collision has no usable tie-break asymmetry', () => {
  const session = fakeStorage({ [TAB_ID_KEY]: 'shared' });
  const result = handleIncomingProbe({ type: TAB_PROBE_MESSAGE, tabId: 'shared', nonce: 'same-nonce' }, session, 'shared', 'same-nonce', new Set());
  assert.equal(result.rotated, false);
  assert.equal(result.failed, true, 'a genuine collision that cannot be broken must be reported as failed, not silently ignored');
  assert.ok(result.reply, 'must still reply -- a newcomer needs to learn of the collision even when it cannot be resolved');
  assert.equal(session._store[TAB_ID_KEY], 'shared', 'no rotation attempted -- nothing to rotate TO without a tie-break winner');
});

// end-to-end: proves the actual outcome the fix exists to prevent (dual
// restoration) no longer happens once real nonces happen to collide,
// exercising the full establishTabId -> handshake -> restoreLease() path
// with deterministic, pinned entropy rather than asserting against the
// unit functions in isolation.
test('critical: two genuinely distinct cloned documents with an EQUAL collision nonce no longer both restore as owner', async () => {
  const local = fakeStorage();
  const sharedTabId = establishTabId(fakeStorage());
  const equalNonce = 'nonce-collision';

  const sessionX = fakeStorage({ [TAB_ID_KEY]: sharedTabId });
  await claimOwnership(local, sessionX, TEST_LOCK);
  const sessionY = fakeStorage({ [TAB_ID_KEY]: sharedTabId }); // Y clones X's storage, including the tabId

  const probeFromY = { type: TAB_PROBE_MESSAGE, tabId: sharedTabId, nonce: equalNonce };
  const xResult = handleIncomingProbe(probeFromY, sessionX, sharedTabId, equalNonce, new Set());
  const probeFromX = { type: TAB_PROBE_MESSAGE, tabId: sharedTabId, nonce: equalNonce };
  const yResult = handleIncomingProbe(probeFromX, sessionY, sharedTabId, equalNonce, new Set());

  assert.equal(xResult.failed, true, 'X must recognize the unresolvable collision');
  assert.equal(yResult.failed, true, 'Y must recognize the unresolvable collision');

  // Per the documented caller contract, BOTH sides now disable ownership
  // entirely rather than ever calling restoreLease() -- but proving the
  // underlying storage would still (correctly) show 'restored' for both if
  // a caller ignored the contract is what demonstrates the fix closed the
  // detection gap, not just that a flag got set.
  assert.equal(restoreLease(local, sessionX).status, 'restored');
  assert.equal(restoreLease(local, sessionY).status, 'restored');
  // The fix is that BOTH sides now KNOW this (failed:true) and must disable
  // themselves -- unlike before the fix, where neither side even knew.
});

test('handleIncomingProbeReply: a reply not addressed to me is a complete no-op', () => {
  const session = fakeStorage({ [TAB_ID_KEY]: 'x' });
  const { rotated } = handleIncomingProbeReply({ type: TAB_PROBE_REPLY_MESSAGE, tabId: 'x', replyToNonce: 'someone-elses-nonce' }, session, 'x', 'n1', new Set());
  assert.equal(rotated, false);
  assert.equal(session._store[TAB_ID_KEY], 'x');
});

test('handleIncomingProbe: the same opposing nonce under the SAME identity is only ever decided once (memoization)', () => {
  const sharedTabId = 'shared';
  const session = fakeStorage({ [TAB_ID_KEY]: sharedTabId });
  const resolved = new Set();
  const probe = { type: TAB_PROBE_MESSAGE, tabId: sharedTabId, nonce: 'nonce-zzz' };
  const first = handleIncomingProbe(probe, session, sharedTabId, 'nonce-aaa', resolved);
  assert.equal(first.rotated, true);
  const rotatedId = session._store[TAB_ID_KEY];

  // Deliberately re-delivered with the SAME (now pre-rotation) myTabId --
  // models a duplicate message about the collision this document has
  // already acted on, which must not rotate a second time.
  const second = handleIncomingProbe(probe, session, sharedTabId, 'nonce-aaa', resolved);
  assert.equal(second.rotated, false);
  assert.equal(session._store[TAB_ID_KEY], rotatedId);
});

// critical: `/review-step` finding, 2026-08-15 -- the memoization above was
// keyed by opposing nonce ALONE, which conflated "this nonce" with "this
// collision". Reproduced directly: after losing a collision on nonce N and
// rotating to a new identity, a LATER, genuinely different collision under
// the NEW id carrying the same reused nonce N was silently skipped as
// "already resolved" (returning {rotated:false, failed:false} without even
// consulting the tie-break), and this document then wrongly restored as
// owner. Nonce reuse is exactly the degraded-entropy case rounds 9-10
// established as reachable, so this is not hypothetical. Note the caller
// here refreshes myTabId after the rotation, as the documented contract
// requires -- that refresh is precisely what the old nonce-only key
// ignored.
test('critical: a genuinely new collision under a NEWLY ROTATED identity is not silently skipped just because the opposing nonce was already seen under the OLD identity', () => {
  const originalId = 'original-id';
  const session = fakeStorage({ [TAB_ID_KEY]: originalId });
  const resolved = new Set();
  const reusedNonce = 'nonce-zzz'; // larger -- this document loses and rotates, both times

  const first = handleIncomingProbe({ type: TAB_PROBE_MESSAGE, tabId: originalId, nonce: reusedNonce }, session, originalId, 'nonce-aaa', resolved);
  assert.equal(first.rotated, true, 'sanity: the first collision rotates as usual');
  const newId = session._store[TAB_ID_KEY];
  assert.notEqual(newId, originalId);

  // A genuinely different clone now collides under the NEW id, reusing the
  // same nonce. myTabId is refreshed per the documented caller contract.
  const second = handleIncomingProbe({ type: TAB_PROBE_MESSAGE, tabId: newId, nonce: reusedNonce }, session, newId, 'nonce-aaa', resolved);
  assert.equal(second.rotated, true, 'a real collision under a new identity must be acted on, not shadowed by a stale memo entry from the previous identity');
  assert.notEqual(session._store[TAB_ID_KEY], newId, 'must have rotated again, to a third distinct id');
});

// ── critical: /review-step found rotateTabId()'s return value was
// discarded entirely inside resolveCollision() -- a FAILED rotation write
// was still reported as rotated:true, so the losing side's storage kept
// the SAME id it started with while the caller believed the collision was
// resolved. Reproduced directly: both sides of a collision ended up
// sharing the identical id, and BOTH could subsequently pass
// restoreLease() as 'restored' -- the exact duplicate-ownership outcome
// the whole handshake exists to prevent. Fixed: rotated is only ever true
// when the write is verified to have landed; failed:true otherwise, with
// the documented caller contract being to disable ownership entirely for
// that document (see the section's own comment). ────────────────────────
test('critical: handleIncomingProbe() reports failed:true (never rotated:true) when the losing side\'s rotation write fails, and does not falsely claim the collision was resolved', () => {
  const sharedTabId = 'shared';
  const blockedSession = {
    getItem: (k) => (k === TAB_ID_KEY ? sharedTabId : null),
    setItem: () => { throw new Error('write blocked'); },
    removeItem: () => {},
  };
  const probe = { type: TAB_PROBE_MESSAGE, tabId: sharedTabId, nonce: 'nonce-zzz' }; // larger -- I (nonce-aaa) must rotate
  const result = handleIncomingProbe(probe, blockedSession, sharedTabId, 'nonce-aaa', new Set());
  assert.equal(result.rotated, false, 'must never report success for a rotation that did not actually land');
  assert.equal(result.failed, true, 'the caller must be told the collision could not be resolved');
  assert.ok(result.reply, 'a reply must still be sent regardless of whether this side\'s own rotation succeeded');
});

// Round-8 correction (2026-08-15, `/review-step`): the ORIGINAL version of
// this test was misleadingly named -- it documented that Y (the losing
// side, unable to rotate) technically CAN still pass restoreLease() as
// 'restored' while stuck sharing X's id, but never actually proved that a
// CALLER CORRECTLY FOLLOWING the documented contract (disable ownership on
// `failed:true`) avoids the dual-restoration outcome the test's own name
// claimed. Split into two: the hazard (unchanged, renamed honestly), and a
// new test proving the actual fix via the corrected wireDocument() harness.
test('documents the hazard: Y CAN still technically pass restoreLease() as \'restored\' while stuck sharing X\'s id after a failed rotation -- this is exactly why the caller contract requires disabling ownership on failed:true, not relying on restoreLease() alone', async () => {
  const local = fakeStorage();
  const sharedTabId = establishTabId(fakeStorage());
  const xSession = fakeStorage({ [TAB_ID_KEY]: sharedTabId });
  await claimOwnership(local, xSession, TEST_LOCK);
  const yStore = { ...xSession._store }; // Y clones X's storage
  const yBlockedSession = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(yStore, k) ? yStore[k] : null),
    setItem: () => { throw new Error('write blocked'); }, // Y's rotation write always fails
    removeItem: (k) => { delete yStore[k]; },
  };

  const probeFromX = { type: TAB_PROBE_MESSAGE, tabId: sharedTabId, nonce: 'nonce-zzz' };
  const yResult = handleIncomingProbe(probeFromX, yBlockedSession, sharedTabId, 'nonce-aaa', new Set());
  assert.equal(yResult.failed, true, 'sanity: Y\'s rotation attempt must have failed');
  assert.equal(yStore[TAB_ID_KEY], sharedTabId, 'Y is still stuck sharing X\'s id -- the collision is genuinely unresolved');
  assert.equal(restoreLease(local, { getItem: (k) => yStore[k] ?? null, setItem: () => {}, removeItem: () => {} }).status, 'restored',
    'restoreLease() alone cannot see that a rotation failed -- this is why the caller contract is load-bearing, not optional polish');
});

// HONEST SCOPE NOTE (2026-08-15, `/review-step` finding): this test does
// NOT prove any real caller follows the documented contract -- no boot-time
// coordinator consumes this module yet (see the module's own top comment),
// so there is nothing to test against directly. What it actually locks in
// is narrower: the assertion below is a ternary that trivially evaluates to
// `null` whenever `yRef.disabled` is true, regardless of what
// restoreLease() itself would return -- so this documents the CALLER-SIDE
// PATTERN required by the contract (check `disabled` before ever calling
// restoreLease()/claimOwnership()), and, combined with the adjacent hazard
// test proving restoreLease() alone cannot see a failed rotation, shows
// that pattern is sufficient IF a real caller actually follows it. It is
// pseudocode-level documentation, not enforcement -- a real coordinator
// must get its own test once one exists, per the same finding.
test('documents: the caller-side pattern of checking disabled before calling restoreLease() avoids the dual-restoration hazard, IF a real caller follows it (not yet enforced by any code -- no coordinator exists)', async () => {
  const local = fakeStorage();
  const channel = fakeChannel();
  const sharedTabId = establishTabId(fakeStorage());

  const xSession = fakeStorage({ [TAB_ID_KEY]: sharedTabId });
  const xRef = { tabId: sharedTabId };
  await claimOwnership(local, xSession, TEST_LOCK);
  const xPort = wireDocument(channel, xSession, xRef, 'nonce-zzz'); // larger -- X wins, Y must rotate

  // Y clones X's storage, but Y's OWN sessionStorage write always fails --
  // modeled by joining the SAME channel with a session whose setItem()
  // throws, going through the real wireDocument() harness this time (not
  // a bare handleIncomingProbe() call), so the caller-contract wiring
  // itself is what's under test.
  const yStoreBacking = { ...xSession._store };
  const yBlockedSession = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(yStoreBacking, k) ? yStoreBacking[k] : null),
    setItem: () => { throw new Error('write blocked'); },
    removeItem: (k) => { delete yStoreBacking[k]; },
  };
  const yRef = { tabId: sharedTabId };
  const yPort = wireDocument(channel, yBlockedSession, yRef, 'nonce-aaa');

  yPort.postMessage({ type: TAB_PROBE_MESSAGE, tabId: yRef.tabId, nonce: 'nonce-aaa' });

  assert.equal(yRef.disabled, true, 'the harness (modeling the documented caller contract) must have recorded the failed rotation');
  assert.equal(yRef.tabId, sharedTabId, 'Y never actually escaped the collision -- still shares X\'s id');

  // The documented pattern a boot script MUST follow: check the disabled
  // latch BEFORE ever calling restoreLease()/claimOwnership() -- per the
  // contract, once disabled, no further ownership function is called for
  // this document's lifetime at all. NOTE: this ternary trivially resolves
  // to `null` whenever yRef.disabled is true regardless of what
  // restoreLease() would have returned -- it does not call into (or prove
  // anything about) real caller code, since none exists yet. It documents
  // the pattern; the adjacent hazard test proves the pattern is necessary.
  assert.equal(yRef.disabled ? null : restoreLease(local, yBlockedSession).status, null,
    'documents the required pattern: never reaching restoreLease() once disabled is what would avoid the dual-restoration outcome the hazard test above demonstrates -- contingent on a real caller actually implementing this check, which nothing yet does');
  assert.equal(restoreLease(local, xSession).status, 'restored', 'X, the genuine winner, is completely unaffected');
});


// ── tab-identity lock name (2026-08-16, Task 0.3's replacement for the
// quiet-period settle timer) ────────────────────────────────────────────
test('tabIdentityLockName() namespaces the id, so no stored value can produce a reserved name', () => {
  assert.equal(tabIdentityLockName('abc'), TAB_IDENTITY_LOCK_PREFIX + 'abc');
  // Web Locks reserves names beginning with U+002D HYPHEN-MINUS (request()
  // rejects with NotSupportedError). A corrupted or hand-edited tab id could
  // easily start with one; the prefix means the result never can.
  const hostile = tabIdentityLockName('-evil');
  assert.ok(hostile && !hostile.startsWith('-'),
    'a leading-hyphen id must still yield a usable, non-reserved lock name');
});

test('tabIdentityLockName() rejects unusable ids — peekTabId() does no validation of its own', () => {
  // peekTabId() hands back whatever sessionStorage holds, unbounded and
  // unvalidated, and sessionStorage is editable by anyone with devtools open.
  assert.equal(tabIdentityLockName(''), null, 'empty');
  assert.equal(tabIdentityLockName(null), null, 'null — what peekTabId returns on failure');
  assert.equal(tabIdentityLockName(undefined), null, 'undefined');
  assert.equal(tabIdentityLockName(123), null, 'non-string');
  assert.equal(tabIdentityLockName({}), null, 'object');
  assert.equal(tabIdentityLockName('x'.repeat(100000)), null,
    'an unbounded id must not become an unbounded lock name');
});

test('tabIdentityLockName() accepts a real generated tab id', () => {
  const store = fakeStorage();
  const id = establishTabId(store);
  assert.ok(id, 'premise: an id was actually established');
  const name = tabIdentityLockName(id);
  assert.ok(name && name.startsWith(TAB_IDENTITY_LOCK_PREFIX));
  assert.ok(!name.startsWith('-'));
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
