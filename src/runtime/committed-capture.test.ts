import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id } from '../game/ids.ts';
import { applyAction } from '../game/engine.ts';
import { GameRuntime } from './runtime.ts';
import type { RuntimePublication } from './runtime.ts';
import { fixture } from './testing/fixtures.ts';

function verifyFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const [key, child] of Object.entries(value)) {
    assert.equal(Reflect.set(value, key, null), false);
    verifyFrozen(child, seen);
  }
  assert.throws(() => Object.defineProperty(value, 'mutation', { value: true }), TypeError);
}

test('committed captures share one transitively frozen detached graph; legacy reads and listeners stay mutable', async () => {
  const { options, history, seats } = fixture('vote', 4);
  const runtime = await GameRuntime.create(options);
  try {
    const first: RuntimePublication[] = [];
    const second: RuntimePublication[] = [];
    const legacy: RuntimePublication[] = [];
    await runtime.subscribeCommittedCapture((capture) => {
      first.push(capture);
    });
    await runtime.subscribeCommittedCapture((capture) => {
      second.push(capture);
    });
    await runtime.subscribe((notice) => {
      legacy.push(notice);
    });
    assert.deepEqual(first[0]!.actions, []);
    verifyFrozen(first[0]);
    const before = history.read();
    assert.equal(Object.isFrozen(before.state), false);
    const result = await runtime.dispatch({
      type: 'cast-vote',
      id: id('command', 'freeze-vote'),
      actorId: seats[0]!,
      procedureId: runtime.read().state!.procedure!.timer.id,
      vote: 'yes',
    });
    assert.equal(result.type, 'accepted');
    const capture = first.at(-1)!;
    assert.equal(capture, second.at(-1));
    verifyFrozen(capture);
    assert.notEqual(capture, legacy.at(-1));
    for (const pair of capture.actions)
      assert.deepEqual(applyAction(pair.before.state, pair.action), pair.after.state);
    const saved = structuredClone(capture);
    (legacy.at(-1)!.snapshot.state!.players as unknown[]).length = 0;
    const detached = runtime.read();
    (detached.state!.players as unknown[]).length = 0;
    assert.deepEqual(capture, saved);
    assert.equal(runtime.read().state!.players.length, 4);
    assert.equal(history.read().state!.players.length, 4);
    assert.equal(Object.isFrozen(history.read().state), false);
  } finally {
    await runtime.dispose();
  }
});

for (const operation of ['command', 'timeout', 'control', 'rollback'] as const) {
  test(`registration is serialized behind blocked ${operation} commit and before the next update`, async () => {
    const { options, history, seats, clock } = fixture('vote', 4);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let block = false;
    const runtime = await GameRuntime.create({
      ...options,
      commit: async () => {
        if (block) {
          entered.resolve();
          await release.promise;
        }
      },
    });
    try {
      const early: RuntimePublication[] = [];
      const late: RuntimePublication[] = [];
      await runtime.subscribeCommittedCapture((capture) => {
        early.push(capture);
      });
      if (operation === 'control') {
        await runtime.dispatch({
          type: 'disconnect',
          id: id('command', 'prepare-absence'),
          seatId: seats[1]!,
        });
        await clock.advanceBy(30001);
      }
      const initialCount = early.length;
      block = true;
      const pending =
        operation === 'timeout'
          ? clock.advanceBy(10000)
          : runtime.dispatch(
              operation === 'control'
                ? {
                    type: 'propose-bot',
                    id: id('command', 'replace'),
                    actorId: seats[0]!,
                    seatId: seats[1]!,
                  }
                : operation === 'rollback'
                  ? {
                      type: 'rollback',
                      id: id('command', 'rollback'),
                      actorId: seats[0]!,
                      expected: runtime.read().head,
                      beforeCommandId: history.read().actions.at(-1)!.commandId,
                      knowledgeWarningAcknowledged: true,
                    }
                  : {
                      type: 'cast-vote',
                      id: id('command', 'vote'),
                      actorId: seats[0]!,
                      procedureId: runtime.read().state!.procedure!.timer.id,
                      vote: 'yes',
                    },
            );
      await entered.promise;
      const registration = runtime.subscribeCommittedCapture((capture) => {
        late.push(capture);
      });
      assert.equal(early.length, initialCount);
      assert.equal(late.length, 0);
      release.resolve();
      await pending;
      const stop = await registration;
      assert.equal(late.length, 1);
      assert.equal(late[0]!.kind, 'initial');
      assert.deepEqual(late[0]!.actions, []);
      assert.deepEqual(late[0]!.snapshot, early.at(-1)!.snapshot);
      assert.equal(late[0]!.sequence, early.at(-1)!.sequence);
      early.forEach((capture) => verifyFrozen(capture));
      verifyFrozen(late[0]);
      if (operation === 'control') {
        assert.deepEqual(early.at(-2)!.snapshot.head, early.at(-1)!.snapshot.head);
        assert.deepEqual(early.at(-1)!.actions, []);
      }
      await runtime.dispatch({
        type: 'disconnect',
        id: id('command', 'next-absence'),
        seatId: seats[2]!,
      });
      assert.equal(late.length, 2);
      assert.equal(late[1]!.sequence, late[0]!.sequence + 1);
      assert.equal(late[1], early.at(-1));
      stop();
      stop();
      await runtime.dispatch({
        type: 'reconnect',
        id: id('command', 'next-return'),
        seatId: seats[2]!,
      });
      assert.equal(late.length, 2);
    } finally {
      release.resolve();
      await runtime.dispose();
    }
  });
}

