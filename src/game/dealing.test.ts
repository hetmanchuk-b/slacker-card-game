import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAction, decide, validateState } from './engine.ts';
import { id } from './ids.ts';
import type { DecisionContext } from './contracts.ts';
import type { GameState } from './model.ts';

const context: DecisionContext = { nowMs: 1000, randomInt: (upper) => upper - 1 };

function newGame(count: number, creationContext: DecisionContext = context) {
  const seatIds = Array.from({ length: count }, (_, index) => id('seat', `seat-${index}`));
  const decision = decide(
    null,
    {
      type: 'start-game',
      id: id('command', `start-${count}`),
      gameId: id('game', `game-${count}`),
      ownerId: seatIds[0]!,
      seatIds,
      cardIds: Array.from({ length: 36 }, (_, index) => id('card', `opaque-${index}`)),
    },
    creationContext,
  );
  if (decision.type !== 'accepted') throw new Error('Invalid setup');
  return applyAction(null, decision.action);
}

function dealAll(initial: GameState): GameState {
  let state = initial;
  for (let draw = 0; draw < 36; draw++) {
    if (state.phase.type !== 'dealing') throw new Error('Dealing ended too early');
    const result = decide(
      state,
      {
        type: 'draw-card',
        id: id('command', `draw-${draw}`),
        actorId: state.phase.nextSeatId,
      },
      { ...context, nowMs: 1000 + draw },
    );
    if (result.type !== 'accepted') throw new Error(`Draw ${draw} rejected`);
    state = applyAction(state, result.action);
    assert.deepEqual(validateState(state), []);
  }
  return state;
}

test('all supported seat counts deal two separate stump passes and the complete remaining deck', () => {
  const examples = [
    { count: 2, hands: [16, 16], last: 'seat-0' },
    { count: 3, hands: [10, 10, 10], last: 'seat-1' },
    { count: 4, hands: [7, 7, 7, 7], last: 'seat-2' },
    { count: 5, hands: [5, 5, 5, 5, 6], last: 'seat-4' },
    { count: 6, hands: [4, 4, 4, 4, 4, 4], last: 'seat-4' },
    { count: 7, hands: [3, 3, 3, 3, 3, 3, 4], last: 'seat-6' },
    { count: 8, hands: [3, 3, 3, 2, 2, 2, 2, 3], last: 'seat-2' },
  ];
  for (const example of examples) {
    const state = dealAll(newGame(example.count));
    assert.deepEqual(
      state.players.map((player) => player.stumps.length),
      Array(example.count).fill(2),
    );
    assert.deepEqual(
      state.players.map((player) => player.hand.length),
      example.hands,
    );
    assert.deepEqual(state.players.at(-1)!.stumps, ['opaque-0', `opaque-${example.count}`]);
    assert.equal(state.deck.length, 0);
    assert.equal(state.phase.type, 'trump-reveal');
    if (state.phase.type !== 'trump-reveal') throw new Error('Expected reveal');
    assert.equal(state.phase.recipientId, example.last);
    assert.equal(state.phase.cardId, 'opaque-35');
    assert.equal(state.phase.timer.remainingMs, 10000);
    assert.equal(state.phase.timer.startedAtMs, 1035);
    assert.equal(state.trump, null);
    assert.ok(
      state.players.find((player) => player.id === example.last)!.hand.includes(state.phase.cardId),
    );
  }
});

test('the last-card reveal cannot finish early and then selects the last recipient as leader', () => {
  const state = dealAll(newGame(4));
  if (state.phase.type !== 'trump-reveal') throw new Error('Expected reveal');
  const command = {
    type: 'expire-reveal' as const,
    id: id('command', 'reveal-done'),
    timerId: state.phase.timer.id,
  };
  assert.deepEqual(decide(state, command, { ...context, nowMs: 11034 }), {
    type: 'rejected',
    code: 'timer-not-due',
  });
  const result = decide(state, command, { ...context, nowMs: 11035 });
  assert.equal(result.type, 'accepted');
  if (result.type !== 'accepted') return;
  const next = applyAction(state, result.action);
  assert.deepEqual(next.phase, { type: 'between-rounds', leaderId: 'seat-2', nextRoundNumber: 1 });
  assert.deepEqual(next.players, state.players);
  assert.deepEqual(validateState(next), []);
});

