import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAction, decide, validateState } from './engine.ts';
import { id } from './ids.ts';
import type { CardId } from './ids.ts';
import type { DecisionContext, DomainEvent, StartGame } from './contracts.ts';

const seats = [id('seat', 'seat-a'), id('seat', 'seat-b')];
const start: StartGame = {
  type: 'start-game',
  id: id('command', 'start-1'),
  gameId: id('game', 'game-1'),
  ownerId: seats[0]!,
  seatIds: seats,
  cardIds: Array.from({ length: 36 }, (_, index) => id('card', `opaque-${index}`)),
};
const context: DecisionContext = { nowMs: 1000, randomInt: (upper) => upper - 1 };

function startedGame() {
  const result = decide(null, start, context);
  assert.equal(result.type, 'accepted');
  if (result.type !== 'accepted') throw new Error('Expected a started game');
  return { state: applyAction(null, result.action), action: result.action };
}

test('starting a game records a complete deck and a random initial recipient for replay', () => {
  const decision = decide(null, start, context);
  assert.equal(decision.type, 'accepted');
  if (decision.type !== 'accepted') return;
  assert.equal(decision.outcome, 'played');
  const state = applyAction(null, decision.action);
  assert.equal(state.gameId, 'game-1');
  assert.equal(state.ownerId, 'seat-a');
  assert.deepEqual(state.phase, { type: 'dealing', nextSeatId: 'seat-b', drawCount: 0 });
  assert.deepEqual(state.deck, start.cardIds);
  assert.equal(state.cards.length, 36);
  assert.deepEqual(
    state.players.map((player) => [player.hand.length, player.stumps.length]),
    [
      [0, 0],
      [0, 0],
    ],
  );
  assert.deepEqual(validateState(state), []);
  assert.deepEqual(applyAction(null, structuredClone(decision.action)), state);
});

test('invalid game configurations are rejected before consuming randomness', () => {
  const invalid: StartGame[] = [
    { ...start, seatIds: [seats[0]!] },
    { ...start, seatIds: Array.from({ length: 9 }, (_, i) => id('seat', `seat-${i}`)) },
    { ...start, seatIds: [seats[0]!, seats[0]!] },
    { ...start, ownerId: id('seat', 'outsider') },
    { ...start, cardIds: start.cardIds.slice(1) },
    { ...start, cardIds: Array.from({ length: 36 }, () => start.cardIds[0]!) },
  ];
  for (const command of invalid) {
    assert.deepEqual(
      decide(null, command, {
        nowMs: 1000,
        randomInt: () => {
          throw new Error('Invalid input must not use randomness');
        },
      }),
      { type: 'rejected', code: 'invalid-configuration' },
    );
  }
});

test('starting again cannot overwrite an existing game', () => {
  const { state } = startedGame();
  const before = structuredClone(state);
  assert.deepEqual(decide(state, start, context), { type: 'rejected', code: 'already-started' });
  assert.deepEqual(state, before);
});

test('decision timestamps and random source contracts are validated', () => {
  for (const nowMs of [-1, NaN, Infinity, 1.5]) {
    assert.deepEqual(decide(null, start, { ...context, nowMs }), {
      type: 'rejected',
      code: 'invalid-time',
    });
  }
  for (const randomInt of [() => -1, () => 0.5, () => NaN, (upper: number) => upper]) {
    assert.throws(() => decide(null, start, { ...context, randomInt }), RangeError);
  }
});

test('replay detects card loss, duplication, unknown cards and corrupt catalogs', () => {
  const { state } = startedGame();
  assert.ok(validateState({ ...state, deck: state.deck.slice(1) }).length > 0);
  assert.ok(validateState({ ...state, table: [state.deck[0]!] }).length > 0);
  assert.ok(
    validateState({ ...state, deck: [id('card', 'unknown'), ...state.deck.slice(1)] }).length > 0,
  );
  assert.ok(
    validateState({ ...state, cards: [state.cards[0]!, ...state.cards.slice(0, -1)] }).length > 0,
  );
});

test('invalid replay envelopes fail without silently accepting unknown events', () => {
  const { state, action } = startedGame();
  const before = structuredClone(state);
  assert.throws(() => applyAction(null, { ...action, occurredAtMs: NaN }));
  assert.throws(() => applyAction(null, { ...action, events: [] }));
  assert.throws(() =>
    applyAction(null, { ...action, events: [action.events[0]!, action.events[0]!] }),
  );
  assert.throws(() =>
    applyAction(state, {
      ...action,
      events: [
        {
          id: id('event', 'unknown-event'),
          event: { type: 'unknown-event' } as unknown as DomainEvent,
        },
      ],
    }),
  );
  assert.deepEqual(state, before);
});

test('a clock earlier than game creation cannot generate an action', () => {
  const { state } = startedGame();
  assert.deepEqual(
    decide(
      state,
      {
        type: 'draw-card',
        id: id('command', 'past-draw'),
        actorId: id('seat', 'seat-b'),
      },
      { ...context, nowMs: 999 },
    ),
    { type: 'rejected', code: 'invalid-time' },
  );
});

test('replay snapshots do not alias recorded events or original creation inputs', () => {
  const { state, action } = startedGame();
  const event = action.events[0]!.event;
  if (event.type !== 'game-started') throw new Error('Expected creation event');
  // Deliberately violate the readonly contract to check ownership of stored arrays.
  (event.deck as CardId[])[0] = id('card', 'different');
  assert.equal(state.deck[0], 'opaque-0');
  assert.equal(event.deck[0], 'different');
  assert.equal(start.cardIds[0], 'opaque-0');
});
