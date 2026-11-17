import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide } from './engine.ts';
import { id } from './ids.ts';
import { cardId, club, heart, refusePenalty, scenario, seat, step } from './testing/scenarios.ts';
import type { GameState, Vote } from './model.ts';

function accuse(
  state: GameState,
  key = 'episode',
  actor = 0,
  accused = 1,
  nowMs = 1000,
): GameState {
  return step(
    state,
    {
      type: 'submit-claim',
      id: id('command', `claim-${key}`),
      actorId: seat(actor),
      accusedId: seat(accused),
      reason: 'Forbidden name',
      incident: { type: 'spoken', key },
      scope: 'round',
      scopeNumber: 2,
    },
    nowMs,
  );
}

function vote(
  state: GameState,
  actor: number,
  value: Vote,
  label: string,
  nowMs = 1000,
): GameState {
  if (state.procedure?.type !== 'claim-vote') throw new Error('Expected claim vote');
  return step(
    state,
    {
      type: 'cast-vote',
      id: id('command', label),
      actorId: seat(actor),
      procedureId: state.procedure.timer.id,
      vote: value,
    },
    nowMs,
  );
}

const voteExamples: readonly {
  count: number;
  votes: readonly Vote[];
  resolution: string;
  recipient: number | null;
}[] = [
  { count: 2, votes: ['yes'], resolution: 'upheld', recipient: 1 },
  { count: 4, votes: ['yes', 'yes', 'no'], resolution: 'upheld', recipient: 1 },
  { count: 4, votes: ['yes', 'no', 'no'], resolution: 'rejected', recipient: 0 },
  { count: 4, votes: ['yes', 'no', 'abstain'], resolution: 'tied', recipient: null },
  { count: 4, votes: ['abstain', 'abstain', 'abstain'], resolution: 'tied', recipient: null },
  {
    count: 8,
    votes: ['yes', 'yes', 'yes', 'no', 'no', 'abstain', 'abstain'],
    resolution: 'upheld',
    recipient: 1,
  },
];
for (const example of voteExamples) {
  test(`${example.count}-seat vote ${example.votes.join('/')} resolves as ${example.resolution}`, () => {
    const ranks = [6, 7, 8, 9, 10, 11, 12, 13] as const;
    let state = accuse(
      scenario({
        hands: ranks.slice(0, example.count).map((rank) => [heart(rank), club(rank)]),
        table: [heart(14)],
        turn: 0,
      }),
    );
    const eligible = state.players.map((_, index) => index).filter((index) => index !== 1);
    for (const [index, actor] of eligible.entries())
      state = vote(state, actor, example.votes[index]!, `vote-${index}`);
    assert.equal(state.claims[0]!.resolution, example.resolution);
    if (example.recipient === null) {
      assert.equal(state.procedure, null);
      assert.equal(state.pendingPenalties.length, 0);
    } else {
      assert.equal(state.procedure?.type, 'penalty');
      if (state.procedure?.type === 'penalty') {
        assert.equal(state.procedure.penalty.recipientId, seat(example.recipient));
        assert.equal(state.procedure.penalty.reason, 'claim');
      }
    }
  });
}

test('vote timeout abstains for missing responses and a zero-zero tie punishes nobody', () => {
  const state = accuse(round());
  if (state.procedure?.type !== 'claim-vote') throw new Error('Expected vote');
  const command = {
    type: 'expire-claim-vote' as const,
    id: id('command', 'vote-timeout'),
    timerId: state.procedure.timer.id,
  };
  assert.deepEqual(decide(state, command, { nowMs: 10999, randomInt: () => 0 }), {
    type: 'rejected',
    code: 'timer-not-due',
  });
  const next = step(state, command, 11000);
  assert.equal(next.claims[0]!.resolution, 'tied');
  assert.equal(next.procedure, null);
  assert.deepEqual(next.players, state.players);
  assert.deepEqual(next.phase, state.phase);
});

test('a timeout counts actual yes/no votes without treating abstentions as opposition', () => {
  let state = accuse(round());
  state = vote(state, 0, 'yes', 'yes-first', 2000);
  if (state.procedure?.type !== 'claim-vote') throw new Error('Expected vote');
  state = step(
    state,
    {
      type: 'expire-claim-vote',
      id: id('command', 'timeout-after-yes'),
      timerId: state.procedure.timer.id,
    },
    11000,
  );
  assert.equal(state.claims[0]!.resolution, 'upheld');
  if (state.procedure?.type !== 'penalty') throw new Error('Expected penalty');
  assert.equal(state.procedure.penalty.recipientId, seat(1));
});

