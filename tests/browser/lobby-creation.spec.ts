import { expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { test } from './fixtures.ts';

test('a real HTTPS browser creates a lobby and receives only its own identity', async ({
  page,
  context,
  origin,
}, testInfo) => {
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: 'Create a lobby' })).toBeVisible();
  await page.getByRole('button', { name: 'Create lobby', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your lobby' })).toBeVisible();
  await expect(page.getByTestId('seat-number')).toHaveText('1');
  await expect(page.getByTestId('seat-role')).toHaveText('Owner');
  const lobby = await page.getByTestId('lobby-id').innerText();
  expect(lobby).toMatch(/^[0-9a-f-]{36}$/i);
  const cookies = await context.cookies(origin);
  const guest = cookies.find((cookie) => cookie.name === '__Host-penky_guest');
  expect(Boolean(guest)).toBe(true);
  expect({
    secure: guest!.secure,
    httpOnly: guest!.httpOnly,
    sameSite: guest!.sameSite,
    path: guest!.path,
  }).toEqual({ secure: true, httpOnly: true, sameSite: 'Lax', path: '/' });
  expect(await page.evaluate(() => document.cookie.includes('__Host-penky_guest'))).toBe(false);
  const stored = await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }));
  expect(stored.includes(guest!.value)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('lobby-desktop.png'), fullPage: true });
});

test('expired original sessions do not issue replacement credentials or replay creation', async ({
  page,
  context,
  origin,
  wall,
}) => {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Create lobby', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your lobby' })).toBeVisible();
  const original = (await context.cookies(origin)).find(
    (cookie) => cookie.name === '__Host-penky_guest',
  )!;
  wall.now += 30 * 24 * 60 * 60 * 1000 + 1;
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') mutations.push(new URL(request.url()).pathname);
  });
  await page.reload();
  await page.getByRole('button', { name: 'Resume lobby creation' }).click();
  await expect(page.getByRole('alert')).toContainText('original guest session is unavailable');
  expect(mutations).toEqual(['/api/guest/session/refresh']);
  expect(
    (await context.cookies(origin)).find((cookie) => cookie.name === '__Host-penky_guest')
      ?.value === original.value,
  ).toBe(true);
  await expect(page.getByRole('heading', { name: 'Your lobby' })).toHaveCount(0);
});

test('a lost committed response resumes the original lobby after reload', async ({
  page,
  origin,
}) => {
  const keys: string[] = [];
  let original = '';
  let drop = true;
  await page.route('**/api/lobbies', async (route) => {
    keys.push(route.request().postDataJSON().requestId);
    if (drop) {
      drop = false;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      original = (await response.json()).lobbyId;
      await route.abort('failed');
    } else await route.continue();
  });
  await page.goto(origin);
  await page.getByRole('button', { name: 'Create lobby', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('could not be confirmed');
  await page.reload();
  await page.getByRole('button', { name: 'Resume lobby creation' }).click();
  await expect(page.getByTestId('lobby-id')).toHaveText(original);
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
});

test('independent browser contexts receive distinct cookies, lobbies and own seats', async ({
  page,
  context,
  browser,
  origin,
}) => {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Create lobby', exact: true }).click();
  await expect(page.getByTestId('lobby-id')).toBeVisible();
  const first = await page.getByTestId('lobby-id').innerText();
  const firstGuest = (await context.cookies(origin)).find(
    (cookie) => cookie.name === '__Host-penky_guest',
  )!;
  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const second = await other.newPage();
    await second.goto(origin);
    await second.getByRole('button', { name: 'Create lobby', exact: true }).click();
    await expect(second.getByTestId('lobby-id')).toBeVisible();
    expect(await second.getByTestId('lobby-id').innerText()).not.toBe(first);
    expect(await second.getByTestId('seat-id').innerText()).not.toBe(
      await page.getByTestId('seat-id').innerText(),
    );
    expect(
      (await other.cookies(origin)).find((cookie) => cookie.name === '__Host-penky_guest')!
        .value === firstGuest.value,
    ).toBe(false);
    await expect(second.locator('main')).not.toContainText(first);
  } finally {
    await other.close();
  }
});

test('an invalid retained named cookie is never silently overwritten', async ({
  page,
  context,
  origin,
}) => {
  const invalid = 'A'.repeat(43);
  await context.addCookies([
    {
      name: '__Host-penky_guest',
      value: invalid,
      url: origin,
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  await page.goto(origin);
  await page.getByRole('button', { name: 'Create lobby', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('have not replaced it');
  expect(
    (await context.cookies(origin)).find((cookie) => cookie.name === '__Host-penky_guest')
      ?.value === invalid,
  ).toBe(true);
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
});

test('blocked tab storage prevents an unrepeatable lobby request', async ({ page, origin }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'sessionStorage', {
      get() {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });
  });
  const requests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request.url());
  });
  await page.goto(origin);
  await page.getByRole('button', { name: 'Create lobby', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('cannot save its creation reference');
  expect(requests).toEqual([]);
});

test('real rate-limit feedback retains the original creation reference', async ({
  page,
  origin,
}) => {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Create lobby', exact: true }).click();
  await expect(page.getByTestId('lobby-id')).toBeVisible();
  const original = await page.getByTestId('lobby-id').innerText();
  const reference = await page.evaluate(() => sessionStorage.getItem('penky.lobby-creation.v1'));
  for (let index = 1; index < 12; index++) {
    await page.getByRole('button', { name: 'Confirm lobby identity' }).click();
    await expect(page.getByTestId('lobby-id')).toHaveText(original);
  }
  await page.getByRole('button', { name: 'Confirm lobby identity' }).click();
  await expect(page.getByRole('alert')).toContainText('Too many requests');
  expect(await page.evaluate(() => sessionStorage.getItem('penky.lobby-creation.v1'))).toBe(
    reference,
  );
});

test('development proxy preserves Origin rejection and does not serve private server source', async ({
  page,
  origin,
}) => {
  await page.goto(origin);
  const refused = await page.request.post(`${origin}/api/guest/session`, {
    headers: { Origin: 'https://evil.example' },
  });
  expect(refused.status()).toBe(403);
  expect(await refused.text()).toBe('');
  const path = fileURLToPath(
    new URL('../../src/server/guest-access.ts', import.meta.url),
  ).replaceAll('\\', '/');
  const source = await page.request.get(`${origin}/@fs/${path}`);
  expect(source.status()).toBe(403);
  expect(await source.text()).not.toContain('export class PostgresGuestAccess');
});

test('keyboard creation works at a narrow viewport without horizontal overflow', async ({
  page,
  origin,
}, testInfo) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(origin);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Create lobby', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Your lobby' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('lobby-360.png'), fullPage: true });
});
