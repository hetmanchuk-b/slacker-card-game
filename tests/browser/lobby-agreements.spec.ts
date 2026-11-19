import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './fixtures.ts';
import { randomUUID } from 'node:crypto';
import { id } from '../../src/game/ids.ts';
import { PostgresGuestAccess } from '../../src/server/guest-access.ts';
import { PostgresGameHost } from '../../src/server/game-host.ts';

async function submit(page: Page, name: string, path: string, status = 200) {
  const reply = page.waitForResponse((response) => new URL(response.url()).pathname === path);
  await page.getByRole('button', { name, exact: true }).click();
  expect((await reply).status()).toBe(status);
  await expect(page.getByRole('button', { name: 'Refresh agreements', exact: true })).toBeEnabled();
}
async function refresh(page: Page) {
  await submit(page, 'Refresh agreements', '/api/lobbies/state');
}
async function save(page: Page) {
  await submit(page, 'Save agreements', '/api/lobbies/agreements');
}
async function accept(page: Page) {
  await submit(page, 'Accept current agreements', '/api/lobbies/ready');
}

async function create(page: Page, origin: string) {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Create lobby', exact: true }).click();
  await expect(page.getByTestId('lobby-id')).toBeVisible();
  return page.getByTestId('lobby-id').innerText();
}
async function join(page: Page, origin: string, lobbyId: string) {
  await page.goto(origin);
  await page.getByLabel('Lobby reference (required)').fill(lobbyId);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Join as a new guest' }).click();
  await expect(page.getByTestId('lobby-id')).toHaveText(lobbyId);
}

test('owner edits literal text, accepts agreements, preserves an identical save and resets on change', async ({
  page,
  origin,
}) => {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Create lobby', exact: true }).click();
  await expect(page.getByTestId('seat-id')).toBeVisible();
  await refresh(page);
  const initial = BigInt(await page.getByTestId('agreements-epoch').innerText());
  const text = '  Literal <img src=x onerror="alert(1)">\nДомовленості 🂡\n';
  await page.getByLabel('Edit lobby agreements').fill(text);
  await save(page);
  expect(await page.getByTestId('agreements-text').textContent()).toBe(text);
  await expect(page.getByTestId('agreements-text').locator('img')).toHaveCount(0);
  await expect(page.getByTestId('agreements-epoch')).toHaveText(String(initial + 1n));
  await accept(page);
  await expect(page.getByTestId('acceptance-0')).toContainText('Accepted');
  await save(page);
  await expect(page.getByTestId('acceptance-0')).toContainText('Accepted');
  await expect(page.getByTestId('agreements-epoch')).toHaveText(String(initial + 1n));
  await page.getByLabel('Edit lobby agreements').fill('A deliberate change');
  await save(page);
  await expect(page.getByTestId('acceptance-0')).toContainText('Not accepted');
  await expect(page.getByTestId('agreements-epoch')).toHaveText(String(initial + 2n));
});

test('different members confirm one epoch concurrently, withdraw only their own consent and reset on a new member', async ({
  page,
  browser,
  origin,
}) => {
  const lobbyId = await create(page, origin);
  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  const third = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const member = await other.newPage();
    await join(member, origin, lobbyId);
    await Promise.all([refresh(page), refresh(member)]);
    const epoch = await page.getByTestId('agreements-epoch').innerText();
    await expect(member.getByRole('button', { name: 'Save agreements', exact: true })).toHaveCount(
      0,
    );
    await Promise.all([accept(page), accept(member)]);
    await refresh(page);
    await expect(page.getByTestId('acceptance-0')).toContainText('Accepted');
    await expect(page.getByTestId('acceptance-1')).toContainText('Accepted');
    await expect(page.getByTestId('agreements-epoch')).toHaveText(epoch);
    await submit(member, 'Withdraw acceptance', '/api/lobbies/ready');
    await refresh(page);
    await expect(page.getByTestId('acceptance-0')).toContainText('Accepted');
    await expect(page.getByTestId('acceptance-1')).toContainText('Not accepted');
    await expect(page.getByTestId('agreements-epoch')).toHaveText(epoch);
    await accept(member);
    const newcomer = await third.newPage();
    await join(newcomer, origin, lobbyId);
    await refresh(page);
    await expect(page.getByTestId('agreements-epoch')).toHaveText(String(BigInt(epoch) + 1n));
    for (let position = 0; position < 3; position++)
      await expect(page.getByTestId(`acceptance-${position}`)).toContainText('Not accepted');
  } finally {
    await other.close();
    await third.close();
  }
});

