import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id } from '../game/ids.ts';
import { GameRuntime } from './runtime.ts';
import { fixture } from './testing/fixtures.ts';
import { FakeClock } from './testing/fake-clock.ts';
import { finishMatch } from './testing/match.ts';

test('owner rollback restores the six-second pre-withdrawal ballot and invalidates the abandoned future', async () => {
  const { options, clock, history, seats } = fixture('withdrawal');
  const runtime = await GameRuntime.create(options);
  await clock.advanceBy(20000);
  assert.equal(runtime.read().state?.procedure, null);
  const abandoned = history.read();
  const result = await runtime.dispatch({
    type: 'rollback',
    id: id('command', 'rollback'),
    actorId: seats[0]!,
    expected: abandoned.head,
    beforeCommandId: id('command', 'withdraw'),
    knowledgeWarningAcknowledged: true,
  });
  assert.equal(result.type, 'accepted');
  const snapshot = runtime.read();
  assert.notEqual(snapshot.head.branchId, abandoned.head.branchId);
  assert.equal(snapshot.state?.procedure?.type, 'claim-vote');
  assert.equal(snapshot.state?.procedure?.timer.remainingMs, 6000);
  assert.equal(snapshot.state?.procedure?.timer.startedAtMs, clock.now());
  assert.deepEqual(history.read(abandoned.head.branchId), abandoned);
  assert.equal(snapshot.controlEvents.at(-1)?.type, 'rollback-completed');
  await clock.advanceBy(5999);
  assert.equal(runtime.read().state?.procedure?.type, 'claim-vote');
  await clock.advanceBy(1);
  assert.equal(runtime.read().state?.procedure, null);
  await runtime.dispose();
});

test('rollback keeps current absences and resumes restored time only after reconnection', async () => {
  const { options, clock, history, seats } = fixture('withdrawal');
  const runtime = await GameRuntime.create(options);
  await runtime.dispatch({ type: 'disconnect', id: id('command', 'leave'), seatId: seats[1]! });
  await clock.advanceBy(60000);
  assert.equal(
    (
      await runtime.dispatch({
        type: 'rollback',
        id: id('command', 'rollback'),
        actorId: seats[0]!,
        expected: history.read().head,
        beforeCommandId: id('command', 'withdraw'),
        knowledgeWarningAcknowledged: true,
      })
    ).type,
    'accepted',
  );
  assert.equal(runtime.read().paused, true);
  assert.equal(runtime.read().state?.procedure?.timer.remainingMs, 6000);
  assert.equal(runtime.read().state?.procedure?.timer.startedAtMs, null);
  assert.equal(runtime.read().connections[1]?.disconnectedAtMs, 5000);
  await clock.advanceBy(60000);
  await runtime.dispatch({ type: 'reconnect', id: id('command', 'return'), seatId: seats[1]! });
  assert.equal(runtime.read().paused, false);
  assert.equal(runtime.read().state?.procedure?.timer.remainingMs, 6000);
  await clock.advanceBy(5999);
  assert.equal(runtime.read().state?.procedure?.type, 'claim-vote');
  await clock.advanceBy(1);
  assert.equal(runtime.read().state?.procedure, null);
  await runtime.dispose();
});

test('rollback rejects unauthorized actors and unacknowledged warnings without changing history', async () => {
  const { options, history, seats } = fixture('withdrawal');
  const runtime = await GameRuntime.create(options);
  const before = history.read();
  const command = {
    type: 'rollback' as const,
    id: id('command', 'rollback'),
    actorId: seats[0]!,
    expected: before.head,
    beforeCommandId: id('command', 'withdraw'),
    knowledgeWarningAcknowledged: true,
  };
  for (const [input, code] of [
    [{ ...command, actorId: seats[1]! }, 'owner-only'],
    [{ ...command, knowledgeWarningAcknowledged: false }, 'warning-required'],
    [{ ...command, expected: { ...before.head, version: 0 } }, 'version-conflict'],
  ] as const) {
    const result = await runtime.dispatch(input);
    assert.equal(result.type, 'rejected');
    if (result.type === 'rejected') assert.equal(result.code, code);
    assert.deepEqual(history.read(), before);
  }
  const bot = await runtime.dispatch(command, { controller: 'bot' });
  assert.equal(bot.type, 'rejected');
  if (bot.type === 'rejected') assert.equal(bot.code, 'wrong-controller');
  await runtime.dispose();
});