test('ballots reject excluded voters, stale procedures, repeated responses and expired input', () => {
  let state = accuse(round());
  if (state.procedure?.type !== 'claim-vote') throw new Error('Expected vote');
  const command = {
    type: 'cast-vote' as const,
    id: id('command', 'ballot'),
    actorId: seat(0),
    procedureId: state.procedure.timer.id,
    vote: 'yes' as const,
  };
  assert.deepEqual(
    decide(state, { ...command, actorId: seat(1) }, { nowMs: 1000, randomInt: () => 0 }),
    { type: 'rejected', code: 'not-eligible' },
  );
  assert.deepEqual(
    decide(
      state,
      { ...command, procedureId: id('procedure', 'old') },
      { nowMs: 1000, randomInt: () => 0 },
    ),
    { type: 'rejected', code: 'stale-timer' },
  );
  assert.deepEqual(decide(state, command, { nowMs: 999, randomInt: () => 0 }), {
    type: 'rejected',
    code: 'invalid-time',
  });
  assert.deepEqual(decide(state, command, { nowMs: 11000, randomInt: () => 0 }), {
    type: 'rejected',
    code: 'timer-expired',
  });
  state = step(state, command);
  assert.deepEqual(
    decide(
      state,
      { ...command, id: id('command', 'repeat-ballot') },
      { nowMs: 2000, randomInt: () => 0 },
    ),
    { type: 'rejected', code: 'already-answered' },
  );
});

test('accepted claims are processed FIFO and punishment finishes before the next vote', () => {
  let state = accuse(round(), 'first');
  const firstId = state.claims[0]!.claim.id;
  state = accuse(state, 'second', 2, 3, 1000);
  if (state.procedure?.type !== 'claim-vote') throw new Error('Expected first vote');
  assert.equal(state.procedure.claim.id, firstId);
  state = vote(state, 0, 'yes', 'first-a');
  state = vote(state, 2, 'yes', 'first-c');
  state = vote(state, 3, 'yes', 'first-d');
  assert.equal(state.procedure?.type, 'penalty');
  state = refusePenalty(state, 'first-punishment');
  assert.equal(state.claims[0]!.punishmentStarted, true);
  if (state.procedure?.type !== 'claim-vote') throw new Error('Expected second vote');
  assert.equal(state.procedure.claim.id, state.claims[1]!.claim.id);
  assert.deepEqual(state.procedure.eligibleSeatIds, [seat(0), seat(1), seat(2)]);
  state = step(
    state,
    {
      type: 'expire-claim-vote',
      id: id('command', 'second-timeout'),
      timerId: state.procedure.timer.id,
    },
    11000,
  );
  assert.deepEqual(
    state.claims.map((record) => record.resolution),
    ['upheld', 'tied'],
  );
  assert.equal(state.procedure, null);
});

test('an automatic violation cannot be accused and punished a second time', () => {
  let state = round();
  state = step(state, {
    type: 'play-card',
    id: id('command', 'bad-action'),
    actorId: seat(0),
    cardId: cardId(state, club(6)),
  });
  const command = {
    type: 'submit-claim' as const,
    id: id('command', 'report-again'),
    actorId: seat(2),
    accusedId: seat(0),
    reason: 'Invalid beat',
    incident: { type: 'action' as const, commandId: id('command', 'bad-action') },
    scope: 'round' as const,
    scopeNumber: 2,
  };
  assert.deepEqual(decide(state, command, { nowMs: 1000, randomInt: () => 0 }), {
    type: 'rejected',
    code: 'incident-already-handled',
  });
  state = refusePenalty(state, 'already-punished');
  assert.deepEqual(decide(state, command, { nowMs: 1000, randomInt: () => 0 }), {
    type: 'rejected',
    code: 'incident-already-handled',
  });
});

test('the same chat episode remains closed even if a new claim changes its description', () => {
  let state = round();
  const command = {
    type: 'submit-claim' as const,
    id: id('command', 'chat-report'),
    actorId: seat(0),
    accusedId: seat(1),
    reason: 'Forbidden name',
    incident: { type: 'chat' as const, messageId: 'message-1' },
    scope: 'round' as const,
    scopeNumber: 2,
  };
  state = step(state, command);
  if (state.procedure?.type !== 'claim-vote') throw new Error('Expected vote');
  state = step(
    state,
    { type: 'expire-claim-vote', id: id('command', 'tie'), timerId: state.procedure.timer.id },
    11000,
  );
  assert.deepEqual(
    decide(
      state,
      { ...command, id: id('command', 'renamed-report'), reason: 'Different description' },
      { nowMs: 11000, randomInt: () => 0 },
    ),
    { type: 'rejected', code: 'incident-already-handled' },
  );
});

test('a participant without cards can still accuse and vote before the round ends', () => {
  let state = accuse(
    scenario({ hands: [[], [heart(9), club(6)], [club(7)]], table: [heart(8)], turn: 1 }),
  );
  state = vote(state, 0, 'yes', 'empty-hand-vote');
  state = vote(state, 2, 'yes', 'other-vote');
  assert.equal(state.players[0]!.status, 'active');
  assert.equal(state.claims[0]!.resolution, 'upheld');
});

