import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide } from '../game/engine.ts';
import { id } from '../game/ids.ts';
import { cardId, club, heart, scenario, seat } from '../game/testing/scenarios.ts';
import { GameRuntime } from '../runtime/runtime.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import { decodeClientMessage } from './decode.ts';

// Test-only server binding: decoding does not authenticate or construct commands.
function decoded(intent: unknown, requestId = 'request') {
  const result = decodeClientMessage({ protocolVersion: 1, requestId, intent });
  if (result.type !== 'decoded') assert.fail(result.code);
  return result.message;
}

test('decoding plus explicit trusted binding preserves out-of-turn punishment, retries and delayed current-branch attempts', async () => {
  const { options, seats, clock } = fixture('vote', 4);
  const runtime = await GameRuntime.create(options);
  try {
    await clock.advanceBy(10000);
    const initial = runtime.read();
    const intent = {
      type: 'draw-card',
      gameId: initial.head.gameId,
      branchId: initial.head.branchId,
    };
    const first = decoded(intent, 'wrong-draw');
    const delayed = decoded(intent, 'delayed-draw');
    const submit = (message: typeof first) =>
      runtime.dispatch(
        { type: 'draw-card', id: message.requestId, actorId: seats[0]! },
        { branchId: initial.head.branchId },
      );
    const result = await submit(first);
    assert.equal(result.type, 'accepted');
    if (result.type !== 'accepted') assert.fail();
    assert.equal(result.outcome, 'violation');
    const after = runtime.read();
    const retry = await submit(decoded(intent, 'wrong-draw'));
    assert.equal(retry.type === 'accepted' && retry.duplicate, true);
    assert.deepEqual(runtime.read().state, after.state);
    const second = await submit(delayed);
    assert.equal(second.type === 'accepted' && second.outcome, 'violation');
    assert.equal(runtime.read().state!.pendingPenalties.length, 2);
    assert.equal(runtime.read().head.version > initial.head.version, true);
    const changed = decoded({ ...intent, type: 'play-card', cardId: 'guessed' }, 'wrong-draw');
    if (changed.intent.type !== 'play-card') assert.fail();
    assert.equal(
      (
        await runtime.dispatch(
          {
            type: 'play-card',
            id: changed.requestId,
            actorId: seats[0]!,
            cardId: changed.intent.cardId,
          },
          { branchId: initial.head.branchId },
        )
      ).type,
      'rejected',
    );
  } finally {
    await runtime.dispose();
  }
});

test('exact procedure IDs are preserved for runtime rejection rather than retargeting stale responses', async () => {
  const { options, seats } = fixture('vote', 4);
  const runtime = await GameRuntime.create(options);
  try {
    const snapshot = runtime.read();
    const route = { gameId: snapshot.head.gameId, branchId: snapshot.head.branchId };
    for (const procedureId of ['stale-timer', snapshot.state!.procedure!.timer.id]) {
      const message = decoded(
        { type: 'cast-vote', ...route, procedureId, vote: 'yes' },
        procedureId,
      );
      if (message.intent.type !== 'cast-vote') assert.fail();
      assert.equal(message.intent.procedureId, procedureId);
      const result = await runtime.dispatch(
        {
          type: 'cast-vote',
          id: message.requestId,
          actorId: seats[0]!,
          procedureId: message.intent.procedureId,
          vote: message.intent.vote,
        },
        { branchId: route.branchId },
      );
      assert.equal(result.type, procedureId === 'stale-timer' ? 'rejected' : 'accepted');
    }
  } finally {
    await runtime.dispose();
  }
});

test('validly shaped invalid beats and own-stump peeks are not blocked by the decoder', () => {
  const state = scenario({
    hands: [[heart(7)], [heart(9)]],
    stumps: [[club(7)], [club(8)]],
    table: [heart(8)],
    turn: 0,
  });
  const route = { gameId: state.gameId, branchId: id('branch', 'main') };
  for (const type of ['play-card', 'open-stump'] as const) {
    const message = decoded({
      type,
      ...route,
      cardId: cardId(state, type === 'play-card' ? heart(7) : club(7)),
    });
    const intent = message.intent;
    if (intent.type !== 'play-card' && intent.type !== 'open-stump') assert.fail();
    const decision = decide(
      state,
      { type: intent.type, id: message.requestId, actorId: seat(0), cardId: intent.cardId },
      { nowMs: 1000, randomInt: (upper) => upper - 1 },
    );
    assert.equal(decision.type === 'accepted' && decision.outcome, 'violation');
  }
});

test('forged identity packets cannot enter the test binding path or create a game action', async () => {
  const { options, seats } = fixture('vote', 4);
  const runtime = await GameRuntime.create(options);
  try {
    const before = runtime.read();
    const result = decodeClientMessage({
      protocolVersion: 1,
      requestId: 'forged',
      intent: {
        type: 'draw-card',
        gameId: before.head.gameId,
        branchId: before.head.branchId,
        actorId: seats[1],
      },
    });
    assert.equal(result.type, 'rejected');
    assert.deepEqual(runtime.read(), before);
  } finally {
    await runtime.dispose();
  }
});