test('a fork requires an explicit current branch for new gameplay and rejects old-branch deliveries', async () => {
  const { options, history, seats } = fixture('withdrawal');
  const runtime = await GameRuntime.create(options);
  await runtime.dispatch({
    type: 'rollback',
    id: id('command', 'rollback'),
    actorId: seats[0]!,
    expected: history.read().head,
    beforeCommandId: id('command', 'withdraw'),
    knowledgeWarningAcknowledged: true,
  });
  const current = runtime.read();
  const command = {
    type: 'cast-vote' as const,
    id: id('command', 'ballot'),
    actorId: seats[0]!,
    procedureId: current.state!.procedure!.timer.id,
    vote: 'abstain' as const,
  };
  for (const origin of [{}, { branchId: id('branch', 'main') }]) {
    const result = await runtime.dispatch(command, origin);
    assert.equal(result.type, 'rejected');
    if (result.type === 'rejected') assert.equal(result.code, 'wrong-branch');
    assert.deepEqual(runtime.read().head, current.head);
  }
  assert.equal(
    (await runtime.dispatch(command, { branchId: current.head.branchId })).type,
    'accepted',
  );
  await runtime.dispose();
});

test('a rollback cancels obsolete deadlines even when the clock still delivers canceled callbacks', async () => {
  class UncancelableClock extends FakeClock {
    override scheduleAt(at: number, task: () => Promise<void>): () => void {
      super.scheduleAt(at, task);
      return () => {};
    }
  }
  const { options, history, seats } = fixture('withdrawal');
  const clock = new UncancelableClock(5000);
  const runtime = await GameRuntime.create({ ...options, clock });
  await clock.advanceBy(1000);
  await runtime.dispatch({
    type: 'rollback',
    id: id('command', 'rollback'),
    actorId: seats[0]!,
    expected: history.read().head,
    beforeCommandId: id('command', 'withdraw'),
    knowledgeWarningAcknowledged: true,
  });
  await clock.advanceBy(9000);
  assert.equal(runtime.read().state?.procedure, null);
  assert.equal(history.read().actions.length, 4);
  assert.equal(history.read(id('branch', 'main')).state?.procedure?.type, 'withdrawal');
  await runtime.dispose();
});

test('fork receipts survive recovery and cannot replay abandoned gameplay on the new branch', async () => {
  const { options, clock, history, seats } = fixture('vote', 4);
  const runtime = await GameRuntime.create(options);
  const ballot = {
    type: 'cast-vote' as const,
    id: id('command', 'ballot'),
    actorId: seats[0]!,
    procedureId: runtime.read().state!.procedure!.timer.id,
    vote: 'yes' as const,
  };
  await clock.advanceBy(4000);
  await runtime.dispatch(ballot);
  const command = {
    type: 'rollback' as const,
    id: id('command', 'rollback'),
    actorId: seats[0]!,
    expected: history.read().head,
    beforeCommandId: ballot.id,
    knowledgeWarningAcknowledged: true,
  };
  await runtime.dispatch(command);
  const checkpoint = await runtime.checkpoint();
  await runtime.dispose();
  await clock.advanceBy(30000);
  const recovered = await GameRuntime.restore(options, checkpoint);
  const before = history.read();
  const duplicate = await recovered.dispatch(command);
  assert.equal(duplicate.type, 'accepted');
  if (duplicate.type === 'accepted') assert.equal(duplicate.duplicate, true);
  assert.deepEqual(history.read(), before);
  const stale = await recovered.dispatch(ballot, { branchId: before.head.branchId });
  assert.equal(stale.type, 'rejected');
  if (stale.type === 'rejected') assert.equal(stale.code, 'wrong-branch');
  assert.equal(history.audit().length, 1);
  assert.equal(recovered.read().state?.procedure?.timer.remainingMs, 6000);
  await recovered.dispose();
});

for (const count of [2, 5, 8]) {
  test(`rollback of a finished ${count}-seat match restores results, cards, rights and repetition counts`, async () => {
    const { options, clock, history, seats } = fixture('reveal', count);
    const runtime = await GameRuntime.create(options);
    await clock.advanceBy(10000);
    await finishMatch(runtime);
    const finished = history.read();
    assert.equal(finished.state?.phase.type, 'finished');
    const last = finished.actions.at(-1)!;
    const point = history.rollbackPoint(last.commandId)!;
    assert.notEqual(point.state?.phase.type, 'finished');
    assert.equal(
      (
        await runtime.dispatch({
          type: 'rollback',
          id: id('command', 'undo-result'),
          actorId: seats[0]!,
          expected: finished.head,
          beforeCommandId: last.commandId,
          knowledgeWarningAcknowledged: true,
        })
      ).type,
      'accepted',
    );
    assert.deepEqual(runtime.read().state, point.state);
    assert.deepEqual(history.read(finished.head.branchId), finished);
    history.closeRollback();
    const head = history.read().head;
    const closed = await runtime.dispatch({
      type: 'rollback',
      id: id('command', 'too-late'),
      actorId: seats[0]!,
      expected: head,
      beforeCommandId: last.commandId,
      knowledgeWarningAcknowledged: true,
    });
    assert.equal(closed.type, 'rejected');
    if (closed.type === 'rejected') assert.equal(closed.code, 'rollback-closed');
    assert.deepEqual(history.read().head, head);
    await runtime.dispose();
  });
}

