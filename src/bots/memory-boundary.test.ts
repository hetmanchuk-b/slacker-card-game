import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAction, decide, validateState } from '../game/engine.ts';
import type { GameCommand } from '../game/contracts.ts';
import type { GameState } from '../game/model.ts';
import { id } from '../game/ids.ts';
import { cardId, club, heart, scenario, seat, step } from '../game/testing/scenarios.ts';
import { GameRuntime } from '../runtime/runtime.ts';
import type { RuntimeSnapshot } from '../runtime/runtime.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import { observeBotAction, observeBotCurrent } from './observation.ts';
import { createBotMemory, rememberBotObservation, restoreBotMemory } from './memory.ts';

function capture(
  base: RuntimeSnapshot,
  state: GameState,
  command: GameCommand,
  own = seat(0),
  version = 10,
) {
  const before = {
    ...base,
    state,
    head: { gameId: state.gameId, branchId: id('branch', 'main'), version },
  };
  const decision = decide(state, command, { nowMs: 1000, randomInt: (upper) => upper - 1 });
  if (decision.type !== 'accepted') assert.fail(decision.code);
  const after = {
    ...before,
    state: applyAction(state, decision.action),
    head: { ...before.head, version: version + 1 },
  };
  assert.deepEqual(validateState(after.state), []);
  const prior = observeBotCurrent(before, own, 1000);
  const memory = rememberBotObservation(createBotMemory(state.gameId, own), prior);
  const current = observeBotCurrent(after, own, 1000);
  const action = observeBotAction(
    { before, after, action: decision.action, delivery: 'fresh' },
    own,
  );
  return {
    before,
    after,
    current,
    action,
    memory,
    learned: rememberBotObservation(memory, current, action),
    batch: decision.action,
  };
}

const pickup = { type: 'take-bottom' as const, id: id('command', 'pickup'), actorId: seat(1) };
function manualBoundary() {
  return scenario({
    hands: [[], [club(7)]],
    stumps: [[club(8), club(9)], []],
    table: [heart(10)],
    turn: 1,
  });
}

for (const mode of ['manual', 'manual-and-automatic', 'lead-and-automatic'] as const) {
  test(`permitted boundary memory: ${mode} grants a one-use right`, async () => {
    const runtime = await GameRuntime.create(fixture('vote').options);
    try {
      const state =
        mode === 'manual'
          ? manualBoundary()
          : mode === 'manual-and-automatic'
            ? scenario({
                hands: [[], [club(7)], [], []],
                stumps: [[club(8), club(9)], [], [club(10)], [club(11)]],
                table: [heart(8), heart(9), heart(10)],
                turn: 1,
              })
            : scenario({ hands: [[heart(10)], []], stumps: [[club(8), club(9)], [club(10)]] });
      const command =
        mode === 'lead-and-automatic'
          ? {
              type: 'play-card' as const,
              id: id('command', 'lead'),
              actorId: seat(0),
              cardId: cardId(state, heart(10)),
            }
          : pickup;
      const result = capture(runtime.read(), state, command);
      assert.equal(result.after.state.phase.type, 'between-rounds');
      assert.deepEqual(
        result.action.observations.map((o) => o.type),
        mode === 'manual'
          ? ['bottom-taken']
          : mode === 'manual-and-automatic'
            ? ['bottom-taken', 'bottom-taken', 'bottom-taken']
            : ['card-played', 'bottom-taken'],
      );
      assert.deepEqual(result.learned.opening, {
        head: result.current.head,
        round: 3,
        available: true,
      });
      const opened = capture(
        runtime.read(),
        result.after.state,
        {
          type: 'open-stump',
          id: id('command', 'open'),
          actorId: seat(0),
          cardId: result.after.state.players[0]!.stumps[0]!,
        },
        seat(0),
        11,
      );
      const consumed = rememberBotObservation(result.learned, opened.current, opened.action);
      assert.equal(consumed.opening?.available, false);
      assert.deepEqual(rememberBotObservation(consumed, opened.current, opened.action), consumed);
      const played = step(opened.after.state, {
        type: 'play-card',
        id: id('command', 'play-opened'),
        actorId: seat(0),
        cardId: opened.after.state.players[0]!.hand[0]!,
      });
      const peek = capture(runtime.read(), played, {
        type: 'open-stump',
        id: id('command', 'second-open'),
        actorId: seat(0),
        cardId: played.players[0]!.stumps[0]!,
      });
      assert.ok(peek.action.observations.some((o) => o.type === 'violation'));
      assert.equal(peek.learned.opening, null, 'a fresh peek cannot establish a right');
    } finally {
      await runtime.dispose();
    }
  });
}

