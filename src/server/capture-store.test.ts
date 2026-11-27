import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id } from '../game/ids.ts';
import { GameRuntime } from '../runtime/runtime.ts';
import type { RuntimePublication } from '../runtime/runtime.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import { CaptureStore } from './capture-store.ts';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
async function publications() {
  const { options } = fixture('vote', 4);
  const runtime = await GameRuntime.create(options);
  const notices: RuntimePublication[] = [];
  await runtime.subscribeCommittedCapture((p) => {
    notices.push(p);
  });
  const procedure = runtime.read().state!.procedure!;
  assert.equal(procedure.type, 'claim-vote');
  if (procedure.type !== 'claim-vote') throw new Error('Expected vote');
  for (let i = 0; i < 2; i++)
    await runtime.dispatch({
      type: 'cast-vote',
      id: id('command', `store-vote-${i}`),
      actorId: procedure.eligibleSeatIds[i]!,
      procedureId: runtime.read().state!.procedure!.timer.id,
      vote: 'yes',
    });
  await runtime.flushCommittedCaptures();
  await runtime.flushCommittedCaptures();
  await runtime.dispose();
  return notices;
}

test('capture store shares proven full roots, not controls, and releases only the last handle', async () => {
  const [initial, first, second] = await publications();
  const store = new CaptureStore();
  const writer = store.writer('writer', initial!.snapshot.head.gameId);
  const a = writer.capture(first!);
  const b = writer.capture(second!);
  assert.equal(a.value.publication.actions[0]!.after.state, a.value.publication.snapshot.state);
  assert.equal(a.value.publication.snapshot.state, b.value.publication.actions[0]!.before.state);
  const control = freeze({
    ...second!,
    sequence: second!.sequence + 1,
    actions: [],
    snapshot: { ...second!.snapshot, controlEvents: [] },
  });
  const c = writer.capture(control);
  assert.notEqual(c.value.publication, b.value.publication);
  assert.equal(c.value.publication.snapshot.state, b.value.publication.snapshot.state);
  const queued = a.retain();
  const bytes = store.stats().bytes;
  assert.equal(queued.bytes, a.bytes);
  assert.equal(store.stats().bytes, bytes);
  a.release();
  a.release();
  assert.equal(store.stats().publications, 3);
  assert.throws(() => a.retain(), /Capture unavailable/);
  queued.release();
  b.release();
  c.release();
  assert.deepEqual(store.stats(), {
    bytes: 0,
    roots: 0,
    publications: 0,
    handles: 0,
    games: 0,
    constructing: 0,
  });
});

test('capture store fails closed on content conflicts, mutable inputs and misbound heads; isolates writers and branches', async () => {
  const [initial] = await publications();
  const store = new CaptureStore();
  const writer = store.writer('epoch', initial!.snapshot.head.gameId);
  const a = writer.capture(initial!);
  const changed = structuredClone(initial!);
  (changed.snapshot.state as { ownerId: string }).ownerId = 'secret-conflict';
  assert.throws(() => writer.capture(freeze(changed)), /^Error: Capture unavailable$/);
  assert.throws(() => writer.capture(structuredClone(initial!)), /Capture unavailable/);
  const bad = freeze({
    ...initial!,
    snapshot: {
      ...initial!.snapshot,
      head: { ...initial!.snapshot.head, gameId: id('game', 'wrong') },
    },
  });
  assert.throws(() => writer.capture(bad), /Capture unavailable/);
  const nullState = freeze({ ...initial!, snapshot: { ...initial!.snapshot, state: null } });
  assert.throws(() => writer.capture(nullState), /Capture unavailable/);
  const fork = freeze({
    ...structuredClone(initial!),
    snapshot: {
      ...structuredClone(initial!.snapshot),
      head: { ...initial!.snapshot.head, branchId: id('branch', 'fork') },
    },
  });
  const b = writer.capture(fork);
  const c = store.writer('epoch', initial!.snapshot.head.gameId).capture(initial!);
  assert.notEqual(b.value.publication.snapshot.state, a.value.publication.snapshot.state);
  // The input may itself be identical; use a separately owned recovery graph.
  const d = store
    .writer('recovered', initial!.snapshot.head.gameId)
    .capture(freeze(structuredClone(initial!)));
  assert.notEqual(d.value.publication.snapshot.state, a.value.publication.snapshot.state);
  a.release();
  b.release();
  c.release();
  d.release();
  assert.equal(store.stats().bytes, 0);
});

