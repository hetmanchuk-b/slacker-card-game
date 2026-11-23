import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id } from '../game/ids.ts';
import type { SeatId } from '../game/ids.ts';
import { GameRuntime, RuntimeAdmissionError } from '../runtime/runtime.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import { observeBotCurrent } from './observation.ts';
import { startBotRunner } from './runner.ts';

async function setup(phase: 'vote' | 'penalty' = 'vote') {
  const f = fixture(phase, 4);
  const runtime = await GameRuntime.create(f.options);
  async function replace(seatId: SeatId) {
    const actorId = runtime
      .read()
      .connections.find(
        (p) => p.seatId !== seatId && p.connected && p.controller === 'human',
      )!.seatId;
    await runtime.dispatch({ type: 'disconnect', id: f.options.nextCommandId(), seatId });
    await f.clock.advanceBy(30001);
    await runtime.dispatch({ type: 'propose-bot', id: f.options.nextCommandId(), actorId, seatId });
    await runtime.dispatch({
      type: 'replacement-vote',
      id: f.options.nextCommandId(),
      actorId,
      procedureId: runtime.read().replacementVote!.timer.id,
      vote: 'yes',
    });
    await f.clock.advanceBy(10000);
  }
  return { ...f, runtime, replace };
}

async function drain(runtime: GameRuntime) {
  // Each fresh publication may enqueue a response after the current queue tail.
  for (let i = 0; i < 12; i++) await runtime.observe(async () => {});
}

test('runner approves only the top withdrawal, preserves nested clocks across absence, then abstains in FIFO ballots', async () => {
  const { runtime, seats, clock, options, replace } = await setup();
  let stop = () => {};
  try {
    await replace(seats[2]!);
    await clock.advanceBy(2000);
    const first = runtime.read().state!.procedure!;
    await runtime.dispatch({
      type: 'submit-claim',
      id: options.nextCommandId(),
      actorId: seats[1]!,
      accusedId: seats[0]!,
      reason: 'second',
      incident: { type: 'chat', messageId: 'retained-message' },
      scope: 'dealing',
      scopeNumber: 0,
    });
    await runtime.dispatch({
      type: 'request-withdrawal',
      id: options.nextCommandId(),
      actorId: seats[0]!,
      claimId: runtime.read().state!.claims[0]!.claim.id,
    });
    const withdrawalId = runtime.read().state!.procedure!.timer.id;
    const stale = runtime.botAdmission(seats[2]!, new AbortController().signal);
    stop = await startBotRunner(runtime, options.nextCommandId);
    await drain(runtime);
    let view = observeBotCurrent(runtime.read(), seats[2]!, clock.now());
    assert.equal(view.procedure?.type, 'withdrawal');
    if (view.procedure?.type !== 'withdrawal') assert.fail();
    assert.equal(view.procedure.ownApproval, true);
    assert.equal(view.procedure.suspendedVote!.ownVote, null);
    assert.equal(view.procedure.suspendedVote!.timer.remainingMs, 8000);
    await clock.advanceBy(1000);
    await runtime.dispatch({ type: 'disconnect', id: options.nextCommandId(), seatId: seats[3]! });
    await clock.advanceBy(20000);
    await runtime.dispatch({ type: 'reconnect', id: options.nextCommandId(), seatId: seats[3]! });
    view = observeBotCurrent(runtime.read(), seats[2]!, clock.now());
    if (view.procedure?.type !== 'withdrawal') assert.fail();
    assert.equal(view.procedure.timer.remainingMs, 9000);
    assert.equal(view.procedure.suspendedVote!.timer.remainingMs, 8000);
    assert.equal(view.procedure.suspendedVote!.timer.paused, true);
    await runtime.dispatch({
      type: 'withdrawal-response',
      id: options.nextCommandId(),
      actorId: seats[1]!,
      procedureId: withdrawalId,
      approve: false,
    });
    await drain(runtime);
    view = observeBotCurrent(runtime.read(), seats[2]!, clock.now());
    if (view.procedure?.type !== 'claim-vote') assert.fail();
    assert.equal(view.procedure.timer.id, first.timer.id);
    assert.equal(view.procedure.timer.remainingMs, 8000);
    assert.equal(view.procedure.ownVote, 'abstain');
    await assert.rejects(
      runtime.dispatch(
        {
          type: 'withdrawal-response',
          id: options.nextCommandId(),
          actorId: seats[2]!,
          procedureId: withdrawalId,
          approve: true,
        },
        stale,
      ),
      RuntimeAdmissionError,
    );
    for (const actorId of [seats[0]!, seats[3]!])
      await runtime.dispatch({
        type: 'cast-vote',
        id: options.nextCommandId(),
        actorId,
        procedureId: first.timer.id,
        vote: 'abstain',
      });
    await drain(runtime);
    const second = runtime.read().state!.procedure!;
    assert.equal(second.type, 'claim-vote');
    assert.notEqual(second.timer.id, first.timer.id);
    assert.equal(
      (
        await runtime.dispatch({
          type: 'cast-vote',
          id: options.nextCommandId(),
          actorId: seats[2]!,
          procedureId: first.timer.id,
          vote: 'abstain',
        })
      ).type,
      'rejected',
    );
    for (const actorId of [seats[1]!, seats[3]!])
      await runtime.dispatch({
        type: 'cast-vote',
        id: options.nextCommandId(),
        actorId,
        procedureId: second.timer.id,
        vote: 'abstain',
      });
    await drain(runtime);
    assert.equal(runtime.read().state!.procedure, null);
    assert.deepEqual(
      runtime.read().state!.claims.map((c) => c.resolution),
      ['tied', 'tied'],
    );
    const commands = (await runtime.checkpoint()).receipts
      .filter((r) => r.controller === 'bot')
      .map((r) => r.command);
    assert.deepEqual(
      commands.map((c) => c.type),
      ['withdrawal-response', 'cast-vote', 'cast-vote'],
    );
  } finally {
    stop();
    await runtime.dispose();
  }
});

