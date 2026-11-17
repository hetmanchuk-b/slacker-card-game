import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide } from './engine.ts';
import { id } from './ids.ts';
import {
  cardId,
  club,
  heart,
  refusePenalty,
  scenario,
  seat,
  spade,
  step,
} from './testing/scenarios.ts';
import type { GameState } from './model.ts';

function invalidBeat(): GameState {
  const state = scenario({
    hands: [[club(10), spade(9)], [heart(7), heart(8)], [club(7)], [heart(9), heart(10)]],
    stumps: [[], [], [spade(6)], []],
    table: [spade(8)],
    turn: 0,
    trump: 'clubs',
  });
  return step(state, {
    type: 'play-card',
    id: id('command', 'bad-beat'),
    actorId: seat(0),
    cardId: cardId(state, club(10)),
  });
}

test('an invalid beat starts an immediate penalty without moving the card or consuming the turn', () => {
  const state = invalidBeat();
  assert.equal(state.procedure?.type, 'penalty');
  if (state.procedure?.type !== 'penalty') return;
  assert.equal(state.procedure.penalty.reason, 'invalid-beat');
  assert.equal(state.procedure.timer.remainingMs, 10000);
  assert.deepEqual(state.procedure.eligibleSeatIds, [seat(1), seat(2), seat(3)]);
  assert.deepEqual(state.table, [cardId(state, spade(8))]);
  assert.ok(state.players[0]!.hand.includes(cardId(state, club(10))));
  assert.equal(state.phase.type, 'round');
  if (state.phase.type === 'round') assert.equal(state.phase.turnSeatId, seat(0));
  assert.deepEqual(
    decide(
      state,
      {
        type: 'play-card',
        id: id('command', 'too-early'),
        actorId: seat(0),
        cardId: cardId(state, spade(9)),
      },
      { nowMs: 1001, randomInt: () => 0 },
    ),
    { type: 'rejected', code: 'procedure-active' },
  );
});

test('optional penalty contributions transfer privately and cannot consume a donor last card', () => {
  let state = invalidBeat();
  if (state.procedure?.type !== 'penalty') throw new Error('Expected penalty');
  const procedureId = state.procedure.timer.id;
  assert.deepEqual(
    decide(
      state,
      {
        type: 'penalty-response',
        id: id('command', 'last-card'),
        actorId: seat(2),
        procedureId,
        cardId: cardId(state, club(7)),
      },
      { nowMs: 1000, randomInt: () => 0 },
    ),
    { type: 'rejected', code: 'last-card-protected' },
  );
  state = step(state, {
    type: 'penalty-response',
    id: id('command', 'b-gives'),
    actorId: seat(1),
    procedureId,
    cardId: cardId(state, heart(7)),
  });
  assert.ok(
    state.players[1]!.hand.includes(cardId(state, heart(7))),
    'Choice is reserved until procedure completes',
  );
  state = step(state, {
    type: 'penalty-response',
    id: id('command', 'c-refuses'),
    actorId: seat(2),
    procedureId,
    cardId: null,
  });
  state = step(state, {
    type: 'penalty-response',
    id: id('command', 'd-refuses'),
    actorId: seat(3),
    procedureId,
    cardId: null,
  });
  assert.equal(state.procedure, null);
  assert.equal(state.pendingPenalties.length, 0);
  assert.equal(state.players[1]!.hand.length, 1);
  assert.ok(state.players[0]!.hand.includes(cardId(state, heart(7))));
  assert.deepEqual(state.players[2]!.hand, [cardId(state, club(7))]);
  assert.equal(state.phase.type, 'round');
  if (state.phase.type === 'round') assert.equal(state.phase.turnSeatId, seat(0));
  state = step(state, {
    type: 'play-card',
    id: id('command', 'retry-valid'),
    actorId: seat(0),
    cardId: cardId(state, spade(9)),
  });
  assert.deepEqual(state.table, [cardId(state, spade(8)), cardId(state, spade(9))]);
});

