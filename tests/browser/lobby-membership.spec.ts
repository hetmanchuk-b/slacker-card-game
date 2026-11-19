import { expect } from '@playwright/test';
import type { Page, BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { id } from '../../src/game/ids.ts';
import { PostgresGuestAccess } from '../../src/server/guest-access.ts';
import { PostgresGameHost } from '../../src/server/game-host.ts';
import { test } from './fixtures.ts';

async function create(page: Page, origin: string) {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Create lobby', exact: true }).click();
  await expect(page.getByTestId('lobby-id')).toBeVisible();
  return page.getByTestId('lobby-id').innerText();
}
async function freshJoin(page: Page, origin: string, lobbyId: string) {
  await page.goto(origin);
  await page.getByLabel('Lobby reference (required)').fill(lobbyId);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Join as a new guest' }).click();
}

test('same-cookie owner and member identities restore on reload and an independent tab', async ({
  page,
  context,
  browser,
  origin,
}) => {
  const lobbyId = await create(page, origin);
  const ownerSeat = await page.getByTestId('seat-id').innerText();
  const opened = context.waitForEvent('page');
  await page.getByRole('link', { name: 'Open lobby in another tab' }).click();
  const tab = await opened;
  await tab.waitForLoadState('domcontentloaded');
  await expect(tab.getByTestId('seat-id')).toHaveCount(0);
  await tab.getByRole('button', { name: 'Restore my seat' }).click();
  await expect(tab.getByTestId('seat-id')).toHaveText(ownerSeat);
  await expect(tab.getByTestId('seat-role')).toHaveText('Owner');
  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const member = await other.newPage();
    await freshJoin(member, origin, lobbyId);
    await expect(member.getByTestId('seat-number')).toHaveText('2');
    await expect(member.getByTestId('seat-role')).toHaveText('Member');
    const seat = await member.getByTestId('seat-id').innerText();
    expect(seat).not.toBe(ownerSeat);
    await expect(member.getByRole('checkbox')).not.toBeChecked();
    await member.reload();
    await expect(member.getByTestId('seat-id')).toHaveCount(0);
    await member.getByRole('button', { name: 'Restore my seat' }).click();
    await expect(member.getByTestId('seat-id')).toHaveText(seat);
    expect(await member.evaluate(() => sessionStorage.length + localStorage.length)).toBe(0);
  } finally {
    await other.close();
  }
});

test('a lost committed join reply resumes the exact target and seat after reload', async ({
  page,
  browser,
  origin,
}) => {
  const lobbyId = await create(page, origin);
  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const member = await other.newPage();
    let committedSeat = '';
    const bodies: unknown[] = [];
    let drop = true;
    await member.route('**/api/lobbies/join', async (route) => {
      bodies.push(route.request().postDataJSON());
      if (drop) {
        drop = false;
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        committedSeat = (await response.json()).seatId;
        await route.abort('failed');
      } else await route.continue();
    });
    await freshJoin(member, origin, lobbyId);
    await expect(member.getByRole('alert')).toContainText('could not be confirmed');
    await member.reload();
    await member.getByRole('button', { name: 'Restore my seat' }).click();
    await expect(member.getByTestId('seat-id')).toHaveText(committedSeat);
    expect(bodies).toEqual([{ lobbyId }, { lobbyId }]);
  } finally {
    await other.close();
  }
});

test('a copied locator with no cookie cannot silently issue a replacement or reclaim ownership', async ({
  page,
  context,
  origin,
}) => {
  await create(page, origin);
  await context.clearCookies();
  const posts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') posts.push(new URL(request.url()).pathname);
  });
  await page.reload();
  await page.getByRole('button', { name: 'Restore my seat' }).click();
  await expect(page.getByRole('alert')).toContainText('have not replaced it');
  expect(posts).toEqual(['/api/guest/session/refresh']);
  await expect(page.getByTestId('seat-id')).toHaveCount(0);
  // Even explicit fresh-entry consent must not rebind this tab's saved creation key.
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Join as a new guest' }).click();
  await expect(page.getByRole('alert')).toContainText('have not replaced it');
  expect(posts).toEqual(['/api/guest/session/refresh', '/api/guest/session/refresh']);
});

test('unknown references fail generically; native keyboard validation and narrow layout remain usable', async ({
  page,
  origin,
}, testInfo) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(origin);
  const input = page.getByLabel('Lobby reference (required)');
  await page.getByRole('button', { name: 'Join lobby', exact: true }).click();
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await input.fill('does-not-exist');
  await page.getByRole('checkbox').check();
  await input.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('could not be confirmed');
  await expect(page.getByTestId('seat-id')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('join-360.png'), fullPage: true });
});

test('joining another lobby preserves the original canonical creation and labels its retry separately', async ({
  page,
  browser,
  origin,
}) => {
  const original = await create(page, origin);
  const reference = await page.evaluate(() => sessionStorage.getItem('penky.lobby-creation.v1'));
  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const owner = await other.newPage();
    const target = await create(owner, origin);
    await page.getByLabel('Lobby reference (required)').fill(target);
    await page.getByRole('button', { name: 'Join lobby', exact: true }).click();
    await expect(page.getByTestId('lobby-id')).toHaveText(target);
    await expect(page.getByTestId('seat-role')).toHaveText('Member');
    expect(await page.evaluate(() => sessionStorage.getItem('penky.lobby-creation.v1'))).toBe(
      reference,
    );
    await page.getByRole('button', { name: 'Resume lobby creation' }).click();
    await expect(page.getByTestId('lobby-id')).toHaveText(original);
    await expect(page.getByTestId('seat-role')).toHaveText('Owner');
  } finally {
    await other.close();
  }
});

