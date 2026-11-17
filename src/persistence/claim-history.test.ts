import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAction, decide } from '../game/engine.ts';
import { id } from '../game/ids.ts';
import { MemoryHistory } from './memory-history.ts';
import type { GameCommand } from '../game/contracts.ts';
import type { GameState } from '../game/model.ts';

test('dealing, withdrawal, false accusation, contribution and queued voting replay as one history', () => {
  const gameId = id('game', 'claim-history');
  const history = new MemoryHistory(gameId, id('branch', 'main'));
  const a = id('seat', 'a');
  const b = id('seat', 'b');
  let clock = 0;
  const cid = (label: string) => id('command', label);
  const state = (): GameState => {
    const current = history.read().state;
    if (current === null) assert.fail('No game');
    return current;
  };
  function run(command: GameCommand) {
    const snapshot = history.read();
    const result = decide(snapshot.state, command, {
      nowMs: clock++,
      randomInt: (upper) => upper - 1,
    });
    if (result.type !== 'accepted') assert.fail(`Rejected history command: ${result.code}`);
    assert.equal(history.append(snapshot.head, result.action).type, 'committed');
  }
  run({
    type: 'start-game',
    id: cid('start'),
    gameId,
    ownerId: a,
    seatIds: [a, b],
    cardIds: Array.from({ length: 36 }, (_, index) => id('card', `opaque-${index}`)),
  });
  for (let draw = 0; draw < 36; draw++) {
    const phase = state().phase;
    if (phase.type !== 'dealing') assert.fail('Expected dealing');
    run({ type: 'draw-card', id: cid(`draw-${draw}`), actorId: phase.nextSeatId });
  }
  const revealed = state().phase;
  if (revealed.type !== 'trump-reveal') assert.fail('Expected reveal');
  clock += 10000;
  run({ type: 'expire-reveal', id: cid('reveal-ended'), timerId: revealed.timer.id });
  run({
    type: 'submit-claim',
    id: cid('claim-a'),
    actorId: a,
    accusedId: b,
    reason: 'First episode',
    incident: { type: 'spoken', key: 'one' },
    scope: 'between-rounds',
    scopeNumber: 0,
  });
  run({
    type: 'request-withdrawal',
    id: cid('withdraw-a'),
    actorId: a,
    claimId: state().claims[0]!.claim.id,
  });
  const withdrawal = state().procedure;
  if (withdrawal?.type !== 'withdrawal') assert.fail('Expected withdrawal');
  run({
    type: 'withdrawal-response',
    id: cid('deny-a'),
    actorId: b,
    procedureId: withdrawal.timer.id,
    approve: false,
  });
  const vote = state().procedure;
  if (vote?.type !== 'claim-vote') assert.fail('Expected restored vote');
  run({
    type: 'cast-vote',
    id: cid('reject-a'),
    actorId: a,
    procedureId: vote.timer.id,
    vote: 'no',
  });
  run({
    type: 'submit-claim',
    id: cid('claim-b'),
    actorId: b,
    accusedId: a,
    reason: 'Second episode',
    incident: { type: 'chat', messageId: 'message-two' },
    scope: 'between-rounds',
    scopeNumber: 0,
  });
  const penalty = state().procedure;
  if (penalty?.type !== 'penalty') assert.fail('Expected false-claim punishment');
  run({
    type: 'penalty-response',
    id: cid('b-gives'),
    actorId: b,
    procedureId: penalty.timer.id,
    cardId: state().players[1]!.hand[0]!,
  });
  const secondVote = state().procedure;
  if (secondVote?.type !== 'claim-vote') assert.fail('Expected second claim vote');
  run({
    type: 'cast-vote',
    id: cid('tie-b'),
    actorId: b,
    procedureId: secondVote.timer.id,
    vote: 'abstain',
  });
  const snapshot = history.read();
  assert.deepEqual(
    snapshot.state?.claims.map((record) => record.resolution),
    ['rejected', 'tied'],
  );
  assert.equal(snapshot.state?.players[0]!.hand.length, 17);
  assert.equal(snapshot.state?.players[1]!.hand.length, 15);
  let replayed: GameState | null = null;
  for (const action of snapshot.actions) replayed = applyAction(replayed, structuredClone(action));
  assert.deepEqual(replayed, snapshot.state);
  assert.equal(
    history.append({ ...snapshot.head, version: 0 }, snapshot.actions.at(-1)!).type,
    'duplicate',
  );
  assert.deepEqual(history.read(), snapshot);
});
