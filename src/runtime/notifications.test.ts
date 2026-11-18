import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAction } from '../game/engine.ts';
import { id } from '../game/ids.ts';
import { MemoryHistory } from '../persistence/memory-history.ts';
import { projectAction } from '../projections/actions.ts';
import { projectOwnerHistory } from '../projections/history.ts';
import { projectLiveGame } from '../projections/live.ts';
import { GameRuntime } from './runtime.ts';
import type { RuntimePublication, RuntimeCheckpoint } from './runtime.ts';
import { fixture } from './testing/fixtures.ts';
import { FakeClock } from './testing/fake-clock.ts';
import { finishMatch } from './testing/match.ts';

function verifyPairs(publication: RuntimePublication) {
  for (const pair of publication.actions) {
    assert.equal(pair.delivery, 'fresh');
    assert.equal(pair.before.head.branchId, pair.after.head.branchId);
    assert.equal(pair.before.head.version + 1, pair.after.head.version);
    assert.deepEqual(applyAction(pair.before.state, pair.action), pair.after.state);
    assert.doesNotThrow(() => projectAction(pair, { type: 'public' }));
  }
}

test('subscription starts with a detached current baseline, not preloaded action replay', async () => {
  const { options, history, clock } = fixture('reveal', 4);
  const runtime = await GameRuntime.create(options);
  try {
    const notices: RuntimePublication[] = [];
    const stop = await runtime.subscribe((notice) => {
      notices.push(notice);
    });
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.kind, 'initial');
    assert.deepEqual(notices[0]!.actions, []);
    assert.deepEqual(notices[0]!.snapshot, runtime.read());
    assert.equal(history.read().actions.length, 37);
    assert.equal(notices[0]!.nowMs, clock.now());
    assert.notEqual(notices[0]!.snapshot.state, runtime.read().state);
    stop();
    stop();
    await clock.advanceBy(10000);
    assert.equal(notices.length, 1);
  } finally {
    await runtime.dispose();
  }
});

test('nothing notifies or acknowledges before commit; complete committed actions and receipts publish together', async () => {
  const { options, seats } = fixture('vote', 4);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let blocked = false;
  let stored: RuntimeCheckpoint | null = null;
  const runtime = await GameRuntime.create({
    ...options,
    commit: async (checkpoint) => {
      if (blocked) {
        entered.resolve();
        await release.promise;
      }
      stored = checkpoint;
    },
  });
  try {
    const notices: RuntimePublication[] = [];
    await runtime.subscribe((notice) => {
      notices.push(notice);
    });
    const before = runtime.read();
    const command = {
      type: 'cast-vote' as const,
      id: id('command', 'vote'),
      actorId: seats[0]!,
      procedureId: before.state!.procedure!.timer.id,
      vote: 'yes' as const,
    };
    blocked = true;
    let acknowledged = false;
    const pending = runtime.dispatch(command).then((result) => {
      acknowledged = true;
      return result;
    });
    await entered.promise;
    assert.equal(notices.length, 1);
    assert.equal(acknowledged, false);
    assert.deepEqual(runtime.read(), before);
    release.resolve();
    assert.equal((await pending).type, 'accepted');
    assert.equal(notices.length, 2);
    const notice = notices[1]!;
    assert.equal(notice.kind, 'update');
    assert.equal(notice.sequence, notices[0]!.sequence + 1);
    assert.equal((stored as RuntimeCheckpoint | null)?.receipts.at(-1)?.command.id, command.id);
    assert.deepEqual(notice.snapshot, runtime.read());
    assert.equal(notice.actions.length, 1);
    assert.deepEqual(notice.actions[0]!.before, { head: before.head, state: before.state });
    verifyPairs(notice);
  } finally {
    release.resolve();
    await runtime.dispose();
  }
});

