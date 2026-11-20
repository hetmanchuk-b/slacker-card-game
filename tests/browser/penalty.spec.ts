import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ServerMessage } from '../../src/protocol/contracts.ts';
import { test } from './fixtures.ts';
import { setup, deal, initialRecipient } from './dealing-helpers.ts';

const cert = readFileSync(new URL('../../src/server/testing/localhost-cert.pem', import.meta.url));
async function rpc(
  socket: Socket,
  intent: object,
  type: ServerMessage['type'],
): Promise<ServerMessage> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('server-message', receive);
      reject(Error('No fixture reply'));
    }, 5000);
    function receive(message: ServerMessage) {
      if (message.type !== type && message.type !== 'error') return;
      if (message.type === 'command-ack' && message.requestId !== requestId) return;
      clearTimeout(timer);
      socket.off('server-message', receive);
      resolve(message);
    }
    socket.on('server-message', receive);
    socket.emit('client-message', { protocolVersion: 1, requestId, intent });
  });
}
async function external(page: Page, origin: string) {
  const cookie = (await page.context().cookies(origin)).find(
    (v) => v.name === '__Host-penky_guest',
  )!;
  const socket = io(origin, {
    ca: cert.toString(),
    transports: ['websocket'],
    reconnection: false,
    autoConnect: false,
    extraHeaders: { Origin: origin, Cookie: `${cookie.name}=${cookie.value}` },
  });
  socket.on('server-message', (_message: unknown, receipt: string, ack: (value: string) => void) =>
    ack(receipt),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', () => reject(Error('Fixture connection refused')));
      socket.connect();
    });
    return socket;
  } catch (error) {
    socket.disconnect();
    throw error;
  }
}
async function reserve(page: Page) {
  const select = page.getByLabel('Card to reserve (required)');
  await expect(select).toBeEnabled();
  const choice = await select
    .locator('option')
    .nth(1)
    .evaluate((option: HTMLOptionElement) => ({ id: option.value, label: option.text }));
  await select.selectOption(choice.id);
  await page.getByRole('button', { name: 'Reserve selected card', exact: true }).click();
  return choice;
}
async function refuse(page: Page) {
  await page.getByRole('button', { name: 'Refuse contribution', exact: true }).click();
}
async function beginPenalty(pages: Page[], repeats = 1) {
  const first = await initialRecipient(pages);
  const recipient = first === 1 ? 2 : 1; // Never owner 0; always out of turn.
  for (let i = 0; i < repeats; i++) {
    await pages[recipient]!.getByRole('button', { name: 'Draw card', exact: true }).click();
    await expect(pages[recipient]!.getByTestId('draw-result')).toHaveText(/violation/);
    await expect(pages[first]!.getByTestId('initial-recipient')).toBeVisible();
  }
  const { leader } = await deal(pages);
  for (const page of pages)
    await expect(page.getByTestId('penalty-procedure')).toBeVisible({ timeout: 15000 });
  return { recipient, leader };
}

