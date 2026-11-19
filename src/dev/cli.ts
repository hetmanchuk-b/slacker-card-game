import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { startBrowserDevServer } from './server.ts';

async function main() {
  const database = process.env.DATABASE_URL;
  const keyPath = process.env.PENKY_DEV_TLS_KEY;
  const certPath = process.env.PENKY_DEV_TLS_CERT;
  const caPath = process.env.PENKY_DEV_TLS_CA;
  const rawPort = process.env.PENKY_DEV_PORT ?? '5173';
  if (
    !database ||
    !keyPath ||
    !certPath ||
    !/^[1-9]\d{0,4}$/.test(rawPort) ||
    Number(rawPort) > 65535
  )
    throw new Error(
      'Set DATABASE_URL, PENKY_DEV_TLS_KEY, PENKY_DEV_TLS_CERT and a valid optional PENKY_DEV_PORT',
    );
  const [key, cert, ca] = await Promise.all([
    readFile(keyPath),
    readFile(certPath),
    caPath ? readFile(caPath) : Promise.resolve(undefined),
  ]);
  const pool = new Pool({
    connectionString: database,
    max: 10,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
  });
  pool.on('error', () => {
    console.error('Development database unavailable');
  });
  try {
    // Explicit migrations remain a separate operator action; never run DDL here.
    const server = await startBrowserDevServer({
      pool,
      tls: { key, cert },
      port: Number(rawPort),
      ...(ca ? { ca } : {}),
    });
    console.log(`Penky development browser: ${server.origin}`);
    let closing = false;
    const stop = async () => {
      if (closing) return;
      closing = true;
      try {
        await server.close();
      } finally {
        await pool.end();
      }
    };
    const onSignal = () => {
      void stop().catch(() => {
        console.error('Development shutdown failed');
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  } catch (error) {
    await pool.end();
    throw error;
  }
}
void main().catch(() => {
  console.error(
    'Development startup failed. Check database configuration, explicit migrations and local TLS files.',
  );
  process.exitCode = 1;
});