test('stale edits and acceptance require explicit refresh without retargeting a draft or decision', async ({
  page,
  context,
  origin,
  wall,
}) => {
  await create(page, origin);
  const tab = await context.newPage();
  await tab.goto(page.url());
  await tab.getByRole('button', { name: 'Restore my seat' }).click();
  await expect(tab.getByTestId('seat-id')).toBeVisible();
  await Promise.all([refresh(page), refresh(tab)]);
  await page.getByLabel('Edit lobby agreements').fill('Current terms');
  await save(page);
  const mutations: unknown[] = [];
  tab.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/lobbies/agreements')
      mutations.push(request.postDataJSON());
  });
  await tab.getByLabel('Edit lobby agreements').fill('Obsolete draft');
  await submit(tab, 'Save agreements', '/api/lobbies/agreements', 409);
  await expect(tab.getByRole('alert')).toContainText('changed or lobby changes are locked');
  await expect(tab.getByRole('button', { name: 'Save agreements', exact: true })).toBeDisabled();
  await expect(
    tab.getByRole('button', { name: 'Accept current agreements', exact: true }),
  ).toBeDisabled();
  await expect(tab.getByLabel('Edit lobby agreements')).toHaveValue('Obsolete draft');
  await refresh(tab);
  await expect(tab.getByLabel('Edit lobby agreements')).toHaveValue('Current terms');
  expect(mutations).toHaveLength(1);
  wall.now += 60001; // Shared credential budget, not an epoch/version shortcut.
  await page.getByLabel('Edit lobby agreements').fill('New current terms');
  await save(page);
  await submit(tab, 'Accept current agreements', '/api/lobbies/ready', 409);
  await expect(
    tab.getByRole('button', { name: 'Accept current agreements', exact: true }),
  ).toBeDisabled();
  await refresh(tab);
  await expect(tab.getByTestId('agreements-text')).toHaveText('New current terms');
  await expect(tab.getByTestId('acceptance-0')).toContainText('Not accepted');
});

test('lost committed edit and acceptance replies stay uncertain until an explicit fresh read', async ({
  page,
  origin,
}) => {
  await create(page, origin);
  await refresh(page);
  for (const [path, name] of [
    ['/api/lobbies/agreements', 'Save agreements'],
    ['/api/lobbies/ready', 'Accept current agreements'],
  ] as const) {
    if (path.endsWith('/agreements'))
      await page.getByLabel('Edit lobby agreements').fill('Committed once');
    let calls = 0;
    await page.route(`**${path}`, async (route) => {
      calls++;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort('failed');
    });
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('It may have committed');
    await expect(page.getByRole('button', { name: 'Save agreements', exact: true })).toBeDisabled();
    await refresh(page);
    expect(calls).toBe(1);
    expect(await page.getByTestId('agreements-text').textContent()).toBe('Committed once');
    if (path.endsWith('/ready'))
      await expect(page.getByTestId('acceptance-0')).toContainText('Accepted');
    await page.unroute(`**${path}`);
  }
});

test('UTF-8 validation permits empty text, refresh clears validation, and in-flight requests lock all lobby controls', async ({
  page,
  origin,
}, testInfo) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await create(page, origin);
  await refresh(page);
  const input = page.getByLabel('Edit lobby agreements');
  let mutations = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/lobbies/agreements') mutations++;
  });
  await input.fill('🂡'.repeat(1025));
  await page.getByRole('button', { name: 'Save agreements', exact: true }).click();
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(mutations).toBe(0);
  await refresh(page);
  await expect(input).not.toHaveAttribute('aria-invalid', 'true');
  await expect(input).toHaveValue('');
  await save(page);
  expect(mutations).toBe(1);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/lobbies/state', async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: 'Refresh agreements', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Confirming…', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save agreements', exact: true })).toBeDisabled();
    await expect(page.getByLabel('Lobby reference (required)')).toHaveAttribute('readonly', '');
  } finally {
    release();
  }
  await expect(page.getByRole('button', { name: 'Refresh agreements', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('agreements-360.png'), fullPage: true });
});