test('dealing violations remain pending after the reveal instead of starting play', () => {
  const initial = newGame(4);
  const wrong = decide(
    initial,
    {
      type: 'draw-card',
      id: id('command', 'wrong-first-draw'),
      actorId: id('seat', 'seat-0'),
    },
    context,
  );
  if (wrong.type !== 'accepted') throw new Error('Expected in-game violation');
  const revealed = dealAll(applyAction(initial, wrong.action));
  if (revealed.phase.type !== 'trump-reveal') throw new Error('Expected reveal');
  const result = decide(
    revealed,
    {
      type: 'expire-reveal',
      id: id('command', 'reveal-end'),
      timerId: revealed.phase.timer.id,
    },
    { ...context, nowMs: 11035 },
  );
  if (result.type !== 'accepted') throw new Error('Expected reveal completion');
  const next = applyAction(revealed, result.action);
  assert.deepEqual(next.phase, { type: 'pre-game-penalties', firstLeaderId: 'seat-2' });
  assert.equal(next.pendingPenalties.length, 0);
  assert.equal(next.procedure?.type, 'penalty');
  if (next.procedure?.type === 'penalty')
    assert.equal(next.procedure.penalty.reason, 'draw-out-of-turn');
});

test('multiple dealing punishments are executed sequentially before the first leader is released', () => {
  let state = newGame(4);
  for (const offender of [0, 1]) {
    const result = decide(
      state,
      {
        type: 'draw-card',
        id: id('command', `wrong-${offender}`),
        actorId: id('seat', `seat-${offender}`),
      },
      context,
    );
    if (result.type !== 'accepted') throw new Error('Expected violation');
    state = applyAction(state, result.action);
  }
  state = dealAll(state);
  if (state.phase.type !== 'trump-reveal') throw new Error('Expected reveal');
  const expiry = decide(
    state,
    { type: 'expire-reveal', id: id('command', 'end-reveal'), timerId: state.phase.timer.id },
    { ...context, nowMs: 11035 },
  );
  if (expiry.type !== 'accepted') throw new Error('Expected reveal expiry');
  state = applyAction(state, expiry.action);
  const recipients: string[] = [];
  let responses = 0;
  while (state.procedure?.type === 'penalty') {
    const procedure = state.procedure;
    const recipient = procedure.penalty.recipientId;
    if (!recipients.includes(recipient)) recipients.push(recipient);
    const donor = procedure.eligibleSeatIds.find(
      (seatId) => !Object.hasOwn(procedure.responses, seatId),
    )!;
    const result = decide(
      state,
      {
        type: 'penalty-response',
        id: id('command', `refusal-${responses}`),
        actorId: donor,
        procedureId: procedure.timer.id,
        cardId: null,
      },
      { ...context, nowMs: 11035 + responses++ },
    );
    if (result.type !== 'accepted') throw new Error('Expected refusal');
    state = applyAction(state, result.action);
  }
  assert.deepEqual(recipients, ['seat-0', 'seat-1']);
  assert.equal(responses, 6);
  assert.equal(state.pendingPenalties.length, 0);
  assert.deepEqual(state.phase, { type: 'between-rounds', leaderId: 'seat-2', nextRoundNumber: 1 });
  assert.deepEqual(Object.values(state.repetitions), [1]);
});

test('unknown seats, stale timers and draws outside dealing are technical rejections', () => {
  const initial = newGame(4);
  assert.deepEqual(
    decide(
      null,
      {
        type: 'draw-card',
        id: id('command', 'no-game'),
        actorId: id('seat', 'seat-0'),
      },
      context,
    ),
    { type: 'rejected', code: 'not-started' },
  );
  assert.deepEqual(
    decide(
      initial,
      {
        type: 'draw-card',
        id: id('command', 'outsider'),
        actorId: id('seat', 'outsider'),
      },
      context,
    ),
    { type: 'rejected', code: 'unknown-seat' },
  );
  const state = dealAll(initial);
  assert.deepEqual(
    decide(
      state,
      {
        type: 'draw-card',
        id: id('command', 'late-draw'),
        actorId: id('seat', 'seat-0'),
      },
      { ...context, nowMs: 2000 },
    ),
    { type: 'rejected', code: 'wrong-phase' },
  );
  assert.deepEqual(
    decide(
      state,
      {
        type: 'expire-reveal',
        id: id('command', 'stale-expiry'),
        timerId: id('procedure', 'obsolete'),
      },
      { ...context, nowMs: 20000 },
    ),
    { type: 'rejected', code: 'stale-timer' },
  );
});

