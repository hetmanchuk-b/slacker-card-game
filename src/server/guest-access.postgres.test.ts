import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Pool } from 'pg';
import { id } from '../game/ids.ts';
import { migrate, PostgresSession } from '../persistence/postgres.ts';
import { PostgresLobby } from '../persistence/lobby.ts';
import type { LiveMatch } from '../persistence/lobby.ts';
import type { MatchStart } from '../persistence/lobby-contracts.ts';
import { finishMatch } from '../runtime/testing/match.ts';
import { FakeClock } from '../runtime/testing/fake-clock.ts';
import { PostgresGuestAccess } from './guest-access.ts';
import { guestTokenHash, GUEST_TTL_MS } from './guest-session.ts';

const url = process.env.PENKY_TEST_DATABASE_URL;
test('PostgreSQL guest authentication and membership', { skip: !url }, async (t) => {
  assert.ok(new URL(url!).pathname.endsWith('_test'));
  const applicationName = `penky-auth-test-${randomUUID()}`;
  const pool = new Pool({
    connectionString: url,
    max: 16,
    connectionTimeoutMillis: 3000,
    application_name: applicationName,
  });
  pool.on('error', () => {});
  t.after(() => pool.end());
  await migrate(pool);
  const access = new PostgresGuestAccess(pool);
  const lobbyId = () => id('lobby', randomUUID());
  async function setup() {
    const owner = await access.issue(1000);
    const member = await access.createLobby(owner.token, lobbyId(), 1000);
    const guest = await access.issue(1000);
    const joined = await access.joinLobby(guest.token, member.lobbyId, 1000);
    return { owner, member, guest, joined };
  }
  async function start(
    t: TestContext,
    context: Awaited<ReturnType<typeof setup>>,
    seatIds = context.joined.seatIds,
  ) {
    const lobby = await PostgresLobby.open(pool, context.member.lobbyId);
    const request: MatchStart = {
      id: id('command', randomUUID()),
      actorSessionId: context.member.sessionId,
      expectedGameId: null,
      expectedHead: null,
      gameId: id('game', randomUUID()),
      branchId: id('branch', randomUUID()),
      seatIds,
      cardIds: Array.from({ length: 36 }, () => id('card', randomUUID())),
    };
    const clock = new FakeClock(1000);
    const result = await lobby.startMatch(request, {
      clock,
      connectedSeatIds: seatIds,
      randomInt: (upper) => upper - 1,
      nextCommandId: () => id('command', randomUUID()),
    });
    if (result.type !== 'started') assert.fail();
    t.after(async () => {
      await result.runtime.dispose();
      await result.session.close();
    });
    return { live: result, clock, request };
  }
  async function finish(live: LiveMatch, clock: FakeClock) {
    for (let index = 0; index < 36; index++) {
      const phase = live.runtime.read().state!.phase;
      if (phase.type !== 'dealing') assert.fail();
      assert.equal(
        (
          await live.runtime.dispatch({
            type: 'draw-card',
            id: id('command', randomUUID()),
            actorId: phase.nextSeatId,
          })
        ).type,
        'accepted',
      );
    }
    await clock.advanceBy(10000);
    await finishMatch(live.runtime);
  }
  async function waitForLock(application: string, queryFragment: string) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE $2",
        [application, `%${queryFragment}%`],
      );
      if (result.rowCount) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.fail('Expected database lock wait');
  }

  await t.test(
    'creation request retries retain one lobby across services and process recovery',
    async () => {
      const grant = await access.issue(1000);
      const requestId = randomUUID();
      const other = new PostgresGuestAccess(pool);
      const results = await Promise.all([
        access.createLobbyFromIntent(grant.token, requestId, 1000),
        other.createLobbyFromIntent(grant.token, requestId, 1000),
      ]);
      assert.deepEqual(results[0], results[1]);
      assert.equal(results[0]!.position, 0);
      assert.equal(results[0]!.isOwner, true);
      const source = `
      import { Pool } from 'pg';
      import { PostgresGuestAccess } from './src/server/guest-access.ts';
      const pool = new Pool({ connectionString: process.env.PENKY_TEST_DATABASE_URL });
      try {
        const result = await new PostgresGuestAccess(pool).createLobbyFromIntent(process.env.TEST_TOKEN, process.env.TEST_REQUEST, 1000);
        process.stdout.write(JSON.stringify(result));
      } finally { await pool.end(); }
    `;
      const recovered = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
          env: { ...process.env, TEST_TOKEN: grant.token, TEST_REQUEST: requestId },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
          stdout += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr))));
      });
      assert.deepEqual(JSON.parse(recovered), results[0]);
      const separate = await access.createLobbyFromIntent(grant.token, randomUUID(), 1000);
      assert.notEqual(separate.lobbyId, results[0]!.lobbyId);
      const stranger = await access.issue(1000);
      const scoped = await access.createLobbyFromIntent(stranger.token, requestId, 1000);
      assert.notEqual(scoped.lobbyId, results[0]!.lobbyId);
      await access.revoke(grant.token, 1000);
      await assert.rejects(access.createLobbyFromIntent(grant.token, requestId, 1000), {
        message: 'authentication-required',
      });
    },
  );

  await t.test(
    'failed creation receipt rolls back lobby, membership and refresh before retry',
    async () => {
      const grant = await access.issue(1000);
      const session = await access.inspect(grant.token, 1000);
      const requestId = randomUUID();
      const fn = `creation_failure_${randomUUID().replaceAll('-', '')}`;
      await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.request_id = '${requestId}' THEN RAISE EXCEPTION 'private creation failure'; END IF;
      RETURN NEW; END $$`);
      await pool.query(
        `CREATE TRIGGER ${fn} BEFORE INSERT ON penky_lobby_creation_requests FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
      );
      try {
        await assert.rejects(access.createLobbyFromIntent(grant.token, requestId, 2000), {
          message: 'storage-unavailable',
        });
        const unchanged = await access.inspect(grant.token, 1000);
        assert.equal(unchanged!.expiresAtMs, session!.expiresAtMs);
        const rows = await pool.query('SELECT 1 FROM penky_lobbies WHERE owner_session_id=$1', [
          session!.sessionId,
        ]);
        assert.equal(rows.rowCount, 0);
      } finally {
        await pool.query(`DROP TRIGGER ${fn} ON penky_lobby_creation_requests`);
        await pool.query(`DROP FUNCTION ${fn}()`);
      }
      const retried = await access.createLobbyFromIntent(grant.token, requestId, 2000);
      assert.equal(retried.position, 0);
      assert.equal(
        (await access.membership(grant.token, retried.lobbyId, 2000)).seatId,
        retried.seatId,
      );
      assert.deepEqual(await access.createLobbyFromIntent(grant.token, requestId, 2000), retried);
      await assert.rejects(
        access.createLobbyFromIntent(grant.token, requestId, 2000 + GUEST_TTL_MS),
        { message: 'authentication-required' },
      );
    },
  );

  await t.test(
    'credentials persist only hashes and slide expiry without shortening on out-of-order requests',
    async () => {
      const grant = await access.issue(1000);
      const first = await access.authenticate(grant.token, 1000);
      assert.ok(first);
      assert.equal(first.expiresAtMs, 1000 + GUEST_TTL_MS);
      const stored = await pool.query('SELECT * FROM penky_guest_sessions WHERE session_id=$1', [
        first.sessionId,
      ]);
      assert.equal(stored.rows[0].token_hash, guestTokenHash(grant.token));
      assert.equal(JSON.stringify(stored.rows).includes(grant.token), false);
      assert.equal(
        await access.authenticate(first.sessionId, 1000),
        null,
        'session ID is not a credential',
      );
      const later = await access.authenticate(grant.token, 5000);
      assert.equal(later!.expiresAtMs, 5000 + GUEST_TTL_MS);
      const earlier = await access.authenticate(grant.token, 4000);
      assert.equal(earlier!.expiresAtMs, later!.expiresAtMs);
      assert.equal(
        await access.authenticate(grant.token, later!.expiresAtMs),
        null,
        'expiry is exclusive and cannot refresh an expired token',
      );
      assert.equal(await access.authenticate('SECRET-INVALID', 1000), null);
      await assert.rejects(access.issue(Number.MAX_SAFE_INTEGER), { message: 'invalid-time' });
    },
  );

  await t.test(
    'owner creation and repeat joins retain immutable owner-first clockwise seat bindings',
    async () => {
      const context = await setup();
      const reopened = new PostgresGuestAccess(pool);
      const duplicate = await reopened.createLobby(
        context.owner.token,
        context.member.lobbyId,
        1000,
      );
      assert.deepEqual(
        duplicate,
        context.joined.isOwner
          ? context.joined
          : { ...context.member, seatIds: context.joined.seatIds },
      );
      assert.equal(duplicate.position, 0);
      assert.equal(duplicate.isOwner, true);
      assert.equal(context.joined.position, 1);
      assert.deepEqual(context.joined.seatIds, [context.member.seatId, context.joined.seatId]);
      assert.equal(
        (await reopened.joinLobby(context.guest.token, context.member.lobbyId, 1000)).seatId,
        context.joined.seatId,
      );
      assert.equal(
        (await reopened.requireOwner(context.owner.token, context.member.lobbyId, 1000)).seatId,
        context.member.seatId,
      );
      await assert.rejects(
        reopened.requireOwner(context.guest.token, context.member.lobbyId, 1000),
        { message: 'owner-only' },
      );
      const foreign = await access.issue(1000);
      await assert.rejects(access.membership(foreign.token, context.member.lobbyId, 1000), {
        message: 'membership-required',
      });
      await assert.rejects(access.createLobby(foreign.token, context.member.lobbyId, 1000), {
        message: 'owner-only',
      });
    },
  );

  await t.test(
    'concurrent joins saturate eight unique stable seats across independent service instances',
    async () => {
      const owner = await access.issue(1000);
      const room = await access.createLobby(owner.token, lobbyId(), 1000);
      const guests = await Promise.all(Array.from({ length: 10 }, () => access.issue(1000)));
      const results = await Promise.allSettled(
        guests.map((guest) =>
          new PostgresGuestAccess(pool).joinLobby(guest.token, room.lobbyId, 1000),
        ),
      );
      const joined = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      assert.equal(joined.length, 7);
      assert.deepEqual(joined.map((member) => member.position).sort(), [1, 2, 3, 4, 5, 6, 7]);
      assert.equal(new Set(joined.map((member) => member.seatId)).size, 7);
      assert.equal(
        results.filter(
          (result) => result.status === 'rejected' && result.reason.message === 'lobby-full',
        ).length,
        3,
      );
      const stored = await access.requireOwner(owner.token, room.lobbyId, 1000);
      assert.equal(stored.seatIds.length, 8);
      const token = guests[results.findIndex((result) => result.status === 'fulfilled')]!.token;
      const [one, two] = await Promise.all([
        access.joinLobby(token, room.lobbyId, 1000),
        new PostgresGuestAccess(pool).joinLobby(token, room.lobbyId, 1000),
      ]);
      assert.deepEqual(one, two);
    },
  );

  await t.test(
    'revocation and expiry deny credentials but never release seats or transfer ownership',
    async () => {
      const context = await setup();
      assert.equal(await access.revoke(context.owner.token, 2000), true);
      assert.equal(await access.authenticate(context.owner.token, 2000), null);
      await assert.rejects(access.requireOwner(context.owner.token, context.member.lobbyId, 2000), {
        message: 'authentication-required',
      });
      assert.equal(await access.revoke(context.owner.token, 2000), false);
      await assert.rejects(
        access.membership(context.guest.token, context.member.lobbyId, 1000 + GUEST_TTL_MS),
        { message: 'authentication-required' },
      );
      const fresh = await access.issue(2000);
      const joined = await access.joinLobby(fresh.token, context.member.lobbyId, 2000);
      assert.equal(joined.position, 2);
      assert.equal(joined.isOwner, false);
      assert.deepEqual(joined.seatIds.slice(0, 2), context.joined.seatIds);
      const binding = await (await PostgresLobby.open(pool, context.member.lobbyId)).read();
      assert.equal(binding.ownerSessionId, context.member.sessionId);
      await assert.rejects(access.requireOwner(fresh.token, context.member.lobbyId, 2000), {
        message: 'owner-only',
      });
    },
  );

  await t.test(
    'running games admit existing members only; stored roster order is the authoritative match roster',
    async (t) => {
      const context = await setup();
      const { live } = await start(t, context);
      const fresh = await access.issue(1000);
      await assert.rejects(access.joinLobby(fresh.token, context.member.lobbyId, 1000), {
        message: 'match-running',
      });
      const existing = await access.joinLobby(context.guest.token, context.member.lobbyId, 1000);
      assert.equal(existing.seatId, context.joined.seatId);
      assert.equal(existing.currentGameId, live.gameId);
      assert.deepEqual(
        live.runtime.read().state!.players.map((player) => player.id),
        existing.seatIds,
      );
    },
  );

  await t.test(
    'finished admission does not alter an old roster; rollback reopens its gate to new seats',
    async (t) => {
      const context = await setup();
      const { live, clock } = await start(t, context);
      await finish(live, clock);
      const fresh = await access.issue(11000);
      const joined = await access.joinLobby(fresh.token, context.member.lobbyId, 11000);
      assert.equal(joined.position, 2);
      assert.equal(live.runtime.read().state!.players.length, 2);
      const last = live.session.history.read().actions.at(-1)!;
      const result = await live.runtime.dispatch({
        type: 'rollback',
        id: id('command', randomUUID()),
        actorId: context.member.seatId,
        expected: live.runtime.read().head,
        beforeCommandId: last.commandId,
        knowledgeWarningAcknowledged: true,
      });
      assert.equal(result.type, 'accepted');
      assert.notEqual(live.runtime.read().state!.phase.type, 'finished');
      const other = await access.issue(11000);
      await assert.rejects(access.joinLobby(other.token, context.member.lobbyId, 11000), {
        message: 'match-running',
      });
      assert.equal(
        (await access.membership(fresh.token, context.member.lobbyId, 11000)).seatId,
        joined.seatId,
      );
    },
  );

  await t.test(
    'admission waits for a prior durable rollback rather than reading a stale finished frame',
    async (t) => {
      const context = await setup();
      const { live, clock } = await start(t, context);
      await finish(live, clock);
      const blocker = await pool.connect();
      const fresh = await access.issue(11000);
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM penky_game_heads WHERE game_id=$1 FOR UPDATE', [
        live.gameId,
      ]);
      const target = live.session.history.read().actions.at(-1)!.commandId;
      const rollback = live.runtime.dispatch({
        type: 'rollback',
        id: id('command', randomUUID()),
        actorId: context.member.seatId,
        expected: live.runtime.read().head,
        beforeCommandId: target,
        knowledgeWarningAcknowledged: true,
      });
      let admission: Promise<unknown> | undefined;
      try {
        await waitForLock(`penky-game:${live.gameId}`, 'UPDATE penky_game_heads');
        admission = access.joinLobby(fresh.token, context.member.lobbyId, 11000);
        // Attach immediately; test should never generate an unhandled rejection.
        admission.catch(() => {});
        await waitForLock(applicationName, 'penky_game_heads');
      } finally {
        await blocker.query('COMMIT');
        blocker.release();
      }
      assert.equal((await rollback).type, 'accepted');
      await assert.rejects(admission!, { message: 'match-running' });
    },
  );

  await t.test(
    'a stale prepared roster cannot start after a join wins the lobby lock',
    async () => {
      const context = await setup();
      const selected = context.joined.seatIds;
      const extra = await access.issue(1000);
      await access.joinLobby(extra.token, context.member.lobbyId, 1000);
      const lobby = await PostgresLobby.open(pool, context.member.lobbyId);
      const request: MatchStart = {
        id: id('command', randomUUID()),
        actorSessionId: context.member.sessionId,
        expectedGameId: null,
        expectedHead: null,
        gameId: id('game', randomUUID()),
        branchId: id('branch', randomUUID()),
        seatIds: selected,
        cardIds: Array.from({ length: 36 }, () => id('card', randomUUID())),
      };
      await assert.rejects(
        lobby.startMatch(request, {
          clock: new FakeClock(1000),
          connectedSeatIds: selected,
          randomInt: (upper) => upper - 1,
          nextCommandId: () => id('command', randomUUID()),
        }),
        /Lobby roster changed/,
      );
      assert.equal((await lobby.read()).currentGameId, null);
      assert.equal(await lobby.startReceipt(request.id), null);
      assert.equal(await PostgresSession.load(pool, request.gameId), null);
    },
  );

  await t.test(
    'failed owner-membership creation rolls back the lobby and redacts storage diagnostics',
    async () => {
      const owner = await access.issue(1000);
      const target = lobbyId();
      const suffix = randomUUID().replaceAll('-', '');
      await pool.query(
        `CREATE FUNCTION guest_fail_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.lobby_id='${target}' THEN RAISE EXCEPTION 'SECRET-CREDENTIAL-DIAGNOSTIC'; END IF; RETURN NEW; END $$`,
      );
      await pool.query(
        `CREATE TRIGGER guest_fail_${suffix} BEFORE INSERT ON penky_lobby_members FOR EACH ROW EXECUTE FUNCTION guest_fail_${suffix}()`,
      );
      try {
        await assert.rejects(access.createLobby(owner.token, target, 1000), {
          message: 'storage-unavailable',
        });
        assert.equal(
          (await pool.query('SELECT 1 FROM penky_lobbies WHERE lobby_id=$1', [target])).rowCount,
          0,
        );
        assert.equal(
          (await pool.query('SELECT 1 FROM penky_lobby_members WHERE lobby_id=$1', [target]))
            .rowCount,
          0,
        );
      } finally {
        await pool.query(`DROP TRIGGER guest_fail_${suffix} ON penky_lobby_members`);
        await pool.query(`DROP FUNCTION guest_fail_${suffix}()`);
      }
    },
  );

  await t.test(
    'legacy trusted lobbies cannot be adopted by a fresh credential or lobby code',
    async () => {
      const guest = await access.issue(1000);
      const binding = {
        id: lobbyId(),
        ownerSessionId: id('session', randomUUID()),
        ownerSeatId: id('seat', randomUUID()),
      };
      await PostgresLobby.create(pool, binding);
      await assert.rejects(access.joinLobby(guest.token, binding.id, 1000), {
        message: 'lobby-unavailable',
      });
      await assert.rejects(access.membership(guest.token, binding.id, 1000), {
        message: 'lobby-unavailable',
      });
    },
  );

  await t.test(
    'a current match rolled back before creation keeps its reserved admission gate closed',
    async (t) => {
      const context = await setup();
      const { live, request } = await start(t, context);
      const result = await live.runtime.dispatch({
        type: 'rollback',
        id: id('command', randomUUID()),
        actorId: context.member.seatId,
        expected: live.runtime.read().head,
        beforeCommandId: request.id,
        knowledgeWarningAcknowledged: true,
      });
      assert.equal(result.type, 'accepted');
      assert.equal(live.runtime.read().state, null);
      const fresh = await access.issue(1000);
      await assert.rejects(access.joinLobby(fresh.token, context.member.lobbyId, 1000), {
        message: 'match-running',
      });
      assert.equal(
        (await access.requireOwner(context.owner.token, context.member.lobbyId, 1000)).seatId,
        context.member.seatId,
      );
      assert.equal(
        (await access.joinLobby(context.guest.token, context.member.lobbyId, 1000)).seatId,
        context.joined.seatId,
      );
    },
  );

  await t.test('a corrupt durable game frame cannot open admission', async (t) => {
    const context = await setup();
    const { live } = await start(t, context);
    await pool.query(
      'UPDATE penky_game_frames SET payload=jsonb_set(payload,\'{snapshot,state,phase}\', \'{"type":"finished","result":{"type":"all-won"}}\'::jsonb) WHERE game_id=$1',
      [live.gameId],
    );
    const fresh = await access.issue(1000);
    await assert.rejects(access.joinLobby(fresh.token, context.member.lobbyId, 1000), {
      message: 'lobby-unavailable',
    });
  });

  await t.test(
    'a fresh Node process authenticates the same guest and recovers its bound seat',
    async () => {
      const context = await setup();
      const moduleUrl = new URL('./guest-access.ts', import.meta.url).href;
      const script = `import { Pool } from 'pg'; import { PostgresGuestAccess } from ${JSON.stringify(moduleUrl)};
      let text=''; for await (const chunk of process.stdin) text+=chunk;
      const input=JSON.parse(text); const pool=new Pool({connectionString:process.env.PENKY_TEST_DATABASE_URL});
      try { const result=await new PostgresGuestAccess(pool).membership(input.token,input.lobbyId,1000); process.stdout.write(JSON.stringify(result)); }
      catch { process.stderr.write('Guest recovery failed'); process.exitCode=1; } finally { await pool.end(); }`;
      const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const result = await new Promise<string>((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('exit', (code) =>
          code === 0 ? resolve(stdout) : reject(new Error(stderr || 'Child failed')),
        );
        child.stdin.end(
          JSON.stringify({ token: context.guest.token, lobbyId: context.member.lobbyId }),
        );
      });
      assert.deepEqual(JSON.parse(result), context.joined);
      assert.equal(result.includes(context.guest.token), false);
    },
  );
});
