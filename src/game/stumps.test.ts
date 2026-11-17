import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide } from './engine.ts';
import { id } from './ids.ts';
import { cardId, club, heart, refusePenalty, scenario, seat, step } from './testing/scenarios.ts';

test('a round boundary grants one stump opening that can be used during the following round', () => {
  let state = scenario({ hands: [[heart(10)], [heart(12), club(7)]], stumps: [[club(8)], []] });
  state = step(state, {
    type: 'play-card',
    id: id('command', 'a-10'),
    actorId: seat(0),
    cardId: cardId(state, heart(10)),
  });
  state = step(state, {
    type: 'play-card',
    id: id('command', 'b-q'),
    actorId: seat(1),
    cardId: cardId(state, heart(12)),
  });
  assert.deepEqual(state.openingRights, [{ seatId: seat(0), throughRound: 3 }]);
  assert.equal(state.players[0]!.status, 'active');
  state = step(state, {
    type: 'play-card',
    id: id('command', 'b-7'),
    actorId: seat(1),
    cardId: cardId(state, club(7)),
  });
  assert.equal(state.phase.type, 'round');
  state = step(state, {
    type: 'open-stump',
    id: id('command', 'open-a'),
    actorId: seat(0),
    cardId: cardId(state, club(8)),
  });
  assert.deepEqual(state.players[0]!.hand, [cardId(state, club(8))]);
  assert.deepEqual(state.players[0]!.stumps, []);
  assert.deepEqual(state.openingRights, []);
  state = step(state, {
    type: 'play-card',
    id: id('command', 'a-8'),
    actorId: seat(0),
    cardId: cardId(state, club(8)),
  });
  assert.deepEqual(state.phase, { type: 'finished', result: { type: 'all-won' } });
});

test('an entitled stump can be opened outside the owner turn without consuming the turn', () => {
  let state = scenario({
    hands: [[], [heart(8)], [heart(9)]],
    stumps: [[club(7)], [], []],
    openingSeats: [0],
    leader: 1,
  });
  const phase = structuredClone(state.phase);
  state = step(state, {
    type: 'open-stump',
    id: id('command', 'open-outside-turn'),
    actorId: seat(0),
    cardId: cardId(state, club(7)),
  });
  assert.deepEqual(state.phase, phase);
  assert.equal(state.procedure, null);
  assert.deepEqual(state.players[0]!.hand, [cardId(state, club(7))]);
});

test('emptying a hand mid-round does not grant opening and illegal peeking does not move the stump', () => {
  let state = scenario({
    hands: [[heart(10)], [heart(12), club(7)], [club(8)]],
    stumps: [[heart(6)], [], []],
  });
  state = step(state, {
    type: 'play-card',
    id: id('command', 'last-main'),
    actorId: seat(0),
    cardId: cardId(state, heart(10)),
  });
  const before = structuredClone(state);
  state = step(state, {
    type: 'open-stump',
    id: id('command', 'illegal-peek'),
    actorId: seat(0),
    cardId: cardId(state, heart(6)),
  });
  assert.deepEqual(state.players, before.players);
  assert.deepEqual(state.table, before.table);
  assert.deepEqual(state.phase, before.phase);
  assert.deepEqual(state.openingRights, []);
  assert.deepEqual(state.peekedStumps, [{ seatId: seat(0), cardId: cardId(state, heart(6)) }]);
  assert.equal(state.procedure?.type, 'penalty');
  if (state.procedure?.type === 'penalty') assert.equal(state.procedure.penalty.reason, 'peek');
});

test('using one entitlement does not permit opening the second stump in the same round', () => {
  let state = scenario({
    hands: [[], [heart(7), club(8)], [heart(8), club(9)], [heart(9), club(10)]],
    stumps: [[heart(6), club(7)], [], [], []],
    openingSeats: [0],
  });
  state = step(state, {
    type: 'open-stump',
    id: id('command', 'first-stump'),
    actorId: seat(0),
    cardId: cardId(state, heart(6)),
  });
  state = step(state, {
    type: 'play-card',
    id: id('command', 'play-first'),
    actorId: seat(0),
    cardId: cardId(state, heart(6)),
  });
  state = step(state, {
    type: 'open-stump',
    id: id('command', 'peek-second'),
    actorId: seat(0),
    cardId: cardId(state, club(7)),
  });
  assert.equal(state.players[0]!.hand.length, 0);
  assert.deepEqual(state.players[0]!.stumps, [cardId(state, club(7))]);
  assert.equal(state.procedure?.type, 'penalty');
  if (state.procedure?.type === 'penalty') assert.equal(state.procedure.penalty.reason, 'peek');
});