test('runner accused consents explicitly to unanimous withdrawal without voting on accusation', async () => {
  const { runtime, seats, options, replace } = await setup();
  let stop = () => {};
  try {
    await replace(seats[1]!);
    await runtime.dispatch({
      type: 'request-withdrawal',
      id: options.nextCommandId(),
      actorId: seats[0]!,
      claimId: runtime.read().state!.claims[0]!.claim.id,
    });
    const procedureId = runtime.read().state!.procedure!.timer.id;
    stop = await startBotRunner(runtime, options.nextCommandId);
    await drain(runtime);
    assert.equal(runtime.read().state!.procedure?.type, 'withdrawal');
    for (const actorId of seats.slice(2))
      await runtime.dispatch({
        type: 'withdrawal-response',
        id: options.nextCommandId(),
        actorId,
        procedureId,
        approve: true,
      });
    await drain(runtime);
    assert.equal(runtime.read().state!.procedure, null);
    assert.equal(runtime.read().state!.claims[0]!.resolution, 'withdrawn');
    assert.deepEqual(
      (await runtime.checkpoint()).receipts
        .filter((r) => r.controller === 'bot')
        .map((r) => r.command.type),
      ['withdrawal-response'],
    );
  } finally {
    stop();
    await runtime.dispose();
  }
});

