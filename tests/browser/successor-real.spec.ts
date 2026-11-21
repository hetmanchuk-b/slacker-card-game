import { expect } from '@playwright/test';
import { test } from './fixtures.ts';
import { setup } from './dealing-helpers.ts';
import { finishThroughSeats } from './successor-helpers.ts';

test('real HTTPS/PG successor: Node-seat finished precondition; UI consent/new member, denial, lost ack and exact retry', async ({
  browser,
  origin,
  wall,
}) => {
  test.setTimeout(180000);
  let lose = false;
  const starts: { requestId: string; intent: { expected: object } }[] = [];
  const states: object[] = [];
  let actions = 0;
  const { contexts, pages } = await setup(browser, origin, wall, 2, async (page) => {
    await page.routeWebSocket('**/socket.io/**', (route) => {
      const server = route.connectToServer();
      route.onMessage((frame) => {
        if (typeof frame === 'string' && frame.startsWith('42')) {
          const t = JSON.parse(frame.slice(frame.indexOf('[')));
          if (t[0] === 'client-message' && t[1]?.intent?.type === 'start-match') starts.push(t[1]);
        }
        server.send(frame);
      });
      server.onMessage(async (frame) => {
        if (typeof frame === 'string' && frame.startsWith('42')) {
          const t = JSON.parse(frame.slice(frame.indexOf('[')));
          if (t[1]?.type === 'state') states.push(t[1]);
          if (t[1]?.type === 'action') actions++;
          if (lose && t[1]?.type === 'match-start-ack' && t[1]?.result?.type === 'started') {
            lose = false;
            await route.close();
            return;
          }
        }
        route.send(frame);
      });
    });
  });
  let driver: Awaited<ReturnType<typeof finishThroughSeats>> | undefined;
  try {
    const owner = pages[0]!;
    driver = await finishThroughSeats(pages, origin, wall);
    await expect(owner.getByTestId('match-results')).toBeVisible();
    const oldGame = await owner.getByTestId('game-id').innerText();
    async function refresh(page = owner) {
      wall.now += 1001;
      const read = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/lobbies/state');
      await page.getByRole('button', { name: 'Refresh agreements', exact: true }).click();
      await read;
      await expect(page.getByText('Agreements refreshed.', { exact: true })).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Refresh agreements', exact: true }),
      ).toBeEnabled();
    }
    await refresh();
    const epoch = await owner.getByTestId('agreements-epoch').innerText();
    await owner.getByRole('button', { name: 'Accept current agreements', exact: true }).click();
    await owner.getByRole('button', { name: 'Attempt next match', exact: true }).click();
    await expect(
      owner.getByText('The server rejected this start attempt.', { exact: false }),
    ).toBeVisible();
    await refresh();
    await expect(owner.getByTestId('agreements-epoch')).toHaveText(epoch);
    await expect(owner.getByTestId('game-id')).toHaveText(oldGame);
    await expect(owner.getByTestId('acceptance-0')).toContainText('Accepted');
    await expect(owner.getByTestId('acceptance-1')).toContainText('Not accepted');
    await owner.getByRole('button', { name: 'Refresh owner history', exact: true }).click();
    await expect(owner.getByText('Rollback window open.', { exact: false })).toBeVisible();
    for (const page of pages) {
      await refresh(page);
      const accept = page.getByRole('button', { name: 'Accept current agreements', exact: true });
      if (await accept.isVisible()) await accept.click();
    }
    await refresh();
    for (let n = 0; n < 2; n++)
      await expect(owner.getByTestId(`acceptance-${n}`)).toContainText('Accepted');
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    contexts.push(context);
    const newcomer = await context.newPage();
    pages.push(newcomer);
    await newcomer.goto(origin);
    await newcomer
      .getByLabel('Lobby reference (required)')
      .fill(await owner.getByTestId('lobby-id').innerText());
    await newcomer.getByRole('checkbox').check();
    await newcomer.getByRole('button', { name: 'Join as a new guest' }).click();
    await expect(newcomer.getByTestId('seat-id')).toBeVisible();
    await refresh();
    const joinedEpoch = await owner.getByTestId('agreements-epoch').innerText();
    expect(BigInt(joinedEpoch)).toBe(BigInt(epoch) + 1n);
    for (let n = 0; n < 3; n++)
      await expect(owner.getByTestId(`acceptance-${n}`)).toContainText('Not accepted');
    await owner.getByRole('button', { name: 'Retry original next match', exact: true }).click();
    await expect(
      owner.getByText('The server rejected this start attempt.', { exact: false }),
    ).toBeVisible();
    await refresh();
    await expect(owner.getByTestId('agreements-epoch')).toHaveText(joinedEpoch);
    for (const page of pages) {
      await refresh(page);
      await expect(page.getByTestId('agreements-epoch')).toHaveText(joinedEpoch);
      await page.getByRole('button', { name: 'Accept current agreements', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Withdraw acceptance', exact: true }),
      ).toBeVisible();
    }
    await refresh();
    for (let n = 0; n < 3; n++)
      await expect(owner.getByTestId(`acceptance-${n}`)).toContainText('Accepted');
    const actionsBeforeStart = actions;
    lose = true;
    await owner.getByRole('button', { name: 'Retry original next match', exact: true }).click();
    await expect(owner.getByTestId('connection-status')).toHaveText('uncertain');
    await owner.getByRole('button', { name: 'Connect game', exact: true }).click();
    await expect(owner.getByTestId('game-phase')).toHaveText('dealing');
    const nextGame = await owner.getByTestId('game-id').innerText();
    expect(nextGame).not.toBe(oldGame);
    await expect(
      owner.getByRole('list', { name: 'Game seat counts' }).getByRole('listitem'),
    ).toHaveCount(3);
    await expect(owner.getByTestId('fresh-peek')).toHaveCount(0);
    await expect(owner.getByTestId('final-reveal')).toHaveCount(0);
    await expect(owner.getByTestId('play-observations')).toBeEmpty();
    await expect(owner.getByTestId('penalty-transfers')).toBeEmpty();
    expect(actions, 'successor adoption and reconnect are state-only').toBe(actionsBeforeStart);
    await expect(owner.getByTestId('match-results')).toHaveCount(0);
    await refresh();
    const resetEpoch = (BigInt(joinedEpoch) + 1n).toString();
    await expect(owner.getByTestId('agreements-epoch')).toHaveText(resetEpoch);
    for (let n = 0; n < 3; n++)
      await expect(owner.getByTestId(`acceptance-${n}`)).toContainText('Not accepted');
    await owner.getByRole('button', { name: 'Retry original next match', exact: true }).click();
    await expect(owner.getByTestId('connection-status')).toHaveText('observing');
    await expect(owner.getByTestId('game-id')).toHaveText(nextGame);
    await refresh();
    await expect(owner.getByTestId('agreements-epoch')).toHaveText(resetEpoch);
    const attempts = starts.slice(1);
    expect(attempts).toHaveLength(4);
    for (const request of attempts) expect(request).toEqual(attempts[0]);
    expect(attempts[0]!.intent.expected).toEqual(driver.head);
    expect(states.length).toBeGreaterThan(2);
    expect(actions, 'accepted retry replays no private or public actions').toBe(actionsBeforeStart);
    // A later actual successor is started by authenticated Node administration,
    // preserving the UI's original uncertain-start reference for a genuinely historical retry.
    driver.close();
    driver = await finishThroughSeats(pages, origin, wall);
    await expect(owner.getByTestId('match-results')).toBeVisible();
    for (const page of pages) {
      await refresh(page);
      await page.getByRole('button', { name: 'Accept current agreements', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Withdraw acceptance', exact: true }),
      ).toBeVisible();
    }
    const later = await driver.rpc(driver.peers[0]!, {
      type: 'start-match',
      lobbyId: driver.peers[0]!.lobbyId,
      expected: driver.head,
    });
    if (later.type !== 'match-start-ack' || later.result.type !== 'started')
      throw Error('Later successor not committed');
    const latestGame = later.result.gameId;
    expect(latestGame).not.toBe(nextGame);
    await expect(owner.getByTestId('game-id')).toHaveText(latestGame);
    await owner.getByRole('button', { name: 'Retry original next match', exact: true }).click();
    await expect(owner.getByTestId('connection-status')).toHaveText('observing');
    await expect(owner.getByTestId('game-id')).toHaveText(latestGame);
    expect(starts.at(-1)).toEqual(attempts[0]);
    await refresh();
    await expect(owner.getByTestId('agreements-epoch')).toHaveText(
      (BigInt(resetEpoch) + 1n).toString(),
    );
    await expect(owner.getByTestId('play-observations')).toBeEmpty();
    await expect(owner.getByTestId('penalty-transfers')).toBeEmpty();
  } finally {
    driver?.close();
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('real HTTPS/PG race: held UI next-start does not close rollback; authenticated rollback wins and stale finished head rejects without clearing consent', async ({
  browser,
  origin,
  wall,
}) => {
  test.setTimeout(180000);
  let release: (() => void) | null = null;
  let hold = false;
  let captured: { intent: { expected: object } } | null = null;
  const { contexts, pages } = await setup(browser, origin, wall, 2, async (page) => {
    await page.routeWebSocket('**/socket.io/**', (route) => {
      const server = route.connectToServer();
      route.onMessage((frame) => {
        if (hold && typeof frame === 'string' && frame.startsWith('42')) {
          const t = JSON.parse(frame.slice(frame.indexOf('[')));
          if (t[0] === 'client-message' && t[1]?.intent?.type === 'start-match') {
            captured = t[1];
            release = () => server.send(frame);
            return;
          }
        }
        server.send(frame);
      });
      server.onMessage((frame) => route.send(frame));
    });
  });
  let driver: Awaited<ReturnType<typeof finishThroughSeats>> | undefined;
  try {
    const owner = pages[0]!;
    driver = await finishThroughSeats(pages, origin, wall);
    await expect(owner.getByTestId('match-results')).toBeVisible();
    for (const page of pages) {
      wall.now += 1001;
      await page.getByRole('button', { name: 'Refresh agreements', exact: true }).click();
      await page.getByRole('button', { name: 'Accept current agreements', exact: true }).click();
    }
    await owner.getByRole('button', { name: 'Refresh agreements', exact: true }).click();
    const epoch = await owner.getByTestId('agreements-epoch').innerText();
    hold = true;
    await owner.getByRole('button', { name: 'Attempt next match', exact: true }).click();
    await expect.poll(() => release !== null).toBe(true);
    expect((captured as { intent: { expected: object } } | null)?.intent.expected).toEqual(
      driver.head,
    );
    const admin = driver.peers[0]!;
    const history = await driver.rpc(admin, {
      type: 'owner-history-page',
      gameId: driver.head.gameId,
      cursor: null,
      limit: 100,
    });
    if (history.type !== 'owner-history-page' || history.result.type !== 'page')
      throw Error('No real owner history');
    expect(history.result.rollbackOpen).toBe(true);
    const action = history.result.entries.find(
      (e) => e.type === 'action' && e.action.rollbackTarget,
    );
    if (!action || action.type !== 'action') throw Error('No rollback target');
    const rollback = await driver.rpc(admin, {
      type: 'rollback',
      target: action.action.rollbackTarget,
      knowledgeWarningAcknowledged: true,
    });
    if (rollback.type !== 'command-ack') throw Error('No rollback receipt');
    expect(rollback.result.type).toBe('accepted');
    // The serialized server rollback wins before delivery of the already-captured UI start.
    hold = false;
    (release as (() => void) | null)?.();
    await expect(
      owner.getByText('The server rejected this start attempt.', { exact: false }),
    ).toBeVisible();
    await owner.getByRole('button', { name: 'Refresh agreements', exact: true }).click();
    await expect(owner.getByTestId('agreements-epoch')).toHaveText(epoch);
    for (let n = 0; n < 2; n++)
      await expect(owner.getByTestId(`acceptance-${n}`)).toContainText('Accepted');
    const historyAfter = await driver.rpc(admin, {
      type: 'owner-history-page',
      gameId: driver.head.gameId,
      cursor: null,
      limit: 100,
    });
    if (historyAfter.type !== 'owner-history-page' || historyAfter.result.type !== 'page')
      throw Error('No post-denial history');
    expect(historyAfter.result.rollbackOpen).toBe(true);
    await expect(owner.getByTestId('game-id')).toHaveText(driver.head.gameId);
    await expect(owner.getByTestId('match-results')).toHaveCount(0);
  } finally {
    driver?.close();
    await Promise.all(contexts.map((c) => c.close()));
  }
});