test('failed storage commits emit no draft and still fault the runtime', async () => {
  const { options, seats } = fixture('vote', 4);
  let fail = false;
  const runtime = await GameRuntime.create({
    ...options,
    commit: async () => {
      if (fail) throw new Error('Storage unavailable');
    },
  });
  const notices: RuntimePublication[] = [];
  await runtime.subscribe((notice) => {
    notices.push(notice);
  });
  fail = true;
  await assert.rejects(
    runtime.dispatch({
      type: 'cast-vote',
      id: id('command', 'lost'),
      actorId: seats[0]!,
      procedureId: runtime.read().state!.procedure!.timer.id,
      vote: 'yes',
    }),
    /Storage unavailable/,
  );
  assert.equal(notices.length, 1);
  assert.throws(() => runtime.read(), /Runtime scheduling failed/);
  await assert.rejects(
    runtime.subscribe(() => {}),
    /unavailable/,
  );
  await runtime.dispose();
});

test('deadline-only and control-only publications have ordered sequences even at identical heads', async () => {
  const { options, seats, clock } = fixture('vote', 4);
  const runtime = await GameRuntime.create(options);
  try {
    const notices: RuntimePublication[] = [];
    await runtime.subscribe((notice) => {
      notices.push(notice);
    });
    await runtime.dispatch({ type: 'disconnect', id: id('command', 'leave'), seatId: seats[1]! });
    await clock.advanceBy(30001);
    const paused = runtime.read().head;
    await runtime.dispatch({
      type: 'propose-bot',
      id: id('command', 'replace'),
      actorId: seats[0]!,
      seatId: seats[1]!,
    });
    assert.deepEqual(notices.at(-1)!.snapshot.head, paused);
    assert.equal(notices.at(-1)!.actions.length, 0);
    await clock.advanceBy(10000);
    assert.deepEqual(notices.at(-1)!.snapshot.head, paused);
    assert.equal(notices.at(-1)!.snapshot.replacementVote, null);
    assert.equal(notices.at(-1)!.actions.length, 0);
    await runtime.dispatch({ type: 'reconnect', id: id('command', 'return'), seatId: seats[1]! });
    await clock.advanceBy(10000);
    assert.equal(notices.at(-1)!.actions[0]!.action.events[0]!.event.type, 'claim-vote-expired');
    assert.equal(notices.at(-1)!.snapshot.state!.procedure, null);
    for (let index = 1; index < notices.length; index++)
      assert.equal(notices[index]!.sequence, notices[index - 1]!.sequence + 1);
    notices.forEach(verifyPairs);
  } finally {
    await runtime.dispose();
  }
});

test('checkpoint, observer, duplicate and rejected jobs remain quiet without changing existing commits', async () => {
  const { options, seats } = fixture('vote', 4);
  let commits = 0;
  const runtime = await GameRuntime.create({
    ...options,
    commit: async () => {
      commits++;
    },
  });
  try {
    const notices: RuntimePublication[] = [];
    await runtime.subscribe((notice) => {
      notices.push(notice);
    });
    const command = {
      type: 'cast-vote' as const,
      id: id('command', 'one'),
      actorId: seats[0]!,
      procedureId: runtime.read().state!.procedure!.timer.id,
      vote: 'yes' as const,
    };
    await runtime.dispatch(command);
    const count = notices.length;
    const saved = commits;
    assert.equal((await runtime.dispatch(command)).type, 'accepted');
    await runtime.dispatch({ ...command, vote: 'no' });
    await runtime.checkpoint();
    await runtime.observe(async () => {});
    await assert.rejects(
      runtime.observe(async () => {
        throw new Error('Observer failed');
      }),
    );
    assert.equal(notices.length, count);
    assert.equal(
      commits,
      saved + 3,
      'existing duplicate/rejection/checkpoint storage behavior remains',
    );
  } finally {
    await runtime.dispose();
  }
});

test('listeners cannot mutate runtime, action pairs or another subscriber capture', async () => {
  const { options, seats } = fixture('vote', 4);
  const runtime = await GameRuntime.create(options);
  try {
    const received: RuntimePublication[] = [];
    await runtime.subscribe((notice) => {
      (notice.snapshot.head as { version: number }).version = 999;
      (notice.snapshot.state!.players as unknown[]).length = 0;
      (notice.actions as unknown[]).length = 0;
    });
    await runtime.subscribe((notice) => {
      received.push(notice);
    });
    await runtime.dispatch({
      type: 'cast-vote',
      id: id('command', 'normal'),
      actorId: seats[0]!,
      procedureId: runtime.read().state!.procedure!.timer.id,
      vote: 'yes',
    });
    assert.equal(runtime.read().state!.players.length, 4);
    assert.equal(received.at(-1)!.snapshot.state!.players.length, 4);
    assert.notEqual(received.at(-1)!.snapshot.head.version, 999);
    assert.equal(received.at(-1)!.actions.length, 1);
    verifyPairs(received.at(-1)!);
  } finally {
    await runtime.dispose();
  }
});

