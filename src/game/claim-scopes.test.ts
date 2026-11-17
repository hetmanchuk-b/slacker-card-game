import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAction, decide } from './engine.ts';
import { id } from './ids.ts';
import { cardId, club, heart, refusePenalty, scenario, seat, step } from './testing/scenarios.ts';
import type { GameState } from './model.ts';

function dealing(): GameState {
  const created = decide(
    null,
    {
      type: 'start-game',
      id: id('command', 'start'),
      gameId: id('game', 'scopes'),
      ownerId: seat(0),
      seatIds: [0, 1, 2, 3].map(seat),
      cardIds: Array.from({ length: 36 }, (_, index) => id('card', `opaque-${index}`)),
    },
    { nowMs: 0, randomInt: (upper) => upper - 1 },
  );
  if (created.type !== 'accepted') throw new Error('Creation rejected');
  return applyAction(null, created.action);
}

function dealAll(initial: GameState): GameState {
  let state = initial;
  for (let draw = 0; state.phase.type === 'dealing'; draw++)
    state = step(state, {
      type: 'draw-card',
      id: id('command', `draw-${draw}`),
      actorId: state.phase.nextSeatId,
    });
  return state;
}

function dealingClaim(state: GameState, label: string, nowMs = 1000): GameState {
  return step(
    state,
    {
      type: 'submit-claim',
      id: id('command', label),
      actorId: seat(0),
      accusedId: seat(1),
      reason: 'Spoken house rule',
      incident: { type: 'spoken', key: label },
      scope: 'dealing',
      scopeNumber: 0,
    },
    nowMs,
  );
}

test('dealing claims vote immediately but execute punishment only before the first round', () => {
  let state = dealingClaim(dealing(), 'deal-incident');
  if (state.procedure?.type !== 'claim-vote') throw new Error('Expected dealing vote');
  const procedureId = state.procedure.timer.id;
  for (const actor of [0, 2, 3])
    state = step(state, {
      type: 'cast-vote',
      id: id('command', `yes-${actor}`),
      actorId: seat(actor),
      procedureId,
      vote: 'yes',
    });
  assert.equal(state.phase.type, 'dealing');
  assert.equal(state.procedure, null);
  assert.equal(state.pendingPenalties.length, 1);
  assert.equal(state.claims[0]!.punishmentStarted, false);
  state = dealAll(state);
  if (state.phase.type !== 'trump-reveal') throw new Error('Expected reveal');
  state = step(
    state,
    { type: 'expire-reveal', id: id('command', 'reveal-ended'), timerId: state.phase.timer.id },
    11000,
  );
  if (state.procedure?.type !== 'penalty') throw new Error('Expected deferred punishment');
  assert.equal(state.procedure.penalty.recipientId, seat(1));
  assert.equal(state.claims[0]!.punishmentStarted, true);
  state = refusePenalty(state, 'deal-refusals', 11000);
  assert.deepEqual(state.phase, { type: 'between-rounds', leaderId: seat(2), nextRoundNumber: 1 });
});

test('a decided but not yet started dealing punishment can be withdrawn unanimously', () => {
  let state = dealingClaim(dealing(), 'withdraw-deferred');
  if (state.procedure?.type !== 'claim-vote') throw new Error('Expected vote');
  const voteId = state.procedure.timer.id;
  for (const actor of [0, 2, 3])
    state = step(state, {
      type: 'cast-vote',
      id: id('command', `yes-${actor}`),
      actorId: seat(actor),
      procedureId: voteId,
      vote: 'yes',
    });
  state = step(
    state,
    {
      type: 'request-withdrawal',
      id: id('command', 'withdraw-verdict'),
      actorId: seat(0),
      claimId: state.claims[0]!.claim.id,
    },
    2000,
  );
  if (state.procedure?.type !== 'withdrawal')
    throw new Error('Expected withdrawal before punishment');
  assert.equal(state.procedure.suspendedVote, null);
  const withdrawalId = state.procedure.timer.id;
  for (const actor of [1, 2, 3])
    state = step(
      state,
      {
        type: 'withdrawal-response',
        id: id('command', `consent-${actor}`),
        actorId: seat(actor),
        procedureId: withdrawalId,
        approve: true,
      },
      3000,
    );
  assert.equal(state.claims[0]!.resolution, 'withdrawn');
  assert.equal(state.claims[0]!.punishmentStarted, false);
  assert.equal(state.pendingPenalties.length, 0);
  assert.equal(state.phase.type, 'dealing');
});

