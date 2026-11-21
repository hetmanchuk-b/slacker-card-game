import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { id } from '../game/ids.ts';
import { GameRuntime } from '../runtime/runtime.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import { migrate, PostgresSession } from './postgres.ts';

const url = process.env.PENKY_TEST_DATABASE_URL;
test(
  'PostgreSQL permitted memory survives fresh process, retries and rollback without archive observations',
  { skip: !url },
  async () => {
    const pool = new Pool({ connectionString: url });
    const gameId = id('game', randomUUID());
    const source = fixture('vote', 2, gameId);
    await migrate(pool);
    let session = await PostgresSession.open(pool, gameId, id('branch', 'main'));
    for (const action of source.history.read().actions)
      session.history.append(session.history.read().head, action);
    let runtime = await GameRuntime.create({
      ...source.options,
      history: session.history,
      commit: session.commit,
    });
    try {
      const command = {
        type: 'cast-vote' as const,
        id: id('command', 'memory-ballot'),
        actorId: source.seats[0]!,
        procedureId: runtime.read().state!.procedure!.timer.id,
        vote: 'no' as const,
      };
      await runtime.dispatch(command);
      const frame = await runtime.checkpoint();
      assert.equal(frame.schemaVersion, 2);
      if (frame.schemaVersion !== 2) assert.fail();
      const before = frame.botMemory;
      await runtime.dispatch(command);
      const duplicate = await runtime.checkpoint();
      if (duplicate.schemaVersion !== 2) assert.fail();
      assert.deepEqual(duplicate.botMemory, before);
      await runtime.dispose();
      await session.close();
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [fileURLToPath(new URL('./testing/recover-memory-process.ts', import.meta.url))],
        { env: { ...process.env, PENKY_RECOVERY_GAME_ID: gameId } },
      );
      const restored = JSON.parse(stdout) as typeof before;
      assert.deepEqual(
        restored.current.map((m) => m.trump),
        before.current.map((m) => m.trump),
      );
      assert.deepEqual(
        restored.beforeCommands.slice(0, before.beforeCommands.length),
        before.beforeCommands,
      );
      session = await PostgresSession.open(pool, gameId, id('branch', 'main'));
      runtime = await GameRuntime.restore(
        {
          ...source.options,
          clock: { ...source.clock, now: () => Date.now(), scheduleAt: () => () => {} },
          history: session.history,
          commit: session.commit,
        },
        session.checkpoint!,
      );
      const headBeforeControl = runtime.read().head;
      await runtime.dispatch({
        type: 'disconnect',
        id: id('command', 'same-head-control'),
        seatId: source.seats[0]!,
      });
      assert.deepEqual(runtime.read().head, headBeforeControl);
      const control = await runtime.checkpoint();
      if (control.schemaVersion !== 2) assert.fail();
      const storedControl = (await PostgresSession.load(pool, gameId))!.checkpoint;
      if (storedControl.schemaVersion !== 2) assert.fail();
      assert.deepEqual(storedControl.botMemory, control.botMemory);
      await runtime.dispatch({
        type: 'rollback',
        id: id('command', 'memory-fork'),
        actorId: source.seats[0]!,
        expected: runtime.read().head,
        beforeCommandId: command.id,
        knowledgeWarningAcknowledged: true,
      });
      const fork = await runtime.checkpoint();
      if (fork.schemaVersion !== 2) assert.fail();
      assert.ok(fork.botMemory.current.every((m) => m.trump === null));
      const durable = (await PostgresSession.load(pool, gameId))!.checkpoint;
      if (durable.schemaVersion !== 2) assert.fail();
      assert.deepEqual(durable.botMemory, fork.botMemory);
    } finally {
      await runtime.dispose();
      await session.close();
      await pool.end();
    }
  },
);

test(
  'PostgreSQL fresh-process reveal memory is restored exactly; legacy missing memory stays unknown',
  { skip: !url },
  async () => {
    const pool = new Pool({ connectionString: url });
    try {
      await migrate(pool);
      for (const legacy of [false, true]) {
        const gameId = id('game', randomUUID());
        const source = fixture('reveal', 2, gameId);
        const session = await PostgresSession.open(pool, gameId, id('branch', 'main'));
        let runtime: GameRuntime | undefined;
        try {
          for (const action of source.history.read().actions)
            session.history.append(session.history.read().head, action);
          runtime = await GameRuntime.create({
            ...source.options,
            history: session.history,
            commit: session.commit,
          });
          const frame = await runtime.checkpoint();
          if (frame.schemaVersion !== 2) assert.fail();
          assert.ok(frame.botMemory.current.every((m) => m.trump));
          if (legacy) {
            const { botMemory, ...base } = frame;
            assert.ok(botMemory);
            await session.commit({ ...base, schemaVersion: 1 });
          }
          await runtime.dispose();
          await session.close();
          const { stdout } = await promisify(execFile)(
            process.execPath,
            [fileURLToPath(new URL('./testing/recover-memory-process.ts', import.meta.url))],
            { env: { ...process.env, PENKY_RECOVERY_GAME_ID: gameId } },
          );
          const restored = JSON.parse(stdout) as typeof frame.botMemory;
          assert.deepEqual(
            restored.current.map((m) => m.trump),
            legacy ? [null, null] : frame.botMemory.current.map((m) => m.trump),
          );
        } finally {
          await runtime?.dispose();
          await session.close();
        }
      }
    } finally {
      await pool.end();
    }
  },
);
