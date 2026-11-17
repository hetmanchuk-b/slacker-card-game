import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateState } from './engine.ts';
import { id } from './ids.ts';
import { cardId, club, heart, scenario, seat, step } from './testing/scenarios.ts';

test('round validation checks frozen target, participants, turn and round number', () => {
  const state = scenario({
    hands: [[heart(9)], [heart(10)], [club(6)]],
    table: [heart(8)],
    turn: 0,
  });
  if (state.phase.type !== 'round') throw new Error('Expected round');
  assert.ok(
    validateState({ ...state, phase: { ...state.phase, targetSize: 2 } }).includes(
      'Round target disagrees with participants',
    ),
  );
  assert.ok(
    validateState({ ...state, phase: { ...state.phase, turnSeatId: seat(7) } }).includes(
      'Unknown round turn',
    ),
  );
  assert.ok(
    validateState({
      ...state,
      phase: { ...state.phase, participantIds: [seat(0), seat(0), seat(2)] },
    }).includes('Round participants disagree with active seats'),
  );
  assert.ok(
    validateState({ ...state, phase: { ...state.phase, number: 99 } }).includes(
      'Invalid active round number',
    ),
  );
});

test('opening rights and private peek records must refer to real owned seats/cards', () => {
  const state = scenario({
    hands: [[heart(9)], [heart(10)]],
    stumps: [[club(6)], []],
    openingSeats: [0],
  });
  assert.ok(
    validateState({ ...state, openingRights: [{ seatId: seat(0), throughRound: 1 }] }).includes(
      'Expired or invalid opening right',
    ),
  );
  assert.ok(
    validateState({ ...state, openingRights: [{ seatId: seat(1), throughRound: 2 }] }).includes(
      'Opening right without an active stump owner',
    ),
  );
  assert.ok(
    validateState({
      ...state,
      peekedStumps: [{ seatId: seat(7), cardId: cardId(state, club(6)) }],
    }).includes('Unknown private peek seat/card'),
  );
});

test('finished results must agree with actual remaining participants', () => {
  const state = scenario({ hands: [[heart(9)], [heart(10)]] });
  assert.ok(
    validateState({ ...state, phase: { type: 'finished', result: { type: 'all-won' } } }).includes(
      'All-won result still has participants',
    ),
  );
  assert.ok(
    validateState({
      ...state,
      phase: { type: 'finished', result: { type: 'last-player', loserId: seat(0) } },
    }).includes('Last-player result disagrees with participants'),
  );
  assert.ok(
    validateState({
      ...state,
      phase: { type: 'finished', result: { type: 'draw', remainingSeatIds: [seat(0)] } },
    }).includes('Draw result disagrees with participants'),
  );
});

test('claim invariants validate voters, records, ballot eligibility and incident uniqueness', () => {
  const state = step(
    scenario({ hands: [[heart(9)], [heart(10)], [club(6)]], table: [heart(8)], turn: 0 }),
    {
      type: 'submit-claim',
      id: id('command', 'claim'),
      actorId: seat(0),
      accusedId: seat(1),
      reason: 'House rule',
      incident: { type: 'spoken', key: 'episode' },
      scope: 'round',
      scopeNumber: 2,
    },
  );
  if (state.procedure?.type !== 'claim-vote') throw new Error('Expected vote');
  assert.ok(
    validateState({
      ...state,
      procedure: { ...state.procedure, eligibleSeatIds: [seat(0), seat(1)] },
    }).includes('Invalid claim voters'),
  );
  assert.ok(
    validateState({
      ...state,
      procedure: { ...state.procedure, votes: { [seat(1)]: 'yes' } },
    }).includes('Invalid claim ballot'),
  );
  assert.ok(
    validateState({ ...state, claims: [] }).includes('Claim procedure has no pending record'),
  );
  assert.ok(
    validateState({
      ...state,
      claims: [
        ...state.claims,
        {
          ...state.claims[0]!,
          claim: { ...state.claims[0]!.claim, id: id('claim', 'different-id') },
        },
      ],
    }).includes('Duplicate claim incident'),
  );
  assert.ok(
    validateState({
      ...state,
      claims: [{ ...state.claims[0]!, punishmentStarted: true }],
    }).includes('Invalid claim punishment status'),
  );
});

test('withdrawal invariants keep the accused eligible and the suspended ballot timer stopped', () => {
  let state = step(
    scenario({ hands: [[heart(9)], [heart(10)], [club(6)]], table: [heart(8)], turn: 0 }),
    {
      type: 'submit-claim',
      id: id('command', 'claim'),
      actorId: seat(0),
      accusedId: seat(1),
      reason: 'House rule',
      incident: { type: 'spoken', key: 'episode' },
      scope: 'round',
      scopeNumber: 2,
    },
  );
  state = step(
    state,
    {
      type: 'request-withdrawal',
      id: id('command', 'withdraw'),
      actorId: seat(0),
      claimId: state.claims[0]!.claim.id,
    },
    5000,
  );
  if (state.procedure?.type !== 'withdrawal' || state.procedure.suspendedVote === null)
    throw new Error('Expected suspended vote');
  assert.ok(
    validateState({
      ...state,
      procedure: { ...state.procedure, eligibleSeatIds: [seat(0), seat(2)] },
    }).includes('Invalid withdrawal approvers'),
  );
  assert.ok(
    validateState({
      ...state,
      procedure: {
        ...state.procedure,
        suspendedVote: {
          ...state.procedure.suspendedVote,
          timer: { ...state.procedure.suspendedVote.timer, startedAtMs: 5000 },
        },
      },
    }).includes('Suspended claim timer is running'),
  );
});

test('penalty validation protects recipients, donor eligibility and reserved contributions', () => {
  let state = scenario({
    hands: [[heart(7)], [club(6)], [club(7), club(8)]],
    table: [heart(8)],
    turn: 0,
  });
  state = step(state, {
    type: 'play-card',
    id: id('command', 'invalid-beat'),
    actorId: seat(0),
    cardId: cardId(state, heart(7)),
  });
  if (state.procedure?.type !== 'penalty') throw new Error('Expected penalty');
  assert.ok(
    validateState({
      ...state,
      procedure: { ...state.procedure, eligibleSeatIds: [seat(0), seat(1)] },
    }).includes('Invalid penalty donors'),
  );
  assert.ok(
    validateState({
      ...state,
      procedure: { ...state.procedure, responses: { [seat(1)]: cardId(state, club(6)) } },
    }).includes('Invalid reserved penalty card'),
  );
});
