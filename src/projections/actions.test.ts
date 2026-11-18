import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAction, decide } from '../game/engine.ts';
import { id } from '../game/ids.ts';
import { cardId, club, heart, scenario, seat } from '../game/testing/scenarios.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import type { GameCommand, BranchHead } from '../game/contracts.ts';
import type { GameState } from '../game/model.ts';
import { projectAction } from './actions.ts';
import { projectLiveGame } from './live.ts';

function actionFrom(state: GameState, command: GameCommand, nowMs = 1000) {
  const result = decide(state, command, { nowMs, randomInt: (upper) => upper - 1 });
  if (result.type !== 'accepted') assert.fail(result.code);
  const head: BranchHead = { gameId: state.gameId, branchId: id('branch', 'main'), version: 10 };
  return {
    before: { head, state },
    action: result.action,
    after: { head: { ...head, version: 11 }, state: applyAction(state, result.action) },
    delivery: 'fresh' as 'fresh' | 'duplicate',
  };
}

for (const count of [2, 4, 8]) {
  test(`${count}-seat dealing observations show actors without exposing deck/stump faces or reinsertion`, () => {
    const { history, seats } = fixture('vote', count);
    // Creation alone is sufficient; no unresolved claim in this checkpoint.
    const created = applyAction(null, history.read().actions[0]!);
    const phase = created.phase;
    if (phase.type !== 'dealing') assert.fail();
    const drawn = actionFrom(created, {
      type: 'draw-card',
      id: id('command', 'draw'),
      actorId: phase.nextSeatId,
    });
    for (const seatId of seats) {
      assert.deepEqual(projectAction(drawn, { type: 'seat', seatId }).observations, [
        { type: 'card-drawn', seatId: phase.nextSeatId, destination: 'stump', card: null },
      ]);
    }
    const wrong = actionFrom(created, {
      type: 'draw-card',
      id: id('command', 'wrong'),
      actorId: seats[0]!,
    });
    assert.deepEqual(projectAction(wrong, { type: 'public' }).observations, [
      { type: 'draw-rejected', seatId: seats[0] },
    ]);
    assert.equal(
      JSON.stringify(projectAction(wrong, { type: 'public' })).includes('opaque-'),
      false,
    );
  });
}

test('fresh illegal peek is private, duplicate delivery and reconnect never reissue it', () => {
  const state = scenario({ hands: [[heart(8)], [heart(9)]], stumps: [[club(7)], [club(8)]] });
  const input = actionFrom(state, {
    type: 'open-stump',
    id: id('command', 'peek'),
    actorId: seat(0),
    cardId: cardId(state, club(7)),
  });
  const own = projectAction(input, { type: 'seat', seatId: seat(0) });
  assert.ok(
    own.observations.some((item) => item.type === 'stump-peeked' && item.card.face.rank === 7),
  );
  for (const viewer of [{ type: 'public' as const }, { type: 'seat' as const, seatId: seat(1) }]) {
    assert.equal(
      JSON.stringify(projectAction(input, viewer)).includes(cardId(state, club(7))),
      false,
    );
  }
  assert.deepEqual(
    projectAction({ ...input, delivery: 'duplicate' }, { type: 'seat', seatId: seat(0) })
      .observations,
    [],
  );
  const snapshot = {
    ...input.after,
    connections: [],
    paused: false,
    replacementVote: null,
    controlEvents: [],
  };
  const refresh = projectLiveGame(snapshot, { type: 'seat', seatId: seat(0) }, 1000);
  assert.equal(JSON.stringify(refresh).includes('stump-peeked'), false);
  assert.equal(JSON.stringify(refresh).includes('"suit":"clubs"'), false);
  assert.equal(refresh.state!.own!.stumps.includes(cardId(state, club(7))), true);
});

test('a separate repeated illegal peek remains a fresh private action', () => {
  const state = scenario({ hands: [[heart(8)], [heart(9)]], stumps: [[club(7)], [club(8)]] });
  const input = actionFrom(state, {
    type: 'open-stump',
    id: id('command', 'peek-1'),
    actorId: seat(0),
    cardId: cardId(state, club(7)),
  });
  // Refuse the first penalty, then click again, despite existing private knowledge.
  let next = input.after.state;
  const procedure = next.procedure!;
  next = actionFrom(next, {
    type: 'penalty-response',
    id: id('command', 'refuse'),
    actorId: seat(1),
    procedureId: procedure.timer.id,
    cardId: null,
  }).after.state;
  const again = actionFrom(next, {
    type: 'open-stump',
    id: id('command', 'peek-2'),
    actorId: seat(0),
    cardId: cardId(next, club(7)),
  });
  assert.equal(
    projectAction(again, { type: 'seat', seatId: seat(0) }).observations.filter(
      (item) => item.type === 'stump-peeked',
    ).length,
    1,
  );
});

