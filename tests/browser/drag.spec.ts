import { expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import { test } from './fixtures.ts';
import { setup, deal, initialRecipient } from './dealing-helpers.ts';
import { installScenario } from './play-fixture.ts';
import { scenario, heart, club } from '../../src/game/testing/scenarios.ts';

async function center(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw Error('Missing gesture geometry');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function begin(page: Page, source: Locator) {
  await source.scrollIntoViewIfNeeded();
  const start = await center(source);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 12, start.y, { steps: 3 });
  await expect(page.getByTestId('gesture-drop-target')).toBeVisible();
  return start;
}
async function drop(page: Page, target: Locator) {
  const end = await center(target);
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}
function outgoing(page: Page) {
  const types: string[] = [];
  page.on('websocket', (socket) =>
    socket.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string' || !payload.startsWith('42')) return;
      const tuple = JSON.parse(payload.slice(payload.indexOf('[')));
      if (tuple[0] === 'client-message') types.push(tuple[1]?.intent?.type);
    }),
  );
  return types;
}
const small = () =>
  scenario({
    hands: [
      [heart(6), club(6)],
      [heart(7), club(7)],
    ],
  });

test('real deck drag is one draw, including stump passes and deliberate out-of-turn attempts; cancellation never clicks through', async ({
  browser,
  origin,
  wall,
}) => {
  const { contexts, pages } = await setup(browser, origin, wall, 2);
  try {
    const commands = pages.map(outgoing);
    for (const page of pages) {
      await page.getByRole('button', { name: 'Resync game', exact: true }).click();
      await expect(page.getByTestId('game-phase')).toHaveText('dealing');
    }
    for (const page of pages) await expect(page.getByTestId('game-paused')).toHaveText('Running');
    const first = await initialRecipient(pages),
      actor = pages[first]!,
      other = pages[1 - first]!;
    await actor.setViewportSize({ width: 390, height: 1100 });
    const source = actor.getByRole('button', { name: 'Draw card', exact: true });
    await begin(actor, source);
    await drop(actor, actor.getByTestId('own-hand'));
    await expect(actor.getByTestId('deck-count')).toHaveText('35');
    await expect(actor.getByTestId('own-stumps').getByRole('listitem')).toHaveCount(1);
    await expect(
      actor.getByTestId('own-hand').getByRole('listitem'),
      'draw intent never promises a hand destination',
    ).toHaveCount(0);
    expect(commands[first]!.filter((t) => t === 'draw-card')).toHaveLength(1);
    // State can arrive before the command acknowledgment; gestures stay blocked
    // until the original draw is confirmed, even when the card is already shown.
    await expect(actor.getByTestId('draw-result')).toHaveText('Draw accepted.');
    await expect(source).toBeEnabled();
    await begin(actor, source);
    await actor.mouse.move(4, 4, { steps: 5 });
    await actor.mouse.up();
    expect(commands[first]!.filter((t) => t === 'draw-card')).toHaveLength(1);
    const start = await begin(actor, source);
    await actor.keyboard.press('Escape');
    await actor.mouse.move(start.x, start.y);
    await actor.mouse.up();
    await expect(actor.getByTestId('gesture-drop-target')).toHaveCount(0);
    expect(commands[first]!.filter((t) => t === 'draw-card')).toHaveLength(1);
    // Same actor deliberately drags again out of turn: same command, not a client legality gate.
    await begin(actor, source);
    await drop(actor, actor.getByTestId('gesture-drop-target'));
    await expect(actor.getByTestId('draw-result')).toContainText('violation');
    await expect(actor.getByTestId('deck-count')).toHaveText('35');
    expect(commands[first]!.filter((t) => t === 'draw-card')).toHaveLength(2);
    await other.getByRole('button', { name: 'Draw card', exact: true }).press('Enter');
    await expect(other.getByTestId('deck-count')).toHaveText('34');
    await source.click();
    await expect(actor.getByTestId('deck-count')).toHaveText('33');
    expect(commands[first]!.filter((t) => t === 'draw-card')).toHaveLength(3);
    expect(commands[1 - first]!.filter((t) => t === 'draw-card')).toHaveLength(1);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('real hand drag to the table strip uses one authenticated play intent and committed movement', async ({
  browser,
  origin,
  wall,
}) => {
  test.setTimeout(60000);
  const { contexts, pages } = await setup(browser, origin, wall, 2);
  try {
    const { leader } = await deal(pages);
    wall.now += 1001;
    for (const page of pages)
      await expect(page.getByTestId('game-phase')).toHaveText('between-rounds', { timeout: 15000 });
    const commands = pages.map(outgoing);
    for (const page of pages) {
      await page.getByRole('button', { name: 'Resync game', exact: true }).click();
      await expect(page.getByTestId('game-phase')).toHaveText('between-rounds');
    }
    for (const page of pages) await expect(page.getByTestId('game-paused')).toHaveText('Running');
    const actor = pages[leader]!;
    await actor.setViewportSize({ width: 390, height: 844 });
    const source = actor.getByTestId('own-hand').getByRole('button').first();
    const label = (await source.innerText()).slice(5);
    const count = await actor.getByTestId('own-hand').getByRole('listitem').count();
    await begin(actor, source);
    await drop(actor, actor.getByTestId('gesture-drop-target'));
    await expect(actor.getByTestId('own-hand').getByRole('listitem')).toHaveCount(count - 1);
    for (const page of pages) await expect(page.getByTestId('public-table')).toContainText(label);
    expect(commands[leader]!.filter((type) => type === 'play-card')).toHaveLength(1);
    expect(commands[1 - leader]!.filter((type) => type === 'play-card')).toHaveLength(0);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test('explicit wire fixture: mouse hand drag to public table sends exactly one existing play command', async ({
  browser,
  origin,
  wall,
}) => {
  const { contexts, pages } = await setup(browser, origin, wall, 2);
  try {
    const fixture = await installScenario(pages, small());
    const page = pages[0]!;
    await page.setViewportSize({ width: 1000, height: 2200 });
    const source = page.getByRole('button', { name: 'Play 6 of hearts', exact: true });
    await begin(page, source);
    await drop(page, page.getByTestId('public-table'));
    await expect(page.getByTestId('public-table')).toContainText('6 of hearts');
    await expect(page.getByTestId('own-hand').getByRole('listitem')).toHaveCount(1);
    expect(fixture.commands).toEqual([{ type: 'play-card', actor: 0 }]);
    await pages[1]!.getByRole('button', { name: 'Play 7 of hearts', exact: true }).press('Space');
    await expect(page.getByTestId('public-table').getByRole('listitem')).toHaveCount(0);
    expect(fixture.commands).toEqual([
      { type: 'play-card', actor: 0 },
      { type: 'play-card', actor: 1 },
    ]);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('explicit wire fixture: capture loss, resync, same-head epoch and source removal invalidate held gestures', async ({
  browser,
  origin,
  wall,
}) => {
  const { contexts, pages } = await setup(browser, origin, wall, 2);
  try {
    const fixture = await installScenario(pages, small());
    const page = pages[0]!;
    const source = page.getByRole('button', { name: 'Play 6 of hearts', exact: true });
    const start = await begin(page, source);
    await source.evaluate((button: HTMLButtonElement) => button.releasePointerCapture(1));
    // Pending capture changes are processed before the next native pointer event.
    await page.mouse.move(start.x + 13, start.y);
    await expect(page.getByTestId('gesture-drop-target')).toHaveCount(0);
    await page.mouse.up();
    expect(fixture.commands).toHaveLength(0);
    await begin(page, source);
    // Explicit lifecycle instrumentation while a pointer is held, not a new game command.
    await page
      .getByRole('button', { name: 'Resync game', exact: true })
      .evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.getByTestId('game-phase')).toHaveText('between-rounds');
    await page.mouse.up();
    expect(fixture.commands).toHaveLength(0);
    await begin(page, source);
    fixture.refresh(true);
    await expect(page.getByTestId('gesture-drop-target')).toHaveCount(0);
    await page.mouse.up();
    expect(fixture.commands).toHaveLength(0);
    // Keyboard action can remove the held source; its subsequent pointer release is not a new play.
    await begin(page, source);
    await source.press('Enter');
    await expect(source).toHaveCount(0);
    await page.mouse.up();
    expect(fixture.commands).toEqual([{ type: 'play-card', actor: 0 }]);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('mixed primary pointer event ordering cannot take over or click through a cancelled mouse gesture', async ({
  browser,
  origin,
  wall,
}) => {
  const { contexts, pages } = await setup(browser, origin, wall, 2);
  try {
    const fixture = await installScenario(pages, small());
    const page = pages[0]!;
    const original = page.getByRole('button', { name: 'Play 6 of hearts', exact: true });
    const competing = page.getByRole('button', { name: 'Play 6 of clubs', exact: true });
    const start = await begin(page, original);
    // Explicit adapter-order injection: touch and mouse can each be primary.
    // The original mouse is native; this secondary touchdown exercises document capture + React bubbling.
    await competing.dispatchEvent('pointerdown', {
      pointerId: 2,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      bubbles: true,
    });
    await expect(page.getByTestId('gesture-drop-target')).toHaveCount(0);
    await page.mouse.move(start.x, start.y);
    await page.mouse.up();
    await competing.dispatchEvent('pointerup', {
      pointerId: 2,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      bubbles: true,
    });
    await competing.dispatchEvent('click', { detail: 1 });
    expect(fixture.commands).toHaveLength(0);
    await original.click();
    await expect(page.getByTestId('public-table')).toContainText('6 of hearts');
    expect(fixture.commands).toEqual([{ type: 'play-card', actor: 0 }]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test('Chromium touch pipeline: touch drag/cancel, native keyboard alternative and scrolling outside sources', async ({
  browser,
  origin,
  wall,
}) => {
  const { contexts, pages } = await setup(browser, origin, wall, 2);
  try {
    const fixture = await installScenario(pages, small());
    const page = pages[0]!;
    await page.setViewportSize({ width: 390, height: 844 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
    const touch = async (
      type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel',
      x = 0,
      y = 0,
    ) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y, id: 0 }],
      });
    const source = page.getByRole('button', { name: 'Play 6 of hearts', exact: true });
    await source.scrollIntoViewIfNeeded();
    let start = await center(source);
    await touch('touchStart', start.x, start.y);
    await touch('touchMove', start.x + 20, start.y);
    await expect(page.getByTestId('gesture-drop-target')).toBeVisible();
    const target = await center(page.getByTestId('gesture-drop-target'));
    await touch('touchMove', target.x, target.y);
    await touch('touchEnd');
    await expect(page.getByTestId('own-hand').getByRole('listitem')).toHaveCount(1);
    expect(fixture.commands).toEqual([{ type: 'play-card', actor: 0 }]);
    const remaining = page.getByRole('button', { name: 'Play 6 of clubs', exact: true });
    await remaining.scrollIntoViewIfNeeded();
    start = await center(remaining);
    await touch('touchStart', start.x, start.y);
    await touch('touchMove', start.x + 20, start.y);
    await expect(page.getByTestId('gesture-drop-target')).toBeVisible();
    await touch('touchCancel');
    await expect(page.getByTestId('gesture-drop-target')).toHaveCount(0);
    expect(fixture.commands).toHaveLength(1);
    await remaining.press('Space');
    await expect(page.getByTestId('penalty-recipient')).toContainText('play-out-of-turn');
    expect(fixture.commands).toHaveLength(2);
    await page.evaluate(() => window.scrollTo(0, 0));
    await touch('touchStart', 8, 650);
    await touch('touchMove', 8, 250);
    await touch('touchEnd');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await cdp.detach();
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
