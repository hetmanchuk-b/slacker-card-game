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
      const firstClaim = await pages[0]!
        .getByTestId('claim-ballot')
        .locator('p')
        .first()
        .innerText();
      // Queue a second explicit episode while the first procedure is still active.
      await claim(pages[0]!, accused, 'Next manual episode');
      await Promise.all(
        pages
          .filter((_, i) => i !== 1)
          .map(async (page, index) => {
            const name =
              count === 4 && index < 2 ? (index === 0 ? 'Vote yes' : 'Vote no') : 'Abstain';
            await page.getByRole('button', { name, exact: true }).click();
          }),
      );
      // All abstentions produce 0:0, no punishment; FIFO exposes the next claim.
      await Promise.all(
        pages.map(async (page) => {
          await expect(page.getByTestId('claim-ballot')).toContainText('spoken social allegation');
          await expect(page.getByTestId('claim-ballot').locator('p').first()).not.toHaveText(
            firstClaim,
          );
        }),
      );
      await expect(pages[0]!.getByRole('button', { name: 'Abstain', exact: true })).toBeEnabled();
      await Promise.all(
        pages
          .filter((_, i) => i !== 1)
          .map((page) => page.getByRole('button', { name: 'Vote no', exact: true }).click()),
      );
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

for (const claimFirst of [true, false])
  test(`real controlled boundary scheduling: ${claimFirst ? 'claim-first' : 'play-first'} and stale ballot isolation`, async ({
    browser,
    origin,
    wall,
  }) => {
    test.setTimeout(90000);
    // These are controlled arrival orders, not an uncontrolled timing race. Only
    // original browser frames are delayed; all replies/state come from HTTPS/PG.
    const held = new Map<string, { requestId: string; release: () => void }>();
    const hold = new Set<string>();
    const acks = new Map<string, { type: string; code?: string }>();
    const draws = new Map<string, string>();
    const ballots = new Map<
      Page,
      { claim: { reason: string }; ownVote: string | null; timer: { id: string } } | null
    >();
    const votes: { requestId: string; procedureId: string }[] = [];
    async function intercept(page: Page) {
      await page.routeWebSocket('**/socket.io/**', (route) => {
        const server = route.connectToServer();
        route.onMessage((frame) => {
          if (typeof frame === 'string' && frame.startsWith('42')) {
            const [event, message] = JSON.parse(frame.slice(frame.indexOf('[')));
            if (event === 'client-message') {
              const type = message.intent?.type;
              if (type === 'cast-vote')
                votes.push({
                  requestId: message.requestId,
                  procedureId: message.intent.procedureId,
                });
              if (hold.delete(type)) {
                held.set(type, { requestId: message.requestId, release: () => server.send(frame) });
                return;
              }
            }
          }
          server.send(frame);
        });
        server.onMessage((frame) => {
          if (typeof frame === 'string' && frame.startsWith('42')) {
            const [event, message] = JSON.parse(frame.slice(frame.indexOf('[')));
            if (event === 'server-message') {
              if (message.type === 'command-ack') acks.set(message.requestId, message.result);
              if (message.type === 'state')
                ballots.set(
                  page,
                  message.view.procedure?.type === 'claim-vote' ? message.view.procedure : null,
                );
              if (message.type === 'action')
                for (const observation of message.view.observations)
                  if (observation.type === 'card-drawn')
                    draws.set(observation.seatId, message.view.commandId);
            }
          }
          route.send(frame);
        });
      });
    }
    const { pages, contexts } = await setup(browser, origin, wall, 4, intercept, true);
    try {
      for (const page of pages) await expect(page.getByTestId('game-paused')).toHaveText('Running');
      const { leader } = await deal(pages);
      wall.now += 1001;
      for (const page of pages)
        await expect(page.getByTestId('game-phase')).toHaveText('between-rounds', {
          timeout: 15000,
        });
      const claimantIndex = (leader + 1) % 4;
      const accusedIndex = (claimantIndex + 1) % 4;
      const claimant = pages[claimantIndex]!;
      const ids = await Promise.all(pages.map((page) => page.getByTestId('seat-id').innerText()));
      const drawId = draws.get(ids[accusedIndex]!);
      expect(drawId).toBeTruthy();
      hold.add('submit-claim');
      hold.add('play-card');
      await claimant.getByLabel('Accused seat (required)').selectOption(ids[accusedIndex]!);
      await claimant.getByLabel('Reason (required)').fill('Boundary draw evidence');
      await claimant.getByLabel('Evidence type').selectOption('action');
      await claimant.getByLabel('Exact action command ID (required)').selectOption(drawId!);
      await claimant.getByRole('button', { name: 'Submit claim', exact: true }).click();
      await pages[leader]!.getByTestId('own-hand').getByRole('button').first().click();
      await expect.poll(() => held.size).toBe(2);
      const first = held.get(claimFirst ? 'submit-claim' : 'play-card')!;
      const second = held.get(claimFirst ? 'play-card' : 'submit-claim')!;
      first.release();
      await expect.poll(() => acks.get(first.requestId)?.type).toBe('accepted');
      second.release();
      await expect
        .poll(() => acks.get(second.requestId)?.code)
        .toBe(claimFirst ? 'procedure-active' : 'scope-closed');
      for (const page of pages) {
        await expect(page.getByTestId('game-phase')).toHaveText(
          claimFirst ? 'between-rounds' : 'round',
        );
        await expect(page.getByTestId('claim-ballot')).toHaveCount(claimFirst ? 1 : 0);
        await expect(page.getByTestId('penalty-procedure')).toHaveCount(0);
      }
      if (!claimFirst) await claim(claimant, ids[accusedIndex]!, 'First round ballot');
      await expect(claimant.getByRole('button', { name: 'Vote yes', exact: true })).toBeEnabled();
      const oldProcedure = ballots.get(claimant)!.timer.id;
      hold.add('cast-vote');
      await claimant.getByRole('button', { name: 'Vote yes', exact: true }).click();
      await expect.poll(() => held.has('cast-vote')).toBe(true);
      // Leave every other voter silent: only the real server deadline settles A.
      for (const page of pages)
        await expect(page.getByTestId('claim-ballot')).toHaveCount(0, { timeout: 15000 });
      const nextClaimant = pages[(claimantIndex + 2) % 4]!;
      await claim(nextClaimant, ids[accusedIndex]!, 'Replacement ballot');
      for (const page of pages)
        await expect(page.getByTestId('claim-ballot')).toContainText('spoken social allegation');
      const newProcedure = ballots.get(claimant)!.timer.id;
      expect(newProcedure).not.toBe(oldProcedure);
      expect(ballots.get(claimant)!.ownVote).toBeNull();
      const stale = held.get('cast-vote')!;
      stale.release();
      await expect.poll(() => acks.get(stale.requestId)?.code).toBe('stale-timer');
      // The late original yes vote is rejected, never rewritten for ballot B.
      expect(votes.filter((vote) => vote.requestId === stale.requestId)).toEqual([
        { requestId: stale.requestId, procedureId: oldProcedure },
      ]);
      expect(ballots.get(claimant)!.timer.id).toBe(newProcedure);
      expect(ballots.get(claimant)!.ownVote).toBeNull();
      await expect(claimant.getByRole('button', { name: 'Vote yes', exact: true })).toBeEnabled();
      for (const page of pages) await expect(page.getByTestId('penalty-procedure')).toHaveCount(0);
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  });
