import { expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

export async function setup(
  browser: Browser,
  origin: string,
  wall: { now: number },
  count: number,
  prepare?: (page: Page) => Promise<void>,
  prepareEach = false,
) {
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  try {
    let lobbyId = '';
    for (let index = 0; index < count; index++) {
      if (index === 6) wall.now += 60001; // Existing guest issuance policy, not a bypass.
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      contexts.push(context);
      const page = await context.newPage();
      pages.push(page);
      await page.clock.install();
      if (index === 0 || prepareEach) await prepare?.(page);
      await page.goto(origin);
      if (index === 0) {
        await page.getByRole('button', { name: 'Create lobby', exact: true }).click();
        await expect(page.getByTestId('lobby-id')).toBeVisible();
        lobbyId = await page.getByTestId('lobby-id').innerText();
      } else {
        await page.getByLabel('Lobby reference (required)').fill(lobbyId);
        await page.getByRole('checkbox').check();
        await page.getByRole('button', { name: 'Join as a new guest' }).click();
        await expect(page.getByTestId('seat-id')).toBeVisible();
      }
    }
    for (const page of pages) {
      await page.getByRole('button', { name: 'Refresh agreements', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Accept current agreements', exact: true }),
      ).toBeEnabled();
      await page.getByRole('button', { name: 'Accept current agreements', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Withdraw acceptance', exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Connect game', exact: true }).click();
      await expect(page.getByTestId('connection-status')).toHaveText('attached');
    }
    await pages[0]!.getByRole('button', { name: 'Attempt first start', exact: true }).click();
    await expect(pages[0]!.getByTestId('game-phase')).toHaveText('dealing');
    for (const page of pages.slice(1)) {
      await page.getByRole('button', { name: 'Resync game', exact: true }).click();
      await expect(page.getByTestId('game-phase')).toHaveText('dealing');
    }
    for (const page of pages) await expect(page.getByTestId('game-paused')).toHaveText('Running');
    await initialRecipient(pages);
    return { contexts, pages };
  } catch (error) {
    await Promise.all(contexts.map((context) => context.close()));
    throw error;
  }
}
export async function initialRecipient(pages: Page[]) {
  let first = -1;
  await expect
    .poll(async () => {
      first = (
        await Promise.all(pages.map((p) => p.getByTestId('initial-recipient').count()))
      ).indexOf(1);
      return first;
    })
    .toBeGreaterThanOrEqual(0);
  return first;
}
export async function deal(pages: Page[]) {
  const first = await initialRecipient(pages);
  for (let draw = 0; draw < 36; draw++) {
    await pages[(first + draw) % pages.length]!.getByRole('button', {
      name: 'Draw card',
      exact: true,
    }).click();
    for (const page of pages)
      await expect(page.getByTestId('deck-count')).toHaveText(String(35 - draw));
  }
  return { first, leader: (first + 35) % pages.length };
}
