import { Pool } from 'pg';
import { id } from '../../game/ids.ts';
import { GameRuntime } from '../../runtime/runtime.ts';
import { systemInputs } from '../../runtime/system.ts';
import { PostgresSession } from '../postgres.ts';

const connectionString = process.env.PENKY_TEST_DATABASE_URL;
const gameId = process.env.PENKY_RECOVERY_GAME_ID;
if (!connectionString || !gameId) throw new Error('Recovery test environment is missing');
const pool = new Pool({ connectionString, connectionTimeoutMillis: 3000 });
pool.on('error', () => {});
const session = await PostgresSession.open(pool, id('game', gameId), id('branch', 'main'));
try {
  if (!session.checkpoint) throw new Error('Missing recovery checkpoint');
  const runtime = await GameRuntime.restore(
    {
      ...systemInputs(() => {}),
      history: session.history,
      connectedSeatIds: [],
      commit: session.commit,
    },
    session.checkpoint,
  );
  try {
    const snapshot = runtime.read();
    process.stdout.write(
      JSON.stringify({
        remainingMs: snapshot.state?.procedure?.timer.remainingMs,
        paused: snapshot.paused,
        allDisconnected: snapshot.connections.every((seat) => !seat.connected),
      }),
    );
  } finally {
    await runtime.dispose();
  }
} finally {
  await session.close();
  await pool.end();
}
