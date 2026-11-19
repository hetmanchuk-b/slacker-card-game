import { Agent, createServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import type { ViteDevServer } from 'vite';
import type { Pool } from 'pg';
import { PostgresGameHost } from '../server/game-host.ts';
import { PostgresGuestAccess } from '../server/guest-access.ts';
import { PenkyTransport } from '../server/transport.ts';
import clientConfig, { clientRoot } from '../../vite.config.ts';

type Options = Readonly<{
  pool: Pool;
  tls: Readonly<{ key: Buffer | string; cert: Buffer | string }>;
  /** CA for the TLS upstream; defaults to the local self-signed certificate. */
  ca?: Buffer | string;
  port?: number;
  /** Existing server clock seam for deterministic browser tests, never a client input. */
  now?: () => number;
}>;

/** Loopback-only development/test composition, not a production proxy mode.
 * Browser -> HTTPS Vite front door -> certificate-verified HTTPS transport.
 * Origin/cookies are preserved, never rewritten into identity or proxy trust.
 * Caller owns pool and explicitly runs migrations before use.
 */
export async function startBrowserDevServer(options: Options) {
  const port = options.port ?? 5173;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error('Invalid development port');
  let handler = (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(503).end();
  };
  const front = createServer(
    { ...options.tls, minVersion: 'TLSv1.2', maxHeaderSize: 16384 },
    (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      handler(req, res);
    },
  );
  front.headersTimeout = 5000;
  front.requestTimeout = 10000;
  const host = new PostgresGameHost(options.pool);
  const agent = new Agent({ ca: options.ca ?? options.tls.cert });
  let transport: PenkyTransport | undefined;
  let vite: ViteDevServer | undefined;
  let closing: Promise<void> | null = null;
  const close = () => {
    closing ??= (async () => {
      try {
        await vite?.close();
      } finally {
        try {
          await transport?.close();
        } finally {
          try {
            await host.close();
          } finally {
            agent.destroy();
            await new Promise<void>((resolve) => {
              front.close(() => resolve());
              front.closeAllConnections();
            });
          }
        }
      }
    })();
    return closing;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      front.once('error', reject);
      front.listen(port, '127.0.0.1', () => {
        front.off('error', reject);
        resolve();
      });
    });
    const actualPort = (front.address() as AddressInfo).port;
    const origin = `https://127.0.0.1:${actualPort}`;
    transport = new PenkyTransport({
      access: new PostgresGuestAccess(options.pool),
      host,
      tls: options.tls,
      origins: [origin],
      ...(options.now ? { now: options.now } : {}),
    });
    const upstream = await transport.listen(0, '127.0.0.1');
    vite = await createViteServer({
      ...clientConfig,
      configFile: false,
      logLevel: 'error',
      clearScreen: false,
      server: {
        middlewareMode: true,
        host: '127.0.0.1',
        port: actualPort,
        hmr: { server: front, protocol: 'wss', host: '127.0.0.1', clientPort: actualPort },
        fs: {
          strict: true,
          allow: [clientRoot, fileURLToPath(new URL('../../node_modules/', import.meta.url))],
        },
        proxy: { '/api/': { target: upstream, changeOrigin: false, secure: true, agent } },
      },
    });
    handler = (req, res) => vite!.middlewares(req, res);
    return { origin, close };
  } catch (error) {
    await close();
    throw error;
  }
}