test('a penalty card temporarily obstructs an unused right, which becomes usable again after playing it', () => {
  let state = scenario({
    hands: [[], [heart(7), heart(8)], [club(7)], [club(8)]],
    stumps: [[club(11)], [], [], []],
    table: [club(10)],
    turn: 0,
    openingSeats: [0],
    trump: 'hearts',
  });
  state = step(state, { type: 'take-bottom', id: id('command', 'must-open'), actorId: seat(0) });
  assert.deepEqual(state.table, [cardId(state, club(10))]);
  if (state.procedure?.type !== 'penalty') throw new Error('Expected penalty');
  assert.equal(state.procedure.penalty.reason, 'must-open-stump');
  state = step(state, {
    type: 'penalty-response',
    id: id('command', 'give-heart'),
    actorId: seat(1),
    procedureId: state.procedure.timer.id,
    cardId: cardId(state, heart(7)),
  });
  state = refusePenalty(state, 'refuse-others');
  assert.deepEqual(state.players[0]!.hand, [cardId(state, heart(7))]);
  assert.deepEqual(state.openingRights, [{ seatId: seat(0), throughRound: 2 }]);
  state = step(state, {
    type: 'play-card',
    id: id('command', 'use-penalty-card'),
    actorId: seat(0),
    cardId: cardId(state, heart(7)),
  });
  state = step(state, {
    type: 'open-stump',
    id: id('command', 'use-preserved-right'),
    actorId: seat(0),
    cardId: cardId(state, club(11)),
  });
  assert.deepEqual(state.players[0]!.hand, [cardId(state, club(11))]);
  assert.deepEqual(state.openingRights, []);
  assert.equal(state.procedure, null);
});

test('unused entitlement expires at the boundary when its owner still has hand cards', () => {
  let state = scenario({
    hands: [[club(10)], [heart(9), club(7)], [heart(10), club(8)]],
    stumps: [[club(9)], [], []],
    openingSeats: [0],
    table: [heart(8)],
    turn: 1,
  });
  state = step(state, {
    type: 'play-card',
    id: id('command', 'b-beats'),
    actorId: seat(1),
    cardId: cardId(state, heart(9)),
  });
  state = step(state, {
    type: 'play-card',
    id: id('command', 'c-discards'),
    actorId: seat(2),
    cardId: cardId(state, heart(10)),
  });
  assert.deepEqual(state.openingRights, []);
  state = step(state, {
    type: 'play-card',
    id: id('command', 'c-leads'),
    actorId: seat(2),
    cardId: cardId(state, club(8)),
  });
  state = step(state, {
    type: 'play-card',
    id: id('command', 'a-empties'),
    actorId: seat(0),
    cardId: cardId(state, club(10)),
  });
  state = step(state, {
    type: 'open-stump',
    id: id('command', 'expired-right'),
    actorId: seat(0),
    cardId: cardId(state, club(9)),
  });
  assert.equal(state.players[0]!.hand.length, 0);
  assert.equal(state.procedure?.type, 'penalty');
  if (state.procedure?.type === 'penalty') assert.equal(state.procedure.penalty.reason, 'peek');
});

test('foreign stumps cannot be opened even when their identifier is guessed', () => {
  const state = scenario({ hands: [[heart(8)], [heart(9)]], stumps: [[club(7)], [club(8)]] });
  assert.deepEqual(
    decide(
      state,
      {
        type: 'open-stump',
        id: id('command', 'foreign-stump'),
        actorId: seat(0),
        cardId: cardId(state, club(8)),
      },
      { nowMs: 1000, randomInt: () => 0 },
    ),
    { type: 'rejected', code: 'card-not-owned' },
  );
});
