import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Pool } from 'pg';
import { id } from '../game/ids.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import { GameRuntime } from '../runtime/runtime.ts';
import { finishMatch } from '../runtime/testing/match.ts';
import { PostgresSession, migrate } from './postgres.ts';
import { MemoryHistory } from './memory-history.ts';

const url = process.env.PENKY_TEST_DATABASE_URL;
test('PostgreSQL durable runtime', { skip: !url }, async (t) => {
  assert.ok(new URL(url!).pathname.endsWith('_test'), 'Use a dedicated *_test database');
  const pool = new Pool({ connectionString: url, max: 6, connectionTimeoutMillis: 3000 });
  pool.on('error', () => {});
  t.after(() => pool.end());
  await migrate(pool);
  await migrate(pool);
  await t.test(
    'command receipts and remaining time survive a fresh PostgreSQL session',
    async (t) => {
      const gameId = id('game', randomUUID());
      const source = fixture('vote', 4, gameId);
      const session = await PostgresSession.open(pool, gameId, id('branch', 'main'));
      for (const action of source.history.read().actions)
        session.history.append(session.history.read().head, action);
      const options = { ...source.options, history: session.history, commit: session.commit };
      const runtime = await GameRuntime.create(options);
      t.after(async () => {
        await runtime.dispose();
        await session.close();
      });
      await source.clock.advanceBy(4000);
      const ballot = {
        type: 'cast-vote' as const,
        id: id('command', 'ballot'),
        actorId: source.seats[0]!,
        procedureId: runtime.read().state!.procedure!.timer.id,
        vote: 'yes' as const,
      };
      assert.equal((await runtime.dispatch(ballot)).type, 'accepted');
      const state = runtime.read().state;
      await runtime.dispose();
      await session.close();
      await source.clock.advanceBy(30000);
      const reopened = await PostgresSession.open(pool, gameId, id('branch', 'main'));
      assert.deepEqual(reopened.history.read().state, state);
      const original = source.history.read();
      assert.equal(
        reopened.history.append({ ...original.head, version: 0 }, original.actions[0]!).type,
        'duplicate',
      );
      assert.ok(reopened.checkpoint);
      t.after(() => reopened.close());
      const recovered = await GameRuntime.restore(
        { ...options, history: reopened.history, commit: reopened.commit },
        reopened.checkpoint!,
      );
      t.after(() => recovered.dispose());
      assert.equal(recovered.read().state?.procedure?.timer.remainingMs, 6000);
      const retry = await recovered.dispatch(ballot);
      assert.equal(retry.type, 'accepted');
      if (retry.type === 'accepted') assert.equal(retry.duplicate, true);
      await recovered.dispose();
      await reopened.close();
    },
  );

  await t.test(
    'only one writer can own a game and immutable committed revisions remain readable',
    async (t) => {
      const gameId = id('game', randomUUID());
      const source = fixture('vote', 4, gameId);
      const session = await PostgresSession.open(pool, gameId, id('branch', 'main'));
      t.after(() => session.close());
      for (const action of source.history.read().actions)
        session.history.append(session.history.read().head, action);
      const runtime = await GameRuntime.create({
        ...source.options,
        history: session.history,
        commit: session.commit,
      });
      t.after(() => runtime.dispose());
      await assert.rejects(
        PostgresSession.open(pool, gameId, id('branch', 'main')).then((unexpected) =>
          unexpected.close(),
        ),
        /already has a writer/,
      );
      const first = await PostgresSession.load(pool, gameId, '1');
      assert.ok(first);
      await runtime.dispatch({
        type: 'cast-vote',
        id: id('command', 'ballot'),
        actorId: source.seats[0]!,
        procedureId: runtime.read().state!.procedure!.timer.id,
        vote: 'yes',
      });
      assert.deepEqual(await PostgresSession.load(pool, gameId, '1'), first);
      assert.notDeepEqual((await PostgresSession.load(pool, gameId))?.snapshot, first.snapshot);
      await runtime.dispose();
      await session.close();
      const reopened = await PostgresSession.open(pool, gameId, id('branch', 'main'));
      t.after(() => reopened.close());
      assert.deepEqual(
        reopened.history.read(),
        (await PostgresSession.load(pool, gameId))?.snapshot,
      );
    },
  );

  await t.test(
    'rollback branches and audit recover together with their rebased timer',
    async (t) => {
      const gameId = id('game', randomUUID());
      const source = fixture('withdrawal', 2, gameId);
      const session = await PostgresSession.open(pool, gameId, id('branch', 'main'));
      t.after(() => session.close());
      for (const action of source.history.read().actions)
        session.history.append(session.history.read().head, action);
      const runtime = await GameRuntime.create({
        ...source.options,
        history: session.history,
        commit: session.commit,
      });
      t.after(() => runtime.dispose());
      await source.clock.advanceBy(20000);
      const abandoned = session.history.read();
      const rollback = {
        type: 'rollback' as const,
        id: id('command', 'rollback'),
        actorId: source.seats[0]!,
        expected: abandoned.head,
        beforeCommandId: id('command', 'withdraw'),
        knowledgeWarningAcknowledged: true,
      };
      assert.equal((await runtime.dispatch(rollback)).type, 'accepted');
      const fork = runtime.read();
      await runtime.dispose();
      await session.close();
      await source.clock.advanceBy(30000);
      const reopened = await PostgresSession.open(pool, gameId, id('branch', 'main'));
      t.after(() => reopened.close());
      assert.deepEqual(reopened.history.read(abandoned.head.branchId), abandoned);
      assert.equal(reopened.history.audit().length, 1);
      assert.deepEqual(reopened.history.read().state, fork.state);
      const restored = await GameRuntime.restore(
        { ...source.options, history: reopened.history, commit: reopened.commit },
        reopened.checkpoint!,
      );
      t.after(() => restored.dispose());
      assert.equal(restored.read().state?.procedure?.timer.remainingMs, 6000);
      const retry = await restored.dispatch(rollback);
      assert.equal(retry.type, 'accepted');
      if (retry.type === 'accepted') assert.equal(retry.duplicate, true);
      assert.equal(reopened.history.audit().length, 1);
    },
  );

  await t.test(
    'a failed frame insert rolls back the head and never acknowledges a partial command',
    async (t) => {
      const gameId = id('game', randomUUID());
      const source = fixture('vote', 4, gameId);
      const session = await PostgresSession.open(pool, gameId, id('branch', 'main'));
      t.after(() => session.close());
      for (const action of source.history.read().actions)
        session.history.append(session.history.read().head, action);
      const runtime = await GameRuntime.create({
        ...source.options,
        history: session.history,
        commit: session.commit,
      });
      t.after(() => runtime.dispose());
      const before = await PostgresSession.load(pool, gameId);
      const functionName = `penky_fail_${randomUUID().replaceAll('-', '')}`;
      // External fault injection into this test game's INSERT, not a storage implementation mock.
      await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.game_id = '${gameId}' THEN RAISE EXCEPTION 'injected storage failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER ${functionName} BEFORE INSERT ON penky_game_frames FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      t.after(() =>
        pool.query(
          `DROP TRIGGER IF EXISTS ${functionName} ON penky_game_frames; DROP FUNCTION IF EXISTS ${functionName}()`,
        ),
      );
      await assert.rejects(
        runtime.dispatch({
          type: 'cast-vote',
          id: id('command', 'ballot'),
          actorId: source.seats[0]!,
          procedureId: runtime.read().state!.procedure!.timer.id,
          vote: 'yes',
        }),
        /injected storage failure/,
      );
      assert.throws(() => runtime.read(), /Runtime scheduling failed/);
      assert.deepEqual(await PostgresSession.load(pool, gameId), before);
      await runtime.dispose();
      await session.close();
      const recovered = await PostgresSession.open(pool, gameId, id('branch', 'main'));
      t.after(() => recovered.close());
      assert.deepEqual(recovered.history.read(), before!.snapshot);
    },
  );

  await t.test(
    'replacement deadlines and controller changes persist independently of paused gameplay',
    async (t) => {
      const gameId = id('game', randomUUID());
      const source = fixture('vote', 3, gameId);
      const session = await PostgresSession.open(pool, gameId, id('branch', 'main'));
      t.after(() => session.close());
      for (const action of source.history.read().actions)
        session.history.append(session.history.read().head, action);
      const runtime = await GameRuntime.create({
        ...source.options,
        history: session.history,
        commit: session.commit,
      });
      t.after(() => runtime.dispose());
      await runtime.dispatch({
        type: 'disconnect',
        id: id('command', 'leave'),
        seatId: source.seats[1]!,
      });
      await source.clock.advanceBy(30001);
      await runtime.dispatch({
        type: 'propose-bot',
        id: id('command', 'replace'),
        actorId: source.seats[0]!,
        seatId: source.seats[1]!,
      });
      await runtime.dispatch({
        type: 'replacement-vote',
        id: id('command', 'yes'),
        actorId: source.seats[0]!,
        procedureId: runtime.read().replacementVote!.timer.id,
        vote: 'yes',
      });
      await runtime.dispose();
      await session.close();
      await source.clock.advanceBy(10000);
      const reopened = await PostgresSession.open(pool, gameId, id('branch', 'main'));
      t.after(() => reopened.close());
      const recovered = await GameRuntime.restore(
        { ...source.options, history: reopened.history, commit: reopened.commit },
        reopened.checkpoint!,
      );
      t.after(() => recovered.dispose());
      await source.clock.advanceBy(0);
      assert.equal(recovered.read().connections[1]?.controller, 'bot');
      assert.equal(recovered.read().paused, true);
      assert.equal(recovered.read().state?.procedure?.timer.remainingMs, 10000);
      assert.equal(
        (await PostgresSession.load(pool, gameId))?.checkpoint.connections[1]?.controller,
        'bot',
      );
    },
  );

  await t.test(
    'snapshot loading and full journal replay recover identical durable branches and metadata',
    async (t) => {
      const gameId = id('game', randomUUID());
      const source = fixture('withdrawal', 2, gameId);
      const session = await PostgresSession.open(pool, gameId, id('branch', 'main'));
      t.after(() => session.close());
      for (const action of source.history.read().actions)
        session.history.append(session.history.read().head, action);
      const runtime = await GameRuntime.create({
        ...source.options,
        history: session.history,
        commit: session.commit,
      });
      t.after(() => runtime.dispose());
      await source.clock.advanceBy(20000);
      await runtime.dispatch({
        type: 'rollback',
        id: id('command', 'rollback'),
        actorId: source.seats[0]!,
        expected: session.history.read().head,
        beforeCommandId: id('command', 'withdraw'),
        knowledgeWarningAcknowledged: true,
      });
      const stored = await PostgresSession.load(pool, gameId);
      assert.ok(stored?.cache);
      await runtime.dispose();
      await session.close();
      const fast = await PostgresSession.open(pool, gameId, id('branch', 'main'));
      t.after(() => fast.close());
      const fastArchive = fast.history.archive();
      const fastCache = fast.history.snapshot();
      await fast.close();
      const replayed = await PostgresSession.open(pool, gameId, id('branch', 'main'), {
        recovery: 'replay',
      });
      t.after(() => replayed.close());
      assert.deepEqual(replayed.history.archive(), fastArchive);
      assert.deepEqual(replayed.history.snapshot(), fastCache);
    },
  );

  await t.test(
    'a new Node process recovers from PostgreSQL without any old in-memory objects',
    async (t) => {
      const gameId = id('game', randomUUID());
      const source = fixture('vote', 4, gameId);
      const session = await PostgresSession.open(pool, gameId, id('branch', 'main'));
      t.after(() => session.close());
      for (const action of source.history.read().actions)
        session.history.append(session.history.read().head, action);
      const runtime = await GameRuntime.create({
        ...source.options,
        history: session.history,
        commit: session.commit,
      });
      t.after(() => runtime.dispose());
      await source.clock.advanceBy(4000);
      await runtime.checkpoint();
      await runtime.dispose();
      await session.close();
      const child = await promisify(execFile)(
        process.execPath,
        [fileURLToPath(new URL('./testing/recover-process.ts', import.meta.url))],
        { env: { ...process.env, PENKY_RECOVERY_GAME_ID: gameId }, timeout: 15000 },
      );
      assert.deepEqual(JSON.parse(child.stdout), {
        remainingMs: 6000,
        paused: true,
        allDisconnected: true,
      });
    },
  );

  await t.test(
    'completed matches and rollback-window closure survive durable recovery',
    async (t) => {
      const gameId = id('game', randomUUID());
      const source = fixture('reveal', 2, gameId);
      const session = await PostgresSession.open(pool, gameId, id('branch', 'main'));
      t.after(() => session.close());
      for (const action of source.history.read().actions)
        session.history.append(session.history.read().head, action);
      const runtime = await GameRuntime.create({
        ...source.options,
        history: session.history,
        commit: session.commit,
      });
      t.after(() => runtime.dispose());
      await source.clock.advanceBy(10000);
      await finishMatch(runtime);
      for (const revision of ['2', '3']) {
        const frame = await PostgresSession.load(pool, gameId, revision);
        assert.ok(frame?.cache);
        assert.deepEqual(
          MemoryHistory.restoreSnapshot(frame.history, frame.cache).read(),
          MemoryHistory.restore(frame.history).read(),
        );
      }
      const finished = session.history.read();
      assert.equal(await runtime.closeForNextMatch(), true);
      await runtime.dispose();
      await session.close();
      const reopened = await PostgresSession.open(pool, gameId, id('branch', 'main'));
      t.after(() => reopened.close());
      assert.deepEqual(reopened.history.read(), finished);
      const recovered = await GameRuntime.restore(
        { ...source.options, history: reopened.history, commit: reopened.commit },
        reopened.checkpoint!,
      );
      t.after(() => recovered.dispose());
      await recovered.dispatch({
        type: 'reconnect',
        id: id('command', 'owner-return'),
        seatId: source.seats[0]!,
      });
      const result = await recovered.dispatch({
        type: 'rollback',
        id: id('command', 'too-late'),
        actorId: source.seats[0]!,
        expected: recovered.read().head,
        beforeCommandId: finished.actions.at(-1)!.commandId,
        knowledgeWarningAcknowledged: true,
      });
      assert.equal(result.type, 'rejected');
      if (result.type === 'rejected') assert.equal(result.code, 'rollback-closed');
    },
  );

  await t.test(
    'recorded random dealing outcomes recover without rerunning randomness',
    async (t) => {
      const gameId = id('game', randomUUID());
      const source = fixture('penalty', 2, gameId);
      const session = await PostgresSession.open(pool, gameId, id('branch', 'main'));
      t.after(() => session.close());
      for (const action of source.history.read().actions)
        session.history.append(session.history.read().head, action);
      const runtime = await GameRuntime.create({
        ...source.options,
        history: session.history,
        commit: session.commit,
      });
      t.after(() => runtime.dispose());
      await source.clock.advanceBy(4000);
      await runtime.checkpoint();
      const before = session.history.read();
      await runtime.dispose();
      await session.close();
      const reopened = await PostgresSession.open(pool, gameId, id('branch', 'main'));
      t.after(() => reopened.close());
      assert.deepEqual(reopened.history.read(), before);
      const recovered = await GameRuntime.restore(
        {
          ...source.options,
          history: reopened.history,
          commit: reopened.commit,
          randomInt: () => {
            throw new Error('Unexpected reroll');
          },
        },
        reopened.checkpoint!,
      );
      t.after(() => recovered.dispose());
      assert.deepEqual(recovered.read().state?.players, before.state?.players);
      assert.equal(recovered.read().state?.procedure?.type, 'penalty');
      assert.equal(recovered.read().state?.procedure?.timer.remainingMs, 6000);
    },
  );

  await t.test(
    'a lost database connection cannot silently reconnect and keep writing under an old lease',
    async (t) => {
      const gameId = id('game', randomUUID());
      const source = fixture('vote', 4, gameId);
      const session = await PostgresSession.open(pool, gameId, id('branch', 'main'));
      t.after(() => session.close());
      for (const action of source.history.read().actions)
        session.history.append(session.history.read().head, action);
      const runtime = await GameRuntime.create({
        ...source.options,
        history: session.history,
        commit: session.commit,
      });
      t.after(() => runtime.dispose());
      const before = await PostgresSession.load(pool, gameId);
      const timerId = runtime.read().state!.procedure!.timer.id;
      // System-boundary fault injection in this dedicated test database only.
      await pool.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1 AND pid <> pg_backend_pid()',
        [`penky-game:${gameId}`],
      );
      await assert.rejects(
        runtime.dispatch({
          type: 'cast-vote',
          id: id('command', 'after-loss'),
          actorId: source.seats[0]!,
          procedureId: timerId,
          vote: 'yes',
        }),
        /unavailable|connection|terminat/i,
      );
      assert.throws(() => runtime.read(), /Runtime scheduling failed/);
      await runtime.dispose();
      await session.close();
      const reopened = await PostgresSession.open(pool, gameId, id('branch', 'main'));
      t.after(() => reopened.close());
      assert.deepEqual(reopened.history.read(), before!.snapshot);
    },
  );

  await t.test(
    'optimistic revisions reject a writer whose durable head changed outside its lease',
    async (t) => {
      const gameId = id('game', randomUUID());
      const source = fixture('vote', 4, gameId);
      const session = await PostgresSession.open(pool, gameId, id('branch', 'main'));
      t.after(() => session.close());
      for (const action of source.history.read().actions)
        session.history.append(session.history.read().head, action);
      const runtime = await GameRuntime.create({
        ...source.options,
        history: session.history,
        commit: session.commit,
      });
      t.after(() => runtime.dispose());
      const before = await PostgresSession.load(pool, gameId);
      await pool.query('UPDATE penky_game_heads SET revision = revision + 1 WHERE game_id = $1', [
        gameId,
      ]);
      t.after(() =>
        pool.query('UPDATE penky_game_heads SET revision = 1 WHERE game_id = $1', [gameId]),
      );
      await assert.rejects(
        runtime.dispatch({
          type: 'cast-vote',
          id: id('command', 'stale'),
          actorId: source.seats[0]!,
          procedureId: runtime.read().state!.procedure!.timer.id,
          vote: 'yes',
        }),
        /revision conflict/,
      );
      assert.deepEqual(await PostgresSession.load(pool, gameId, '1'), before);
    },
  );

  await t.test(
    'head metadata corruption is rejected even when the frame checksum remains valid',
    async (t) => {
      const gameId = id('game', randomUUID());
      const session = await PostgresSession.open(pool, gameId, id('branch', 'main'));
      t.after(() => session.close());
      const source = fixture('vote', 2, gameId);
      for (const action of source.history.read().actions)
        session.history.append(session.history.read().head, action);
      const runtime = await GameRuntime.create({
        ...source.options,
        history: session.history,
        commit: session.commit,
      });
      await runtime.dispose();
      await session.close();
      await pool.query(
        'UPDATE penky_game_heads SET head_version = head_version + 1 WHERE game_id = $1',
        [gameId],
      );
      await assert.rejects(
        PostgresSession.open(pool, gameId, id('branch', 'main')).then((unexpected) =>
          unexpected.close(),
        ),
        /snapshot disagrees/,
      );
    },
  );

  await t.test(
    'corrupt or unknown-version stored frames are rejected before recovery',
    async (t) => {
      const gameId = id('game', randomUUID());
      const source = fixture('vote', 2, gameId);
      const session = await PostgresSession.open(pool, gameId, id('branch', 'main'));
      t.after(() => session.close());
      for (const action of source.history.read().actions)
        session.history.append(session.history.read().head, action);
      const runtime = await GameRuntime.create({
        ...source.options,
        history: session.history,
        commit: session.commit,
      });
      await runtime.dispose();
      await session.close();
      await pool.query(
        "UPDATE penky_game_frames SET payload = jsonb_set(payload, '{schemaVersion}', '999') WHERE game_id = $1",
        [gameId],
      );
      await assert.rejects(
        PostgresSession.open(pool, gameId, id('branch', 'main')).then((unexpected) =>
          unexpected.close(),
        ),
        /Invalid stored game frame/,
      );
    },
  );
});