test('capture store candidate bounds are inclusive, refusal is atomic, and idle slots recover', async () => {
  const [initial] = await publications();
  const probe = new CaptureStore();
  const measured = probe.writer('a', initial!.snapshot.head.gameId).capture(initial!);
  const bytes = measured.bytes;
  measured.release();
  for (const bound of ['publicationBytes', 'gameBytes', 'globalBytes'] as const) {
    const exact = new CaptureStore({ [bound]: bytes });
    const a = exact.writer('a', initial!.snapshot.head.gameId).capture(initial!);
    a.release();
    const below = new CaptureStore({ [bound]: bytes - 1 });
    assert.throws(
      () => below.writer('a', initial!.snapshot.head.gameId).capture(initial!),
      /Capture unavailable/,
    );
    assert.equal(below.stats().bytes, 0);
    assert.equal(below.stats().constructing, 0);
  }
  const store = new CaptureStore({ games: 1, publicationsPerGame: 1, handles: 2 });
  const writer = store.writer('a', initial!.snapshot.head.gameId);
  const a = writer.capture(initial!);
  const peer = a.retain();
  assert.throws(() => a.retain(), /Capture unavailable/);
  assert.throws(() => writer.capture(initial!), /Capture unavailable/);
  a.release();
  assert.equal(store.stats().games, 1);
  peer.release();
  const next = writer.capture(initial!);
  next.release();
  assert.equal(store.stats().games, 0);
});

test('capture store applies the actual 8-game/64-publication/2048-handle candidates and recovers slots', async () => {
  const [initial] = await publications();
  const store = new CaptureStore();
  const handles = [];
  for (let game = 0; game < 8; game++) {
    const gameId = id('game', `bounded-${game}`);
    const publication = structuredClone(initial!);
    const remapped = freeze({
      ...publication,
      snapshot: {
        ...publication.snapshot,
        head: { ...publication.snapshot.head, gameId },
        state: { ...publication.snapshot.state!, gameId },
      },
    });
    handles.push(store.writer(`epoch-${game}`, gameId).capture(remapped));
  }
  assert.equal(store.stats().games, 8);
  assert.throws(
    () => store.writer('ninth', initial!.snapshot.head.gameId).capture(initial!),
    /Capture unavailable/,
  );
  handles[0]!.release();
  const recovered = store.writer('ninth', initial!.snapshot.head.gameId).capture(initial!);
  recovered.release();
  handles.forEach((handle) => handle.release());
  assert.equal(store.stats().games, 0);
  const writer = store.writer('publication-limit', initial!.snapshot.head.gameId);
  const records = Array.from({ length: 64 }, () => writer.capture(initial!));
  assert.equal(store.stats().publications, 64);
  assert.throws(() => writer.capture(initial!), /Capture unavailable/);
  records.forEach((record) => record.release());
  const owner = writer.capture(initial!);
  const peers = Array.from({ length: 2047 }, () => owner.retain());
  assert.equal(store.stats().handles, 2048);
  assert.throws(() => owner.retain(), /Capture unavailable/);
  owner.release();
  assert.equal(store.stats().handles, 2047);
  const retry = peers[0]!.retain();
  retry.release();
  peers.forEach((peer) => peer.release());
  assert.equal(store.stats().bytes, 0);
});