test('browser reservations remain private until completion; queued and later penalties restore the server phase', async ({
  browser,
  origin,
  wall,
}) => {
  test.setTimeout(60000);
  const { contexts, pages } = await setup(browser, origin, wall, 4);
  let socket: Socket | null = null;
  let leaderSocket: Socket | null = null;
  try {
    const { recipient, leader } = await beginPenalty(pages, 2);
    const donor = pages[0]!;
    await donor.setViewportSize({ width: 360, height: 800 });
    const bystander = [0, 1, 2, 3].find((i) => i !== 0 && i !== recipient)!;
    const donorCount = await donor.getByTestId('own-hand').getByRole('listitem').count();
    const recipientCount = await pages[recipient]!.getByTestId('own-hand')
      .getByRole('listitem')
      .count();
    const chosen = await reserve(donor);
    await expect(donor.getByTestId('own-reservation')).toContainText(chosen.label);
    await expect(donor.getByTestId('own-hand').getByRole('listitem')).toHaveCount(donorCount);
    for (const page of pages.slice(1)) {
      await expect(page.getByTestId('own-reservation')).toBeEmpty();
      await expect(page.getByTestId('penalty-transfers')).toBeEmpty();
      expect(await page.locator('body').textContent()).not.toContain(chosen.label);
    }
    const others = [0, 1, 2, 3].filter((i) => i !== 0 && i !== recipient);
    await refuse(pages[others[0]!]!);
    await expect(pages[others[0]!]!.getByTestId('own-reservation')).toHaveText(
      'Your refusal is confirmed.',
    );
    await refuse(pages[others[1]!]!);
    for (const page of [donor, pages[recipient]!])
      await expect(page.getByTestId('penalty-transfers')).toContainText(chosen.label);
    await expect(pages[bystander]!.getByTestId('penalty-transfers')).toBeEmpty();
    await expect(donor.getByTestId('own-hand').getByRole('listitem')).toHaveCount(donorCount - 1);
    await expect(pages[recipient]!.getByTestId('own-hand').getByRole('listitem')).toHaveCount(
      recipientCount + 1,
    );
    await expect(donor.getByLabel('Card to reserve (required)')).toHaveValue('');
    // Second queued penalty is a distinct procedure; selections and responses do not carry over.
    for (const index of [0, ...others]) await refuse(pages[index]!);
    for (const page of pages)
      await expect(page.getByTestId('game-phase')).toHaveText('between-rounds');
    // Authenticated external wire setup only: no ordinary play/history control is added to the UI.
    socket = await external(donor, origin);
    const lobbyId = await donor.getByTestId('lobby-id').innerText();
    const before = await rpc(socket, { type: 'resync', lobbyId }, 'state');
    if (before.type !== 'state' || !before.view.state?.own)
      throw Error('Missing seat-local fixture view');
    expect(before.view.state.phase.type).toBe('between-rounds');
    if (before.view.state.phase.type === 'between-rounds')
      expect(before.view.state.phase.leaderId).toBe(
        await pages[leader]!.getByTestId('seat-id').innerText(),
      );
    // Establish an interrupted round through the leader's own authenticated wire view,
    // not trusted state access or an ordinary-play browser control.
    leaderSocket = await external(pages[leader]!, origin);
    const leaderView = await rpc(leaderSocket, { type: 'resync', lobbyId }, 'state');
    if (leaderView.type !== 'state' || !leaderView.view.state?.own)
      throw Error('Missing leader view');
    const lead = await rpc(
      leaderSocket,
      {
        type: 'play-card',
        gameId: leaderView.view.head.gameId,
        branchId: leaderView.view.head.branchId,
        cardId: leaderView.view.state.own.hand[0]!.id,
      },
      'command-ack',
    );
    expect(
      lead.type === 'command-ack' &&
        lead.result.type === 'accepted' &&
        lead.result.outcome === 'played',
    ).toBe(true);
    const interrupted = await rpc(socket, { type: 'resync', lobbyId }, 'state');
    if (interrupted.type !== 'state' || interrupted.view.state?.phase.type !== 'round')
      throw Error('Missing round view');
    const ack = await rpc(
      socket,
      {
        type: 'open-stump',
        gameId: before.view.head.gameId,
        branchId: before.view.head.branchId,
        cardId: before.view.state.own.stumps[0],
      },
      'command-ack',
    );
    expect(
      ack.type === 'command-ack' &&
        ack.result.type === 'accepted' &&
        ack.result.outcome === 'violation',
    ).toBe(true);
    await expect(donor.getByTestId('penalty-recipient')).toContainText('peek');
    // Old procedure IDs are rejected by the real server, not retargeted to the new penalty.
    const stale = await rpc(
      socket,
      {
        type: 'penalty-response',
        gameId: before.view.head.gameId,
        branchId: before.view.head.branchId,
        procedureId: 'obsolete-procedure',
        cardId: null,
      },
      'command-ack',
    );
    expect(
      stale.type === 'command-ack' &&
        stale.result.type === 'rejected' &&
        stale.result.code === 'stale-timer',
    ).toBe(true);
    for (const page of pages.slice(1)) await refuse(page);
    await expect(donor.getByTestId('penalty-procedure')).toHaveCount(0);
    const after = await rpc(socket, { type: 'resync', lobbyId }, 'state');
    if (after.type !== 'state') throw Error('Missing resumed fixture view');
    expect(after.view.state?.phase).toEqual(interrupted.view.state.phase);
    await expect(
      donor.getByRole('button', { name: /play card|open stump|take bottom/i }),
    ).toHaveCount(0);
    expect(await donor.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    leaderSocket?.disconnect();
    socket?.disconnect();
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('a reserved card survives pause privately and transfers only after the real remaining timeout', async ({
  browser,
  origin,
  wall,
}) => {
  test.setTimeout(60000);
  const { contexts, pages } = await setup(browser, origin, wall, 4);
  try {
    const { recipient } = await beginPenalty(pages);
    const donor = pages[0]!;
    const chosen = await reserve(donor);
    await expect(donor.getByTestId('own-reservation')).toContainText(chosen.label);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const absent = [1, 2, 3].find((i) => i !== recipient)!;
    await pages[absent]!.getByRole('button', { name: 'Disconnect game', exact: true }).click();
    await expect(donor.getByTestId('procedure-time')).toContainText('Paused');
    const frozen = await donor.getByTestId('procedure-time').innerText();
    await donor.clock.fastForward(1000);
    await expect(donor.getByTestId('procedure-time')).toHaveText(frozen);
    await pages[absent]!.getByRole('button', { name: 'Connect game', exact: true }).click();
    await expect(donor.getByTestId('game-paused')).toHaveText('Running');
    await expect(donor.getByTestId('own-reservation')).toContainText(chosen.label);
    await expect(pages[absent]!.getByTestId('penalty-transfers')).toBeEmpty();
    // Local zero does not submit a refusal, transfer a card or complete the penalty.
    await donor.clock.fastForward(10001);
    await expect(donor.getByTestId('procedure-time')).toContainText('Awaiting server completion');
    await expect(donor.getByTestId('penalty-procedure')).toBeVisible();
    await expect(donor.getByTestId('penalty-transfers')).toBeEmpty();
    await expect(donor.getByTestId('penalty-procedure')).toHaveCount(0, { timeout: 12000 });
    for (const page of [donor, pages[recipient]!])
      await expect(page.getByTestId('penalty-transfers')).toContainText(chosen.label);
    await expect(pages[absent]!.getByTestId('penalty-transfers')).toBeEmpty();
    await donor.getByRole('button', { name: 'Resync game', exact: true }).click();
    await expect(donor.getByTestId('game-phase')).toHaveText('between-rounds');
    await expect(donor.getByTestId('penalty-transfers')).toBeEmpty();
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('lost penalty acknowledgment clears the draft; resync confirms the reservation without retry', async ({
  browser,
  origin,
  wall,
}) => {
  test.setTimeout(60000);
  let pendingType = '';
  let responses = 0;
  let dropped = false;
  const { contexts, pages } = await setup(browser, origin, wall, 4, async (page) => {
    await page.routeWebSocket('**/socket.io/**', (route) => {
      const server = route.connectToServer();
      route.onMessage((frame) => {
        if (typeof frame === 'string' && frame.startsWith('42')) {
          const tuple = JSON.parse(frame.slice(frame.indexOf('[')));
          if (tuple[0] === 'client-message') {
            pendingType = tuple[1]?.intent?.type;
            if (pendingType === 'penalty-response') responses++;
          }
        }
        server.send(frame);
      });
      server.onMessage(async (frame) => {
        if (
          !dropped &&
          pendingType === 'penalty-response' &&
          typeof frame === 'string' &&
          frame.startsWith('42')
        ) {
          const tuple = JSON.parse(frame.slice(frame.indexOf('[')));
          if (tuple[0] === 'server-message' && tuple[1]?.type === 'command-ack') {
            expect(tuple[1].result.type).toBe('accepted');
            dropped = true;
            await route.close();
            return;
          }
        }
        route.send(frame);
      });
    });
  });
  try {
    await beginPenalty(pages);
    const donor = pages[0]!;
    const chosen = await reserve(donor);
    await expect(donor.getByTestId('connection-status')).toHaveText('uncertain');
    await expect(donor.getByTestId('penalty-result')).toContainText('outcome uncertain');
    await expect(donor.getByLabel('Card to reserve (required)')).toHaveCount(0);
    await donor.getByRole('button', { name: 'Connect game', exact: true }).click();
    await expect(donor.getByTestId('own-reservation')).toContainText(chosen.label);
    await expect(donor.getByTestId('penalty-transfers')).toBeEmpty();
    expect(responses).toBe(1);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
