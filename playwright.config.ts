import { defineConfig, devices } from '@playwright/test';

const database = process.env.PENKY_TEST_DATABASE_URL;
if (!database || !new URL(database).pathname.endsWith('_test'))
  throw new Error(
    'Browser tests require an explicitly disposable PENKY_TEST_DATABASE_URL ending in _test',
  );

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30000,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
    // Only this isolated browser-test context accepts the public localhost
    // fixture certificate. Never disable TLS verification globally or in proxy.
    ignoreHTTPSErrors: true,
    trace: 'off', // No cookie/response archives by default.
    screenshot: 'off',
  },
});
