import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './fixtures.ts';
import { setup } from './dealing-helpers.ts';

test('real UI rollback: native cancel/focus, lost acknowledgment exact retry, null state, retained chat/fork and participant notice', async ({
  browser,
  origin,
  wall,
}) => {
  let lose = true;
  const requests: unknown[] = [];
  const notices: unknown[] = [];
  const { contexts, pages } = await setup(browser, origin, wall, 2, async (page) => {
    await page.routeWebSocket('**/socket.io/**', (route) => {
      const server = route.connectToServer();
      route.onMessage((frame) => {
        if (typeof frame === 'string' && frame.startsWith('42')) {
          const t = JSON.parse(frame.slice(frame.indexOf('[')));
          if (t[0] === 'client-message' && t[1]?.intent?.type === 'rollback') requests.push(t[1]);
        }
        server.send(frame);
      });
      server.onMessage(async (frame) => {
        if (typeof frame === 'string' && frame.startsWith('42')) {
          const t = JSON.parse(frame.slice(frame.indexOf('[')));
          if (t[0] === 'server-message' && t[1]?.type === 'rollback-notice')
            notices.push(t[1].notice);
          if (lose && t[0] === 'server-message' && t[1]?.type === 'command-ack') {
            lose = false;
            await route.close();
            return;
          }
        }
        route.send(frame);
      });
    });
  });
  const owner = pages[0]!,
    member = pages[1]!;
  try {
    const text = '  <private memory is not erased> 😀\noriginal  ';
    await owner.getByLabel('Chat message (required)').fill(text);
    await owner.getByRole('button', { name: 'Post chat message', exact: true }).click();
    await expect(owner.getByTestId('chat-status')).toHaveText('Chat reply confirmed.');
    const originalContext = await owner.getByTestId('chat-message').innerText();
    await owner.getByRole('button', { name: 'Refresh owner history', exact: true }).click();
    await expect(owner.getByText('History: complete.', { exact: false })).toBeVisible();
    await owner.getByLabel('Select branch 1 action 1', { exact: true }).check();
    const review = owner.getByRole('button', { name: 'Review selected rollback', exact: true });
    await review.click();
    const modal = owner.getByRole('dialog', { name: 'Confirm owner rollback' });
    await expect(modal).toBeVisible();
    await expect(modal.getByText(/cannot erase human memory/)).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Cancel rollback' })).toBeFocused();
    await owner.keyboard.press('Escape');
    await expect(modal).not.toBeVisible();
    await expect(review).toBeFocused();
    expect(requests).toHaveLength(0);
    await review.click();
    await modal.getByRole('button', { name: 'Confirm rollback — I understand' }).click();
    await expect(owner.getByTestId('rollback-status')).toContainText('uncertain');
    await expect(member.getByTestId('rollback-notice')).toContainText('before branch 1, action 1');
    await expect(member.getByTestId('game-null-state')).toBeVisible();
    await owner.getByRole('button', { name: 'Connect game', exact: true }).click();
    await expect(owner.getByTestId('game-null-state')).toBeVisible();
    await expect(owner.getByTestId('rollback-notice')).toHaveCount(0);
    await owner.getByRole('button', { name: 'Retry original rollback', exact: true }).click();
    await expect(owner.getByTestId('rollback-status')).toContainText('accepted');
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(notices).toHaveLength(1);
    expect(Object.keys(notices[0] as object).sort()).toEqual(['actorId', 'head', 'target']);
    expect(JSON.stringify(notices)).not.toMatch(/cardId|face|ownVote|events|commandId/);
    await expect(owner.getByTestId('chat-message')).toHaveText(originalContext);
    await owner.getByRole('button', { name: 'Refresh owner history', exact: true }).click();
    await expect(owner.getByRole('rowheader', { name: /abandoned/ })).toBeVisible();
    await expect(
      owner.getByRole('rowheader', { name: 'Rollback audit 1', exact: true }),
    ).toBeVisible();
    expect(await owner.locator('.owner-history').innerText()).not.toMatch(/cardId|ownVote|opaque-/);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('real UI rollback confirmation rejects stale snapshot without automatic retarget and clears uncontrolled evidence', async ({
  browser,
  origin,
  wall,
}) => {
  const { contexts, pages } = await setup(browser, origin, wall, 2);
  const owner = pages[0]!,
    member = pages[1]!;
  try {
    await owner.getByLabel('Reason (required)', { exact: true }).fill('obsolete reason');
    await owner
      .getByLabel('Exact spoken episode key (required)', { exact: true })
      .fill('obsolete evidence');
    await owner.getByRole('button', { name: 'Refresh owner history', exact: true }).click();
    await owner.getByLabel('Select branch 1 action 1', { exact: true }).check();
    await owner.getByRole('button', { name: 'Review selected rollback', exact: true }).click();
    await member.getByRole('button', { name: 'Disconnect game', exact: true }).click();
    const modal = owner.getByRole('dialog');
    await expect(modal.getByText(/Selection or history changed/)).toBeVisible();
    await expect(
      modal.getByRole('button', { name: 'Confirm rollback — I understand' }),
    ).toBeDisabled();
    await modal.getByRole('button', { name: 'Cancel rollback' }).click();
    await owner.getByRole('button', { name: 'Refresh owner history', exact: true }).click();
    await owner.getByLabel('Select branch 1 action 1', { exact: true }).check();
    await owner.getByRole('button', { name: 'Review selected rollback', exact: true }).click();
    await modal.getByRole('button', { name: 'Confirm rollback — I understand' }).click();
    await expect(owner.getByTestId('game-null-state')).toBeVisible();
    await expect(owner.getByLabel('Reason (required)', { exact: true })).toHaveValue('');
    await expect(
      owner.getByLabel('Exact spoken episode key (required)', { exact: true }),
    ).toHaveValue('');
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

import { installRollbackFixture } from './rollback-fixture.ts';
import { scenario, heart, club, step, cardId } from '../../src/game/testing/scenarios.ts';
import { id } from '../../src/game/ids.ts';
import { GameRuntime } from '../../src/runtime/runtime.ts';
import type { RuntimeSnapshot } from '../../src/runtime/runtime.ts';
import { fixture } from '../../src/runtime/testing/fixtures.ts';
import { finishMatch } from '../../src/runtime/testing/match.ts';
async function confirmFixtureRollback(page: Page) {
  await page.getByRole('button', { name: 'Refresh owner history', exact: true }).click();
  await page.getByLabel('Select branch 1 action 1', { exact: true }).check();
  await page.getByRole('button', { name: 'Review selected rollback', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm rollback — I understand', exact: true }).click();
}
test('explicit engine/projector wire fixture scenario 17: rollback restores table order, private hands, N and turn', async ({
  browser,
  origin,
  wall,
}) => {
  const initial = scenario({
    hands: [[club(6)], [heart(12), club(7)], [club(8)], [club(9)]],
    table: [heart(10)],
    turn: 1,
  });
  const played = step(initial, {
    type: 'play-card',
    id: id('command', 'beat'),
    actorId: initial.players[1]!.id,
    cardId: cardId(initial, heart(12)),
  });
  const abandoned = step(played, {
    type: 'take-bottom',
    id: id('command', 'take'),
    actorId: initial.players[2]!.id,
  });
  const snapshot = (state: typeof initial, branchId: string): RuntimeSnapshot => ({
    head: { gameId: state.gameId, branchId: id('branch', branchId), version: 1 },
    state,
    paused: false,
    connections: state.players.map((p) => ({
      seatId: p.id,
      connected: true,
      controller: 'human',
      disconnectedAtMs: null,
    })),
    replacementVote: null,
    controlEvents: [],
  });
  const { contexts, pages } = await setup(browser, origin, wall, 4);
  try {
    const packets = await installRollbackFixture(
      pages,
      snapshot(abandoned, 'old'),
      snapshot(initial, 'new'),
    );
    await expect(pages[0]!.getByTestId('public-table')).toContainText('Q');
    const dragged = pages[1]!.getByTestId('own-hand').getByRole('button').first();
    await dragged.scrollIntoViewIfNeeded();
    const box = (await dragged.boundingBox())!;
    await pages[1]!.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await pages[1]!.mouse.down();
    await pages[1]!.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, { steps: 3 });
    await expect(pages[1]!.getByTestId('gesture-drop-target')).toBeVisible();
    await confirmFixtureRollback(pages[0]!);
    await expect(pages[1]!.getByTestId('gesture-drop-target')).toHaveCount(0);
    await pages[1]!.mouse.up();
    for (const page of pages) {
      await expect(page.getByTestId('public-table').getByRole('listitem')).toHaveCount(1);
      await expect(page.getByTestId('public-table')).toContainText('10');
      await expect(page.getByTestId('round-context')).toContainText('Seat 2');
      await expect(page.getByTestId('round-context')).toContainText('4');
      await expect(page.getByTestId('rollback-notice')).toBeVisible();
    }
    await expect(pages[1]!.getByTestId('own-hand')).toContainText('Q');
    await expect(pages[2]!.getByTestId('own-hand').getByRole('listitem')).toHaveCount(1);
    expect(JSON.stringify(packets[0])).not.toContain('card-played');
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
test('explicit runtime/projector wire fixture scenario 18: finished restore six-second ballot with current absent participant stays paused', async ({
  browser,
  origin,
  wall,
}) => {
  const { options, clock, history, seats } = fixture('withdrawal', 2);
  const runtime = await GameRuntime.create(options);
  let before: RuntimeSnapshot, restored: RuntimeSnapshot;
  try {
    await clock.advanceBy(20000);
    for (let draw = 0; draw < 36; draw++) {
      const phase = runtime.read().state!.phase;
      if (phase.type !== 'dealing') throw Error('Expected dealing');
      expect(
        (
          await runtime.dispatch(
            { type: 'draw-card', id: id('command', `draw-${draw}`), actorId: phase.nextSeatId },
            { branchId: runtime.read().head.branchId },
          )
        ).type,
      ).toBe('accepted');
    }
    await clock.advanceBy(10000);
    await finishMatch(runtime);
    await runtime.dispatch({
      type: 'disconnect',
      id: id('command', 'absent-after-finish'),
      seatId: seats[1]!,
    });
    before = runtime.read();
    expect(before.state!.phase.type).toBe('finished');
    expect(
      (
        await runtime.dispatch({
          type: 'rollback',
          id: id('command', 'restore'),
          actorId: seats[0]!,
          expected: history.read().head,
          beforeCommandId: id('command', 'withdraw'),
          knowledgeWarningAcknowledged: true,
        })
      ).type,
    ).toBe('accepted');
    restored = runtime.read();
    expect(restored.paused).toBe(true);
    expect(restored.state!.procedure!.timer.remainingMs).toBe(6000);
  } finally {
    await runtime.dispose();
  }
  const { contexts, pages } = await setup(browser, origin, wall, 2);
  try {
    await installRollbackFixture(pages, before!, restored!);
    await expect(pages[0]!.getByTestId('game-phase')).toHaveText('finished');
    await confirmFixtureRollback(pages[0]!);
    for (const page of pages) {
      await expect(page.getByTestId('game-paused')).toHaveText('Paused');
      await expect(page.getByTestId('claim-ballot').getByTestId('procedure-time')).toHaveText(
        'Paused: 6s',
      );
      await page.clock.fastForward(7000);
      await expect(page.getByTestId('claim-ballot').getByTestId('procedure-time')).toHaveText(
        'Paused: 6s',
      );
      await expect(page.getByTestId('game-phase')).toHaveText('dealing');
    }
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
