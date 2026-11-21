import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './fixtures.ts';
import { setup, deal } from './dealing-helpers.ts';

async function claim(page: Page, accused: string, key: string) {
  await page.getByLabel('Accused seat (required)').selectOption(accused);
  await page.getByLabel('Reason (required)').fill('Withdrawal test allegation');
  await page.getByLabel('Exact spoken episode key (required)').fill(key);
  await page.getByRole('button', { name: 'Submit claim', exact: true }).click();
  await expect(page.getByTestId('claim-ballot')).toBeVisible();
}
for (const outcome of ['approval', 'denial', 'silence'] as const)
  test(`real withdrawal ${outcome} preserves own ballot and separate deadlines`, async ({
    browser,
    origin,
    wall,
  }) => {
    test.setTimeout(45000);
    const procedures: {
      type: string;
      timer: { remainingMs: number };
      suspendedVote?: { timer: { remainingMs: number } };
    }[] = [];
    const { pages, contexts } = await setup(browser, origin, wall, 4, async (page) => {
      page.on('websocket', (socket) =>
        socket.on('framereceived', (frame) => {
          const raw = String(frame.payload);
          if (!raw.startsWith('42')) return;
          const [event, message] = JSON.parse(raw.slice(raw.indexOf('[')));
          if (event === 'server-message' && message.type === 'state' && message.view.procedure)
            procedures.push(message.view.procedure);
        }),
      );
    });
    try {
      const ids = await Promise.all(pages.map((p) => p.getByTestId('seat-id').innerText()));
      await claim(pages[0]!, ids[1]!, `Withdrawal ${outcome}`);
      await pages[2]!.getByRole('button', { name: 'Vote yes', exact: true }).click();
      await expect(pages[2]!.getByTestId('claim-ballot')).toContainText('Your confirmed vote: yes');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await pages[0]!.getByRole('button', { name: 'Request withdrawal', exact: true }).click();
      for (const page of pages) {
        await expect(page.getByTestId('withdrawal-procedure')).toBeVisible();
        await expect(page.getByTestId('claim-ballot').getByTestId('procedure-time')).toContainText(
          'Paused',
        );
      }
      await expect(
        pages[0]!.getByRole('button', { name: 'Approve withdrawal', exact: true }),
      ).toHaveCount(0);
      const frozenBallotMs = procedures.at(-1)!.suspendedVote!.timer.remainingMs;
      expect(frozenBallotMs).toBeLessThan(9000);
      expect(frozenBallotMs).toBeGreaterThan(0);
      expect(procedures.at(-1)!.timer.remainingMs).toBeLessThanOrEqual(10000);
      expect(procedures.at(-1)!.timer.remainingMs).toBeGreaterThan(9500);
      if (outcome === 'silence') {
        await pages[0]!.clock.fastForward(10001);
        await expect(
          pages[0]!.getByTestId('withdrawal-procedure').getByTestId('procedure-time'),
        ).toContainText('Awaiting server completion');
        await expect(pages[0]!.getByTestId('withdrawal-procedure')).toBeVisible();
      }
      if (outcome === 'approval') {
        // Accused must consent too; two approvals cannot finish the procedure.
        for (const index of [2, 3]) {
          await pages[index]!.getByRole('button', {
            name: 'Approve withdrawal',
            exact: true,
          }).click();
          await expect(pages[index]!.getByTestId('withdrawal-procedure')).toContainText(
            'Your confirmed approval: yes',
          );
        }
        await expect(pages[1]!.getByTestId('withdrawal-procedure')).toContainText(
          'No confirmed approval from you',
        );
        await pages[1]!.getByRole('button', { name: 'Approve withdrawal', exact: true }).click();
        for (const page of pages) {
          await expect(page.getByTestId('claim-ballot')).toHaveCount(0);
          await expect(page.getByTestId('withdrawal-procedure')).toHaveCount(0);
          await expect(page.getByTestId('penalty-procedure')).toHaveCount(0);
        }
      } else {
        if (outcome === 'denial')
          await pages[1]!.getByRole('button', { name: 'Refuse withdrawal', exact: true }).click();
        for (const page of pages)
          await expect(page.getByTestId('withdrawal-procedure')).toHaveCount(0, { timeout: 15000 });
        // The wire projection may already have consumed a few real milliseconds
        // after resume; it must never restart the original ten-second duration.
        const resumedMs = procedures.findLast((p) => p.type === 'claim-vote')!.timer.remainingMs;
        expect(resumedMs).toBeLessThanOrEqual(frozenBallotMs);
        expect(resumedMs).toBeGreaterThan(frozenBallotMs - 500);
        await expect(pages[2]!.getByTestId('claim-ballot')).toContainText(
          'Your confirmed vote: yes',
        );
        await expect(pages[0]!.getByRole('button', { name: 'Vote no', exact: true })).toBeEnabled();
      }
    } finally {
      await Promise.all(contexts.map((c) => c.close()));
    }
  });

