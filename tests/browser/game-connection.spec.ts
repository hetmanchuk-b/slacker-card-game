import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './fixtures.ts';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ServerMessage } from '../../src/protocol/contracts.ts';
const cert = readFileSync(new URL('../../src/server/testing/localhost-cert.pem', import.meta.url));
async function rpc(
  socket: Socket,
  intent: object,
  type: ServerMessage['type'],
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('server-message', receive);
      reject(Error('No fixture reply'));
    }, 5000);
    function receive(message: ServerMessage) {
      if (message.type !== type && message.type !== 'error') return;
      clearTimeout(timer);
      socket.off('server-message', receive);
      resolve(message);
    }
    socket.on('server-message', receive);
    socket.emit('client-message', { protocolVersion: 1, requestId: randomUUID(), intent });
  });
}
async function external(origin: string, cookie: string, source = origin): Promise<Socket> {
  const socket = io(origin, {
    ca: cert.toString(),
    transports: ['websocket'],
    reconnection: false,
    autoConnect: false,
    timeout: 5000,
    extraHeaders: { Origin: source, Cookie: cookie },
  });
  socket.on('server-message', (_message: unknown, receipt: string, ack: (value: string) => void) =>
    ack(receipt),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
      socket.connect();
    });
    return socket;
  } catch {
    socket.disconnect();
    throw Error('Fixture socket refused');
  }
}
async function accept(page: Page) {
  await page.getByRole('button', { name: 'Refresh agreements', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Accept current agreements', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Accept current agreements', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Withdraw acceptance', exact: true }),
  ).toBeVisible();
}
function starts(page: Page) {
  const messages: unknown[] = [];
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname !== '/socket.io/') return;
    socket.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string' || !payload.startsWith('42')) return;
      const index = payload.indexOf('[');
      if (index < 0) return;
      const tuple = JSON.parse(payload.slice(index));
      if (tuple[0] === 'client-message' && tuple[1]?.intent?.type === 'start-match')
        messages.push(tuple[1]);
    });
  });
  return messages;
}
test('real browser sockets attach, start, resync and show live suspension controls without gameplay UI', async ({
  page,
  browser,
  origin,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const messages = starts(page);
  await page.goto(origin);
  await page.getByRole('button', { name: 'Create lobby', exact: true }).click();
  await expect(page.getByTestId('lobby-id')).toBeVisible();
  const lobbyId = await page.getByTestId('lobby-id').innerText();
  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const member = await other.newPage();
    await member.goto(origin);
    await member.getByLabel('Lobby reference (required)').fill(lobbyId);
    await member.getByRole('checkbox').check();
    await member.getByRole('button', { name: 'Join as a new guest' }).click();
    await expect(member.getByTestId('seat-role')).toHaveText('Member');
    await Promise.all([accept(page), accept(member)]);
    await page.getByRole('button', { name: 'Connect game', exact: true }).click();
    await expect(page.getByTestId('connection-status')).toHaveText('attached');
    await expect(
      page.getByText(
        'No current baseline was confirmed. This does not prove that the lobby has no assigned game.',
      ),
    ).toBeVisible();
    await member.getByRole('button', { name: 'Connect game', exact: true }).click();
    await expect(member.getByTestId('connection-status')).toHaveText('attached');
    await expect(
      member.getByRole('button', { name: 'Attempt first start', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Attempt first start', exact: true }).click();
    await expect(page.getByTestId('game-phase')).toHaveText('dealing');
    await expect(page.getByTestId('agreements-text')).toHaveCount(0);
    const gameId = await page.getByTestId('game-id').innerText();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath('game-390.png'), fullPage: true });
    await page.getByRole('button', { name: 'Refresh agreements', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save agreements', exact: true })).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Accept current agreements', exact: true }),
    ).toBeDisabled();
    await member.getByRole('button', { name: 'Resync game', exact: true }).click();
    await expect(member.getByTestId('game-id')).toHaveText(gameId);
    await expect(member.getByTestId('game-paused')).toHaveText('Running');
    const version = await member.getByTestId('game-version').innerText();
    await page.getByRole('button', { name: 'Disconnect game', exact: true }).click();
    await expect(page.getByTestId('game-id')).toHaveCount(0);
    await expect(member.getByTestId('game-paused')).toHaveText('Paused');
    expect(Number(await member.getByTestId('game-version').innerText())).toBeGreaterThanOrEqual(
      Number(version),
    );
    await page.getByRole('button', { name: 'Connect game', exact: true }).click();
    await expect(page.getByTestId('game-id')).toHaveText(gameId);
    await expect(member.getByTestId('game-paused')).toHaveText('Running');
    await page.reload();
    await page.getByRole('button', { name: 'Restore my seat', exact: true }).click();
    await expect(page.getByTestId('seat-role')).toHaveText('Owner');
    await page.getByRole('button', { name: 'Connect game', exact: true }).click();
    await expect(page.getByTestId('game-id')).toHaveText(gameId);
    await page.getByRole('button', { name: 'Retry original first start', exact: true }).click();
    await expect(page.getByTestId('connection-status')).toHaveText('observing');
    await expect(page.getByRole('button', { name: 'Resync game', exact: true })).toBeEnabled();
    await expect(page.getByTestId('game-id')).toHaveText(gameId);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual(messages[0]);
    await expect(page.getByRole('button', { name: /draw card|play card|open stump/i })).toHaveCount(
      0,
    );
    // Existing authenticated Node fixture exercises rollback, not a browser
    // rollback/history control (9.13/9.14). No trusted state reads choose actions.
    const cookie = (await page.context().cookies(origin)).find(
      (value) => value.name === '__Host-penky_guest',
    )!;
    const socket = await external(origin, `${cookie.name}=${cookie.value}`);
    try {
      expect((await rpc(socket, { type: 'resync', lobbyId }, 'state')).type).toBe('state');
      const history = await rpc(socket, { type: 'owner-history', gameId }, 'owner-history');
      if (history.type !== 'owner-history') throw Error('Missing fixture metadata');
      const rollback = await rpc(
        socket,
        {
          type: 'rollback',
          target: { expected: history.view.head, beforeActionVersion: 1 },
          knowledgeWarningAcknowledged: true,
        },
        'command-ack',
      );
      expect(rollback.type).toBe('command-ack');
      await expect(page.getByTestId('game-null-state')).toBeVisible();
      await expect(page.getByTestId('agreements-text')).toHaveCount(0);
      await expect(page.getByTestId('game-version')).toHaveText('0');
      const tab = await page.context().newPage();
      await tab.goto(page.url());
      await tab.getByRole('button', { name: 'Restore my seat', exact: true }).click();
      await expect(tab.getByTestId('seat-id')).toBeVisible();
      await tab.getByRole('button', { name: 'Connect game', exact: true }).click();
      await expect(tab.getByTestId('game-null-state')).toBeVisible();
      await expect(
        tab.getByRole('button', { name: 'Attempt first start', exact: true }),
      ).toBeDisabled();
      await tab.close();
    } finally {
      socket.disconnect();
    }
  } finally {
    await other.close();
  }
});

