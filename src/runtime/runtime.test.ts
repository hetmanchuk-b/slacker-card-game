import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GameRuntime } from './runtime.ts';
import { id } from '../game/ids.ts';
import { fixture } from './testing/fixtures.ts';

test('disconnect freezes a vote at six seconds and reconnect resumes that same ballot', async () => {
  const { options, clock, seats } = fixture('vote', 4);
  const runtime = await GameRuntime.create(options);
  await clock.advanceBy(4000);
  assert.equal(
    (
      await runtime.dispatch({
        type: 'disconnect',
        id: id('command', 'disconnect'),
        seatId: seats[1]!,
      })
    ).type,
    'accepted',
  );
  let state = runtime.read().state!;
  assert.equal(state.clock.type, 'suspended');
  if (state.procedure?.type !== 'claim-vote') throw new Error('Expected vote');
  assert.equal(state.procedure.timer.remainingMs, 6000);
  assert.equal(state.procedure.timer.startedAtMs, null);
  const timerId = state.procedure.timer.id;
  await clock.advanceBy(100000);
  assert.equal(runtime.read().state?.procedure?.type, 'claim-vote');
  const blocked = await runtime.dispatch({
    type: 'cast-vote',
    id: id('command', 'paused-vote'),
    actorId: seats[0]!,
    procedureId: timerId,
    vote: 'yes',
  });
  assert.equal(blocked.type, 'rejected');
  if (blocked.type === 'rejected') assert.equal(blocked.code, 'game-suspended');
  await runtime.dispatch({ type: 'reconnect', id: id('command', 'return'), seatId: seats[1]! });
  state = runtime.read().state!;
  assert.equal(state.clock.type, 'running');
  if (state.procedure?.type !== 'claim-vote') throw new Error('Vote disappeared');
  assert.equal(state.procedure.timer.remainingMs, 6000);
  assert.equal(state.procedure.timer.startedAtMs, 105000);
  await clock.advanceBy(5999);
  assert.equal(runtime.read().state?.procedure?.type, 'claim-vote');
  await clock.advanceBy(1);
  assert.equal(runtime.read().state?.claims[0]!.resolution, 'tied');
  await runtime.dispose();
});

test('runtime deadlines resolve abstentions, penalty refusals and nested withdrawal without sleeps', async () => {
  for (const phase of ['vote', 'penalty', 'withdrawal'] as const) {
    const { options, clock } = fixture(phase);
    const runtime = await GameRuntime.create(options);
    await clock.advanceBy(phase === 'withdrawal' ? 16000 : 10000);
    const state = runtime.read().state!;
    assert.equal(state.procedure, null);
    if (phase === 'penalty') assert.equal(state.phase.type, 'between-rounds');
    else assert.equal(state.claims[0]!.resolution, 'tied');
    await runtime.dispose();
  }
});

test('multiple absences preserve the original freeze and require every missing human to return', async () => {
  const { options, clock, seats, history } = fixture('vote', 4);
  const runtime = await GameRuntime.create(options);
  await clock.advanceBy(4000);
  await runtime.dispatch({ type: 'disconnect', id: id('command', 'leave-b'), seatId: seats[1]! });
  const frozenVersion = history.read().head.version;
  await clock.advanceBy(20000);
  await runtime.dispatch({ type: 'disconnect', id: id('command', 'leave-c'), seatId: seats[2]! });
  assert.equal(
    history.read().head.version,
    frozenVersion,
    'Second absence must not re-freeze a timer',
  );
  await runtime.dispatch({ type: 'reconnect', id: id('command', 'return-b'), seatId: seats[1]! });
  assert.equal(runtime.read().paused, true);
  await runtime.dispatch({ type: 'reconnect', id: id('command', 'return-c'), seatId: seats[2]! });
  assert.equal(runtime.read().paused, false);
  const procedure = runtime.read().state!.procedure;
  if (procedure?.type !== 'claim-vote') throw new Error('Expected vote');
  assert.equal(procedure.timer.remainingMs, 6000);
  await runtime.dispose();
});