test('throwing or rejecting listeners and error reporters cannot fault commands, deadlines or disposal', async () => {
  const { options, seats, clock } = fixture('vote', 4);
  const runtime = await GameRuntime.create(options);
  const errors: number[] = [];
  const reported = Promise.withResolvers<void>();
  await runtime.subscribe(
    () => {
      throw new Error('SECRET-CARD-DIAGNOSTIC');
    },
    (sequence) => {
      errors.push(sequence);
      throw new Error('Reporter failed');
    },
  );
  await runtime.subscribe(
    async () => {
      throw new Error('SECRET-ASYNC');
    },
    async (sequence) => {
      errors.push(sequence);
      reported.resolve();
      throw new Error('Async reporter failed');
    },
  );
  await reported.promise;
  assert.ok(errors.length >= 2);
  assert.ok(errors.every((value) => Number.isSafeInteger(value)));
  const result = await runtime.dispatch({
    type: 'cast-vote',
    id: id('command', 'valid'),
    actorId: seats[0]!,
    procedureId: runtime.read().state!.procedure!.timer.id,
    vote: 'yes',
  });
  assert.equal(result.type, 'accepted');
  await clock.advanceBy(10000);
  assert.equal(runtime.read().state!.pendingPenalties.length, 1);
  assert.equal(runtime.read().state!.procedure, null);
  await runtime.dispose();
});

test('never-settling delivery does not block work; an async listener can enqueue follow-up work without deadlock', async () => {
  const { options, seats, clock } = fixture('vote', 4);
  const runtime = await GameRuntime.create(options);
  await runtime.subscribe(() => new Promise<void>(() => {}));
  const finished = Promise.withResolvers<void>();
  let followUp = false;
  await runtime.subscribe(async (notice) => {
    if (notice.kind === 'initial' || followUp) return;
    followUp = true;
    await runtime.checkpoint();
    await runtime.observe(async () => {});
    finished.resolve();
  });
  assert.equal(
    (
      await runtime.dispatch({
        type: 'cast-vote',
        id: id('command', 'first'),
        actorId: seats[0]!,
        procedureId: runtime.read().state!.procedure!.timer.id,
        vote: 'abstain',
      })
    ).type,
    'accepted',
  );
  await finished.promise;
  await clock.advanceBy(10000);
  assert.equal(runtime.read().state!.procedure, null);
  await runtime.dispose();
});

test('a command and its automatic clock reconciliation publish once with exact ordered action pairs', async () => {
  const { options, seats } = fixture('vote', 4);
  const gameId = id('game', 'notification-start');
  const history = new MemoryHistory(gameId, id('branch', 'main'));
  const runtime = await GameRuntime.create({ ...options, history, connectedSeatIds: [seats[0]!] });
  try {
    const notices: RuntimePublication[] = [];
    await runtime.subscribe((notice) => {
      notices.push(notice);
    });
    await runtime.dispatch({
      type: 'start-game',
      id: id('command', 'start'),
      gameId,
      ownerId: seats[0]!,
      seatIds: seats,
      cardIds: Array.from({ length: 36 }, (_, index) => id('card', `opaque-${index}`)),
    });
    const notice = notices.at(-1)!;
    assert.equal(notices.length, 2);
    assert.equal(notice.snapshot.paused, true);
    assert.equal(notice.actions.length, 2);
    assert.equal(notice.actions[0]!.action.events[0]!.event.type, 'game-started');
    assert.equal(notice.actions[1]!.action.events[0]!.event.type, 'clock-suspended');
    assert.deepEqual(notice.snapshot.head, history.read().head);
    verifyPairs(notice);
  } finally {
    await runtime.dispose();
  }
});

