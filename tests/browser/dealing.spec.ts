import { expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test } from './fixtures.ts';

async function setup(
  browser: Browser,
  origin: string,
  wall: { now: number },
  count: number,
  prepare?: (page: Page) => Promise<void>,
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
      if (index === 0) await prepare?.(page);
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
    return { contexts, pages };
  } catch (error) {
    await Promise.all(contexts.map((context) => context.close()));
    throw error;
  }
}

test('a lost draw acknowledgment clears disclosures and resync never replays the attempt', async ({
  browser,
  origin,
  wall,
}) => {
  let draws = 0;
  let drop = true;
  const { contexts, pages } = await setup(browser, origin, wall, 2, async (page) => {
    await page.routeWebSocket('**/socket.io/**', (route) => {
      const server = route.connectToServer();
      route.onMessage((frame) => {
        if (typeof frame === 'string' && frame.startsWith('42')) {
          const tuple = JSON.parse(frame.slice(frame.indexOf('[')));
          if (tuple[0] === 'client-message' && tuple[1]?.intent?.type === 'draw-card') draws++;
        }
        server.send(frame);
      });
      server.onMessage(async (frame) => {
        if (drop && typeof frame === 'string' && frame.startsWith('42')) {
          const tuple = JSON.parse(frame.slice(frame.indexOf('[')));
          if (tuple[0] === 'server-message' && tuple[1]?.type === 'command-ack') {
            expect(tuple[1].result.type).toBe('accepted');
            drop = false;
            await route.close();
            return;
          }
        }
        route.send(frame);
      });
    });
  });
  try {
    const page = pages[0]!;
    const first = await page.getByTestId('initial-recipient').count();
    await page.getByRole('button', { name: 'Draw card', exact: true }).click();
    await expect(page.getByTestId('connection-status')).toHaveText('uncertain');
    await expect(page.getByTestId('draw-result')).toHaveText(/outcome uncertain/);
    await expect(page.getByTestId('own-hand').getByRole('listitem')).toHaveCount(0);
    await page.getByRole('button', { name: 'Connect game', exact: true }).click();
    await expect(page.getByTestId('deck-count')).toHaveText(first ? '35' : '36');
    await expect(page.getByTestId('draw-actor')).toBeEmpty();
    expect(draws).toBe(1);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

for (const count of [2, 4, 8]) {
  test(`${count} independent browser seats manually deal with private cards, observed actors and bounded D002 reveals`, async ({
    browser,
    origin,
    wall,
  }) => {
    const { contexts, pages } = await setup(browser, origin, wall, count);
    try {
      await pages[0]!.setViewportSize({ width: 360, height: 800 });
      const notices = await Promise.all(
        pages.map((page) => page.getByTestId('initial-recipient').count()),
      );
      expect(notices.filter(Boolean)).toHaveLength(1);
      const first = notices.indexOf(1);
      // State-only resync may reissue only the unconsumed private initial notice.
      await pages[first]!.getByRole('button', { name: 'Resync game', exact: true }).click();
      await expect(pages[first]!.getByTestId('initial-recipient')).toBeVisible();
      if (count === 4) {
        const culprit = (first + 1) % count;
        await pages[culprit]!.getByRole('button', { name: 'Draw card', exact: true }).click();
        for (const page of pages) {
          await expect(page.getByTestId('draw-actor')).toHaveText(
            `Seat ${culprit + 1} attempted an out-of-turn draw; no card kept.`,
          );
          await expect(page.getByTestId('deck-count')).toHaveText('36');
        }
        await expect(pages[first]!.getByTestId('initial-recipient')).toBeVisible();
        await expect(pages[culprit]!.getByTestId('draw-result')).toHaveText(/violation/i);
      }
      for (let draw = 0; draw < 36; draw++) {
        const actor = (first + draw) % count;
        await pages[actor]!.getByRole('button', { name: 'Draw card', exact: true }).click();
        for (const page of pages) {
          await expect(page.getByTestId('deck-count')).toHaveText(String(35 - draw));
          await expect(page.getByTestId('draw-actor')).toHaveText(
            `Seat ${actor + 1} drew a ${draw < 2 * count ? 'closed stump' : 'hand card'}.`,
          );
          await expect(page.getByTestId('initial-recipient')).toHaveCount(0);
        }
        if (draw < 2 * count) {
          await expect(pages[actor]!.getByTestId('own-stumps').getByRole('listitem')).toHaveCount(
            Math.floor(draw / count) + 1,
          );
          await expect(pages[actor]!.getByTestId('own-hand').getByRole('listitem')).toHaveCount(0);
        }
      }
      const recipient = (first + 35) % count;
      for (let index = 0; index < count; index++) {
        const page = pages[index]!;
        const offset = (index - first + count) % count;
        const expected = Math.floor((35 - offset) / count) - 1;
        await expect(page.getByTestId('own-hand').getByRole('listitem')).toHaveCount(expected);
        await expect(page.getByTestId('own-stumps').getByRole('listitem')).toHaveCount(2);
        await expect(page.getByTestId('final-reveal')).toBeVisible();
        await expect(page.getByTestId('game-phase')).toHaveText('trump-reveal');
        // Only own cards and the one current authorized public reveal are rendered.
        expect(await page.getByTestId('own-hand').getByRole('listitem').allTextContents()).toEqual(
          expect.arrayContaining([expect.stringMatching(/(clubs|diamonds|hearts|spades)/)]),
        );
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      }
      if (count === 2) {
        // Runtime deadlines use the real host clock; the fixture wall controls guest expiry only.
        await new Promise((resolve) => setTimeout(resolve, 3100));
        await pages[0]!.getByRole('button', { name: 'Disconnect game', exact: true }).click();
        await expect(pages[0]!.getByTestId('final-reveal')).toHaveCount(0);
        await expect(pages[1]!.getByTestId('game-paused')).toHaveText('Paused');
        await expect(pages[1]!.getByTestId('final-reveal')).toHaveCount(0);
        await pages[0]!.getByRole('button', { name: 'Connect game', exact: true }).click();
        for (const page of pages) {
          await expect(page.getByTestId('game-paused')).toHaveText('Running');
          await expect(page.getByTestId('final-reveal')).toBeVisible();
          await page.clock.fastForward(7001);
          await expect(page.getByTestId('final-reveal')).toHaveCount(0);
        }
      } else {
        for (const page of pages) {
          await page.clock.fastForward(10001);
          await expect(page.getByTestId('final-reveal')).toHaveCount(0);
        }
      }
      // Removing the public reveal must not remove the recipient's ordinary hand.
      const ownCards = await pages[recipient]!.getByTestId('own-hand')
        .getByRole('listitem')
        .count();
      expect(ownCards).toBeGreaterThan(0);
      // Browser time advancement proves local removal, not a server timer command.
      await expect(pages[0]!.getByTestId('game-phase')).toHaveText(
        count === 4 ? 'pre-game-penalties' : 'between-rounds',
        { timeout: 15000 },
      );
      await pages[0]!.reload();
      await pages[0]!.getByRole('button', { name: 'Restore my seat', exact: true }).click();
      await pages[0]!.getByRole('button', { name: 'Connect game', exact: true }).click();
      await expect(pages[0]!.getByTestId('game-phase')).toBeVisible();
      await expect(pages[0]!.getByTestId('final-reveal')).toHaveCount(0);
      await expect(pages[0]!.getByTestId('draw-actor')).toBeEmpty();
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  });
}
