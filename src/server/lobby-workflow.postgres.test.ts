import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { test } from 'node:test';
import { Pool } from 'pg';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { ServerMessage } from '../protocol/contracts.ts';
import type { LobbyWorkflow } from '../protocol/lobby-workflow.ts';
import { id } from '../game/ids.ts';
import { migrate } from '../persistence/postgres.ts';
import { FakeClock } from '../runtime/testing/fake-clock.ts';
import { PostgresGameHost } from './game-host.ts';
import { PostgresGuestAccess } from './guest-access.ts';
import { PenkyTransport } from './transport.ts';

const url = process.env.PENKY_TEST_DATABASE_URL;
const origin = 'https://localhost';
const cert = readFileSync(new URL('./testing/localhost-cert.pem', import.meta.url));
const key = readFileSync(new URL('./testing/localhost-key.pem', import.meta.url));

test(
  'authenticated lobby agreement acceptance workflow',
  { skip: !url, timeout: 60000 },
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
    for (const count of [2, 4, 8])
      await t.test(`${count} members accept one epoch concurrently before start`, async (t) => {
        let now = 1000;
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
          now: () => now,
          authPollMs: 60000,
        });
        const base = await transport.listen(0, '127.0.0.1');
        const sockets: Socket[] = [];
        t.after(async () => {
          sockets.forEach((socket) => socket.disconnect());
          await transport.close();
          await host.close();
        });
        async function post(path: string, cookie?: string, data?: unknown, source = origin) {
          now += 10001;
          const body = data === undefined ? '' : JSON.stringify(data);
          return new Promise<{ status: number; cookie?: string; body: string }>(
            (resolve, reject) => {
              const req = request(
                new URL(path, base),
                {
                  method: 'POST',
                  ca: cert,
                  headers: {
                    Origin: source,
                    'Content-Length': Buffer.byteLength(body),
                    ...(cookie ? { Cookie: cookie } : {}),
                    ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
                  },
                },
                (res) => {
                  let body = '';
                  res.on('data', (chunk) => {
                    body += String(chunk);
                  });
                  res.on('end', () =>
                    resolve({
                      status: res.statusCode!,
                      body,
                      ...(res.headers['set-cookie']?.[0]
                        ? { cookie: res.headers['set-cookie'][0].split(';')[0]! }
                        : {}),
                    }),
                  );
                },
              );
              req.on('error', reject);
              req.end(body);
            },
          );
        }
        const cookies: string[] = [];
        let lobbyId = '';
        for (let index = 0; index < count; index++) {
          const issued = await post('/api/guest/session');
          assert.equal(issued.status, 204);
          cookies.push(issued.cookie!);
          const membership = await post(
            lobbyId ? '/api/lobbies/join' : '/api/lobbies',
            issued.cookie,
            lobbyId ? { lobbyId } : { requestId: randomUUID() },
          );
          assert.equal(membership.status, 200);
          lobbyId = JSON.parse(membership.body).lobbyId;
        }
        const read = async (cookie = cookies[0]!) => {
          const result = await post('/api/lobbies/state', cookie, { lobbyId });
          assert.equal(result.status, 200);
          return JSON.parse(result.body) as LobbyWorkflow;
        };
        const initial = await read();
        assert.equal(initial.revision, String(count - 1));
        assert.deepEqual(
          initial.members.map((member) => member.ready),
          Array.from({ length: count }, () => false),
        );
        assert.equal(initial.matchAgreements, null);
        const edited = await post('/api/lobbies/agreements', cookies[0], {
          lobbyId,
          expectedRevision: initial.revision,
          text: ' Exact agreements\n ',
        });
        assert.equal(edited.status, 200);
        const epoch: LobbyWorkflow = JSON.parse(edited.body);
        const revision = epoch.revision;
        assert.equal(revision, String(count));
        const forbidden = await post('/api/lobbies/agreements', cookies[1], {
          lobbyId,
          expectedRevision: revision,
          text: 'forged',
        });
        assert.equal(forbidden.status, 403);
        assert.equal(forbidden.body, '');
        for (const data of [
          { lobbyId, expectedRevision: revision, ready: true, seatId: initial.members[0]!.seatId },
          { lobbyId, expectedRevision: '01', ready: true },
          { lobbyId, expectedRevision: revision, ready: 'true' },
        ]) {
          const invalid = await post('/api/lobbies/ready', cookies[0], data);
          assert.equal(invalid.status, 400);
          assert.equal(invalid.body, '');
        }
        const badOrigin = await post(
          '/api/lobbies/state',
          cookies[0],
          { lobbyId },
          'https://evil.example',
        );
        assert.equal(badOrigin.status, 403);
        assert.equal((await post('/api/lobbies/state', undefined, { lobbyId })).status, 401);
        assert.equal(
          (
            await post('/api/lobbies/agreements', cookies[0], {
              lobbyId,
              expectedRevision: revision,
              text: 'é'.repeat(2049),
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await post('/api/lobbies/ready', cookies[0], {
              lobbyId,
              expectedRevision: initial.revision,
              ready: true,
            })
          ).status,
          409,
        );
        const confirmations = await Promise.all(
          cookies.slice(0, -1).map((cookie) =>
            post('/api/lobbies/ready', cookie, {
              lobbyId,
              expectedRevision: revision,
              ready: true,
            }),
          ),
        );
        assert.ok(confirmations.every((result) => result.status === 200));
        assert.equal((await read()).revision, revision);
        const socket = io(base, {
          ca: cert.toString(),
          transports: ['websocket'],
          reconnection: false,
          autoConnect: false,
          extraHeaders: { Origin: origin, Cookie: cookies[0]! },
        });
        sockets.push(socket);
        socket.on('server-message', (_message, receipt: string, ack: (receipt: string) => void) =>
          ack(receipt),
        );
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', resolve);
          socket.once('connect_error', reject);
          socket.connect();
        });
        async function send(intent: object, requestId = randomUUID()) {
          now += 1001;
          return new Promise<ServerMessage>((resolve, reject) => {
            const timer = setTimeout(() => {
              socket.off('server-message', receive);
              reject(new Error('missing reply'));
            }, 10000);
            function receive(message: ServerMessage) {
              if (
                message.type !== 'error' &&
                (!('requestId' in message) || message.requestId !== requestId)
              )
                return;
              clearTimeout(timer);
              socket.off('server-message', receive);
              resolve(message);
            }
            socket.on('server-message', receive);
            socket.emit('client-message', { protocolVersion: 1, requestId, intent });
          });
        }
        assert.deepEqual(await send({ type: 'resync', lobbyId }), {
          protocolVersion: 1,
          type: 'error',
          code: 'unavailable',
        });
        const startId = randomUUID();
        const start = { type: 'start-match', lobbyId, expected: null };
        const unready = await send(start, startId);
        assert.ok(unready.type === 'match-start-ack' && unready.result.type === 'rejected');
        assert.equal(
          unready.result.code,
          'not-ready',
          'a disconnected nonaccepting member still blocks start',
        );
        assert.equal((await read()).revision, revision);
        assert.deepEqual(
          (await read()).members.map((member) => member.ready),
          [...Array.from({ length: count - 1 }, () => true), false],
        );
        const last = await post('/api/lobbies/ready', cookies.at(-1), {
          lobbyId,
          expectedRevision: revision,
          ready: true,
        });
        assert.equal(last.status, 200);
        const identical = await post('/api/lobbies/agreements', cookies[0], {
          lobbyId,
          expectedRevision: revision,
          text: epoch.text,
        });
        assert.equal(identical.status, 200);
        assert.deepEqual(
          JSON.parse(identical.body).members.map((member: { ready: boolean }) => member.ready),
          Array.from({ length: count }, () => true),
        );
        socket.disconnect();
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', resolve);
          socket.once('connect_error', reject);
          socket.connect();
        });
        assert.deepEqual(await send({ type: 'resync', lobbyId }), {
          protocolVersion: 1,
          type: 'error',
          code: 'unavailable',
        });
        const reconnected = await read();
        assert.equal(reconnected.revision, revision);
        assert.ok(reconnected.members.every((member) => member.ready));
        const accepted = await send(start, startId);
        assert.ok(accepted.type === 'match-start-ack' && accepted.result.type === 'started');
        const after = await read(cookies.at(-1));
        assert.equal(after.revision, String(count + 1));
        assert.equal(after.editable, false);
        assert.deepEqual(
          after.members.map((member) => member.ready),
          Array.from({ length: count }, () => false),
        );
        assert.deepEqual(after.matchAgreements, {
          gameId: accepted.result.gameId,
          revision,
          text: epoch.text,
        });
        assert.deepEqual(await send(start, startId), {
          ...accepted,
          result: { ...accepted.result, duplicate: true },
        });
        assert.equal((await read()).revision, after.revision);
        assert.equal(
          (
            await post('/api/lobbies/ready', cookies[0], {
              lobbyId,
              expectedRevision: after.revision,
              ready: true,
            })
          ).status,
          409,
        );
        assert.deepEqual(Object.keys(after).sort(), [
          'editable',
          'lobbyId',
          'matchAgreements',
          'members',
          'revision',
          'text',
        ]);
        for (const member of after.members)
          assert.deepEqual(Object.keys(member).sort(), ['position', 'ready', 'seatId']);
        assert.doesNotMatch(JSON.stringify(after), /"(?:sessionId|token|cards|face|state|hand)":/);
      });
  },
);