test('boundary inference permits omitted unrelated private transfers, not own transfers', async () => {
  const runtime = await GameRuntime.create(fixture('vote').options);
  try {
    let state = scenario({
      hands: [[], [club(6)], [], [club(7), club(8)]],
      stumps: [[club(9)], [club(10)], [club(11)], []],
      table: [heart(10)],
      turn: 2,
    });
    state = step(state, {
      type: 'open-stump',
      id: id('command', 'peek'),
      actorId: seat(1),
      cardId: cardId(state, club(10)),
    });
    assert.equal(state.procedure?.type, 'penalty');
    if (state.procedure?.type !== 'penalty') assert.fail();
    const procedureId = state.procedure.timer.id;
    for (const index of [0, 2])
      state = step(state, {
        type: 'penalty-response',
        id: id('command', `refuse-${index}`),
        actorId: seat(index),
        procedureId,
        cardId: null,
      });
    const command = {
      type: 'penalty-response' as const,
      id: id('command', 'donate'),
      actorId: seat(3),
      procedureId,
      cardId: cardId(state, club(7)),
    };
    const result = capture(runtime.read(), state, command);
    assert.ok(result.batch.events.some((e) => e.event.type === 'penalty-completed'));
    assert.deepEqual(
      result.action.observations.map((o) => o.type),
      ['bottom-taken'],
    );
    assert.equal(result.learned.opening?.available, true);
    const recipient = capture(runtime.read(), state, command, seat(1));
    assert.ok(recipient.action.observations.some((o) => o.type === 'penalty-transfer'));
    assert.equal(recipient.learned.opening, null);
    const taker = capture(runtime.read(), state, command, seat(2));
    assert.equal(taker.current.state!.own!.hand.length, 1);
    assert.equal(taker.learned.opening, null);
  } finally {
    await runtime.dispose();
  }
});

test('boundary knowledge never repairs missing, duplicate, gapped or mismatched context', async () => {
  const runtime = await GameRuntime.create(fixture('vote').options);
  try {
    const { memory, current, action, learned, before, after, batch } = capture(
      runtime.read(),
      manualBoundary(),
      pickup,
    );
    assert.equal(learned.opening?.available, true);
    assert.equal(rememberBotObservation(memory, current).opening, null);
    const baseline = rememberBotObservation(memory, current);
    assert.equal(rememberBotObservation(baseline, current, action).opening, null);
    const duplicate = observeBotAction(
      { before, after, action: batch, delivery: 'duplicate' },
      seat(0),
    );
    assert.equal(rememberBotObservation(memory, current, duplicate).opening, null);
    for (const prior of [
      { ...memory, phase: null },
      { ...memory, phase: 'round:1' },
      { ...memory, phase: 'between-rounds:1' },
      { ...memory, phase: 'between-rounds:3' },
      { ...memory, head: { ...memory.head!, version: 8 } },
    ]) {
      assert.equal(rememberBotObservation(prior, current, action).opening, null);
    }
    for (const head of [
      { ...action.head, gameId: id('game', 'wrong') },
      { ...action.head, branchId: id('branch', 'wrong') },
      { ...action.head, version: 12 },
    ])
      assert.throws(
        () => rememberBotObservation(memory, current, { ...action, head }),
        /Invalid memory context/,
      );
    for (const observation of [
      { type: 'stump-opened' as const, seatId: seat(0), card: null },
      {
        type: 'penalty-transfer' as const,
        fromSeatId: seat(1),
        toSeatId: seat(0),
        card:
          action.observations[0]!.type === 'bottom-taken'
            ? action.observations[0]!.card
            : assert.fail(),
      },
    ]) {
      const output = rememberBotObservation(memory, current, {
        ...action,
        observations: [...action.observations, observation],
      });
      assert.notEqual(output.opening?.available, true);
    }
    assert.equal(
      rememberBotObservation(
        memory,
        {
          ...current,
          state: {
            ...current.state!,
            players: current.state!.players.map((player) =>
              player.id === seat(0) ? { ...player, status: 'won' as const } : player,
            ),
          },
        },
        action,
      ).opening,
      null,
      'inactive seats cannot gain rights',
    );
    const fork = { ...current.head, branchId: id('branch', 'fork') };
    assert.equal(restoreBotMemory(learned, fork).opening?.available, true);
    const unknown = restoreBotMemory(createBotMemory(memory.gameId, memory.seatId), fork);
    assert.equal(rememberBotObservation(unknown, { ...current, head: fork }).opening, null);
  } finally {
    await runtime.dispose();
  }
});

test('boundary without stumps or with a finished result cannot grant', async () => {
  const runtime = await GameRuntime.create(fixture('vote').options);
  try {
    const noStumps = scenario({ hands: [[], [club(7)], [club(8)]], table: [heart(10)], turn: 1 });
    assert.equal(capture(runtime.read(), noStumps, pickup).learned.opening, null);
    const finished = scenario({ hands: [[heart(10)], [heart(12)]] });
    const lead = step(finished, {
      type: 'play-card',
      id: id('command', 'lead'),
      actorId: seat(0),
      cardId: cardId(finished, heart(10)),
    });
    const result = capture(runtime.read(), lead, {
      type: 'play-card',
      id: id('command', 'finish'),
      actorId: seat(1),
      cardId: cardId(lead, heart(12)),
    });
    assert.equal(result.after.state.phase.type, 'finished');
    assert.equal(result.learned.opening, null);
    const normal = capture(runtime.read(), manualBoundary(), pickup);
    const key = normal.after.state.lastRepetitionKey!;
    const repetition = capture(
      runtime.read(),
      { ...manualBoundary(), repetitions: { [key]: 2 } },
      pickup,
    );
    assert.equal(repetition.after.state.phase.type, 'finished');
    assert.equal(repetition.learned.opening, null);
  } finally {
    await runtime.dispose();
  }
});
