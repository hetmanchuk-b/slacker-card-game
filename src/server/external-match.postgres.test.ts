import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Pool } from 'pg';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { Card, Suit } from '../game/cards.ts';
import type { BranchHead } from '../game/contracts.ts';
import { id } from '../game/ids.ts';
import type { SeatId } from '../game/ids.ts';
import type {
  ClientIntent,
  CommandAck,
  ServerMessage,
  StateMessage,
} from '../protocol/contracts.ts';
import type { LobbyMembership } from '../protocol/lobby.ts';
import type { VisibleCard } from '../projections/game.ts';
import type { VisibleBallot, VisibleProcedure, VisibleTimer } from '../projections/live.ts';
import { migrate } from '../persistence/postgres.ts';
import { FakeClock } from '../runtime/testing/fake-clock.ts';
import { PostgresGuestAccess } from './guest-access.ts';
import { PostgresGameHost } from './game-host.ts';
import { PenkyTransport } from './transport.ts';

const url = process.env.PENKY_TEST_DATABASE_URL;
const origin = 'https://localhost';
const cert = readFileSync(new URL('./testing/localhost-cert.pem', import.meta.url));
const key = readFileSync(new URL('./testing/localhost-key.pem', import.meta.url));

function keys(value: object, expected: readonly string[]) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}
function card(value: { id: string; face: Card }) {
  keys(value, ['id', 'face']);
  keys(value.face, ['suit', 'rank']);
  assert.match(value.id, /^[0-9a-f-]{36}$/i, 'server generates opaque face-independent handles');
}
function head(value: BranchHead) {
  keys(value, ['gameId', 'branchId', 'version']);
}
function timer(value: VisibleTimer) {
  keys(value, ['id', 'remainingMs', 'paused']);
}
function ballot(value: VisibleBallot) {
  keys(value, ['type', 'claim', 'eligibleSeatIds', 'ownVote', 'timer']);
  keys(value.claim, ['id', 'claimantId', 'accusedId', 'reason', 'scope', 'scopeNumber']);
  timer(value.timer);
}
function procedure(value: VisibleProcedure | null, peer: WireSeat) {
  if (!value) return;
  timer(value.timer);
  switch (value.type) {
    case 'claim-vote':
      ballot(value);
      break;
    case 'withdrawal':
      keys(value, ['type', 'claim', 'eligibleSeatIds', 'ownApproval', 'suspendedVote', 'timer']);
      keys(value.claim, ['id', 'claimantId', 'accusedId', 'reason', 'scope', 'scopeNumber']);
      if (value.suspendedVote) ballot(value.suspendedVote);
      break;
    case 'penalty':
      keys(value, ['type', 'recipientId', 'reason', 'eligibleSeatIds', 'ownResponse', 'timer']);
      if (value.ownResponse) {
        assert.ok(value.eligibleSeatIds.includes(peer.membership.seatId));
        keys(value.ownResponse, value.ownResponse.type === 'card' ? ['type', 'card'] : ['type']);
        if (value.ownResponse.type === 'card') card(value.ownResponse.card);
      }
      break;
  }
}

/** Each socket retains only its own received wire data. No runtime, history,
 * access binding, database query or other seat's hand is available to its strategy.
 */
class WireSeat {
  readonly messages: ServerMessage[] = [];
  readonly #listeners = new Set<() => void>();
  readonly socket: Socket;
  state: StateMessage | null = null;
  trump: Exclude<Suit, 'spades'> | null | undefined;

  readonly cookie: string;
  readonly membership: LobbyMembership;
  readonly tick: () => void;