test('a queued withdrawal is considered before its deferred punishment can start', () => {
  let state = dealing();
  for (const label of ['first', 'second']) {
    state = dealingClaim(state, label);
    if (state.procedure?.type !== 'claim-vote') throw new Error('Expected vote');
    const procedureId = state.procedure.timer.id;
    for (const actor of [0, 2, 3])
      state = step(state, {
        type: 'cast-vote',
        id: id('command', `${label}-yes-${actor}`),
        actorId: seat(actor),
        procedureId,
        vote: 'yes',
      });
  }
  state = dealAll(state);
  if (state.phase.type !== 'trump-reveal') throw new Error('Expected reveal');
  state = step(
    state,
    { type: 'expire-reveal', id: id('command', 'reveal-ended'), timerId: state.phase.timer.id },
    11000,
  );
  state = step(
    state,
    {
      type: 'request-withdrawal',
      id: id('command', 'withdraw-second'),
      actorId: seat(0),
      claimId: state.claims[1]!.claim.id,
    },
    11100,
  );
  assert.equal(state.procedure?.type, 'penalty', 'The first punishment is not interrupted');
  state = refusePenalty(state, 'finish-first', 11100);
  if (state.procedure?.type !== 'withdrawal')
    throw new Error('Expected withdrawal before second punishment');
  const procedureId = state.procedure.timer.id;
  for (const actor of [1, 2, 3])
    state = step(
      state,
      {
        type: 'withdrawal-response',
        id: id('command', `approve-second-${actor}`),
        actorId: seat(actor),
        procedureId,
        approve: true,
      },
      11200,
    );
  assert.deepEqual(
    state.claims.map((record) => [record.resolution, record.punishmentStarted]),
    [
      ['upheld', true],
      ['withdrawn', false],
    ],
  );
  assert.equal(state.pendingPenalties.length, 0);
  assert.equal(state.procedure, null);
  assert.deepEqual(state.phase, { type: 'between-rounds', leaderId: seat(2), nextRoundNumber: 1 });
});

test('claims carrying a closed round or between-round scope are rejected', () => {
  let state = scenario({
    hands: [
      [heart(8), club(6)],
      [heart(9), club(7)],
    ],
    table: [heart(7)],
    turn: 0,
  });
  state = step(state, {
    type: 'play-card',
    id: id('command', 'end-round'),
    actorId: seat(0),
    cardId: cardId(state, heart(8)),
  });
  const command = {
    type: 'submit-claim' as const,
    id: id('command', 'late'),
    actorId: seat(0),
    accusedId: seat(1),
    reason: 'Old incident',
    incident: { type: 'spoken' as const, key: 'old-round' },
    scope: 'round' as const,
    scopeNumber: 2,
  };
  assert.deepEqual(decide(state, command, { nowMs: 1000, randomInt: () => 0 }), {
    type: 'rejected',
    code: 'scope-closed',
  });
  state = step(state, {
    ...command,
    id: id('command', 'between'),
    incident: { type: 'spoken', key: 'between-episode' },
    scope: 'between-rounds',
    scopeNumber: 2,
  });
  if (state.procedure?.type !== 'claim-vote') throw new Error('Expected between-round vote');
  state = step(
    state,
    {
      type: 'expire-claim-vote',
      id: id('command', 'between-tie'),
      timerId: state.procedure.timer.id,
    },
    11000,
  );
  state = step(
    state,
    {
      type: 'play-card',
      id: id('command', 'new-round'),
      actorId: seat(0),
      cardId: cardId(state, club(6)),
    },
    11000,
  );
  assert.deepEqual(
    decide(state, { ...command, scope: 'between-rounds' }, { nowMs: 11000, randomInt: () => 0 }),
    { type: 'rejected', code: 'scope-closed' },
  );
  state = step(
    state,
    {
      ...command,
      id: id('command', 'current'),
      incident: { type: 'spoken', key: 'current-round' },
      scopeNumber: 3,
    },
    11000,
  );
  assert.equal(state.procedure?.type, 'claim-vote');
});

