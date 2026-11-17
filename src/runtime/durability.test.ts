import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id } from '../game/ids.ts';
import { GameRuntime } from './runtime.ts';
import type { RuntimeCheckpoint } from './runtime.ts';
import { fixture } from './testing/fixtures.ts';
import { FakeClock } from './testing/fake-clock.ts';

test('runtime publishes a command and its receipt only after the storage transaction completes', async () => {
  const { options, seats } = fixture('vote', 4);
  let block = false;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let stored: RuntimeCheckpoint | null = null;
  const runtime = await GameRuntime.create({
    ...options,
    commit: async (frame: RuntimeCheckpoint) => {
      if (block) {
        entered.resolve();
        await release.promise;
      }
      stored = frame;
    },
  });
  const before = runtime.read();
  block = true;
  const command = {
    type: 'cast-vote' as const,
    id: id('command', 'ballot'),
    actorId: seats[0]!,
    procedureId: before.state!.procedure!.timer.id,
    vote: 'yes' as const,
  };
  let acknowledged = false;
  const pending = runtime.dispatch(command).then((result) => {
    acknowledged = true;
    return result;
  });
  // A missing adapter invocation must fail rather than hang this regression.
  await Promise.race([
    entered.promise,
    pending.then(() => assert.fail('Command acknowledged without durable commit')),
  ]);
  assert.equal(acknowledged, false);
  assert.deepEqual(runtime.read(), before);
  release.resolve();
  assert.equal((await pending).type, 'accepted');
  assert.ok(stored);
  assert.equal((stored as RuntimeCheckpoint).receipts.at(-1)?.command.id, command.id);
  assert.equal(runtime.read().head.version, before.head.version + 1);
  await runtime.dispose();
});

test('failed durable commits fault the runtime rather than publishing or accepting its draft', async () => {
  const { options, seats } = fixture('vote', 4);
  let fail = false;
  const runtime = await GameRuntime.create({
    ...options,
    commit: async () => {
      if (fail) throw new Error('Storage unavailable');
    },
  });
  const procedureId = runtime.read().state!.procedure!.timer.id;
  fail = true;
  await assert.rejects(
    runtime.dispatch({
      type: 'cast-vote',
      id: id('command', 'ballot'),
      actorId: seats[0]!,
      procedureId,
      vote: 'yes',
    }),
    /Storage unavailable/,
  );
  assert.throws(() => runtime.read(), /Runtime scheduling failed/);
  await assert.rejects(
    runtime.dispatch({ type: 'disconnect', id: id('command', 'later'), seatId: seats[1]! }),
    /faulted/,
  );
  await runtime.dispose();
});

test('no deadline runs before the initial durable commit finishes', async () => {
  const { options, clock, history } = fixture('vote', 4);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first = true;
  const created = GameRuntime.create({
    ...options,
    commit: async () => {
      if (first) {
        first = false;
        entered.resolve();
        await release.promise;
      }
    },
  });
  await entered.promise;
  const before = history.read();
  await clock.advanceBy(10000);
  assert.deepEqual(history.read(), before);
  release.resolve();
  const runtime = await created;
  await clock.advanceBy(0);
  assert.equal(runtime.read().state?.procedure, null);
  await runtime.dispose();
});

test('obsolete delivered callbacks do not write storage after runtime disposal', async () => {
  class UncancelableClock extends FakeClock {
    override scheduleAt(at: number, task: () => Promise<void>): () => void {
      super.scheduleAt(at, task);
      return () => {};
    }
  }
  const { options } = fixture('vote', 4);
  const clock = new UncancelableClock(1000);
  let writes = 0;
  const runtime = await GameRuntime.create({
    ...options,
    clock,
    commit: async () => {
      writes++;
    },
  });
  const before = writes;
  await runtime.dispose();
  await clock.advanceBy(10000);
  assert.equal(writes, before);
});
