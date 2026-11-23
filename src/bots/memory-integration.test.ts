import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, applyAction } from '../game/engine.ts';
import { id } from '../game/ids.ts';
import { scenario, heart, club, seat, cardId, step } from '../game/testing/scenarios.ts';
import { GameRuntime } from '../runtime/runtime.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import { observeBotAction, observeBotCurrent } from './observation.ts';
import { createBotMemory, rememberBotObservation } from './memory.ts';

test('engine/projector composition grants the play-only boundary but excludes own transfers', async () => {
  const { options } = fixture('vote');
  const runtime = await GameRuntime.create(options);
  try {
    let state = scenario({ hands: [[heart(10)], [heart(12), club(7)]], stumps: [[club(8)], []] });
    state = step(state, {
      type: 'play-card',
      id: id('command', 'lead'),
      actorId: seat(0),
      cardId: cardId(state, heart(10)),
    });
    const before = {
      ...runtime.read(),
      state,
      head: { gameId: state.gameId, branchId: id('branch', 'main'), version: 10 },
    };
    const current = observeBotCurrent(before, seat(0), 1000);
    const memory = rememberBotObservation(createBotMemory(state.gameId, seat(0)), current);
    const decision = decide(
      state,
      {
        type: 'play-card',
        id: id('command', 'beat'),
        actorId: seat(1),
        cardId: cardId(state, heart(12)),
      },
      { nowMs: 1000, randomInt: (upper) => upper - 1 },
    );
    if (decision.type !== 'accepted') assert.fail(decision.code);
    const after = {
      ...before,
      head: { ...before.head, version: 11 },
      state: applyAction(state, decision.action),
    };
    const projected = observeBotCurrent(after, seat(0), 1000);
    const action = observeBotAction(
      { before, after, action: decision.action, delivery: 'fresh' },
      seat(0),
    );
    assert.equal(rememberBotObservation(memory, projected, action).opening?.available, true);
    assert.equal(rememberBotObservation(memory, projected).opening, null);
    assert.equal(
      rememberBotObservation(memory, projected, {
        ...action,
        observations: [
          ...action.observations,
          {
            type: 'penalty-transfer',
            fromSeatId: seat(1),
            toSeatId: seat(0),
            card: current.state!.own!.hand[0] ?? { id: id('card', 'public'), face: heart(6) },
          },
        ],
      }).opening,
      null,
    );
  } finally {
    await runtime.dispose();
  }
});
