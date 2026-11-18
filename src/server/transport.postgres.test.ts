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
import { PostgresGameHost } from './game-host.ts';
import { GuestAccessError, PostgresGuestAccess } from './guest-access.ts';
import { FakeClock } from '../runtime/testing/fake-clock.ts';
import { finishMatch } from '../runtime/testing/match.ts';
import { GUEST_COOKIE_NAME, GUEST_TTL_MS, guestTokenHash } from './guest-session.ts';
import { PenkyTransport } from './transport.ts';
import type { ServerMessage } from '../protocol/contracts.ts';

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

async function message(socket: Socket, payload: unknown): Promise<ServerMessage> {
  const result = once(socket, 'server-message');
  socket.emit('client-message', payload);
  return (await result)[0] as ServerMessage;
}

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('Timed out waiting for observable transport state');
}

test('HTTPS and Socket.IO authenticated resync', { skip: !url, timeout: 90000 }, async (t) => {
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

  async function fixture(t: TestContext, count = 2, authPollMs = 25) {
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
    assert.equal((await host.startMatch(owner.lobbyId, start)).type, 'started');
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
      transport,
      base,
      grants,
      members,
      start,
      client,
      connect,
      setNow: (value: number) => {
        now = value;
      },
      now: () => now,
    };
  }

  type Context = Awaited<ReturnType<typeof fixture>>;
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

  for (const mode of ['disconnect', 'revoke', 'expire'] as const)
    await t.test(
      `${mode} while a gameplay command waits in the runtime queue cannot execute through retained seat presence`,
      async (t) => {
        const context = await fixture(t, 2, 60000);
        const sockets = await Promise.all([context.connect(), context.connect(1)]);
        for (const socket of sockets) await message(socket, resync(context.members[0]!.lobbyId));
        const initial = (await context.host.read(context.members[0]!.lobbyId))!.snapshot;
        if (initial.state!.phase.type !== 'dealing') assert.fail();
        const actor = context.members.findIndex(
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
          intent: {
            type: 'draw-card',
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
          },
        );
        assert.equal(
          received.some((reply) => reply.type === 'command-ack'),
          false,
        );
        if (mode === 'disconnect') accepted(await play(context, keeper, { type: 'draw-card' }));
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
      const baseline = await message(sockets[1 - actor]!, resync(context.members[0]!.lobbyId));
      assert.equal(baseline.type, 'state');
      assert.deepEqual(
        observations.map((reply) => reply.type),
        ['state'],
        'no unsolicited action/state publication is introduced',
      );
    },
  );

  await t.test(
    'existing claim procedures accept exact vote/withdrawal replies without enabling claim submission',
    async (t) => {
      const context = await fixture(t);
      const sockets = await Promise.all([context.connect(), context.connect(1)]);
      for (const socket of sockets) await message(socket, resync(context.members[0]!.lobbyId));
      await context.host.withCurrent(context.members[0]!.lobbyId, context.start.gameId, (runtime) =>
        runtime.dispatch({
          type: 'submit-claim',
          id: id('command', randomUUID()),
          actorId: context.members[0]!.seatId,
          accusedId: context.members[1]!.seatId,
          reason: 'Trusted claim fixture',
          incident: { type: 'spoken', key: 'trusted-episode' },
          scope: 'dealing',
          scopeNumber: 0,
        }),
      );
      const claim = (await context.host.read(context.members[0]!.lobbyId))!.snapshot.state!
        .claims[0]!.claim;
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
      const vote = (await context.host.read(context.members[0]!.lobbyId))!.snapshot.state!
        .procedure;
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
        (await context.host.read(context.members[0]!.lobbyId))!.snapshot.state!.claims[0]!
          .resolution,
        'tied',
      );
      const before = (await context.host.read(context.members[0]!.lobbyId))!.snapshot.head;
      assert.deepEqual(
        await play(context, sockets[0]!, {
          type: 'submit-claim',
          accusedId: context.members[1]!.seatId,
          reason: 'Still deferred',
          evidence: { type: 'spoken', key: 'new-episode' },
        }),
        { protocolVersion: 1, type: 'error', code: 'unavailable' },
      );
      assert.deepEqual(
        (await context.host.read(context.members[0]!.lobbyId))!.snapshot.head,
        before,
      );
    },
  );

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
          await finishMatch(runtime);
        },
      );
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
          await finishMatch(runtime);
        },
      );
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
    'deferred claims, malformed and oversized payloads never dispatch game actions',
    async (t) => {
      const context = await fixture(t);
      const socket = await context.connect();
      await message(socket, resync(context.members[0]!.lobbyId));
      const before = (await context.host.read(context.members[0]!.lobbyId))!.snapshot.head;
      const payload = {
        protocolVersion: 1,
        requestId: randomUUID(),
        intent: {
          type: 'submit-claim',
          gameId: context.start.gameId,
          branchId: context.start.branchId,
          accusedId: context.members[1]!.seatId,
          reason: 'Deferred spoken claim',
          evidence: { type: 'spoken', key: 'episode' },
        },
      };
      assert.deepEqual(await message(socket, payload), {
        protocolVersion: 1,
        type: 'error',
        code: 'unavailable',
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
