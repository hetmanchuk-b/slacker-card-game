import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './fixtures.ts';
import { setup, initialRecipient, deal } from './dealing-helpers.ts';

async function claim(page: Page, accused: string, key: string) {
  await page.getByLabel('Accused seat (required)').selectOption(accused);
  await page.getByLabel('Reason (required)').fill('<spoken social allegation>');
  await page.getByLabel('Exact spoken episode key (required)').fill(key);
  await page.getByRole('button', { name: 'Submit claim', exact: true }).click();
}
for (const count of [2, 4, 8])
  test(`real ${count}-seat manual spoken claims, sequential own-only ballots and abstention`, async ({
    browser,
    origin,
    wall,
  }) => {
    const { pages, contexts } = await setup(browser, origin, wall, count);
    try {
      const accused = await pages[1]!.getByTestId('seat-id').innerText();
      await claim(pages[0]!, accused, '  Exact manually entered Episode  ');
      for (const page of pages) await expect(page.getByTestId('claim-ballot')).toBeVisible();
      await expect(pages[1]!.getByRole('button', { name: 'Vote yes', exact: true })).toHaveCount(0);
      await expect(pages[0]!.getByLabel('Exact spoken episode key (required)')).toHaveValue('');
      // Queue a second explicit episode while the first procedure is still active.
      await claim(pages[0]!, accused, 'Next manual episode');
      for (const [index, page] of pages.filter((_, i) => i !== 1).entries()) {
        const name = count === 4 && index < 2 ? (index === 0 ? 'Vote yes' : 'Vote no') : 'Abstain';
        await page.getByRole('button', { name, exact: true }).click();
      }
      // All abstentions produce 0:0, no punishment; FIFO exposes the next claim.
      for (const page of pages)
        await expect(page.getByTestId('claim-ballot')).toContainText('spoken social allegation');
      await expect(pages[0]!.getByRole('button', { name: 'Abstain', exact: true })).toBeEnabled();
      for (const page of pages.filter((_, i) => i !== 1))
        await page.getByRole('button', { name: 'Vote no', exact: true }).click();
      for (const page of pages) await expect(page.getByTestId('claim-ballot')).toHaveCount(0);
      // Re-entering the same manual key is deliberate, but the server deduplicates it.
      await claim(pages[0]!, accused, 'Next manual episode');
      await expect(pages[0]!.getByTestId('claim-result')).toContainText('technically rejected');
      await expect(pages[0]!.getByTestId('claim-ballot')).toHaveCount(0);
    } finally {
      await Promise.all(contexts.map((c) => c.close()));
    }
  });

