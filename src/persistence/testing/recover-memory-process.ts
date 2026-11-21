import { Pool } from 'pg';
import { id } from '../../game/ids.ts';
import { GameRuntime } from '../../runtime/runtime.ts';
import { systemInputs } from '../../runtime/system.ts';
import { PostgresSession } from '../postgres.ts';
const pool = new Pool({ connectionString: process.env.PENKY_TEST_DATABASE_URL });
const session = await PostgresSession.open(
  pool,
  id('game', process.env.PENKY_RECOVERY_GAME_ID!),
  id('branch', 'main'),
);
try {
  const runtime = await GameRuntime.restore(
    {
      ...systemInputs(() => {}),
      history: session.history,
      connectedSeatIds: [],
      commit: session.commit,
    },
    session.checkpoint!,
  );
  try {
    const checkpoint = await runtime.checkpoint();
    if (checkpoint.schemaVersion !== 2) throw new Error('Expected memory checkpoint');
    process.stdout.write(JSON.stringify(checkpoint.botMemory));
  } finally {
    await runtime.dispose();
  }
} finally {
  await session.close();
  await pool.end();
}
