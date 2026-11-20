import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameStream } from './game-stream.ts';
const state = (epoch: string, sequence: number, version = 0, paused = false, empty = false) => ({
  protocolVersion: 1,
  type: 'state',
  delivery: { epoch, sequence },
  view: {
    head: { gameId: 'game', branchId: 'branch', version },
    state: empty
      ? null
      : {
          viewer: { type: 'participant', seatId: 'own' },
          players: [
            { id: 'own', status: 'active', handCount: 0, stumpCount: 0 },
            { id: 'other', status: 'active', handCount: 0, stumpCount: 0 },
          ],
          own: { seatId: 'own', hand: [], stumps: [] },
          deckCount: 36,
          table: [],
          discardCount: 0,
          phase: { type: 'dealing' },
        },
    transient: { initialRecipientNotice: !empty, reveal: null },
    procedure: null,
    control: {
      paused,
      connections: [{ seatId: 'own', connected: !paused, controller: 'human' }],
      replacementVote: null,
    },
  },
});
test('delivery ordering accepts same-head controls, retires epochs and permits rollback to assigned null state', () => {
  const stream = new GameStream('own');
  const view = () => stream.snapshot;
  assert.equal(stream.receive(state('old', 1, 8)), 'state');
  assert.equal(stream.receive(state('old', 2, 8, true)), 'state');
  assert.equal(view()?.paused, true);
  assert.equal(
    stream.receive({
      protocolVersion: 1,
      type: 'rollback-notice',
      delivery: { epoch: 'new', sequence: 1 },
      notice: {},
    }),
    'meta',
  );
  assert.equal(view(), null);
  assert.equal(stream.receive(state('new', 2, 0, false, true)), 'state');
  assert.equal(view()?.state, null);
  assert.equal(view()?.head.gameId, 'game');
  assert.equal(stream.receive(state('old', 3, 99)), 'ignored');
  assert.equal(view()?.head.version, 0);
  assert.equal(
    stream.receive({ protocolVersion: 1, type: 'command-ack', result: { head: { version: 99 } } }),
    'ignored',
  );
  assert.equal(view()?.head.version, 0);
});
test('duplicates cannot regress state and missing delivery positions fail closed', () => {
  const stream = new GameStream('own');
  assert.equal(stream.receive(state('epoch', 1, 2)), 'state');
  assert.equal(stream.receive(state('epoch', 1, 0)), 'ignored');
  assert.equal(stream.snapshot?.head.version, 2);
  assert.equal(stream.receive(state('epoch', 3, 3)), 'invalid');
});
const card = { id: 'opaque-card', face: { suit: 'hearts', rank: 9 } };
const revealDeadline = (stream: GameStream) => stream.snapshot?.reveal?.expiresAt;
const action = (sequence: number, observations: object[]) => ({
  protocolVersion: 1,
  type: 'action',
  delivery: { epoch: 'epoch', sequence },
  view: {
    head: { gameId: 'game', branchId: 'branch', version: 1 },
    commandId: 'command',
    observations,
  },
});
test('own faces and closed handles are validated; fresh draw actors survive the following state but never resync', () => {
  const stream = new GameStream('own');
  const wire = state('epoch', 1);
  wire.view.state!.own.hand = [card] as never[];
  wire.view.state!.players[0]!.handCount = 1;
  wire.view.state!.own.stumps = ['opaque-stump'] as never[];
  wire.view.state!.players[0]!.stumpCount = 1;
  assert.equal(stream.receive(wire), 'state');
  assert.deepEqual(stream.snapshot?.state?.own, { hand: [card], stumps: ['opaque-stump'] });
  assert.equal(
    stream.receive(
      action(2, [{ type: 'card-drawn', seatId: 'other', destination: 'stump', card: null }]),
    ),
    'meta',
  );
  assert.deepEqual(stream.draw, { seatId: 'other', destination: 'stump', rejected: false });
  assert.equal(stream.receive(state('epoch', 3)), 'state');
  assert.equal(stream.draw?.seatId, 'other');
  assert.equal(stream.receive(action(2, [{ type: 'draw-rejected', seatId: 'own' }])), 'ignored');
  assert.equal(stream.draw?.seatId, 'other');
  assert.equal(stream.receive(state('new', 1)), 'state');
  assert.equal(stream.draw, null);
});
test('D002 notices and relative reveal deadlines cannot restart on duplicates or same-timer updates', () => {
  let now = 100;
  const stream = new GameStream('own', () => now);
  const reveal = (sequence: number, remainingMs: number, paused = false) => {
    const wire = state('epoch', sequence, 1, paused);
    wire.view.state!.phase.type = 'trump-reveal';
    Object.assign(wire.view.transient, {
      initialRecipientNotice: false,
      reveal: paused
        ? null
        : {
            card,
            recipientId: 'other',
            timer: { id: 'timer', remainingMs, paused: false },
          },
    });
    return wire;
  };
  assert.equal(stream.receive(state('epoch', 1)), 'state');
  assert.equal(stream.snapshot?.initialRecipientNotice, true);
  assert.equal(stream.receive(action(2, [{ type: 'draw-rejected', seatId: 'other' }])), 'meta');
  assert.equal(stream.receive(state('epoch', 3)), 'state');
  assert.equal(stream.snapshot?.initialRecipientNotice, true);
  stream.receive(reveal(4, 10000));
  assert.equal(stream.snapshot?.reveal?.expiresAt, 10100);
  now = 5000;
  stream.receive(reveal(4, 10000));
  stream.receive(reveal(5, 10000));
  assert.equal(stream.snapshot?.reveal?.expiresAt, 10100);
  stream.receive(reveal(6, 7000, true));
  assert.equal(stream.snapshot?.reveal, null);
  now = 20000;
  stream.receive(reveal(7, 7000));
  assert.equal(revealDeadline(stream), 27000);
  now = 27001;
  stream.expireReveal();
  assert.equal(stream.snapshot?.reveal, null);
  stream.receive(reveal(8, 7000));
  assert.equal(stream.snapshot?.reveal, null, 'expired running timer cannot resurrect');
});
test('malformed cards, hidden observations and invalid transient references fail closed', () => {
  for (const bad of [
    { ...card, face: { suit: ['hearts'], rank: 9 } },
    { ...card, face: { suit: 'hearts', rank: 15 } },
    { ...card, secret: 'PRIVATE' },
  ]) {
    const wire = state('epoch', 1);
    wire.view.state!.own.hand = [bad] as never[];
    assert.equal(new GameStream('own').receive(wire), 'invalid');
  }
  assert.equal(
    new GameStream('own').receive(
      action(1, [{ type: 'card-drawn', seatId: 'other', destination: 'hand', card }]),
    ),
    'invalid',
  );
  const wire = state('epoch', 1);
  Object.assign(wire.view.transient, {
    reveal: {
      card,
      recipientId: 'missing',
      timer: { id: 'timer', remainingMs: 10000, paused: false },
    },
  });
  assert.equal(new GameStream('own').receive(wire), 'invalid');
});
test('viewer substitution, raw private player fields and malformed bounds are rejected', () => {
  for (const mutate of [
    (wire: ReturnType<typeof state>) => {
      wire.view.state!.viewer.seatId = 'other';
    },
    (wire: ReturnType<typeof state>) => {
      Object.assign(wire.view.state!.players[1]!, { hand: ['PRIVATE'] });
    },
    (wire: ReturnType<typeof state>) => {
      wire.view.state!.deckCount = 100;
    },
    (wire: ReturnType<typeof state>) => {
      wire.view.head.version = -1;
    },
    (wire: ReturnType<typeof state>) => {
      Object.assign(wire.view.state!.viewer, { type: ['participant'] });
    },
    (wire: ReturnType<typeof state>) => {
      Object.assign(wire.view.state!.players[0]!, { status: ['active'] });
    },
    (wire: ReturnType<typeof state>) => {
      Object.assign(wire.view.control.connections[0]!, { controller: ['human'] });
    },
    (wire: ReturnType<typeof state>) => {
      Object.assign(wire.view.state!.phase, { type: { toString: null } });
    },
  ]) {
    const wire = state('epoch', 1);
    mutate(wire);
    assert.equal(new GameStream('own').receive(wire), 'invalid');
  }
});
test('opaque epoch retirement is bounded per physical connection', () => {
  const stream = new GameStream('own');
  for (let index = 0; index < 65; index++)
    assert.equal(stream.receive(state(`epoch-${index}`, 1)), 'state');
  assert.equal(stream.receive(state('epoch-overflow', 1)), 'invalid');
});
