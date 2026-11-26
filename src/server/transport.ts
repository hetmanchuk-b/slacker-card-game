import type { CaptureHandle } from './capture-store.ts';
import { makeOwnerHistoryPage } from '../protocol/history-page.ts';
import { projectOwnerHistory } from '../projections/history.ts';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:https';
import type { Server as HttpsServer, ServerOptions } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TLSSocket } from 'node:tls';
import { Server } from 'socket.io';
import type { Socket } from 'socket.io';
import type { LobbyId, SeatId, BranchId } from '../game/ids.ts';
import type {
  ClaimRequest,
  DispatchOptions,
  RuntimeCommand,
  RuntimePublication,
} from '../runtime/runtime.ts';
import type { HostPublication } from './game-host.ts';
import type { RollbackNotice } from '../projections/history.ts';
import { AcknowledgedOutbound } from './outbound.ts';
import { RuntimeAdmissionError } from '../runtime/runtime.ts';
import { GameHostError } from './game-host.ts';
import { decodeClientMessage } from '../protocol/decode.ts';
import {
  makeActionMessage,
  makeOwnerHistoryMessage,
  makeMatchStartAck,
  makeRollbackNoticeMessage,
  makeCommandAck,
  makeStateMessage,
  protocolError,
} from '../protocol/messages.ts';
import type { ClientMessage, ServerMessage, TechnicalError } from '../protocol/contracts.ts';
import { GuestAccessError } from './guest-access.ts';
import type { PostgresGuestAccess } from './guest-access.ts';
import type { PostgresGameHost } from './game-host.ts';
import {
  GUEST_COOKIE_NAME,
  allowedGuestOrigin,
  clearGuestCookie,
  guestCookie,
  guestTokenHash,
  readGuestCookie,
} from './guest-session.ts';
import { TransportLimiter } from './transport-limits.ts';
import { ChatAdmissionError } from '../persistence/lobby.ts';
import { boundedChatPage } from './chat-page.ts';
import type { ChatMessage } from '../persistence/lobby-contracts.ts';
import { decodeLobbyRequest, lobbyMembership, LOBBY_BODY_MAX_BYTES } from '../protocol/lobby.ts';
import {
  decodeWorkflow,
  lobbyWorkflow,
  WORKFLOW_BODY_MAX_BYTES,
} from '../protocol/lobby-workflow.ts';

const GAMEPLAY_TYPES = new Set([
  'draw-card',
  'play-card',
  'take-bottom',
  'open-stump',
  'penalty-response',
  'cast-vote',
  'request-withdrawal',
  'withdrawal-response',
  'propose-bot',
  'replacement-vote',
  'submit-claim',
]);

/** Explicit server-owned binding. Never spread a browser intent into a command. */
function gameplayCommand(message: ClientMessage, actorId: SeatId): RuntimeCommand | null {
  const intent = message.intent;
  switch (intent.type) {
    case 'draw-card':
      return { type: 'draw-card', id: message.requestId, actorId };
    case 'play-card':
      return { type: 'play-card', id: message.requestId, actorId, cardId: intent.cardId };
    case 'take-bottom':
      return { type: 'take-bottom', id: message.requestId, actorId };
    case 'open-stump':
      return { type: 'open-stump', id: message.requestId, actorId, cardId: intent.cardId };
    case 'penalty-response':
      return {
        type: 'penalty-response',
        id: message.requestId,
        actorId,
        procedureId: intent.procedureId,
        cardId: intent.cardId,
      };
    case 'cast-vote':
      return {
        type: 'cast-vote',
        id: message.requestId,
        actorId,
        procedureId: intent.procedureId,
        vote: intent.vote,
      };
    case 'request-withdrawal':
      return {
        type: 'request-withdrawal',
        id: message.requestId,
        actorId,
        claimId: intent.claimId,
      };
    case 'withdrawal-response':
      return {
        type: 'withdrawal-response',
        id: message.requestId,
        actorId,
        procedureId: intent.procedureId,
        approve: intent.approve,
      };
    case 'propose-bot':
      return { type: 'propose-bot', id: message.requestId, actorId, seatId: intent.absentSeatId };
    case 'replacement-vote':
      return {
        type: 'replacement-vote',
        id: message.requestId,
        actorId,
        procedureId: intent.procedureId,
        vote: intent.vote,
      };
    default:
      return null;
  }
}

type Peer = {
  socket: Socket;
  cancellation: AbortController;
  token: string;
  closed: boolean;
  lobbyId: LobbyId | null;
  detach: (() => Promise<void>) | null;
  pending: Promise<void>;
  cleanup: Promise<void>;
  queued: number;
  sequence: number;
  streamId: string;
  outbound: AcknowledgedOutbound;
  watch: number;
  stopWatch: (() => void) | null;
  generation: number;
  epoch: string | null;
  branch: BranchId | null;
  seatId: SeatId | null;
  publications: {
    capture: CaptureHandle;
    publication: RuntimePublication;
    rollback?: RollbackNotice;
    epoch: string;
    generation: number;
    bytes: number;
  }[];
  publicationBytes: number;
  publishing: boolean;
};
const DELIVERY = {
  jobs: 64,
  captureBytes: 4194304,
  messages: 32,
  bytes: 262144,
  ackTimeoutMs: 2000,
};
export type TransportOptions = Readonly<{
  tls: Pick<ServerOptions, 'key' | 'cert'>;
  origins: readonly string[];
  access: PostgresGuestAccess;
  host: PostgresGameHost;
  now?: () => number;
  /** Non-refreshing durable credential check cadence, not a gameplay timer. */
  authPollMs?: number;
  /** Trusted technical bounds, never browser configuration. */
  delivery?: Partial<typeof DELIVERY>;
}>;

