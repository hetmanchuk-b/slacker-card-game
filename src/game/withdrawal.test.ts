import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide } from './engine.ts';
import { id } from './ids.ts';
import { club, heart, scenario, seat, step } from './testing/scenarios.ts';

function voting() {
  const state = scenario({
    hands: [[heart(9), club(6)], [heart(10), club(7)], [club(8)], [club(9)]],
    table: [heart(8)],
    turn: 0,
  });
  return step(state, {
    type: 'submit-claim',
    id: id('command', 'claim'),
    actorId: seat(0),
    accusedId: seat(1),
    reason: 'Forbidden name',
    incident: { type: 'spoken', key: 'episode' },
    scope: 'round',
    scopeNumber: 2,
  });
}

test('denied withdrawal resumes the original ballots with the exact remaining six seconds', () => {
  let state = voting();
  if (state.procedure?.type !== 'claim-vote') throw new Error('Expected vote');
  const voteId = state.procedure.timer.id;
  state = step(
    state,
    {
      type: 'cast-vote',
      id: id('command', 'yes-before-withdrawal'),
      actorId: seat(0),
      procedureId: voteId,
      vote: 'yes',
    },
    2000,
  );
  state = step(
    state,
    {
      type: 'request-withdrawal',
      id: id('command', 'request'),
      actorId: seat(0),
      claimId: state.claims[0]!.claim.id,
    },
    5000,
  );
  if (state.procedure?.type !== 'withdrawal') throw new Error('Expected withdrawal');
  state = step(
    state,
    {
      type: 'withdrawal-response',
      id: id('command', 'refused'),
      actorId: seat(1),
      procedureId: state.procedure.timer.id,
      approve: false,
    },
    6000,
  );
  if (state.procedure?.type !== 'claim-vote') throw new Error('Expected restored vote');
  assert.equal(state.procedure.timer.id, voteId);
  assert.equal(state.procedure.timer.remainingMs, 6000);
  assert.equal(state.procedure.timer.startedAtMs, 6000);
  assert.deepEqual(state.procedure.votes, { [seat(0)]: 'yes' });
  const command = {
    type: 'expire-claim-vote' as const,
    id: id('command', 'expire-resumed'),
    timerId: voteId,
  };
  assert.deepEqual(decide(state, command, { nowMs: 11999, randomInt: () => 0 }), {
    type: 'rejected',
    code: 'timer-not-due',
  });
  state = step(state, command, 12000);
  assert.equal(state.claims[0]!.resolution, 'upheld');
  assert.equal(state.procedure?.type, 'penalty');
});

test('withdrawal timeout is not consent and restores the suspended voting time', () => {
  let state = voting();
  state = step(
    state,
    {
      type: 'request-withdrawal',
      id: id('command', 'request'),
      actorId: seat(0),
      claimId: state.claims[0]!.claim.id,
    },
    5000,
  );
  if (state.procedure?.type !== 'withdrawal') throw new Error('Expected withdrawal');
  const command = {
    type: 'expire-withdrawal' as const,
    id: id('command', 'withdrawal-timeout'),
    timerId: state.procedure.timer.id,
  };
  assert.deepEqual(decide(state, command, { nowMs: 14999, randomInt: () => 0 }), {
    type: 'rejected',
    code: 'timer-not-due',
  });
  state = step(state, command, 15000);
  if (state.procedure?.type !== 'claim-vote') throw new Error('Expected restored vote');
  assert.equal(state.procedure.timer.remainingMs, 6000);
  assert.equal(state.procedure.timer.startedAtMs, 15000);
  assert.equal(state.claims[0]!.withdrawalRequested, false);
});

test('a queued withdrawal waits for the current claim and denial starts its previously unstarted vote', () => {
  let state = voting();
  const firstId = state.claims[0]!.claim.id;
  state = step(
    state,
    {
      type: 'submit-claim',
      id: id('command', 'second-claim'),
      actorId: seat(2),
      accusedId: seat(3),
      reason: 'Another incident',
      incident: { type: 'spoken', key: 'second' },
      scope: 'round',
      scopeNumber: 2,
    },
    2000,
  );
  const secondId = state.claims[1]!.claim.id;
  state = step(
    state,
    {
      type: 'request-withdrawal',
      id: id('command', 'withdraw-queued'),
      actorId: seat(2),
      claimId: secondId,
    },
    3000,
  );
  if (state.procedure?.type !== 'claim-vote') throw new Error('Expected first vote');
  assert.equal(state.procedure.claim.id, firstId);
  state = step(
    state,
    {
      type: 'expire-claim-vote',
      id: id('command', 'first-tie'),
      timerId: state.procedure.timer.id,
    },
    11000,
  );
  if (state.procedure?.type !== 'withdrawal') throw new Error('Expected queued withdrawal');
  assert.equal(state.procedure.claim.id, secondId);
  assert.equal(state.procedure.suspendedVote, null);
  state = step(
    state,
    {
      type: 'withdrawal-response',
      id: id('command', 'deny-queued'),
      actorId: seat(0),
      procedureId: state.procedure.timer.id,
      approve: false,
    },
    12000,
  );
  if (state.procedure?.type !== 'claim-vote') throw new Error('Expected fresh second vote');
  assert.equal(state.procedure.claim.id, secondId);
  assert.equal(state.procedure.timer.remainingMs, 10000);
  assert.equal(state.procedure.timer.startedAtMs, 12000);
});