test('real nested disconnect freezes consent and suspended ballot separately; denial resumes original ballot', async ({
  browser,
  origin,
  wall,
}) => {
  const { pages, contexts } = await setup(browser, origin, wall, 4);
  try {
    const accused = await pages[1]!.getByTestId('seat-id').innerText();
    await claim(pages[0]!, accused, 'Nested withdrawal pause');
    await pages[2]!.getByRole('button', { name: 'Vote yes', exact: true }).click();
    await expect(pages[2]!.getByTestId('claim-ballot')).toContainText('Your confirmed vote: yes');
    await pages[0]!.getByRole('button', { name: 'Request withdrawal', exact: true }).click();
    await expect(pages[0]!.getByTestId('withdrawal-procedure')).toBeVisible();
    const ballot = pages[0]!.getByTestId('claim-ballot').getByTestId('procedure-time');
    const consent = pages[0]!.getByTestId('withdrawal-procedure').getByTestId('procedure-time');
    const original = await ballot.innerText();
    await pages[3]!.getByRole('button', { name: 'Disconnect game', exact: true }).click();
    await expect(consent).toContainText('Paused');
    const frozen = await consent.innerText();
    await pages[0]!.clock.fastForward(20000);
    await expect(consent).toHaveText(frozen);
    await expect(ballot).toHaveText(original);
    await pages[3]!.getByRole('button', { name: 'Connect game', exact: true }).click();
    await expect(pages[0]!.getByTestId('game-paused')).toHaveText('Running');
    await expect(ballot).toHaveText(original);
    await pages[1]!.getByRole('button', { name: 'Refuse withdrawal', exact: true }).click();
    await expect(pages[0]!.getByTestId('withdrawal-procedure')).toHaveCount(0);
    await expect(pages[2]!.getByTestId('claim-ballot')).toContainText('Your confirmed vote: yes');
    await expect(
      pages[2]!.getByTestId('claim-ballot').getByTestId('procedure-time'),
    ).not.toContainText('Paused');
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('real delayed withdrawal request cannot cancel punishment after the cutoff', async ({
  browser,
  origin,
  wall,
}) => {
  test.setTimeout(60000);
  let held: (() => void) | undefined;
  let heldRequest = '';
  let rejection = '';
  const { pages, contexts } = await setup(browser, origin, wall, 4, async (page) => {
    await page.routeWebSocket('**/socket.io/**', (route) => {
      const server = route.connectToServer();
      route.onMessage((frame) => {
        if (typeof frame === 'string' && frame.startsWith('42')) {
          const [event, message] = JSON.parse(frame.slice(frame.indexOf('[')));
          if (event === 'client-message' && message.intent?.type === 'request-withdrawal') {
            heldRequest = message.requestId;
            held = () => server.send(frame);
            return;
          }
        }
        server.send(frame);
      });
      server.onMessage((frame) => {
        if (typeof frame === 'string' && frame.startsWith('42')) {
          const [event, message] = JSON.parse(frame.slice(frame.indexOf('[')));
          if (
            event === 'server-message' &&
            message.type === 'command-ack' &&
            message.requestId === heldRequest
          )
            rejection = message.result.code;
        }
        route.send(frame);
      });
    });
  });
  try {
    await deal(pages);
    wall.now += 1001;
    for (const page of pages)
      await expect(page.getByTestId('game-phase')).toHaveText('between-rounds', { timeout: 15000 });
    const accused = await pages[1]!.getByTestId('seat-id').innerText();
    await claim(pages[0]!, accused, 'Cutoff original request');
    await pages[0]!.getByRole('button', { name: 'Vote yes', exact: true }).click();
    await expect(pages[0]!.getByTestId('claim-ballot')).toContainText('Your confirmed vote: yes');
    await pages[0]!.getByRole('button', { name: 'Request withdrawal', exact: true }).click();
    await expect.poll(() => !!held).toBe(true);
    // Independent seats can answer concurrently within the real ballot deadline.
    await Promise.all(
      [2, 3].map((index) =>
        pages[index]!.getByRole('button', { name: 'Vote yes', exact: true }).click(),
      ),
    );
    for (const page of pages) await expect(page.getByTestId('penalty-procedure')).toBeVisible();
    held!();
    await expect.poll(() => rejection).toBe('punishment-started');
    for (const page of pages) {
      await expect(page.getByTestId('penalty-procedure')).toBeVisible();
      await expect(page.getByTestId('withdrawal-procedure')).toHaveCount(0);
    }
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