test('a committed lost first-start acknowledgment is explicitly retried with the same intent after reconnect', async ({
  page,
  browser,
  origin,
}) => {
  let drop = true;
  let committed = '';
  await page.routeWebSocket('**/socket.io/**', (route) => {
    const server = route.connectToServer();
    server.onMessage(async (frame) => {
      if (drop && typeof frame === 'string' && frame.startsWith('42')) {
        const tuple = JSON.parse(frame.slice(frame.indexOf('[')));
        if (tuple[0] === 'server-message' && tuple[1]?.type === 'match-start-ack') {
          expect(tuple[1].result.type).toBe('started');
          committed = tuple[1].result.gameId;
          drop = false;
          await route.close();
          return;
        }
      }
      route.send(frame);
    });
  });
  const messages = starts(page);
  await page.goto(origin);
  await page.getByRole('button', { name: 'Create lobby', exact: true }).click();
  await expect(page.getByTestId('lobby-id')).toBeVisible();
  const lobbyId = await page.getByTestId('lobby-id').innerText();
  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const member = await other.newPage();
    await member.goto(origin);
    await member.getByLabel('Lobby reference (required)').fill(lobbyId);
    await member.getByRole('checkbox').check();
    await member.getByRole('button', { name: 'Join as a new guest' }).click();
    await expect(member.getByTestId('seat-id')).toBeVisible();
    await Promise.all([accept(page), accept(member)]);
    await page.getByRole('button', { name: 'Connect game', exact: true }).click();
    await expect(page.getByTestId('connection-status')).toHaveText('attached');
    await page.getByRole('button', { name: 'Attempt first start', exact: true }).click();
    await expect(page.getByTestId('connection-status')).toHaveText('uncertain');
    await expect(page.getByTestId('game-id')).toHaveCount(0);
    await page.getByRole('button', { name: 'Connect game', exact: true }).click();
    await expect(page.getByTestId('game-id')).toHaveText(committed);
    await page.getByRole('button', { name: 'Retry original first start', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Resync game', exact: true })).toBeEnabled();
    await expect(page.getByTestId('game-id')).toHaveText(committed);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual(messages[0]);
  } finally {
    await other.close();
  }
});

test('suppressing real transport nonce receipts disconnects the browser rather than advancing delivery', async ({
  page,
  origin,
}) => {
  let blocked = 0;
  await page.routeWebSocket('**/socket.io/**', (route) => {
    const server = route.connectToServer();
    route.onMessage((frame) => {
      if (typeof frame === 'string' && frame.startsWith('43')) blocked++;
      else server.send(frame);
    });
  });
  await page.goto(origin);
  await page.getByRole('button', { name: 'Create lobby', exact: true }).click();
  await expect(page.getByTestId('seat-id')).toBeVisible();
  await page.getByRole('button', { name: 'Connect game', exact: true }).click();
  await expect(page.getByTestId('connection-status')).toHaveText('attached');
  await expect(page.getByTestId('connection-status')).toHaveText('disconnected');
  expect(blocked).toBeGreaterThan(0);
  await expect(page.getByTestId('game-id')).toHaveCount(0);
});

test('a not-ready first start never retries automatically when another member later accepts', async ({
  page,
  browser,
  origin,
}) => {
  const messages = starts(page);
  await page.goto(origin);
  await page.getByRole('button', { name: 'Create lobby', exact: true }).click();
  await expect(page.getByTestId('lobby-id')).toBeVisible();
  const lobbyId = await page.getByTestId('lobby-id').innerText();
  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const member = await other.newPage();
    await member.goto(origin);
    await member.getByLabel('Lobby reference (required)').fill(lobbyId);
    await member.getByRole('checkbox').check();
    await member.getByRole('button', { name: 'Join as a new guest' }).click();
    await expect(member.getByTestId('seat-id')).toBeVisible();
    await accept(page);
    await page.getByRole('button', { name: 'Connect game', exact: true }).click();
    await expect(page.getByTestId('connection-status')).toHaveText('attached');
    await page.getByRole('button', { name: 'Attempt first start', exact: true }).click();
    await expect(
      page.getByText(
        'The server rejected this start attempt. Refresh agreements and inspect the current game before deliberately retrying the original intent.',
      ),
    ).toBeVisible();
    await expect(page.getByTestId('game-id')).toHaveCount(0);
    await accept(member);
    expect(messages).toHaveLength(1);
    await page.getByRole('button', { name: 'Retry original first start', exact: true }).click();
    await expect(page.getByTestId('game-phase')).toHaveText('dealing');
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual(messages[0]);
  } finally {
    await other.close();
  }
});

