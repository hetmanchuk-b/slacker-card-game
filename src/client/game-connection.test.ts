import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameConnection } from './game-connection.ts';
import type { GameSocket } from './game-connection.ts';
class FakeSocket implements GameSocket {
  connected = false;
  listeners = new Map<string, (...args: unknown[]) => void>();
  sent: object[] = [];
  on(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.set(event, listener);
  }
  connect() {
    assert.ok(this.listeners.has('server-message'));
    this.connected = true;
    this.listeners.get('connect')?.();
  }
  disconnect() {
    this.connected = false;
    this.listeners.get('disconnect')?.();
  }
  send(message: object) {
    assert.equal(this.connected, true);
    this.sent.push(message);
  }
  deliver(message: object) {
    let receipt = '';
    this.listeners.get('server-message')?.(message, 'opaque-nonce', (value: string) => {
      receipt = value;
    });
    assert.equal(receipt, 'opaque-nonce');
  }
}
function currentView(client: GameConnection) {
  return client.current.view;
}
function fixture(saved?: string) {
  const sockets: FakeSocket[] = [];
  const storage = new Map<string, string>();
  if (saved !== undefined) storage.set('penky.first-start.v1.lobby', saved);
  let timeout = () => {};
  let id = 0;
  const busy: boolean[] = [];
  const makeClient = () =>
    new GameConnection({
      lobbyId: 'lobby',
      seatId: 'own',
      isOwner: true,
      onBusy: (value) => {
        busy.push(value);
      },
      factory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      requestId: () => `request-${++id}`,
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => {
          storage.set(key, value);
        },
      },
      schedule: (callback) => {
        timeout = callback;
        return () => {};
      },
    });
  const client = makeClient();
  return { client, sockets, storage, makeClient, busy, timeout: () => timeout() };
}
test('receipt handler precedes connect; unavailable attach is not proof of an empty lobby and start retries keep the exact intent', () => {
  const { client, sockets } = fixture();
  client.connect();
  sockets[0]!.deliver({ protocolVersion: 1, type: 'error', code: 'unavailable' });
  assert.equal(client.current.status, 'attached');
  assert.equal(currentView(client), null);
  client.startFirst();
  const original = sockets[0]!.sent.at(-1);
  sockets[0]!.disconnect();
  client.connect();
  sockets[1]!.deliver({ protocolVersion: 1, type: 'error', code: 'unavailable' });
  client.startFirst();
  assert.deepEqual(sockets[1]!.sent.at(-1), original);
  const requestId = (original as { requestId: string }).requestId;
  sockets[1]!.deliver({
    protocolVersion: 1,
    type: 'match-start-ack',
    requestId,
    result: { type: 'started', gameId: 'historical-game', duplicate: true },
  });
  assert.equal(sockets.length, 3, 'a fresh fenced connection explicitly resyncs after the ack');
  assert.equal(currentView(client), null, 'ack game identity is not a baseline');
  assert.equal((sockets[2]!.sent[0] as { intent: { type: string } }).intent.type, 'resync');
  sockets[2]!.deliver({
    protocolVersion: 1,
    type: 'state',
    delivery: { epoch: 'fresh', sequence: 1 },
    view: {
      head: { gameId: 'current-game', branchId: 'current-branch', version: 0 },
      state: null,
      transient: {},
      procedure: null,
      control: { paused: true, connections: [], replacementVote: null },
    },
  });
  assert.equal(client.current.view?.head.gameId, 'current-game');
  sockets[1]!.deliver({
    protocolVersion: 1,
    type: 'match-start-ack',
    requestId,
    result: { type: 'started', gameId: 'historical-game', duplicate: true },
  });
  assert.equal(client.current.view?.head.gameId, 'current-game');
  client.close();
});
test('unreadable saved start references cannot be replaced after an unavailable attachment', () => {
  const { client, sockets } = fixture('{"version":1,"requestId":"old","expected":{}}');
  client.connect();
  sockets[0]!.deliver({ protocolVersion: 1, type: 'error', code: 'unavailable' });
  client.startFirst();
  assert.equal(sockets[0]!.sent.length, 1);
  client.close();
});
const baseline = (sequence = 1, paused = false) => ({
  protocolVersion: 1,
  type: 'state',
  delivery: { epoch: 'opaque', sequence },
  view: {
    head: { gameId: 'assigned-game', branchId: 'branch', version: 0 },
    state: null,
    transient: {},
    procedure: null,
    control: { paused, connections: [], replacementVote: null },
  },
});
test('assigned null baseline blocks a new null-head start and disconnect clears display without replay', () => {
  const { client, sockets } = fixture();
  client.startFirst();
  assert.equal(sockets.length, 0);
  client.connect();
  sockets[0]!.deliver(baseline());
  assert.equal(client.current.assigned, true);
  assert.equal(client.current.view?.state, null);
  client.startFirst();
  assert.equal(sockets[0]!.sent.length, 1);
  client.close();
  sockets[0]!.deliver(baseline(2));
  assert.equal(client.current.view, null);
  assert.equal(client.current.assigned, true);
});
test('timeouts and uncorrelated errors fence late acks and never enqueue offline starts', () => {
  const { client, sockets, timeout } = fixture();
  client.connect();
  sockets[0]!.deliver({ protocolVersion: 1, type: 'error', code: 'unavailable' });
  client.startFirst();
  const original = sockets[0]!.sent.at(-1) as { requestId: string };
  timeout();
  assert.equal(client.current.status, 'uncertain');
  client.startFirst();
  assert.equal(sockets[0]!.sent.length, 2);
  client.connect();
  sockets[0]!.deliver({
    protocolVersion: 1,
    type: 'match-start-ack',
    requestId: original.requestId,
    result: { type: 'started', gameId: 'old', duplicate: true },
  });
  assert.equal(sockets.length, 2);
  sockets[1]!.deliver({ protocolVersion: 1, type: 'error', code: 'unavailable' });
  client.startFirst();
  assert.deepEqual(sockets[1]!.sent.at(-1), original);
  sockets[1]!.deliver({ protocolVersion: 1, type: 'error', code: 'unavailable', cause: 'PRIVATE' });
  assert.equal(client.current.status, 'uncertain');
  assert.equal(JSON.stringify(client.current).includes('PRIVATE'), false);
  client.close();
});
test('a new controller restores only the immutable nonsecret first-start intent', () => {
  const { client, sockets, makeClient, storage } = fixture();
  client.connect();
  sockets[0]!.deliver({ protocolVersion: 1, type: 'error', code: 'unavailable' });
  client.startFirst();
  const original = sockets[0]!.sent.at(-1);
  client.close();
  const reloaded = makeClient();
  reloaded.connect();
  sockets[1]!.deliver({ protocolVersion: 1, type: 'error', code: 'unavailable' });
  reloaded.startFirst();
  assert.deepEqual(sockets[1]!.sent.at(-1), original);
  const saved = JSON.parse([...storage.values()][0]!);
  assert.deepEqual(Object.keys(saved).sort(), ['expected', 'requestId', 'version']);
  reloaded.close();
});
test('idle stream updates cannot release another UI operation guard; malformed receipts fail closed', () => {
  const { client, sockets, busy } = fixture();
  client.connect();
  sockets[0]!.deliver(baseline());
  const transitions = [...busy];
  sockets[0]!.deliver(baseline(2, true));
  assert.deepEqual(busy, transitions);
  sockets[0]!.listeners.get('server-message')?.(baseline(3), 17, () =>
    assert.fail('Invalid nonce'),
  );
  assert.equal(client.current.status, 'failed');
  assert.equal(client.current.view, null);
  client.close();
});
