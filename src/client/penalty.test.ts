import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameStream, remainingTime } from './game-stream.ts';

const ownCard = { id: 'own-card', face: { suit: 'hearts', rank: 9 } };
const secondCard = { id: 'second-card', face: { suit: 'clubs', rank: 7 } };
function wire(sequence = 1, remainingMs = 10000, paused = false) {
  return {
    protocolVersion: 1,
    type: 'state',
    delivery: { epoch: 'epoch', sequence },
    view: {
      head: { gameId: 'game', branchId: 'branch', version: 1 },
      state: {
        viewer: { type: 'participant', seatId: 'own' },
        own: { seatId: 'own', hand: [ownCard, secondCard], stumps: ['closed'] },
        players: [
          { id: 'own', status: 'active', handCount: 2, stumpCount: 1 },
          { id: 'recipient', status: 'active', handCount: 2, stumpCount: 2 },
          { id: 'other', status: 'active', handCount: 2, stumpCount: 2 },
        ],
        deckCount: 0,
        table: [],
        discardCount: 0,
        phase: { type: 'pre-game-penalties' },
      },
      transient: { initialRecipientNotice: false, reveal: null },
      procedure: {
        type: 'penalty',
        recipientId: 'recipient',
        reason: 'draw-out-of-turn',
        eligibleSeatIds: ['own', 'other'],
        ownResponse: null as null | object,
        timer: { id: 'penalty', remainingMs, paused },
      },
      control: { paused, connections: [], replacementVote: null },
    },
  };
}
function transfer(sequence: number, observations: object[]) {
  return {
    protocolVersion: 1,
    type: 'action',
    delivery: { epoch: 'epoch', sequence },
    view: {
      head: { gameId: 'game', branchId: 'branch', version: 2 },
      commandId: 'command',
      observations,
    },
  };
}
test('penalty projection keeps only own reservation without moving the hand; refusals and local zero are valid', () => {
  const stream = new GameStream('own', () => 100);
  const view = wire();
  view.view.procedure.ownResponse = { type: 'card', card: ownCard };
  assert.equal(stream.receive(view), 'state');
  assert.deepEqual(stream.snapshot?.penalty?.ownResponse, { type: 'card', card: ownCard });
  assert.equal(stream.snapshot?.state?.own.hand.length, 2);
  assert.equal(stream.snapshot?.penalty?.timer.expiresAt, 10100);
  const refusal = wire(2, 0);
  refusal.view.procedure.ownResponse = { type: 'refuse' };
  assert.equal(stream.receive(refusal), 'state');
  assert.equal(stream.snapshot?.penalty?.ownResponse?.type, 'refuse');
  assert.equal(remainingTime(stream.snapshot!.penalty!.timer, 100), 0);
});
test('penalty timer updates shorten, freeze on pause and resume only projected remainder', () => {
  let now = 100;
  const stream = new GameStream('own', () => now);
  stream.receive(wire());
  now = 3000;
  stream.receive(wire(2, 10000));
  assert.equal(remainingTime(stream.snapshot!.penalty!.timer, now), 7100);
  stream.receive(wire(3, 7000, true));
  now = 50000;
  assert.equal(remainingTime(stream.snapshot!.penalty!.timer, now), 7000);
  stream.receive(wire(4, 7000));
  assert.equal(remainingTime(stream.snapshot!.penalty!.timer, now), 7000);
  now = 57001;
  assert.equal(remainingTime(stream.snapshot!.penalty!.timer, now), 0);
  assert.equal(
    stream.snapshot?.penalty?.ownResponse,
    null,
    'local expiry never manufactures refusal',
  );
});
test('foreign or extra reservation data, invalid timer/reason/eligibility and last-card reservations fail closed', () => {
  for (const mutate of [
    (v: ReturnType<typeof wire>) => {
      v.view.procedure.ownResponse = { type: 'card', card: { ...ownCard, id: 'foreign' } };
    },
    (v: ReturnType<typeof wire>) => {
      v.view.procedure.ownResponse = {
        type: 'card',
        card: { ...ownCard, face: { suit: 'clubs', rank: 9 } },
      };
    },
    (v: ReturnType<typeof wire>) => {
      Object.assign(v.view.procedure, { responses: { other: ownCard } });
    },
    (v: ReturnType<typeof wire>) => {
      Object.assign(v.view.procedure, { reason: ['peek'] });
    },
    (v: ReturnType<typeof wire>) => {
      v.view.procedure.timer.remainingMs = -1;
    },
    (v: ReturnType<typeof wire>) => {
      v.view.procedure.timer.remainingMs = 10001;
    },
    (v: ReturnType<typeof wire>) => {
      Object.assign(v.view.procedure.timer, { paused: ['false'] });
    },
    (v: ReturnType<typeof wire>) => {
      v.view.procedure.eligibleSeatIds = ['recipient', 'own'];
    },
    (v: ReturnType<typeof wire>) => {
      v.view.procedure.eligibleSeatIds = ['own', 'own'];
    },
    (v: ReturnType<typeof wire>) => {
      v.view.state.own.hand = [ownCard];
      v.view.state.players[0]!.handCount = 1;
      v.view.procedure.ownResponse = { type: 'card', card: ownCard };
    },
  ]) {
    const view = wire();
    mutate(view);
    assert.equal(new GameStream('own').receive(view), 'invalid');
  }
});
test('fresh completed transfers are donor/recipient-only and never baseline or duplicate replay', () => {
  const stream = new GameStream('own');
  stream.receive(wire());
  const observation = {
    type: 'penalty-transfer',
    fromSeatId: 'own',
    toSeatId: 'recipient',
    card: ownCard,
  };
  assert.equal(stream.receive(transfer(2, [observation])), 'meta');
  assert.deepEqual(stream.transfers, [{ fromSeatId: 'own', toSeatId: 'recipient', card: ownCard }]);
  assert.equal(stream.receive(wire(3)), 'state');
  assert.equal(stream.transfers.length, 1);
  assert.equal(stream.receive(transfer(2, [])), 'ignored');
  assert.equal(stream.transfers.length, 1);
  const branch = wire(4);
  branch.view.head.branchId = 'new-branch';
  stream.receive(branch);
  assert.deepEqual(
    stream.transfers,
    [],
    'branch changes clear stale transfer feedback even within an epoch',
  );
  stream.receive(transfer(5, []));
  assert.deepEqual(stream.transfers, [], 'not a transfer history');
  const resync = wire(1);
  resync.delivery.epoch = 'fresh';
  stream.receive(resync);
  assert.deepEqual(stream.transfers, []);
  for (const bad of [
    { ...observation, fromSeatId: 'other' },
    { ...observation, toSeatId: 'own' },
    { ...observation, card: { ...ownCard, secret: 'PRIVATE' } },
  ])
    assert.equal(new GameStream('own').receive(transfer(1, [bad])), 'invalid');
});
