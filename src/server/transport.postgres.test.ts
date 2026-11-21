import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Pool } from 'pg';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { id } from '../game/ids.ts';
import { migrate, PostgresSession } from '../persistence/postgres.ts';
import { PostgresLobby } from '../persistence/lobby.ts';
import { PostgresGameHost } from './game-host.ts';
import { GuestAccessError, PostgresGuestAccess } from './guest-access.ts';
import { FakeClock } from '../runtime/testing/fake-clock.ts';
import { GameRuntime } from '../runtime/runtime.ts';
import { finishMatch } from '../runtime/testing/match.ts';
import { GUEST_COOKIE_NAME, GUEST_TTL_MS, guestTokenHash } from './guest-session.ts';
import { PenkyTransport } from './transport.ts';
import type { TransportOptions } from './transport.ts';
import type { OwnerHistoryCursor, ServerMessage } from '../protocol/contracts.ts';

const cert = readFileSync(new URL('./testing/localhost-cert.pem', import.meta.url));
const key = readFileSync(new URL('./testing/localhost-key.pem', import.meta.url));
const origin = 'https://localhost';
const url = process.env.PENKY_TEST_DATABASE_URL;
const resync = (lobbyId: string) => ({
  protocolVersion: 1,
  requestId: randomUUID(),
  intent: { type: 'resync', lobbyId },
});

function http(
  base: string,
  path: string,
  method = 'POST',
  cookie?: string,
  source: string | null = origin,
  body = '',
  extra: Record<string, string> = {},
) {
  return new Promise<{ status: number; cookie: string | undefined; body: string }>(
    (resolve, reject) => {
      const req = request(
        new URL(path, base),
        {
          method,
          ca: cert,
          headers: {
            ...(source === null ? {} : { Origin: source }),
            ...(cookie === undefined ? {} : { Cookie: cookie }),
            'Content-Length': Buffer.byteLength(body),
            ...extra,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () =>
            resolve({
              status: response.statusCode!,
              cookie: response.headers['set-cookie']?.[0],
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.on('error', reject);
      req.on('upgrade', (_response, socket) => {
        socket.destroy();
        reject(new Error('Unexpected successful WebSocket upgrade'));
      });
      req.end(body);
    },
  );
}

function once(socket: Socket, event: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, receive);
      reject(new Error(`Missing socket event: ${event}`));
    }, 10000);
    function receive(...args: unknown[]) {
      clearTimeout(timer);
      resolve(args);
    }
    socket.once(event, receive);
  });
}

const receiptEnabled = new WeakMap<Socket, boolean>();
const latestEpoch = new WeakMap<Socket, string>();
const latestState = new WeakMap<Socket, Extract<ServerMessage, { type: 'state' }>>();
function acknowledge(socket: Socket) {
  socket.on(
    'server-message',
    (value: ServerMessage, receipt: string, ack?: (receipt: string) => void) => {
      if (value.type === 'state') {
        latestEpoch.set(socket, value.delivery.epoch);
        latestState.set(socket, value);
      }
      if (receiptEnabled.get(socket) !== false) ack?.(receipt);
    },
  );
}
async function message(socket: Socket, payload: unknown): Promise<ServerMessage> {
  const input = payload as { requestId?: string; intent?: { type?: string } };
  const resyncing = input?.intent?.type === 'resync';
  const history = input?.intent?.type === 'owner-history';
  const historyPage = input?.intent?.type === 'owner-history-page';
  const chat = input?.intent?.type === 'post-chat' || input?.intent?.type === 'chat-history';
  const starting = input?.intent?.type === 'start-match';
  const oldEpoch = latestEpoch.get(socket);
  const result = new Promise<ServerMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('server-message', receive);
      reject(new Error('Missing correlated response'));
    }, 10000);
    function receive(value: ServerMessage) {
      if (
        value.type !== 'error' &&
        !(resyncing
          ? value.type === 'state' && value.delivery.epoch !== oldEpoch
          : history
            ? value.type === 'owner-history'
            : historyPage
              ? value.type === 'owner-history-page' && value.requestId === input?.requestId
              : chat
                ? value.type === 'chat-page' && value.requestId === input?.requestId
                : starting
                  ? value.type === 'match-start-ack' && value.requestId === input?.requestId
                  : value.type === 'command-ack' && value.requestId === input?.requestId)
      )
        return;
      clearTimeout(timer);
      socket.off('server-message', receive);
      resolve(value);
    }
    socket.on('server-message', receive);
  });
  socket.emit('client-message', payload);
  return result;
}

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('Timed out waiting for observable transport state');
}

