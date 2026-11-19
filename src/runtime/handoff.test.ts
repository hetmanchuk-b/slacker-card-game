import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id } from '../game/ids.ts';
import { GameRuntime, RuntimeAdmissionError } from './runtime.ts';
import { fixture } from './testing/fixtures.ts';
import { finishMatch } from './testing/match.ts';

test('handoff admission runs inside its queue before closure and denial leaves the finished runtime healthy', async () => {
  const { options, clock, history } = fixture('reveal');
  const runtime = await GameRuntime.create(options);
  await clock.advanceBy(10000);
  await finishMatch(runtime);
  const before = runtime.read();
  const capture = history.snapshot().value;
  let calls = 0;
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const blocked = runtime.observe(async () => {
    entered.resolve();
    await held.promise;
  });
  await entered.promise;
  let allowed = true;
  const pending = runtime.handoff(
    async () => {
      calls++;
    },
    before.head,
    { admit: () => allowed },
  );
  allowed = false;
  held.resolve();
  await blocked;
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof RuntimeAdmissionError && error.code === 'unauthorized',
  );
  assert.equal(calls, 0);
  assert.deepEqual(history.snapshot().value, capture);
  assert.deepEqual(runtime.read(), before);
  await assert.rejects(
    runtime.handoff(
      async () => {
        calls++;
      },
      before.head,
      {
        admit: () => {
          throw new Error('PRIVATE AUTH SQL');
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeAdmissionError);
      assert.equal(error.code, 'unavailable');
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  assert.deepEqual(history.snapshot().value, capture);
  assert.equal(
    await runtime.handoff(
      async () => {
        calls++;
      },
      before.head,
      { admit: () => true },
    ),
    true,
  );
  assert.equal(calls, 1);
  await runtime.dispose();
});

test('deferred handoff refusal preserves open history and permits a later handoff', async () => {
  const { options, clock, history } = fixture('reveal');
  const runtime = await GameRuntime.create(options);
  await clock.advanceBy(10000);
  await finishMatch(runtime);
  const before = runtime.read();
  const archive = history.archive();
  assert.equal(
    await runtime.handoff(async () => false, before.head, { deferClosure: true }),
    false,
  );
  assert.deepEqual(runtime.read(), before);
  assert.deepEqual(history.archive(), archive);
  assert.equal(await runtime.handoff(async () => {}, before.head, { deferClosure: true }), true);
  assert.equal(history.snapshot().value.closedRollback, true);
  await runtime.dispose();
});

test('actual handoff waits for its transaction and retires the old runtime before queued rollback', async () => {
  const { options, clock, history, seats } = fixture('reveal');
  const runtime = await GameRuntime.create(options);
  await clock.advanceBy(10000);
  await finishMatch(runtime);
  const before = runtime.read();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const transition = runtime.handoff(async (checkpoint) => {
    assert.deepEqual(checkpoint.head, before.head);
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  assert.deepEqual(runtime.read(), before);
  const rollback = runtime.dispatch({
    type: 'rollback',
    id: id('command', 'late'),
    actorId: seats[0]!,
    expected: before.head,
    beforeCommandId: history.read().actions.at(-1)!.commandId,
    knowledgeWarningAcknowledged: true,
  });
  release.resolve();
  assert.equal(await transition, true);
  const rejected = await rollback;
  assert.equal(rejected.type, 'rejected');
  if (rejected.type === 'rejected') assert.equal(rejected.code, 'closed');
  await runtime.dispose();
});

test('a rollback already queued before handoff reopens the match and prevents successor publication', async () => {
  const { options, clock, history, seats } = fixture('reveal');
  const runtime = await GameRuntime.create(options);
  await clock.advanceBy(10000);
  await finishMatch(runtime);
  const head = runtime.read().head;
  const rollback = runtime.dispatch({
    type: 'rollback',
    id: id('command', 'first'),
    actorId: seats[0]!,
    expected: head,
    beforeCommandId: history.read().actions.at(-1)!.commandId,
    knowledgeWarningAcknowledged: true,
  });
  let published = false;
  const handoff = runtime.handoff(async () => {
    published = true;
  });
  assert.equal((await rollback).type, 'accepted');
  assert.equal(await handoff, false);
  assert.equal(published, false);
  assert.notEqual(runtime.read().state?.phase.type, 'finished');
  await runtime.dispose();
});

test('a failed read-only ordered operation does not fault gameplay or stop its timer', async () => {
  const { options, clock } = fixture('vote');
  const runtime = await GameRuntime.create(options);
  await assert.rejects(
    runtime.observe(async () => {
      throw new Error('Chat unavailable');
    }),
    /Chat unavailable/,
  );
  assert.equal(runtime.read().state?.procedure?.type, 'claim-vote');
  await clock.advanceBy(10000);
  assert.equal(runtime.read().state?.procedure, null);
  await runtime.dispose();
});