for (const controlOnly of [false, true]) {
  test(`failed ${controlOnly ? 'same-head control' : 'action'} commit emits no immutable capture and rejects registration`, async () => {
    const { options, seats, clock } = fixture('vote', 4);
    let fail = false;
    const runtime = await GameRuntime.create({
      ...options,
      commit: async () => {
        if (fail) throw new Error('commit failed');
      },
    });
    if (controlOnly) {
      await runtime.dispatch({
        type: 'disconnect',
        id: id('command', 'prepare-failed-control'),
        seatId: seats[1]!,
      });
      await clock.advanceBy(30001);
    }
    const notices: RuntimePublication[] = [];
    await runtime.subscribeCommittedCapture((capture) => {
      notices.push(capture);
    });
    fail = true;
    await assert.rejects(
      runtime.dispatch(
        controlOnly
          ? {
              type: 'propose-bot',
              id: id('command', 'failed-control'),
              actorId: seats[0]!,
              seatId: seats[1]!,
            }
          : {
              type: 'cast-vote',
              id: id('command', 'failed-vote'),
              actorId: seats[0]!,
              procedureId: runtime.read().state!.procedure!.timer.id,
              vote: 'yes',
            },
      ),
      /commit failed/,
    );
    assert.equal(notices.length, 1);
    await assert.rejects(
      runtime.subscribeCommittedCapture(() => {}),
      /unavailable/,
    );
    await runtime.dispose();
  });
}

test('immutable listener failures and pending async work do not block commands; unsubscribe and disposal stop invocation', async () => {
  const { options, seats, clock } = fixture('vote', 4);
  const runtime = await GameRuntime.create(options);
  const errors: number[] = [];
  const notices: RuntimePublication[] = [];
  await runtime.subscribeCommittedCapture(
    () => {
      throw new Error('private');
    },
    (sequence) => {
      errors.push(sequence);
      throw new Error('report');
    },
  );
  await runtime.subscribeCommittedCapture(
    async () => {
      throw new Error('private async');
    },
    async (sequence) => {
      errors.push(sequence);
      throw new Error('report async');
    },
  );
  await runtime.subscribeCommittedCapture(() => new Promise<void>(() => {}));
  const stop = await runtime.subscribeCommittedCapture((capture) => {
    notices.push(capture);
  });
  const followUp = Promise.withResolvers<void>();
  await runtime.subscribeCommittedCapture(async (capture) => {
    if (capture.kind === 'initial') return;
    await runtime.checkpoint();
    followUp.resolve();
  });
  assert.equal(
    (
      await runtime.dispatch({
        type: 'cast-vote',
        id: id('command', 'nonblocking'),
        actorId: seats[0]!,
        procedureId: runtime.read().state!.procedure!.timer.id,
        vote: 'yes',
      })
    ).type,
    'accepted',
  );
  await followUp.promise;
  assert.equal(errors.length, 4);
  assert.ok(errors.every(Number.isSafeInteger));
  stop();
  stop();
  await clock.advanceBy(10000);
  assert.equal(notices.length, 2);
  await runtime.dispose();
  await clock.advanceBy(10000);
  await assert.rejects(
    runtime.subscribeCommittedCapture(() => {}),
    /unavailable/,
  );
});

test('late and restored immutable baselines never replay historical private peek observations', async () => {
  const { options, seats, clock } = fixture('reveal', 4);
  const runtime = await GameRuntime.create(options);
  let restored: GameRuntime | undefined;
  try {
    await clock.advanceBy(10000);
    const captures: RuntimePublication[] = [];
    await runtime.subscribeCommittedCapture((capture) => {
      captures.push(capture);
    });
    const command = {
      type: 'open-stump' as const,
      id: id('command', 'private-peek'),
      actorId: seats[0]!,
      cardId: runtime.read().state!.players[0]!.stumps[0]!,
    };
    assert.equal((await runtime.dispatch(command)).type, 'accepted');
    assert.ok(captures.at(-1)!.actions.length > 0);
    verifyFrozen(captures.at(-1));
    assert.ok(Object.keys(captures.at(-1)!.snapshot.state!.repetitions).length > 0);
    assert.deepEqual(captures.at(-1)!.snapshot, runtime.read());
    const late: RuntimePublication[] = [];
    await runtime.subscribeCommittedCapture((capture) => {
      late.push(capture);
    });
    assert.deepEqual(late[0]!.actions, []);
    assert.equal((await runtime.dispatch(command)).type, 'accepted');
    assert.equal(late.length, 1);
    const checkpoint = await runtime.checkpoint();
    await runtime.dispose();
    restored = await GameRuntime.restore(options, checkpoint);
    const recovered: RuntimePublication[] = [];
    await restored.subscribeCommittedCapture((capture) => {
      recovered.push(capture);
    });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]!.kind, 'initial');
    assert.deepEqual(recovered[0]!.actions, []);
    verifyFrozen(recovered[0]);
  } finally {
    await runtime.dispose();
    await restored?.dispose();
  }
});