test('dealing claims remain admissible until the first lead, but not after it', () => {
  let state = dealAll(dealing());
  if (state.phase.type !== 'trump-reveal') throw new Error('Expected reveal');
  state = step(
    state,
    { type: 'expire-reveal', id: id('command', 'end-reveal'), timerId: state.phase.timer.id },
    11000,
  );
  state = dealingClaim(state, 'just-before-lead', 11000);
  if (state.procedure?.type !== 'claim-vote') throw new Error('Expected late dealing claim');
  state = step(
    state,
    { type: 'expire-claim-vote', id: id('command', 'no-votes'), timerId: state.procedure.timer.id },
    21000,
  );
  const leader = state.players.find((player) => player.id === seat(2))!;
  state = step(
    state,
    {
      type: 'play-card',
      id: id('command', 'first-lead'),
      actorId: leader.id,
      cardId: leader.hand[0]!,
    },
    21000,
  );
  assert.deepEqual(
    decide(
      state,
      {
        type: 'submit-claim',
        id: id('command', 'too-late'),
        actorId: seat(0),
        accusedId: seat(1),
        reason: 'Dealing incident',
        incident: { type: 'spoken', key: 'late-dealing' },
        scope: 'dealing',
        scopeNumber: 0,
      },
      { nowMs: 21000, randomInt: () => 0 },
    ),
    { type: 'rejected', code: 'scope-closed' },
  );
});

test('queued reveal claims keep the same reveal timer frozen until all votes finish', () => {
  let state = dealingClaim(dealAll(dealing()), 'first', 5000);
  state = dealingClaim(state, 'second', 6000);
  if (state.procedure?.type !== 'claim-vote') throw new Error('Expected first vote');
  state = step(
    state,
    {
      type: 'expire-claim-vote',
      id: id('command', 'first-abstention'),
      timerId: state.procedure.timer.id,
    },
    15000,
  );
  if (state.phase.type !== 'trump-reveal' || state.procedure?.type !== 'claim-vote')
    throw new Error('Expected second vote during frozen reveal');
  assert.equal(state.phase.timer.remainingMs, 6000);
  assert.equal(state.phase.timer.startedAtMs, null);
  assert.equal(state.procedure.claim.id, state.claims[1]!.claim.id);
  state = step(
    state,
    {
      type: 'expire-claim-vote',
      id: id('command', 'second-abstention'),
      timerId: state.procedure.timer.id,
    },
    25000,
  );
  if (state.phase.type !== 'trump-reveal') throw new Error('Expected resumed reveal');
  assert.equal(state.phase.timer.remainingMs, 6000);
  assert.equal(state.phase.timer.startedAtMs, 25000);
});

test('a claim suspends the one-time trump reveal and resumes its six remaining seconds', () => {
  let state = dealAll(dealing());
  if (state.phase.type !== 'trump-reveal') throw new Error('Expected reveal');
  const revealId = state.phase.timer.id;
  state = dealingClaim(state, 'during-reveal', 5000);
  if (state.phase.type !== 'trump-reveal' || state.procedure?.type !== 'claim-vote')
    throw new Error('Expected paused reveal with vote');
  assert.equal(state.phase.timer.remainingMs, 6000);
  assert.equal(state.phase.timer.startedAtMs, null);
  state = step(
    state,
    {
      type: 'expire-claim-vote',
      id: id('command', 'abstain-all'),
      timerId: state.procedure.timer.id,
    },
    15000,
  );
  if (state.phase.type !== 'trump-reveal') throw new Error('Expected resumed reveal');
  assert.equal(state.phase.timer.id, revealId);
  assert.equal(state.phase.timer.remainingMs, 6000);
  assert.equal(state.phase.timer.startedAtMs, 15000);
  const expiry = {
    type: 'expire-reveal' as const,
    id: id('command', 'end-reveal'),
    timerId: revealId,
  };
  assert.deepEqual(decide(state, expiry, { nowMs: 20999, randomInt: () => 0 }), {
    type: 'rejected',
    code: 'timer-not-due',
  });
  state = step(state, expiry, 21000);
  assert.deepEqual(state.phase, { type: 'between-rounds', leaderId: seat(2), nextRoundNumber: 1 });
});
