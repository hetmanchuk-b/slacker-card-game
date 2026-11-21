import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameStream } from './game-stream.ts';
const face = (id: string, rank = 9) => ({ id, face: { suit: 'hearts', rank } });
const peekId = (stream: GameStream) => stream.peek?.penaltyId;
function wire(sequence = 1) {
  return {
    protocolVersion: 1,
    type: 'state',
    delivery: { epoch: 'epoch', sequence },
    view: {
      head: { gameId: 'game', branchId: 'branch', version: sequence },
      state: {
        viewer: { type: 'participant', seatId: 'own' },
        players: [
          { id: 'own', status: 'active', handCount: 1, stumpCount: 1 },
          { id: 'other', status: 'active', handCount: 2, stumpCount: 1 },
        ],
        own: { seatId: 'own', hand: [face('hand')], stumps: ['stump'] },
        deckCount: 0,
        table: [face('bottom', 7), face('top', 8)],
        discardCount: 0,
        phase: { type: 'round', number: 2, targetSize: 4, turnSeatId: 'other' } as object,
      },
      transient: { initialRecipientNotice: false, reveal: null },
      procedure: null as object | null,
      control: { paused: false, connections: [], replacementVote: null },
    },
  };
}
const action = (sequence: number, observations: object[]) => ({
  protocolVersion: 1,
  type: 'action',
  delivery: { epoch: 'epoch', sequence },
  view: {
    head: { gameId: 'game', branchId: 'branch', version: sequence },
    commandId: `command-${sequence}`,
    observations,
  },
});
function penalty(sequence: number, id = 'penalty') {
  const value = wire(sequence);
  value.view.procedure = {
    type: 'penalty',
    recipientId: 'own',
    reason: 'peek',
    eligibleSeatIds: ['other'],
    ownResponse: null,
    timer: { id, remainingMs: 9000, paused: false },
  };
  return value;
}
test('ordered public table and server round/leader fields are validated without deriving legality', () => {
  const stream = new GameStream('own');
  stream.receive(wire());
  assert.deepEqual(stream.snapshot?.state?.table, [face('bottom', 7), face('top', 8)]);
  assert.deepEqual(stream.snapshot?.state?.round, {
    number: 2,
    targetSize: 4,
    turnSeatId: 'other',
  });
  const boundary = wire(2);
  boundary.view.state.table = [];
  boundary.view.state.phase = { type: 'between-rounds', leaderId: 'own', nextRoundNumber: 3 };
  assert.equal(stream.receive(boundary), 'state');
  assert.equal(stream.snapshot?.state?.leaderId, 'own');
  for (const mutate of [
    (v: ReturnType<typeof wire>) => {
      v.view.state.phase = { type: 'round', number: 2, targetSize: 9, turnSeatId: 'other' };
    },
    (v: ReturnType<typeof wire>) => {
      v.view.state.phase = { type: 'round', number: 2, targetSize: 4, turnSeatId: 'missing' };
    },
    (v: ReturnType<typeof wire>) => {
      Object.assign(v.view.state.table[0]!, { secret: 'PRIVATE' });
    },
    (v: ReturnType<typeof wire>) => {
      v.view.state.table[1] = v.view.state.table[0]!;
    },
    (v: ReturnType<typeof wire>) => {
      v.view.state.phase = { type: 'dealing', nextSeatId: 'PRIVATE' };
    },
  ]) {
    const value = wire();
    mutate(value);
    assert.equal(new GameStream('own').receive(value), 'invalid');
  }
});
test('current-action play and automatic bottom pickup survive empty final table but are not history', () => {
  const stream = new GameStream('own');
  stream.receive(wire());
  const observations = [
    { type: 'card-played', seatId: 'other', card: face('played', 10) },
    { type: 'bottom-taken', seatId: 'own', card: face('bottom', 7), automatic: true },
  ];
  assert.equal(stream.receive(action(2, observations)), 'meta');
  const final = wire(3);
  final.view.state.table = [];
  stream.receive(final);
  assert.deepEqual(stream.playObservations, observations);
  stream.receive(action(2, []));
  assert.equal(stream.playObservations.length, 2);
  stream.receive(action(4, []));
  assert.deepEqual(stream.playObservations, []);
  assert.equal(
    new GameStream('own').receive(
      action(1, [{ type: 'stump-opened', seatId: 'other', card: face('hidden') }]),
    ),
    'invalid',
  );
  assert.equal(
    new GameStream('own').receive(
      action(1, [
        { type: 'bottom-taken', seatId: 'own', card: face('bottom'), automatic: ['true'] },
      ]),
    ),
    'invalid',
  );
});
test('fresh peek is bound to its penalty, cannot reopen after dismissal/duplicates and never moves the stump', () => {
  const stream = new GameStream('own');
  stream.receive(wire());
  stream.receive(action(2, [{ type: 'stump-peeked', card: face('stump') }]));
  assert.equal(stream.peek, null, 'not displayed before associated penalty baseline');
  stream.receive(penalty(3));
  assert.deepEqual(stream.peek, { card: face('stump'), penaltyId: 'penalty' });
  assert.deepEqual(stream.snapshot?.state?.own.stumps, ['stump']);
  assert.equal(stream.snapshot?.state?.own.hand.length, 1);
  stream.dismissPeek();
  stream.receive(penalty(4));
  stream.receive(action(2, [{ type: 'stump-peeked', card: face('stump') }]));
  assert.equal(stream.peek, null);
  stream.receive(action(5, [{ type: 'stump-peeked', card: face('stump') }]));
  stream.receive(penalty(6, 'next'));
  assert.equal(peekId(stream), 'next', 'a separate fresh action can disclose again');
  stream.receive(penalty(7, 'changed'));
  assert.equal(stream.peek, null);
});
test('peek hides on penalty completion, pause, reset, null state and state-only resync, never restoring on resume', () => {
  for (const clear of ['complete', 'pause', 'epoch', 'rollback', 'null', 'branch']) {
    const stream = new GameStream('own');
    stream.receive(wire());
    stream.receive(action(2, [{ type: 'stump-peeked', card: face('stump') }]));
    stream.receive(penalty(3));
    const value = penalty(4);
    if (clear === 'complete') value.view.procedure = null;
    if (clear === 'pause') {
      value.view.control.paused = true;
      Object.assign(value.view.procedure!, {
        timer: { id: 'penalty', remainingMs: 8000, paused: true },
      });
    }
    if (clear === 'epoch') value.delivery.epoch = 'new';
    if (clear === 'branch') value.view.head.branchId = 'new';
    if (clear === 'null') Object.assign(value.view, { state: null, procedure: null });
    if (clear === 'rollback')
      stream.receive({
        protocolVersion: 1,
        type: 'rollback-notice',
        delivery: { epoch: 'epoch', sequence: 4 },
        notice: {},
      });
    else stream.receive(value);
    assert.equal(stream.peek, null, clear);
    stream.receive(penalty(5));
    assert.equal(stream.peek, null, 'current penalty never replays knowledge');
  }
  const invalid = new GameStream('own');
  invalid.receive(wire());
  assert.equal(
    invalid.receive(action(2, [{ type: 'stump-peeked', card: face('foreign') }])),
    'invalid',
  );
});
test('finished results retain strict executable variants and earlier winners without exposing additional cards', () => {
  for (const result of [
    { type: 'last-player', loserId: 'other' },
    { type: 'all-won' },
    { type: 'draw', remainingSeatIds: ['other'] },
  ]) {
    const stream = new GameStream('own');
    const value = wire();
    value.view.state.phase = { type: 'finished', result };
    value.view.state.players[0]!.status = 'won';
    assert.equal(stream.receive(value), 'state');
    assert.deepEqual(stream.snapshot?.state?.result, result);
    assert.equal(stream.snapshot?.state?.players[0]?.status, 'won');
    assert.deepEqual(stream.snapshot?.state?.own.hand, [face('hand')]);
    const malformed = wire(2);
    malformed.view.state.phase = {
      type: 'finished',
      result: { ...result, hiddenCards: [face('secret')] },
    };
    assert.equal(stream.receive(malformed), 'invalid');
  }
});