test('lawful stump opening exposes the face only to its owner', () => {
  const state = scenario({ hands: [[], [heart(9)]], stumps: [[club(7)], []], openingSeats: [0] });
  const input = actionFrom(state, {
    type: 'open-stump',
    id: id('command', 'open'),
    actorId: seat(0),
    cardId: cardId(state, club(7)),
  });
  assert.deepEqual(projectAction(input, { type: 'public' }).observations, [
    { type: 'stump-opened', seatId: seat(0), card: null },
  ]);
  assert.deepEqual(projectAction(input, { type: 'seat', seatId: seat(0) }).observations, [
    {
      type: 'stump-opened',
      seatId: seat(0),
      card: state.cards.find((card) => card.id === cardId(state, club(7))),
    },
  ]);
});

test('completed action shows a played card even when it is immediately discarded', () => {
  const state = scenario({ hands: [[club(6)], [heart(9), club(7)]], table: [heart(8)], turn: 1 });
  const input = actionFrom(state, {
    type: 'play-card',
    id: id('command', 'beat'),
    actorId: seat(1),
    cardId: cardId(state, heart(9)),
  });
  assert.deepEqual(input.after.state.table, []);
  assert.deepEqual(projectAction(input, { type: 'public' }).observations, [
    {
      type: 'card-played',
      seatId: seat(1),
      card: state.cards.find((card) => card.id === cardId(state, heart(9))),
    },
  ]);
});

test('all automatic bottom pickups are observable within one atomic action', () => {
  const state = scenario({
    hands: [[], [], [heart(13), club(7)]],
    table: [heart(8), heart(9)],
    turn: 2,
  });
  const input = actionFrom(state, {
    type: 'take-bottom',
    id: id('command', 'take'),
    actorId: seat(2),
  });
  const observations = projectAction(input, { type: 'public' }).observations;
  assert.deepEqual(
    observations.map((item) => item.type),
    ['bottom-taken', 'bottom-taken'],
  );
  assert.deepEqual(
    observations.map(
      (item) => item.type === 'bottom-taken' && [item.seatId, item.card.face.rank, item.automatic],
    ),
    [
      [seat(2), 8, false],
      [seat(0), 9, true],
    ],
  );
});

test('penalty cards are disclosed to donor and recipient only at actual completion, including last response', () => {
  const { history, seats } = fixture('penalty', 4);
  let state = history.read().state!;
  const procedure = state.procedure!;
  const donor = seats[1]!;
  const selected = state.players[1]!.hand[0]!;
  const reserved = actionFrom(
    state,
    {
      type: 'penalty-response',
      id: id('command', 'reserve'),
      actorId: donor,
      procedureId: procedure.timer.id,
      cardId: selected,
    },
    11000,
  );
  assert.deepEqual(projectAction(reserved, { type: 'seat', seatId: seats[0]! }).observations, []);
  state = reserved.after.state;
  state = actionFrom(
    state,
    {
      type: 'penalty-response',
      id: id('command', 'refuse'),
      actorId: seats[2]!,
      procedureId: procedure.timer.id,
      cardId: null,
    },
    11000,
  ).after.state;
  const second = state.players[3]!.hand[0]!;
  const completed = actionFrom(
    state,
    {
      type: 'penalty-response',
      id: id('command', 'last'),
      actorId: seats[3]!,
      procedureId: procedure.timer.id,
      cardId: second,
    },
    11000,
  );
  for (const seatId of seats) {
    const transfers = projectAction(completed, { type: 'seat', seatId }).observations.filter(
      (item) => item.type === 'penalty-transfer',
    );
    assert.equal(
      transfers.length,
      seatId === seats[0] ? 2 : seatId === donor || seatId === seats[3] ? 1 : 0,
    );
    if (seatId === donor) assert.equal(transfers[0]!.card.id, selected);
    if (seatId === seats[3]) assert.equal(transfers[0]!.card.id, second);
  }
  assert.deepEqual(projectAction(completed, { type: 'public' }).observations, []);
});

test('action projection rejects branch/head/replay mismatches and redacts private replay diagnostics', () => {
  const state = scenario({ hands: [[heart(8)], [heart(9)]], stumps: [[club(7)], [club(8)]] });
  const input = actionFrom(state, {
    type: 'open-stump',
    id: id('command', 'peek'),
    actorId: seat(0),
    cardId: cardId(state, club(7)),
  });
  for (const invalid of [
    {
      ...input,
      after: { ...input.after, head: { ...input.after.head, branchId: id('branch', 'abandoned') } },
    },
    { ...input, after: { ...input.after, head: { ...input.after.head, version: 12 } } },
    { ...input, after: { ...input.after, state } },
    { ...input, action: { ...input.action, events: [] } },
    {
      ...input,
      action: {
        ...input.action,
        events: [{ id: id('event', 'bad'), event: { type: 'SECRET-PRIVATE-ERROR' } }],
      },
    },
  ]) {
    assert.throws(() => projectAction(invalid as typeof input, { type: 'public' }), {
      message: 'Invalid action projection context',
    });
  }
  assert.throws(() => projectAction(input, { type: 'seat', seatId: id('seat', 'SECRET-OTHER') }), {
    message: 'Unknown viewer seat',
  });
});