test('accepted command retries execute once and changed payloads cannot reuse their identity', async () => {
  const { options, clock, seats, history } = fixture('vote');
  const runtime = await GameRuntime.create(options);
  const procedure = runtime.read().state!.procedure;
  if (procedure?.type !== 'claim-vote') throw new Error('Expected vote');
  const command = {
    type: 'cast-vote' as const,
    id: id('command', 'one-ballot'),
    actorId: seats[0]!,
    procedureId: procedure.timer.id,
    vote: 'yes' as const,
  };
  const result = await runtime.dispatch(command);
  const version = history.read().head.version;
  const retry = await runtime.dispatch({ ...command });
  assert.equal(retry.type, 'accepted');
  if (retry.type === 'accepted') assert.equal(retry.duplicate, true);
  const changed = await runtime.dispatch({ ...command, vote: 'no' });
  assert.equal(changed.type, 'rejected');
  if (changed.type === 'rejected') assert.equal(changed.code, 'command-id-reused');
  assert.equal(history.read().head.version, version);
  await clock.advanceBy(20000);
  assert.equal(history.read().head.version, version, 'Obsolete vote expiry must not fire');
  assert.equal(result.type, 'accepted');
  await runtime.dispose();
});

test('disconnect during withdrawal does not resume either the suspended ballot or the reveal early', async () => {
  const { options, clock, seats } = fixture('reveal', 4);
  const runtime = await GameRuntime.create(options);
  await clock.advanceBy(4000);
  await runtime.dispatch({
    type: 'submit-claim',
    id: id('command', 'new-claim'),
    actorId: seats[0]!,
    accusedId: seats[1]!,
    reason: 'Spoken episode',
    incident: { type: 'spoken', key: 'nested' },
    scope: 'dealing',
    scopeNumber: 0,
  });
  await clock.advanceBy(1000);
  await runtime.dispatch({
    type: 'request-withdrawal',
    id: id('command', 'withdraw'),
    actorId: seats[0]!,
    claimId: runtime.read().state!.claims[0]!.claim.id,
  });
  await clock.advanceBy(1000);
  await runtime.dispatch({ type: 'disconnect', id: id('command', 'leave'), seatId: seats[1]! });
  let state = runtime.read().state!;
  if (state.procedure?.type !== 'withdrawal' || state.phase.type !== 'trump-reveal')
    throw new Error('Expected nested timers');
  assert.equal(state.procedure.timer.remainingMs, 9000);
  assert.equal(state.procedure.suspendedVote!.timer.remainingMs, 9000);
  assert.equal(state.phase.timer.remainingMs, 6000);
  await clock.advanceBy(100000);
  await runtime.dispatch({ type: 'reconnect', id: id('command', 'return'), seatId: seats[1]! });
  await clock.advanceBy(9000);
  state = runtime.read().state!;
  assert.equal(state.procedure?.type, 'claim-vote');
  if (state.phase.type !== 'trump-reveal') throw new Error('Reveal vanished');
  assert.equal(state.phase.timer.startedAtMs, null);
  await clock.advanceBy(9000);
  state = runtime.read().state!;
  assert.equal(state.procedure, null);
  if (state.phase.type !== 'trump-reveal') throw new Error('Reveal vanished');
  assert.equal(state.phase.timer.remainingMs, 6000);
  await clock.advanceBy(6000);
  assert.equal(runtime.read().state!.phase.type, 'between-rounds');
  await runtime.dispose();
});