test('claim-before-final-play pauses the round, while claim-after-final-play is too late', () => {
  let initial = scenario({ hands: [[heart(8)], [heart(9)]] });
  initial = step(initial, {
    type: 'play-card',
    id: id('command', 'initial-lead'),
    actorId: seat(0),
    cardId: cardId(initial, heart(8)),
  });
  const beforeLastCard = initial;
  let claimed = accuse(beforeLastCard, 'before-last');
  const lastPlay = {
    type: 'play-card' as const,
    id: id('command', 'last-card'),
    actorId: seat(1),
    cardId: cardId(initial, heart(9)),
  };
  assert.deepEqual(decide(claimed, lastPlay, { nowMs: 1000, randomInt: () => 0 }), {
    type: 'rejected',
    code: 'procedure-active',
  });
  claimed = vote(claimed, 0, 'yes', 'only-vote');
  claimed = refusePenalty(claimed, 'no-cards-to-give');
  claimed = step(claimed, lastPlay);
  assert.deepEqual(claimed.phase, { type: 'finished', result: { type: 'all-won' } });
  const finishedFirst = step(beforeLastCard, lastPlay);
  const late = decide(
    finishedFirst,
    {
      type: 'submit-claim',
      id: id('command', 'late-claim'),
      actorId: seat(0),
      accusedId: seat(1),
      reason: 'Late episode',
      incident: { type: 'spoken', key: 'after-last' },
      scope: 'round',
      scopeNumber: 2,
    },
    { nowMs: 1000, randomInt: () => 0 },
  );
  assert.equal(late.type, 'rejected');
  assert.equal(finishedFirst.claims.length, 0);
});

test('invalid, backdated and reused claim submissions cannot corrupt the claim ledger', () => {
  const initial = round();
  const command = {
    type: 'submit-claim' as const,
    id: id('command', 'claim-input'),
    actorId: seat(0),
    accusedId: seat(1),
    reason: 'House rule',
    incident: { type: 'spoken' as const, key: 'input-episode' },
    scope: 'round' as const,
    scopeNumber: 2,
  };
  const context = { nowMs: 1000, randomInt: () => 0 };
  assert.deepEqual(decide(initial, { ...command, accusedId: seat(7) }, context), {
    type: 'rejected',
    code: 'unknown-seat',
  });
  assert.deepEqual(decide(initial, { ...command, reason: '   ' }, context), {
    type: 'rejected',
    code: 'invalid-claim',
  });
  assert.deepEqual(
    decide(initial, { ...command, incident: { type: 'spoken', key: '' } }, context),
    { type: 'rejected', code: 'invalid-claim' },
  );
  assert.deepEqual(decide(initial, { ...command, scopeNumber: 99 }, context), {
    type: 'rejected',
    code: 'scope-closed',
  });
  const state = step(initial, command);
  assert.deepEqual(
    decide(
      state,
      {
        ...command,
        id: id('command', 'backdated'),
        incident: { type: 'spoken', key: 'different-episode' },
      },
      { ...context, nowMs: 999 },
    ),
    { type: 'rejected', code: 'invalid-time' },
  );
  assert.deepEqual(
    decide(state, { ...command, incident: { type: 'spoken', key: 'another-episode' } }, context),
    { type: 'rejected', code: 'incident-already-handled' },
  );
});

function round() {
  return scenario({
    hands: [[heart(9), club(6)], [heart(10), club(7)], [club(8)], [club(9)]],
    table: [heart(8)],
    turn: 0,
  });
}

test('a spoken-rule claim pauses play and starts voting by every participant except the accused', () => {
  const before = round();
  const state = step(before, {
    type: 'submit-claim',
    id: id('command', 'claim-1'),
    actorId: seat(0),
    accusedId: seat(1),
    reason: 'Used a forbidden name',
    incident: { type: 'spoken', key: 'episode-1' },
    scope: 'round',
    scopeNumber: 2,
  });
  assert.deepEqual(state.players, before.players);
  assert.deepEqual(state.table, before.table);
  assert.deepEqual(state.phase, before.phase);
  assert.equal(state.claims.length, 1);
  assert.equal(state.procedure?.type, 'claim-vote');
  if (state.procedure?.type !== 'claim-vote') return;
  assert.deepEqual(state.procedure.eligibleSeatIds, [seat(0), seat(2), seat(3)]);
  assert.equal(state.procedure.timer.remainingMs, 10000);
  assert.deepEqual(state.procedure.votes, {});
  assert.deepEqual(
    decide(
      state,
      {
        type: 'play-card',
        id: id('command', 'blocked-play'),
        actorId: seat(0),
        cardId: cardId(state, heart(9)),
      },
      { nowMs: 1001, randomInt: () => 0 },
    ),
    { type: 'rejected', code: 'procedure-active' },
  );
});