  constructor(base: string, cookie: string, membership: LobbyMembership, tick: () => void) {
    this.cookie = cookie;
    this.membership = membership;
    this.tick = tick;
    this.socket = io(base, {
      ca: cert.toString(),
      transports: ['websocket'],
      reconnection: false,
      autoConnect: false,
      timeout: 5000,
      extraHeaders: { Origin: origin, Cookie: cookie },
    });
    this.socket.on(
      'server-message',
      (message: ServerMessage, receipt: string, acknowledge: (value: string) => void) => {
        this.messages.push(message);
        if (message.type === 'state') {
          this.state = message;
          const reveal = message.view.transient.reveal;
          if (reveal)
            this.trump = reveal.card.face.suit === 'spades' ? null : reveal.card.face.suit;
        }
        acknowledge(receipt);
        for (const listener of this.#listeners) listener();
      },
    );
  }

  async connect() {
    await new Promise<void>((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('connect_error', reject);
      this.socket.connect();
    });
  }

  async wait<T>(read: () => T | undefined, description: string): Promise<T> {
    const existing = read();
    if (existing !== undefined) return existing;
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.#listeners.delete(check);
      };
      const check = () => {
        const value = read();
        if (value !== undefined) {
          cleanup();
          resolve(value);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Missing ${description}; connected=${this.socket.connected}`));
      }, 10000);
      this.#listeners.add(check);
      check();
    });
  }

  async send(intent: ClientIntent, requestId = id('command', randomUUID())) {
    this.tick();
    const after = this.messages.length;
    const pending = this.wait(
      () =>
        this.messages.slice(after).find((message) => {
          if (message.type === 'error') return true;
          if (intent.type === 'resync') return message.type === 'state';
          if (intent.type === 'owner-history') return message.type === 'owner-history';
          return 'requestId' in message && message.requestId === requestId;
        }),
      intent.type,
    );
    this.socket.emit('client-message', { protocolVersion: 1, requestId, intent });
    return pending;
  }

  async at(target: BranchHead) {
    return this.wait(() => {
      const state = this.state;
      return state &&
        state.view.head.gameId === target.gameId &&
        state.view.head.branchId === target.branchId &&
        state.view.head.version >= target.version
        ? state
        : undefined;
    }, `state ${target.version}`);
  }

  get own() {
    const own = this.state?.view.state?.own;
    assert.ok(own);
    assert.equal(own.seatId, this.membership.seatId);
    return own;
  }

  /** Independent spec-based choice from this seat's hand, public table and its
   * remembered reveal. This is test automation, not the Stage 10 bot interface.
   */
  choose(): ClientIntent {
    const view = this.state!.view;
    assert.ok(view.state);
    const phase = view.state.phase;
    assert.ok(phase.type === 'round' || phase.type === 'between-rounds');
    assert.equal(
      phase.type === 'round' ? phase.turnSeatId : phase.leaderId,
      this.membership.seatId,
    );
    const route = { gameId: view.head.gameId, branchId: view.head.branchId };
    const own = this.own;
    if (!own.hand.length) {
      assert.ok(
        own.stumps[0],
        'an empty-handed turn needs an entitled stump; otherwise pickup is automatic',
      );
      return { type: 'open-stump', ...route, cardId: own.stumps[0] };
    }
    assert.notEqual(this.trump, undefined, 'strategy must observe the timed reveal');
    const top = view.state.table.at(-1)?.face;
    const playable = own.hand.find(
      ({ face }) =>
        !top ||
        (top.suit === face.suit
          ? face.rank > top.rank || (top.rank === 14 && face.rank === 6)
          : top.suit !== 'spades' && face.suit === this.trump),
    );
    return playable
      ? { type: 'play-card', ...route, cardId: playable.id }
      : { type: 'take-bottom', ...route };
  }
}

async function http(base: string, path: string, cookie?: string, value?: unknown) {
  const body = value === undefined ? '' : JSON.stringify(value);
  return new Promise<{ status: number; cookie?: string; body: string }>((resolve, reject) => {
    const req = request(
      new URL(path, base),
      {
        method: 'POST',
        ca: cert,
        headers: {
          Origin: origin,
          'Content-Length': Buffer.byteLength(body),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(value === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
      },
      (res) => {
        let result = '';
        res.on('data', (chunk) => {
          result += String(chunk);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            body: result,
            ...(res.headers['set-cookie']?.[0]
              ? { cookie: res.headers['set-cookie'][0].split(';')[0]! }
              : {}),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
function accepted(message: ServerMessage, outcome: 'played' | 'violation' | 'control' = 'played') {
  if (message.type !== 'command-ack' || message.result.type !== 'accepted')
    assert.fail(JSON.stringify(message));
  assert.equal(message.result.outcome, outcome);
  return message as CommandAck & { result: Extract<CommandAck['result'], { type: 'accepted' }> };
}

function assertPrivacy(peer: WireSeat, actors: ReadonlyMap<string, SeatId>) {
  let sequence = 0;
  let epoch = '';
  const seenEpochs = new Set<string>();
  for (const message of peer.messages) {
    assert.equal(message.protocolVersion, 1);
    if ('delivery' in message) {
      keys(message.delivery, ['epoch', 'sequence']);
      if (message.delivery.epoch !== epoch) {
        assert.equal(
          seenEpochs.has(message.delivery.epoch),
          false,
          'obsolete epochs cannot return',
        );
        epoch = message.delivery.epoch;
        seenEpochs.add(epoch);
        sequence = 0;
      }
      assert.ok(message.delivery.sequence > sequence);
      sequence = message.delivery.sequence;
    }
    switch (message.type) {
      case 'state': {
        keys(message, ['protocolVersion', 'type', 'delivery', 'view']);
        keys(message.view, ['head', 'state', 'transient', 'procedure', 'control']);
        head(message.view.head);
        const state = message.view.state;
        assert.ok(state);
        keys(state, ['viewer', 'players', 'own', 'deckCount', 'table', 'discardCount', 'phase']);
        keys(state.viewer, ['type', 'seatId']);
        const phase = state.phase;
        keys(
          phase,
          phase.type === 'round'
            ? ['type', 'number', 'targetSize', 'turnSeatId']
            : phase.type === 'between-rounds'
              ? ['type', 'leaderId', 'nextRoundNumber']
              : phase.type === 'finished'
                ? ['type', 'result']
                : ['type'],
        );
        if (phase.type === 'finished')
          keys(
            phase.result,
            phase.result.type === 'last-player'
              ? ['type', 'loserId']
              : phase.result.type === 'draw'
                ? ['type', 'remainingSeatIds']
                : ['type'],
          );
        procedure(message.view.procedure, peer);
        const control = message.view.control;
        keys(control, ['paused', 'connections', 'replacementVote']);
        for (const connection of control.connections)
          keys(connection, ['seatId', 'connected', 'controller']);
        if (control.replacementVote) {
          keys(control.replacementVote, ['absentSeatId', 'eligibleSeatIds', 'ownVote', 'timer']);
          timer(control.replacementVote.timer);
        }
        assert.equal(state.own!.seatId, peer.membership.seatId);
        keys(state.own!, ['seatId', 'hand', 'stumps']);
        for (const player of state.players)
          keys(player, ['id', 'status', 'handCount', 'stumpCount']);
        state.own!.hand.forEach(card);
        state.table.forEach(card);
        for (const stump of state.own!.stumps) assert.match(stump, /^[0-9a-f-]{36}$/i);
        keys(message.view.transient, ['initialRecipientNotice', 'reveal']);
        if (message.view.transient.reveal) {
          keys(message.view.transient.reveal, ['card', 'recipientId', 'timer']);
          timer(message.view.transient.reveal.timer);
          card(message.view.transient.reveal.card);
        }
        break;
      }
      case 'action':
        keys(message, ['protocolVersion', 'type', 'delivery', 'view']);
        keys(message.view, ['head', 'commandId', 'observations']);
        head(message.view.head);
        for (const observation of message.view.observations) {
          const fields = {
            'card-drawn': ['type', 'seatId', 'destination', 'card'],
            'draw-rejected': ['type', 'seatId'],
            'card-played': ['type', 'seatId', 'card'],
            'bottom-taken': ['type', 'seatId', 'card', 'automatic'],
            'stump-opened': ['type', 'seatId', 'card'],
            'stump-peeked': ['type', 'card'],
            violation: ['type', 'seatId', 'reason'],
            'penalty-transfer': ['type', 'fromSeatId', 'toSeatId', 'card'],
          };
          keys(observation, fields[observation.type]);
          if (observation.type === 'stump-peeked')
            assert.equal(actors.get(message.view.commandId), peer.membership.seatId);
          if ('card' in observation && observation.card) card(observation.card);
          if (observation.type === 'card-drawn' || observation.type === 'stump-opened') {
            if (
              observation.seatId !== peer.membership.seatId ||
              (observation.type === 'card-drawn' && observation.destination === 'stump')
            )
              assert.equal(observation.card, null);
          }
          if (observation.type === 'penalty-transfer')
            assert.ok(
              [observation.fromSeatId, observation.toSeatId].includes(peer.membership.seatId),
            );
        }
        break;
      case 'command-ack':
        keys(message, ['protocolVersion', 'type', 'requestId', 'result']);
        keys(
          message.result,
          message.result.type === 'accepted'
            ? ['type', 'outcome', 'head', 'duplicate']
            : ['type', 'code', 'head'],
        );
        head(message.result.head);
        break;
      case 'error':
        keys(message, ['protocolVersion', 'type', 'code']);
        break;
      case 'match-start-ack':
        keys(message, ['protocolVersion', 'type', 'requestId', 'result']);
        keys(
          message.result,
          message.result.type === 'started' ? ['type', 'gameId', 'duplicate'] : ['type', 'code'],
        );
        break;
      case 'owner-history':
        assert.equal(peer.membership.isOwner, true);
        assert.doesNotMatch(
          JSON.stringify(message.view),
          /"(?:face|cardId|cards|hand|stumps|events|state|observations|branchId|commandId|eventId|claimId|procedureId|peekedStumps|openingRights|repetition)":/,
        );
        break;
      case 'rollback-notice':
        keys(message, ['protocolVersion', 'type', 'delivery', 'notice']);
        keys(message.notice, ['actorId', 'target', 'head']);
        break;
      case 'chat-page':
        keys(message, ['protocolVersion', 'type', 'requestId', 'messages']);
        for (const chat of message.messages)
          keys(chat, ['id', 'lobbyId', 'authorSeatId', 'text', 'sequence', 'atMs', 'context']);
        break;
    }
  }
}

test(
  'external complete matches from authenticated lobby APIs',
  { skip: !url, timeout: 240000 },
  async (t) => {
    assert.ok(new URL(url!).pathname.endsWith('_test'));
    const pool = new Pool({
      connectionString: url,
      max: 20,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });
    pool.on('error', () => {});
    t.after(() => pool.end());
    await migrate(pool);

    async function setup(t: TestContext, count: number) {
      let wall = 1000;
      const clock = new FakeClock(1000);
      const host = new PostgresGameHost(pool, {
        inputs: () => ({
          clock,
          randomInt: (upper) => upper - 1,
          nextCommandId: () => id('command', randomUUID()),
        }),
      });
      const transport = new PenkyTransport({
        access: new PostgresGuestAccess(pool),
        host,
        tls: { key, cert },
        origins: [origin],
        now: () => wall,
        authPollMs: 60000,
      });
      const base = await transport.listen(0, '127.0.0.1');
      const peers: WireSeat[] = [];
      t.after(async () => {
        peers.forEach((peer) => peer.socket.disconnect());
        await transport.close();
        await host.close();
      });
      let lobbyId: LobbyMembership['lobbyId'] | undefined;
      for (let index = 0; index < count; index++) {
        wall += 10001; // Exercise real limits without wall-clock sleeps or bypasses.
        const issued = await http(base, '/api/guest/session');
        assert.equal(issued.status, 204);
        assert.ok(issued.cookie);
        const creationKey = randomUUID();
        const membership = await http(
          base,
          lobbyId ? '/api/lobbies/join' : '/api/lobbies',
          issued.cookie,
          lobbyId ? { lobbyId } : { requestId: creationKey },
        );
        assert.equal(membership.status, 200);
        const retried = await http(
          base,
          lobbyId ? '/api/lobbies/join' : '/api/lobbies',
          issued.cookie,
          lobbyId ? { lobbyId } : { requestId: creationKey },
        );
        assert.equal(retried.status, 200);
        assert.equal(retried.body, membership.body);
        const binding: LobbyMembership = JSON.parse(membership.body);
        keys(binding, ['lobbyId', 'seatId', 'position', 'isOwner']);
        assert.equal(binding.position, index);
        assert.equal(binding.isOwner, index === 0);
        lobbyId = binding.lobbyId;
        const peer = new WireSeat(base, issued.cookie, binding, () => {
          wall += 1001;
        });
        peers.push(peer);
        await peer.connect();
        assert.deepEqual(await peer.send({ type: 'resync', lobbyId }), {
          protocolVersion: 1,
          type: 'error',
          code: 'unavailable',
        });
      }
      assert.ok(lobbyId);
      const owner = peers[0]!;
      const acceptAll = async () => {
        wall += 10001;
        const state = await http(base, '/api/lobbies/state', owner.cookie, { lobbyId });
        assert.equal(state.status, 200);
        const revision = JSON.parse(state.body).revision;
        const confirmations = await Promise.all(
          peers.map((peer) => {
            wall += 1001;
            return http(base, '/api/lobbies/ready', peer.cookie, {
              lobbyId,
              expectedRevision: revision,
              ready: true,
            });
          }),
        );
        assert.ok(confirmations.every((reply) => reply.status === 200));
      };
      await acceptAll();
      const startId = id('command', randomUUID());
      const startIntent = { type: 'start-match', lobbyId, expected: null } as const;
      const started = await owner.send(startIntent, startId);
      assert.equal(started.type, 'match-start-ack');
      if (started.type !== 'match-start-ack' || started.result.type !== 'started') assert.fail();
      const repeatedStart = await owner.send(startIntent, startId);
      assert.deepEqual(repeatedStart, {
        ...started,
        result: { ...started.result, duplicate: true },
      });
      for (const peer of peers) {
        const baseline = await peer.send({ type: 'resync', lobbyId });
        assert.equal(baseline.type, 'state');
        assert.equal(peer.state!.view.head.gameId, started.result.gameId);
      }
      const actors = new Map<string, SeatId>();
      const duplicateIds = new Set<string>();
      const route = () => ({
        gameId: owner.state!.view.head.gameId,
        branchId: owner.state!.view.head.branchId,
      });
      const sync = async (head: BranchHead) => {
        await Promise.all(peers.map((peer) => peer.at(head)));
        const canonical = owner.state!.view.state!;
        const shared = (state: NonNullable<StateMessage['view']['state']>) => ({
          players: state.players,
          deckCount: state.deckCount,
          discardCount: state.discardCount,
          table: state.table,
          phase: state.phase,
        });
        const handles: string[] = canonical.table.map((card) => card.id);
        for (const peer of peers) {
          const state = peer.state!.view.state!;
          assert.deepEqual(shared(state), shared(canonical));
          const player = state.players.find((player) => player.id === peer.membership.seatId)!;
          assert.equal(peer.own.hand.length, player.handCount);
          assert.equal(peer.own.stumps.length, player.stumpCount);
          handles.push(...peer.own.hand.map((card) => card.id), ...peer.own.stumps);
          for (const other of peers.filter((other) => other !== peer))
            for (const stump of peer.own.stumps)
              assert.equal(
                JSON.stringify(other.state!.view).includes(stump),
                false,
                'other seats cannot receive closed stump handles',
              );
        }
        assert.equal(new Set(handles).size, handles.length, 'wire card handles remain disjoint');
        assert.equal(
          canonical.deckCount +
            canonical.discardCount +
            canonical.table.length +
            canonical.players.reduce(
              (sum, player) => sum + player.handCount + player.stumpCount,
              0,
            ),
          36,
        );
      };
      const command = async (
        peer: WireSeat,
        intent: ClientIntent,
        outcome: 'played' | 'violation' | 'control' = 'played',
        duplicate = false,
      ) => {
        const requestId = id('command', randomUUID());
        actors.set(requestId, peer.membership.seatId);
        const result = accepted(await peer.send(intent, requestId), outcome);
        await sync(result.result.head);
        if (duplicate) {
          const current = structuredClone(peer.state);
          const repeated = accepted(await peer.send(intent, requestId), outcome);
          assert.equal(repeated.result.duplicate, true);
          assert.deepEqual(repeated.result.head, result.result.head);
          assert.deepEqual(
            peer.state,
            current,
            'historical duplicate ack must not change the live cursor',
          );
          duplicateIds.add(requestId);
        }
        return result;
      };
      return {
        base,
        peers,
        owner,
        clock,
        lobbyId,
        route,
        sync,
        command,
        actors,
        duplicateIds,
        acceptAll,
      };
    }

    type Context = Awaited<ReturnType<typeof setup>>;

    async function settlePenalty(context: Context, contribute = false) {
      const { peers, owner, command, route } = context;
      const procedure = owner.state!.view.procedure;
      assert.equal(procedure?.type, 'penalty');
      if (procedure?.type !== 'penalty') assert.fail();
      let donated: VisibleCard | undefined;
      const donorId = contribute ? procedure.eligibleSeatIds[0] : undefined;
      let lastCommand = '';
      for (const seatId of procedure.eligibleSeatIds) {
        const peer = peers.find((peer) => peer.membership.seatId === seatId)!;
        let cardId: VisibleCard['id'] | null = null;
        // Publicly designate one donor; no seat's response depends on another
        // seat's private hand/selection. All remaining seats refuse independently.
        if (seatId === donorId) {
          assert.ok(peer.own.hand.length > 1);
          donated = peer.own.hand[0]!;
          cardId = donated.id;
        }
        const result = await command(peer, {
          type: 'penalty-response',
          ...route(),
          procedureId: procedure.timer.id,
          cardId,
        });
        lastCommand = result.requestId;
      }
      assert.equal(owner.state!.view.procedure, null);
      if (contribute) {
        assert.ok(donated);
        for (const peer of peers) {
          const action = peer.messages.find(
            (message) => message.type === 'action' && message.view.commandId === lastCommand,
          );
          assert.ok(action?.type === 'action');
          const transfers = action.view.observations.filter(
            (observation) => observation.type === 'penalty-transfer',
          );
          assert.equal(
            transfers.length,
            [donorId, procedure.recipientId].includes(peer.membership.seatId) ? 1 : 0,
          );
          if (transfers[0]) assert.deepEqual(transfers[0].card, donated);
        }
      }
    }

    async function dealingProcedures(context: Context, first: number) {
      const { peers, owner, command, route, lobbyId } = context;
      await command(
        peers[(first + 1) % peers.length]!,
        { type: 'draw-card', ...route() },
        'violation',
        true,
      );
      assert.equal(owner.state!.view.state!.deckCount, 36);
      const author = peers[1]!;
      const post = {
        type: 'post-chat',
        lobbyId,
        messageId: id('message', randomUUID()),
        text: 'Exact retained chat — original dealing episode',
      } as const;
      const posted = await author.send(post);
      assert.equal(posted.type, 'chat-page');
      if (posted.type !== 'chat-page') assert.fail();
      const original = posted.messages[0]!;
      assert.equal(original.authorSeatId, author.membership.seatId);
      assert.equal(original.text, post.text);
      const retried = await author.send(post);
      assert.ok(retried.type === 'chat-page');
      assert.deepEqual(retried.messages, posted.messages);
      const claim = {
        type: 'submit-claim',
        ...route(),
        accusedId: author.membership.seatId,
        reason: 'A chat-backed episode',
        evidence: { type: 'chat', messageId: post.messageId },
      } as const;
      await command(owner, claim, 'played', true);
      const ballot = owner.state!.view.procedure;
      assert.ok(ballot?.type === 'claim-vote');
      assert.equal(ballot.claim.scope, 'dealing');
      await command(owner, { type: 'request-withdrawal', ...route(), claimId: ballot.claim.id });
      const withdrawal = owner.state!.view.procedure;
      assert.ok(withdrawal?.type === 'withdrawal');
      for (const seatId of withdrawal.eligibleSeatIds) {
        const peer = peers.find((peer) => peer.membership.seatId === seatId)!;
        await command(peer, {
          type: 'withdrawal-response',
          ...route(),
          procedureId: withdrawal.timer.id,
          approve: true,
        });
      }
      assert.equal(owner.state!.view.procedure, null);
      const handled = await owner.send(claim);
      assert.ok(handled.type === 'command-ack' && handled.result.type === 'rejected');
      assert.equal(handled.result.code, 'incident-already-handled');
      return original;
    }

    async function adminAndReconnect(context: Context) {
      const { peers, owner, command, route, sync, lobbyId } = context;
      // This intentional rule-breaking attempt is observed privately, never replayed.
      const beforePeek = peers.map((peer) => structuredClone(peer.state!.view.state));
      const stumpId = owner.own.stumps[0]!;
      const peek = await command(
        owner,
        { type: 'open-stump', ...route(), cardId: stumpId },
        'violation',
        true,
      );
      for (const [index, peer] of peers.entries()) {
        const observations = peer.messages.flatMap((message) =>
          message.type === 'action' && message.view.commandId === peek.requestId
            ? message.view.observations.filter((observation) => observation.type === 'stump-peeked')
            : [],
        );
        assert.equal(
          observations.length,
          peer === owner ? 1 : 0,
          'one fresh peek only reaches its actor',
        );
        if (observations[0]) assert.equal(observations[0].card.id, stumpId);
        assert.deepEqual(
          peer.state!.view.state,
          beforePeek[index],
          'peek never moves the stump or changes hands',
        );
      }
      await settlePenalty(context);
      const history = await owner.send({ type: 'owner-history', gameId: route().gameId });
      assert.ok(history.type === 'owner-history');
      for (const peer of peers)
        for (const cardId of [...peer.own.hand.map((card) => card.id), ...peer.own.stumps])
          assert.equal(
            JSON.stringify(history).includes(cardId),
            false,
            'owner history cannot preview even known card handles',
          );
      const active = history.view.branches.find((branch) => branch.label === 'active')!;
      const target = active.actions.find(
        (action) => action.version === peek.result.head.version,
      )!.rollbackTarget;
      assert.ok(target);
      assert.deepEqual(await peers[1]!.send({ type: 'owner-history', gameId: route().gameId }), {
        protocolVersion: 1,
        type: 'error',
        code: 'unauthorized',
      });
      const oldBranch = route();
      await command(
        owner,
        { type: 'rollback', target, knowledgeWarningAcknowledged: true },
        'control',
        true,
      );
      assert.notEqual(route().branchId, oldBranch.branchId);
      for (const [index, peer] of peers.entries())
        assert.deepEqual(
          peer.state!.view.state,
          beforePeek[index],
          'rollback restores the selected pre-action card/phase projection',
        );
      const restoredHistory = await owner.send({ type: 'owner-history', gameId: route().gameId });
      assert.ok(restoredHistory.type === 'owner-history');
      const restored = restoredHistory.view.branches.find((branch) => branch.label === 'active')!;
      const abandoned = restoredHistory.view.branches.find(
        (branch) => branch.head.branch === active.head.branch,
      )!;
      const withoutSelectors = (rows: typeof active.actions) =>
        rows.map(({ version, origin, occurredAtMs, summaries }) => ({
          version,
          origin,
          occurredAtMs,
          summaries,
        }));
      assert.equal(abandoned.label, 'abandoned');
      assert.deepEqual(
        withoutSelectors(abandoned.actions),
        withoutSelectors(active.actions),
        'abandoned future remains intact',
      );
      assert.deepEqual(restored.parent, {
        ...history.view.head,
        version: target.beforeActionVersion - 1,
      });
      assert.deepEqual(
        withoutSelectors(restored.actions.slice(0, target.beforeActionVersion - 1)),
        withoutSelectors(active.actions.slice(0, target.beforeActionVersion - 1)),
        'restored timeline inherits exactly the selected prefix',
      );
      assert.equal(
        restoredHistory.view.rollbacks.length,
        1,
        'retry cannot append another rollback audit',
      );
      const audit = restoredHistory.view.rollbacks[0]!;
      assert.deepEqual(audit.beforeAction, {
        branch: history.view.head.branch,
        version: target.beforeActionVersion,
      });
      assert.deepEqual(audit.parent, restored.parent);
      assert.ok(
        restored.actions.some((row) =>
          row.summaries.some((summary) => summary.type === 'rollback'),
        ),
      );
      assert.equal(
        restored.actions.some((row) =>
          row.summaries.some(
            (summary) => summary.type === 'violation' && summary.reason === 'peek',
          ),
        ),
        false,
      );
      for (const peer of peers)
        assert.equal(
          peer.messages.filter((message) => message.type === 'rollback-notice').length,
          1,
        );
      const stale = await owner.send({ type: 'draw-card', ...oldBranch });
      assert.ok(stale.type === 'command-ack' && stale.result.type === 'rejected');
      assert.equal(stale.result.code, 'wrong-branch');

      const absent = peers[1]!;
      await command(owner, {
        type: 'submit-claim',
        ...route(),
        accusedId: absent.membership.seatId,
        reason: 'Pause/resume an external ballot',
        evidence: { type: 'spoken', key: randomUUID() },
      });
      let ballot = owner.state!.view.procedure;
      assert.ok(ballot?.type === 'claim-vote');
      await command(owner, {
        type: 'cast-vote',
        ...route(),
        procedureId: ballot.timer.id,
        vote: 'yes',
      });
      await context.clock.advanceBy(4000);
      absent.socket.disconnect();
      await owner.wait(
        () => (owner.state!.view.control.paused ? true : undefined),
        'disconnect suspension',
      );
      ballot = owner.state!.view.procedure;
      assert.ok(ballot?.type === 'claim-vote');
      assert.equal(ballot.timer.paused, true);
      assert.equal(ballot.timer.remainingMs, 6000);
      const suspended = await owner.send({ type: 'take-bottom', ...route() });
      assert.ok(suspended.type === 'command-ack' && suspended.result.type === 'rejected');
      assert.equal(suspended.result.code, 'game-suspended');
      await context.clock.advanceBy(31001);
      assert.equal(owner.state!.view.procedure?.timer.remainingMs, 6000);
      const returned = new WireSeat(context.base, absent.cookie, absent.membership, absent.tick);
      returned.trump = absent.trump; // The same human retains previously permitted memory.
      peers[1] = returned;
      await returned.connect();
      const baseline = await returned.send({ type: 'resync', lobbyId });
      assert.equal(baseline.type, 'state');
      assert.equal(returned.messages.filter((message) => message.type === 'action').length, 0);
      await owner.wait(
        () => (!owner.state!.view.control.paused ? true : undefined),
        'reconnected ballot',
      );
      await sync(owner.state!.view.head);
      ballot = owner.state!.view.procedure;
      assert.ok(ballot?.type === 'claim-vote');
      assert.equal(ballot.timer.remainingMs, 6000);
      assert.equal(ballot.timer.paused, false);
      for (const seatId of ballot.eligibleSeatIds) {
        const peer = peers.find((peer) => peer.membership.seatId === seatId)!;
        const ownBallot = peer.state!.view.procedure;
        assert.ok(ownBallot?.type === 'claim-vote');
        if (ownBallot.ownVote === null)
          await command(peer, {
            type: 'cast-vote',
            ...route(),
            procedureId: ownBallot.timer.id,
            vote: 'abstain',
          });
      }
      assert.equal(owner.state!.view.procedure?.type, 'penalty');
      await settlePenalty(context);
      return absent;
    }

    for (const count of [2, 4, 8]) {
      await t.test(
        `${count} isolated seats finish from wire observations without trusted gameplay setup`,
        async (t) => {
          const context = await setup(t, count);
          const { peers, owner, route, sync, command } = context;
          const first = peers.findIndex(
            (peer) => peer.state!.view.transient.initialRecipientNotice,
          );
          assert.notEqual(first, -1);
          assert.equal(
            peers.filter((peer) => peer.state!.view.transient.initialRecipientNotice).length,
            1,
          );
          const originalChat = count === 4 ? await dealingProcedures(context, first) : null;
          for (let draw = 0; draw < 36; draw++) {
            const actor = peers[(first + draw) % count]!;
            await command(actor, { type: 'draw-card', ...route() }, 'played', draw === 0);
            assert.equal(owner.state!.view.state!.deckCount, 35 - draw);
          }
          for (const peer of peers) {
            assert.equal(peer.state!.view.state!.phase.type, 'trump-reveal');
            assert.notEqual(peer.trump, undefined);
          }
          await context.clock.advanceBy(10000);
          await owner.wait(() => {
            const phase = owner.state?.view.state?.phase.type;
            return phase && phase !== 'trump-reveal' ? true : undefined;
          }, 'reveal expiry');
          await sync(owner.state!.view.head);
          for (const peer of peers) {
            assert.equal(peer.state!.view.transient.reveal, null);
            assert.equal(peer.state!.view.transient.initialRecipientNotice, false);
          }
          if (count === 4) await settlePenalty(context, true);
          const retired = count === 4 ? await adminAndReconnect(context) : null;
          if (originalChat) {
            const page = await owner.send({
              type: 'chat-history',
              lobbyId: context.lobbyId,
              afterSequence: '0',
              limit: 100,
            });
            assert.ok(page.type === 'chat-page');
            assert.deepEqual(
              page.messages,
              [originalChat],
              'rollback/reconnect retain exact original chat context',
            );
          }
          const seen = new Set<string>();
          for (const peer of peers)
            for (const value of [...peer.own.hand.map((card) => card.id), ...peer.own.stumps]) {
              assert.equal(seen.has(value), false);
              seen.add(value);
            }
          assert.equal(seen.size, 36);
          const repeatedTypes = new Set<string>();
          for (let step = 0; step < 1000; step++) {
            const state = owner.state!.view.state!;
            if (state.phase.type === 'finished') break;
            assert.equal(owner.state!.view.procedure, null);
            const phase = state.phase;
            assert.ok(phase.type === 'round' || phase.type === 'between-rounds');
            const actorId = phase.type === 'round' ? phase.turnSeatId : phase.leaderId;
            const actor = peers.find((peer) => peer.membership.seatId === actorId)!;
            const intent = actor.choose();
            const duplicate =
              !repeatedTypes.has(intent.type) &&
              (intent.type === 'play-card' || intent.type === 'open-stump');
            await command(actor, intent, 'played', duplicate);
            if (duplicate) repeatedTypes.add(intent.type);
            if (step === 999) assert.fail('wire-only match exceeded its bounded regression budget');
          }
          const phase = owner.state!.view.state!.phase;
          assert.equal(phase.type, 'finished');
          for (const peer of peers) {
            assert.deepEqual(peer.state!.view.state!.phase, phase);
          }
          if (phase.type !== 'finished') assert.fail();
          const active = owner
            .state!.view.state!.players.filter((player) => player.status === 'active')
            .map((player) => player.id);
          if (phase.result.type === 'last-player') assert.deepEqual(active, [phase.result.loserId]);
          else if (phase.result.type === 'all-won') assert.equal(active.length, 0);
          else assert.deepEqual(active, phase.result.remainingSeatIds);
          const allPeers = retired ? [...peers, retired] : peers;
          for (const requestId of context.duplicateIds) {
            // A reconnect may change sockets, never authorize replay of an old observation.
            for (const seatId of peers.map((peer) => peer.membership.seatId))
              assert.equal(
                allPeers
                  .filter((peer) => peer.membership.seatId === seatId)
                  .flatMap((peer) => peer.messages)
                  .filter(
                    (message) => message.type === 'action' && message.view.commandId === requestId,
                  ).length,
                1,
              );
          }
          await context.acceptAll();
          const beforeSuccessor = peers.map((peer) => peer.messages.length);
          const nextId = id('command', randomUUID());
          const nextIntent = {
            type: 'start-match',
            lobbyId: context.lobbyId,
            expected: owner.state!.view.head,
          } as const;
          const successor = await owner.send(nextIntent, nextId);
          assert.ok(successor.type === 'match-start-ack' && successor.result.type === 'started');
          const successorGameId = successor.result.gameId;
          assert.notEqual(successorGameId, nextIntent.expected.gameId);
          assert.deepEqual(await owner.send(nextIntent, nextId), {
            ...successor,
            result: { ...successor.result, duplicate: true },
          });
          for (const [index, peer] of peers.entries()) {
            await peer.wait(
              () => (peer.state?.view.head.gameId === successorGameId ? true : undefined),
              'committed successor baseline',
            );
            assert.equal(peer.state!.view.state!.phase.type, 'dealing');
            assert.equal(
              peer.messages
                .slice(beforeSuccessor[index])
                .filter((message) => message.type === 'action').length,
              0,
            );
          }
          for (const peer of allPeers) assertPrivacy(peer, context.actors);
        },
      );
    }
  },
);