test('state validation catches incorrect reveal cards, trump, timers and dealing destinations', () => {
  const state = dealAll(newGame(4));
  if (state.phase.type !== 'trump-reveal') throw new Error('Expected reveal');
  assert.ok(
    validateState({ ...state, phase: { ...state.phase, cardId: state.players[0]!.stumps[0]! } })
      .length > 0,
  );
  assert.ok(validateState({ ...state, trump: 'hearts' }).length > 0);
  assert.ok(
    validateState({
      ...state,
      phase: { ...state.phase, timer: { ...state.phase.timer, remainingMs: -1 } },
    }).length > 0,
  );
  const initial = newGame(4);
  const malformed: GameState = {
    ...initial,
    deck: initial.deck.slice(1),
    phase: { type: 'dealing', nextSeatId: id('seat', 'seat-0'), drawCount: 1 },
    players: initial.players.map((player) =>
      player.id === 'seat-3' ? { ...player, hand: [initial.deck[0]!] } : player,
    ),
  };
  assert.ok(validateState(malformed).length > 0);
});

test('a non-spade final card selects its suit as trump', () => {
  const state = dealAll(
    newGame(4, { ...context, randomInt: (upper) => (upper === 36 ? 26 : upper - 1) }),
  );
  assert.equal(state.trump, 'hearts');
  assert.equal(state.phase.type, 'trump-reveal');
  if (state.phase.type === 'trump-reveal') assert.equal(state.phase.cardId, 'opaque-26');
});

test('the first draw places exactly one face-down stump and advances clockwise', () => {
  const state = newGame(4);
  const before = structuredClone(state);
  const decision = decide(
    state,
    {
      type: 'draw-card',
      id: id('command', 'draw-1'),
      actorId: id('seat', 'seat-3'),
    },
    context,
  );
  assert.equal(decision.type, 'accepted');
  if (decision.type !== 'accepted') return;
  assert.equal(decision.outcome, 'played');
  const next = applyAction(state, decision.action);
  assert.deepEqual(next.players[3]!.stumps, ['opaque-0']);
  assert.equal(next.deck.length, 35);
  assert.deepEqual(next.phase, { type: 'dealing', nextSeatId: 'seat-0', drawCount: 1 });
  assert.deepEqual(next.players[3]!.hand, []);
  assert.deepEqual(state, before);
  assert.deepEqual(validateState(next), []);
});

test('an out-of-turn draw returns the card randomly and defers one penalty without advancing', () => {
  for (const reinsertionIndex of [0, 17, 35]) {
    const state = newGame(4);
    const before = structuredClone(state);
    const decision = decide(
      state,
      {
        type: 'draw-card',
        id: id('command', `wrong-draw-${reinsertionIndex}`),
        actorId: id('seat', 'seat-0'),
      },
      { nowMs: 2000, randomInt: () => reinsertionIndex },
    );
    assert.equal(decision.type, 'accepted');
    if (decision.type !== 'accepted') return;
    assert.equal(decision.outcome, 'violation');
    const next = applyAction(state, decision.action);
    assert.equal(next.deck.length, 36);
    assert.equal(next.deck[reinsertionIndex], 'opaque-0');
    assert.deepEqual(next.phase, before.phase);
    assert.deepEqual(next.players, before.players);
    assert.deepEqual(next.pendingPenalties, [
      {
        incidentId: `wrong-draw-${reinsertionIndex}`,
        recipientId: 'seat-0',
        reason: 'draw-out-of-turn',
      },
    ]);
    assert.deepEqual(validateState(next), []);
    assert.deepEqual(applyAction(state, structuredClone(decision.action)), next);
    assert.deepEqual(state, before);
  }
});
