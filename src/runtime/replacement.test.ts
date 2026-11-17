import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id } from '../game/ids.ts';
import { GameRuntime } from './runtime.ts';
import { fixture } from './testing/fixtures.ts';

test('a replacement timeout counts abstentions without consuming the frozen gameplay clock', async () => {
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
  const vote = runtime.read().replacementVote!;
  await runtime.dispatch({
    type: 'replacement-vote',
    id: id('command', 'yes'),
    actorId: seats[0]!,
    procedureId: vote.timer.id,
    vote: 'yes',
  });
  await clock.advanceBy(9999);
  assert.equal(runtime.read().paused, true);
  await clock.advanceBy(1);
  assert.equal(runtime.read().connections[1]!.controller, 'bot');
  assert.equal(runtime.read().paused, false);
  const procedure = runtime.read().state!.procedure;
  if (procedure?.type !== 'claim-vote') throw new Error('Expected gameplay vote');
  assert.equal(procedure.timer.remainingMs, 10000);
  assert.equal(procedure.timer.startedAtMs, 41001);
  await runtime.dispose();
});

test('a tied replacement vote leaves the human seat absent and the game suspended', async () => {
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
  const vote = runtime.read().replacementVote!;
  for (const [actor, value] of [
    [0, 'yes'],
    [2, 'no'],
    [3, 'abstain'],
  ] as const)
    await runtime.dispatch({
      type: 'replacement-vote',
      id: id('command', `ballot-${actor}`),
      actorId: seats[actor]!,
      procedureId: vote.timer.id,
      vote: value,
    });
  assert.equal(runtime.read().replacementVote, null);
  assert.equal(runtime.read().connections[1]!.controller, 'human');
  assert.equal(runtime.read().paused, true);
  await clock.advanceBy(100000);
  assert.equal(runtime.read().state!.claims[0]!.resolution, 'pending');
  await runtime.dispose();
});

test('returning before replacement cancels the control vote even if another player is still absent', async () => {
  const { options, clock, seats } = fixture('vote', 4);
  const runtime = await GameRuntime.create(options);
  await runtime.dispatch({ type: 'disconnect', id: id('command', 'leave-b'), seatId: seats[1]! });
  await runtime.dispatch({ type: 'disconnect', id: id('command', 'leave-c'), seatId: seats[2]! });
  await clock.advanceBy(30001);
  await runtime.dispatch({
    type: 'propose-bot',
    id: id('command', 'propose'),
    actorId: seats[0]!,
    seatId: seats[1]!,
  });
  await runtime.dispatch({ type: 'reconnect', id: id('command', 'return-b'), seatId: seats[1]! });
  assert.equal(runtime.read().replacementVote, null);
  assert.equal(runtime.read().connections[1]!.controller, 'human');
  assert.equal(runtime.read().paused, true, 'The other absence still blocks play');
  await clock.advanceBy(20000);
  assert.equal(runtime.read().connections[1]!.controller, 'human');
  await runtime.dispatch({ type: 'reconnect', id: id('command', 'return-c'), seatId: seats[2]! });
  assert.equal(runtime.read().paused, false);
  await runtime.dispose();
});

test('bot handover preserves an atomic draw and returns authority to the reconnecting human', async () => {
  const { options, clock, seats } = fixture('vote');
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
  await clock.advanceBy(10000);
  const botDraw = runtime.dispatch(
    { type: 'draw-card', id: id('command', 'bot-draw'), actorId: seats[1]! },
    { controller: 'bot' },
  );
  const reconnect = runtime.dispatch({
    type: 'reconnect',
    id: id('command', 'return'),
    seatId: seats[1]!,
  });
  assert.equal((await botDraw).type, 'accepted');
  assert.equal((await reconnect).type, 'accepted');
  assert.equal(runtime.read().state!.players[1]!.stumps.length, 1);
  assert.equal(runtime.read().connections[1]!.controller, 'human');
  const staleBot = await runtime.dispatch(
    { type: 'draw-card', id: id('command', 'stale-bot'), actorId: seats[1]! },
    { controller: 'bot' },
  );
  assert.equal(staleBot.type, 'rejected');
  if (staleBot.type === 'rejected') assert.equal(staleBot.code, 'wrong-controller');
  await runtime.dispose();
});