test('failed and successful trusted start preconditions preserve/reset UI consent and expose locked original match terms', async ({
  page,
  context,
  browser,
  origin,
  pool,
  wall,
}) => {
  const lobbyId = await create(page, origin);
  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  const host = new PostgresGameHost(pool);
  try {
    const member = await other.newPage();
    await join(member, origin, lobbyId);
    await refresh(page);
    const text = 'Original exact terms\n 🂡';
    await page.getByLabel('Edit lobby agreements').fill(text);
    await save(page);
    await refresh(member);
    const epoch = await page.getByTestId('agreements-epoch').innerText();
    await accept(page);
    // Trusted fixture start only. Agreement edits/consent are real browser UI;
    // no game-start control/socket proxy is added before approved increment 9.4.
    const token = (await context.cookies(origin)).find(
      (cookie) => cookie.name === '__Host-penky_guest',
    )!.value;
    const binding = await new PostgresGuestAccess(pool).membership(
      token,
      id('lobby', lobbyId),
      wall.now,
    );
    const start = {
      id: id('command', randomUUID()),
      actorSessionId: binding.sessionId,
      expectedGameId: null,
      expectedHead: null,
      gameId: id('game', randomUUID()),
      branchId: id('branch', randomUUID()),
      seatIds: binding.seatIds,
      cardIds: Array.from({ length: 36 }, () => id('card', randomUUID())),
    };
    expect(await host.startMatch(binding.lobbyId, start)).toEqual({
      type: 'rejected',
      code: 'not-ready',
    });
    await refresh(page);
    await expect(page.getByTestId('agreements-epoch')).toHaveText(epoch);
    await expect(page.getByTestId('acceptance-0')).toContainText('Accepted');
    await expect(page.getByTestId('acceptance-1')).toContainText('Not accepted');
    await accept(member);
    expect((await host.startMatch(binding.lobbyId, start)).type).toBe('started');
    await refresh(page);
    await expect(page.getByTestId('agreements-epoch')).toHaveText(String(BigInt(epoch) + 1n));
    for (const position of [0, 1])
      await expect(page.getByTestId(`acceptance-${position}`)).toContainText('Not accepted');
    await expect(page.getByRole('button', { name: 'Save agreements', exact: true })).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Accept current agreements', exact: true }),
    ).toBeDisabled();
    await expect(page.getByTestId('match-agreements-epoch')).toHaveText(epoch);
    expect(await page.getByTestId('match-agreements-text').textContent()).toBe(text);
    expect((await host.startMatch(binding.lobbyId, start)).type).toBe('duplicate');
    await refresh(page);
    await expect(page.getByTestId('agreements-epoch')).toHaveText(String(BigInt(epoch) + 1n));
    await member.reload();
    await member.getByRole('button', { name: 'Restore my seat' }).click();
    await expect(member.getByTestId('seat-id')).toBeVisible();
    await refresh(member);
    expect(await member.getByTestId('match-agreements-text').textContent()).toBe(text);
    await expect(
      member.getByRole('button', { name: 'Accept current agreements', exact: true }),
    ).toBeDisabled();
  } finally {
    await host.close();
    await other.close();
  }
});

test('refresh and an unedited save preserve existing CRLF text exactly', async ({
  page,
  origin,
}) => {
  const lobbyId = await create(page, origin);
  const text = '  Existing\r\ntext\r\n';
  // Existing HTTP setup supplies CRLF that native textarea input normalizes.
  // UI reading and an unchanged save must not silently normalize stored terms.
  const seeded = await page.request.post(`${origin}/api/lobbies/agreements`, {
    headers: { Origin: origin },
    data: { lobbyId, expectedRevision: '0', text },
  });
  expect(seeded.status()).toBe(200);
  await refresh(page);
  expect(await page.getByTestId('agreements-text').textContent()).toBe(text);
  const sent = page.waitForRequest(
    (request) => new URL(request.url()).pathname === '/api/lobbies/agreements',
  );
  await save(page);
  expect((await sent).postDataJSON().text).toBe(text);
  expect(await page.getByTestId('agreements-text').textContent()).toBe(text);
  await expect(page.getByTestId('agreements-epoch')).toHaveText('1');
});