test('restoring a nested reveal claim never resumes the reveal before its restored ballot finishes', async () => {
  const { options, clock, history, seats } = fixture('reveal');
  const runtime = await GameRuntime.create(options);
  await clock.advanceBy(4000);
  await runtime.dispatch({
    type: 'submit-claim',
    id: id('command', 'reveal-claim'),
    actorId: seats[0]!,
    accusedId: seats[1]!,
    reason: 'Spoken rule',
    incident: { type: 'spoken', key: 'reveal' },
    scope: 'dealing',
    scopeNumber: 0,
  });
  await clock.advanceBy(4000);
  await runtime.dispatch({
    type: 'request-withdrawal',
    id: id('command', 'withdraw-reveal'),
    actorId: seats[0]!,
    claimId: runtime.read().state!.claims[0]!.claim.id,
  });
  await clock.advanceBy(1000);
  await runtime.dispatch({
    type: 'withdrawal-response',
    id: id('command', 'deny'),
    actorId: seats[1]!,
    procedureId: runtime.read().state!.procedure!.timer.id,
    approve: false,
  });
  await clock.advanceBy(5000);
  await runtime.dispatch({
    type: 'rollback',
    id: id('command', 'rollback'),
    actorId: seats[0]!,
    expected: history.read().head,
    beforeCommandId: id('command', 'withdraw-reveal'),
    knowledgeWarningAcknowledged: true,
  });
  const state = runtime.read().state!;
  assert.equal(state.procedure?.type, 'claim-vote');
  assert.equal(state.procedure?.timer.remainingMs, 6000);
  if (state.phase.type !== 'trump-reveal') assert.fail('Expected reveal');
  assert.equal(state.phase.timer.remainingMs, 6000);
  assert.equal(state.phase.timer.startedAtMs, null);
  await clock.advanceBy(6000);
  assert.equal(runtime.read().state?.procedure, null);
  assert.equal(runtime.read().state?.phase.type, 'trump-reveal');
  await clock.advanceBy(5999);
  assert.equal(runtime.read().state?.phase.type, 'trump-reveal');
  await clock.advanceBy(1);
  assert.equal(runtime.read().state?.phase.type, 'between-rounds');
  await runtime.dispose();
});

test('rollback before a penalty gift restores cards and the donor response window', async () => {
  const { options, clock, history, seats } = fixture('penalty');
  const runtime = await GameRuntime.create(options);
  await clock.advanceBy(2000);
  const before = runtime.read().state!;
  const penalty = before.procedure;
  if (penalty?.type !== 'penalty') assert.fail('Expected penalty');
  const donor = before.players.find((player) => player.id === penalty.eligibleSeatIds[0])!;
  await runtime.dispatch({
    type: 'penalty-response',
    id: id('command', 'gift'),
    actorId: donor.id,
    procedureId: penalty.timer.id,
    cardId: donor.hand[0]!,
  });
  assert.equal(runtime.read().state?.procedure, null);
  await clock.advanceBy(3000);
  assert.equal(
    (
      await runtime.dispatch({
        type: 'rollback',
        id: id('command', 'undo-gift'),
        actorId: seats[0]!,
        expected: history.read().head,
        beforeCommandId: id('command', 'gift'),
        knowledgeWarningAcknowledged: true,
      })
    ).type,
    'accepted',
  );
  const restored = runtime.read().state!;
  assert.deepEqual(restored.players, before.players);
  assert.deepEqual(restored.pendingPenalties, before.pendingPenalties);
  assert.equal(restored.procedure?.type, 'penalty');
  assert.equal(restored.procedure?.timer.remainingMs, 8000);
  await clock.advanceBy(8000);
  assert.equal(runtime.read().state?.procedure, null);
  await runtime.dispose();
});

