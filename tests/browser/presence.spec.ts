import { expect } from '@playwright/test';
import { test } from './fixtures.ts';
import { setup, initialRecipient } from './dealing-helpers.ts';

// Real HTTPS/authenticated transport/PostgreSQL with the runtime's real monotonic clock.
// Exact 30000/30001 boundary remains covered by src/runtime/replacement.test.ts.
test('real multiple tabs and absences; return cancels replacement while nested gameplay stays frozen', async ({
  browser,
  origin,
  wall,
}) => {
  test.setTimeout(65000);
  const { pages, contexts } = await setup(browser, origin, wall, 4);
  try {
    const ids = await Promise.all(pages.map((p) => p.getByTestId('seat-id').innerText()));
    const opened = contexts[3]!.waitForEvent('page');
    await pages[3]!.getByRole('link', { name: 'Open lobby in another tab' }).click();
    const tab = await opened;
    await tab.getByRole('button', { name: 'Restore my seat', exact: true }).click();
    await tab.getByRole('button', { name: 'Connect game', exact: true }).click();
    await expect(tab.getByTestId('game-phase')).toHaveText('dealing');
    await pages[3]!.getByRole('button', { name: 'Disconnect game', exact: true }).click();
    await expect(pages[0]!.getByTestId(`presence-${ids[3]}`)).toContainText('Connected');
    await expect(pages[0]!.getByTestId('game-paused')).toHaveText('Running');
    // Create real nested claim/withdrawal clocks before the final tab leaves.
    await pages[0]!.getByLabel('Accused seat (required)').selectOption(ids[1]!);
    await pages[0]!.getByLabel('Reason (required)').fill('Presence nested pause');
    await pages[0]!.getByLabel('Exact spoken episode key (required)').fill('Presence episode');
    await pages[0]!.getByRole('button', { name: 'Submit claim', exact: true }).click();
    await expect(pages[0]!.getByTestId('claim-ballot')).toBeVisible();
    await pages[0]!.getByRole('button', { name: 'Request withdrawal', exact: true }).click();
    await expect(pages[0]!.getByTestId('withdrawal-procedure')).toBeVisible();
    await tab.getByRole('button', { name: 'Disconnect game', exact: true }).click();
    await pages[2]!.getByRole('button', { name: 'Disconnect game', exact: true }).click();
    await expect(pages[0]!.getByTestId('game-paused')).toHaveText('Paused');
    const consent = pages[0]!.getByTestId('withdrawal-procedure').getByTestId('procedure-time');
    const ballot = pages[0]!.getByTestId('claim-ballot').getByTestId('procedure-time');
    await expect(consent).toContainText('Paused');
    const frozen = await consent.innerText();
    const frozenBallot = await ballot.innerText();
    const proposal = pages[0]!.getByRole('button', { name: 'Propose bot for Seat 4', exact: true });
    await proposal.focus();
    await pages[0]!.keyboard.press('Enter');
    await expect(pages[0]!.getByTestId('replacement-feedback')).toContainText('exceed 30 seconds');
    await new Promise((resolve) => setTimeout(resolve, 30100));
    await proposal.click();
    await expect(pages[0]!.getByTestId('replacement-vote')).toBeVisible();
    await pages[0]!.clock.fastForward(2500);
    await expect(
      pages[0]!.getByTestId('replacement-vote').getByTestId('procedure-time'),
    ).toContainText('8s');
    await expect(consent).toHaveText(frozen);
    await expect(ballot).toHaveText(frozenBallot);
    await pages[0]!.getByRole('button', { name: 'Replacement vote yes', exact: true }).click();
    await expect(pages[0]!.getByTestId('replacement-vote')).toContainText(
      'Your confirmed vote: yes',
    );
    await pages[0]!.clock.fastForward(10001);
    await expect(
      pages[0]!.getByTestId('replacement-vote').getByTestId('procedure-time'),
    ).toContainText('Awaiting server completion');
    await expect(pages[0]!.getByTestId('replacement-vote')).toBeVisible();
    await pages[3]!.getByRole('button', { name: 'Connect game', exact: true }).click();
    await expect(pages[0]!.getByTestId('replacement-vote')).toHaveCount(0);
    await expect(pages[0]!.getByTestId('game-paused')).toHaveText('Paused');
    await expect(pages[0]!.getByTestId(`presence-${ids[2]}`)).toContainText('Absent');
    await expect(consent).toHaveText(frozen);
    await pages[2]!.getByRole('button', { name: 'Connect game', exact: true }).click();
    await expect(pages[0]!.getByTestId('game-paused')).toHaveText('Running');
    await expect(consent).not.toContainText('Paused');
    await expect(ballot).toHaveText(frozenBallot);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('real replacement timeout during pause, no-human suspension, automatic human handback with state-only reconnect', async ({
  browser,
  origin,
  wall,
  pool,
}) => {
  test.setTimeout(65000);
  const { pages, contexts } = await setup(browser, origin, wall, 2);
  try {
    const ids = await Promise.all(pages.map((p) => p.getByTestId('seat-id').innerText()));
    const gameId = await pages[0]!.getByTestId('game-id').innerText();
    const first = await initialRecipient(pages);
    await pages[first]!.getByRole('button', { name: 'Draw card', exact: true }).click();
    await expect(pages[1]!.getByTestId('draw-actor')).toContainText('drew');
    await pages[1]!.getByRole('button', { name: 'Disconnect game', exact: true }).click();
    await expect(pages[0]!.getByTestId('game-paused')).toHaveText('Paused');
    await new Promise((resolve) => setTimeout(resolve, 30100));
    await pages[0]!.getByRole('button', { name: 'Propose bot for Seat 2', exact: true }).click();
    await expect(pages[0]!.getByTestId('replacement-vote')).toBeVisible();
    // No ballots: server deadline completes independently of frozen gameplay.
    await expect(pages[0]!.getByTestId('replacement-vote')).toHaveCount(0, { timeout: 15000 });
    await expect(pages[0]!.getByTestId(`presence-${ids[1]}`)).toContainText('Human control');
    await pages[0]!.getByRole('button', { name: 'Propose bot for Seat 2', exact: true }).click();
    await expect(pages[0]!.getByTestId('replacement-vote')).toBeVisible();
    await pages[0]!.getByRole('button', { name: 'Replacement vote yes', exact: true }).click();
    await expect(pages[0]!.getByTestId(`presence-${ids[1]}`)).toContainText('Bot control');
    await expect(pages[0]!.getByTestId('game-paused')).toHaveText('Running');
    await pages[0]!.getByRole('button', { name: 'Disconnect game', exact: true }).click();
    // No connected human can observe live pause. Inspect only the private committed
    // clock discriminator in the test harness; never send this frame to a browser.
    await expect
      .poll(async () => {
        const r = await pool.query(
          `SELECT f.payload->'snapshot'->'state'->'clock'->>'type' AS clock
        FROM penky_game_frames f JOIN penky_game_heads h USING(game_id)
        WHERE f.game_id=$1 AND f.revision=h.revision`,
          [gameId],
        );
        return r.rows[0]?.clock;
      })
      .toBe('suspended');
    await pages[1]!.getByRole('button', { name: 'Connect game', exact: true }).click();
    await expect(pages[1]!.getByTestId(`presence-${ids[1]}`)).toContainText('Human control');
    await expect(pages[1]!.getByTestId('game-paused')).toHaveText('Paused');
    await expect(pages[1]!.getByTestId('draw-actor')).toHaveText('');
    await pages[0]!.getByRole('button', { name: 'Connect game', exact: true }).click();
    await expect(pages[1]!.getByTestId('game-paused')).toHaveText('Running');
    await expect(pages[1]!.getByRole('button', { name: 'Draw card', exact: true })).toBeEnabled();
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