test('bots cannot continue when every human connection is absent', async () => {
  const { options, clock, seats, history } = fixture('vote');
  const runtime = await GameRuntime.create(options);
  await runtime.dispatch({ type: 'disconnect', id: id('command', 'leave-b'), seatId: seats[1]! });
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
  await runtime.dispatch({ type: 'disconnect', id: id('command', 'leave-a'), seatId: seats[0]! });
  const version = history.read().head.version;
  await clock.advanceBy(100000);
  assert.equal(runtime.read().paused, true);
  assert.equal(history.read().head.version, version);
  const result = await runtime.dispatch(
    { type: 'draw-card', id: id('command', 'alone-bot'), actorId: seats[1]! },
    { controller: 'bot' },
  );
  assert.equal(result.type, 'rejected');
  if (result.type === 'rejected') assert.equal(result.code, 'game-suspended');
  await runtime.dispose();
});

test('replacement ballots reject stale, repeated and newly ineligible voters without changing control state', async () => {
  const { options, clock, seats } = fixture('vote', 4);
  const runtime = await GameRuntime.create(options);
  await runtime.dispatch({ type: 'disconnect', id: id('command', 'leave-b'), seatId: seats[1]! });
  await runtime.dispatch({ type: 'disconnect', id: id('command', 'leave-c'), seatId: seats[2]! });
  await clock.advanceBy(30001);
  await runtime.dispatch({
    type: 'propose-bot',
    id: id('command', 'propose'),
    actorId: seats[0]!,
    seatId: seats[1]!,
  });
  await runtime.dispatch({ type: 'reconnect', id: id('command', 'return-c'), seatId: seats[2]! });
  const vote = runtime.read().replacementVote!;
  const command = {
    type: 'replacement-vote' as const,
    id: id('command', 'ballot'),
    actorId: seats[0]!,
    procedureId: vote.timer.id,
    vote: 'yes' as const,
  };
  const before = runtime.read().controlEvents.length;
  const ineligible = await runtime.dispatch({ ...command, actorId: seats[2]! });
  assert.equal(ineligible.type, 'rejected');
  if (ineligible.type === 'rejected') assert.equal(ineligible.code, 'not-eligible');
  const stale = await runtime.dispatch({ ...command, procedureId: id('procedure', 'old') });
  assert.equal(stale.type, 'rejected');
  if (stale.type === 'rejected') assert.equal(stale.code, 'stale-timer');
  assert.equal(runtime.read().controlEvents.length, before);
  await runtime.dispatch(command);
  const repeated = await runtime.dispatch({ ...command, id: id('command', 'second-answer') });
  assert.equal(repeated.type, 'rejected');
  if (repeated.type === 'rejected') assert.equal(repeated.code, 'already-answered');
  assert.equal(runtime.read().connections[1]!.controller, 'human');
  assert.equal(runtime.read().paused, true);
  await runtime.dispose();
});

test('a majority can replace an absent player only after more than thirty seconds', async () => {
  const { options, clock, seats } = fixture('vote', 4);
  const runtime = await GameRuntime.create(options);
  await clock.advanceBy(4000);
  await runtime.dispatch({ type: 'disconnect', id: id('command', 'leave'), seatId: seats[1]! });
  await clock.advanceBy(30000);
  const proposal = {
    type: 'propose-bot' as const,
    id: id('command', 'propose'),
    actorId: seats[0]!,
    seatId: seats[1]!,
  };
  const early = await runtime.dispatch(proposal);
  assert.equal(early.type, 'rejected');
  if (early.type === 'rejected') assert.equal(early.code, 'replacement-too-early');
  await clock.advanceBy(1);
  assert.equal((await runtime.dispatch(proposal)).type, 'accepted');
  const replacement = runtime.read().replacementVote;
  if (!replacement) throw new Error('Expected replacement vote');
  assert.deepEqual(replacement.eligibleSeatIds, [seats[0], seats[2], seats[3]]);
  for (const actor of [0, 2, 3])
    await runtime.dispatch({
      type: 'replacement-vote',
      id: id('command', `vote-${actor}`),
      actorId: seats[actor]!,
      procedureId: replacement.timer.id,
      vote: actor === 3 ? 'abstain' : 'yes',
    });
  assert.equal(runtime.read().replacementVote, null);
  assert.equal(
    runtime.read().connections.find((item) => item.seatId === seats[1])!.controller,
    'bot',
  );
  assert.equal(runtime.read().paused, false);
  const procedure = runtime.read().state!.procedure;
  if (procedure?.type !== 'claim-vote') throw new Error('Expected resumed ballot');
  assert.equal(procedure.timer.remainingMs, 6000);
  assert.equal(procedure.timer.startedAtMs, 35001);
  await clock.advanceBy(6000);
  assert.equal(runtime.read().state!.claims[0]!.resolution, 'tied');
  await runtime.dispose();
});
