import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAction, decide } from './engine.ts';
import { id } from './ids.ts';
import { cardId, club, heart, refusePenalty, scenario, seat, step } from './testing/scenarios.ts';
import type { Card } from './cards.ts';
import type { GameState } from './model.ts';

function play(state: GameState, actor: number, card: Card, name: string) {
  return step(state, {
    type: 'play-card',
    id: id('command', name),
    actorId: seat(actor),
    cardId: cardId(state, card),
  });
}
function take(state: GameState, actor: number, name: string) {
  return step(state, { type: 'take-bottom', id: id('command', name), actorId: seat(actor) });
}

test('scenario 2: emptying the table finalizes the empty opponent and ends the game', () => {
  let state = scenario({
    hands: [
      [heart(6), heart(9)],
      [heart(7), heart(8)],
    ],
  });
  state = play(state, 0, heart(6), 'a-6');
  state = play(state, 1, heart(7), 'b-7');
  state = play(state, 1, heart(8), 'b-8');
  assert.equal(state.players[1]!.status, 'active');
  state = take(state, 0, 'a-takes');
  assert.equal(state.players[1]!.status, 'won');
  assert.deepEqual(state.phase, {
    type: 'finished',
    result: { type: 'last-player', loserId: seat(0) },
  });
  assert.deepEqual(state.players[0]!.hand, [cardId(state, heart(9)), cardId(state, heart(8))]);
});

test('scenario 15: both last cards reaching discard means everyone wins, not a draw', () => {
  let state = scenario({ hands: [[heart(8)], [heart(9)]] });
  state = play(state, 0, heart(8), 'a-last');
  state = play(state, 1, heart(9), 'b-last');
  assert.deepEqual(state.phase, { type: 'finished', result: { type: 'all-won' } });
  assert.deepEqual(
    state.players.map((player) => player.status),
    ['won', 'won'],
  );
  assert.equal(state.discard.length, 36);
});

test('scenario 6: eight seats retain target eight, then skip simultaneous winners', () => {
  let state = scenario({
    hands: [
      [heart(6)],
      [heart(7), club(6)],
      [heart(8), club(7)],
      [heart(9), club(8)],
      [heart(10), club(9)],
      [heart(11), club(10)],
      [heart(12), club(11)],
      [heart(13)],
    ],
  });
  const ranks = [6, 7, 8, 9, 10, 11, 12, 13] as const;
  for (let index = 0; index < ranks.length; index++) {
    state = play(state, index, heart(ranks[index]!), `eight-${index}`);
    if (index < 7) {
      assert.equal(state.phase.type, 'round');
      if (state.phase.type === 'round') assert.equal(state.phase.targetSize, 8);
      assert.equal(state.players[0]!.status, 'active');
    }
  }
  assert.equal(state.players[0]!.status, 'won');
  assert.equal(state.players[7]!.status, 'won');
  assert.deepEqual(state.phase, { type: 'between-rounds', leaderId: seat(1), nextRoundNumber: 3 });
  state = play(state, 1, club(6), 'six-lead');
  assert.equal(state.phase.type, 'round');
  if (state.phase.type === 'round') {
    assert.equal(state.phase.targetSize, 6);
    assert.deepEqual(state.phase.participantIds, [1, 2, 3, 4, 5, 6].map(seat));
  }
});

test('automatic pickups are recorded in the same action and can close a round', () => {
  let state = scenario({ hands: [[heart(10)], [heart(12)], [heart(13)], [club(7), club(8)]] });
  state = play(state, 0, heart(10), 'a-last');
  state = play(state, 1, heart(12), 'b-last');
  state = play(state, 2, heart(13), 'c-last');
  const beforeOccurrences = Object.values(state.repetitions).reduce((sum, count) => sum + count, 0);
  state = take(state, 3, 'd-takes');
  const afterOccurrences = Object.values(state.repetitions).reduce((sum, count) => sum + count, 0);
  assert.equal(
    afterOccurrences - beforeOccurrences,
    1,
    'Only the settled state after the pickup chain is counted',
  );
  assert.deepEqual(state.table, []);
  assert.deepEqual(state.players[0]!.hand, [cardId(state, heart(12))]);
  assert.deepEqual(state.players[1]!.hand, [cardId(state, heart(13))]);
  assert.equal(state.players[2]!.status, 'won');
  assert.deepEqual(state.phase, { type: 'between-rounds', leaderId: seat(3), nextRoundNumber: 3 });
});