test('rollback publishes only exact new-branch rebases/reconciliation, never inherited or abandoned actions', async () => {
  const { options, history, seats } = fixture('withdrawal', 4);
  const runtime = await GameRuntime.create(options);
  try {
    const notices: RuntimePublication[] = [];
    await runtime.subscribe((notice) => {
      notices.push(notice);
    });
    const target = history.read().actions.at(-1)!.commandId;
    const result = await runtime.dispatch({
      type: 'rollback',
      id: id('command', 'fork'),
      actorId: seats[0]!,
      expected: runtime.read().head,
      beforeCommandId: target,
      knowledgeWarningAcknowledged: true,
    });
    assert.equal(result.type, 'accepted');
    const rollback = notices.at(-1)!;
    assert.equal(rollback.kind, 'rollback');
    assert.equal(rollback.actions.length, 1);
    assert.equal(rollback.actions[0]!.action.events[0]!.event.type, 'clock-rebased');
    assert.equal(rollback.actions[0]!.after.head.branchId, rollback.snapshot.head.branchId);
    verifyPairs(rollback);
    assert.deepEqual(projectAction(rollback.actions[0]!, { type: 'public' }).observations, []);
    const beforeCreation = await runtime.dispatch({
      type: 'rollback',
      id: id('command', 'empty'),
      actorId: seats[0]!,
      expected: runtime.read().head,
      beforeCommandId: history.read().actions[0]!.commandId,
      knowledgeWarningAcknowledged: true,
    });
    assert.equal(beforeCreation.type, 'accepted');
    assert.equal(notices.at(-1)!.kind, 'rollback');
    assert.equal(notices.at(-1)!.snapshot.state, null);
    assert.deepEqual(notices.at(-1)!.actions, []);
  } finally {
    await runtime.dispose();
  }
});

test('restored subscription emits a new baseline without replaying accepted receipts or private observations', async () => {
  const { options, seats, clock } = fixture('vote', 4);
  const original = await GameRuntime.create(options);
  const command = {
    type: 'cast-vote' as const,
    id: id('command', 'saved'),
    actorId: seats[0]!,
    procedureId: original.read().state!.procedure!.timer.id,
    vote: 'yes' as const,
  };
  await original.dispatch(command);
  await clock.advanceBy(4000);
  const checkpoint = await original.checkpoint();
  await original.dispose();
  const runtime = await GameRuntime.restore(options, checkpoint);
  try {
    const notices: RuntimePublication[] = [];
    await runtime.subscribe((notice) => {
      notices.push(notice);
    });
    assert.equal(notices[0]!.kind, 'initial');
    assert.deepEqual(notices[0]!.actions, []);
    assert.equal(notices[0]!.snapshot.state!.procedure!.timer.remainingMs, 6000);
    assert.equal((await runtime.dispatch(command)).type, 'accepted');
    assert.equal(notices.length, 1);
  } finally {
    await runtime.dispose();
  }
});

test('legacy closure emits committed same-head metadata synchronously capturable for owner history', async () => {
  const { options, clock, history, seats } = fixture('reveal');
  const runtime = await GameRuntime.create(options);
  try {
    await clock.advanceBy(10000);
    await finishMatch(runtime);
    const head = runtime.read().head;
    let closedTargets: boolean | null = null;
    const notices: RuntimePublication[] = [];
    await runtime.subscribe((notice) => {
      notices.push(notice);
      if (notice.kind === 'rollback-closed') {
        const projected = projectOwnerHistory(history.snapshot().value, {
          type: 'seat',
          seatId: seats[0]!,
        });
        closedTargets = projected.branches
          .flatMap((branch) => branch.actions)
          .every((row) => row.rollbackTarget === null);
      }
    });
    assert.equal(await runtime.closeForNextMatch(), true);
    assert.equal(notices.at(-1)!.kind, 'rollback-closed');
    assert.deepEqual(notices.at(-1)!.snapshot.head, head);
    assert.equal(closedTargets, true);
    assert.deepEqual(notices.at(-1)!.actions, []);
  } finally {
    await runtime.dispose();
  }
});

