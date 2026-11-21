import { GameRuntime } from '../../src/runtime/runtime.ts';
import { finishMatch } from '../../src/runtime/testing/match.ts';
import { projectLiveGame } from '../../src/projections/live.ts';
import { expect } from '@playwright/test';
import { test } from './fixtures.ts';
import { setup } from './dealing-helpers.ts';
import { fixture } from '../../src/runtime/testing/fixtures.ts';
import { id } from '../../src/game/ids.ts';
import { projectOwnerHistory } from '../../src/projections/history.ts';
import { makeOwnerHistoryPage } from '../../src/protocol/history-page.ts';
import type { ServerMessage, OwnerHistoryCursor } from '../../src/protocol/contracts.ts';
import { io } from 'socket.io-client';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
async function external(page: Page, origin: string) {
  const cookie = (await page.context().cookies(origin)).find(
    (c) => c.name === '__Host-penky_guest',
  )!;
  const socket = io(origin, {
    ca: readFileSync(
      new URL('../../src/server/testing/localhost-cert.pem', import.meta.url),
    ).toString(),
    transports: ['websocket'],
    reconnection: false,
    autoConnect: false,
    extraHeaders: { Origin: origin, Cookie: `${cookie.name}=${cookie.value}` },
  });
  socket.on('server-message', (_m, receipt, ack) => ack(receipt));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    socket.connect();
  });
  const rpc = (intent: object, type: string): Promise<ServerMessage> =>
    new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => reject(Error('No fixture response')), 5000);
      const receive = (m: ServerMessage) => {
        if (m.type !== type && m.type !== 'error') return;
        if ('requestId' in m && m.requestId !== requestId) return;
        clearTimeout(timer);
        socket.off('server-message', receive);
        resolve(m);
      };
      socket.on('server-message', receive);
      socket.emit('client-message', { protocolVersion: 1, requestId, intent });
    });
  return { socket, rpc };
}
test('real owner reads; nonowner server denial; authenticated Node rollback precondition preserves null-state owner history', async ({
  browser,
  origin,
  wall,
}) => {
  const { contexts, pages } = await setup(browser, origin, wall, 2);
  const owner = pages[0]!,
    member = pages[1]!;
  try {
    await expect(
      member.getByRole('button', { name: 'Refresh owner history', exact: true }),
    ).toHaveCount(0);
    const lobbyId = await owner.getByTestId('lobby-id').innerText();
    const denied = await external(member, origin);
    let gameId = '';
    const admin = await external(owner, origin);
    try {
      const state = await admin.rpc({ type: 'resync', lobbyId }, 'state');
      if (state.type !== 'state') throw Error('Expected state');
      gameId = state.view.head.gameId;
      await denied.rpc({ type: 'resync', lobbyId }, 'state');
      const denial = await denied.rpc(
        { type: 'owner-history-page', gameId, cursor: null, limit: 100 },
        'owner-history-page',
      );
      expect(denial.type).toBe('error');
      if (denial.type !== 'error') throw Error('Expected denial');
      expect(denial.code).toBe('unauthorized');
      expect('result' in denial).toBe(false);
      await owner.getByRole('button', { name: 'Refresh owner history', exact: true }).click();
      await expect(owner.getByText('History: complete.', { exact: false })).toBeVisible();
      const history = await admin.rpc(
        { type: 'owner-history-page', gameId, cursor: null, limit: 100 },
        'owner-history-page',
      );
      if (history.type !== 'owner-history-page' || history.result.type !== 'page')
        throw Error('Expected history');
      const row = history.result.entries.find(
        (e) => e.type === 'action' && e.action.rollbackTarget,
      );
      if (!row || row.type !== 'action') throw Error('No target');
      // Real authenticated Node administration establishes null/abandoned precondition, NOT UI rollback.
      const rollback = await admin.rpc(
        { type: 'rollback', target: row.action.rollbackTarget, knowledgeWarningAcknowledged: true },
        'command-ack',
      );
      if (rollback.type !== 'command-ack') throw Error('Expected rollback ack');
      expect(rollback.result.type).toBe('accepted');
      await owner.getByRole('button', { name: 'Resync game', exact: true }).click();
      await expect(owner.getByTestId('connection-status')).toHaveText('observing');
      await owner.getByRole('button', { name: 'Refresh owner history', exact: true }).click();
      await expect(owner.getByText('History: complete.', { exact: false })).toBeVisible();
      await expect(owner.getByRole('rowheader', { name: /abandoned/ })).toBeVisible();
      await expect(owner.getByRole('rowheader', { name: /Rollback audit/ })).toBeVisible();
    } finally {
      admin.socket.disconnect();
      denied.socket.disconnect();
    }
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

for (const finished of [false, true]) {
  test(`explicit trusted engine wire fixture: ${finished ? 'finished owner' : '>97KB retained fork'} paging, narrow DOM keyboard targets, stale and closure`, async ({
    browser,
    origin,
    wall,
  }, testInfo) => {
    const { history, seats, options, clock } = fixture('reveal', finished ? 2 : 8);
    let finishedView: ReturnType<typeof projectLiveGame> | null = null;
    if (finished) {
      const runtime = await GameRuntime.create(options);
      try {
        await clock.advanceBy(10000);
        await finishMatch(runtime);
        const snapshot = runtime.read();
        finishedView = projectLiveGame(
          {
            ...snapshot,
            connections: snapshot.state!.players.map((p) => ({
              seatId: p.id,
              connected: true,
              controller: 'human',
              disconnectedAtMs: null,
            })),
            paused: false,
            replacementVote: null,
            controlEvents: [],
          },
          { type: 'seat', seatId: seats[0]! },
          clock.now(),
        );
      } finally {
        await runtime.dispose();
      }
    }
    let target = id('command', 'draw-34');
    for (let i = 0; i < (finished ? 0 : 16); i++) {
      const command = id('command', `fork-${i}`);
      expect(
        history.fork(history.read().head, {
          id: command,
          actorId: seats[0]!,
          beforeCommandId: target,
          branchId: id('branch', `fork-${i}`),
          nowMs: 12000 + i,
          resumeClock: true,
          knowledgeWarningAcknowledged: true,
        }).type,
      ).toBe('committed');
      target = command;
    }
    let view = projectOwnerHistory(history.snapshot().value, { type: 'seat', seatId: seats[0]! });
    let finishedActive = false;
    let stale = false,
      pagesRead = 0,
      bytes = 0,
      nonce = 100000;
    const { contexts, pages } = await setup(browser, origin, wall, 2, async (page) => {
      await page.routeWebSocket('**/socket.io/**', (route) => {
        const server = route.connectToServer();
        let deliverySequence = 0;
        let epoch = '';
        route.onMessage((frame) => {
          if (
            typeof frame === 'string' &&
            frame.startsWith('43') &&
            Number(frame.slice(2, frame.indexOf('['))) >= 100000
          )
            return;
          if (typeof frame === 'string' && frame.startsWith('42')) {
            const tuple = JSON.parse(frame.slice(frame.indexOf('[')));
            const m = tuple[1];
            if (tuple[0] === 'client-message' && m.intent.type === 'owner-history-page') {
              const rebound = JSON.parse(
                JSON.stringify(view, (key, value: unknown) =>
                  key === 'gameId' ? m.intent.gameId : value,
                ),
              ) as typeof view;
              let response = makeOwnerHistoryPage(
                rebound,
                id('command', m.requestId),
                { epoch, sequence: ++deliverySequence },
                m.intent.cursor as OwnerHistoryCursor | null,
                20,
                65536,
              );
              if (stale) {
                response = { ...response, result: { type: 'stale' } };
                stale = false;
              }
              pagesRead++;
              bytes += Buffer.byteLength(JSON.stringify(response));
              route.send(
                `42${++nonce}${JSON.stringify(['server-message', response, randomUUID()])}`,
              );
              return;
            }
          }
          server.send(frame);
        });
        server.onMessage((frame) => {
          if (typeof frame === 'string' && frame.startsWith('42')) {
            const start = frame.indexOf('[');
            const tuple = JSON.parse(frame.slice(start));
            if (tuple[0] === 'server-message' && tuple[1].delivery) {
              if (
                finishedActive &&
                finishedView &&
                tuple[1].type === 'state' &&
                tuple[1].view.state
              ) {
                const actual = tuple[1].view;
                const replacements = new Map<string, string>(
                  seats.map((seat, i) => [seat, actual.state.players[i].id]),
                );
                replacements.set(finishedView.head.gameId, actual.head.gameId);
                replacements.set(finishedView.head.branchId, actual.head.branchId);
                tuple[1].view = JSON.parse(
                  JSON.stringify(finishedView, (_key, value: unknown) =>
                    typeof value === 'string' ? (replacements.get(value) ?? value) : value,
                  ),
                );
              }
              epoch = tuple[1].delivery.epoch;
              tuple[1].delivery.sequence = ++deliverySequence;
              route.send(frame.slice(0, start) + JSON.stringify(tuple));
              return;
            }
          }
          route.send(frame);
        });
      });
    });
    const page = pages[0]!;
    try {
      if (finished) {
        finishedActive = true;
        await page.getByRole('button', { name: 'Resync game', exact: true }).click();
        await expect(page.getByTestId('game-phase')).toHaveText('finished');
      }
      await page.setViewportSize({ width: 360, height: 800 });
      const start = Date.now();
      await page.getByRole('button', { name: 'Refresh owner history', exact: true }).click();
      await expect(page.getByText('History: partial.', { exact: false })).toBeVisible();
      while (
        await page.getByRole('button', { name: 'Read next history page', exact: true }).isVisible()
      ) {
        await page.getByRole('button', { name: 'Read next history page', exact: true }).click();
        await expect(page.getByText('History: pending.', { exact: false })).toHaveCount(0);
      }
      await expect(page.getByText('History: complete.', { exact: false })).toBeVisible();
      const expected = view.branches.reduce(
        (n, b) => n + 1 + b.actions.length,
        view.rollbacks.length,
      );
      await expect(page.locator('.history-scroll tbody tr')).toHaveCount(expected);
      if (!finished) {
        await expect(page.getByText(/^rollback: .*audit 1$/).first()).toBeVisible();
        await expect(
          page.getByRole('rowheader', { name: 'Rollback audit 1', exact: true }),
        ).toBeVisible();
        await expect(page.getByRole('rowheader', { name: /^Rollback audit / })).toHaveText(
          view.rollbacks.map((_rollback, index) => `Rollback audit ${index + 1}`),
        );
      }
      const radio = page.getByRole('radio').first();
      await radio.focus();
      await page.keyboard.press('Space');
      await expect(radio).toBeChecked();
      await expect(page.getByText(/Selected completed action:/)).toBeVisible();
      const measurement = await page.locator('.history-scroll').evaluate((el) => ({
        rows: el.querySelectorAll('tbody tr').length,
        nodes: el.querySelectorAll('*').length,
        width: el.clientWidth,
        scrollWidth: el.scrollWidth,
        pageWidth: document.documentElement.scrollWidth,
        viewport: innerWidth,
      }));
      expect(measurement.pageWidth).toBeLessThanOrEqual(360);
      if (!finished) expect(bytes).toBeGreaterThan(97000);
      else await expect(page.getByTestId('game-phase')).toHaveText('finished');

      console.log(
        'HISTORY_MEASUREMENT',
        JSON.stringify({
          finished,
          pages: pagesRead,
          bytes,
          renderMs: Date.now() - start,
          ...measurement,
        }),
      );
      await testInfo.attach('history-dom-measurement', {
        body: JSON.stringify({
          fixture: 'trusted engine metadata; real lobby/live baseline; not persisted history',
          pages: pagesRead,
          bytes,
          renderMs: Date.now() - start,
          ...measurement,
        }),
        contentType: 'application/json',
      });
      await page.getByRole('button', { name: 'Refresh owner history', exact: true }).click();
      stale = true;
      await page.getByRole('button', { name: 'Read next history page', exact: true }).click();
      await expect(page.getByText('History: stale.', { exact: false })).toBeVisible();
      await expect(page.getByRole('radio')).toHaveCount(0);
      history.closeRollback();
      view = projectOwnerHistory(history.snapshot().value, { type: 'seat', seatId: seats[0]! });
      await page.getByRole('button', { name: 'Refresh owner history', exact: true }).click();
      await expect(page.getByText('History: partial.', { exact: false })).toBeVisible();
      while (
        await page.getByRole('button', { name: 'Read next history page', exact: true }).isVisible()
      ) {
        await page.getByRole('button', { name: 'Read next history page', exact: true }).click();
        await expect(page.getByText('History: pending.', { exact: false })).toHaveCount(0);
      }
      await expect(
        page.getByText('Rollback window closed; read-only.', { exact: false }),
      ).toBeVisible();
      await expect(page.getByRole('radio')).toHaveCount(0);
    } finally {
      await Promise.all(contexts.map((c) => c.close()));
    }
  });
}