test('a separate repeated illegal attempt receives a new punishment after the first completes', () => {
  let state = invalidBeat();
  if (state.procedure?.type !== 'penalty') throw new Error('Expected first penalty');
  const firstId = state.procedure.timer.id;
  state = refusePenalty(state, 'first-refusals');
  state = step(state, {
    type: 'play-card',
    id: id('command', 'bad-again'),
    actorId: seat(0),
    cardId: cardId(state, club(10)),
  });
  if (state.procedure?.type !== 'penalty') throw new Error('Expected second penalty');
  assert.notEqual(state.procedure.timer.id, firstId);
  assert.equal(state.procedure.penalty.incidentId, 'bad-again');
  assert.equal(state.procedure.penalty.reason, 'invalid-beat');
  assert.deepEqual(state.table, [cardId(state, spade(8))]);
});

test('penalty responses reject stale, ineligible, repeated and out-of-window input', () => {
  let state = invalidBeat();
  if (state.procedure?.type !== 'penalty') throw new Error('Expected penalty');
  const procedureId = state.procedure.timer.id;
  const command = {
    type: 'penalty-response' as const,
    id: id('command', 'answer'),
    actorId: seat(1),
    procedureId,
    cardId: null,
  };
  const context = { nowMs: 1000, randomInt: () => 0 };
  assert.deepEqual(
    decide(state, { ...command, procedureId: id('procedure', 'obsolete') }, context),
    { type: 'rejected', code: 'stale-timer' },
  );
  assert.deepEqual(decide(state, { ...command, actorId: seat(0) }, context), {
    type: 'rejected',
    code: 'not-eligible',
  });
  assert.deepEqual(decide(state, { ...command, cardId: cardId(state, spade(9)) }, context), {
    type: 'rejected',
    code: 'card-not-owned',
  });
  assert.deepEqual(decide(state, command, { ...context, nowMs: 999 }), {
    type: 'rejected',
    code: 'invalid-time',
  });
  assert.deepEqual(decide(state, command, { ...context, nowMs: 11000 }), {
    type: 'rejected',
    code: 'timer-expired',
  });
  state = step(state, command);
  assert.deepEqual(decide(state, { ...command, id: id('command', 'second-answer') }, context), {
    type: 'rejected',
    code: 'already-answered',
  });
});

test('seat identifiers cannot be confused with inherited object properties', () => {
  const base = scenario({
    hands: [[heart(7)], [club(6), club(7)], [club(8)]],
    table: [heart(8)],
    turn: 0,
  });
  const donorId = id('seat', 'toString');
  if (base.phase.type !== 'round') throw new Error('Expected round');
  let state: GameState = {
    ...base,
    players: base.players.map((player, index) =>
      index === 1 ? { ...player, id: donorId } : player,
    ),
    phase: { ...base.phase, participantIds: [seat(0), donorId, seat(2)] },
  };
  state = step(state, {
    type: 'play-card',
    id: id('command', 'bad-for-special-donor'),
    actorId: seat(0),
    cardId: cardId(state, heart(7)),
  });
  if (state.procedure?.type !== 'penalty') throw new Error('Expected penalty');
  state = step(state, {
    type: 'penalty-response',
    id: id('command', 'special-donor-gives'),
    actorId: donorId,
    procedureId: state.procedure.timer.id,
    cardId: cardId(state, club(6)),
  });
  if (state.procedure?.type !== 'penalty') throw new Error('Expected remaining donor');
  state = step(state, {
    type: 'penalty-response',
    id: id('command', 'other-refuses'),
    actorId: seat(2),
    procedureId: state.procedure.timer.id,
    cardId: null,
  });
  assert.equal(state.procedure, null);
  assert.ok(state.players[0]!.hand.includes(cardId(state, club(6))));
});

test('penalty timeout defaults to refusals and zero received cards still completes punishment', () => {
  const state = invalidBeat();
  if (state.procedure?.type !== 'penalty') throw new Error('Expected penalty');
  const command = {
    type: 'expire-penalty' as const,
    id: id('command', 'penalty-timeout'),
    timerId: state.procedure.timer.id,
  };
  assert.deepEqual(decide(state, command, { nowMs: 10999, randomInt: () => 0 }), {
    type: 'rejected',
    code: 'timer-not-due',
  });
  const next = step(state, command, 11000);
  assert.equal(next.procedure, null);
  assert.deepEqual(next.players, state.players);
  assert.deepEqual(next.table, state.table);
  assert.deepEqual(next.phase, state.phase);
});