test('restoring withdrawal preserves its seven seconds and the nested six-second suspended ballot', async () => {
  const { options, clock, history, seats } = fixture('withdrawal');
  const runtime = await GameRuntime.create(options);
  await clock.advanceBy(3000);
  await runtime.dispatch({
    type: 'withdrawal-response',
    id: id('command', 'deny'),
    actorId: seats[1]!,
    procedureId: runtime.read().state!.procedure!.timer.id,
    approve: false,
  });
  await clock.advanceBy(1000);
  await runtime.dispatch({
    type: 'rollback',
    id: id('command', 'rollback'),
    actorId: seats[0]!,
    expected: history.read().head,
    beforeCommandId: id('command', 'deny'),
    knowledgeWarningAcknowledged: true,
  });
  const procedure = runtime.read().state!.procedure;
  if (procedure?.type !== 'withdrawal') assert.fail('Expected withdrawal');
  assert.equal(procedure.timer.remainingMs, 7000);
  assert.equal(procedure.suspendedVote?.timer.remainingMs, 6000);
  assert.equal(procedure.suspendedVote?.timer.startedAtMs, null);
  await clock.advanceBy(6999);
  assert.equal(runtime.read().state?.procedure?.type, 'withdrawal');
  await clock.advanceBy(1);
  assert.equal(runtime.read().state?.procedure?.type, 'claim-vote');
  assert.equal(runtime.read().state?.procedure?.timer.remainingMs, 6000);
  await clock.advanceBy(6000);
  assert.equal(runtime.read().state?.procedure, null);
  await runtime.dispose();
});

test('restoring an old disconnect pause uses current connections rather than resurrecting old sockets', async () => {
  const { options, clock, history, seats } = fixture('vote');
  const runtime = await GameRuntime.create(options);
  await clock.advanceBy(4000);
  await runtime.dispatch({ type: 'disconnect', id: id('command', 'leave'), seatId: seats[1]! });
  await clock.advanceBy(9000);
  await runtime.dispatch({ type: 'reconnect', id: id('command', 'return'), seatId: seats[1]! });
  const resume = history
    .read()
    .actions.find((action) => action.events.some((event) => event.event.type === 'clock-resumed'))!;
  await clock.advanceBy(1000);
  await runtime.dispatch({
    type: 'rollback',
    id: id('command', 'rollback'),
    actorId: seats[0]!,
    expected: history.read().head,
    beforeCommandId: resume.commandId,
    knowledgeWarningAcknowledged: true,
  });
  assert.equal(runtime.read().paused, false);
  assert.equal(
    runtime.read().connections.every((connection) => connection.connected),
    true,
  );
  assert.equal(runtime.read().state?.procedure?.timer.remainingMs, 6000);
  assert.equal(runtime.read().state?.procedure?.timer.startedAtMs, clock.now());
  await runtime.dispose();
});

test('the next-match guard serializes with rollback and cannot close a match that was just reopened', async () => {
  for (const closeFirst of [true, false]) {
    const { options, clock, history, seats } = fixture('reveal');
    const runtime = await GameRuntime.create(options);
    await clock.advanceBy(10000);
    await finishMatch(runtime);
    const finished = history.read();
    const command = {
      type: 'rollback' as const,
      id: id('command', 'undo-result'),
      actorId: seats[0]!,
      expected: finished.head,
      beforeCommandId: finished.actions.at(-1)!.commandId,
      knowledgeWarningAcknowledged: true,
    };
    const first = closeFirst ? runtime.closeForNextMatch() : runtime.dispatch(command);
    const second = closeFirst ? runtime.dispatch(command) : runtime.closeForNextMatch();
    const [a, b] = await Promise.all([first, second]);
    const closed = closeFirst ? a : b;
    const rollback = closeFirst ? b : a;
    assert.equal(closed, closeFirst);
    assert.ok(typeof rollback === 'object');
    assert.equal(rollback.type, closeFirst ? 'rejected' : 'accepted');
    if (rollback.type === 'rejected') assert.equal(rollback.code, 'rollback-closed');
    await runtime.dispose();
  }
});

test('rollback explicitly cancels an obsolete replacement vote without changing current controller ownership', async () => {
  const { options, clock, history, seats } = fixture('vote', 4);
  const runtime = await GameRuntime.create(options);
  await runtime.dispatch({ type: 'disconnect', id: id('command', 'leave'), seatId: seats[1]! });
  await clock.advanceBy(30001);
  await runtime.dispatch({
    type: 'propose-bot',
    id: id('command', 'propose'),
    actorId: seats[0]!,
    seatId: seats[1]!,
  });
  assert.ok(runtime.read().replacementVote);
  await runtime.dispatch({
    type: 'rollback',
    id: id('command', 'rollback'),
    actorId: seats[0]!,
    expected: history.read().head,
    beforeCommandId: id('command', 'claim'),
    knowledgeWarningAcknowledged: true,
  });
  assert.equal(runtime.read().replacementVote, null);
  const canceled = runtime
    .read()
    .controlEvents.find((event) => event.type === 'replacement-canceled');
  assert.ok(canceled && canceled.type === 'replacement-canceled');
  assert.equal(canceled.reason, 'rollback');
  await clock.advanceBy(10000);
  assert.equal(runtime.read().connections[1]?.controller, 'human');
  assert.equal(runtime.read().paused, true);
  assert.equal(
    runtime.read().controlEvents.some((event) => event.type === 'replacement-resolved'),
    false,
  );
  await runtime.dispose();
});
