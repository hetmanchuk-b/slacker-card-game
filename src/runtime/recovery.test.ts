import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id } from '../game/ids.ts';
import { GameRuntime } from './runtime.ts';
import type { RuntimeCheckpoint } from './runtime.ts';
import { fixture } from './testing/fixtures.ts';

test('a stale recovery checkpoint cannot overwrite a newer history head', async () => {
  const { options, history, seats } = fixture('vote');
  const runtime = await GameRuntime.create(options);
  const checkpoint = await runtime.checkpoint();
  const procedure = runtime.read().state!.procedure;
  if (procedure?.type !== 'claim-vote') throw new Error('Expected vote');
  await runtime.dispatch({
    type: 'cast-vote',
    id: id('command', 'later-ballot'),
    actorId: seats[0]!,
    procedureId: procedure.timer.id,
    vote: 'abstain',
  });
  await runtime.dispose();
  const before = history.read();
  await assert.rejects(GameRuntime.restore(options, checkpoint), /history head/);
  assert.deepEqual(history.read(), before);
});

test('restoring a withdrawal preserves its own clock and the already suspended six-second ballot', async () => {
  const { options, clock, seats } = fixture('withdrawal', 4);
  const runtime = await GameRuntime.create(options);
  await clock.advanceBy(1000);
  const checkpoint = await runtime.checkpoint();
  await runtime.dispose();
  await clock.advanceBy(100000);
  const restored = await GameRuntime.restore(options, checkpoint);
  const procedure = restored.read().state!.procedure;
  if (procedure?.type !== 'withdrawal' || !procedure.suspendedVote)
    throw new Error('Expected nested withdrawal');
  assert.equal(procedure.timer.remainingMs, 9000);
  assert.equal(procedure.suspendedVote.timer.remainingMs, 6000);
  assert.equal(procedure.suspendedVote.timer.startedAtMs, null);
  for (const [index, seatId] of seats.entries())
    await restored.dispatch({ type: 'reconnect', id: id('command', `return-${index}`), seatId });
  await clock.advanceBy(9000);
  const resumed = restored.read().state!.procedure;
  if (resumed?.type !== 'claim-vote') throw new Error('Expected resumed vote');
  assert.equal(resumed.timer.remainingMs, 6000);
  await clock.advanceBy(6000);
  assert.equal(restored.read().state!.claims[0]!.resolution, 'tied');
  await restored.dispose();
});

test('accepted gameplay receipts survive recovery without reapplying a ballot', async () => {
  const { options, clock, history, seats } = fixture('vote');
  const runtime = await GameRuntime.create(options);
  const procedure = runtime.read().state!.procedure;
  if (procedure?.type !== 'claim-vote') throw new Error('Expected vote');
  const command = {
    type: 'cast-vote' as const,
    id: id('command', 'accepted-ballot'),
    actorId: seats[0]!,
    procedureId: procedure.timer.id,
    vote: 'yes' as const,
  };
  await runtime.dispatch(command);
  const checkpoint = await runtime.checkpoint();
  await runtime.dispose();
  await clock.advanceBy(100000);
  const restored = await GameRuntime.restore(options, checkpoint);
  const version = history.read().head.version;
  const receipt = await restored.dispatch(command);
  assert.equal(receipt.type, 'accepted');
  if (receipt.type === 'accepted') assert.equal(receipt.duplicate, true);
  assert.equal(history.read().head.version, version);
  assert.equal(restored.read().state!.pendingPenalties.length, 1);
  await restored.dispose();
});

test('replacement control deadlines continue through downtime while gameplay stays frozen', async () => {
  const { options, clock, seats } = fixture('vote', 4);
  const runtime = await GameRuntime.create(options);
  await runtime.dispatch({ type: 'disconnect', id: id('command', 'leave'), seatId: seats[1]! });
  await clock.advanceBy(30001);
  await runtime.dispatch({
    type: 'propose-bot',
    id: id('command', 'propose'),
    actorId: seats[0]!,
    seatId: seats[1]!,
  });
  await runtime.dispatch({
    type: 'replacement-vote',
    id: id('command', 'yes'),
    actorId: seats[0]!,
    procedureId: runtime.read().replacementVote!.timer.id,
    vote: 'yes',
  });
  const checkpoint = await runtime.checkpoint();
  await runtime.dispose();
  await clock.advanceBy(20000);
  const restored = await GameRuntime.restore(options, checkpoint);
  await clock.advanceBy(0);
  assert.equal(restored.read().connections[1]!.controller, 'bot');
  assert.equal(restored.read().replacementVote, null);
  assert.equal(restored.read().paused, true, 'No human socket is alive after restart');
  const procedure = restored.read().state!.procedure;
  if (procedure?.type !== 'claim-vote') throw new Error('Expected suspended gameplay ballot');
  assert.equal(procedure.timer.remainingMs, 10000);
  assert.equal(procedure.timer.startedAtMs, null);
  await restored.dispose();
});

test('corrupt recovery control metadata is rejected before the history is changed', async () => {
  const { options, seats, history } = fixture('vote', 4);
  const runtime = await GameRuntime.create(options);
  const checkpoint = await runtime.checkpoint();
  await runtime.dispose();
  const before = history.read();
  const corrupt = {
    ...checkpoint,
    replacementVote: {
      absentSeatId: seats[1]!,
      eligibleSeatIds: [seats[0]!],
      votes: {},
      timer: {
        id: id('procedure', 'corrupt'),
        startedAtMs: checkpoint.capturedAtMs,
        remainingMs: -1,
      },
    },
  };
  await assert.rejects(GameRuntime.restore(options, corrupt), /checkpoint replacement/i);
  assert.deepEqual(history.read(), before);
});

test('recovery pauses dead sockets and preserves the six seconds remaining at checkpoint capture', async () => {
  const { options, clock, seats } = fixture('vote', 4);
  const original = await GameRuntime.create(options);
  await clock.advanceBy(4000);
  const checkpoint = JSON.parse(JSON.stringify(await original.checkpoint())) as RuntimeCheckpoint;
  await original.dispose();
  await clock.advanceBy(100000);
  const restored = await GameRuntime.restore(options, checkpoint);
  assert.equal(restored.read().paused, true);
  assert.ok(restored.read().connections.every((item) => !item.connected));
  let procedure = restored.read().state!.procedure;
  if (procedure?.type !== 'claim-vote') throw new Error('Expected suspended vote');
  assert.equal(procedure.timer.remainingMs, 6000);
  assert.equal(procedure.timer.startedAtMs, null);
  await clock.advanceBy(10000);
  assert.equal(restored.read().state!.claims[0]!.resolution, 'pending');
  for (const [index, seatId] of seats.entries())
    await restored.dispatch({ type: 'reconnect', id: id('command', `return-${index}`), seatId });
  assert.equal(restored.read().paused, false);
  procedure = restored.read().state!.procedure;
  if (procedure?.type !== 'claim-vote') throw new Error('Vote disappeared');
  assert.equal(procedure.timer.remainingMs, 6000);
  assert.equal(procedure.timer.startedAtMs, 115000);
  await clock.advanceBy(6000);
  assert.equal(restored.read().state!.claims[0]!.resolution, 'tied');
  await restored.dispose();
});
