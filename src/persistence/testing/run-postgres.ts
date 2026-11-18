import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.env.PENKY_TEST_DATABASE_URL)
  throw new Error('Set PENKY_TEST_DATABASE_URL to a dedicated *_test database');
const child = spawn(
  process.execPath,
  [
    '--test',
    fileURLToPath(new URL('../postgres.test.ts', import.meta.url)),
    fileURLToPath(new URL('../lobby.postgres.test.ts', import.meta.url)),
    fileURLToPath(new URL('../../server/guest-access.postgres.test.ts', import.meta.url)),
    fileURLToPath(new URL('../../server/game-host.postgres.test.ts', import.meta.url)),
  ],
  { stdio: 'inherit' },
);
child.on('error', () => {
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