test('out-of-turn play is punishable but forged ownership is a technical rejection', () => {
  let state = scenario({
    hands: [
      [heart(8), club(7)],
      [heart(9), club(8)],
      [heart(10), club(9)],
    ],
  });
  const before = structuredClone(state);
  state = play(state, 1, heart(9), 'out-of-turn');
  assert.deepEqual(state.phase, before.phase);
  assert.deepEqual(state.players, before.players);
  assert.deepEqual(state.table, []);
  if (state.procedure?.type !== 'penalty') throw new Error('Expected penalty');
  assert.equal(state.procedure.penalty.reason, 'play-out-of-turn');
  state = refusePenalty(state, 'no-contributions');
  assert.deepEqual(
    decide(
      state,
      {
        type: 'play-card',
        id: id('command', 'forged'),
        actorId: seat(0),
        cardId: cardId(state, heart(9)),
      },
      { nowMs: 1000, randomInt: () => 0 },
    ),
    { type: 'rejected', code: 'card-not-owned' },
  );
  state = play(state, 0, heart(8), 'correct-turn');
  assert.deepEqual(faces(state), [heart(8)]);
});

function faces(state: GameState) {
  return state.table.map((card) => state.cards.find((item) => item.id === card)!.face);
}

test('scenario 4: four participants can take six turns before four cards reach discard', () => {
  let state = scenario({
    hands: [
      [heart(10), heart(6), club(7)],
      [heart(12), heart(9), club(8)],
      [club(9), club(10)],
      [heart(14), club(11)],
    ],
  });
  state = play(state, 0, heart(10), 'a-10');
  assert.deepEqual(faces(state), [heart(10)]);
  assert.deepEqual(state.phase, {
    type: 'round',
    number: 2,
    participantIds: [seat(0), seat(1), seat(2), seat(3)],
    targetSize: 4,
    turnSeatId: seat(1),
  });
  state = play(state, 1, heart(12), 'b-q');
  state = take(state, 2, 'c-take');
  assert.deepEqual(faces(state), [heart(12)]);
  assert.ok(state.players[2]!.hand.includes(cardId(state, heart(10))));
  state = play(state, 3, heart(14), 'd-a');
  state = play(state, 0, heart(6), 'a-6');
  assert.deepEqual(faces(state), [heart(12), heart(14), heart(6)]);
  state = play(state, 1, heart(9), 'b-9');
  assert.deepEqual(state.table, []);
  assert.deepEqual(state.phase, { type: 'between-rounds', leaderId: seat(1), nextRoundNumber: 3 });
  for (const rank of [12, 14, 6, 9] as const)
    assert.ok(state.discard.includes(cardId(state, heart(rank))));
  assert.equal(state.completedRounds, 2);
});

test('scenario 5: an empty participant automatically takes the bottom instead of being skipped', () => {
  let state = scenario({
    hands: [[heart(10)], [heart(12), club(8)], [club(9)], [heart(14), club(11)]],
  });
  state = play(state, 0, heart(10), 'a-10');
  assert.equal(state.players[0]!.status, 'active');
  state = play(state, 1, heart(12), 'b-q');
  state = take(state, 2, 'c-take');
  const decision = decide(
    state,
    {
      type: 'play-card',
      id: id('command', 'd-a'),
      actorId: seat(3),
      cardId: cardId(state, heart(14)),
    },
    { nowMs: 1000, randomInt: (upper) => upper - 1 },
  );
  assert.equal(decision.type, 'accepted');
  if (decision.type !== 'accepted') return;
  assert.deepEqual(
    decision.action.events.map((item) => item.event.type),
    ['card-played', 'bottom-taken', 'repetition-checked'],
  );
  const next = applyAction(state, decision.action);
  assert.deepEqual(faces(next), [heart(14)]);
  assert.deepEqual(next.players[0]!.hand, [cardId(next, heart(12))]);
  assert.equal(next.players[0]!.status, 'active');
  assert.equal(next.phase.type, 'round');
  if (next.phase.type === 'round') {
    assert.equal(next.phase.turnSeatId, seat(1));
    assert.equal(next.phase.targetSize, 4);
  }
});
