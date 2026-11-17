import { Pool } from 'pg';
import { migrate } from '../postgres.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('Set DATABASE_URL before running migrations');
const pool = new Pool({ connectionString, connectionTimeoutMillis: 10000 });
pool.on('error', () => {
  process.exitCode = 1;
});
try {
  await migrate(pool);
  console.log('Database migrations complete');
} finally {
  await pool.end();
}
