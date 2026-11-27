import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureSource, constructCapture, sourceWeight } from './capture-construction.ts';
import { fixture } from './testing/fixtures.ts';
import { GameRuntime } from './runtime.ts';
import type { RuntimePublication } from './runtime.ts';
import { id } from '../game/ids.ts';

test('capture construction yields, preserves aliases and freezes only its owned graph', async () => {
  const child = { secret: 'private', values: Array.from({ length: 4000 }, (_, i) => i) };
  const source = { first: child, second: child };
  let settled = false;
  const pending = constructCapture('game', source).then((capture) => {
    settled = true;
    return capture;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  const capture = await pending;
  assert.notEqual(capture, source);
  assert.equal(capture.first, capture.second);
  assert.equal(Object.isFrozen(capture.first.values), true);
  assert.equal(Object.isFrozen(source.first), false);
  assert.deepEqual(capture, source);
});

test('source admission rejects over-budget graphs before retaining scheduled work', () => {
  assert.throws(() => sourceWeight({ private: 'x'.repeat(2000) }, 1024), /Capture unavailable/);
  const shared = { a: 1 };
  assert.equal(
    sourceWeight([shared, shared], 10000) < sourceWeight([{ a: 1 }, { a: 1 }], 10000),
    true,
  );
});

test('supported plain graphs preserve null prototypes, sparse lengths and reject exotic/accessor inputs', async () => {
  for (const source of [
    new Date(),
    new Map(),
    new Uint8Array(2),
    {
      get secret(): never {
        return assert.fail('accessor must not run');
      },
    },
  ])
    assert.throws(() => sourceWeight(source, 4096), /Capture unavailable/);
  const source = Object.assign(Object.create(null) as Record<string, unknown>, {
    sparse: new Array(4),
  });
  assert.deepEqual(await constructCapture('plain', source), source);
});

test('wide source admission stops at the existing bound and admitted wide copies yield', async (t) => {
  const source = Object.fromEntries(Array.from({ length: 20000 }, (_, i) => [`position-${i}`, i]));
  const started = performance.now();
  assert.throws(() => sourceWeight(source, 1024), /Capture unavailable/);
  t.diagnostic(
    `wide admission rejection ${performance.now() - started}ms; native key enumeration is not preemptible`,
  );
  let done = false;
  const copy = constructCapture('wide', source).then((result) => {
    done = true;
    return result;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  assert.deepEqual(await copy, source);
});

test('capture source aliases only proven same-head equal final roots without changing the legacy graph', async (t) => {
  const { options, seats } = fixture('vote', 4);
  const runtime = await GameRuntime.create(options);
  let original: RuntimePublication | undefined;
  await runtime.subscribe((notice) => {
    original = notice;
  });
  try {
    await runtime.dispatch({
      type: 'cast-vote',
      id: id('command', 'source-alias'),
      actorId: seats[0]!,
      procedureId: runtime.read().state!.procedure!.timer.id,
      vote: 'yes',
    });
    const publication = original!;
    const last = publication.actions.at(-1)!;
    assert.notEqual(publication.snapshot.state, last.after.state);
    const saved = structuredClone(publication);
    const started = performance.now();
    const source = captureSource(publication);
    t.diagnostic(`proven final-root equality ${performance.now() - started}ms`);
    assert.equal(source.snapshot.state, last.after.state);
    assert.deepEqual(source, saved);
    assert.deepEqual(publication, saved);
    assert.notEqual(publication.snapshot.state, last.after.state, 'legacy aliases unchanged');
    assert.equal(Object.isFrozen(publication.snapshot.state), false);
    const expanded = structuredClone(publication);
    const key = 'private-position-'.repeat(40000);
    Object.assign(expanded.snapshot.state!.repetitions, { [key]: 1 });
    Object.assign(expanded.actions.at(-1)!.after.state!.repetitions, { [key]: 1 });
    const limit = 2 * 1024 * 1024;
    assert.throws(() => sourceWeight(expanded, limit), /Capture unavailable/);
    const expandedStarted = performance.now();
    const bounded = captureSource(expanded);
    t.diagnostic(`expanded proven-root sizing/equality ${performance.now() - expandedStarted}ms`);
    assert.ok(
      sourceWeight(bounded, limit) <= limit,
      'two actual retained roots fit the unchanged allowance',
    );
    assert.deepEqual(bounded, expanded);
    for (const field of ['gameId', 'branchId', 'version'] as const) {
      const mismatch = structuredClone(expanded);
      Object.assign(mismatch.snapshot.head, {
        [field]: field === 'version' ? mismatch.snapshot.head.version + 1 : 'wrong',
      });
      assert.equal(captureSource(mismatch), mismatch);
      assert.throws(() => sourceWeight(captureSource(mismatch), limit), /Capture unavailable/);
    }
    const expandedConflict = structuredClone(expanded);
    Object.assign(expandedConflict.snapshot.state!, { ownerId: 'different' });
    assert.equal(captureSource(expandedConflict), expandedConflict);
    assert.throws(
      () => sourceWeight(captureSource(expandedConflict), limit),
      /Capture unavailable/,
    );
    const changed = structuredClone(publication);
    Object.assign(changed.snapshot.head, { version: changed.snapshot.head.version + 1 });
    assert.equal(captureSource(changed), changed);
    const conflict = structuredClone(publication);
    Object.assign(conflict.snapshot.state!, { ownerId: 'different' });
    assert.equal(captureSource(conflict), conflict);
    const control = { ...publication, actions: [] };
    assert.equal(captureSource(control), control);
  } finally {
    await runtime.dispose();
  }
});