test('creation observations never serialize the catalog or shuffled deck', () => {
  const { history } = fixture('reveal', 4);
  const action = history.read().actions[0]!;
  const afterState = applyAction(null, action);
  const head: BranchHead = {
    gameId: afterState.gameId,
    branchId: id('branch', 'main'),
    version: 0,
  };
  const input = {
    before: { head, state: null },
    after: { head: { ...head, version: 1 }, state: afterState },
    action,
    delivery: 'fresh' as const,
  };
  assert.deepEqual(projectAction(input, { type: 'public' }).observations, []);
  assert.equal(
    JSON.stringify(projectAction(input, { type: 'seat', seatId: afterState.ownerId })).includes(
      'opaque-',
    ),
    false,
  );
});

test('the final hand draw discloses a face only to its recipient, not an immortal public reveal', () => {
  const { history } = fixture('reveal', 4);
  const actions = history.read().actions;
  let before: GameState | null = null;
  for (const action of actions.slice(0, -1)) before = applyAction(before, action);
  assert.ok(before);
  const phase = before.phase;
  if (phase.type !== 'dealing') assert.fail();
  const input = actionFrom(before, {
    type: 'draw-card',
    id: id('command', 'last-draw'),
    actorId: phase.nextSeatId,
  });
  for (const viewer of [
    { type: 'public' as const },
    ...before.players.map((player) => ({ type: 'seat' as const, seatId: player.id })),
  ]) {
    const view = projectAction(input, viewer);
    const draw = view.observations[0]!;
    if (draw.type !== 'card-drawn') assert.fail();
    assert.equal(draw.card !== null, viewer.type === 'seat' && viewer.seatId === phase.nextSeatId);
    assert.equal(view.observations.length, 1);
    if (draw.card) {
      assert.notEqual(
        draw.card.face,
        input.after.state.cards.find((card) => card.id === draw.card!.id)!.face,
      );
    }
  }
});

test('penalty timeout transfers prior reservations but never emits a transfer for refusals', () => {
  const { history, seats } = fixture('penalty', 4);
  let state = history.read().state!;
  const procedure = state.procedure!;
  const selected = state.players[1]!.hand[0]!;
  state = actionFrom(
    state,
    {
      type: 'penalty-response',
      id: id('command', 'reserve-timeout'),
      actorId: seats[1]!,
      procedureId: procedure.timer.id,
      cardId: selected,
    },
    11000,
  ).after.state;
  const input = actionFrom(
    state,
    { type: 'expire-penalty', id: id('command', 'timeout'), timerId: procedure.timer.id },
    21000,
  );
  assert.equal(
    projectAction(input, { type: 'seat', seatId: seats[0]! }).observations.filter(
      (item) => item.type === 'penalty-transfer',
    ).length,
    1,
  );
  assert.deepEqual(projectAction(input, { type: 'public' }).observations, []);
  const empty = actionFrom(
    history.read().state!,
    { type: 'expire-penalty', id: id('command', 'empty-timeout'), timerId: procedure.timer.id },
    21000,
  );
  assert.deepEqual(projectAction(empty, { type: 'seat', seatId: seats[0]! }).observations, []);
});

test('prototype-like seat identifiers retain final-response private transfer observations', () => {
  for (const name of ['__proto__', 'constructor', 'toString']) {
    const base = scenario({ hands: [[heart(7)], [club(6), club(7)]], table: [heart(8)], turn: 0 });
    if (base.phase.type !== 'round') assert.fail();
    const donorId = id('seat', name);
    let state: GameState = {
      ...base,
      players: base.players.map((player, index) =>
        index === 1 ? { ...player, id: donorId } : player,
      ),
      phase: { ...base.phase, participantIds: [seat(0), donorId] },
    };
    state = actionFrom(state, {
      type: 'play-card',
      id: id('command', `bad-${name}`),
      actorId: seat(0),
      cardId: cardId(state, heart(7)),
    }).after.state;
    const procedure = state.procedure!;
    const selected = cardId(state, club(6));
    const input = actionFrom(state, {
      type: 'penalty-response',
      id: id('command', `give-${name}`),
      actorId: donorId,
      procedureId: procedure.timer.id,
      cardId: selected,
    });
    assert.ok(input.after.state.players[0]!.hand.includes(selected));
    for (const seatId of [seat(0), donorId]) {
      assert.deepEqual(projectAction(input, { type: 'seat', seatId }).observations, [
        {
          type: 'penalty-transfer',
          fromSeatId: donorId,
          toSeatId: seat(0),
          card: state.cards.find((card) => card.id === selected),
        },
      ]);
    }
    assert.deepEqual(projectAction(input, { type: 'public' }).observations, []);
  }
});