test('generation guards ignore obsolete callbacks even when the clock cannot cancel delivery', async () => {
  const data = fixture('vote', 4);
  const clock = {
    now: () => data.clock.now(),
    scheduleAt: (deadline: number, task: () => Promise<void>) => {
      data.clock.scheduleAt(deadline, task);
      return () => undefined;
    },
  };
  const runtime = await GameRuntime.create({ ...data.options, clock });
  await data.clock.advanceBy(4000);
  await runtime.dispatch({
    type: 'disconnect',
    id: id('command', 'leave'),
    seatId: data.seats[1]!,
  });
  await data.clock.advanceBy(20000);
  assert.equal(runtime.read().state!.claims[0]!.resolution, 'pending');
  await runtime.dispatch({
    type: 'reconnect',
    id: id('command', 'return'),
    seatId: data.seats[1]!,
  });
  await data.clock.advanceBy(6000);
  assert.equal(runtime.read().state!.claims[0]!.resolution, 'tied');
  const version = data.history.read().head.version;
  await runtime.dispose();
  await data.clock.advanceBy(100000);
  assert.equal(data.history.read().head.version, version);
});

test('branch and controller authorization do not suppress a legitimate out-of-turn violation', async () => {
  const { options, clock, seats, history } = fixture('reveal');
  const runtime = await GameRuntime.create(options);
  await clock.advanceBy(10000);
  const state = runtime.read().state!;
  const command = {
    type: 'play-card' as const,
    id: id('command', 'out-of-turn'),
    actorId: seats[1]!,
    cardId: state.players[1]!.hand[0]!,
  };
  const before = history.read().head.version;
  const wrongBranch = await runtime.dispatch(command, { branchId: id('branch', 'abandoned') });
  assert.equal(wrongBranch.type, 'rejected');
  if (wrongBranch.type === 'rejected') assert.equal(wrongBranch.code, 'wrong-branch');
  assert.equal(history.read().head.version, before);
  const result = await runtime.dispatch(command);
  assert.equal(result.type, 'accepted');
  if (result.type === 'accepted') assert.equal(result.outcome, 'violation');
  assert.equal(runtime.read().state!.procedure?.type, 'penalty');
  const forbidden = await runtime.dispatch({
    type: 'resume-clock',
    id: id('command', 'forged-system'),
  });
  assert.equal(forbidden.type, 'rejected');
  if (forbidden.type === 'rejected') assert.equal(forbidden.code, 'system-command');
  await runtime.dispose();
  const closed = await runtime.dispatch({ ...command, id: id('command', 'after-close') });
  assert.equal(closed.type, 'rejected');
  if (closed.type === 'rejected') assert.equal(closed.code, 'closed');
});

test('concurrently submitted ballots are serialized and their canceled deadline never replays a verdict', async () => {
  const { options, clock, seats, history } = fixture('vote', 4);
  const runtime = await GameRuntime.create(options);
  const procedure = runtime.read().state!.procedure;
  if (procedure?.type !== 'claim-vote') throw new Error('Expected vote');
  const results = await Promise.all(
    (
      [
        [0, 'yes'],
        [2, 'no'],
        [3, 'abstain'],
      ] as const
    ).map(([actor, vote]) =>
      runtime.dispatch({
        type: 'cast-vote',
        id: id('command', `concurrent-${actor}`),
        actorId: seats[actor]!,
        procedureId: procedure.timer.id,
        vote,
      }),
    ),
  );
  assert.ok(results.every((result) => result.type === 'accepted'));
  assert.equal(runtime.read().state!.claims[0]!.resolution, 'tied');
  const version = history.read().head.version;
  await clock.advanceBy(20000);
  assert.equal(history.read().head.version, version);
  await runtime.dispose();
});

test('the runtime expires the final-card reveal exactly once at its deadline', async () => {
  const { options, clock, history } = fixture('reveal');
  const runtime = await GameRuntime.create(options);
  const beforeVersion = history.read().head.version;
  await clock.advanceBy(9999);
  assert.equal(runtime.read().state?.phase.type, 'trump-reveal');
  await clock.advanceBy(1);
  assert.equal(runtime.read().state?.phase.type, 'between-rounds');
  assert.equal(history.read().head.version, beforeVersion + 1);
  await clock.advanceBy(10000);
  assert.equal(history.read().head.version, beforeVersion + 1);
  await runtime.dispose();
});
