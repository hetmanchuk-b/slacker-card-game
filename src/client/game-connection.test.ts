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
function fixture(
  saved?: string,
  timing: {
    now?: () => number;
    scheduleReveal?: (callback: () => void, delay: number) => () => void;
  } = {},
) {
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
      ...timing,
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
      transient: { initialRecipientNotice: false, reveal: null },
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
    transient: { initialRecipientNotice: false, reveal: null },
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
function dealing(sequence = 1) {
  const wire = baseline(sequence);
  Object.assign(wire.view, {
    state: {
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
  });
  return wire;
}
test('draw sends only the confirmed route, permits out-of-turn attempts and never applies acknowledgment heads', () => {
  const { client, sockets } = fixture();
  client.drawCard();
  assert.equal(sockets.length, 0);
  client.connect();
  const socket = sockets[0]!;
  socket.deliver(dealing());
  client.drawCard();
  const command = socket.sent.at(-1) as { requestId: string };
  assert.deepEqual(command, {
    protocolVersion: 1,
    requestId: command.requestId,
    intent: { type: 'draw-card', gameId: 'assigned-game', branchId: 'branch' },
  });
  assert.equal(client.current.view?.state?.deckCount, 36);
  client.drawCard();
  assert.equal(socket.sent.length, 2, 'only one pending draw');
  socket.deliver({
    protocolVersion: 1,
    type: 'command-ack',
    requestId: 'unrelated',
    result: {
      type: 'accepted',
      outcome: 'played',
      head: { gameId: 'old', branchId: 'old', version: 100 },
      duplicate: false,
    },
  });
  assert.equal(client.current.drawStatus, 'pending');
  socket.deliver({
    protocolVersion: 1,
    type: 'command-ack',
    requestId: command.requestId,
    result: {
      type: 'accepted',
      outcome: 'violation',
      head: { gameId: 'old', branchId: 'old', version: 100 },
      duplicate: false,
    },
  });
  assert.equal(client.current.drawStatus, 'violation');
  assert.equal(client.current.view?.head.version, 0);
  client.drawCard();
  const next = socket.sent.at(-1) as { requestId: string };
  socket.deliver({
    protocolVersion: 1,
    type: 'command-ack',
    requestId: next.requestId,
    result: {
      type: 'rejected',
      code: 'wrong-phase',
      head: { gameId: 'assigned-game', branchId: 'branch', version: 0 },
    },
  });
  assert.equal(client.current.drawStatus, 'rejected');
  client.close();
});
test('uncertain draws are not retried offline or silently retargeted after reconnect', () => {
  const { client, sockets, timeout } = fixture();
  client.connect();
  sockets[0]!.deliver(dealing());
  client.drawCard();
  timeout();
  assert.equal(client.current.drawStatus, 'uncertain');
  assert.equal(client.current.view, null);
  client.drawCard();
  assert.equal(sockets[0]!.sent.length, 2);
  client.connect();
  sockets[1]!.deliver(dealing());
  assert.equal(sockets[1]!.sent.length, 1, 'resync only, never automatic draw replay');
  client.close();
});
test('a rotated rollback stream invalidates an old pending draw and its late acknowledgment', () => {
  const { client, sockets } = fixture();
  client.connect();
  sockets[0]!.deliver(dealing());
  client.drawCard();
  const original = sockets[0]!.sent.at(-1) as { requestId: string };
  sockets[0]!.deliver({
    protocolVersion: 1,
    type: 'rollback-notice',
    delivery: { epoch: 'rollback', sequence: 1 },
    notice: {
      actorId: 'own',
      target: {
        expected: { gameId: 'assigned-game', branch: 1, version: 10 },
        beforeActionVersion: 1,
      },
      head: { gameId: 'assigned-game', branch: 2, version: 0 },
    },
  });
  assert.notEqual(client.current.drawStatus, 'pending');
  const next = dealing(2);
  next.delivery.epoch = 'rollback';
  sockets[0]!.deliver(next);
  sockets[0]!.deliver({
    protocolVersion: 1,
    type: 'command-ack',
    requestId: original.requestId,
    result: {
      type: 'accepted',
      outcome: 'played',
      duplicate: false,
      head: { gameId: 'assigned-game', branchId: 'old', version: 100 },
    },
  });
  assert.notEqual(client.current.drawStatus, 'played');
  client.drawCard();
  assert.equal(sockets[0]!.sent.length, 3);
  client.close();
});
test('malformed matching draw acknowledgments fail closed without diagnostics', () => {
  const { client, sockets } = fixture();
  client.connect();
  sockets[0]!.deliver(dealing());
  client.drawCard();
  const command = sockets[0]!.sent.at(-1) as { requestId: string };
  sockets[0]!.deliver({
    protocolVersion: 1,
    type: 'command-ack',
    requestId: command.requestId,
    result: { type: 'accepted', outcome: ['played'], duplicate: false, secret: 'PRIVATE' },
  });
  assert.equal(client.current.status, 'uncertain');
  assert.equal(client.current.view, null);
  assert.equal(JSON.stringify(client.current).includes('PRIVATE'), false);
  client.close();
});
const donationCard = { id: 'donation', face: { suit: 'hearts', rank: 9 } };
function penaltyBaseline(sequence = 1, id = 'penalty', size = 2) {
  return {
    protocolVersion: 1,
    type: 'state',
    delivery: { epoch: 'opaque', sequence },
    view: {
      head: { gameId: 'assigned-game', branchId: 'branch', version: 1 },
      state: {
        viewer: { type: 'participant', seatId: 'own' },
        players: [
          { id: 'own', status: 'active', handCount: size, stumpCount: 1 },
          { id: 'other', status: 'active', handCount: 3, stumpCount: 2 },
          { id: 'third', status: 'active', handCount: 3, stumpCount: 2 },
        ],
        own: {
          seatId: 'own',
          hand:
            size === 0
              ? []
              : size === 1
                ? [donationCard]
                : [donationCard, { id: 'second', face: { suit: 'clubs', rank: 6 } }],
          stumps: ['stump'],
        },
        deckCount: 0,
        table: [],
        discardCount: 0,
        phase: { type: 'pre-game-penalties' },
      },
      transient: { initialRecipientNotice: false, reveal: null },
      procedure: {
        type: 'penalty',
        recipientId: 'other',
        reason: 'draw-out-of-turn',
        eligibleSeatIds: ['own', 'third'],
        ownResponse: null as object | null,
        timer: { id, remainingMs: 10000, paused: false },
      },
      control: { paused: false, connections: [], replacementVote: null },
    },
  };
}
test('penalty selection sends captured own reservation intent only once and ack never creates a reservation', () => {
  const { client, sockets } = fixture();
  client.connect();
  const socket = sockets[0]!;
  socket.deliver(penaltyBaseline());
  client.selectPenaltyCard('stump');
  assert.equal(client.current.selectedCardId, null);
  client.selectPenaltyCard('foreign');
  assert.equal(client.current.selectedCardId, null);
  client.selectPenaltyCard('donation');
  assert.equal(client.current.selectedCardId, 'donation');
  client.respondToPenalty('donation');
  const sent = socket.sent.at(-1) as { requestId: string };
  assert.deepEqual(sent, {
    protocolVersion: 1,
    requestId: sent.requestId,
    intent: {
      type: 'penalty-response',
      gameId: 'assigned-game',
      branchId: 'branch',
      procedureId: 'penalty',
      cardId: 'donation',
    },
  });
  client.respondToPenalty(null);
  assert.equal(socket.sent.length, 2);
  assert.equal(client.current.view?.state?.own.hand.length, 2);
  socket.deliver({
    protocolVersion: 1,
    type: 'command-ack',
    requestId: sent.requestId,
    result: {
      type: 'accepted',
      outcome: 'played',
      duplicate: false,
      head: { gameId: 'old', branchId: 'old', version: 99 },
    },
  });
  assert.equal(client.current.penaltyStatus, 'accepted');
  assert.equal(client.current.view?.penalty?.ownResponse, null);
  const reservation = penaltyBaseline(2);
  reservation.view.procedure.ownResponse = { type: 'card', card: donationCard };
  socket.deliver(reservation);
  assert.equal(client.current.selectedCardId, null);
  client.respondToPenalty(null);
  assert.equal(socket.sent.length, 2, 'authoritative ownResponse disables a second answer');
  socket.deliver(penaltyBaseline(3, 'next-penalty'));
  assert.equal(
    client.current.penaltyStatus,
    'none',
    'previous acceptance is not feedback for the next procedure',
  );
  client.close();
});
test('zero/one-card donors can refuse but cannot reserve a last card or a closed stump', () => {
  for (const size of [0, 1]) {
    const { client, sockets } = fixture();
    client.connect();
    const socket = sockets[0]!;
    socket.deliver(penaltyBaseline(1, 'penalty', size));
    client.selectPenaltyCard('donation');
    client.respondToPenalty('donation');
    client.respondToPenalty('stump');
    assert.equal(socket.sent.length, 1);
    assert.equal(client.current.selectedCardId, null);
    client.respondToPenalty(null);
    assert.equal((socket.sent.at(-1) as { intent: { cardId: unknown } }).intent.cardId, null);
    client.close();
  }
});
test('new procedure and rotated stream clear obsolete penalty drafts/pending commands and ignore late acks', () => {
  const { client, sockets } = fixture();
  client.connect();
  const socket = sockets[0]!;
  socket.deliver(penaltyBaseline());
  client.selectPenaltyCard('donation');
  socket.deliver(penaltyBaseline(2, 'next'));
  assert.equal(client.current.selectedCardId, null);
  client.respondToPenalty(null);
  const old = socket.sent.at(-1) as { requestId: string };
  socket.deliver(penaltyBaseline(3, 'third'));
  assert.notEqual(client.current.penaltyStatus, 'pending');
  client.respondToPenalty(null);
  const newer = socket.sent.at(-1);
  socket.deliver({
    protocolVersion: 1,
    type: 'command-ack',
    requestId: old.requestId,
    result: {
      type: 'accepted',
      outcome: 'played',
      duplicate: false,
      head: { gameId: 'old', branchId: 'old', version: 99 },
    },
  });
  assert.equal(client.current.penaltyStatus, 'pending');
  assert.notDeepEqual(newer, old);
  socket.deliver({
    protocolVersion: 1,
    type: 'rollback-notice',
    delivery: { epoch: 'rollback', sequence: 1 },
    notice: {
      actorId: 'own',
      target: {
        expected: { gameId: 'assigned-game', branch: 1, version: 10 },
        beforeActionVersion: 1,
      },
      head: { gameId: 'assigned-game', branch: 2, version: 0 },
    },
  });
  assert.notEqual(client.current.penaltyStatus, 'pending');
  assert.equal(client.current.selectedCardId, null);
  client.close();
});
test('local penalty expiry clears an unsent selection without manufacturing refusal, transfer or completion', () => {
  let now = 0;
  let expire = () => {};
  const { client, sockets } = fixture(undefined, {
    now: () => now,
    scheduleReveal: (callback, delay) => {
      assert.equal(delay, 10000);
      expire = callback;
      return () => {};
    },
  });
  client.connect();
  sockets[0]!.deliver(penaltyBaseline());
  client.selectPenaltyCard('donation');
  now = 10001;
  expire();
  assert.equal(client.current.selectedCardId, null);
  assert.equal(client.current.view?.penalty?.ownResponse, null);
  assert.deepEqual(client.current.transfers, []);
  client.respondToPenalty(null);
  assert.equal(sockets[0]!.sent.length, 1, 'no expiry command or late response');
  client.close();
});
test('penalty uncertainty drops selection and observations; reconnect sends only resync', () => {
  const { client, sockets, timeout } = fixture();
  client.connect();
  sockets[0]!.deliver(penaltyBaseline());
  client.selectPenaltyCard('donation');
  client.respondToPenalty('donation');
  timeout();
  assert.equal(client.current.penaltyStatus, 'uncertain');
  assert.equal(client.current.selectedCardId, null);
  assert.deepEqual(client.current.transfers, []);
  assert.equal(client.current.view, null);
  client.connect();
  sockets[1]!.deliver(penaltyBaseline());
  assert.equal(sockets[1]!.sent.length, 1);
  assert.equal(client.current.selectedCardId, null);
  client.close();
});
function playing(sequence = 1) {
  const value = penaltyBaseline(sequence);
  Object.assign(value.view, { procedure: null });
  Object.assign(value.view.state, {
    phase: { type: 'round', number: 1, targetSize: 3, turnSeatId: 'other' },
    table: [{ id: 'bottom', face: { suit: 'spades', rank: 14 } }],
  });
  return value;
}
test('play/take/stump clicks capture exact routes without turn, beat or opening-right solvers', () => {
  const { client, sockets } = fixture();
  client.connect();
  const socket = sockets[0]!;
  socket.deliver(playing());
  for (const [type, cardId] of [
    ['play-card', 'donation'],
    ['take-bottom', undefined],
    ['open-stump', 'stump'],
  ] as const) {
    if (type === 'play-card') client.playCard(cardId!);
    else if (type === 'take-bottom') client.takeBottom();
    else client.openStump(cardId!);
    const command = socket.sent.at(-1) as { requestId: string };
    assert.deepEqual(command, {
      protocolVersion: 1,
      requestId: command.requestId,
      intent: { type, gameId: 'assigned-game', branchId: 'branch', ...(cardId ? { cardId } : {}) },
    });
    const count = socket.sent.length;
    client.takeBottom();
    assert.equal(socket.sent.length, count, 'single flight');
    assert.equal(client.current.view?.state?.own.hand.length, 2, 'no optimistic movement');
    socket.deliver({
      protocolVersion: 1,
      type: 'command-ack',
      requestId: command.requestId,
      result: {
        type: 'accepted',
        outcome: 'violation',
        duplicate: false,
        head: { gameId: 'historical', branchId: 'old', version: 99 },
      },
    });
    assert.equal(client.current.moveStatus, 'violation');
    assert.equal(client.current.view?.head.version, 1);
  }
  const count = socket.sent.length;
  client.playCard('stump');
  client.openStump('foreign');
  assert.equal(socket.sent.length, count, 'only own command handles');
  const blocked = playing(2);
  Object.assign(blocked.view, { procedure: penaltyBaseline().view.procedure });
  socket.deliver(blocked);
  client.playCard('donation');
  client.takeBottom();
  client.openStump('stump');
  assert.equal(socket.sent.length, count, 'procedures block gameplay');
  client.close();
});
test('uncertain moves clear face feedback and are not replayed; reset invalidates late acknowledgments', () => {
  const { client, sockets, timeout } = fixture();
  client.connect();
  sockets[0]!.deliver(playing());
  client.playCard('donation');
  const original = sockets[0]!.sent.at(-1) as { requestId: string };
  timeout();
  assert.equal(client.current.status, 'uncertain');
  assert.equal(client.current.moveStatus, 'uncertain');
  assert.equal(client.current.peek, null);
  client.connect();
  sockets[1]!.deliver(playing());
  assert.equal(sockets[1]!.sent.length, 1);
  client.takeBottom();
  sockets[1]!.deliver({
    protocolVersion: 1,
    type: 'rollback-notice',
    delivery: { epoch: 'rollback', sequence: 1 },
    notice: {
      actorId: 'own',
      target: {
        expected: { gameId: 'assigned-game', branch: 1, version: 10 },
        beforeActionVersion: 1,
      },
      head: { gameId: 'assigned-game', branch: 2, version: 0 },
    },
  });
  assert.notEqual(client.current.moveStatus, 'pending');
  sockets[1]!.deliver({
    protocolVersion: 1,
    type: 'command-ack',
    requestId: original.requestId,
    result: {
      type: 'accepted',
      outcome: 'played',
      duplicate: true,
      head: { gameId: 'old', branchId: 'old', version: 99 },
    },
  });
  assert.notEqual(client.current.moveStatus, 'played');
  client.close();
});
test('lobby chat survives denied game visibility on the same socket and never installs post context as game state', () => {
  const { client, sockets } = fixture();
  client.connect();
  const socket = sockets[0]!;
  socket.deliver({ protocolVersion: 1, type: 'error', code: 'unauthorized' });
  assert.equal(client.current.status, 'attached');
  client.postChat('hello');
  const post = socket.sent.at(-1) as { requestId: string; intent: { messageId: string } };
  socket.deliver({
    protocolVersion: 1,
    type: 'rollback-notice',
    delivery: { epoch: 'rollback', sequence: 1 },
    notice: {
      actorId: 'own',
      target: {
        expected: { gameId: 'assigned-game', branch: 1, version: 10 },
        beforeActionVersion: 1,
      },
      head: { gameId: 'assigned-game', branch: 2, version: 0 },
    },
  });
  socket.deliver({
    protocolVersion: 1,
    type: 'chat-page',
    requestId: post.requestId,
    messages: [
      {
        id: post.intent.messageId,
        lobbyId: 'lobby',
        authorSeatId: 'own',
        text: 'hello',
        sequence: '9',
        atMs: 1000,
        context: {
          head: { gameId: 'abandoned', branchId: 'old', version: 99 },
          scope: 'round',
          scopeNumber: 2,
        },
      },
    ],
  });
  assert.equal(client.current.view, null);
  assert.equal(client.current.chat.lastPost?.context.head?.gameId, 'abandoned');
  assert.equal(client.current.chat.cursor, '0');
  client.close();
});
test('lost chat reply retains exact durable message identity across fenced reconnect without automatic replay', () => {
  const { client, sockets, timeout } = fixture();
  client.connect();
  sockets[0]!.deliver({ protocolVersion: 1, type: 'error', code: 'unavailable' });
  client.postChat('verbatim\r\n');
  const first = sockets[0]!.sent.at(-1) as { intent: object };
  timeout();
  assert.equal(client.current.chat.retry, true);
  client.connect();
  sockets[1]!.deliver({ protocolVersion: 1, type: 'error', code: 'unavailable' });
  assert.equal(sockets[1]!.sent.length, 1);
  client.postChat('changed');
  assert.equal(sockets[1]!.sent.length, 1);
  client.retryChat();
  assert.deepEqual((sockets[1]!.sent.at(-1) as { intent: object }).intent, first.intent);
  client.close();
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