test('an expired member with only a URL locator never receives a replacement credential on restore', async ({
  page,
  browser,
  origin,
  wall,
}) => {
  const lobbyId = await create(page, origin);
  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const member = await other.newPage();
    await freshJoin(member, origin, lobbyId);
    await expect(member.getByTestId('seat-id')).toBeVisible();
    wall.now += 30 * 24 * 60 * 60 * 1000 + 1;
    const posts: string[] = [];
    member.on('request', (request) => {
      if (request.method() === 'POST') posts.push(new URL(request.url()).pathname);
    });
    await member.reload();
    await member.getByRole('button', { name: 'Restore my seat' }).click();
    await expect(member.getByRole('alert')).toContainText('have not replaced it');
    expect(posts).toEqual(['/api/guest/session/refresh']);
    await expect(member.getByTestId('seat-id')).toHaveCount(0);
  } finally {
    await other.close();
  }
});

test('a successful creation clears an earlier invalid join field so restoration can submit', async ({
  page,
  origin,
}) => {
  await page.goto(origin);
  const input = page.getByLabel('Lobby reference (required)');
  await input.fill('   ');
  await page.getByRole('button', { name: 'Join lobby', exact: true }).click();
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('button', { name: 'Create lobby', exact: true }).click();
  await expect(page.getByTestId('lobby-id')).toBeVisible();
  await expect(input).not.toHaveAttribute('aria-invalid', 'true');
  const restored = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/lobbies/join',
  );
  await page.getByRole('button', { name: 'Restore my seat' }).click();
  expect((await restored).status()).toBe(200);
  await expect(page.getByTestId('seat-role')).toHaveText('Owner');
});

test('a full eight-seat lobby restores existing membership but rejects a ninth guest', async ({
  page,
  browser,
  origin,
  wall,
}) => {
  const lobbyId = await create(page, origin);
  const contexts: BrowserContext[] = [];
  try {
    let first!: Page;
    let seat = '';
    for (let position = 2; position <= 9; position++) {
      wall.now += 60001; // Fixture advances issuance/IP windows, not admission policy.
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      contexts.push(context);
      const member = await context.newPage();
      await freshJoin(member, origin, lobbyId);
      if (position === 9) {
        await expect(member.getByRole('alert')).toContainText(
          'may be full or have a match in progress',
        );
        await expect(member.getByTestId('seat-id')).toHaveCount(0);
      } else {
        await expect(member.getByTestId('seat-number')).toHaveText(String(position));
        if (position === 2) {
          first = member;
          seat = await member.getByTestId('seat-id').innerText();
        }
      }
    }
    await first.reload();
    await first.getByRole('button', { name: 'Restore my seat' }).click();
    await expect(first.getByTestId('seat-id')).toHaveText(seat);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test('running-match fixture preserves existing browser membership and refuses new admission', async ({
  page,
  context,
  browser,
  origin,
  pool,
  wall,
}) => {
  const lobbyId = await create(page, origin);
  const ownerSeat = await page.getByTestId('seat-id').innerText();
  const memberContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const outsider = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const member = await memberContext.newPage();
    await freshJoin(member, origin, lobbyId);
    await expect(member.getByTestId('seat-role')).toHaveText('Member');
    const memberSeat = await member.getByTestId('seat-id').innerText();
    // Trusted server setup ONLY for the running admission precondition. This is
    // not UI start/agreements/gameplay acceptance; those remain later increments.
    const access = new PostgresGuestAccess(pool);
    const ownerToken = (await context.cookies(origin)).find(
      (cookie) => cookie.name === '__Host-penky_guest',
    )!.value;
    const memberToken = (await memberContext.cookies(origin)).find(
      (cookie) => cookie.name === '__Host-penky_guest',
    )!.value;
    const binding = await access.membership(ownerToken, id('lobby', lobbyId), wall.now);
    const view = await access.lobbyState(ownerToken, binding.lobbyId, wall.now);
    for (const token of [ownerToken, memberToken])
      await access.setAcceptance(token, binding.lobbyId, view.revision, true, wall.now);
    const host = new PostgresGameHost(pool);
    try {
      expect(
        (
          await host.startMatch(binding.lobbyId, {
            id: id('command', randomUUID()),
            actorSessionId: binding.sessionId,
            expectedGameId: null,
            expectedHead: null,
            gameId: id('game', randomUUID()),
            branchId: id('branch', randomUUID()),
            seatIds: binding.seatIds,
            cardIds: Array.from({ length: 36 }, () => id('card', randomUUID())),
          })
        ).type,
      ).toBe('started');
    } finally {
      await host.close();
    }
    for (const [active, seat] of [
      [page, ownerSeat],
      [member, memberSeat],
    ] as const) {
      await active.reload();
      await active.getByRole('button', { name: 'Restore my seat' }).click();
      await expect(active.getByTestId('seat-id')).toHaveText(seat);
    }
    const fresh = await outsider.newPage();
    await freshJoin(fresh, origin, lobbyId);
    await expect(fresh.getByRole('alert')).toContainText('may be full or have a match in progress');
    await expect(fresh.getByTestId('seat-id')).toHaveCount(0);
  } finally {
    await memberContext.close();
    await outsider.close();
  }
});