test('false claim verdict prompts explicit bot penalty refusal before completing procedure', async () => {
  const { runtime, seats, clock, options, replace } = await setup('penalty');
  let stop = () => {};
  try {
    // Settle the initial automatic dealing penalty before the new claim.
    const initial = runtime.read().state!.procedure!;
    if (initial.type !== 'penalty') assert.fail();
    for (const actorId of initial.eligibleSeatIds)
      await runtime.dispatch({
        type: 'penalty-response',
        id: options.nextCommandId(),
        actorId,
        procedureId: initial.timer.id,
        cardId: null,
      });
    await replace(seats[2]!);
    await runtime.dispatch({
      type: 'submit-claim',
      id: options.nextCommandId(),
      actorId: seats[0]!,
      accusedId: seats[1]!,
      reason: 'false claim',
      incident: { type: 'spoken', key: 'false' },
      scope: 'between-rounds',
      scopeNumber: 0,
    });
    const ballot = runtime.read().state!.procedure!;
    assert.equal(ballot.type, 'claim-vote');
    stop = await startBotRunner(runtime, options.nextCommandId);
    await drain(runtime);
    for (const actorId of [seats[0]!, seats[3]!])
      await runtime.dispatch({
        type: 'cast-vote',
        id: options.nextCommandId(),
        actorId,
        procedureId: ballot.timer.id,
        vote: 'no',
      });
    await drain(runtime);
    const penalty = runtime.read().state!.procedure!;
    assert.equal(penalty.type, 'penalty');
    if (penalty.type !== 'penalty') assert.fail();
    assert.equal(penalty.penalty.recipientId, seats[0]);
    const projected = observeBotCurrent(runtime.read(), seats[2]!, clock.now()).procedure;
    if (projected?.type !== 'penalty') assert.fail();
    assert.deepEqual(projected.ownResponse, { type: 'refuse' });
    for (const actorId of [seats[1]!, seats[3]!])
      await runtime.dispatch({
        type: 'penalty-response',
        id: options.nextCommandId(),
        actorId,
        procedureId: penalty.timer.id,
        cardId: null,
      });
    await drain(runtime);
    assert.equal(runtime.read().state!.procedure, null);
    const commands = (await runtime.checkpoint()).receipts
      .filter((r) => r.controller === 'bot')
      .map((r) => r.command);
    assert.deepEqual(
      commands.slice(0, 2).map((c) => c.type),
      ['cast-vote', 'penalty-response'],
    );
    assert.ok(
      commands
        .slice(2)
        .every(
          (c) => c.type === 'play-card' || c.type === 'take-bottom' || c.type === 'open-stump',
        ),
    );
  } finally {
    stop();
    await runtime.dispose();
  }
});

test('multiple bots including claimant abstain once despite exact-head cancellation; action evidence stays unclassified', async () => {
  const { runtime, seats, options, replace } = await setup();
  let stop = () => {};
  try {
    await replace(seats[0]!);
    await replace(seats[2]!);
    stop = await startBotRunner(runtime, options.nextCommandId);
    await drain(runtime);
    const first = runtime.read().state!.procedure!;
    await runtime.dispatch({
      type: 'cast-vote',
      id: options.nextCommandId(),
      actorId: seats[3]!,
      procedureId: first.timer.id,
      vote: 'abstain',
    });
    assert.equal(runtime.read().state!.claims[0]!.resolution, 'tied');
    await runtime.dispatch({
      type: 'submit-claim',
      id: options.nextCommandId(),
      actorId: seats[3]!,
      accusedId: seats[1]!,
      reason: 'action fixture',
      incident: { type: 'action', commandId: id('command', 'trusted-action-fixture') },
      scope: 'dealing',
      scopeNumber: 0,
    });
    await drain(runtime);
    const second = runtime.read().state!.procedure!;
    await runtime.dispatch({
      type: 'cast-vote',
      id: options.nextCommandId(),
      actorId: seats[3]!,
      procedureId: second.timer.id,
      vote: 'abstain',
    });
    await drain(runtime);
    assert.equal(runtime.read().state!.procedure, null);
    const responses = (await runtime.checkpoint()).receipts.filter((r) => r.controller === 'bot');
    assert.equal(responses.length, 4);
    assert.ok(
      responses.every((r) => r.command.type === 'cast-vote' && r.command.vote === 'abstain'),
    );
  } finally {
    stop();
    await runtime.dispose();
  }
});
