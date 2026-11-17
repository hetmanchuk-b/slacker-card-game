import assert from 'node:assert/strict';
import { createDeck } from '../cards.ts';
import { applyAction, decide, validateState } from '../engine.ts';
import { id } from '../ids.ts';
import type { Card, Trump } from '../cards.ts';
import type { GameCommand } from '../contracts.ts';
import type { CardId, SeatId } from '../ids.ts';
import type { GameState } from '../model.ts';

export const seat = (index: number): SeatId => id('seat', `seat-${index}`);

/** Explicit late-game checkpoints, not a second implementation of game transitions. */
export function scenario(input: {
  hands: readonly (readonly Card[])[];
  stumps?: readonly (readonly Card[])[];
  leader?: number;
  table?: readonly Card[];
  turn?: number;
  openingSeats?: readonly number[];
  wonSeats?: readonly number[];
  trump?: Trump;
}): GameState {
  const cards = createDeck().map((face, index) => ({ id: id('card', `opaque-${index}`), face }));
  const find = (face: Card): CardId => {
    const card = cards.find((card) => card.face.suit === face.suit && card.face.rank === face.rank);
    if (!card) throw new Error('Unknown fixture face');
    return card.id;
  };
  const players = input.hands.map((hand, index) => ({
    id: seat(index),
    hand: hand.map(find),
    stumps: (input.stumps?.[index] ?? []).map(find),
    status: input.wonSeats?.includes(index) ? ('won' as const) : ('active' as const),
  }));
  const table = (input.table ?? []).map(find);
  const used = [...table, ...players.flatMap((player) => [...player.hand, ...player.stumps])];
  if (new Set(used).size !== used.length) throw new Error('Fixture assigns a card twice');
  const state: GameState = {
    schemaVersion: 1,
    gameId: id('game', 'scenario'),
    ownerId: seat(0),
    createdAtMs: 0,
    cards,
    players,
    deck: [],
    table,
    discard: cards.filter((card) => !used.includes(card.id)).map((card) => card.id),
    trump: input.trump ?? null,
    phase:
      table.length > 0
        ? {
            type: 'round',
            number: 2,
            participantIds: players
              .filter((player) => player.status === 'active')
              .map((player) => player.id),
            targetSize: players.filter((player) => player.status === 'active').length,
            turnSeatId: seat(input.turn ?? 0),
          }
        : { type: 'between-rounds', leaderId: seat(input.leader ?? 0), nextRoundNumber: 2 },
    procedure: null,
    pendingPenalties: [],
    completedRounds: 1,
    openingRights: (input.openingSeats ?? []).map((index) => ({
      seatId: seat(index),
      throughRound: 2,
    })),
    repetitions: {},
    lastRepetitionKey: null,
    peekedStumps: [],
  };
  assert.deepEqual(validateState(state), [], 'Fixture must conserve all 36 cards');
  return state;
}

export function cardId(state: GameState, face: Card): CardId {
  const card = state.cards.find(
    (card) => card.face.suit === face.suit && card.face.rank === face.rank,
  );
  if (!card) throw new Error('Unknown face');
  return card.id;
}

export function step(state: GameState, command: GameCommand, nowMs = 1000): GameState {
  const before = structuredClone(state);
  const decision = decide(state, command, { nowMs, randomInt: (upper) => upper - 1 });
  if (decision.type !== 'accepted') assert.fail(`Rejected: ${decision.code}`);
  const next = applyAction(state, decision.action);
  assert.deepEqual(state, before, 'Commands and replay must not mutate checkpoints');
  assert.deepEqual(validateState(next), []);
  assert.deepEqual(applyAction(state, structuredClone(decision.action)), next);
  return next;
}

export function refusePenalty(initial: GameState, label: string): GameState {
  let state = initial;
  let response = 0;
  while (state.procedure?.type === 'penalty') {
    const procedure = state.procedure;
    const seatId = procedure.eligibleSeatIds.find(
      (seatId) => !Object.hasOwn(procedure.responses, seatId),
    );
    if (!seatId) throw new Error('Expected an unanswered penalty donor');
    state = step(state, {
      type: 'penalty-response',
      id: id('command', `${label}-${response++}`),
      actorId: seatId,
      procedureId: procedure.timer.id,
      cardId: null,
    });
  }
  return state;
}

export const heart = (rank: Card['rank']): Card => ({ suit: 'hearts', rank });
export const club = (rank: Card['rank']): Card => ({ suit: 'clubs', rank });
export const spade = (rank: Card['rank']): Card => ({ suit: 'spades', rank });