test('original match text is a separate read-only panel even when current terms differ', async ({
  page,
  origin,
}) => {
  await create(page, origin);
  // Presentation-only wire fixture models a finished match followed by edits;
  // real start/lock/binding behavior is covered by the trusted-start case above.
  await page.route('**/api/lobbies/state', async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    await route.fulfill({
      response,
      json: {
        ...value,
        revision: '5',
        text: 'Later lobby text',
        matchAgreements: {
          gameId: 'opaque-prior-game',
          revision: '2',
          text: 'Original match text',
        },
      },
    });
  });
  await refresh(page);
  await expect(page.getByTestId('agreements-text')).toHaveText('Later lobby text');
  await expect(page.getByTestId('match-agreements-text')).toHaveText('Original match text');
  await expect(page.getByTestId('match-agreements-epoch')).toHaveText('2');
  await expect(
    page
      .getByRole('region', { name: 'Original match agreements (read-only)' })
      .getByRole('textbox'),
  ).toHaveCount(0);
});

test('switching confirmed lobbies discards old drafts, snapshots and owner controls', async ({
  page,
  browser,
  origin,
}) => {
  await create(page, origin);
  await refresh(page);
  await page.getByLabel('Edit lobby agreements').fill('Only the previous lobby');
  await save(page);
  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const owner = await other.newPage();
    const target = await create(owner, origin);
    await page.getByLabel('Lobby reference (required)').fill(target);
    await expect(page.getByTestId('agreements-text')).toHaveCount(0);
    await page.getByRole('button', { name: 'Join lobby', exact: true }).click();
    await expect(page.getByTestId('seat-role')).toHaveText('Member');
    await expect(page.getByTestId('agreements-text')).toHaveCount(0);
    await refresh(page);
    expect(await page.getByTestId('agreements-text').textContent()).toBe('');
    await expect(page.getByRole('button', { name: 'Save agreements', exact: true })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Only the previous lobby');
  } finally {
    await other.close();
  }
});

test('a malformed committed mutation response keeps the local draft copyable but disables stale authority', async ({
  page,
  origin,
}) => {
  await create(page, origin);
  await refresh(page);
  const draft = 'Keep this exact local draft 🂡';
  await page.getByLabel('Edit lobby agreements').fill(draft);
  await page.route('**/api/lobbies/agreements', async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.fulfill({
      response,
      json: { ...(await response.json()), cards: ['PRIVATE_CANARY'] },
    });
  });
  await save(page);
  await expect(page.getByRole('alert')).toContainText('could not be verified');
  await expect(page.getByLabel('Edit lobby agreements')).toHaveValue(draft);
  await expect(page.getByLabel('Edit lobby agreements')).toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', { name: 'Save agreements', exact: true })).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Accept current agreements', exact: true }),
  ).toBeDisabled();
  await expect(page.locator('body')).not.toContainText('PRIVATE_CANARY');
  await page.unroute('**/api/lobbies/agreements');
  await refresh(page);
  expect(await page.getByTestId('agreements-text').textContent()).toBe(draft);
});

test('malformed/private workflow responses clear authority and never echo diagnostics or issue credentials', async ({
  page,
  origin,
}) => {
  await create(page, origin);
  await refresh(page);
  await page.route('**/api/lobbies/state', async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    await route.fulfill({ response, json: { ...value, sessionId: 'PRIVATE_CANARY' } });
  });
  await refresh(page);
  await expect(page.getByRole('alert')).toContainText('could not be verified');
  expect(await page.getByTestId('agreements-text').textContent()).toBe('');
  await expect(page.getByRole('button', { name: 'Save agreements', exact: true })).toBeDisabled();
  await expect(
    page.getByText('Last confirmed snapshot only. Refresh is required before another change.'),
  ).toBeVisible();
  await expect(page.locator('body')).not.toContainText('PRIVATE_CANARY');
  await page.unroute('**/api/lobbies/state');
  const posts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') posts.push(new URL(request.url()).pathname);
  });
  await page.route('**/api/lobbies/state', (route) =>
    route.fulfill({ status: 401, body: 'PRIVATE_TOKEN_SQL' }),
  );
  await submit(page, 'Refresh agreements', '/api/lobbies/state', 401);
  await expect(page.getByRole('alert')).toContainText('no replacement was issued');
  await expect(page.locator('body')).not.toContainText('PRIVATE_TOKEN_SQL');
  expect(posts).toEqual(['/api/lobbies/state']);
});