test('HTTPS and Socket.IO authenticated resync', { skip: !url, timeout: 240000 }, async (t) => {
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

  async function fixture(
    t: TestContext,
    count = 2,
    authPollMs = 25,
    delivery?: TransportOptions['delivery'],
    startGame = true,
    accept = true,
  ) {
    let now = Date.now();
    const access = new PostgresGuestAccess(pool);
    const clock = new FakeClock(now);
    const host = new PostgresGameHost(pool, {
      inputs: () => ({
        clock,
        randomInt: (upper) => upper - 1,
        nextCommandId: () => id('command', randomUUID()),
      }),
    });
    const transport = new PenkyTransport({
      access,
      host,
      tls: { key, cert },
      origins: [origin],
      now: () => now,
      authPollMs,
      ...(delivery ? { delivery } : {}),
    });
    const base = await transport.listen(0, '127.0.0.1');
    t.after(async () => {
      await transport.close();
      await host.close();
    });
    const grants = await Promise.all(Array.from({ length: count }, () => access.issue(now)));
    const owner = await access.createLobby(grants[0]!.token, id('lobby', randomUUID()), now);
    for (const grant of grants.slice(1)) await access.joinLobby(grant.token, owner.lobbyId, now);
    const members = await Promise.all(
      grants.map((grant) => access.membership(grant.token, owner.lobbyId, now)),
    );
    const start = {
      id: id('command', randomUUID()),
      actorSessionId: owner.sessionId,
      expectedGameId: null,
      expectedHead: null,
      gameId: id('game', randomUUID()),
      branchId: id('branch', randomUUID()),
      seatIds: members[0]!.seatIds,
      cardIds: Array.from({ length: 36 }, () => id('card', randomUUID())),
    };
    const acceptAll = async () => {
      const view = await access.lobbyState(grants[0]!.token, owner.lobbyId, now);
      await Promise.all(
        grants.map((grant) =>
          access.setAcceptance(grant.token, owner.lobbyId, view.revision, true, now),
        ),
      );
    };
    if (accept) await acceptAll(); // Explicit test-fixture consent, never production auto-readiness.
    if (startGame) assert.equal((await host.startMatch(owner.lobbyId, start)).type, 'started');
    const clients: Socket[] = [];
    function client(
      token: string | null,
      options: { source?: string | null; auth?: object; polling?: boolean } = {},
    ) {
      const socket = io(base, {
        ca: cert.toString(),
        transports: options.polling ? ['polling'] : ['websocket'],
        reconnection: false,
        timeout: 3000,
        extraHeaders: {
          ...(options.source === null ? {} : { Origin: options.source ?? origin }),
          ...(token === null ? {} : { Cookie: `${GUEST_COOKIE_NAME}=${token}` }),
        },
        auth: options.auth ?? {},
      });
      clients.push(socket);
      acknowledge(socket);
      t.after(() => {
        socket.disconnect();
      });
      return socket;
    }
    async function connect(index = 0) {
      const socket = client(grants[index]!.token);
      await once(socket, 'connect');
      return socket;
    }
    return {
      access,
      host,
      clock,
      acceptAll,
      transport,
      base,
      grants,
      members,
      start,
      client,
      connect,
      clients,
      setNow: (value: number) => {
        now = value;
      },
      now: () => now,
    };
  }

  await t.test(
    'HTTP lobby creation retries and joins return only committed own-seat identity',
    async (t) => {
      const context = await fixture(t, 2, 60000, undefined, false);
      const cookie = `${GUEST_COOKIE_NAME}=${context.grants[0]!.token}`;
      const body = JSON.stringify({ requestId: randomUUID() });
      const headers = { 'Content-Type': 'application/json' };
      const replies = await Promise.all(
        Array.from({ length: 3 }, () =>
          http(context.base, '/api/lobbies', 'POST', cookie, origin, body, headers),
        ),
      );
      for (const reply of replies) {
        assert.equal(reply.status, 200);
        assert.match(reply.cookie!, /Secure; HttpOnly; SameSite=Lax/);
        assert.equal(reply.body, replies[0]!.body);
      }
      const created = JSON.parse(replies[0]!.body);
      assert.deepEqual(Object.keys(created).sort(), ['isOwner', 'lobbyId', 'position', 'seatId']);
      assert.equal(created.position, 0);
      assert.equal(created.isOwner, true);
      assert.notEqual(created.lobbyId, context.members[0]!.lobbyId);
      const guestCookie = `${GUEST_COOKIE_NAME}=${context.grants[1]!.token}`;
      const join = () =>
        http(
          context.base,
          '/api/lobbies/join',
          'POST',
          guestCookie,
          origin,
          JSON.stringify({ lobbyId: created.lobbyId }),
          headers,
        );
      const joined = await join();
      assert.equal(joined.status, 200);
      assert.equal((await join()).body, joined.body);
      const member = JSON.parse(joined.body);
      assert.deepEqual(Object.keys(member).sort(), ['isOwner', 'lobbyId', 'position', 'seatId']);
      assert.equal(member.isOwner, false);
      assert.equal(member.position, 1);
      assert.notEqual(member.seatId, created.seatId);
      const socket = await context.connect(1);
      const unavailable = await message(socket, resync(created.lobbyId));
      assert.equal(unavailable.type, 'error');
      // Explicit resync establishes attachment; HTTP admission never creates a match.
      assert.equal(
        (await context.access.membership(context.grants[1]!.token, created.lobbyId, context.now()))
          .currentGameId,
        null,
      );
    },
  );

  await t.test(
    'lobby HTTP rejects identity injection, invalid JSON and unbounded bodies with fixed errors',
    async (t) => {
      const context = await fixture(t, 2, 60000, undefined, false);
      const cookie = `${GUEST_COOKIE_NAME}=${context.grants[0]!.token}`;
      const headers = { 'Content-Type': 'application/json' };
      const cases = [
        ['{}', headers],
        ['[]', headers],
        ['not-json', headers],
        [JSON.stringify({ requestId: 'x', ownerId: context.members[0]!.seatId }), headers],
        [JSON.stringify({ requestId: 'x'.repeat(129) }), headers],
        [JSON.stringify({ requestId: '\ud800' }), headers],
        [JSON.stringify({ requestId: 'x' }), { 'Content-Type': 'text/plain' }],
        [' '.repeat(2049), headers],
      ] as const;
      for (const [body, extra] of cases) {
        const reply = await http(context.base, '/api/lobbies', 'POST', cookie, origin, body, extra);
        assert.equal(reply.status, 400);
        assert.equal(reply.body, '');
        assert.equal(reply.cookie, undefined);
      }
      for (const [source, expected] of [
        [null, 403],
        ['https://evil.example', 403],
      ] as const) {
        assert.equal(
          (
            await http(
              context.base,
              '/api/lobbies',
              'POST',
              cookie,
              source,
              '{"requestId":"x"}',
              headers,
            )
          ).status,
          expected,
        );
      }
      assert.equal((await http(context.base, '/api/lobbies', 'GET', cookie)).status, 405);
      assert.equal((await http(context.base, '/api/lobbies/join', 'DELETE', cookie)).status, 405);
      const missing = await http(
        context.base,
        '/api/lobbies',
        'POST',
        undefined,
        origin,
        '{"requestId":"x"}',
        headers,
      );
      assert.equal(missing.status, 401);
      assert.equal(missing.body, '');
    },
  );

  await t.test(
    'lobby HTTP retry authorization observes revocation and expiry without reclaiming seats',
    async (t) => {
      const context = await fixture(t, 2, 60000, undefined, false);
      const headers = { 'Content-Type': 'application/json' };
      const cookie = `${GUEST_COOKIE_NAME}=${context.grants[0]!.token}`;
      const body = JSON.stringify({ requestId: randomUUID() });
      const first = await http(context.base, '/api/lobbies', 'POST', cookie, origin, body, headers);
      assert.equal(first.status, 200);
      await context.access.revoke(context.grants[0]!.token, context.now());
      const revoked = await http(
        context.base,
        '/api/lobbies',
        'POST',
        cookie,
        origin,
        body,
        headers,
      );
      assert.equal(revoked.status, 401);
      assert.equal(revoked.cookie, undefined);
      assert.equal(revoked.body, '');
      const outsider = `${GUEST_COOKIE_NAME}=${context.grants[1]!.token}`;
      const joined = await http(
        context.base,
        '/api/lobbies/join',
        'POST',
        outsider,
        origin,
        JSON.stringify({ lobbyId: JSON.parse(first.body).lobbyId }),
        headers,
      );
      assert.equal(joined.status, 200);
      assert.equal(JSON.parse(joined.body).position, 1);
      assert.equal(JSON.parse(joined.body).isOwner, false);
      context.setNow(context.now() + GUEST_TTL_MS);
      const expired = await http(
        context.base,
        '/api/lobbies/join',
        'POST',
        outsider,
        origin,
        JSON.stringify({ lobbyId: JSON.parse(first.body).lobbyId }),
        headers,
      );
      assert.equal(expired.status, 401);
      assert.equal(expired.cookie, undefined);
    },
  );

  for (const count of [2, 4, 8]) {
    await t.test(
      `HTTP joins serialize ${count} seats and preserve running-match admission`,
      async (t) => {
        const context = await fixture(t, count, 60000);
        const headers = { 'Content-Type': 'application/json' };
        const join = (token: string) =>
          http(
            context.base,
            '/api/lobbies/join',
            'POST',
            `${GUEST_COOKIE_NAME}=${token}`,
            origin,
            JSON.stringify({ lobbyId: context.members[0]!.lobbyId }),
            headers,
          );
        const existing = await Promise.all(context.grants.map((grant) => join(grant.token)));
        for (let index = 0; index < count; index++) {
          assert.equal(existing[index]!.status, 200);
          assert.equal(JSON.parse(existing[index]!.body).seatId, context.members[index]!.seatId);
          assert.equal(JSON.parse(existing[index]!.body).position, index);
        }
        const fresh = await context.access.issue(context.now());
        const denied = await join(fresh.token);
        assert.equal(denied.status, 409);
        assert.equal(denied.body, '');
        assert.equal(denied.cookie, undefined);
        const owner = await http(
          context.base,
          '/api/lobbies',
          'POST',
          `${GUEST_COOKIE_NAME}=${context.grants[0]!.token}`,
          origin,
          JSON.stringify({ requestId: randomUUID() }),
          headers,
        );
        assert.equal(owner.status, 200);
        const lobbyId = JSON.parse(owner.body).lobbyId;
        const extras = await Promise.all(
          Array.from({ length: 9 }, () => context.access.issue(context.now())),
        );
        const attempts = await Promise.all(
          extras.map((grant) =>
            http(
              context.base,
              '/api/lobbies/join',
              'POST',
              `${GUEST_COOKIE_NAME}=${grant.token}`,
              origin,
              JSON.stringify({ lobbyId }),
              headers,
            ),
          ),
        );
        const admitted = attempts
          .filter((reply) => reply.status === 200)
          .map((reply) => JSON.parse(reply.body));
        assert.equal(admitted.length, 7);
        assert.deepEqual(admitted.map((reply) => reply.position).sort(), [1, 2, 3, 4, 5, 6, 7]);
        assert.equal(new Set(admitted.map((reply) => reply.seatId)).size, 7);
        assert.equal(attempts.filter((reply) => reply.status === 409).length, 2);
      },
    );
  }

  await t.test('lobby HTTP creation is credential rate bounded, including retries', async (t) => {
    const context = await fixture(t, 2, 60000, undefined, false);
    const cookie = `${GUEST_COOKIE_NAME}=${context.grants[0]!.token}`;
    const headers = { 'Content-Type': 'application/json' };
    const body = JSON.stringify({ requestId: randomUUID() });
    for (let index = 0; index < 12; index++)
      assert.equal(
        (await http(context.base, '/api/lobbies', 'POST', cookie, origin, body, headers)).status,
        200,
      );
    const limited = await http(context.base, '/api/lobbies', 'POST', cookie, origin, body, headers);
    assert.equal(limited.status, 429);
    assert.equal(limited.body, '');
    assert.equal(limited.cookie, undefined);
  });

  await t.test(
    'failed HTTP creation emits no identity; original retry survives transport restart',
    async (t) => {
      const context = await fixture(t, 2, 60000, undefined, false);
      const requestId = randomUUID();
      const body = JSON.stringify({ requestId });
      const cookie = `${GUEST_COOKIE_NAME}=${context.grants[0]!.token}`;
      const headers = { 'Content-Type': 'application/json' };
      const fn = `http_creation_failure_${randomUUID().replaceAll('-', '')}`;
      await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.request_id = '${requestId}' THEN RAISE EXCEPTION 'PRIVATE creation failure'; END IF;
      RETURN NEW; END $$`);
      await pool.query(
        `CREATE TRIGGER ${fn} BEFORE INSERT ON penky_lobby_creation_requests FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
      );
      try {
        const failed = await http(
          context.base,
          '/api/lobbies',
          'POST',
          cookie,
          origin,
          body,
          headers,
        );
        assert.equal(failed.status, 503);
        assert.equal(failed.body, '');
        assert.equal(failed.cookie, undefined);
      } finally {
        await pool.query(`DROP TRIGGER ${fn} ON penky_lobby_creation_requests`);
        await pool.query(`DROP FUNCTION ${fn}()`);
      }
      const accepted = await http(
        context.base,
        '/api/lobbies',
        'POST',
        cookie,
        origin,
        body,
        headers,
      );
      assert.equal(accepted.status, 200);
      await context.transport.close();
      const replacement = new PenkyTransport({
        access: new PostgresGuestAccess(pool),
        host: context.host,
        tls: { key, cert },
        origins: [origin],
        now: context.now,
      });
      t.after(() => replacement.close());
      const base = await replacement.listen(0, '127.0.0.1');
      const recovered = await http(base, '/api/lobbies', 'POST', cookie, origin, body, headers);
      assert.equal(recovered.status, 200);
      assert.equal(recovered.body, accepted.body);
    },
  );

  await t.test(
    'chunked lobby bodies and invalid UTF-8 cannot bypass the raw byte boundary',
    async (t) => {
      const context = await fixture(t, 2, 60000, undefined, false);
      const cookie = `${GUEST_COOKIE_NAME}=${context.grants[0]!.token}`;
      for (const chunks of [
        [Buffer.from('{"requestId":"'), Buffer.from([0xc0, 0xaf]), Buffer.from('"}')],
        [Buffer.from(' '.repeat(1024)), Buffer.from(' '.repeat(1025))],
      ]) {
        const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = request(
            new URL('/api/lobbies', context.base),
            {
              method: 'POST',
              ca: cert,
              headers: {
                Origin: origin,
                Cookie: cookie,
                'Content-Type': 'application/json',
                'Transfer-Encoding': 'chunked',
              },
            },
            (res) => {
              let body = '';
              res.on('data', (chunk) => {
                body += String(chunk);
              });
              res.on('end', () => resolve({ status: res.statusCode!, body }));
            },
          );
          req.on('error', reject);
          for (const chunk of chunks) req.write(chunk);
          req.end();
        });
        assert.deepEqual(result, { status: 400, body: '' });
      }
    },
  );

  type Context = Awaited<ReturnType<typeof fixture>>;
  async function finishHosted(context: Context) {
    let snapshot = (await context.host.read(context.members[0]!.lobbyId))!.snapshot;
    await finishMatch({
      read: () => snapshot,
      dispatch: async (command, options) => {
        const result = await context.host.withCurrent(
          context.members[0]!.lobbyId,
          context.start.gameId,
          async (runtime) => {
            const result = await runtime.dispatch(command, {
              ...options,
              branchId: runtime.read().head.branchId,
            });
            snapshot = runtime.read();
            return result;
          },
        );
        // Trusted fixtures yield between atomic jobs; do not turn an entire
        // generated match into one host callback that starves all live readers.
        await until(async () =>
          context.clients
            .filter((socket) => socket.connected)
            .every(
              (socket) =>
                (latestState.get(socket)?.view.head.version ?? -1) >= snapshot.head.version,
            ),
        );
        return result;
      },
    });
    await context.acceptAll(); // A successor fixture must explicitly accept its next-match epoch.
  }
  async function play(
    context: Context,
    socket: Socket,
    intent: Record<string, unknown>,
    requestId: string = randomUUID(),
  ) {
    // Trusted auth wall time advances independently of the engine fake clock.
    context.setNow(context.now() + 1001);
    return message(socket, {
      protocolVersion: 1,
      requestId,
      intent: { gameId: context.start.gameId, branchId: context.start.branchId, ...intent },
    });
  }
  function accepted(reply: ServerMessage, outcome: 'played' | 'violation' | 'control' = 'played') {
    if (reply.type !== 'command-ack' || reply.result.type !== 'accepted')
      assert.fail(JSON.stringify(reply));
    assert.equal(reply.result.outcome, outcome);
    assert.deepEqual(Object.keys(reply).sort(), ['protocolVersion', 'requestId', 'result', 'type']);
    assert.deepEqual(Object.keys(reply.result).sort(), ['duplicate', 'head', 'outcome', 'type']);
    assert.deepEqual(Object.keys(reply.result.head).sort(), ['branchId', 'gameId', 'version']);
    return { ...reply, result: reply.result };
  }

  async function ready(context: Context) {
    for (let draw = 0; draw < 36; draw++)
      await context.host.withCurrent(
        context.members[0]!.lobbyId,
        context.start.gameId,
        async (runtime) => {
          const phase = runtime.read().state!.phase;
          if (phase.type !== 'dealing') assert.fail();
          await runtime.dispatch(
            {
              type: 'draw-card',
              id: id('command', randomUUID()),
              actorId: phase.nextSeatId,
            },
            { branchId: runtime.read().head.branchId },
          );
        },
      );
    await context.clock.advanceBy(10000);
    const head = (await context.host.read(context.members[0]!.lobbyId))!.snapshot.head;
    await until(async () =>
      context.clients
        .filter((socket) => socket.connected)
        .every((socket) => (latestState.get(socket)?.view.head.version ?? -1) >= head.version),
    );
  }

  await t.test(
    'one-seat lobbies cannot start and client configuration cannot supply the missing roster',
    async (t) => {
      const context = await fixture(t, 1, 60000, undefined, false);
      const socket = await context.connect();
      const lobbyId = context.members[0]!.lobbyId;
      await message(socket, resync(lobbyId));
      const input = {
        protocolVersion: 1,
        requestId: randomUUID(),
        intent: { type: 'start-match', lobbyId, expected: null },
      };
      const result = await message(socket, input);
      if (result.type !== 'match-start-ack' || result.result.type !== 'rejected') assert.fail();
      assert.equal(result.result.code, 'invalid-configuration');
      assert.equal(await context.host.read(lobbyId), null);
      assert.equal(
        await (
          await PostgresLobby.open(pool, lobbyId)
        ).startReceipt(id('command', input.requestId)),
        null,
      );
      const forged = await message(socket, {
        ...input,
        intent: { ...input.intent, seatIds: ['owner', 'fake'] },
      });
      assert.deepEqual(forged, { protocolVersion: 1, type: 'error', code: 'invalid-message' });
    },
  );

  await t.test(
    'a join winning after start preparation rejects the stale roster atomically and original-ID retry uses fresh membership',
    async (t) => {
      const context = await fixture(t, 2, 60000, undefined, false);
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      const lobbyId = context.members[0]!.lobbyId;
      for (const socket of sockets) await message(socket, resync(lobbyId));
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const create = PostgresSession.createLobbyGame;
      const spy = t.mock.method(
        PostgresSession,
        'createLobbyGame',
        async (...args: Parameters<typeof create>) => {
          entered.resolve();
          await release.promise;
          return Reflect.apply(create, PostgresSession, args);
        },
      );
      const request = {
        protocolVersion: 1,
        requestId: randomUUID(),
        intent: { type: 'start-match', lobbyId, expected: null },
      };
      const pending = message(sockets[0]!, request);
      try {
        await entered.promise;
        const grant = await context.access.issue(context.now());
        await context.access.joinLobby(grant.token, lobbyId, context.now());
        context.grants.push(grant);
        release.resolve();
        assert.deepEqual(await pending, {
          protocolVersion: 1,
          type: 'match-start-ack',
          requestId: request.requestId,
          result: { type: 'rejected', code: 'invalid-configuration' },
        });
        assert.equal((await (await PostgresLobby.open(pool, lobbyId)).read()).currentGameId, null);
        assert.equal(
          await (
            await PostgresLobby.open(pool, lobbyId)
          ).startReceipt(id('command', request.requestId)),
          null,
        );
      } finally {
        release.resolve();
        spy.mock.restore();
      }
      await context.acceptAll(); // The new member invalidated every old acceptance.
      const retry = await message(sockets[0]!, request);
      if (retry.type !== 'match-start-ack' || retry.result.type !== 'started') assert.fail();
      assert.equal(retry.result.duplicate, false);
      assert.equal((await context.host.read(lobbyId))!.snapshot.state!.players.length, 3);
    },
  );

  await t.test(
    'acceptance withdrawn after successor preparation refuses without closing the old writer',
    async (t) => {
      const context = await fixture(t);
      const lobbyId = context.members[0]!.lobbyId;
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      for (const socket of sockets) await message(socket, resync(lobbyId));
      await ready(context);
      await finishHosted(context);
      const before = (await context.host.read(lobbyId))!;
      const consent = await context.access.lobbyState(
        context.grants[0]!.token,
        lobbyId,
        context.now(),
      );
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const move = PostgresSession.prototype.startSuccessor;
      const held = t.mock.method(
        PostgresSession.prototype,
        'startSuccessor',
        async function (this: PostgresSession, ...args: Parameters<typeof move>) {
          entered.resolve();
          await release.promise;
          return Reflect.apply(move, this, args);
        },
      );
      const request = {
        protocolVersion: 1,
        requestId: randomUUID(),
        intent: { type: 'start-match', lobbyId, expected: before.snapshot.head },
      };
      const pending = message(sockets[0]!, request);
      try {
        await entered.promise;
        const withdrawn = await http(
          context.base,
          '/api/lobbies/ready',
          'POST',
          `${GUEST_COOKIE_NAME}=${context.grants[1]!.token}`,
          origin,
          JSON.stringify({ lobbyId, expectedRevision: consent.revision, ready: false }),
          { 'Content-Type': 'application/json' },
        );
        assert.equal(withdrawn.status, 200);
        release.resolve();
        assert.deepEqual(await pending, {
          protocolVersion: 1,
          type: 'match-start-ack',
          requestId: request.requestId,
          result: { type: 'rejected', code: 'not-ready' },
        });
      } finally {
        release.resolve();
        held.mock.restore();
      }
      const after = (await context.host.read(lobbyId))!;
      assert.equal(after.epoch, before.epoch);
      assert.deepEqual(after.snapshot, before.snapshot);
      assert.equal(
        await context.host.observeHistory(
          lobbyId,
          before.snapshot.head.gameId,
          async (capture) => capture.closedRollback,
        ),
        false,
      );
      assert.equal(
        await (
          await PostgresLobby.open(pool, lobbyId)
        ).startReceipt(id('command', request.requestId)),
        null,
      );
      const retained = await context.access.lobbyState(
        context.grants[0]!.token,
        lobbyId,
        context.now(),
      );
      assert.equal(retained.revision, consent.revision);
      assert.deepEqual(
        retained.members.map((member) => member.ready),
        [true, false],
      );
      await context.acceptAll();
      const retry = await message(sockets[0]!, request);
      assert.ok(retry.type === 'match-start-ack' && retry.result.type === 'started');
    },
  );

  await t.test(
    'failed successor transaction exposes no new game or receipt and retains the durable rollback window',
    async (t) => {
      const context = await fixture(t);
      const lobbyId = context.members[0]!.lobbyId;
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      for (const socket of sockets) await message(socket, resync(lobbyId));
      await ready(context);
      await finishHosted(context);
      const old = (await context.host.read(lobbyId))!.snapshot.head;
      const consentBeforeFailure = await context.access.lobbyState(
        context.grants[0]!.token,
        lobbyId,
        context.now(),
      );
      const failedWriter = (
        await pool.query<{ pid: number }>(
          'SELECT pid FROM pg_stat_activity WHERE application_name=$1',
          [`penky-game:${context.start.gameId}`],
        )
      ).rows[0]!.pid;
      const name = `start_fail_${randomUUID().replaceAll('-', '')}`;
      await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.game_id = '${context.start.gameId}' THEN RAISE EXCEPTION 'PRIVATE start failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER ${name} BEFORE INSERT ON penky_game_frames FOR EACH ROW EXECUTE FUNCTION ${name}()`);
      const remove = async () => {
        await pool.query(
          `DROP TRIGGER IF EXISTS ${name} ON penky_game_frames; DROP FUNCTION IF EXISTS ${name}()`,
        );
      };
      t.after(remove);
      const request = {
        protocolVersion: 1,
        requestId: randomUUID(),
        intent: { type: 'start-match', lobbyId, expected: old },
      };
      assert.deepEqual(await message(sockets[0]!, request), {
        protocolVersion: 1,
        type: 'error',
        code: 'unavailable',
      });
      await remove();
      assert.deepEqual(
        await context.access.lobbyState(context.grants[0]!.token, lobbyId, context.now()),
        consentBeforeFailure,
        'failed storage start never resets consent or epoch',
      );
      const lobby = await PostgresLobby.open(pool, lobbyId);
      assert.equal((await lobby.read()).currentGameId, old.gameId);
      assert.equal(await lobby.startReceipt(id('command', request.requestId)), null);
      const stored = await PostgresSession.load(pool, old.gameId);
      assert.deepEqual(stored!.snapshot.head, old);
      assert.equal(
        stored!.history.operations.some((operation) => operation.type === 'close-rollback'),
        false,
      );
      await until(
        async () =>
          !(await pool.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [failedWriter]))
            .rowCount,
      );
      const returned = await context.connect();
      await message(returned, resync(lobbyId));
      assert.equal(
        await context.host.observeHistory(
          lobbyId,
          old.gameId,
          async (capture) => capture.closedRollback,
        ),
        false,
      );
      const retry = await message(returned, request);
      if (retry.type !== 'match-start-ack' || retry.result.type !== 'started') assert.fail();
      assert.equal(retry.result.duplicate, false);
    },
  );

  await t.test(
    'successor start validates the observed result and historical retries never retarget the current game',
    async (t) => {
      const context = await fixture(t);
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      const lobbyId = context.members[0]!.lobbyId;
      for (const socket of sockets) await message(socket, resync(lobbyId));
      const send = (expected: unknown, requestId = randomUUID()) =>
        message(sockets[0]!, {
          protocolVersion: 1,
          requestId,
          intent: { type: 'start-match', lobbyId, expected },
        });
      const reject = (reply: ServerMessage, code: string) => {
        if (reply.type !== 'match-start-ack' || reply.result.type !== 'rejected')
          assert.fail(JSON.stringify(reply));
        assert.equal(reply.result.code, code);
      };
      const current = (await context.host.read(lobbyId))!.snapshot.head;
      reject(await send(current), 'wrong-phase');
      await ready(context);
      await finishHosted(context);
      const old = (await context.host.read(lobbyId))!.snapshot.head;
      reject(await send(null), 'wrong-game');
      reject(await send({ ...old, version: old.version - 1 }), 'version-conflict');
      reject(await send({ ...old, branchId: 'stale-branch' }), 'version-conflict');
      assert.deepEqual(
        await message(sockets[0]!, {
          protocolVersion: 1,
          requestId: randomUUID(),
          intent: { type: 'start-match', lobbyId, expected: old, cardIds: ['forged'] },
        }),
        { protocolVersion: 1, type: 'error', code: 'invalid-message' },
      );
      const requestId = randomUUID();
      const started = await send(old, requestId);
      if (started.type !== 'match-start-ack' || started.result.type !== 'started') assert.fail();
      const secondId = started.result.gameId;
      await until(async () =>
        sockets.every((socket) => latestState.get(socket)?.view.head.gameId === secondId),
      );
      const secondHead = (await context.host.read(lobbyId))!.snapshot.head;
      const secondContext = {
        ...context,
        start: { ...context.start, gameId: secondId, branchId: secondHead.branchId },
      };
      await ready(secondContext);
      await finishHosted(secondContext);
      const next = (await context.host.read(lobbyId))!.snapshot.head;
      const third = await send(next);
      if (third.type !== 'match-start-ack' || third.result.type !== 'started') assert.fail();
      const duplicate = await send(old, requestId);
      if (duplicate.type !== 'match-start-ack' || duplicate.result.type !== 'started')
        assert.fail();
      assert.equal(duplicate.result.gameId, secondId);
      assert.equal(duplicate.result.duplicate, true);
      assert.equal((await context.host.read(lobbyId))!.snapshot.head.gameId, third.result.gameId);
      await context.host.withCurrent(lobbyId, third.result.gameId, (runtime) =>
        runtime.dispatch({
          type: 'rollback',
          id: id('command', randomUUID()),
          actorId: context.members[0]!.seatId,
          expected: runtime.read().head,
          beforeCommandId: third.requestId,
          knowledgeWarningAcknowledged: true,
        }),
      );
      const empty = (await context.host.read(lobbyId))!.snapshot;
      assert.equal(empty.state, null);
      reject(await send(null), 'wrong-game');
      reject(await send(empty.head), 'wrong-phase');
    },
  );

  for (const stage of ['lookup', 'handoff'] as const)
    for (const mode of ['disconnect', 'revoke', 'expire'] as const)
      await t.test(
        `${mode} before start ${stage} admission cannot use another tab's retained owner presence`,
        async (t) => {
          const context = await fixture(t, 2, 60000, undefined, stage === 'handoff');
          const sockets = await Promise.all([context.connect(), context.connect(1)]);
          const lobbyId = context.members[0]!.lobbyId;
          for (const socket of sockets) await message(socket, resync(lobbyId));
          const keeper = await context.connect();
          await message(keeper, resync(lobbyId));
          if (stage === 'handoff') {
            await ready(context);
            await finishHosted(context);
          }
          const before = await context.host.read(lobbyId);
          const expected = before?.snapshot.head ?? null;
          const release = Promise.withResolvers<void>();
          const entered = Promise.withResolvers<void>();
          const requested = Promise.withResolvers<void>();
          let blocked: Promise<unknown>;
          let restore: () => void;
          if (stage === 'lookup') {
            blocked = context.host.chatHistory(lobbyId, '0', 1, {
              admit: async () => {
                entered.resolve();
                await release.promise;
                return true;
              },
            });
            const start = context.host.startFromIntent.bind(context.host);
            const spy = t.mock.method(
              context.host,
              'startFromIntent',
              (...args: Parameters<typeof start>) => {
                requested.resolve();
                return start(...args);
              },
            );
            restore = () => spy.mock.restore();
          } else {
            await context.host.withCurrent(lobbyId, context.start.gameId, async (runtime) => {
              blocked = runtime.observe(async () => {
                entered.resolve();
                await release.promise;
              });
              await entered.promise;
            });
            const handoff = GameRuntime.prototype.handoff;
            const spy = t.mock.method(
              GameRuntime.prototype,
              'handoff',
              function (this: GameRuntime, ...args: Parameters<typeof handoff>) {
                requested.resolve();
                return Reflect.apply(handoff, this, args);
              },
            );
            restore = () => spy.mock.restore();
          }
          await entered.promise;
          const received: ServerMessage[] = [];
          sockets[0]!.on('server-message', (reply: ServerMessage) => received.push(reply));
          const requestId = randomUUID();
          sockets[0]!.emit('client-message', {
            protocolVersion: 1,
            requestId,
            intent: { type: 'start-match', lobbyId, expected },
          });
          let revoking: ReturnType<typeof http> | null = null;
          try {
            await requested.promise;
            if (mode === 'disconnect') {
              sockets[0]!.disconnect();
              await http(
                context.base,
                '/api/guest/session/refresh',
                'POST',
                `${GUEST_COOKIE_NAME}=${context.grants[0]!.token}`,
              );
            } else if (mode === 'expire') {
              context.setNow(
                (await context.access.inspect(context.grants[0]!.token, context.now()))!
                  .expiresAtMs,
              );
              await context.transport.checkCredentials();
            } else {
              const closed = once(sockets[0]!, 'disconnect');
              revoking = http(
                context.base,
                '/api/guest/session',
                'DELETE',
                `${GUEST_COOKIE_NAME}=${context.grants[0]!.token}`,
              );
              await closed;
            }
            release.resolve();
            await blocked!;
            if (revoking) await revoking;
            assert.deepEqual((await context.host.read(lobbyId))?.snapshot.head ?? null, expected);
            assert.equal(
              await (
                await PostgresLobby.open(pool, lobbyId)
              ).startReceipt(id('command', requestId)),
              null,
            );
            if (before)
              assert.equal(
                await context.host.observeHistory(
                  lobbyId,
                  context.start.gameId,
                  async (capture) => capture.closedRollback,
                ),
                false,
              );
            assert.equal(
              received.some((reply) => reply.type === 'match-start-ack'),
              false,
            );
          } finally {
            release.resolve();
            restore!();
          }
        },
      );

  for (const count of [2, 4, 8])
    await t.test(
      `${count} seats start once from owner intent, retry canonically and receive private state-only resync`,
      async (t) => {
        const context = await fixture(t, count, 60000, undefined, false);
        const sockets = await Promise.all(
          context.grants.map((_grant, index) => context.connect(index)),
        );
        const lobbyId = context.members[0]!.lobbyId;
        for (const socket of sockets) await message(socket, resync(lobbyId));
        const extra = await context.connect();
        await message(extra, resync(lobbyId));
        const request = {
          protocolVersion: 1,
          requestId: randomUUID(),
          intent: { type: 'start-match', lobbyId, expected: null },
        };
        const starts = await Promise.all([message(sockets[0]!, request), message(extra, request)]);
        const gameIds: string[] = [];
        const duplicates: boolean[] = [];
        for (const reply of starts) {
          if (reply.type !== 'match-start-ack' || reply.result.type !== 'started')
            assert.fail(JSON.stringify(reply));
          assert.deepEqual(Object.keys(reply.result).sort(), ['duplicate', 'gameId', 'type']);
          gameIds.push(reply.result.gameId);
          duplicates.push(reply.result.duplicate);
        }
        assert.equal(new Set(gameIds).size, 1);
        assert.deepEqual(duplicates.sort(), [false, true]);
        for (const socket of sockets) {
          const baseline = await message(socket, resync(lobbyId));
          if (baseline.type !== 'state') assert.fail();
          assert.equal(baseline.view.head.gameId, gameIds[0]);
        }
        assert.deepEqual(await message(sockets[1]!, request), {
          protocolVersion: 1,
          type: 'error',
          code: 'unauthorized',
        });
        const head = (await context.host.read(lobbyId))!.snapshot.head;
        const changed = await message(sockets[0]!, {
          ...request,
          intent: { ...request.intent, expected: head },
        });
        if (changed.type !== 'match-start-ack' || changed.result.type !== 'rejected') assert.fail();
        assert.equal(changed.result.code, 'command-id-reused');
        await context.host.recover(lobbyId);
        await message(sockets[0]!, resync(lobbyId));
        const retry = await message(sockets[0]!, request);
        if (retry.type !== 'match-start-ack' || retry.result.type !== 'started') assert.fail();
        assert.equal(retry.result.gameId, gameIds[0]);
        assert.equal(retry.result.duplicate, true);
        assert.equal((await context.host.read(lobbyId))!.snapshot.state!.deck.length, 36);
      },
    );

  await t.test(
    'resync discards prepared chat history waiting for the host without disconnecting the participant',
    async (t) => {
      const context = await fixture(t, 2, 60000);
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      const lobbyId = context.members[0]!.lobbyId;
      let cancelled!: () => void;
      const cancellation = new Promise<void>((resolve) => {
        cancelled = resolve;
      });
      const subscribe = context.host.subscribe.bind(context.host);
      const subscription = t.mock.method(
        context.host,
        'subscribe',
        async (...args: Parameters<typeof subscribe>) => {
          const stop = await subscribe(...args);
          return () => {
            cancelled();
            stop();
          };
        },
      );
      for (const socket of sockets) await message(socket, resync(lobbyId));
      let release!: () => void;
      let entered!: () => void;
      let queued!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const requested = new Promise<void>((resolve) => {
        queued = resolve;
      });
      const history = context.host.chatHistory.bind(context.host);
      const historyCall = t.mock.method(
        context.host,
        'chatHistory',
        (...args: Parameters<typeof history>) => {
          queued();
          return history(...args);
        },
      );
      const blocked = context.host.withCurrent(lobbyId, context.start.gameId, async () => {
        entered();
        await gate;
      });
      await waiting;
      const seen: ServerMessage[] = [];
      sockets[0]!.on('server-message', (value: ServerMessage) => seen.push(value));
      sockets[0]!.emit('client-message', {
        protocolVersion: 1,
        requestId: randomUUID(),
        intent: { type: 'chat-history', lobbyId, afterSequence: '0', limit: 100 },
      });
      try {
        await requested;
        const baseline = message(sockets[0]!, resync(lobbyId));
        await cancellation;
        release();
        await blocked;
        assert.equal((await baseline).type, 'state');
        assert.equal(sockets[0]!.connected, true);
        assert.equal(
          seen.some((value) => value.type === 'chat-page'),
          false,
        );
      } finally {
        release();
        subscription.mock.restore();
        historyCall.mock.restore();
      }
    },
  );

  await t.test(
    'chat pages obey serialized byte limits, preserve cursor order and fail fixed on an oversized trusted row',
    async (t) => {
      const context = await fixture(t, 2, 60000, undefined, false);
      const socket = await context.connect();
      const lobbyId = context.members[0]!.lobbyId;
      await message(socket, resync(lobbyId));
      const lobby = await PostgresLobby.open(pool, lobbyId);
      const text = '\n'.repeat(4096);
      const ids: string[] = [];
      for (let index = 0; index < 20; index++) {
        const input = {
          id: id('message', randomUUID()),
          authorSessionId: context.members[0]!.sessionId,
          authorSeatId: context.members[0]!.seatId,
          text,
        };
        ids.push(input.id);
        await lobby.postChat(input, context.now());
      }
      let cursor = '0';
      const seen: string[] = [];
      for (let iteration = 0; iteration < 20; iteration++) {
        const reply = await message(socket, {
          protocolVersion: 1,
          requestId: randomUUID(),
          intent: { type: 'chat-history', lobbyId, afterSequence: cursor, limit: 100 },
        });
        if (reply.type !== 'chat-page') assert.fail(JSON.stringify(reply));
        assert.ok(Buffer.byteLength(JSON.stringify(reply)) + 128 <= 65536);
        if (!reply.messages.length) break;
        assert.ok(reply.messages.length < 20);
        for (const row of reply.messages) {
          assert.equal(row.text, text);
          seen.push(row.id);
        }
        cursor = reply.messages.at(-1)!.sequence;
      }
      assert.deepEqual(seen, ids);
      await lobby.postChat(
        {
          id: id('message', randomUUID()),
          authorSessionId: context.members[0]!.sessionId,
          authorSeatId: context.members[0]!.seatId,
          text: '\u0001'.repeat(20000),
        },
        context.now(),
      );
      assert.deepEqual(
        await message(socket, {
          protocolVersion: 1,
          requestId: randomUUID(),
          intent: { type: 'chat-history', lobbyId, afterSequence: cursor, limit: 100 },
        }),
        { protocolVersion: 1, type: 'error', code: 'unavailable' },
      );
      assert.equal(socket.connected, true);
    },
  );

  await t.test(
    'chat INSERT failure returns no accepted message, leaves gameplay healthy and permits the original-ID retry',
    async (t) => {
      const context = await fixture(t);
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      const lobbyId = context.members[0]!.lobbyId;
      for (const socket of sockets) await message(socket, resync(lobbyId));
      const before = (await context.host.read(lobbyId))!.snapshot;
      const name = `chat_fail_${randomUUID().replaceAll('-', '')}`;
      await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.lobby_id = '${lobbyId}' THEN RAISE EXCEPTION 'PRIVATE chat failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER ${name} BEFORE INSERT ON penky_lobby_chat FOR EACH ROW EXECUTE FUNCTION ${name}()`);
      const remove = async () => {
        await pool.query(
          `DROP TRIGGER IF EXISTS ${name} ON penky_lobby_chat; DROP FUNCTION IF EXISTS ${name}()`,
        );
      };
      t.after(remove);
      const input = {
        protocolVersion: 1,
        requestId: randomUUID(),
        intent: { type: 'post-chat', lobbyId, messageId: randomUUID(), text: 'Retry me' },
      };
      assert.deepEqual(await message(sockets[0]!, input), {
        protocolVersion: 1,
        type: 'error',
        code: 'unavailable',
      });
      assert.deepEqual((await context.host.read(lobbyId))!.snapshot, before);
      assert.equal(
        await (
          await PostgresLobby.open(pool, lobbyId)
        ).message(id('message', input.intent.messageId)),
        null,
      );
      await remove();
      const posted = await message(sockets[0]!, input);
      if (posted.type !== 'chat-page') assert.fail();
      assert.equal(posted.messages.length, 1);
      assert.equal(posted.messages[0]!.id, input.intent.messageId);
    },
  );

  await t.test(
    'members chat before any match without obtaining a game view, and retries retain lobby context after start',
    async (t) => {
      const context = await fixture(t, 2, 60000, undefined, false);
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      const lobbyId = context.members[0]!.lobbyId;
      const seen: ServerMessage[] = [];
      sockets[0]!.on('server-message', (value: ServerMessage) => seen.push(value));
      for (const socket of sockets)
        assert.deepEqual(await message(socket, resync(lobbyId)), {
          protocolVersion: 1,
          type: 'error',
          code: 'unavailable',
        });
      const request = {
        protocolVersion: 1,
        requestId: randomUUID(),
        intent: {
          type: 'post-chat',
          lobbyId,
          messageId: randomUUID(),
          text: '  before the match  ',
        },
      };
      const first = await message(sockets[0]!, request);
      if (first.type !== 'chat-page') assert.fail();
      assert.deepEqual(first.messages[0]!.context, {
        head: null,
        scope: 'lobby',
        scopeNumber: null,
      });
      assert.equal(await context.host.read(lobbyId), null);
      assert.equal(
        seen.some((value) => value.type === 'state' || value.type === 'action'),
        false,
      );
      assert.deepEqual(
        await message(sockets[0]!, {
          ...request,
          intent: { ...request.intent, lobbyId: 'wrong-lobby' },
        }),
        { protocolVersion: 1, type: 'error', code: 'unauthorized' },
      );
      assert.equal((await context.host.startMatch(lobbyId, context.start)).type, 'started');
      for (const socket of sockets) await message(socket, resync(lobbyId));
      const retry = await message(sockets[0]!, request);
      if (retry.type !== 'chat-page') assert.fail();
      assert.deepEqual(retry.messages, first.messages);
      const next = await message(sockets[1]!, {
        ...request,
        requestId: randomUUID(),
        intent: { ...request.intent, messageId: randomUUID() },
      });
      if (next.type !== 'chat-page') assert.fail();
      assert.equal(next.messages[0]!.context.scope, 'dealing');
    },
  );

  await t.test(
    'lobby-only members can chat after finishing and rollback without receiving the old match state',
    async (t) => {
      const context = await fixture(t);
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      const lobbyId = context.members[0]!.lobbyId;
      for (const socket of sockets) await message(socket, resync(lobbyId));
      await ready(context);
      await finishHosted(context);
      const guest = await context.access.issue(context.now());
      const member = await context.access.joinLobby(guest.token, lobbyId, context.now());
      const socket = context.client(guest.token);
      await once(socket, 'connect');
      const seen: ServerMessage[] = [];
      socket.on('server-message', (value: ServerMessage) => seen.push(value));
      assert.deepEqual(await message(socket, resync(lobbyId)), {
        protocolVersion: 1,
        type: 'error',
        code: 'unauthorized',
      });
      const request = {
        protocolVersion: 1,
        requestId: randomUUID(),
        intent: {
          type: 'post-chat',
          lobbyId,
          messageId: randomUUID(),
          text: 'Lobby member, not match participant',
        },
      };
      const posted = await message(socket, request);
      if (posted.type !== 'chat-page') assert.fail();
      assert.equal(posted.messages[0]!.authorSeatId, member.seatId);
      assert.equal(posted.messages[0]!.context.scope, 'lobby');
      await context.host.withCurrent(lobbyId, context.start.gameId, (runtime) =>
        runtime.dispatch({
          type: 'rollback',
          id: id('command', randomUUID()),
          actorId: context.members[0]!.seatId,
          expected: runtime.read().head,
          beforeCommandId: context.start.id,
          knowledgeWarningAcknowledged: true,
        }),
      );
      const page = await message(socket, {
        protocolVersion: 1,
        requestId: randomUUID(),
        intent: { type: 'chat-history', lobbyId, afterSequence: '0', limit: 100 },
      });
      if (page.type !== 'chat-page') assert.fail();
      assert.deepEqual(page.messages, posted.messages);
      assert.equal(
        seen.some(
          (value) =>
            value.type === 'state' || value.type === 'action' || value.type === 'owner-history',
        ),
        false,
      );
    },
  );

  await t.test(
    'retained post replies and evidence preserve their original branch across rollback, recovery and successor adoption',
    async (t) => {
      const context = await fixture(t);
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      const lobbyId = context.members[0]!.lobbyId;
      for (const socket of sockets) await message(socket, resync(lobbyId));
      const drawId = randomUUID();
      accepted(await play(context, sockets[1]!, { type: 'draw-card' }, drawId));
      const request = {
        protocolVersion: 1,
        requestId: randomUUID(),
        intent: {
          type: 'post-chat',
          lobbyId,
          messageId: randomUUID(),
          text: 'Retained abandoned evidence',
        },
      };
      const original = await message(sockets[0]!, request);
      if (original.type !== 'chat-page') assert.fail();
      await context.host.withCurrent(lobbyId, context.start.gameId, (runtime) =>
        runtime.dispatch({
          type: 'rollback',
          id: id('command', randomUUID()),
          actorId: context.members[0]!.seatId,
          expected: runtime.read().head,
          beforeCommandId: id('command', drawId),
          knowledgeWarningAcknowledged: true,
        }),
      );
      let retry = await message(sockets[0]!, request);
      if (retry.type !== 'chat-page') assert.fail();
      assert.deepEqual(retry.messages, original.messages);
      const fork = (await context.host.read(lobbyId))!.snapshot.head;
      const claim = await play(context, sockets[1]!, {
        type: 'submit-claim',
        branchId: fork.branchId,
        accusedId: context.members[0]!.seatId,
        reason: 'Old chat is not current evidence',
        evidence: { type: 'chat', messageId: request.intent.messageId },
      });
      if (claim.type !== 'command-ack' || claim.result.type !== 'rejected') assert.fail();
      assert.equal(claim.result.code, 'invalid-claim');
      await context.host.recover(lobbyId);
      for (const socket of sockets) await message(socket, resync(lobbyId));
      retry = await message(sockets[0]!, request);
      if (retry.type !== 'chat-page') assert.fail();
      assert.deepEqual(retry.messages, original.messages);
      await ready(context);
      await finishHosted(context);
      const old = (await context.host.read(lobbyId))!.snapshot.head;
      const next = {
        ...context.start,
        id: id('command', randomUUID()),
        gameId: id('game', randomUUID()),
        branchId: id('branch', randomUUID()),
        expectedGameId: old.gameId,
        expectedHead: old,
      };
      assert.equal((await context.host.startMatch(lobbyId, next)).type, 'started');
      for (const socket of sockets) await message(socket, resync(lobbyId));
      retry = await message(sockets[0]!, request);
      if (retry.type !== 'chat-page') assert.fail();
      assert.deepEqual(retry.messages, original.messages);
    },
  );

  for (const count of [2, 4, 8])
    await t.test(
      `${count} lobby members post exact chat with immutable message-ID retries and ordered private-safe pages`,
      async (t) => {
        const context = await fixture(t, count);
        const sockets = await Promise.all(
          context.grants.map((_grant, index) => context.connect(index)),
        );
        const lobbyId = context.members[0]!.lobbyId;
        for (const socket of sockets) await message(socket, resync(lobbyId));
        const requestId = randomUUID();
        const messageId = randomUUID();
        const intent = {
          type: 'post-chat',
          lobbyId,
          messageId,
          text: '  Привіт 😀\n<script>not HTML</script>  ',
        };
        const input = { protocolVersion: 1, requestId, intent };
        const first = await message(sockets[0]!, input);
        if (first.type !== 'chat-page') assert.fail(JSON.stringify(first));
        assert.equal(first.messages.length, 1);
        assert.equal(first.messages[0]!.authorSeatId, context.members[0]!.seatId);
        assert.equal(first.messages[0]!.text, intent.text);
        assert.equal(first.messages[0]!.context.scope, 'dealing');
        assert.equal(first.messages[0]!.context.head!.gameId, context.start.gameId);
        assert.equal(first.messages[0]!.atMs, context.clock.now());
        assert.equal(JSON.stringify(first).includes(context.members[0]!.sessionId), false);
        const duplicate = await message(sockets[0]!, { ...input, requestId: randomUUID() });
        if (duplicate.type !== 'chat-page') assert.fail();
        assert.deepEqual(duplicate.messages, first.messages);
        const changed = await message(sockets[0]!, {
          ...input,
          intent: { ...intent, text: 'changed' },
        });
        assert.deepEqual(changed, { protocolVersion: 1, type: 'error', code: 'unavailable' });
        assert.deepEqual(await message(sockets[1]!, input), changed);
        const second = await message(sockets[0]!, {
          ...input,
          intent: {
            ...intent,
            messageId: randomUUID(),
            text: 'Second message, same correlation ID',
          },
        });
        if (second.type !== 'chat-page') assert.fail();
        const page = (afterSequence: string) =>
          message(sockets[1]!, {
            protocolVersion: 1,
            requestId: randomUUID(),
            intent: { type: 'chat-history', lobbyId, afterSequence, limit: 1 },
          });
        const one = await page('0');
        if (one.type !== 'chat-page') assert.fail();
        assert.deepEqual(one.messages, first.messages);
        const two = await page(one.messages[0]!.sequence);
        if (two.type !== 'chat-page') assert.fail();
        assert.deepEqual(two.messages, second.messages);
        const empty = await page(two.messages[0]!.sequence);
        if (empty.type !== 'chat-page') assert.fail();
        assert.deepEqual(empty.messages, []);
      },
    );

  await t.test(
    'a history request queued before resync cannot adopt its new stream generation',
    async (t) => {
      const context = await fixture(t, 2, 60000);
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      let invalidated!: () => void;
      const cancelled = new Promise<void>((resolve) => {
        invalidated = resolve;
      });
      const subscribe = context.host.subscribe.bind(context.host);
      const subscription = t.mock.method(
        context.host,
        'subscribe',
        async (...args: Parameters<typeof subscribe>) => {
          const stop = await subscribe(...args);
          return () => {
            invalidated();
            stop();
          };
        },
      );
      const lobbyId = context.members[0]!.lobbyId;
      for (const socket of sockets) await message(socket, resync(lobbyId));
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const membership = context.access.membership.bind(context.access);
      let blocked = false;
      const auth = t.mock.method(
        context.access,
        'membership',
        async (...args: Parameters<typeof membership>) => {
          if (!blocked) {
            blocked = true;
            entered();
            await gate;
          }
          return membership(...args);
        },
      );
      const seen: ServerMessage[] = [];
      sockets[0]!.on('server-message', (message: ServerMessage) => seen.push(message));
      const pending = play(context, sockets[0]!, { type: 'take-bottom' });
      await waiting;
      sockets[0]!.emit('client-message', {
        protocolVersion: 1,
        requestId: randomUUID(),
        intent: { type: 'owner-history', gameId: context.start.gameId },
      });
      const baseline = message(sockets[0]!, resync(lobbyId));
      try {
        await cancelled;
        release();
        await pending;
        assert.equal((await baseline).type, 'state');
        assert.equal(
          seen.some((message) => message.type === 'owner-history'),
          false,
        );
      } finally {
        release();
        auth.mock.restore();
        subscription.mock.restore();
      }
    },
  );

  await t.test(
    'owner history pages terminate when a tiny budget cannot fit the correlated failure',
    async (t) => {
      const bytes = 600;
      const context = await fixture(t, 2, 60000, { bytes, ackTimeoutMs: 100 });
      const lobbyId = context.members[0]!.lobbyId;
      const detach = await context.host.attach(
        await context.access.membership(context.grants[0]!.token, lobbyId, context.now()),
      );
      t.after(detach);
      const snapshot = (await context.host.read(lobbyId))!.snapshot;
      const rollback = await context.host.rollback(lobbyId, context.start.gameId, {
        id: id('command', randomUUID()),
        actorId: context.members[0]!.seatId,
        target: {
          expected: { gameId: context.start.gameId, branch: 1, version: snapshot.head.version },
          beforeActionVersion: 1,
        },
        knowledgeWarningAcknowledged: true,
      });
      assert.equal(rollback.type, 'accepted');
      const socket = await context.connect();
      const baseline = await message(socket, resync(lobbyId));
      if (baseline.type !== 'state') assert.fail();
      assert.equal(baseline.view.state, null);
      assert.ok(Buffer.byteLength(JSON.stringify(baseline)) + 128 <= bytes);
      // Let the acknowledged baseline release the sole 600-byte wire reservation.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(socket.connected, true);
      const requestId = '界'.repeat(128);
      assert.ok(
        Buffer.byteLength(
          JSON.stringify({
            protocolVersion: 1,
            type: 'owner-history-page',
            requestId,
            delivery: baseline.delivery,
            result: { type: 'unavailable' },
          }),
        ) +
          128 >
          bytes,
      );
      const reply = await message(socket, {
        protocolVersion: 1,
        requestId,
        intent: {
          type: 'owner-history-page',
          gameId: context.start.gameId,
          cursor: null,
          limit: 1,
        },
      });
      assert.deepEqual(reply, { protocolVersion: 1, type: 'error', code: 'unavailable' });
      assert.ok(Buffer.byteLength(JSON.stringify(reply)) + 128 <= bytes);
      assert.equal(socket.connected, true);
    },
  );

  await t.test('owner history pages revalidate authorization, branches and recovery', async (t) => {
    const context = await fixture(t, 8, 60000);
    const sockets = await Promise.all(
      context.grants.map((_grant, index) => context.connect(index)),
    );
    const lobbyId = context.members[0]!.lobbyId;
    for (const socket of sockets) await message(socket, resync(lobbyId));
    const readPage = async (
      cursor: OwnerHistoryCursor | null = null,
      index = 0,
      gameId = context.start.gameId,
    ) => {
      const requestId = randomUUID();
      const response = await message(sockets[index]!, {
        protocolVersion: 1,
        requestId,
        intent: { type: 'owner-history-page', gameId, cursor, limit: 1 },
      });
      if (response.type === 'owner-history-page') {
        assert.equal(response.requestId, requestId);
        assert.ok(Buffer.byteLength(JSON.stringify(response)) + 128 <= 65536);
        for (const card of context.start.cardIds)
          assert.equal(JSON.stringify(response).includes(card), false);
      }
      return response;
    };
    assert.deepEqual(await readPage(null, 1), {
      protocolVersion: 1,
      type: 'error',
      code: 'unauthorized',
    });
    assert.deepEqual(await readPage(null, 0, id('game', 'wrong')), {
      protocolVersion: 1,
      type: 'error',
      code: 'wrong-game',
    });
    const first = await readPage();
    if (first.type !== 'owner-history-page' || first.result.type !== 'page' || !first.result.next)
      assert.fail();
    const cursor = first.result.next;
    assert.ok(await context.host.recover(lobbyId));
    await message(sockets[0]!, resync(lobbyId));
    const recovered = await readPage(cursor);
    if (recovered.type !== 'owner-history-page') assert.fail();
    // Recovery rebinds presence and can record public clock actions; old cursors must not silently resume.
    assert.equal(recovered.result.type, 'stale');
    const history = await message(sockets[0]!, {
      protocolVersion: 1,
      requestId: randomUUID(),
      intent: { type: 'owner-history', gameId: context.start.gameId },
    });
    if (history.type !== 'owner-history') assert.fail();
    accepted(
      await message(sockets[0]!, {
        protocolVersion: 1,
        requestId: randomUUID(),
        intent: {
          type: 'rollback',
          target: { expected: history.view.head, beforeActionVersion: 1 },
          knowledgeWarningAcknowledged: true,
        },
      }),
      'control',
    );
    const stale = await readPage(cursor);
    if (stale.type !== 'owner-history-page') assert.fail();
    assert.deepEqual(stale.result, { type: 'stale' });
    const empty = await readPage();
    if (empty.type !== 'owner-history-page' || empty.result.type !== 'page') assert.fail();
    assert.equal(empty.result.head.version, 0);
    assert.equal(empty.result.entries[0]!.type, 'branch');
    assert.ok(empty.result.next);
    await context.access.revoke(context.grants[0]!.token, Date.now());
    assert.deepEqual(await readPage(empty.result.next), {
      protocolVersion: 1,
      type: 'error',
      code: 'unauthorized',
    });
  });

  await t.test(
    'owner history pages reject same-head committed closure after finishing',
    async (t) => {
      const context = await fixture(t);
      const socket = await context.connect();
      const other = await context.connect(1);
      const lobbyId = context.members[0]!.lobbyId;
      await message(socket, resync(lobbyId));
      await message(other, resync(lobbyId));
      await ready(context);
      await finishHosted(context);
      const request = (cursor: OwnerHistoryCursor | null) =>
        message(socket, {
          protocolVersion: 1,
          requestId: randomUUID(),
          intent: { type: 'owner-history-page', gameId: context.start.gameId, cursor, limit: 1 },
        });
      const first = await request(null);
      if (first.type !== 'owner-history-page' || first.result.type !== 'page' || !first.result.next)
        assert.fail();
      assert.equal(first.result.rollbackOpen, true);
      await context.host.withCurrent(lobbyId, context.start.gameId, async (runtime) => {
        await runtime.closeForNextMatch();
      });
      const stale = await request(first.result.next);
      if (stale.type !== 'owner-history-page') assert.fail();
      assert.deepEqual(stale.result, { type: 'stale' });
      const closed = await request(null);
      if (closed.type !== 'owner-history-page' || closed.result.type !== 'page') assert.fail();
      assert.equal(closed.result.rollbackOpen, false);
      assert.deepEqual(closed.result.head, first.result.head);
    },
  );

  await t.test(
    'owner history and rollback enforce ownership, warning, exact heads and canonical retries across forks/recovery',
    async (t) => {
      const context = await fixture(t);
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      const lobbyId = context.members[0]!.lobbyId;
      for (const socket of sockets) await message(socket, resync(lobbyId));
      const historyRequest = {
        protocolVersion: 1,
        requestId: randomUUID(),
        intent: { type: 'owner-history', gameId: context.start.gameId },
      };
      assert.deepEqual(await message(sockets[1]!, historyRequest), {
        protocolVersion: 1,
        type: 'error',
        code: 'unauthorized',
      });
      assert.deepEqual(
        await message(sockets[0]!, {
          ...historyRequest,
          intent: { ...historyRequest.intent, gameId: 'wrong' },
        }),
        { protocolVersion: 1, type: 'error', code: 'wrong-game' },
      );
      const read = async () => (await context.host.read(lobbyId))!.snapshot;
      const draw = async () => {
        const snapshot = await read();
        if (snapshot.state!.phase.type !== 'dealing') assert.fail();
        const actor = context.members.findIndex(
          (seat) =>
            snapshot.state!.phase.type === 'dealing' &&
            seat.seatId === snapshot.state!.phase.nextSeatId,
        );
        accepted(
          await play(context, sockets[actor]!, {
            type: 'draw-card',
            branchId: snapshot.head.branchId,
          }),
        );
      };
      await draw();
      let history = await message(sockets[0]!, historyRequest);
      if (history.type !== 'owner-history') assert.fail();
      const target = {
        expected: history.view.head,
        beforeActionVersion: history.view.head.version,
      };
      const request = {
        protocolVersion: 1,
        requestId: randomUUID(),
        intent: { type: 'rollback', target, knowledgeWarningAcknowledged: true },
      };
      const reject = (reply: ServerMessage, code: string) => {
        if (reply.type !== 'command-ack' || reply.result.type !== 'rejected')
          assert.fail(JSON.stringify(reply));
        assert.equal(reply.result.code, code);
      };
      reject(
        await message(sockets[0]!, {
          ...request,
          intent: { ...request.intent, knowledgeWarningAcknowledged: false },
        }),
        'warning-required',
      );
      reject(
        await message(sockets[0]!, {
          ...request,
          intent: {
            ...request.intent,
            target: { ...target, expected: { ...target.expected, branch: 999 } },
          },
        }),
        'unknown-target',
      );
      const notice: ServerMessage[] = [];
      sockets[0]!.on('server-message', (value: ServerMessage) => {
        if (value.type === 'rollback-notice') notice.push(value);
      });
      const first = accepted(await message(sockets[0]!, request), 'control');
      reject(await message(sockets[0]!, { ...request, requestId: randomUUID() }), 'wrong-branch');
      reject(
        await message(sockets[0]!, {
          ...request,
          intent: { ...request.intent, knowledgeWarningAcknowledged: false },
        }),
        'command-id-reused',
      );
      await draw();
      history = await message(sockets[0]!, historyRequest);
      if (history.type !== 'owner-history') assert.fail();
      const next = {
        protocolVersion: 1,
        requestId: randomUUID(),
        intent: {
          type: 'rollback',
          target: { expected: history.view.head, beforeActionVersion: history.view.head.version },
          knowledgeWarningAcknowledged: true,
        },
      };
      await draw();
      reject(await message(sockets[0]!, next), 'version-conflict');
      history = await message(sockets[0]!, historyRequest);
      if (history.type !== 'owner-history') assert.fail();
      accepted(
        await message(sockets[0]!, {
          ...next,
          intent: {
            ...next.intent,
            target: { expected: history.view.head, beforeActionVersion: history.view.head.version },
          },
        }),
        'control',
      );
      assert.ok(await context.host.recover(lobbyId));
      await message(sockets[0]!, resync(lobbyId));
      assert.deepEqual(accepted(await message(sockets[0]!, request), 'control').result, {
        ...first.result,
        duplicate: true,
      });
      history = await message(sockets[0]!, historyRequest);
      if (history.type !== 'owner-history') assert.fail();
      assert.equal(history.view.branches.length, 3);
      assert.equal(history.view.head.branch, 3);
      assert.equal(notice.length, 2, 'no replay after retry or recovery');
    },
  );

  for (const count of [2, 4, 8])
    await t.test(
      `${count} seats receive a safe rollback notice, while only owner receives metadata history`,
      async (t) => {
        const context = await fixture(t, count);
        const sockets = await Promise.all(
          context.grants.map((_grant, index) => context.connect(index)),
        );
        const lobbyId = context.members[0]!.lobbyId;
        for (const socket of sockets) await message(socket, resync(lobbyId));
        const history = await message(sockets[0]!, {
          protocolVersion: 1,
          requestId: randomUUID(),
          intent: { type: 'owner-history', gameId: context.start.gameId },
        });
        if (history.type !== 'owner-history') assert.fail(JSON.stringify(history));
        const serialized = JSON.stringify(history);
        for (const card of context.start.cardIds) assert.equal(serialized.includes(card), false);
        for (const key of ['"face"', '"events"', '"state"', '"commandId"', '"branchId"'])
          assert.equal(serialized.includes(key), false, key);
        const seen = sockets.map(() => [] as ServerMessage[]);
        sockets.forEach((socket, index) =>
          socket.on('server-message', (message: ServerMessage) => seen[index]!.push(message)),
        );
        const request = {
          protocolVersion: 1,
          requestId: randomUUID(),
          intent: {
            type: 'rollback',
            target: { expected: history.view.head, beforeActionVersion: 1 },
            knowledgeWarningAcknowledged: true,
          },
        };
        const first = accepted(await message(sockets[0]!, request), 'control');
        await until(async () =>
          seen.every((messages) => messages.some((message) => message.type === 'rollback-notice')),
        );
        for (const messages of seen) {
          const notice = messages.find((message) => message.type === 'rollback-notice');
          if (notice?.type !== 'rollback-notice') assert.fail();
          assert.equal(notice.notice.actorId, context.members[0]!.seatId);
          assert.deepEqual(notice.notice.target, request.intent.target);
          assert.equal(notice.notice.head.version, 0);
          assert.equal(notice.notice.head.branch, 2);
          assert.equal(
            messages.some((message) => message.type === 'owner-history'),
            false,
          );
          for (const card of context.start.cardIds)
            assert.equal(JSON.stringify(notice).includes(card), false);
        }
        const retry = accepted(await message(sockets[0]!, request), 'control');
        assert.deepEqual(retry.result, { ...first.result, duplicate: true });
        const empty = await message(sockets[0]!, {
          protocolVersion: 1,
          requestId: randomUUID(),
          intent: { type: 'owner-history', gameId: context.start.gameId },
        });
        if (empty.type !== 'owner-history') assert.fail();
        assert.equal(empty.view.head.version, 0);
        assert.equal(empty.view.branches.length, 2);
        assert.equal(seen[0]!.filter((message) => message.type === 'rollback-notice').length, 1);
      },
    );

  await t.test(
    'closed chat/action scopes cannot be relabeled; claim receipts survive scope advance and durable recovery',
    async (t) => {
      const context = await fixture(t);
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      const lobbyId = context.members[0]!.lobbyId;
      for (const socket of sockets) await message(socket, resync(lobbyId));
      await ready(context);
      const read = async () => (await context.host.read(lobbyId))!.snapshot;
      const requestId = randomUUID();
      const intent = {
        type: 'submit-claim',
        accusedId: context.members[1]!.seatId,
        reason: 'Exact claim',
        evidence: { type: 'spoken', key: 'durable-episode' },
      };
      const first = accepted(await play(context, sockets[0]!, intent, requestId));
      await context.clock.advanceBy(10000);
      const state = (await read()).state!;
      if (state.phase.type !== 'between-rounds') assert.fail();
      const leader = context.members.findIndex(
        (member) => state.phase.type === 'between-rounds' && member.seatId === state.phase.leaderId,
      );
      accepted(
        await play(context, sockets[leader]!, {
          type: 'play-card',
          cardId: state.players[leader]!.hand[0]!,
        }),
      );
      const lobby = await PostgresLobby.open(pool, lobbyId);
      const chatId = id('message', randomUUID());
      await context.host.withCurrent(lobbyId, context.start.gameId, (runtime) =>
        lobby.postChat(
          {
            id: chatId,
            authorSessionId: context.members[leader]!.sessionId,
            authorSeatId: context.members[leader]!.seatId,
            text: 'Round one evidence',
          },
          context.now(),
          runtime,
        ),
      );
      const round = (await read()).state!.phase;
      if (round.type !== 'round') assert.fail();
      const next = context.members.findIndex((member) => member.seatId === round.turnSeatId);
      const takeId = randomUUID();
      accepted(await play(context, sockets[next]!, { type: 'take-bottom' }, takeId));
      for (const [evidence, accusedId] of [
        [{ type: 'chat', messageId: chatId }, context.members[leader]!.seatId],
        [{ type: 'action', commandId: takeId }, context.members[next]!.seatId],
      ] as const) {
        const denied = await play(context, sockets[0]!, { ...intent, evidence, accusedId });
        if (denied.type !== 'command-ack' || denied.result.type !== 'rejected') assert.fail();
        assert.equal(denied.result.code, 'scope-closed');
      }
      assert.ok(await context.host.recover(lobbyId));
      await message(sockets[0]!, resync(lobbyId));
      const retry = accepted(await play(context, sockets[0]!, intent, requestId));
      assert.deepEqual(retry.result, { ...first.result, duplicate: true });
      for (const [socket, changed] of [
        [sockets[0]!, { ...intent, evidence: { type: 'spoken', key: 'changed' } }],
        [sockets[1]!, intent],
      ] as const) {
        const denied = await play(context, socket, changed, requestId);
        if (denied.type !== 'command-ack' || denied.result.type !== 'rejected') assert.fail();
        assert.equal(denied.result.code, 'command-id-reused');
      }
      assert.equal((await read()).state!.claims.length, 1);
    },
  );

  await t.test(
    'chat/action evidence binds immutable authors and inherited prefixes, never abandoned futures',
    async (t) => {
      const context = await fixture(t, 4);
      const sockets = await Promise.all(
        context.grants.map((_grant, index) => context.connect(index)),
      );
      const lobbyId = context.members[0]!.lobbyId;
      for (const socket of sockets) await message(socket, resync(lobbyId));
      const lobby = await PostgresLobby.open(pool, lobbyId);
      const chatId = id('message', randomUUID());
      await context.host.withCurrent(lobbyId, context.start.gameId, (runtime) =>
        lobby.postChat(
          {
            id: chatId,
            authorSessionId: context.members[2]!.sessionId,
            authorSeatId: context.members[2]!.seatId,
            text: 'Original evidence',
          },
          context.now(),
          runtime,
        ),
      );
      const drawId = randomUUID();
      accepted(await play(context, sockets[3]!, { type: 'draw-card' }, drawId));
      const futureId = id('message', randomUUID());
      await context.host.withCurrent(lobbyId, context.start.gameId, (runtime) =>
        lobby.postChat(
          {
            id: futureId,
            authorSessionId: context.members[2]!.sessionId,
            authorSeatId: context.members[2]!.seatId,
            text: 'Abandoned context',
          },
          context.now(),
          runtime,
        ),
      );
      const claim = (
        evidence: object,
        accusedId = context.members[2]!.seatId,
        branchId = context.start.branchId,
      ) =>
        play(context, sockets[0]!, {
          type: 'submit-claim',
          branchId,
          accusedId,
          reason: 'Evidence',
          evidence,
        });
      for (const evidence of [
        { type: 'chat', messageId: 'missing' },
        { type: 'action', commandId: context.start.id },
      ]) {
        const result = await claim(evidence);
        if (result.type !== 'command-ack' || result.result.type !== 'rejected') assert.fail();
        assert.equal(result.result.code, 'invalid-claim');
      }
      const mismatch = await claim({ type: 'action', commandId: drawId });
      if (mismatch.type !== 'command-ack' || mismatch.result.type !== 'rejected') assert.fail();
      assert.equal(mismatch.result.code, 'invalid-claim');
      accepted(await claim({ type: 'action', commandId: drawId }, context.members[3]!.seatId));
      await context.clock.advanceBy(10000);
      await context.host.withCurrent(lobbyId, context.start.gameId, (runtime) =>
        runtime.dispatch({
          type: 'rollback',
          id: id('command', randomUUID()),
          actorId: context.members[0]!.seatId,
          expected: runtime.read().head,
          beforeCommandId: id('command', drawId),
          knowledgeWarningAcknowledged: true,
        }),
      );
      const branchId = (await context.host.read(lobbyId))!.snapshot.head.branchId;
      for (const evidence of [
        { type: 'chat', messageId: futureId },
        { type: 'action', commandId: drawId },
      ]) {
        const denied = await claim(evidence, context.members[2]!.seatId, branchId);
        if (denied.type !== 'command-ack' || denied.result.type !== 'rejected') assert.fail();
        assert.equal(denied.result.code, 'invalid-claim');
      }
      accepted(
        await claim({ type: 'chat', messageId: chatId }, context.members[2]!.seatId, branchId),
      );
      const state = (await context.host.read(lobbyId))!.snapshot.state!;
      assert.equal(state.claims.length, 1);
      assert.equal(state.claims[0]!.claim.accusedId, context.members[2]!.seatId);
      assert.deepEqual(state.claims[0]!.claim.incident, { type: 'chat', messageId: chatId });
    },
  );

  for (const count of [2, 4, 8])
    await t.test(
      `${count} authenticated seats submit claims, vote and retry without a second episode`,
      async (t) => {
        const context = await fixture(t, count);
        const sockets = await Promise.all(
          context.grants.map((_grant, index) => context.connect(index)),
        );
        for (const socket of sockets) await message(socket, resync(context.members[0]!.lobbyId));
        const requestId = randomUUID();
        const intent = {
          type: 'submit-claim',
          accusedId: context.members[1]!.seatId,
          reason: 'Spoken episode',
          evidence: { type: 'spoken', key: 'episode' },
        };
        const first = accepted(await play(context, sockets[0]!, intent, requestId));
        const read = async () => (await context.host.read(context.members[0]!.lobbyId))!.snapshot;
        const procedure = (await read()).state!.procedure;
        if (procedure?.type !== 'claim-vote') assert.fail();
        assert.equal(procedure.claim.claimantId, context.members[0]!.seatId);
        assert.equal(procedure.claim.scope, 'dealing');
        for (const seatId of procedure.eligibleSeatIds) {
          const index = context.members.findIndex((member) => member.seatId === seatId);
          accepted(
            await play(context, sockets[index]!, {
              type: 'cast-vote',
              procedureId: procedure.timer.id,
              vote: 'abstain',
            }),
          );
        }
        assert.equal((await read()).state!.claims[0]!.resolution, 'tied');
        const retry = accepted(await play(context, sockets[0]!, intent, requestId));
        assert.equal(retry.result.duplicate, true);
        assert.deepEqual(retry.result.head, first.result.head);
        const handled = await play(context, sockets[0]!, intent);
        if (handled.type !== 'command-ack' || handled.result.type !== 'rejected') assert.fail();
        assert.equal(handled.result.code, 'incident-already-handled');
        assert.equal((await read()).state!.claims.length, 1);
      },
    );

  await t.test(
    'one committed job emits its exact adjacent action pairs before final state without refreshing idle credentials',
    async (t) => {
      const context = await fixture(t, 2, 60000);
      const socket = await context.connect();
      await message(socket, resync(context.members[0]!.lobbyId));
      await context.host.withCurrent(context.members[0]!.lobbyId, context.start.gameId, (runtime) =>
        runtime.dispatch({
          type: 'rollback',
          id: id('command', randomUUID()),
          actorId: context.members[0]!.seatId,
          expected: runtime.read().head,
          beforeCommandId: context.start.id,
          knowledgeWarningAcknowledged: true,
        }),
      );
      await until(async () => latestState.get(socket)?.view.state === null);
      const before = (await context.access.inspect(context.grants[0]!.token, context.now()))!
        .expiresAtMs;
      context.setNow(context.now() + 5000);
      const messages: ServerMessage[] = [];
      socket.on('server-message', (message: ServerMessage) => messages.push(message));
      await context.host.withCurrent(
        context.members[0]!.lobbyId,
        context.start.gameId,
        async (runtime) => {
          const result = await runtime.dispatch(
            {
              type: 'start-game',
              id: id('command', randomUUID()),
              gameId: context.start.gameId,
              ownerId: context.members[0]!.seatId,
              seatIds: context.members[0]!.seatIds,
              cardIds: Array.from({ length: 36 }, () => id('card', randomUUID())),
            },
            { branchId: runtime.read().head.branchId },
          );
          assert.equal(result.type, 'accepted');
        },
      );
      await until(async () =>
        messages.some((message) => message.type === 'state' && message.view.state !== null),
      );
      const stream = messages.filter(
        (message) => message.type === 'state' || message.type === 'action',
      );
      assert.deepEqual(
        stream.map((message) => message.type),
        ['action', 'action', 'state'],
      );
      assert.deepEqual(
        stream.map((message) => message.view.head.version),
        [1, 2, 2],
      );
      assert.equal(
        (await context.access.inspect(context.grants[0]!.token, context.now()))!.expiresAtMs,
        before,
      );
    },
  );

  await t.test(
    'a later same-branch claim hides a reveal in an older state waiting on delivery authorization',
    async (t) => {
      const context = await fixture(t, 2, 60000);
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      for (const socket of sockets) await message(socket, resync(context.members[0]!.lobbyId));
      for (let draw = 0; draw < 35; draw++)
        await context.host.withCurrent(
          context.members[0]!.lobbyId,
          context.start.gameId,
          async (runtime) => {
            const phase = runtime.read().state!.phase;
            if (phase.type !== 'dealing') assert.fail();
            await runtime.dispatch({
              type: 'draw-card',
              id: id('command', randomUUID()),
              actorId: phase.nextSeatId,
            });
          },
        );
      const head = (await context.host.read(context.members[0]!.lobbyId))!.snapshot.head;
      await until(
        async () => (latestState.get(sockets[0]!)?.view.head.version ?? -1) >= head.version,
      );
      const received: ServerMessage[] = [];
      sockets[0]!.on('server-message', (message: ServerMessage) => received.push(message));
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const query = pool.query;
      let delayed = false;
      const mock = t.mock.method(pool, 'query', async function (this: Pool, ...args: unknown[]) {
        if (
          !delayed &&
          typeof args[0] === 'string' &&
          args[0].includes('SELECT s.session_id,m.seat_id') &&
          Array.isArray(args[1]) &&
          args[1][0] === guestTokenHash(context.grants[0]!.token)
        ) {
          delayed = true;
          entered();
          await gate;
        }
        return Reflect.apply(query, this, args);
      });
      try {
        await context.host.withCurrent(
          context.members[0]!.lobbyId,
          context.start.gameId,
          async (runtime) => {
            const phase = runtime.read().state!.phase;
            if (phase.type !== 'dealing') assert.fail();
            await runtime.dispatch({
              type: 'draw-card',
              id: id('command', randomUUID()),
              actorId: phase.nextSeatId,
            });
          },
        );
        await waiting;
        await context.host.withCurrent(
          context.members[0]!.lobbyId,
          context.start.gameId,
          async (runtime) => {
            const result = await runtime.dispatch({
              type: 'submit-claim',
              id: id('command', randomUUID()),
              actorId: context.members[0]!.seatId,
              accusedId: context.members[1]!.seatId,
              reason: 'Trusted reveal pause fixture',
              incident: { type: 'spoken', key: 'pause-reveal' },
              scope: 'dealing',
              scopeNumber: 0,
            });
            assert.equal(result.type, 'accepted');
          },
        );
      } finally {
        release();
      }
      await until(async () => latestState.get(sockets[0]!)?.view.procedure?.type === 'claim-vote');
      mock.mock.restore();
      const states = received.filter((message) => message.type === 'state');
      assert.ok(states.length >= 2);
      assert.ok(states.every((message) => message.view.transient.reveal === null));
    },
  );

  await t.test(
    'fresh peeks and completed transfers remain seat-private; resync and writer recovery do not replay them',
    async (t) => {
      const context = await fixture(t, 4);
      const sockets = await Promise.all(
        context.grants.map((_grant, index) => context.connect(index)),
      );
      for (const socket of sockets) await message(socket, resync(context.members[0]!.lobbyId));
      await ready(context);
      const received = sockets.map(() => [] as ServerMessage[]);
      sockets.forEach((socket, index) =>
        socket.on('server-message', (value: ServerMessage) => received[index]!.push(value)),
      );
      const state = (await context.host.read(context.members[0]!.lobbyId))!.snapshot.state!;
      const peekId = randomUUID();
      accepted(
        await play(
          context,
          sockets[0]!,
          { type: 'open-stump', cardId: state.players[0]!.stumps[0]! },
          peekId,
        ),
        'violation',
      );
      await until(async () =>
        received.every((messages) =>
          messages.some(
            (message) => message.type === 'action' && message.view.commandId === peekId,
          ),
        ),
      );
      for (const [index, messages] of received.entries()) {
        const action = messages.find(
          (message) => message.type === 'action' && message.view.commandId === peekId,
        )!;
        if (action.type !== 'action') assert.fail();
        assert.equal(
          action.view.observations.filter((observation) => observation.type === 'stump-peeked')
            .length,
          index === 0 ? 1 : 0,
        );
      }
      const penalty = (await context.host.read(context.members[0]!.lobbyId))!.snapshot.state!
        .procedure;
      if (penalty?.type !== 'penalty') assert.fail();
      const selected = state.players[1]!.hand[0]!;
      for (const seat of penalty.eligibleSeatIds) {
        const index = context.members.findIndex((member) => member.seatId === seat);
        accepted(
          await play(context, sockets[index]!, {
            type: 'penalty-response',
            procedureId: penalty.timer.id,
            cardId: index === 1 ? selected : null,
          }),
        );
      }
      await until(async () =>
        received.every((messages) =>
          messages.some((message) => message.type === 'state' && message.view.procedure === null),
        ),
      );
      for (const [index, messages] of received.entries()) {
        const transfers = messages.flatMap((message) =>
          message.type === 'action'
            ? message.view.observations.filter(
                (observation) => observation.type === 'penalty-transfer',
              )
            : [],
        );
        assert.equal(transfers.length, index <= 1 ? 1 : 0);
      }
      accepted(
        await play(
          context,
          sockets[0]!,
          { type: 'open-stump', cardId: state.players[0]!.stumps[0]! },
          peekId,
        ),
        'violation',
      );
      await message(sockets[0]!, resync(context.members[0]!.lobbyId));
      const oldEpoch = latestEpoch.get(sockets[0]!);
      const count = received[0]!.filter((message) => message.type === 'action').length;
      await context.host.recover(context.members[0]!.lobbyId);
      await until(async () => latestEpoch.get(sockets[0]!) !== oldEpoch);
      assert.equal(received[0]!.filter((message) => message.type === 'action').length, count);
      assert.equal(
        received[0]!.filter(
          (message) => message.type === 'action' && message.view.commandId === peekId,
        ).length,
        1,
      );
    },
  );

  await t.test(
    'rollback and explicit resync invalidate private observations still awaiting delivery authorization',
    async (t) => {
      const context = await fixture(t, 2, 60000);
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      for (const socket of sockets) await message(socket, resync(context.members[0]!.lobbyId));
      await ready(context);
      const received: ServerMessage[] = [];
      sockets[0]!.on('server-message', (message: ServerMessage) => received.push(message));
      let branchId = context.start.branchId;
      for (const mode of ['rollback', 'resync'] as const) {
        const query = pool.query;
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const waiting = new Promise<void>((resolve) => {
          entered = resolve;
        });
        let delayed = false;
        const mock = t.mock.method(pool, 'query', async function (this: Pool, ...args: unknown[]) {
          if (
            !delayed &&
            typeof args[0] === 'string' &&
            args[0].includes('SELECT s.session_id,m.seat_id') &&
            Array.isArray(args[1]) &&
            args[1][0] === guestTokenHash(context.grants[0]!.token)
          ) {
            delayed = true;
            entered();
            await gate;
          }
          return Reflect.apply(query, this, args);
        });
        const state = (await context.host.read(context.members[0]!.lobbyId))!.snapshot.state!;
        const peekId = randomUUID();
        sockets[0]!.emit('client-message', {
          protocolVersion: 1,
          requestId: peekId,
          intent: {
            type: 'open-stump',
            gameId: context.start.gameId,
            branchId,
            cardId: state.players[0]!.stumps[0]!,
          },
        });
        await waiting;
        let baseline: Promise<ServerMessage> | null = null;
        try {
          if (mode === 'rollback') {
            await context.host.withCurrent(
              context.members[0]!.lobbyId,
              context.start.gameId,
              (runtime) =>
                runtime.dispatch({
                  type: 'rollback',
                  id: id('command', randomUUID()),
                  actorId: context.members[0]!.seatId,
                  expected: runtime.read().head,
                  beforeCommandId: id('command', peekId),
                  knowledgeWarningAcknowledged: true,
                }),
            );
            branchId = (await context.host.read(context.members[0]!.lobbyId))!.snapshot.head
              .branchId;
          } else {
            context.setNow(context.now() + 1001);
            const at = context.now();
            baseline = message(sockets[0]!, resync(context.members[0]!.lobbyId));
            await until(
              async () =>
                (await context.access.inspect(context.grants[0]!.token, context.now()))!
                  .expiresAtMs >=
                at + GUEST_TTL_MS,
            );
          }
        } finally {
          release();
        }
        if (baseline) await baseline;
        await until(async () => latestState.get(sockets[0]!)?.view.head.branchId === branchId);
        mock.mock.restore();
        assert.equal(
          received.some(
            (message) => message.type === 'action' && message.view.commandId === peekId,
          ),
          false,
        );
      }
    },
  );

  await t.test(
    'a non-acknowledging recipient is disconnected without blocking another socket or game deadlines',
    async (t) => {
      const context = await fixture(t, 2, 60000, { ackTimeoutMs: 1000 });
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      for (const socket of sockets) await message(socket, resync(context.members[0]!.lobbyId));
      receiptEnabled.set(sockets[1]!, false);
      const ended = once(sockets[1]!, 'disconnect');
      accepted(await play(context, sockets[0]!, { type: 'draw-card' }), 'violation');
      await context.host.withCurrent(
        context.members[0]!.lobbyId,
        context.start.gameId,
        async (runtime) => {
          await runtime.dispatch({
            type: 'submit-claim',
            id: id('command', randomUUID()),
            actorId: context.members[0]!.seatId,
            accusedId: context.members[1]!.seatId,
            reason: 'Timer fixture',
            incident: { type: 'spoken', key: 'timer-fixture' },
            scope: 'dealing',
            scopeNumber: 0,
          });
          await context.clock.advanceBy(10000);
          assert.equal(runtime.read().state!.claims[0]!.resolution, 'tied');
        },
      );
      await ended;
      assert.equal(sockets[0]!.connected, true);
      const returned = await context.connect(1);
      const baseline = await message(returned, resync(context.members[0]!.lobbyId));
      if (baseline.type !== 'state') assert.fail();
      assert.equal(baseline.delivery.sequence, 1);
    },
  );

  await t.test(
    'forged transport receipts disconnect only their sender and never credit additional buffered frames',
    async (t) => {
      const context = await fixture(t);
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      for (const socket of sockets) await message(socket, resync(context.members[0]!.lobbyId));
      receiptEnabled.set(sockets[1]!, false);
      sockets[1]!.on(
        'server-message',
        (_message: ServerMessage, _receipt: string, ack: (value: string) => void) =>
          ack('guessed-receipt'),
      );
      const ended = once(sockets[1]!, 'disconnect');
      accepted(await play(context, sockets[0]!, { type: 'draw-card' }), 'violation');
      await ended;
      assert.equal(sockets[0]!.connected, true);
      assert.equal(
        (await context.host.read(context.members[0]!.lobbyId))!.snapshot.state!.deck.length,
        36,
      );
    },
  );

  await t.test(
    'bounded private capture overflow drops one slow reader without blocking a fast reader',
    async (t) => {
      const context = await fixture(t, 2, 60000, { jobs: 2 });
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      for (const socket of sockets) await message(socket, resync(context.members[0]!.lobbyId));
      const query = pool.query;
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let delayed = false;
      const mock = t.mock.method(pool, 'query', async function (this: Pool, ...args: unknown[]) {
        if (
          !delayed &&
          typeof args[0] === 'string' &&
          args[0].includes('SELECT s.session_id,m.seat_id') &&
          Array.isArray(args[1]) &&
          args[1][0] === guestTokenHash(context.grants[1]!.token)
        ) {
          delayed = true;
          entered();
          await gate;
        }
        return Reflect.apply(query, this, args);
      });
      const ended = once(sockets[1]!, 'disconnect');
      try {
        for (let count = 0; count < 3; count++) {
          accepted(await play(context, sockets[0]!, { type: 'draw-card' }), 'violation');
          if (count === 0) await waiting;
          const head = (await context.host.read(context.members[0]!.lobbyId))!.snapshot.head;
          await until(
            async () => (latestState.get(sockets[0]!)?.view.head.version ?? -1) >= head.version,
          );
        }
        await ended;
        assert.equal(sockets[0]!.connected, true);
      } finally {
        release();
        mock.mock.restore();
      }
    },
  );

  for (const count of [2, 4, 8])
    await t.test(
      `${count} sockets receive ordered private committed actions followed by state, without retry replay`,
      async (t) => {
        const context = await fixture(t, count);
        const sockets = await Promise.all(
          context.grants.map((_grant, index) => context.connect(index)),
        );
        for (const socket of sockets) await message(socket, resync(context.members[0]!.lobbyId));
        // Closed-stump draws never disclose a face, even to their owner. Move
        // through both stump passes before testing a seat-private hand draw.
        for (let draw = 0; draw < count * 2; draw++) {
          const state = (await context.host.read(context.members[0]!.lobbyId))!.snapshot.state!;
          if (state.phase.type !== 'dealing') assert.fail();
          const actor = context.members.findIndex(
            (member) => state.phase.type === 'dealing' && member.seatId === state.phase.nextSeatId,
          );
          accepted(await play(context, sockets[actor]!, { type: 'draw-card' }));
        }
        for (const socket of sockets) await message(socket, resync(context.members[0]!.lobbyId));
        const seen = sockets.map(() => [] as ServerMessage[]);
        sockets.forEach((socket, index) =>
          socket.on('server-message', (value: ServerMessage) => seen[index]!.push(value)),
        );
        const snapshot = (await context.host.read(context.members[0]!.lobbyId))!.snapshot;
        if (snapshot.state!.phase.type !== 'dealing') assert.fail();
        const actor = context.members.findIndex(
          (seat) =>
            snapshot.state!.phase.type === 'dealing' &&
            seat.seatId === snapshot.state!.phase.nextSeatId,
        );
        const requestId = randomUUID();
        accepted(await play(context, sockets[actor]!, { type: 'draw-card' }, requestId));
        await until(async () =>
          seen.every((messages) => messages.some((value) => value.type === 'action')),
        );
        await until(async () =>
          seen.every((messages) => messages.some((value) => value.type === 'state')),
        );
        for (const [index, messages] of seen.entries()) {
          const stream = messages.filter(
            (value) => value.type === 'action' || value.type === 'state',
          );
          assert.deepEqual(
            stream.map((value) => value.type),
            ['action', 'state'],
          );
          const action = stream[0]!;
          if (action.type !== 'action') assert.fail();
          assert.equal(action.view.commandId, requestId);
          const draw = action.view.observations.find(
            (observation) => observation.type === 'card-drawn',
          );
          if (draw?.type !== 'card-drawn') assert.fail();
          assert.equal(draw.card !== null, index === actor);
          assert.equal(stream[0]!.delivery.sequence + 1, stream[1]!.delivery.sequence);
        }
        accepted(await play(context, sockets[actor]!, { type: 'draw-card' }, requestId));
        const baseline = await message(sockets[actor]!, resync(context.members[0]!.lobbyId));
        assert.equal(baseline.type, 'state');
        assert.equal(seen[actor]!.filter((value) => value.type === 'action').length, 1);
      },
    );

  for (const count of [2, 4, 8])
    await t.test(
      `${count} seats drive drawing, penalties, rounds and punishable stump attempts through authenticated commands`,
      async (t) => {
        const context = await fixture(t, count);
        const sockets = await Promise.all(
          context.grants.map((_grant, index) => context.connect(index)),
        );
        for (const socket of sockets) await message(socket, resync(context.members[0]!.lobbyId));
        const read = async () => (await context.host.read(context.members[0]!.lobbyId))!.snapshot;
        const initial = await read();
        if (initial.state!.phase.type !== 'dealing') assert.fail();
        const wrong = context.members.findIndex(
          (member) =>
            initial.state!.phase.type === 'dealing' &&
            member.seatId !== initial.state!.phase.nextSeatId,
        );
        accepted(await play(context, sockets[wrong]!, { type: 'draw-card' }), 'violation');
        assert.equal((await read()).state!.deck.length, 36);
        for (let index = 0; index < 36; index++) {
          const state = (await read()).state!;
          if (state.phase.type !== 'dealing') assert.fail();
          const actor = context.members.findIndex(
            (member) => state.phase.type === 'dealing' && member.seatId === state.phase.nextSeatId,
          );
          accepted(await play(context, sockets[actor]!, { type: 'draw-card' }));
        }
        await context.clock.advanceBy(10000);
        const penalty = (await read()).state!.procedure;
        if (penalty?.type !== 'penalty') assert.fail();
        const donor = context.members.findIndex(
          (member) => member.seatId === penalty.eligibleSeatIds[0],
        );
        const stale = await play(context, sockets[donor]!, {
          type: 'penalty-response',
          procedureId: 'obsolete-procedure',
          cardId: null,
        });
        if (stale.type !== 'command-ack' || stale.result.type !== 'rejected') assert.fail();
        assert.equal(stale.result.code, 'stale-timer');
        for (const seatId of penalty.eligibleSeatIds) {
          const socket = sockets[context.members.findIndex((member) => member.seatId === seatId)]!;
          accepted(
            await play(context, socket, {
              type: 'penalty-response',
              procedureId: penalty.timer.id,
              cardId: null,
            }),
          );
        }
        const ready = (await read()).state!;
        if (ready.phase.type !== 'between-rounds') assert.fail();
        const leader = context.members.findIndex(
          (member) =>
            ready.phase.type === 'between-rounds' && member.seatId === ready.phase.leaderId,
        );
        accepted(
          await play(context, sockets[leader]!, {
            type: 'play-card',
            cardId: ready.players[leader]!.hand[0]!,
          }),
        );
        const round = (await read()).state!.phase;
        if (round.type !== 'round') assert.fail();
        const next = context.members.findIndex((member) => member.seatId === round.turnSeatId);
        accepted(await play(context, sockets[next]!, { type: 'take-bottom' }));
        assert.equal((await read()).state!.table.length, 0);
        const stump = (await read()).state!.players[0]!.stumps[0]!;
        const peek = accepted(
          await play(context, sockets[0]!, { type: 'open-stump', cardId: stump }),
          'violation',
        );
        assert.equal(
          JSON.stringify(peek).includes(stump),
          false,
          'acks must not become private observation payloads',
        );
        assert.equal(
          (await read()).state!.peekedStumps.some((item) => item.cardId === stump),
          true,
        );
      },
    );

  await t.test(
    'unattached, malformed identity-spoofing and wrong-game commands cannot become penalties or disclose heads',
    async (t) => {
      const context = await fixture(t);
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      const before = (await context.host.read(context.members[0]!.lobbyId))!.snapshot.head;
      assert.deepEqual(await play(context, sockets[0]!, { type: 'draw-card' }), {
        protocolVersion: 1,
        type: 'error',
        code: 'unauthorized',
      });
      for (const socket of sockets) await message(socket, resync(context.members[0]!.lobbyId));
      const attached = (await context.host.read(context.members[0]!.lobbyId))!.snapshot.head;
      for (const forged of [
        { actorId: context.members[1]!.seatId },
        { ownerId: context.members[0]!.seatId },
        { controller: 'bot' },
      ])
        assert.deepEqual(await play(context, sockets[0]!, { type: 'draw-card', ...forged }), {
          protocolVersion: 1,
          type: 'error',
          code: 'invalid-message',
        });
      assert.deepEqual(
        await play(context, sockets[0]!, { type: 'draw-card', gameId: 'another-game' }),
        { protocolVersion: 1, type: 'error', code: 'wrong-game' },
      );
      assert.equal(attached.gameId, before.gameId);
      assert.deepEqual(
        (await context.host.read(context.members[0]!.lobbyId))!.snapshot.head,
        attached,
      );
      assert.equal(
        (await context.host.read(context.members[0]!.lobbyId))!.snapshot.state!.pendingPenalties
          .length,
        0,
      );
    },
  );

  await t.test(
    'duplicate deliveries across tabs execute once; collisions, abandoned branches and stale routes never replay an action',
    async (t) => {
      const context = await fixture(t);
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      for (const socket of sockets) await message(socket, resync(context.members[0]!.lobbyId));
      const initial = (await context.host.read(context.members[0]!.lobbyId))!.snapshot;
      if (initial.state!.phase.type !== 'dealing') assert.fail();
      const actor = context.members.findIndex(
        (member) =>
          initial.state!.phase.type === 'dealing' &&
          member.seatId === initial.state!.phase.nextSeatId,
      );
      const other = 1 - actor;
      const extra = await context.connect(actor);
      await message(extra, resync(context.members[0]!.lobbyId));
      const requestId = 'q'.repeat(128);
      const replies = await Promise.all([
        play(context, sockets[actor]!, { type: 'draw-card' }, requestId),
        play(context, extra, { type: 'draw-card' }, requestId),
      ]);
      const first = accepted(replies[0]!);
      const second = accepted(replies[1]!);
      assert.deepEqual([first.result.duplicate, second.result.duplicate].sort(), [false, true]);
      assert.deepEqual(first.result.head, second.result.head);
      assert.equal(
        (await context.host.read(context.members[0]!.lobbyId))!.snapshot.state!.deck.length,
        35,
      );
      for (const [socket, type] of [
        [sockets[other]!, 'draw-card'],
        [sockets[actor]!, 'take-bottom'],
      ] as const) {
        const collision = await play(context, socket, { type }, requestId);
        if (collision.type !== 'command-ack' || collision.result.type !== 'rejected') assert.fail();
        assert.equal(collision.result.code, 'command-id-reused');
      }
      await context.host.recover(context.members[0]!.lobbyId);
      const duplicate = accepted(await play(context, extra, { type: 'draw-card' }, requestId));
      assert.equal(duplicate.result.duplicate, true);
      assert.deepEqual(
        duplicate.result.head,
        first.result.head,
        'a duplicate ack retains its historical head, not a state-update cursor',
      );
      await context.host.withCurrent(context.members[0]!.lobbyId, context.start.gameId, (runtime) =>
        runtime.dispatch({
          type: 'rollback',
          id: id('command', randomUUID()),
          actorId: context.members[0]!.seatId,
          expected: runtime.read().head,
          beforeCommandId: id('command', requestId),
          knowledgeWarningAcknowledged: true,
        }),
      );
      const fork = (await context.host.read(context.members[0]!.lobbyId))!.snapshot.head;
      for (const branchId of [context.start.branchId, fork.branchId]) {
        const stale = await play(context, extra, { type: 'draw-card', branchId }, requestId);
        if (stale.type !== 'command-ack' || stale.result.type !== 'rejected') assert.fail();
        assert.equal(stale.result.code, 'wrong-branch');
      }
      assert.equal(
        (await context.host.read(context.members[0]!.lobbyId))!.snapshot.state!.deck.length,
        36,
      );
      accepted(await play(context, extra, { type: 'draw-card', branchId: fork.branchId }));
    },
  );

  for (const kind of [
    'draw',
    'claim',
    'rollback',
    'history',
    'history-page',
    'post-chat',
    'chat-history',
  ] as const)
    for (const mode of ['disconnect', 'revoke', 'expire'] as const)
      await t.test(
        `${mode} while a ${kind} command waits in the runtime queue cannot execute through retained seat presence`,
        async (t) => {
          const context = await fixture(t, 2, 60000);
          const sockets = await Promise.all([context.connect(), context.connect(1)]);
          for (const socket of sockets) await message(socket, resync(context.members[0]!.lobbyId));
          const initial = (await context.host.read(context.members[0]!.lobbyId))!.snapshot;
          if (initial.state!.phase.type !== 'dealing') assert.fail();
          const actor =
            kind === 'rollback' || kind === 'history' || kind === 'history-page'
              ? 0
              : context.members.findIndex(
                  (member) =>
                    initial.state!.phase.type === 'dealing' &&
                    member.seatId === initial.state!.phase.nextSeatId,
                );
          const keeper = await context.connect(actor);
          await message(keeper, resync(context.members[0]!.lobbyId));
          let release!: () => void;
          let entered!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const waiting = new Promise<void>((resolve) => {
            entered = resolve;
          });
          let blocked!: Promise<void>;
          if (kind === 'chat-history') {
            blocked = context.host.withCurrent(
              context.members[0]!.lobbyId,
              context.start.gameId,
              async () => {
                entered();
                await gate;
              },
            );
            await waiting;
          } else
            await context.host.withCurrent(
              context.members[0]!.lobbyId,
              context.start.gameId,
              async (runtime) => {
                blocked = runtime.observe(async () => {
                  entered();
                  await gate;
                });
                await waiting;
              },
            );
          const requestId = randomUUID();
          const received: ServerMessage[] = [];
          sockets[actor]!.on('server-message', (value: ServerMessage) => received.push(value));
          context.setNow(context.now() + 1001);
          const sentAt = context.now();
          sockets[actor]!.emit('client-message', {
            protocolVersion: 1,
            requestId,
            intent:
              kind === 'post-chat'
                ? {
                    type: 'post-chat',
                    lobbyId: context.members[0]!.lobbyId,
                    messageId: requestId,
                    text: 'Queued post',
                  }
                : kind === 'chat-history'
                  ? {
                      type: 'chat-history',
                      lobbyId: context.members[0]!.lobbyId,
                      afterSequence: '0',
                      limit: 100,
                    }
                  : kind === 'rollback'
                    ? {
                        type: 'rollback',
                        target: {
                          expected: {
                            gameId: context.start.gameId,
                            branch: 1,
                            version: initial.head.version,
                          },
                          beforeActionVersion: 1,
                        },
                        knowledgeWarningAcknowledged: true,
                      }
                    : kind === 'history-page'
                      ? {
                          type: 'owner-history-page',
                          gameId: context.start.gameId,
                          cursor: null,
                          limit: 1,
                        }
                      : kind === 'history'
                        ? { type: 'owner-history', gameId: context.start.gameId }
                        : {
                            ...(kind === 'draw'
                              ? { type: 'draw-card' }
                              : {
                                  type: 'submit-claim',
                                  accusedId: context.members[(actor + 1) % 2]!.seatId,
                                  reason: 'Queued claim',
                                  evidence: { type: 'spoken', key: 'queued' },
                                }),
                            gameId: context.start.gameId,
                            branchId: context.start.branchId,
                          },
          });
          await until(
            async () =>
              (await context.access.inspect(context.grants[actor]!.token, context.now()))!
                .expiresAtMs >=
              sentAt + GUEST_TTL_MS,
          );
          let revoking: ReturnType<typeof http> | null = null;
          if (mode === 'revoke') {
            const closed = once(sockets[actor]!, 'disconnect');
            revoking = http(
              context.base,
              '/api/guest/session',
              'DELETE',
              `${GUEST_COOKIE_NAME}=${context.grants[actor]!.token}`,
            );
            await closed;
          } else if (mode === 'expire') {
            context.setNow(
              (await context.access.inspect(context.grants[actor]!.token, context.now()))!
                .expiresAtMs,
            );
            await context.transport.checkCredentials();
          } else {
            sockets[actor]!.disconnect();
            await http(
              context.base,
              '/api/guest/session/refresh',
              'POST',
              `${GUEST_COOKIE_NAME}=${context.grants[actor]!.token}`,
            );
          }
          release();
          await blocked;
          if (revoking) assert.equal((await revoking).status, 204);
          await context.host.withCurrent(
            context.members[0]!.lobbyId,
            context.start.gameId,
            async (runtime) => {
              const checkpoint = await runtime.checkpoint();
              assert.equal(
                checkpoint.receipts.some((receipt) => receipt.command.id === requestId),
                false,
              );
              assert.equal(runtime.read().state!.deck.length, 36);
              assert.equal(runtime.read().state!.claims.length, 0);
            },
          );
          assert.equal(
            received.some(
              (reply) =>
                reply.type === 'command-ack' ||
                reply.type === 'owner-history' ||
                reply.type === 'owner-history-page' ||
                reply.type === 'chat-page',
            ),
            false,
          );
          if (mode === 'disconnect' && (kind === 'draw' || kind === 'claim'))
            accepted(await play(context, keeper, { type: 'draw-card' }));
        },
      );

  for (const controller of ['absent-human', 'bot'] as const)
    await t.test(
      `${controller} cannot bypass current authorization through a cached accepted receipt`,
      async (t) => {
        const context = await fixture(t);
        const sockets = await Promise.all([context.connect(), context.connect(1)]);
        for (const socket of sockets) await message(socket, resync(context.members[0]!.lobbyId));
        const state = (await context.host.read(context.members[0]!.lobbyId))!.snapshot.state!;
        if (state.phase.type !== 'dealing') assert.fail();
        const actor = context.members.findIndex(
          (member) => state.phase.type === 'dealing' && member.seatId === state.phase.nextSeatId,
        );
        const other = 1 - actor;
        const requestId = randomUUID();
        const first = accepted(
          await play(context, sockets[actor]!, { type: 'draw-card' }, requestId),
        );
        await context.host.withCurrent(
          context.members[0]!.lobbyId,
          context.start.gameId,
          async (runtime) => {
            await runtime.dispatch({
              type: 'disconnect',
              id: id('command', randomUUID()),
              seatId: context.members[actor]!.seatId,
            });
            if (controller === 'bot') {
              await context.clock.advanceBy(30001);
              await runtime.dispatch({
                type: 'propose-bot',
                id: id('command', randomUUID()),
                actorId: context.members[other]!.seatId,
                seatId: context.members[actor]!.seatId,
              });
              await runtime.dispatch({
                type: 'replacement-vote',
                id: id('command', randomUUID()),
                actorId: context.members[other]!.seatId,
                procedureId: runtime.read().replacementVote!.timer.id,
                vote: 'yes',
              });
            }
          },
        );
        assert.deepEqual(await play(context, sockets[actor]!, { type: 'draw-card' }, requestId), {
          protocolVersion: 1,
          type: 'error',
          code: 'unauthorized',
        });
        const returned = await context.connect(actor);
        await message(returned, resync(context.members[0]!.lobbyId));
        const retry = accepted(await play(context, returned, { type: 'draw-card' }, requestId));
        assert.equal(retry.result.duplicate, true);
        assert.deepEqual(retry.result.head, first.result.head);
        assert.equal(
          (await context.host.read(context.members[0]!.lobbyId))!.snapshot.state!.deck.length,
          35,
        );
      },
    );

  await t.test(
    'admission-time SQL failure is unavailable, not unauthorized, and leaves the runtime usable without a receipt',
    async (t) => {
      const context = await fixture(t, 2, 60000);
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      for (const socket of sockets) await message(socket, resync(context.members[0]!.lobbyId));
      const before = (await context.host.read(context.members[0]!.lobbyId))!;
      if (before.snapshot.state!.phase.type !== 'dealing') assert.fail();
      const actor = context.members.findIndex(
        (member) =>
          before.snapshot.state!.phase.type === 'dealing' &&
          member.seatId === before.snapshot.state!.phase.nextSeatId,
      );
      const hash = guestTokenHash(context.grants[actor]!.token);
      const query = pool.query;
      let injected = false;
      const mock = t.mock.method(pool, 'query', function (this: Pool, ...args: unknown[]) {
        // Failure only at the non-refreshing SELECT boundary, not membership's
        // separate transaction or dispatch persistence. No application mock.
        if (
          !injected &&
          typeof args[0] === 'string' &&
          args[0].includes('SELECT session_id,expires_at_ms::text') &&
          Array.isArray(args[1]) &&
          args[1][0] === hash
        ) {
          injected = true;
          throw new Error('PRIVATE admission database diagnostic');
        }
        return Reflect.apply(query, this, args);
      });
      const requestId = randomUUID();
      const reply = await play(context, sockets[actor]!, { type: 'draw-card' }, requestId);
      mock.mock.restore();
      assert.equal(injected, true);
      assert.deepEqual(reply, { protocolVersion: 1, type: 'error', code: 'unavailable' });
      const after = (await context.host.read(context.members[0]!.lobbyId))!;
      assert.equal(
        after.epoch,
        before.epoch,
        'authentication failure must not fault/replace the runtime',
      );
      assert.equal(after.snapshot.state!.deck.length, 36);
      const stored = await PostgresSession.load(pool, context.start.gameId);
      assert.equal(
        stored!.checkpoint.receipts.some((receipt) => receipt.command.id === requestId),
        false,
      );
      const returned = await context.connect(actor);
      await message(returned, resync(context.members[0]!.lobbyId));
      assert.equal(
        accepted(await play(context, returned, { type: 'draw-card' }, requestId)).result.duplicate,
        false,
      );
    },
  );

  await t.test(
    'failed durable gameplay sends no accepted ack; recovery and original-ID retry discard the uncommitted draft',
    async (t) => {
      const context = await fixture(t);
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      for (const socket of sockets) await message(socket, resync(context.members[0]!.lobbyId));
      const state = (await context.host.read(context.members[0]!.lobbyId))!.snapshot.state!;
      if (state.phase.type !== 'dealing') assert.fail();
      const actor = context.members.findIndex(
        (member) => state.phase.type === 'dealing' && member.seatId === state.phase.nextSeatId,
      );
      const observations: ServerMessage[] = [];
      sockets[1 - actor]!.on('server-message', (reply: ServerMessage) => observations.push(reply));
      const failedWriter = (
        await pool.query<{ pid: number }>(
          'SELECT pid FROM pg_stat_activity WHERE application_name=$1',
          [`penky-game:${context.start.gameId}`],
        )
      ).rows[0]!.pid;
      const name = `gameplay_fail_${randomUUID().replaceAll('-', '')}`;
      // This database-only fault is scoped to a host-generated UUID game, never
      // user text or another concurrently executing integration suite's frames.
      await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.game_id = '${context.start.gameId}' THEN RAISE EXCEPTION 'PRIVATE injected gameplay failure'; END IF;
      RETURN NEW; END $$; CREATE TRIGGER ${name} BEFORE INSERT ON penky_game_frames FOR EACH ROW EXECUTE FUNCTION ${name}()`);
      const remove = async () => {
        await pool.query(
          `DROP TRIGGER IF EXISTS ${name} ON penky_game_frames; DROP FUNCTION IF EXISTS ${name}()`,
        );
      };
      t.after(remove);
      const requestId = randomUUID();
      assert.deepEqual(await play(context, sockets[actor]!, { type: 'draw-card' }, requestId), {
        protocolVersion: 1,
        type: 'error',
        code: 'unavailable',
      });
      await remove();
      const stored = await PostgresSession.load(pool, context.start.gameId);
      assert.equal(stored!.snapshot.state!.deck.length, 36);
      assert.equal(
        stored!.checkpoint.receipts.some((receipt) => receipt.command.id === requestId),
        false,
      );
      // Destroyed PostgreSQL backends may release advisory leases asynchronously.
      // Wait for this specific writer exit; never retry arbitrary host failures.
      await until(
        async () =>
          !(await pool.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [failedWriter]))
            .rowCount,
      );
      const returned = await context.connect(actor);
      await message(returned, resync(context.members[0]!.lobbyId));
      const retried = accepted(await play(context, returned, { type: 'draw-card' }, requestId));
      assert.equal(retried.result.duplicate, false);
      await until(async () =>
        observations.some((reply) => reply.type === 'action' && reply.view.commandId === requestId),
      );
      const count = observations.filter((reply) => reply.type === 'action').length;
      const baseline = await message(sockets[1 - actor]!, resync(context.members[0]!.lobbyId));
      assert.equal(baseline.type, 'state');
      assert.equal(
        observations.filter((reply) => reply.type === 'action').length,
        count,
        'resync adds no inherited action replay',
      );
    },
  );

  await t.test('externally submitted claims accept exact vote/withdrawal replies', async (t) => {
    const context = await fixture(t);
    const sockets = await Promise.all([context.connect(), context.connect(1)]);
    for (const socket of sockets) await message(socket, resync(context.members[0]!.lobbyId));
    accepted(
      await play(context, sockets[0]!, {
        type: 'submit-claim',
        accusedId: context.members[1]!.seatId,
        reason: 'External claim',
        evidence: { type: 'spoken', key: 'external-episode' },
      }),
    );
    const claim = (await context.host.read(context.members[0]!.lobbyId))!.snapshot.state!.claims[0]!
      .claim;
    accepted(await play(context, sockets[0]!, { type: 'request-withdrawal', claimId: claim.id }));
    const withdrawal = (await context.host.read(context.members[0]!.lobbyId))!.snapshot.state!
      .procedure;
    if (withdrawal?.type !== 'withdrawal') assert.fail();
    accepted(
      await play(context, sockets[1]!, {
        type: 'withdrawal-response',
        procedureId: withdrawal.timer.id,
        approve: false,
      }),
    );
    const vote = (await context.host.read(context.members[0]!.lobbyId))!.snapshot.state!.procedure;
    if (vote?.type !== 'claim-vote') assert.fail();
    const stale = await play(context, sockets[0]!, {
      type: 'cast-vote',
      procedureId: 'old-ballot',
      vote: 'yes',
    });
    if (stale.type !== 'command-ack' || stale.result.type !== 'rejected') assert.fail();
    assert.equal(stale.result.code, 'stale-timer');
    accepted(
      await play(context, sockets[0]!, {
        type: 'cast-vote',
        procedureId: vote.timer.id,
        vote: 'abstain',
      }),
    );
    assert.equal(
      (await context.host.read(context.members[0]!.lobbyId))!.snapshot.state!.claims[0]!.resolution,
      'tied',
    );
    assert.equal(
      (await context.host.read(context.members[0]!.lobbyId))!.snapshot.state!.claims.length,
      1,
    );
  });

  await t.test(
    'authenticated bot-replacement controls bind the proposer, preserve suspension and hand back on reconnect',
    async (t) => {
      const context = await fixture(t);
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      for (const socket of sockets) await message(socket, resync(context.members[0]!.lobbyId));
      sockets[1]!.disconnect();
      await until(
        async () =>
          !(await context.host.read(context.members[0]!.lobbyId))!.snapshot.connections[1]!
            .connected,
      );
      await context.clock.advanceBy(30001);
      accepted(
        await play(context, sockets[0]!, {
          type: 'propose-bot',
          absentSeatId: context.members[1]!.seatId,
        }),
        'control',
      );
      const proposed = (await context.host.read(context.members[0]!.lobbyId))!.snapshot;
      assert.equal(proposed.paused, true);
      accepted(
        await play(context, sockets[0]!, {
          type: 'replacement-vote',
          procedureId: proposed.replacementVote!.timer.id,
          vote: 'yes',
        }),
        'control',
      );
      assert.equal(
        (await context.host.read(context.members[0]!.lobbyId))!.snapshot.connections[1]!.controller,
        'bot',
      );
      const returned = await context.connect(1);
      await message(returned, resync(context.members[0]!.lobbyId));
      assert.equal(
        (await context.host.read(context.members[0]!.lobbyId))!.snapshot.connections[1]!.controller,
        'human',
      );
    },
  );

  await t.test(
    'an attached authenticated seat can draw and retry one committed command with a private-safe acknowledgment',
    async (t) => {
      const context = await fixture(t);
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      for (const socket of sockets) await message(socket, resync(context.members[0]!.lobbyId));
      const snapshot = (await context.host.read(context.members[0]!.lobbyId))!.snapshot;
      if (snapshot.state!.phase.type !== 'dealing') assert.fail();
      // The trusted fixture identifies the recipient; no transport turn hint is added.
      const index = context.members.findIndex(
        (member) =>
          snapshot.state!.phase.type === 'dealing' &&
          member.seatId === snapshot.state!.phase.nextSeatId,
      );
      const requestId = randomUUID();
      const request = {
        protocolVersion: 1,
        requestId,
        intent: {
          type: 'draw-card',
          gameId: context.start.gameId,
          branchId: context.start.branchId,
        },
      };
      const ack = await message(sockets[index]!, request);
      assert.equal(ack.type, 'command-ack');
      if (ack.type !== 'command-ack' || ack.result.type !== 'accepted') assert.fail();
      assert.deepEqual(ack, {
        protocolVersion: 1,
        type: 'command-ack',
        requestId,
        result: {
          type: 'accepted',
          outcome: 'played',
          duplicate: false,
          head: { ...snapshot.head, version: snapshot.head.version + 1 },
        },
      });
      const retry = await message(sockets[index]!, request);
      if (retry.type !== 'command-ack' || retry.result.type !== 'accepted') assert.fail();
      assert.equal(retry.result.duplicate, true);
      assert.equal(
        (await context.host.read(context.members[0]!.lobbyId))!.snapshot.state!.deck.length,
        35,
      );
    },
  );

  await t.test(
    'session issuance, refresh and revocation use TLS cookies only; origin and shape fail closed',
    async (t) => {
      const { base } = await fixture(t);
      const issued = await http(base, '/api/guest/session');
      assert.equal(issued.status, 204);
      assert.equal(issued.body, '');
      assert.match(issued.cookie!, /Secure; HttpOnly; SameSite=Lax/);
      const cookie = issued.cookie!.split(';')[0]!;
      const token = cookie.split('=')[1]!;
      const stored = await pool.query(
        'SELECT token_hash FROM penky_guest_sessions WHERE token_hash=$1',
        [guestTokenHash(token)],
      );
      assert.equal(stored.rowCount, 1);
      assert.equal(
        (await http(base, '/api/guest/session', 'POST', cookie)).status,
        409,
        'issuance must not silently replace an existing identity',
      );
      assert.equal(
        (await http(base, '/api/guest/session', 'POST', `${GUEST_COOKIE_NAME} = malformed`)).status,
        409,
        'malformed existing cookies must not silently replace identity either',
      );
      assert.equal((await http(base, '/api/guest/session/refresh', 'POST', cookie)).status, 204);
      for (const source of [null, 'null', 'http://localhost', 'https://evil.invalid'])
        assert.equal(
          (await http(base, '/api/guest/session', 'POST', undefined, source)).status,
          403,
        );
      assert.equal((await http(base, '/api/guest/session', 'GET')).status, 405);
      assert.equal(
        (await http(base, '/api/guest/session', 'POST', undefined, origin, '{"actorId":"forged"}'))
          .status,
        400,
      );
      const revoked = await http(base, '/api/guest/session', 'DELETE', cookie);
      assert.equal(revoked.status, 204);
      assert.match(revoked.cookie!, /Max-Age=0/);
      assert.equal((await http(base, '/api/guest/session/refresh', 'POST', cookie)).status, 401);
    },
  );

  await t.test(
    'handshakes reject bad origins, missing/forged credentials and identity auth substitutes',
    async (t) => {
      const context = await fixture(t);
      for (const polling of [false, true]) {
        for (const source of [null, 'null', 'http://localhost', 'https://evil.invalid']) {
          const socket = context.client(context.grants[0]!.token, { source, polling });
          assert.ok((await once(socket, 'connect_error'))[0]);
          socket.disconnect();
        }
      }
      for (const token of [
        null,
        context.members[0]!.sessionId,
        `${context.grants[0]!.token}; ${GUEST_COOKIE_NAME}=${context.grants[0]!.token}`,
        'x'.repeat(8200),
      ]) {
        const socket = context.client(token);
        assert.ok((await once(socket, 'connect_error'))[0]);
      }
      const socket = context.client(context.grants[0]!.token, {
        auth: { actorId: context.members[1]!.seatId },
      });
      assert.ok((await once(socket, 'connect_error'))[0]);
    },
  );

  for (const count of [2, 4, 8])
    await t.test(
      `${count} isolated seats resync only their own cards and aggregate duplicate connections`,
      async (t) => {
        const context = await fixture(t, count);
        const sockets = await Promise.all(
          context.grants.map((_grant, index) => context.connect(index)),
        );
        for (const socket of sockets)
          assert.equal((await message(socket, resync(context.members[0]!.lobbyId))).type, 'state');
        await context.host.withCurrent(
          context.members[0]!.lobbyId,
          context.start.gameId,
          async (runtime) => {
            for (let index = 0; index < 36; index++) {
              const phase = runtime.read().state!.phase;
              if (phase.type !== 'dealing') assert.fail();
              await runtime.dispatch({
                type: 'draw-card',
                id: id('command', randomUUID()),
                actorId: phase.nextSeatId,
              });
            }
            await runtime.dispatch({
              type: 'submit-claim',
              id: id('command', randomUUID()),
              actorId: context.members[0]!.seatId,
              accusedId: context.members[1]!.seatId,
              reason: 'Fixture pause hides reveal',
              incident: { type: 'spoken', key: 'fixture' },
              scope: 'dealing',
              scopeNumber: 0,
            });
          },
        );
        const authoritative = (await context.host.read(context.members[0]!.lobbyId))!.snapshot
          .state!;
        for (const [index, socket] of sockets.entries()) {
          const result = await message(socket, resync(context.members[0]!.lobbyId));
          assert.equal(result.type, 'state');
          if (result.type !== 'state') assert.fail();
          const view = result.view.state!;
          assert.equal(view.viewer.type, 'participant');
          assert.deepEqual(
            view.own!.hand.map((card) => card.id),
            authoritative.players[index]!.hand,
          );
          const serialized = JSON.stringify(result);
          for (const other of authoritative.players.filter(
            (_player, otherIndex) => otherIndex !== index,
          ))
            for (const card of [...other.hand, ...other.stumps])
              assert.equal(serialized.includes(card), false);
          for (const field of [
            'peekedStumps',
            'controlEvents',
            'receipts',
            'cards',
            'trump',
            'actions',
          ])
            assert.equal(Object.hasOwn(result.view, field), false);
        }
        const duplicate = await context.connect();
        await message(duplicate, resync(context.members[0]!.lobbyId));
        sockets[0]!.disconnect();
        await message(duplicate, resync(context.members[0]!.lobbyId));
        assert.equal(
          (await context.host.read(context.members[0]!.lobbyId))!.snapshot.paused,
          false,
        );
        duplicate.disconnect();
        await until(
          async () => (await context.host.read(context.members[0]!.lobbyId))!.snapshot.paused,
        );
      },
    );

  await t.test(
    'revocation disconnects all tabs, including a resync waiting for attachment',
    async (t) => {
      const context = await fixture(t);
      const first = await context.connect();
      const second = await context.connect();
      const otherSeat = await context.connect(1);
      await message(otherSeat, resync(context.members[0]!.lobbyId));
      await message(first, resync(context.members[0]!.lobbyId));
      const presence: boolean[] = [];
      await context.host.withCurrent(context.members[0]!.lobbyId, context.start.gameId, (runtime) =>
        runtime.subscribe((notice) => {
          const connected = notice.snapshot.connections.find(
            (seat) => seat.seatId === context.members[0]!.seatId,
          )!.connected;
          if (presence.at(-1) !== connected) presence.push(connected);
        }),
      );
      const attach = context.host.attach.bind(context.host);
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const mock = t.mock.method(
        context.host,
        'attach',
        async (...args: Parameters<typeof context.host.attach>) => {
          entered();
          await gate;
          return attach(...args);
        },
      );
      const received: unknown[] = [];
      second.on('server-message', (value: unknown) => received.push(value));
      second.emit('client-message', resync(context.members[0]!.lobbyId));
      await waiting;
      const disconnected = once(first, 'disconnect');
      const revoke = http(
        context.base,
        '/api/guest/session',
        'DELETE',
        `${GUEST_COOKIE_NAME}=${context.grants[0]!.token}`,
      );
      await disconnected;
      release();
      assert.equal((await revoke).status, 204);
      mock.mock.restore();
      await until(
        async () =>
          !(await context.host.read(context.members[0]!.lobbyId))!.snapshot.connections.find(
            (seat) => seat.seatId === context.members[0]!.seatId,
          )!.connected,
      );
      assert.equal(
        received.some((value) => (value as { type?: string }).type === 'state'),
        false,
      );
      assert.deepEqual(
        presence,
        [true, false],
        'a cancelled queued attachment must never publish reconnect/unpause',
      );
      assert.equal(
        (
          await context.access.membership(
            context.grants[1]!.token,
            context.members[0]!.lobbyId,
            context.now(),
          )
        ).seatIds.length,
        2,
      );
    },
  );

  await t.test(
    'idle validation never extends expiry; external revoke and expiry close sockets',
    async (t) => {
      const context = await fixture(t);
      const socket = await context.connect();
      await message(socket, resync(context.members[0]!.lobbyId));
      const expires = (await context.access.inspect(context.grants[0]!.token, context.now()))!
        .expiresAtMs;
      context.setNow(expires - 1);
      await context.transport.checkCredentials();
      assert.equal(
        (await context.access.inspect(context.grants[0]!.token, context.now()))!.expiresAtMs,
        expires,
      );
      assert.equal(socket.connected, true);
      await context.access.authenticate(context.grants[0]!.token, context.now());
      await context.access.authenticate(context.grants[1]!.token, context.now());
      context.setNow(expires);
      await context.transport.checkCredentials();
      assert.equal(
        socket.connected,
        true,
        'another tab refresh must defeat an old expiry boundary',
      );
      const gone = once(socket, 'disconnect');
      await context.access.revoke(context.grants[0]!.token, context.now());
      await context.transport.checkCredentials();
      await gone;
      const another = await context.connect(1);
      const ended = once(another, 'disconnect');
      context.setNow(context.now() + GUEST_TTL_MS);
      await context.transport.checkCredentials();
      await ended;
    },
  );

  await t.test(
    'a resync delayed across atomic handoff cannot deliver a predecessor or silently switch games',
    async (t) => {
      const context = await fixture(t);
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      for (const socket of sockets) await message(socket, resync(context.members[0]!.lobbyId));
      await context.host.withCurrent(
        context.members[0]!.lobbyId,
        context.start.gameId,
        async (runtime) => {
          for (let index = 0; index < 36; index++) {
            const phase = runtime.read().state!.phase;
            if (phase.type !== 'dealing') assert.fail();
            await runtime.dispatch({
              type: 'draw-card',
              id: id('command', randomUUID()),
              actorId: phase.nextSeatId,
            });
          }
          await context.clock.advanceBy(10000);
        },
      );
      await finishHosted(context);
      const lookup = context.access.membership.bind(context.access);
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const mock = t.mock.method(
        context.access,
        'membership',
        async (...args: Parameters<typeof lookup>) => {
          const binding = await lookup(...args);
          entered();
          await gate;
          return binding;
        },
      );
      const successorMessages: ServerMessage[] = [];
      sockets[1]!.on('server-message', (message: ServerMessage) => successorMessages.push(message));
      const oldEpoch = latestEpoch.get(sockets[1]!);
      const result = message(sockets[0]!, resync(context.members[0]!.lobbyId));
      await waiting;
      const previous = (await context.host.read(context.members[0]!.lobbyId))!.snapshot.head;
      const next = {
        ...context.start,
        id: id('command', randomUUID()),
        expectedGameId: context.start.gameId,
        expectedHead: previous,
        gameId: id('game', randomUUID()),
        branchId: id('branch', randomUUID()),
      };
      assert.equal(
        (await context.host.startMatch(context.members[0]!.lobbyId, next)).type,
        'started',
      );
      await until(async () => latestState.get(sockets[1]!)?.view.head.gameId === next.gameId);
      assert.notEqual(latestEpoch.get(sockets[1]!), oldEpoch);
      assert.equal(
        successorMessages.some(
          (message) => message.type === 'action' && message.view.head.gameId === next.gameId,
        ),
        false,
        'successor installation starts with a baseline, not prepared actions',
      );
      release();
      assert.equal((await result).type, 'error');
      mock.mock.restore();
      const replacement = await context.connect();
      const current = await message(replacement, resync(context.members[0]!.lobbyId));
      if (current.type !== 'state') assert.fail();
      assert.equal(current.view.head.gameId, next.gameId);
    },
  );

  await t.test(
    'resync projects at emission after delayed authentication, never replaying an expired reveal',
    async (t) => {
      const context = await fixture(t, 2, 60000);
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      for (const socket of sockets) await message(socket, resync(context.members[0]!.lobbyId));
      await context.host.withCurrent(
        context.members[0]!.lobbyId,
        context.start.gameId,
        async (runtime) => {
          for (let index = 0; index < 36; index++) {
            const phase = runtime.read().state!.phase;
            if (phase.type !== 'dealing') assert.fail();
            await runtime.dispatch({
              type: 'draw-card',
              id: id('command', randomUUID()),
              actorId: phase.nextSeatId,
            });
          }
        },
      );
      const inspect = context.access.inspectSeat.bind(context.access);
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const mock = t.mock.method(
        context.access,
        'inspectSeat',
        async (...args: Parameters<typeof inspect>) => {
          entered();
          await gate;
          return inspect(...args);
        },
      );
      const pending = message(sockets[0]!, resync(context.members[0]!.lobbyId));
      await waiting;
      await context.clock.advanceBy(10000);
      release();
      const result = await pending;
      mock.mock.restore();
      if (result.type !== 'state') assert.fail();
      assert.equal(result.view.transient.reveal, null);
      assert.equal(result.view.state!.phase.type, 'between-rounds');
    },
  );

  await t.test(
    'TLS transport restart recovers a new baseline without replaying private stump peeks',
    async (t) => {
      const context = await fixture(t);
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      for (const socket of sockets) await message(socket, resync(context.members[0]!.lobbyId));
      await context.host.withCurrent(
        context.members[0]!.lobbyId,
        context.start.gameId,
        async (runtime) => {
          for (let index = 0; index < 36; index++) {
            const phase = runtime.read().state!.phase;
            if (phase.type !== 'dealing') assert.fail();
            await runtime.dispatch({
              type: 'draw-card',
              id: id('command', randomUUID()),
              actorId: phase.nextSeatId,
            });
          }
          await context.clock.advanceBy(10000);
          const stump = runtime.read().state!.players[0]!.stumps[0]!;
          assert.equal(
            (
              await runtime.dispatch({
                type: 'open-stump',
                id: id('command', randomUUID()),
                actorId: context.members[0]!.seatId,
                cardId: stump,
              })
            ).type,
            'accepted',
          );
        },
      );
      const before = await message(sockets[0]!, resync(context.members[0]!.lobbyId));
      if (before.type !== 'state') assert.fail();
      const state = (await context.host.read(context.members[0]!.lobbyId))!.snapshot.state!;
      const face = state.cards.find((card) => card.id === state.players[0]!.stumps[0]!)!.face;
      assert.equal(JSON.stringify(before).includes(JSON.stringify(face)), false);
      await context.transport.close();
      await context.host.close();
      const host = new PostgresGameHost(pool, {
        inputs: () => ({
          clock: context.clock,
          randomInt: (upper) => upper - 1,
          nextCommandId: () => id('command', randomUUID()),
        }),
      });
      const transport = new PenkyTransport({
        host,
        access: context.access,
        tls: { key, cert },
        origins: [origin],
      });
      const base = await transport.listen();
      t.after(async () => {
        await transport.close();
        await host.close();
      });
      const socket = io(base, {
        ca: cert.toString(),
        transports: ['websocket'],
        reconnection: false,
        extraHeaders: {
          Origin: origin,
          Cookie: `${GUEST_COOKIE_NAME}=${context.grants[0]!.token}`,
        },
      });
      t.after(() => {
        socket.disconnect();
      });
      acknowledge(socket);
      await once(socket, 'connect');
      const after = await message(socket, resync(context.members[0]!.lobbyId));
      if (after.type !== 'state') assert.fail();
      assert.notEqual(after.delivery.epoch, before.delivery.epoch);
      assert.equal(after.delivery.sequence, 1);
      assert.equal(JSON.stringify(after).includes(JSON.stringify(face)), false);
      assert.equal(Object.hasOwn(after, 'actions'), false);
    },
  );

  await t.test(
    'post-handshake polling requests and WebSocket upgrades still require an allowed Origin',
    async (t) => {
      const { base } = await fixture(t);
      const handshake = await http(base, '/socket.io/?EIO=4&transport=polling', 'GET');
      assert.equal(handshake.status, 200);
      const sid = (JSON.parse(handshake.body.slice(1)) as { sid: string }).sid;
      assert.equal(
        (
          await http(
            base,
            `/socket.io/?EIO=4&transport=polling&sid=${sid}`,
            'POST',
            undefined,
            'https://evil.invalid',
            '40',
          )
        ).status,
        403,
      );
      const upgrade = await http(
        base,
        `/socket.io/?EIO=4&transport=websocket&sid=${sid}`,
        'GET',
        undefined,
        'https://evil.invalid',
        '',
        {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        },
      ).catch((error: NodeJS.ErrnoException) => {
        assert.equal(error.code, 'ECONNRESET');
        return { status: 403 };
      });
      assert.equal(
        upgrade.status,
        403,
        'an upgrade must either fail with 403 or close the transport',
      );
    },
  );

  await t.test(
    'lobby membership never grants spectator access to an old or pre-creation-rollback match',
    async (t) => {
      const context = await fixture(t);
      const first = await context.connect();
      const second = await context.connect(1);
      for (const socket of [first, second])
        await message(socket, resync(context.members[0]!.lobbyId));
      await context.host.withCurrent(
        context.members[0]!.lobbyId,
        context.start.gameId,
        async (runtime) => {
          for (let index = 0; index < 36; index++) {
            const phase = runtime.read().state!.phase;
            if (phase.type !== 'dealing') assert.fail();
            await runtime.dispatch({
              type: 'draw-card',
              id: id('command', randomUUID()),
              actorId: phase.nextSeatId,
            });
          }
          await context.clock.advanceBy(10000);
        },
      );
      await finishHosted(context);
      const newcomer = await context.access.issue(context.now());
      await context.access.joinLobby(newcomer.token, context.members[0]!.lobbyId, context.now());
      let socket = context.client(newcomer.token);
      await once(socket, 'connect');
      assert.deepEqual(await message(socket, resync(context.members[0]!.lobbyId)), {
        protocolVersion: 1,
        type: 'error',
        code: 'unauthorized',
      });
      assert.deepEqual(
        await play(context, socket, { type: 'draw-card' }, context.start.id),
        { protocolVersion: 1, type: 'error', code: 'unauthorized' },
        'nonparticipants receive no cached receipt/head',
      );
      socket = context.client(newcomer.token);
      await once(socket, 'connect');
      await context.host.withCurrent(context.members[0]!.lobbyId, context.start.gameId, (runtime) =>
        runtime.dispatch({
          type: 'rollback',
          id: id('command', randomUUID()),
          actorId: context.members[0]!.seatId,
          expected: runtime.read().head,
          beforeCommandId: context.start.id,
          knowledgeWarningAcknowledged: true,
        }),
      );
      assert.equal((await context.host.read(context.members[0]!.lobbyId))!.snapshot.state, null);
      assert.deepEqual(await message(socket, resync(context.members[0]!.lobbyId)), {
        protocolVersion: 1,
        type: 'error',
        code: 'unauthorized',
      });
      assert.deepEqual(await play(context, socket, { type: 'draw-card' }, context.start.id), {
        protocolVersion: 1,
        type: 'error',
        code: 'unauthorized',
      });
    },
  );

  await t.test(
    'storage failures send only fixed errors and detach previously admitted presence',
    async (t) => {
      const context = await fixture(t);
      const socket = await context.connect();
      await message(socket, resync(context.members[0]!.lobbyId));
      const mock = t.mock.method(context.access, 'membership', async () => {
        throw new GuestAccessError('storage-unavailable');
      });
      assert.deepEqual(await message(socket, resync(context.members[0]!.lobbyId)), {
        protocolVersion: 1,
        type: 'error',
        code: 'unavailable',
      });
      mock.mock.restore();
      await until(
        async () =>
          !(await context.host.read(context.members[0]!.lobbyId))!.snapshot.connections.find(
            (seat) => seat.seatId === context.members[0]!.seatId,
          )!.connected,
      );
      const other = await context.connect(1);
      const failed = t.mock.method(context.host, 'attach', async () => {
        throw new Error(`PRIVATE SQL ${context.grants[1]!.token}`);
      });
      assert.deepEqual(await message(other, resync(context.members[0]!.lobbyId)), {
        protocolVersion: 1,
        type: 'error',
        code: 'unavailable',
      });
      failed.mock.restore();
      assert.equal(
        (await context.host.read(context.members[0]!.lobbyId))!.snapshot.connections.some(
          (seat) => seat.connected,
        ),
        false,
      );
    },
  );

  await t.test(
    'shutdown drains pending attachment without ever publishing a cancelled reconnect',
    async (t) => {
      const context = await fixture(t);
      const socket = await context.connect();
      const attach = context.host.attach.bind(context.host);
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const mock = t.mock.method(
        context.host,
        'attach',
        async (...args: Parameters<typeof context.host.attach>) => {
          entered();
          await gate;
          return attach(...args);
        },
      );
      const presence: boolean[] = [];
      await context.host.withCurrent(context.members[0]!.lobbyId, context.start.gameId, (runtime) =>
        runtime.subscribe((notice) => {
          presence.push(notice.snapshot.connections.some((seat) => seat.connected));
        }),
      );
      socket.emit('client-message', resync(context.members[0]!.lobbyId));
      await waiting;
      const closing = context.transport.close();
      release();
      await closing;
      mock.mock.restore();
      assert.equal(presence.some(Boolean), false);
      assert.equal(context.transport.close(), closing);
    },
  );

  await t.test('shutdown also drains a handshake waiting on durable authentication', async (t) => {
    const context = await fixture(t);
    const inspect = context.access.inspect.bind(context.access);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const mock = t.mock.method(
      context.access,
      'inspect',
      async (...args: Parameters<typeof inspect>) => {
        entered();
        await gate;
        return inspect(...args);
      },
    );
    const socket = context.client(context.grants[0]!.token);
    let connected = false;
    socket.on('connect', () => {
      connected = true;
    });
    await waiting;
    const closing = context.transport.close();
    release();
    await closing;
    mock.mock.restore();
    assert.equal(connected, false);
    assert.equal(
      (await context.host.read(context.members[0]!.lobbyId))!.snapshot.connections.some(
        (seat) => seat.connected,
      ),
      false,
    );
  });

  await t.test(
    'issuance bursts and binary attachment streams are refused without game actions',
    async (t) => {
      const context = await fixture(t);
      for (let count = 0; count < 6; count++)
        assert.equal((await http(context.base, '/api/guest/session')).status, 204);
      assert.equal((await http(context.base, '/api/guest/session')).status, 429);
      const socket = await context.connect();
      const before = (await context.host.read(context.members[0]!.lobbyId))!.snapshot.head;
      const ended = once(socket, 'disconnect');
      socket.emit('client-message', Buffer.from('binary attachment'));
      await ended;
      assert.deepEqual(
        (await context.host.read(context.members[0]!.lobbyId))!.snapshot.head,
        before,
      );
    },
  );

  await t.test(
    'resync rotates stream epochs without resetting the socket event rate budget',
    async (t) => {
      const context = await fixture(t, 2, 60000);
      const socket = await context.connect();
      const ended = once(socket, 'disconnect');
      for (let count = 0; count < 20; count++)
        assert.equal((await message(socket, resync(context.members[0]!.lobbyId))).type, 'state');
      socket.emit('client-message', resync(context.members[0]!.lobbyId));
      await ended;
    },
  );

  await t.test(
    'invalid event names and argument counts are rate limited before error responses',
    async (t) => {
      const context = await fixture(t);
      for (const event of ['unknown-event', 'client-message']) {
        const socket = await context.connect();
        let responses = 0;
        socket.on('server-message', () => {
          responses++;
        });
        const ended = once(socket, 'disconnect');
        for (let index = 0; index < 40; index++) socket.emit(event, {}, {});
        await ended;
        assert.ok(responses <= 21);
      }
    },
  );

  await t.test(
    'wrong first-start expectation, malformed and oversized payloads never dispatch game actions',
    async (t) => {
      const context = await fixture(t);
      const socket = await context.connect();
      await message(socket, resync(context.members[0]!.lobbyId));
      const before = (await context.host.read(context.members[0]!.lobbyId))!.snapshot.head;
      const payload = {
        protocolVersion: 1,
        requestId: randomUUID(),
        intent: {
          type: 'start-match',
          lobbyId: context.members[0]!.lobbyId,
          expected: null,
        },
      };
      assert.deepEqual(await message(socket, payload), {
        protocolVersion: 1,
        type: 'match-start-ack',
        requestId: payload.requestId,
        result: { type: 'rejected', code: 'wrong-game' },
      });
      assert.equal((await message(socket, { token: context.grants[0]!.token })).type, 'error');
      assert.deepEqual(
        (await context.host.read(context.members[0]!.lobbyId))!.snapshot.head,
        before,
      );
      const ended = once(socket, 'disconnect');
      socket.emit('client-message', 'x'.repeat(20000));
      await ended;
    },
  );
});
