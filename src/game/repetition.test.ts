import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id } from './ids.ts';
import { cardId, club, heart, refusePenalty, scenario, seat, step } from './testing/scenarios.ts';
import type { GameState } from './model.ts';

function cycle(initial: GameState, label: string, startMs = 2000): GameState {
  let state = initial;
  const moves = [
    [0, heart(8), 1],
    [2, heart(9), 0],
    [1, heart(8), 2],
    [0, heart(9), 1],
    [2, heart(8), 0],
    [1, heart(9), 2],
  ] as const;
  for (const [index, [actor, card, taker]] of moves.entries()) {
    state = step(
      state,
      {
        type: 'play-card',
        id: id('command', `${label}-lead-${index}`),
        actorId: seat(actor),
        cardId: cardId(state, card),
      },
      startMs + index,
    );
    state = step(
      state,
      { type: 'take-bottom', id: id('command', `${label}-take-${index}`), actorId: seat(taker) },
      startMs + index,
    );
  }
  return state;
}

test('scenario 16: the third equal boundary draws after twelve rounds despite new IDs and hand order', () => {
  let state = scenario({
    hands: [[heart(8), club(6)], [club(7)], [club(9)]],
    table: [heart(9)],
    turn: 2,
  });
  state = step(state, {
    type: 'take-bottom',
    id: id('command', 'initial-boundary'),
    actorId: seat(2),
  });
  state = cycle(state, 'cycle-1');
  assert.equal(state.phase.type, 'between-rounds');
  assert.equal(Math.max(...Object.values(state.repetitions)), 2);
  state = cycle(state, 'cycle-2', 3000);
  assert.deepEqual(state.phase, {
    type: 'finished',
    result: { type: 'draw', remainingSeatIds: [seat(0), seat(1), seat(2)] },
  });
  assert.equal(Math.max(...Object.values(state.repetitions)), 3);
  assert.equal(state.completedRounds, 14);
});

test('D001: the third equal in-round state draws without emptying or discarding the table', () => {
  let state = scenario({
    hands: [[heart(6), club(6)], [club(7)], [heart(14), heart(7), club(8)]],
    leader: 2,
  });
  state = step(state, {
    type: 'play-card',
    id: id('command', 'initial-ace'),
    actorId: seat(2),
    cardId: cardId(state, heart(14)),
  });
  const initial = structuredClone(state);
  for (let cycleIndex = 0; cycleIndex < 2; cycleIndex++) {
    const moves = [
      [0, heart(6)],
      [2, heart(7)],
      [1, heart(14)],
    ] as const;
    const takers = [1, 0, 2];
    for (const [index, [actor, card]] of moves.entries()) {
      state = step(state, {
        type: 'play-card',
        id: id('command', `in-round-${cycleIndex}-play-${index}`),
        actorId: seat(actor),
        cardId: cardId(state, card),
      });
      state = step(state, {
        type: 'take-bottom',
        id: id('command', `in-round-${cycleIndex}-take-${index}`),
        actorId: seat(takers[index]!),
      });
    }
  }
  assert.deepEqual(state.phase, {
    type: 'finished',
    result: { type: 'draw', remainingSeatIds: [seat(0), seat(1), seat(2)] },
  });
  assert.deepEqual(state.table, initial.table);
  assert.deepEqual(state.discard, initial.discard);
  assert.deepEqual(
    state.players.map((player) => [...player.hand].sort()),
    initial.players.map((player) => [...player.hand].sort()),
  );
  assert.equal(state.completedRounds, initial.completedRounds);
  assert.equal(Math.max(...Object.values(state.repetitions)), 3);
});

test('zero-card punishments and their intermediate responses do not count the same unchanged state again', () => {
  let state = scenario({ hands: [[heart(7), club(7)], [club(6), club(9)], [club(8)]] });
  state = step(state, {
    type: 'play-card',
    id: id('command', 'lead'),
    actorId: seat(0),
    cardId: cardId(state, heart(7)),
  });
  const occurrences = structuredClone(state.repetitions);
  for (let attempt = 0; attempt < 3; attempt++) {
    state = step(state, {
      type: 'play-card',
      id: id('command', `bad-${attempt}`),
      actorId: seat(1),
      cardId: cardId(state, club(6)),
    });
    assert.deepEqual(state.repetitions, occurrences);
    state = refusePenalty(state, `refusals-${attempt}`);
    assert.deepEqual(state.repetitions, occurrences);
  }
  assert.equal(state.phase.type, 'round');
});

test('a repetition draw preserves a player who already won', () => {
  let state = scenario({
    hands: [[heart(8), club(6)], [club(7)], [club(9)], []],
    wonSeats: [3],
    table: [heart(9)],
    turn: 2,
  });
  state = step(state, { type: 'take-bottom', id: id('command', 'initial'), actorId: seat(2) });
  state = cycle(state, 'first');
  state = cycle(state, 'second', 3000);
  assert.equal(state.players[3]!.status, 'won');
  assert.deepEqual(state.phase, {
    type: 'finished',
    result: { type: 'draw', remainingSeatIds: [seat(0), seat(1), seat(2)] },
  });
});