test('only the claimant requests withdrawal, and a punishment already started cannot be canceled', () => {
  let state = voting();
  const claimId = state.claims[0]!.claim.id;
  const request = {
    type: 'request-withdrawal' as const,
    id: id('command', 'withdraw'),
    actorId: seat(0),
    claimId,
  };
  assert.deepEqual(
    decide(state, { ...request, actorId: seat(2) }, { nowMs: 1000, randomInt: () => 0 }),
    { type: 'rejected', code: 'not-eligible' },
  );
  assert.deepEqual(decide(state, request, { nowMs: 11000, randomInt: () => 0 }), {
    type: 'rejected',
    code: 'timer-expired',
  });
  if (state.procedure?.type !== 'claim-vote') throw new Error('Expected vote');
  const procedureId = state.procedure.timer.id;
  for (const actor of [0, 2, 3])
    state = step(state, {
      type: 'cast-vote',
      id: id('command', `yes-${actor}`),
      actorId: seat(actor),
      procedureId,
      vote: 'yes',
    });
  assert.deepEqual(decide(state, request, { nowMs: 1000, randomInt: () => 0 }), {
    type: 'rejected',
    code: 'punishment-started',
  });
});

test('withdrawal consent excludes the claimant and rejects duplicate, stale and late responses', () => {
  let state = voting();
  state = step(
    state,
    {
      type: 'request-withdrawal',
      id: id('command', 'request'),
      actorId: seat(0),
      claimId: state.claims[0]!.claim.id,
    },
    5000,
  );
  if (state.procedure?.type !== 'withdrawal') throw new Error('Expected withdrawal');
  const command = {
    type: 'withdrawal-response' as const,
    id: id('command', 'consent'),
    actorId: seat(1),
    procedureId: state.procedure.timer.id,
    approve: true,
  };
  assert.deepEqual(
    decide(state, { ...command, actorId: seat(0) }, { nowMs: 6000, randomInt: () => 0 }),
    { type: 'rejected', code: 'not-eligible' },
  );
  assert.deepEqual(
    decide(
      state,
      { ...command, procedureId: id('procedure', 'old') },
      { nowMs: 6000, randomInt: () => 0 },
    ),
    { type: 'rejected', code: 'stale-timer' },
  );
  assert.deepEqual(decide(state, command, { nowMs: 15000, randomInt: () => 0 }), {
    type: 'rejected',
    code: 'timer-expired',
  });
  state = step(state, command, 6000);
  assert.deepEqual(
    decide(
      state,
      { ...command, id: id('command', 'duplicate-consent') },
      { nowMs: 7000, randomInt: () => 0 },
    ),
    { type: 'rejected', code: 'already-answered' },
  );
});

test('unanimous withdrawal includes the accused and closes the incident without punishment', () => {
  let state = voting();
  const claimId = state.claims[0]!.claim.id;
  state = step(
    state,
    { type: 'request-withdrawal', id: id('command', 'withdraw'), actorId: seat(0), claimId },
    5000,
  );
  if (state.procedure?.type !== 'withdrawal') throw new Error('Expected withdrawal');
  assert.deepEqual(state.procedure.eligibleSeatIds, [seat(1), seat(2), seat(3)]);
  assert.equal(state.procedure.suspendedVote?.timer.remainingMs, 6000);
  assert.equal(state.procedure.suspendedVote?.timer.startedAtMs, null);
  assert.equal(state.procedure.timer.remainingMs, 10000);
  const procedureId = state.procedure.timer.id;
  for (const actor of [1, 2, 3])
    state = step(
      state,
      {
        type: 'withdrawal-response',
        id: id('command', `approve-${actor}`),
        actorId: seat(actor),
        procedureId,
        approve: true,
      },
      6000 + actor,
    );
  assert.equal(state.claims[0]!.resolution, 'withdrawn');
  assert.equal(state.procedure, null);
  assert.equal(state.pendingPenalties.length, 0);
  assert.deepEqual(
    decide(
      state,
      {
        type: 'submit-claim',
        id: id('command', 'same-episode-again'),
        actorId: seat(2),
        accusedId: seat(1),
        reason: 'Changed description',
        incident: { type: 'spoken', key: 'episode' },
        scope: 'round',
        scopeNumber: 2,
      },
      { nowMs: 7000, randomInt: () => 0 },
    ),
    { type: 'rejected', code: 'incident-already-handled' },
  );
});