test('capture store shares every adjacent root without dropping replay fields; rollback null has its own provenance', async () => {
  const [initial, first, second] = await publications();
  const store = new CaptureStore();
  const writer = store.writer('epoch', initial!.snapshot.head.gameId);
  const combined = freeze({ ...second!, actions: [...first!.actions, ...second!.actions] });
  const handle = writer.capture(combined);
  const pairs = handle.value.publication.actions;
  assert.equal(pairs[0]!.after.state, pairs[1]!.before.state);
  assert.deepEqual(handle.value.publication, combined);
  assert.ok(Object.isFrozen(handle.value.publication.actions));
  assert.ok(Object.isFrozen(pairs[0]!.before.state!.players));
  const rollback = freeze({
    ...initial!,
    kind: 'rollback' as const,
    snapshot: {
      ...initial!.snapshot,
      state: null,
      head: { ...initial!.snapshot.head, branchId: id('branch', 'null-fork'), version: 0 },
    },
  });
  const empty = writer.capture(rollback);
  assert.equal(empty.value.publication.snapshot.state, null);
  const sameEmpty = writer.capture(freeze({ ...rollback, kind: 'initial' as const }));
  empty.release();
  sameEmpty.release();
  handle.release();
  assert.equal(store.stats().roots, 0);
});

test('cached logical publication debt counts distinct roots once but sums independently per peer job', async () => {
  const [initial, first] = await publications();
  const store = new CaptureStore();
  const writer = store.writer('debt', initial!.snapshot.head.gameId);
  const a = writer.capture(first!);
  const peerA = a.retain(),
    peerB = a.retain();
  assert.equal(store.stats().bytes, a.bytes);
  const b = writer.capture(freeze({ ...first!, sequence: first!.sequence + 1 }));
  assert.ok(a.bytes + b.bytes > store.stats().bytes);
  assert.equal(peerA.bytes + b.bytes, peerB.bytes + b.bytes);
  peerA.release();
  peerB.release();
  a.release();
  b.release();
  assert.equal(store.stats().bytes, 0);
});

test('the provisional 2MiB publication boundary accepts exactly the limit and rejects the next weight step', async () => {
  const [initial] = await publications();
  const store = new CaptureStore();
  const writer = store.writer('boundary', initial!.snapshot.head.gameId);
  const base = writer.capture(freeze({ ...initial!, diagnosticPadding: '' }));
  const padding = (2 * 1024 * 1024 - base.bytes) / 2;
  assert.equal(Number.isSafeInteger(padding), true);
  base.release();
  const exact = writer.capture(freeze({ ...initial!, diagnosticPadding: 'x'.repeat(padding) }));
  assert.equal(exact.bytes, 2 * 1024 * 1024);
  exact.release();
  assert.throws(
    () => writer.capture(freeze({ ...initial!, diagnosticPadding: 'x'.repeat(padding + 1) })),
    /Capture unavailable/,
  );
  assert.equal(store.stats().bytes, 0);
});

test('pending source reservation shares quotas through fanout settlement; local pressure evicts oldest stable peer only', async () => {
  const [initial] = await publications();
  const bytes = 2 * 1024 * 1024;
  const store = new CaptureStore({ gameBytes: bytes, globalBytes: bytes });
  let delivered = 0;
  const pending = store.construct(initial!, () => {
    delivered++;
    assert.equal(store.stats().bytes, bytes);
  });
  assert.equal(store.stats().bytes, bytes);
  assert.equal(store.stats().handles, 1);
  const evicted: string[] = [];
  store.watchPressure(
    initial!.snapshot.head.gameId,
    'b',
    () => 1,
    () => {
      evicted.push('b');
    },
  );
  store.watchPressure(
    initial!.snapshot.head.gameId,
    'a',
    () => 1,
    () => {
      evicted.push('a');
    },
  );
  store.watchPressure(
    id('game', 'unrelated'),
    'other',
    () => 0,
    () => assert.fail('unrelated eviction'),
  );
  assert.throws(() => store.construct(initial!, () => assert.fail()), /Capture unavailable/);
  assert.deepEqual(evicted, ['a']);
  assert.equal(store.stats().bytes, bytes, 'active reservation cannot be credited by eviction');
  await pending;
  assert.equal(delivered, 1);
  assert.equal(store.stats().bytes, 0);
});