test('expired socket credentials clear the baseline and reconnect never issues a replacement guest', async ({
  page,
  browser,
  origin,
  wall,
}) => {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Create lobby', exact: true }).click();
  await expect(page.getByTestId('lobby-id')).toBeVisible();
  const lobbyId = await page.getByTestId('lobby-id').innerText();
  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const member = await other.newPage();
    await member.goto(origin);
    await member.getByLabel('Lobby reference (required)').fill(lobbyId);
    await member.getByRole('checkbox').check();
    await member.getByRole('button', { name: 'Join as a new guest' }).click();
    await expect(member.getByTestId('seat-id')).toBeVisible();
    await Promise.all([accept(page), accept(member)]);
    await page.getByRole('button', { name: 'Connect game', exact: true }).click();
    await expect(page.getByTestId('connection-status')).toHaveText('attached');
    await page.getByRole('button', { name: 'Attempt first start', exact: true }).click();
    await expect(page.getByTestId('game-phase')).toHaveText('dealing');
    const issuance: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/guest/session') issuance.push(request.method());
    });
    wall.now += 30 * 24 * 60 * 60 * 1000 + 1;
    await expect(page.getByTestId('game-id')).toHaveCount(0);
    await page.getByRole('button', { name: 'Connect game', exact: true }).click();
    await expect(page.getByTestId('connection-status')).toHaveText('failed');
    expect(issuance).toEqual([]);
    await expect(page.getByTestId('game-id')).toHaveCount(0);
  } finally {
    await other.close();
  }
});

test('the verified HTTPS and WSS proxy preserves exact Origin rejection', async ({
  page,
  origin,
}) => {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Create lobby', exact: true }).click();
  await expect(page.getByTestId('seat-id')).toBeVisible();
  const guest = (await page.context().cookies(origin)).find(
    (value) => value.name === '__Host-penky_guest',
  )!;
  const cookie = `${guest.name}=${guest.value}`;
  const socket = await external(origin, cookie);
  socket.disconnect();
  await expect(external(origin, cookie, 'https://evil.example')).rejects.toThrow(
    'Fixture socket refused',
  );
  const denied = await page.request.get(`${origin}/socket.io/?EIO=4&transport=polling`, {
    headers: { Origin: 'https://evil.example' },
  });
  expect(denied.status()).toBe(403);
});