/** TLS guest/lobby lifecycle, seat-private resync and explicit guarded intents.
 * No proxy trust or insecure mode.
 * The caller owns migrations, host and pool; close transport before either.
 */
export class PenkyTransport {
  readonly #server: HttpsServer;
  readonly #io: Server;
  readonly #options: TransportOptions;
  readonly #now: () => number;
  readonly #rates = new TransportLimiter();
  readonly #peers = new Set<Peer>();
  readonly #jobs = new Set<Promise<unknown>>();
  readonly #timer: ReturnType<typeof setInterval>;
  readonly #delivery: typeof DELIVERY;
  #checking: Promise<void> | null = null;
  #closed = false;
  #closing: Promise<void> | null = null;

  constructor(options: TransportOptions) {
    if (
      !options.tls.key ||
      !options.tls.cert ||
      !options.origins.length ||
      options.origins.some((value) => !allowedGuestOrigin(value, options.origins)) ||
      !Number.isSafeInteger(options.authPollMs ?? 1000) ||
      (options.authPollMs ?? 1000) < 10 ||
      (options.authPollMs ?? 1000) > 60000
    )
      throw new Error('Invalid transport configuration');
    this.#delivery = { ...DELIVERY, ...options.delivery };
    if (
      Object.values(this.#delivery).some((value) => !Number.isSafeInteger(value) || value < 1) ||
      this.#delivery.ackTimeoutMs > 60000
    )
      throw new Error('Invalid delivery bounds');
    this.#options = { ...options, origins: [...options.origins] };
    this.#now = options.now ?? Date.now;
    this.#server = createServer(
      { ...options.tls, minVersion: 'TLSv1.2', maxHeaderSize: 16384 },
      (req, res) => {
        void this.#track(this.#http(req, res));
      },
    );
    this.#server.headersTimeout = 5000;
    this.#server.requestTimeout = 10000;
    this.#server.maxHeadersCount = 40;
    this.#io = new Server(this.#server, {
      serveClient: false,
      maxHttpBufferSize: 16384,
      perMessageDeflate: false,
      connectTimeout: 5000,
      cors: {
        origin: (value, done) => done(null, allowedGuestOrigin(value, this.#options.origins)),
        credentials: true,
      },
      allowRequest: (req, done) =>
        done(
          null,
          !this.#closed &&
            this.#io.engine.clientsCount < 256 &&
            this.#origin(req) &&
            this.#rates.take(`connect:${req.socket.remoteAddress}`, this.#now(), 60, 60000),
        ),
    });
    // CORS is not WebSocket access control. Check actual TLS and exact Origin on
    // polling requests AND upgrades, not only the initial browser handshake.
    this.#io.engine.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
      if (this.#closed || !this.#origin(req)) {
        res.writeHead(403);
        res.end();
        return;
      }
      next();
    });
    this.#io.engine.on('connection', (connection) => {
      connection.prependListener('packet', (packet: { type: string; data?: unknown }) => {
        // Reject binary-event headers before accepting attachment streams. The
        // Engine.IO packet byte limit also applies before JSON decoding.
        if (
          packet.type === 'message' &&
          (typeof packet.data !== 'string' || /^[56]/.test(packet.data))
        )
          connection.close();
      });
    });
    this.#io.use((socket, next) => {
      void this.#track(this.#admit(socket, next));
    });
    this.#io.on('connection', (socket) => {
      const peer = [...this.#peers].find((item) => item.socket === socket);
      if (!peer || peer.closed) {
        socket.disconnect(true);
        return;
      }
      socket.onAny((event: string, ...args: unknown[]) => {
        if (!this.#live(peer)) return;
        const credential = guestTokenHash(peer.token)!;
        if (
          peer.queued >= 4 ||
          !this.#rates.take(`socket:${peer.socket.id}`, this.#now(), 20, 1000) ||
          !this.#rates.take(`credential:${credential}`, this.#now(), 120, 60000)
        ) {
          this.#error(peer, 'unavailable');
          this.#stop(peer);
          return;
        }
        if (event !== 'client-message' || args.length !== 1) {
          this.#error(peer, 'invalid-message');
          return;
        }
        // Resync invalidates old private work at receipt, not after auth/queues.
        const decoded = decodeClientMessage(args[0]);
        if (decoded.type === 'decoded' && decoded.message.intent.type === 'resync')
          this.#unwatch(peer);
        const watch = peer.watch;
        const generation = peer.generation;
        peer.queued++;
        peer.pending = this.#track(
          peer.pending
            .then(() => this.#message(peer, args[0], watch, generation))
            .finally(() => {
              peer.queued--;
            }),
        );
      });
    });
    this.#timer = setInterval(() => {
      void this.checkCredentials();
    }, options.authPollMs ?? 1000);
    this.#timer.unref();
  }

  listen(port = 0, hostname = '127.0.0.1'): Promise<string> {
    if (this.#closed) return Promise.reject(new Error('Transport unavailable'));
    return new Promise((resolve, reject) => {
      const fail = () => reject(new Error('Transport unavailable'));
      this.#server.once('error', fail);
      this.#server.listen(port, hostname, () => {
        this.#server.removeListener('error', fail);
        const address = this.#server.address();
        if (!address || typeof address === 'string') {
          fail();
          return;
        }
        resolve(`https://${hostname.includes(':') ? `[${hostname}]` : hostname}:${address.port}`);
      });
    });
  }

  /** Also exposed for deterministic operations/tests; never refreshes credentials.
   * External revocation is detected within one cadence plus bounded DB latency.
   */
  checkCredentials(): Promise<void> {
    if (this.#checking) return this.#checking;
    if (this.#closed) return Promise.resolve();
    this.#checking = this.#track(
      (async () => {
        for (const peer of [...this.#peers]) {
          if (peer.closed) continue;
          try {
            if (!(await this.#options.access.inspect(peer.token, this.#now()))) this.#stop(peer);
          } catch {
            this.#stop(peer);
          }
        }
      })().finally(() => {
        this.#checking = null;
      }),
    );
    return this.#checking;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    clearInterval(this.#timer);
    for (const peer of this.#peers) this.#stop(peer);
    this.#closing = (async () => {
      await new Promise<void>((resolve) => {
        this.#io.close(() => resolve());
        this.#server.closeAllConnections();
      });
      while (this.#jobs.size) await Promise.allSettled([...this.#jobs]);
    })();
    return this.#closing;
  }

  #track<T>(job: Promise<T>): Promise<T> {
    this.#jobs.add(job);
    void job.then(
      () => this.#jobs.delete(job),
      () => this.#jobs.delete(job),
    );
    return job;
  }

  #origin(req: IncomingMessage): boolean {
    return (
      req.socket instanceof TLSSocket &&
      req.socket.encrypted &&
      allowedGuestOrigin(req.headers.origin, this.#options.origins)
    );
  }

  async #http(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const fail = (status: number) => {
      res.statusCode = status;
      res.end();
      req.resume();
    };
    try {
      if (this.#closed) {
        fail(503);
        return;
      }
      if (!this.#origin(req)) {
        fail(403);
        return;
      }
      if (!this.#rates.take(`http:${req.socket.remoteAddress}`, this.#now(), 60, 60000)) {
        fail(429);
        return;
      }
      const lobbyRoute = [
        '/api/lobbies',
        '/api/lobbies/join',
        '/api/lobbies/state',
        '/api/lobbies/agreements',
        '/api/lobbies/ready',
      ].includes(req.url ?? '');
      if (lobbyRoute) {
        if (req.method !== 'POST') {
          fail(405);
          return;
        }
        await this.#lobbyHttp(req, res);
        return;
      }
      const issue = req.url === '/api/guest/session' && req.method === 'POST';
      const refresh = req.url === '/api/guest/session/refresh' && req.method === 'POST';
      const revoke = req.url === '/api/guest/session' && req.method === 'DELETE';
      if (!issue && !refresh && !revoke) {
        fail(req.url?.startsWith('/api/guest/session') ? 405 : 404);
        return;
      }
      // These endpoints accept no fields. Never deserialize arbitrary JSON or
      // allow caller-selected identity. Connection close bounds rejected bodies.
      if (req.headers['content-length'] && req.headers['content-length'] !== '0') {
        res.setHeader('Connection', 'close');
        fail(400);
        return;
      }
      for await (const chunk of req) {
        if (chunk.length) {
          res.setHeader('Connection', 'close');
          fail(400);
          return;
        }
      }
      const token = readGuestCookie(req.headers.cookie);
      if (issue) {
        if (
          req.headers.cookie
            ?.split(';')
            .some((part) => part.split('=', 1)[0]!.trim() === GUEST_COOKIE_NAME)
        ) {
          fail(409);
          return;
        }
        if (!this.#rates.take(`issue:${req.socket.remoteAddress}`, this.#now(), 6, 60000)) {
          fail(429);
          return;
        }
        const grant = await this.#options.access.issue(this.#now());
        res.setHeader('Set-Cookie', guestCookie(grant.token));
      } else if (refresh) {
        if (!token || !(await this.#options.access.authenticate(token, this.#now()))) {
          fail(401);
          return;
        }
        res.setHeader('Set-Cookie', guestCookie(token));
      } else {
        if (!token) {
          fail(401);
          return;
        }
        await this.#options.access.revoke(token, this.#now());
        const affected = [...this.#peers].filter((peer) => peer.token === token);
        for (const peer of affected) this.#stop(peer);
        await Promise.all(affected.map((peer) => peer.pending));
        await Promise.all(affected.map((peer) => peer.cleanup));
        res.setHeader('Set-Cookie', clearGuestCookie());
      }
      res.statusCode = 204;
      res.end();
    } catch {
      if (!res.writableEnded) fail(503);
    }
  }

  async #lobbyHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fail = (status: number) => {
      res.statusCode = status;
      res.end();
      req.resume();
    };
    const token = readGuestCookie(req.headers.cookie);
    if (!token) {
      fail(401);
      return;
    }
    if (!this.#rates.take(`lobby:${guestTokenHash(token)}`, this.#now(), 12, 60000)) {
      fail(429);
      return;
    }
    const workflowType =
      req.url === '/api/lobbies/state'
        ? 'state'
        : req.url === '/api/lobbies/agreements'
          ? 'agreements'
          : req.url === '/api/lobbies/ready'
            ? 'ready'
            : null;
    const maxBytes = workflowType ? WORKFLOW_BODY_MAX_BYTES : LOBBY_BODY_MAX_BYTES;
    const length = req.headers['content-length'];
    if (
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '') ||
      (req.headers['content-encoding'] !== undefined &&
        req.headers['content-encoding'] !== 'identity') ||
      (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes))
    ) {
      res.setHeader('Connection', 'close');
      fail(400);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) {
        res.setHeader('Connection', 'close');
        fail(400);
        return;
      }
      chunks.push(chunk);
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      fail(400);
      return;
    }
    const create = req.url === '/api/lobbies';
    const creation = create ? decodeLobbyRequest(value, 'create') : null;
    const joining = create || workflowType ? null : decodeLobbyRequest(value, 'join');
    const workflow = workflowType ? decodeWorkflow(value, workflowType) : null;
    if (!creation && !joining && !workflow) {
      fail(400);
      return;
    }
    try {
      // Access owns the credential -> lobby -> game-head transaction/lock order.
      // Do not enter a host/runtime queue or attach sockets while holding it.
      const access = this.#options.access;
      const binding = workflow
        ? workflow.type === 'state'
          ? await access.lobbyState(token, workflow.lobbyId, this.#now())
          : workflow.type === 'agreements'
            ? await access.editAgreements(
                token,
                workflow.lobbyId,
                workflow.expectedRevision,
                workflow.text,
                this.#now(),
              )
            : await access.setAcceptance(
                token,
                workflow.lobbyId,
                workflow.expectedRevision,
                workflow.ready,
                this.#now(),
              )
        : creation
          ? await access.createLobbyFromIntent(token, creation.requestId, this.#now())
          : await access.joinLobby(token, joining!.lobbyId, this.#now());
      if (this.#closed || res.destroyed) return;
      // An admitted commit drains, but revalidate before returning its identity.
      const valid = await this.#options.access.inspect(token, this.#now());
      if (!valid || valid.expiresAtMs <= this.#now()) {
        fail(401);
        return;
      }
      if (this.#closed || res.destroyed) return;
      res.setHeader('Set-Cookie', guestCookie(token));
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.statusCode = 200;
      res.end(
        JSON.stringify('members' in binding ? lobbyWorkflow(binding) : lobbyMembership(binding)),
      );
    } catch (error) {
      fail(
        error instanceof GuestAccessError
          ? error.code === 'authentication-required'
            ? 401
            : error.code === 'owner-only' || error.code === 'membership-required'
              ? 403
              : error.code === 'invalid-workflow'
                ? 400
                : ['lobby-full', 'match-running', 'revision-conflict', 'workflow-locked'].includes(
                      error.code,
                    )
                  ? 409
                  : 503
          : 503,
      );
    }
  }

  async #admit(socket: Socket, next: (error?: Error) => void): Promise<void> {
    const token = readGuestCookie(socket.request.headers.cookie);
    if (
      this.#closed ||
      this.#peers.size >= 256 ||
      !token ||
      !socket.handshake.auth ||
      typeof socket.handshake.auth !== 'object' ||
      Array.isArray(socket.handshake.auth) ||
      Object.keys(socket.handshake.auth).length
    ) {
      next(new Error('unauthorized'));
      return;
    }
    const peer: Peer = {
      socket,
      cancellation: new AbortController(),
      token,
      closed: false,
      lobbyId: null,
      detach: null,
      pending: Promise.resolve(),
      cleanup: Promise.resolve(),
      queued: 0,
      sequence: 0,
      streamId: randomUUID(),
      outbound: new AcknowledgedOutbound(
        async (message) => {
          // Socket.IO numeric ack IDs are predictable. Require an unpredictable
          // per-emission receipt so speculative acks cannot fill socket buffers.
          const receipt = randomUUID();
          const echoed = await socket
            .timeout(this.#delivery.ackTimeoutMs)
            .emitWithAck('server-message', message, receipt);
          if (echoed !== receipt) throw new Error('Invalid delivery receipt');
        },
        () => this.#stop(peer),
        this.#delivery,
      ),
      watch: 0,
      stopWatch: null,
      generation: 0,
      epoch: null,
      branch: null,
      seatId: null,
      publications: [],
      publicationBytes: 0,
      publishing: false,
    };
    this.#peers.add(peer);
    socket.conn.once('close', () => this.#stop(peer));
    socket.once('disconnect', () => this.#stop(peer));
    try {
      if (!(await this.#options.access.inspect(token, this.#now())) || !this.#live(peer, false)) {
        this.#stop(peer);
        next(new Error('unauthorized'));
        return;
      }
      next();
    } catch {
      this.#stop(peer);
      next(new Error('unavailable'));
    }
  }

  #live(peer: Peer, connected = true): boolean {
    return !this.#closed && !peer.closed && (!connected || peer.socket.connected);
  }

  #stop(peer: Peer, finalError?: TechnicalError): void {
    if (peer.closed) return;
    peer.closed = true;
    this.#unwatch(peer);
    if (finalError && peer.socket.connected) {
      void this.#track(
        peer.outbound.finish(protocolError(finalError)).finally(() => peer.socket.disconnect(true)),
      );
    } else {
      peer.outbound.close();
      peer.socket.disconnect(true);
    }
    void this.#track(peer.outbound.drained());
    peer.cancellation.abort();
    this.#peers.delete(peer);
    if (peer.detach) {
      const detach = peer.detach;
      peer.detach = null;
      peer.cleanup = this.#track(detach().catch(() => {}));
    }
  }

  #error(peer: Peer, code: TechnicalError): void {
    if (this.#live(peer)) peer.outbound.enqueue(protocolError(code));
  }

  async #gameplay(peer: Peer, message: ClientMessage): Promise<void> {
    const intent = message.intent;
    // Unsupported intents remain disabled even when well shaped. Gameplay has
    // no lobby field: an authenticated resync must establish the socket route.
    if (!GAMEPLAY_TYPES.has(intent.type) || !('gameId' in intent) || !('branchId' in intent)) {
      this.#error(peer, 'unavailable');
      return;
    }
    if (!peer.lobbyId || !peer.detach) {
      this.#error(peer, 'unauthorized');
      return;
    }
    try {
      const binding = await this.#options.access.membership(peer.token, peer.lobbyId, this.#now());
      if (!this.#live(peer)) return;
      if (binding.currentGameId !== intent.gameId) {
        this.#error(peer, 'wrong-game');
        return;
      }
      const dispatchOptions: DispatchOptions = {
        branchId: intent.branchId,
        controller: 'human',
        admit: async (snapshot) => {
          const valid = await this.#options.access.inspect(peer.token, this.#now());
          if (!valid || this.#now() >= valid.expiresAtMs) {
            this.#stop(peer);
            return false;
          }
          const seat = snapshot.connections.find((item) => item.seatId === binding.seatId);
          const participant = snapshot.state
            ? snapshot.state.players.some((item) => item.id === binding.seatId)
            : seat !== undefined;
          return (
            this.#live(peer) &&
            participant &&
            seat?.connected === true &&
            seat.controller === 'human'
          );
        },
      };
      let result;
      if (intent.type === 'submit-claim') {
        const request: ClaimRequest = {
          type: 'submit-claim',
          id: message.requestId,
          actorId: binding.seatId,
          accusedId: intent.accusedId,
          reason: intent.reason,
          incident: intent.evidence,
        };
        result = await this.#options.host.submitClaim(
          peer.lobbyId,
          intent.gameId,
          request,
          dispatchOptions,
        );
      } else {
        const command = gameplayCommand(message, binding.seatId)!;
        result = await this.#options.host.withCurrent(peer.lobbyId, intent.gameId, (runtime) =>
          runtime.dispatch(command, dispatchOptions),
        );
      }
      // A durable action is not undone if the caller departs during commit.
      // Suppress its acknowledgment instead; the original ID can settle retry.
      const valid = await this.#options.access.inspect(peer.token, this.#now());
      if (!valid || this.#now() >= valid.expiresAtMs) {
        this.#stop(peer);
        return;
      }
      if (this.#live(peer)) peer.outbound.enqueue(makeCommandAck(message.requestId, result));
    } catch (error) {
      const wrongGame = error instanceof GameHostError && error.message === 'wrong-game';
      const unauthorized =
        (error instanceof RuntimeAdmissionError && error.code === 'unauthorized') ||
        (error instanceof GuestAccessError &&
          ['authentication-required', 'membership-required', 'owner-only'].includes(error.code));
      if (wrongGame) this.#error(peer, 'wrong-game');
      else this.#stop(peer, unauthorized ? 'unauthorized' : 'unavailable');
    }
  }

  async #admin(peer: Peer, message: ClientMessage, generation: number): Promise<void> {
    const intent = message.intent;
    if (
      intent.type !== 'owner-history' &&
      intent.type !== 'owner-history-page' &&
      intent.type !== 'rollback'
    )
      return;
    if (!peer.lobbyId || !peer.detach) {
      this.#error(peer, 'unauthorized');
      return;
    }
    const gameId = intent.type !== 'rollback' ? intent.gameId : intent.target.expected.gameId;
    try {
      const binding = await this.#options.access.requireOwner(
        peer.token,
        peer.lobbyId,
        this.#now(),
      );
      if (!this.#live(peer)) return;
      if (binding.currentGameId !== gameId) {
        this.#error(peer, 'wrong-game');
        return;
      }
      if (intent.type === 'owner-history' || intent.type === 'owner-history-page') {
        await peer.outbound.prepare(
          async (emit) => {
            if (!this.#live(peer) || generation !== peer.generation) return;
            await this.#options.host.observeHistory(
              peer.lobbyId!,
              gameId,
              async (capture, epoch) => {
                const valid = await this.#options.access.inspectSeat(
                  peer.token,
                  peer.lobbyId!,
                  this.#now(),
                );
                if (!valid || this.#now() >= valid.expiresAtMs) {
                  this.#stop(peer);
                  return;
                }
                if (
                  valid.sessionId !== binding.sessionId ||
                  valid.seatId !== capture.ownerId ||
                  valid.seatId !== binding.seatId
                )
                  throw new RuntimeAdmissionError();
                if (
                  !this.#live(peer) ||
                  generation !== peer.generation ||
                  valid.currentGameId !== gameId ||
                  (peer.epoch !== null && peer.epoch !== epoch)
                )
                  return;
                const response =
                  intent.type === 'owner-history-page'
                    ? makeOwnerHistoryPage(
                        projectOwnerHistory(capture, { type: 'seat', seatId: valid.seatId }),
                        message.requestId,
                        { epoch: `${epoch}:${peer.streamId}`, sequence: ++peer.sequence },
                        intent.cursor,
                        intent.limit,
                        Math.min(65536, this.#delivery.bytes),
                      )
                    : makeOwnerHistoryMessage(
                        capture,
                        { type: 'seat', seatId: valid.seatId },
                        { epoch: `${epoch}:${peer.streamId}`, sequence: ++peer.sequence },
                      );
                const maxBytes = Math.min(65536, this.#delivery.bytes);
                if (
                  intent.type !== 'owner-history-page' ||
                  Buffer.byteLength(JSON.stringify(response)) + 128 <= maxBytes
                ) {
                  emit(response);
                } else {
                  // Even the correlated failure can exceed a tiny budget. End
                  // the request explicitly rather than waiting for no receipt.
                  const failure = protocolError('unavailable');
                  if (Buffer.byteLength(JSON.stringify(failure)) + 128 <= maxBytes) emit(failure);
                  else this.#stop(peer);
                }
              },
            );
          },
          Math.min(65536, this.#delivery.bytes),
          generation,
        );
        return;
      }
      const result = await this.#options.host.rollback(
        peer.lobbyId,
        gameId,
        {
          id: message.requestId,
          actorId: binding.seatId,
          target: intent.target,
          knowledgeWarningAcknowledged: intent.knowledgeWarningAcknowledged,
        },
        {
          controller: 'human',
          admit: async (snapshot) => {
            const valid = await this.#options.access.inspectSeat(
              peer.token,
              peer.lobbyId!,
              this.#now(),
            );
            if (!valid || this.#now() >= valid.expiresAtMs) {
              this.#stop(peer);
              return false;
            }
            const seat = snapshot.connections.find((seat) => seat.seatId === binding.seatId);
            return (
              this.#live(peer) &&
              valid.sessionId === binding.sessionId &&
              valid.seatId === binding.seatId &&
              valid.currentGameId === gameId &&
              seat?.connected === true &&
              seat.controller === 'human'
            );
          },
        },
      );
      const valid = await this.#options.access.inspect(peer.token, this.#now());
      if (!valid || this.#now() >= valid.expiresAtMs) {
        this.#stop(peer);
        return;
      }
      if (this.#live(peer)) peer.outbound.enqueue(makeCommandAck(message.requestId, result));
    } catch (error) {
      if (error instanceof GameHostError && error.message === 'wrong-game')
        this.#error(peer, 'wrong-game');
      else if (
        (error instanceof RuntimeAdmissionError && error.code === 'unauthorized') ||
        (error instanceof GuestAccessError &&
          ['authentication-required', 'membership-required', 'owner-only'].includes(error.code))
      )
        this.#error(peer, 'unauthorized');
      else this.#stop(peer, 'unavailable');
    }
  }

  async #chat(
    peer: Peer,
    message: ClientMessage,
    watch: number,
    generation: number,
  ): Promise<void> {
    const intent = message.intent;
    if (intent.type !== 'post-chat' && intent.type !== 'chat-history') return;
    if (!peer.detach || peer.lobbyId !== intent.lobbyId) {
      this.#error(peer, 'unauthorized');
      return;
    }
    const history = intent.type === 'chat-history';
    const current = () =>
      this.#live(peer) && (!history || (watch === peer.watch && generation === peer.generation));
    if (!current()) return;
    try {
      const binding = await this.#options.access.membership(
        peer.token,
        intent.lobbyId,
        this.#now(),
      );
      const admit = async () => {
        const valid = await this.#options.access.inspectSeat(
          peer.token,
          intent.lobbyId,
          this.#now(),
        );
        if (!valid || this.#now() >= valid.expiresAtMs) {
          this.#stop(peer);
          return false;
        }
        return (
          current() && valid.sessionId === binding.sessionId && valid.seatId === binding.seatId
        );
      };
      if (!current()) return;
      const posted =
        intent.type === 'post-chat'
          ? await this.#options.host.postChat(
              intent.lobbyId,
              {
                id: intent.messageId,
                authorSessionId: binding.sessionId,
                authorSeatId: binding.seatId,
                text: intent.text,
              },
              this.#now(),
              { admit },
            )
          : null;
      // A committed post is immutable across resync/rollback/handoff. Its reply
      // remains correlated, never a state cursor or an unsolicited broadcast.
      const maxBytes = Math.min(65536, this.#delivery.bytes);
      await peer.outbound.prepare(
        async (emit) => {
          if (!current()) return;
          let rows: readonly ChatMessage[];
          try {
            rows = posted
              ? [posted]
              : intent.type === 'chat-history'
                ? await this.#options.host.chatHistory(
                    intent.lobbyId,
                    intent.afterSequence,
                    intent.limit,
                    { admit },
                  )
                : [];
            if (!(await admit())) return;
          } catch (error) {
            // Resync/rollback can cancel a page while its host admission waits.
            // Cancellation discards the read; it must not become wire failure
            // and disconnect an otherwise healthy participant.
            if (!current()) return;
            throw error;
          }
          // Final authentication and projection/emission have no intervening await.
          let reply: ServerMessage;
          try {
            reply = boundedChatPage(message.requestId, rows, maxBytes);
          } catch {
            reply = protocolError('unavailable');
          }
          emit(reply);
        },
        maxBytes,
        history ? generation : undefined,
      );
    } catch (error) {
      const unauthorized =
        (error instanceof ChatAdmissionError && error.code === 'unauthorized') ||
        (error instanceof GuestAccessError &&
          ['authentication-required', 'membership-required'].includes(error.code));
      this.#error(peer, unauthorized ? 'unauthorized' : 'unavailable');
    }
  }

  async #start(peer: Peer, message: ClientMessage): Promise<void> {
    const intent = message.intent;
    if (intent.type !== 'start-match') return;
    if (!peer.detach || peer.lobbyId !== intent.lobbyId) {
      this.#error(peer, 'unauthorized');
      return;
    }
    try {
      const binding = await this.#options.access.requireOwner(
        peer.token,
        intent.lobbyId,
        this.#now(),
      );
      if (!this.#live(peer)) return;
      const result = await this.#options.host.startFromIntent(
        intent.lobbyId,
        {
          id: message.requestId,
          actorSessionId: binding.sessionId,
          expectedHead: intent.expected,
        },
        async () => {
          if (!this.#live(peer)) return null;
          try {
            const owner = await this.#options.access.requireOwner(
              peer.token,
              intent.lobbyId,
              this.#now(),
            );
            return this.#live(peer) &&
              this.#now() < owner.expiresAtMs &&
              owner.sessionId === binding.sessionId &&
              owner.seatId === binding.seatId
              ? owner
              : null;
          } catch (error) {
            if (
              error instanceof GuestAccessError &&
              ['authentication-required', 'membership-required', 'owner-only'].includes(error.code)
            )
              return null;
            throw error;
          }
        },
      );
      await peer.outbound.prepare(
        async (emit) => {
          const valid = await this.#options.access.inspectSeat(
            peer.token,
            intent.lobbyId,
            this.#now(),
          );
          if (!valid || this.#now() >= valid.expiresAtMs) {
            this.#stop(peer);
            return;
          }
          if (
            !this.#live(peer) ||
            valid.sessionId !== binding.sessionId ||
            valid.seatId !== binding.seatId
          )
            return;
          emit(makeMatchStartAck(message.requestId, result));
        },
        Math.min(65536, this.#delivery.bytes),
      );
    } catch (error) {
      const unauthorized =
        (error instanceof RuntimeAdmissionError && error.code === 'unauthorized') ||
        (error instanceof GuestAccessError &&
          ['authentication-required', 'membership-required', 'owner-only'].includes(error.code));
      this.#error(peer, unauthorized ? 'unauthorized' : 'unavailable');
    }
  }

  #discardStream(peer: Peer): void {
    peer.generation++;
    peer.streamId = randomUUID();
    peer.sequence = 0;
    peer.outbound.invalidate(peer.generation);
    for (const item of peer.publications) {
      peer.publicationBytes -= item.bytes;
      item.capture.release();
    }
    peer.publications = [];
  }

  #unwatch(peer: Peer): void {
    peer.watch++;
    peer.stopWatch?.();
    peer.stopWatch = null;
    this.#discardStream(peer);
    peer.epoch = null;
    peer.branch = null;
  }

  #publication(peer: Peer, notice: HostPublication): void {
    if (!this.#live(peer)) return;
    if (notice.type === 'invalidated') {
      this.#discardStream(peer);
      peer.epoch = null;
      peer.branch = null;
      // Never re-enter host synchronously/await its queue from its callback.
      void this.#track(this.#options.host.read(peer.lobbyId!).catch(() => this.#stop(peer)));
      return;
    }
    const publication = notice.publication;
    if (publication.kind === 'handoff') {
      this.#discardStream(peer);
      peer.epoch = null;
      return;
    }
    const branch = publication.snapshot.head.branchId;
    if (publication.kind === 'initial' || notice.epoch !== peer.epoch || branch !== peer.branch)
      this.#discardStream(peer);
    peer.epoch = notice.epoch;
    peer.branch = branch;
    if (!notice.capture) {
      this.#stop(peer);
      return;
    }
    const bytes = notice.capture.bytes;
    if (
      peer.publications.length + Number(peer.publishing) >= this.#delivery.jobs ||
      peer.publicationBytes + bytes > this.#delivery.captureBytes
    ) {
      this.#stop(peer);
      return;
    }
    let capture: CaptureHandle;
    try {
      capture = notice.capture.retain();
    } catch {
      this.#stop(peer);
      return;
    }
    peer.publicationBytes += bytes;
    peer.publications.push({
      capture,
      publication,
      ...(notice.rollback ? { rollback: notice.rollback } : {}),
      epoch: notice.epoch,
      generation: peer.generation,
      bytes,
    });
    if (!peer.publishing) void this.#track(this.#publish(peer));
  }

  async #publish(peer: Peer): Promise<void> {
    peer.publishing = true;
    try {
      while (this.#live(peer) && peer.publications.length) {
        const item = peer.publications.shift()!;
        try {
          const actions = item.publication.kind === 'initial' ? [] : item.publication.actions;
          const noticeCount = item.rollback ? 1 : 0;
          for (let index = 0; index <= actions.length + noticeCount; index++) {
            if (item.generation !== peer.generation || !this.#live(peer)) break;
            await peer.outbound.prepare(
              async (emit) => {
                if (item.generation !== peer.generation || !this.#live(peer)) return;
                const binding = await this.#options.access.inspectSeat(
                  peer.token,
                  peer.lobbyId!,
                  this.#now(),
                );
                if (
                  !binding ||
                  binding.seatId !== peer.seatId ||
                  this.#now() >= binding.expiresAtMs
                ) {
                  this.#stop(peer);
                  return;
                }
                if (item.generation !== peer.generation || !this.#live(peer)) return;
                if (binding.currentGameId !== item.publication.snapshot.head.gameId) return;
                await this.#options.host.withCurrent(
                  peer.lobbyId!,
                  binding.currentGameId!,
                  (runtime, epoch) =>
                    runtime.observe(async (current, nowMs) => {
                      if (
                        item.generation !== peer.generation ||
                        !this.#live(peer) ||
                        epoch !== item.epoch ||
                        current.head.branchId !== item.publication.snapshot.head.branchId
                      )
                        return;
                      if (this.#now() >= binding.expiresAtMs) {
                        this.#stop(peer);
                        return;
                      }
                      const participant = current.state
                        ? current.state.players.some((seat) => seat.id === binding.seatId)
                        : current.connections.some((seat) => seat.seatId === binding.seatId);
                      if (!participant) {
                        this.#error(peer, 'unauthorized');
                        return;
                      }
                      const viewer = { type: 'seat' as const, seatId: binding.seatId };
                      const delivery = {
                        epoch: `${epoch}:${peer.streamId}`,
                        sequence: ++peer.sequence,
                      };
                      let message: ServerMessage;
                      if (item.rollback && index === 0)
                        message = makeRollbackNoticeMessage(item.rollback, delivery);
                      else if (index - noticeCount < actions.length)
                        message = makeActionMessage(
                          actions[index - noticeCount]!,
                          viewer,
                          delivery,
                        );
                      else {
                        if (item.publication.kind === 'initial') {
                          // The authorized baseline starts here, not before slow SQL.
                          // Earlier queued observations are never replayed by resync.
                          for (const queued of peer.publications) {
                            peer.publicationBytes -= queued.bytes;
                            queued.capture.release();
                          }
                          peer.publications = [];
                        }
                        message = makeStateMessage(
                          item.publication.kind === 'initial' ? current : item.publication.snapshot,
                          viewer,
                          nowMs,
                          delivery,
                        );
                        // A newer pause/procedure can suspend the reveal on this same
                        // branch while an older committed state waits for delivery.
                        const live = makeStateMessage(current, viewer, nowMs, delivery);
                        if (
                          !live.view.transient.reveal ||
                          live.view.transient.reveal.timer.id !==
                            message.view.transient.reveal?.timer.id
                        )
                          message = {
                            ...message,
                            view: {
                              ...message.view,
                              transient: { ...message.view.transient, reveal: null },
                            },
                          };
                      }
                      emit(message); // projection and actual emission share this prefix
                    }),
                );
              },
              Math.min(65536, this.#delivery.bytes),
              item.generation,
            );
          }
        } catch {
          if (item.generation === peer.generation && this.#live(peer)) this.#stop(peer);
        } finally {
          peer.publicationBytes -= item.bytes;
          item.capture.release();
        }
      }
    } catch {
      this.#stop(peer);
    } finally {
      peer.publishing = false;
    }
  }

  async #message(peer: Peer, value: unknown, watch: number, generation: number): Promise<void> {
    if (!this.#live(peer)) return;
    const decoded = decodeClientMessage(value);
    if (decoded.type !== 'decoded') {
      this.#error(peer, decoded.code);
      return;
    }
    if (
      decoded.message.intent.type === 'post-chat' ||
      decoded.message.intent.type === 'chat-history'
    ) {
      await this.#chat(peer, decoded.message, watch, generation);
      return;
    }
    if (decoded.message.intent.type === 'start-match') {
      await this.#start(peer, decoded.message);
      return;
    }
    if (
      decoded.message.intent.type === 'owner-history' ||
      decoded.message.intent.type === 'owner-history-page' ||
      decoded.message.intent.type === 'rollback'
    ) {
      if (
        (decoded.message.intent.type === 'owner-history' ||
          decoded.message.intent.type === 'owner-history-page') &&
        (watch !== peer.watch || generation !== peer.generation)
      )
        return;
      await this.#admin(peer, decoded.message, generation);
      return;
    }
    if (decoded.message.intent.type !== 'resync') {
      await this.#gameplay(peer, decoded.message);
      return;
    }
    const { lobbyId } = decoded.message.intent;
    if (peer.lobbyId !== null && peer.lobbyId !== lobbyId) {
      this.#error(peer, 'unauthorized');
      return;
    }
    try {
      const binding = await this.#options.access.membership(peer.token, lobbyId, this.#now());
      if (!this.#live(peer)) return;
      if (!peer.detach) {
        const detach = await this.#options.host.attach(binding, peer.cancellation.signal);
        if (!this.#live(peer)) {
          await detach();
          return;
        }
        peer.detach = detach;
        peer.lobbyId = lobbyId;
      }
      if (!binding.currentGameId) {
        this.#error(peer, 'unavailable');
        return;
      }
      if (!this.#live(peer) || watch !== peer.watch) return;
      const participant = await this.#options.host.withCurrent(
        lobbyId,
        binding.currentGameId,
        (runtime) =>
          runtime.observe(async (snapshot) =>
            snapshot.state
              ? snapshot.state.players.some((seat) => seat.id === binding.seatId)
              : snapshot.connections.some((seat) => seat.seatId === binding.seatId),
          ),
      );
      if (!this.#live(peer) || watch !== peer.watch) return;
      if (!participant) {
        this.#error(peer, 'unauthorized');
        return;
      }
      peer.seatId = binding.seatId;
      const stop = await this.#options.host.subscribeCommittedCapture(
        lobbyId,
        (notice) => {
          if (watch === peer.watch) this.#publication(peer, notice);
        },
        () => this.#stop(peer),
        binding.currentGameId,
      );
      if (!this.#live(peer) || watch !== peer.watch) stop();
      else peer.stopWatch = stop;
    } catch (error) {
      const unauthorized =
        error instanceof GuestAccessError &&
        ['authentication-required', 'membership-required', 'owner-only'].includes(error.code);
      // Invalidate presence/private work immediately; a final fixed technical
      // response may drain through the existing bounded wire slot before close.
      this.#stop(peer, unauthorized ? 'unauthorized' : 'unavailable');
    }
  }
}