test('handoff notifies once after its special transaction without an ordinary extra commit', async () => {
  const { options, clock } = fixture('reveal');
  let commits = 0;
  const runtime = await GameRuntime.create({
    ...options,
    commit: async () => {
      commits++;
    },
  });
  await clock.advanceBy(10000);
  await finishMatch(runtime);
  const notices: RuntimePublication[] = [];
  await runtime.subscribe((notice) => {
    notices.push(notice);
  });
  const count = commits;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const pending = runtime.handoff(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  assert.equal(notices.length, 1);
  release.resolve();
  assert.equal(await pending, true);
  assert.equal(commits, count);
  assert.equal(notices.length, 2);
  assert.equal(notices[1]!.kind, 'handoff');
  assert.deepEqual(notices[1]!.actions, []);
  await assert.rejects(
    runtime.subscribe(() => {}),
    /unavailable/,
  );
  await runtime.dispose();
});

test('fresh peek observations project only to the actor and never replay through retries, rollback or resubscription', async () => {
  const { options, seats, clock } = fixture('reveal', 4);
  const runtime = await GameRuntime.create(options);
  try {
    await clock.advanceBy(10000);
    const notices: RuntimePublication[] = [];
    await runtime.subscribe((notice) => {
      notices.push(notice);
    });
    const command = {
      type: 'open-stump' as const,
      id: id('command', 'peek-once'),
      actorId: seats[0]!,
      cardId: runtime.read().state!.players[0]!.stumps[0]!,
    };
    assert.equal((await runtime.dispatch(command)).type, 'accepted');
    const pair = notices.at(-1)!.actions[0]!;
    verifyPairs(notices.at(-1)!);
    const own = projectAction(pair, { type: 'seat', seatId: seats[0]! });
    assert.equal(own.observations.filter((item) => item.type === 'stump-peeked').length, 1);
    assert.equal(
      projectAction(pair, { type: 'public' }).observations.some(
        (item) => item.type === 'stump-peeked',
      ),
      false,
    );
    const count = notices.length;
    const retry = await runtime.dispatch(command);
    assert.equal(retry.type === 'accepted' && retry.duplicate, true);
    assert.equal(notices.length, count);
    const latest: RuntimePublication[] = [];
    await runtime.subscribe((notice) => {
      latest.push(notice);
    });
    assert.deepEqual(latest[0]!.actions, []);
    const live = projectLiveGame(
      latest[0]!.snapshot,
      { type: 'seat', seatId: seats[0]! },
      latest[0]!.nowMs,
    );
    assert.equal(
      live.state!.own!.hand.some((card) => card.id === command.cardId),
      false,
    );
    assert.equal(JSON.stringify(live).includes('peekedStumps'), false);
    await runtime.dispatch({
      type: 'rollback',
      id: id('command', 'undo-peek'),
      actorId: seats[0]!,
      expected: runtime.read().head,
      beforeCommandId: command.id,
      knowledgeWarningAcknowledged: true,
    });
    assert.equal(notices.at(-1)!.kind, 'rollback');
    for (const action of notices.at(-1)!.actions) {
      assert.equal(
        projectAction(action, { type: 'seat', seatId: seats[0]! }).observations.some(
          (item) => item.type === 'stump-peeked',
        ),
        false,
      );
    }
  } finally {
    await runtime.dispose();
  }
});

test('failed handoff and disposed obsolete deadlines send no stale notifications', async () => {
  class UncancelableClock extends FakeClock {
    override scheduleAt(at: number, task: () => Promise<void>): () => void {
      super.scheduleAt(at, task);
      return () => {};
    }
  }
  const { options } = fixture('vote', 4);
  const clock = new UncancelableClock(1000);
  const runtime = await GameRuntime.create({ ...options, clock });
  const notices: RuntimePublication[] = [];
  await runtime.subscribe((notice) => {
    notices.push(notice);
  });
  await runtime.dispose();
  await clock.advanceBy(10000);
  assert.equal(notices.length, 1);
  const setup = fixture('reveal');
  const other = await GameRuntime.create(setup.options);
  await setup.clock.advanceBy(10000);
  await finishMatch(other);
  const failed: RuntimePublication[] = [];
  await other.subscribe((notice) => {
    failed.push(notice);
  });
  await assert.rejects(
    other.handoff(async () => {
      throw new Error('Transaction failed');
    }),
    /Transaction failed/,
  );
  assert.equal(failed.length, 1);
  await other.dispose();
});
