import { randomUUID } from 'node:crypto';
import { createServer } from 'node:https';
import type { Server as HttpsServer, ServerOptions } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TLSSocket } from 'node:tls';
import { Server } from 'socket.io';
import type { Socket } from 'socket.io';
import type { LobbyId, SeatId } from '../game/ids.ts';
import type { RuntimeCommand } from '../runtime/runtime.ts';
import { RuntimeAdmissionError } from '../runtime/runtime.ts';
import { GameHostError } from './game-host.ts';
import { decodeClientMessage } from '../protocol/decode.ts';
import { makeCommandAck, makeStateMessage, protocolError } from '../protocol/messages.ts';
import type { ClientMessage, TechnicalError } from '../protocol/contracts.ts';
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
};
export type TransportOptions = Readonly<{
  tls: Pick<ServerOptions, 'key' | 'cert'>;
  origins: readonly string[];
  access: PostgresGuestAccess;
  host: PostgresGameHost;
  now?: () => number;
  /** Non-refreshing durable credential check cadence, not a gameplay timer. */
  authPollMs?: number;
}>;

/** TLS guest lifecycle, seat-private resync and explicit guarded gameplay subset.
 * No claim/admin/chat/start/history handlers, lobby admission, live publisher,
 * proxy trust or insecure mode.
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
          !this.#rates.take(`socket:${peer.streamId}`, this.#now(), 20, 1000) ||
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
        peer.queued++;
        peer.pending = this.#track(
          peer.pending
            .then(() => this.#message(peer, args[0]))
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

  #stop(peer: Peer): void {
    if (peer.closed) return;
    peer.closed = true;
    peer.cancellation.abort();
    this.#peers.delete(peer);
    peer.socket.disconnect(true);
    if (peer.detach) {
      const detach = peer.detach;
      peer.detach = null;
      peer.cleanup = this.#track(detach().catch(() => {}));
    }
  }

  #error(peer: Peer, code: TechnicalError): void {
    if (this.#live(peer)) peer.socket.emit('server-message', protocolError(code));
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
      await this.#options.host.withCurrent(peer.lobbyId, intent.gameId, async (runtime) => {
        const command = gameplayCommand(message, binding.seatId)!;
        const result = await runtime.dispatch(command, {
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
        });
        // A durable action is not undone if the caller departs during commit.
        // Suppress its acknowledgment instead; the original ID can settle retry.
        const valid = await this.#options.access.inspect(peer.token, this.#now());
        if (!valid || this.#now() >= valid.expiresAtMs) {
          this.#stop(peer);
          return;
        }
        if (this.#live(peer))
          peer.socket.emit('server-message', makeCommandAck(message.requestId, result));
      });
    } catch (error) {
      const wrongGame = error instanceof GameHostError && error.message === 'wrong-game';
      const unauthorized =
        (error instanceof RuntimeAdmissionError && error.code === 'unauthorized') ||
        (error instanceof GuestAccessError &&
          ['authentication-required', 'membership-required', 'owner-only'].includes(error.code));
      this.#error(peer, wrongGame ? 'wrong-game' : unauthorized ? 'unauthorized' : 'unavailable');
      if (!wrongGame) this.#stop(peer);
    }
  }

  async #message(peer: Peer, value: unknown): Promise<void> {
    if (!this.#live(peer)) return;
    const decoded = decodeClientMessage(value);
    if (decoded.type !== 'decoded') {
      this.#error(peer, decoded.code);
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
      await this.#options.host.withCurrent(
        lobbyId,
        binding.currentGameId,
        async (runtime, epoch) => {
          // Revalidate before capturing the baseline: slow authentication must not
          // deliver an expired reveal or a state superseded while awaiting SQL.
          const valid = await this.#options.access.inspect(peer.token, this.#now());
          if (!valid) {
            this.#stop(peer);
            return;
          }
          await runtime.observe(async (snapshot, nowMs) => {
            if (!this.#live(peer)) return;
            if (this.#now() >= valid.expiresAtMs) {
              this.#stop(peer);
              return;
            }
            const participant = snapshot.state
              ? snapshot.state.players.some((seat) => seat.id === binding.seatId)
              : snapshot.connections.some((seat) => seat.seatId === binding.seatId);
            const result = participant
              ? makeStateMessage(snapshot, { type: 'seat', seatId: binding.seatId }, nowMs, {
                  epoch: `${epoch}:${peer.streamId}`,
                  sequence: ++peer.sequence,
                })
              : protocolError('unauthorized');
            // No await between current-state projection and best-effort emission;
            // no network delivery promise is awaited inside either server queue.
            peer.socket.emit('server-message', result);
          });
        },
      );
    } catch (error) {
      const unauthorized =
        error instanceof GuestAccessError &&
        ['authentication-required', 'membership-required', 'owner-only'].includes(error.code);
      this.#error(peer, unauthorized ? 'unauthorized' : 'unavailable');
      // A failed attachment/read must not leave a falsely present connection.
      this.#stop(peer);
    }
  }
}
