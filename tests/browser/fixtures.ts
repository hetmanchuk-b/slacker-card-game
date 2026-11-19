import { test as base } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { migrate } from '../../src/persistence/postgres.ts';
import { startBrowserDevServer } from '../../src/dev/server.ts';

const tls = {
  key: readFileSync(new URL('../../src/server/testing/localhost-key.pem', import.meta.url)),
  cert: readFileSync(new URL('../../src/server/testing/localhost-cert.pem', import.meta.url)),
};
export const test = base.extend<{ pool: Pool; origin: string; wall: { now: number } }>({
  wall: async ({ browserName: _browserName }, use) => {
    await use({ now: Date.now() });
  },
  pool: async ({ browserName: _browserName }, use) => {
    const pool = new Pool({
      connectionString: process.env.PENKY_TEST_DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });
    pool.on('error', () => {});
    try {
      await migrate(pool);
      await use(pool);
    } finally {
      await pool.end();
    }
  },
  origin: async ({ wall, pool }, use) => {
    const server = await startBrowserDevServer({ pool, tls, port: 0, now: () => wall.now });
    try {
      await use(server.origin);
    } finally {
      await server.close();
    }
  },
});