test('real chat and fresh action evidence use visible exact IDs, not text or card IDs', async ({
  browser,
  origin,
  wall,
}) => {
  const { pages, contexts } = await setup(browser, origin, wall, 2);
  try {
    const accused = await pages[1]!.getByTestId('seat-id').innerText();
    await pages[1]!.getByLabel('Chat message (required)').fill('Evidence message');
    await pages[1]!.getByRole('button', { name: 'Post chat message', exact: true }).click();
    await pages[0]!.getByRole('button', { name: 'Read chat from beginning', exact: true }).click();
    const page = pages[0]!;
    await page.getByLabel('Accused seat (required)').selectOption(accused);
    await page.getByLabel('Reason (required)').fill('Chat allegation');
    await page.getByLabel('Evidence type').selectOption('chat');
    const options = page.getByLabel('Exact message ID (required)').locator('option');
    const messageId = await options.nth(1).getAttribute('value');
    expect(messageId).toBeTruthy();
    await page.getByLabel('Exact message ID (required)').selectOption(messageId!);
    await page.getByRole('button', { name: 'Submit claim', exact: true }).click();
    await expect(page.getByTestId('claim-ballot')).toBeVisible();
    await page.getByRole('button', { name: 'Abstain', exact: true }).click();
    await expect(page.getByTestId('claim-ballot')).toHaveCount(0);
    const actor = await initialRecipient(pages);
    await pages[actor]!.getByRole('button', { name: 'Draw card', exact: true }).click();
    const claimant = pages[1 - actor]!;
    const actorId = await pages[actor]!.getByTestId('seat-id').innerText();
    await claimant.getByLabel('Accused seat (required)').selectOption(actorId);
    await claimant.getByLabel('Reason (required)').fill('Action allegation');
    await claimant.getByLabel('Evidence type').selectOption('action');
    const commandId = await claimant
      .getByLabel('Exact action command ID (required)')
      .locator('option')
      .last()
      .getAttribute('value');
    expect(commandId).toBeTruthy();
    await claimant.getByLabel('Exact action command ID (required)').selectOption(commandId!);
    await claimant.getByRole('button', { name: 'Submit claim', exact: true }).click();
    await expect(claimant.getByTestId('claim-ballot')).toContainText('Action allegation');
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('real silence deadline abstains without a locally invented verdict', async ({
  browser,
  origin,
  wall,
}) => {
  const { pages, contexts } = await setup(browser, origin, wall, 2);
  try {
    const accused = await pages[1]!.getByTestId('seat-id').innerText();
    await claim(pages[0]!, accused, 'Timeout episode');
    await expect(pages[0]!.getByTestId('claim-ballot')).toBeVisible();
    await expect(pages[0]!.getByTestId('claim-ballot')).toHaveCount(0, { timeout: 15000 });
    await expect(pages[0]!.getByTestId('game-phase')).toHaveText('dealing');
    await claim(pages[0]!, accused, 'Timeout episode');
    await expect(pages[0]!.getByTestId('claim-result')).toContainText('technically rejected');
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('real social verdicts identify accused/claimant punishment, ties punish nobody, and closed dealing action evidence rejects', async ({
  browser,
  origin,
  wall,
}) => {
  test.setTimeout(60000);
  const draws = new Map<string, string>();
  const rejections: string[] = [];
  const { pages, contexts } = await setup(browser, origin, wall, 2, async (page) => {
    page.on('websocket', (socket) =>
      socket.on('framereceived', (frame) => {
        const raw = String(frame.payload);
        if (!raw.startsWith('42')) return;
        const start = raw.indexOf('[');
        if (start < 0) return;
        const [event, message] = JSON.parse(raw.slice(start));
        if (event !== 'server-message') return;
        if (message.type === 'action') {
          for (const observation of message.view.observations) {
            if (observation.type === 'card-drawn')
              draws.set(observation.seatId, message.view.commandId);
          }
        }
        if (message.type === 'command-ack' && message.result.type === 'rejected')
          rejections.push(message.result.code);
      }),
    );
  });
  try {
    const { leader } = await deal(pages);
    wall.now += 1001;
    for (const page of pages)
      await expect(page.getByTestId('game-phase')).toHaveText('between-rounds', { timeout: 15000 });
    const ids = await Promise.all(pages.map((page) => page.getByTestId('seat-id').innerText()));
    // Choose a known HUMAN draw by seat 2, not a later system reveal-expiry action.
    // Public action observations bind its immutable actor and exact command ID.
    const claimant = pages[0]!;
    const dealingCommandId = draws.get(ids[1]!);
    expect(dealingCommandId).toBeTruthy();
    for (const [vote, recipient] of [
      ['yes', 1],
      ['no', 0],
      ['abstain', null],
    ] as const) {
      await claim(pages[0]!, ids[1]!, `Social verdict ${vote}`);
      await expect(pages[0]!.getByTestId('claim-ballot')).toBeVisible();
      await pages[0]!
        .getByRole('button', {
          name: vote === 'yes' ? 'Vote yes' : vote === 'no' ? 'Vote no' : 'Abstain',
          exact: true,
        })
        .click();
      for (const page of pages) await expect(page.getByTestId('claim-ballot')).toHaveCount(0);
      if (recipient !== null) {
        for (const page of pages)
          await expect(page.getByTestId('penalty-recipient')).toHaveText(
            `Seat ${recipient + 1} receives a penalty: claim.`,
          );
        await pages[1 - recipient]!.getByRole('button', {
          name: 'Refuse contribution',
          exact: true,
        }).click();
      }
      for (const page of pages) {
        await expect(page.getByTestId('penalty-procedure')).toHaveCount(0);
        await expect(page.getByTestId('game-phase')).toHaveText('between-rounds');
      }
    }
    // The first round play closes dealing evidence on the authoritative server.
    await pages[leader]!.getByTestId('own-hand').getByRole('button').first().click();
    for (const page of pages) await expect(page.getByTestId('game-phase')).toHaveText('round');
    await claimant.getByLabel('Accused seat (required)').selectOption(ids[1]!);
    await claimant.getByLabel('Reason (required)').fill('Closed dealing action');
    await claimant.getByLabel('Evidence type').selectOption('action');
    await claimant.getByLabel('Exact action command ID (required)').selectOption(dealingCommandId!);
    await claimant.getByRole('button', { name: 'Submit claim', exact: true }).click();
    await expect(claimant.getByTestId('claim-result')).toContainText('technically rejected');
    await expect.poll(() => rejections.at(-1)).toBe('scope-closed');
    for (const page of pages) {
      await expect(page.getByTestId('claim-ballot')).toHaveCount(0);
      await expect(page.getByTestId('penalty-procedure')).toHaveCount(0);
      await expect(page.getByTestId('game-phase')).toHaveText('round');
    }
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
