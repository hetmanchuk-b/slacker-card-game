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
    transient: { initialRecipientNotice: true, reveal: null },
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
test('action observations and legitimate private faces are discarded, not replayed as memory', () => {
  const stream = new GameStream('own');
  const wire = state('epoch', 1);
  wire.view.state!.own.hand = [{ id: 'PRIVATE_FACE' }] as never[];
  assert.equal(stream.receive(wire), 'state');
  assert.equal(JSON.stringify(stream.snapshot).includes('PRIVATE_FACE'), false);
  assert.equal(
    stream.receive({
      protocolVersion: 1,
      type: 'action',
      delivery: { epoch: 'epoch', sequence: 2 },
      view: { privateObservation: 'PRIVATE_FACE' },
    }),
    'meta',
  );
  assert.equal(stream.snapshot, null);
  assert.equal(stream.receive(state('epoch', 3)), 'state');
  assert.equal(JSON.stringify(stream.snapshot).includes('PRIVATE_FACE'), false);
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
