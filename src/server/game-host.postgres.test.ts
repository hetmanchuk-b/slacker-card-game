import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Pool } from 'pg';
import { id } from '../game/ids.ts';
import type { MatchStart } from '../persistence/lobby-contracts.ts';
import { migrate, PostgresSession } from '../persistence/postgres.ts';
import { FakeClock } from '../runtime/testing/fake-clock.ts';
import { finishMatch } from '../runtime/testing/match.ts';
import { PostgresGuestAccess } from './guest-access.ts';
import { PostgresGameHost } from './game-host.ts';
import type { HostPublication } from './game-host.ts';

const url = process.env.PENKY_TEST_DATABASE_URL;
test('PostgreSQL single-runtime game host', { skip: !url }, async (t) => {
  assert.ok(new URL(url!).pathname.endsWith('_test'));
  const pool = new Pool({ connectionString: url, max: 16, connectionTimeoutMillis: 3000 });
  pool.on('error', () => {});
  t.after(() => pool.end());
  await migrate(pool);
  const access = new PostgresGuestAccess(pool);
  async function failFrames(t: TestContext, gameId: string, condition = 'TRUE') {
    const name = `host_fail_${randomUUID().replaceAll('-', '')}`;
    // Only host-generated UUID identifiers are interpolated. The trigger is
    // game-specific, so concurrently running PostgreSQL suites are unaffected.
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.game_id = '${gameId}' AND (${condition}) THEN RAISE EXCEPTION 'injected host frame failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER ${name} BEFORE INSERT ON penky_game_frames FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    const remove = async () => {
      await pool.query(
        `DROP TRIGGER IF EXISTS ${name} ON penky_game_frames; DROP FUNCTION IF EXISTS ${name}()`,
      );
    };
    t.after(remove);
    return remove;
  }
  async function writerExited(gameId: string) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await pool.query('SELECT 1 FROM pg_stat_activity WHERE application_name=$1', [
        `penky-game:${gameId}`,
      ]);
      if (!result.rowCount) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.fail('Disposed writer backend did not exit');
  }
  async function setup(t: TestContext) {
    const clock = new FakeClock(1000);
    const reporters: ((error: unknown) => void)[] = [];
    const host = new PostgresGameHost(pool, {
      inputs: (onError) => {
        reporters.push(onError);
        return {
          clock: {
            now: () => clock.now(),
            scheduleAt: (at, task) =>
              clock.scheduleAt(at, async () => {
                try {
                  await task();
                } catch (error) {
                  onError(error);
                }
              }),
          },
          randomInt: (upper) => upper - 1,
          nextCommandId: () => id('command', randomUUID()),
        };
      },
    });
    t.after(() => host.close());
    const owner = await access.issue(1000);
    const member = await access.createLobby(owner.token, id('lobby', randomUUID()), 1000);
    const guest = await access.issue(1000);
    const joined = await access.joinLobby(guest.token, member.lobbyId, 1000);
    const ownerBinding = await access.membership(owner.token, member.lobbyId, 1000);
    const leaveOwner = await host.attach(ownerBinding);
    const leaveGuest = await host.attach(joined);
    const request: MatchStart = {
      id: id('command', randomUUID()),
      actorSessionId: member.sessionId,
      expectedGameId: null,
      expectedHead: null,
      gameId: id('game', randomUUID()),
      branchId: id('branch', randomUUID()),
      seatIds: joined.seatIds,
      cardIds: Array.from({ length: 36 }, () => id('card', randomUUID())),
    };
    assert.equal((await host.startMatch(member.lobbyId, request)).type, 'started');
    return {
      host,
      clock,
      member,
      joined,
      owner,
      guest,
      request,
      leaveOwner,
      leaveGuest,
      reporters,
    };
  }

  await t.test(
    'lobby subscriptions invalidate retired writers and rebind state-only after recovery without action replay',
    async (t) => {
      const { host, member, request } = await setup(t);
      const notices: HostPublication[] = [];
      const stop = await host.subscribe(member.lobbyId, (notice) => {
        notices.push(notice);
      });
      assert.equal(notices[0]!.type, 'publication');
      const first = notices[0]!;
      if (first.type !== 'publication') assert.fail();
      assert.equal(first.publication.kind, 'initial');
      assert.deepEqual(first.publication.actions, []);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        const phase = runtime.read().state!.phase;
        if (phase.type !== 'dealing') assert.fail();
        await runtime.dispatch({
          type: 'draw-card',
          id: id('command', randomUUID()),
          actorId: phase.nextSeatId,
        });
      });
      assert.equal(notices.at(-1)!.type, 'publication');
      await host.recover(member.lobbyId);
      const invalidated = notices.find((notice) => notice.type === 'invalidated');
      assert.equal(invalidated?.epoch, first.epoch);
      const baseline = notices.at(-1)!;
      if (baseline.type !== 'publication') assert.fail();
      assert.notEqual(baseline.epoch, first.epoch);
      assert.equal(baseline.publication.kind, 'initial');
      assert.deepEqual(baseline.publication.actions, []);
      stop();
      stop();
      const count = notices.length;
      await host.recover(member.lobbyId);
      assert.equal(notices.length, count);
    },
  );

  await t.test(
    'host listener and reporter failures cannot block commits, recovery or other subscriptions',
    async (t) => {
      const { host, member, request } = await setup(t);
      const seen: HostPublication[] = [];
      const stopBad = await host.subscribe(
        member.lobbyId,
        async () => {
          throw new Error('private listener failure');
        },
        () => {
          return Promise.reject(new Error('private reporter failure'));
        },
      );
      const stopGood = await host.subscribe(member.lobbyId, (notice) => {
        seen.push(notice);
      });
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        const phase = runtime.read().state!.phase;
        if (phase.type !== 'dealing') assert.fail();
        assert.equal(
          (
            await runtime.dispatch({
              type: 'draw-card',
              id: id('command', randomUUID()),
              actorId: phase.nextSeatId,
            })
          ).type,
          'accepted',
        );
      });
      await host.recover(member.lobbyId);
      assert.ok(seen.some((notice) => notice.type === 'invalidated'));
      assert.equal(seen.at(-1)!.type, 'publication');
      stopBad();
      stopGood();
    },
  );

  await t.test(
    'concurrent acquisition shares a writer and epoch; competing hosts respect its lease',
    async (t) => {
      const { host, member, request } = await setup(t);
      const views = await Promise.all(Array.from({ length: 8 }, () => host.read(member.lobbyId)));
      assert.equal(new Set(views.map((view) => view!.epoch)).size, 1);
      const other = new PostgresGameHost(pool);
      t.after(() => other.close());
      await assert.rejects(other.read(member.lobbyId), { message: 'game-unavailable' });
      await assert.rejects(
        host.withCurrent(member.lobbyId, id('game', 'wrong'), async () => assert.fail()),
        { message: 'wrong-game' },
      );
      assert.equal(views[0]!.snapshot.head.gameId, request.gameId);
      await host.close();
      const recovered = await other.read(member.lobbyId);
      assert.ok(recovered);
      assert.notEqual(recovered.epoch, views[0]!.epoch);
      assert.equal(recovered.snapshot.paused, true);
      await assert.rejects(host.read(member.lobbyId), { message: 'host-closed' });
    },
  );

  await t.test(
    'concurrent cold requests perform one restoration and share its baseline epoch',
    async (t) => {
      const { host, member } = await setup(t);
      await host.close();
      const other = new PostgresGameHost(pool);
      t.after(() => other.close());
      const views = await Promise.all(Array.from({ length: 12 }, () => other.read(member.lobbyId)));
      assert.equal(new Set(views.map((view) => view!.epoch)).size, 1);
      assert.equal(
        views[0]!.snapshot.controlEvents.filter((event) => event.type === 'runtime-restored')
          .length,
        1,
      );
      assert.deepEqual(
        views.map((view) => view!.snapshot.head),
        Array(12).fill(views[0]!.snapshot.head),
      );
    },
  );

  await t.test(
    'an aborted attachment queued behind other host work never enters the connection ledger',
    async (t) => {
      const context = await setup(t);
      const binding = await access.membership(context.owner.token, context.member.lobbyId, 1000);
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = context.host.withCurrent(
        context.member.lobbyId,
        context.request.gameId,
        async () => {
          entered();
          await gate;
        },
      );
      await waiting;
      const controller = new AbortController();
      const attachment = context.host.attach(binding, controller.signal);
      controller.abort();
      release();
      await blocked;
      await assert.rejects(attachment, { name: 'AbortError' });
      await context.leaveOwner();
      assert.equal(
        (await context.host.read(context.member.lobbyId))!.snapshot.paused,
        true,
        'no ghost connection remains after the original departs',
      );
    },
  );

  await t.test(
    'presence counts connections, ignores duplicate detach and reconnects only on transitions',
    async (t) => {
      const context = await setup(t);
      const { host, member, guest, leaveGuest } = context;
      const binding = await access.membership(guest.token, member.lobbyId, 1000);
      const leaveSecond = await host.attach(binding);
      const before = (await host.read(member.lobbyId))!.snapshot.controlEvents.length;
      await leaveGuest();
      await leaveGuest();
      assert.equal((await host.read(member.lobbyId))!.snapshot.paused, false);
      assert.equal((await host.read(member.lobbyId))!.snapshot.controlEvents.length, before);
      await leaveSecond();
      assert.equal((await host.read(member.lobbyId))!.snapshot.paused, true);
      const leaveNew = await host.attach(binding);
      await leaveSecond();
      assert.equal((await host.read(member.lobbyId))!.snapshot.paused, false);
      await leaveNew();
      assert.equal((await host.read(member.lobbyId))!.snapshot.paused, true);
    },
  );

  await t.test(
    'recovery restores durable receipts and a new baseline without replaying actions',
    async (t) => {
      const { host, member, request } = await setup(t);
      const before = (await host.read(member.lobbyId))!;
      const phase = before.snapshot.state!.phase;
      if (phase.type !== 'dealing') assert.fail();
      const command = {
        type: 'draw-card' as const,
        id: id('command', randomUUID()),
        actorId: phase.nextSeatId,
      };
      const accepted = await host.withCurrent(member.lobbyId, request.gameId, (runtime) =>
        runtime.dispatch(command),
      );
      assert.equal(accepted.type, 'accepted');
      await host.recover(member.lobbyId);
      const after = (await host.read(member.lobbyId))!;
      assert.notEqual(after.epoch, before.epoch);
      assert.equal(after.snapshot.paused, false, 'live ledger is reconciled after restore');
      const notices: number[] = [];
      await host.withCurrent(member.lobbyId, request.gameId, (runtime) =>
        runtime.subscribe((notice) => {
          notices.push(notice.actions.length);
        }),
      );
      const duplicate = await host.withCurrent(member.lobbyId, request.gameId, (runtime) =>
        runtime.dispatch(command),
      );
      assert.equal(duplicate.type, 'accepted');
      if (duplicate.type === 'accepted') assert.equal(duplicate.duplicate, true);
      assert.deepEqual(notices, [0]);
    },
  );

  await t.test(
    'faulted callbacks cannot poison current routing or evict a later epoch',
    async (t) => {
      const { host, member, request, reporters } = await setup(t);
      const before = (await host.read(member.lobbyId))!;
      // Simulate a scheduling failure through the real public runtime failure path.
      await assert.rejects(
        host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
          await runtime.dispatch({
            type: 'disconnect',
            id: id('command', randomUUID()),
            seatId: member.seatId,
          });
          await pool.query(
            'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1',
            [`penky-game:${request.gameId}`],
          );
          // Deliberately catch the dispatch failure: acquisition must detect the
          // poisoned runtime even when an integration callback swallowed its error.
          await runtime
            .dispatch({ type: 'reconnect', id: id('command', randomUUID()), seatId: member.seatId })
            .catch(() => {});
          throw new Error('callback failure');
        }),
      );
      const recovered = (await host.read(member.lobbyId))!;
      assert.notEqual(recovered.epoch, before.epoch);
      const oldReporter = reporters[0]!;
      oldReporter(new Error('late old clock failure'));
      assert.equal((await host.read(member.lobbyId))!.epoch, recovered.epoch);
    },
  );

  await t.test(
    'automatic acquisition detects a fault even if a callback swallowed its dispatch error',
    async (t) => {
      const { host, member, request } = await setup(t);
      const before = (await host.read(member.lobbyId))!;
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        await pool.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1',
          [`penky-game:${request.gameId}`],
        );
        await runtime
          .dispatch({ type: 'disconnect', id: id('command', randomUUID()), seatId: member.seatId })
          .catch(() => {});
      });
      assert.notEqual((await host.read(member.lobbyId))!.epoch, before.epoch);
    },
  );

  await t.test(
    'failed durable action is not published or retried and the draft is discarded',
    async (t) => {
      const { host, member, request } = await setup(t);
      const before = (await host.read(member.lobbyId))!;
      const phase = before.snapshot.state!.phase;
      if (phase.type !== 'dealing') assert.fail();
      const command = {
        type: 'draw-card' as const,
        id: id('command', randomUUID()),
        actorId: phase.nextSeatId,
      };
      const notices: number[] = [];
      await host.withCurrent(member.lobbyId, request.gameId, (runtime) =>
        runtime.subscribe((notice) => {
          notices.push(notice.actions.length);
        }),
      );
      await pool.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1',
        [`penky-game:${request.gameId}`],
      );
      await assert.rejects(
        host.withCurrent(member.lobbyId, request.gameId, (runtime) => runtime.dispatch(command)),
      );
      assert.deepEqual(notices, [0]);
      const after = (await host.read(member.lobbyId))!;
      assert.deepEqual(after.snapshot.state!.deck, before.snapshot.state!.deck);
      const stored = await PostgresSession.load(pool, request.gameId);
      assert.equal(
        stored!.checkpoint.receipts.some((receipt) => receipt.command.id === command.id),
        false,
      );
      const retry = await host.withCurrent(member.lobbyId, request.gameId, (runtime) =>
        runtime.dispatch(command),
      );
      assert.equal(retry.type, 'accepted');
      if (retry.type === 'accepted') assert.equal(retry.duplicate, false);
    },
  );

  await t.test(
    'failed detach lookup evicts stale presence while retaining the connection departure',
    async (t) => {
      const { host, member, leaveGuest } = await setup(t);
      const before = (await host.read(member.lobbyId))!;
      const query = pool.query;
      let fail = true;
      const mock = t.mock.method(pool, 'query', function (this: Pool, ...args: unknown[]) {
        if (fail && typeof args[0] === 'string' && args[0].includes('FROM penky_lobbies')) {
          fail = false;
          throw new Error('one-shot lookup failure');
        }
        return Reflect.apply(query, this, args);
      });
      await assert.rejects(leaveGuest());
      mock.mock.restore();
      const after = (await host.read(member.lobbyId))!;
      assert.notEqual(after.epoch, before.epoch);
      assert.equal(after.snapshot.paused, true);
      await leaveGuest();
      assert.equal((await host.read(member.lobbyId))!.snapshot.paused, true);
    },
  );

  await t.test(
    'deadline commit faults release the writer and recover without publishing the draft',
    async (t) => {
      const { host, clock, member, request } = await setup(t);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        for (let index = 0; index < 36; index++) {
          const phase = runtime.read().state!.phase;
          if (phase.type !== 'dealing') assert.fail();
          await runtime.dispatch({
            type: 'draw-card',
            id: id('command', randomUUID()),
            actorId: phase.nextSeatId,
          });
        }
      });
      const before = (await host.read(member.lobbyId))!;
      const notices: number[] = [];
      await host.withCurrent(member.lobbyId, request.gameId, (runtime) =>
        runtime.subscribe((notice) => {
          notices.push(notice.actions.length);
        }),
      );
      const remove = await failFrames(t, request.gameId);
      await clock.advanceBy(10000);
      await remove();
      // Do not touch the original host: automatic cleanup must release its live
      // backend/lease even though the runtime consumes the deadline rejection.
      const other = new PostgresGameHost(pool);
      t.after(() => other.close());
      const recovered = (await other.read(member.lobbyId))!;
      assert.notEqual(recovered.epoch, before.epoch);
      assert.equal(recovered.snapshot.state!.phase.type, 'trump-reveal');
      assert.deepEqual(notices, [0]);
    },
  );

  await t.test(
    'corrupt recovery releases acquisition resources and never creates a replacement game',
    async (t) => {
      const { host, member, request } = await setup(t);
      await host.close();
      const stored = await pool.query<{ checksum: string }>(
        'SELECT checksum FROM penky_game_frames WHERE game_id=$1 ORDER BY revision DESC LIMIT 1',
        [request.gameId],
      );
      await pool.query(
        "UPDATE penky_game_frames SET checksum='invalid' WHERE game_id=$1 AND revision=(SELECT revision FROM penky_game_heads WHERE game_id=$1)",
        [request.gameId],
      );
      const other = new PostgresGameHost(pool);
      t.after(() => other.close());
      await assert.rejects(other.read(member.lobbyId), { message: 'game-unavailable' });
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1',
            [`penky-game:${request.gameId}`],
          )
        ).rows[0].count,
        0,
      );
      await pool.query(
        'UPDATE penky_game_frames SET checksum=$2 WHERE game_id=$1 AND revision=(SELECT revision FROM penky_game_heads WHERE game_id=$1)',
        [request.gameId, stored.rows[0]!.checksum],
      );
      // Only the latest frame is read; repairing the deliberately damaged checksum
      // permits a later explicit attempt, not an automatic integrity-error retry.
      assert.equal((await other.read(member.lobbyId))!.snapshot.head.gameId, request.gameId);
    },
  );

  await t.test(
    'presence failure after restoration releases the lease and retains live connection intent',
    async (t) => {
      const { host, member, request, clock } = await setup(t);
      const remove = await failFrames(
        t,
        request.gameId,
        `jsonb_path_exists(NEW.payload, '$.checkpoint.connections[*] ? (@.connected == true)')`,
      );
      await assert.rejects(host.recover(member.lobbyId), { message: 'game-unavailable' });
      await remove();
      await writerExited(request.gameId);
      const other = new PostgresGameHost(pool, {
        inputs: () => ({
          clock,
          randomInt: (upper) => upper - 1,
          nextCommandId: () => id('command', randomUUID()),
        }),
      });
      t.after(() => other.close());
      assert.ok(await other.read(member.lobbyId), 'failed acquisition did not retain its lease');
      await other.close();
      assert.equal((await host.read(member.lobbyId))!.snapshot.paused, false);
    },
  );

  await t.test(
    'shutdown drains queued reads and releases every game even when a checkpoint fails',
    async (t) => {
      const first = await setup(t);
      const second = await setup(t);
      await first.host.close();
      await second.host.close();
      const host = new PostgresGameHost(pool);
      t.after(() => host.close().catch(() => {})); // this test deliberately faults close
      await host.read(first.member.lobbyId);
      await host.read(second.member.lobbyId);
      const remove = await failFrames(t, first.request.gameId);
      const queued = host.read(second.member.lobbyId);
      const closing = host.close();
      const rejected = assert.rejects(closing, { message: 'game-unavailable' });
      assert.ok(await queued);
      await rejected;
      assert.equal(host.close(), closing);
      await assert.rejects(host.read(first.member.lobbyId), { message: 'host-closed' });
      await remove();
      await writerExited(first.request.gameId);
      const other = new PostgresGameHost(pool);
      t.after(() => other.close());
      assert.ok(await other.read(first.member.lobbyId));
      assert.ok(await other.read(second.member.lobbyId));
    },
  );

  await t.test(
    'recovery preserves nested suspended timers and reconciles connected seats',
    async (t) => {
      const { host, clock, member, joined, request } = await setup(t);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        await runtime.dispatch({
          type: 'submit-claim',
          id: id('command', randomUUID()),
          actorId: member.seatId,
          accusedId: joined.seatId,
          reason: 'Spoken incident',
          incident: { type: 'spoken', key: 'episode' },
          scope: 'dealing',
          scopeNumber: 0,
        });
        await clock.advanceBy(4000);
        await runtime.dispatch({
          type: 'request-withdrawal',
          id: id('command', randomUUID()),
          actorId: member.seatId,
          claimId: runtime.read().state!.claims[0]!.claim.id,
        });
        await clock.advanceBy(1000);
        await runtime.checkpoint();
      });
      await host.recover(member.lobbyId);
      const procedure = (await host.read(member.lobbyId))!.snapshot.state!.procedure;
      if (procedure?.type !== 'withdrawal' || !procedure.suspendedVote) assert.fail();
      assert.equal(procedure.timer.remainingMs, 9000);
      assert.equal(procedure.suspendedVote.timer.remainingMs, 6000);
      assert.equal(procedure.suspendedVote.timer.startedAtMs, null);
      await clock.advanceBy(9000);
      assert.equal(
        (await host.read(member.lobbyId))!.snapshot.state!.procedure?.type,
        'claim-vote',
      );
    },
  );

  await t.test(
    'atomic successor is adopted without another lease; old routing and stale bindings fail',
    async (t) => {
      const { host, clock, member, request, guest } = await setup(t);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        for (let index = 0; index < 36; index++) {
          const phase = runtime.read().state!.phase;
          if (phase.type !== 'dealing') assert.fail();
          await runtime.dispatch({
            type: 'draw-card',
            id: id('command', randomUUID()),
            actorId: phase.nextSeatId,
          });
        }
        await clock.advanceBy(10000);
        await finishMatch(runtime);
      });
      const old = (await host.read(member.lobbyId))!;
      const newcomer = await access.issue(1000);
      const newBinding = await access.joinLobby(newcomer.token, member.lobbyId, 1000);
      const leaveNewcomer = await host.attach(newBinding);
      assert.equal(
        (await host.read(member.lobbyId))!.snapshot.connections.length,
        2,
        'lobby membership does not add a participant to an old match',
      );
      const stale = await access.membership(guest.token, member.lobbyId, 1000);
      const next: MatchStart = {
        ...request,
        id: id('command', randomUUID()),
        expectedGameId: request.gameId,
        expectedHead: old.snapshot.head,
        gameId: id('game', randomUUID()),
        branchId: id('branch', randomUUID()),
        seatIds: newBinding.seatIds,
      };
      const remove = await failFrames(t, request.gameId);
      await assert.rejects(host.startMatch(member.lobbyId, next), { message: 'game-unavailable' });
      await remove();
      assert.equal(
        (
          await pool.query('SELECT current_game_id FROM penky_lobbies WHERE lobby_id=$1', [
            member.lobbyId,
          ])
        ).rows[0].current_game_id,
        request.gameId,
      );
      assert.equal(
        (await pool.query('SELECT 1 FROM penky_game_heads WHERE game_id=$1', [next.gameId]))
          .rowCount,
        0,
        'failed preparation is not adopted or persisted',
      );
      const restored = (await host.read(member.lobbyId))!;
      assert.notEqual(restored.epoch, old.epoch);
      const retry = { ...next, expectedHead: restored.snapshot.head };
      assert.equal((await host.startMatch(member.lobbyId, retry)).type, 'started');
      const current = (await host.read(member.lobbyId))!;
      assert.equal(current.snapshot.head.gameId, next.gameId);
      assert.notEqual(current.epoch, old.epoch);
      assert.equal(current.snapshot.paused, false);
      await assert.rejects(
        host.withCurrent(member.lobbyId, request.gameId, async () => assert.fail()),
        { message: 'wrong-game' },
      );
      await assert.rejects(host.attach(stale), { message: 'wrong-game' });
      assert.equal((await host.startMatch(member.lobbyId, retry)).type, 'duplicate');
      assert.equal(current.snapshot.connections.length, 3);
      await leaveNewcomer();
      assert.equal((await host.read(member.lobbyId))!.snapshot.paused, true);
    },
  );
});
