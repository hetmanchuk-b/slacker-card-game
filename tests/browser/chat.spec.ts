import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './fixtures.ts';
import { setup } from './dealing-helpers.ts';
import { io } from 'socket.io-client';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ServerMessage } from '../../src/protocol/contracts.ts';
async function create(page: Page, origin: string) {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Create lobby', exact: true }).click();
  await expect(page.getByTestId('lobby-id')).toBeVisible();
  await page.getByRole('button', { name: 'Connect game', exact: true }).click();
  await expect(page.getByTestId('connection-status')).toHaveText('attached');
}
async function post(page: Page, text: string) {
  await page.getByLabel('Chat message (required)').fill(text);
  await page.getByRole('button', { name: 'Post chat message', exact: true }).click();
  await expect(page.getByLabel('Chat message (required)')).toHaveValue('');
  await expect(page.getByTestId('chat-status')).toHaveText('Chat reply confirmed.');
}

test('real no-game chat preserves plain text and pages byte-bounded prefixes without treating short pages as complete', async ({
  page,
  origin,
  wall,
}) => {
  test.setTimeout(60000);
  await create(page, origin);
  const text = '  <img src=x onerror="document.body.dataset.hacked=1">\n😀 & text  ';
  await post(page, text);
  await expect(page.getByTestId('chat-text')).toHaveText(text, { useInnerText: false });
  expect(await page.evaluate(() => document.body.dataset.hacked)).toBeUndefined();
  for (let index = 0; index < 17; index++) {
    if (index % 7 === 0) wall.now += 1001;
    await post(page, `${index}:` + 'x'.repeat(4090));
  }
  wall.now += 1001;
  await page.getByRole('button', { name: 'Read chat from beginning', exact: true }).click();
  await expect(page.getByTestId('chat-page').getByTestId('chat-message')).not.toHaveCount(0);
  const firstCount = await page.getByTestId('chat-page').getByTestId('chat-message').count();
  expect(firstCount).toBeLessThan(18);
  await expect(page.getByTestId('chat-cursor')).toContainText(
    'A short page does not prove completion',
  );
  await page.getByRole('button', { name: 'Read next chat page', exact: true }).click();
  await expect(page.getByTestId('chat-page').getByTestId('chat-message')).toHaveCount(
    18 - firstCount,
  );
  await page.getByRole('button', { name: 'Read next chat page', exact: true }).click();
  await expect(page.getByTestId('chat-cursor')).toContainText('Empty page');
  await page.getByRole('button', { name: 'Refresh agreements', exact: true }).click();
  await expect(page.getByTestId('agreements-text')).toBeVisible();
});

test('explicit game-denial reply fixture leaves real membership chat usable without a game baseline', async ({
  page,
  origin,
}) => {
  await page.routeWebSocket('**/socket.io/**', (route) => {
    const server = route.connectToServer();
    server.onMessage((frame) => {
      if (typeof frame === 'string' && frame.startsWith('42')) {
        const start = frame.indexOf('['),
          tuple = JSON.parse(frame.slice(start));
        if (
          tuple[0] === 'server-message' &&
          tuple[1]?.type === 'error' &&
          tuple[1]?.code === 'unavailable'
        ) {
          tuple[1] = { protocolVersion: 1, type: 'error', code: 'unauthorized' };
          route.send(frame.slice(0, start) + JSON.stringify(tuple));
          return;
        }
      }
      route.send(frame);
    });
  });
  await create(page, origin);
  await expect(page.getByTestId('game-id')).toHaveCount(0);
  await post(page, 'membership chat after denied game view');
  await expect(page.getByTestId('chat-text')).toHaveText('membership chat after denied game view');
  await expect(page.getByTestId('game-id')).toHaveCount(0);
});

test('real committed lost chat reply retries the original message ID/text after reconnect without duplicate insertion', async ({
  page,
  origin,
}) => {
  let drop = true;
  const posts: { messageId: string; text: string }[] = [];
  await page.routeWebSocket('**/socket.io/**', (route) => {
    const server = route.connectToServer();
    route.onMessage((frame) => {
      if (typeof frame === 'string' && frame.startsWith('42')) {
        const tuple = JSON.parse(frame.slice(frame.indexOf('[')));
        if (tuple[0] === 'client-message' && tuple[1]?.intent?.type === 'post-chat')
          posts.push(tuple[1].intent);
      }
      server.send(frame);
    });
    server.onMessage(async (frame) => {
      if (drop && typeof frame === 'string' && frame.startsWith('42')) {
        const tuple = JSON.parse(frame.slice(frame.indexOf('[')));
        if (tuple[0] === 'server-message' && tuple[1]?.type === 'chat-page') {
          drop = false;
          await route.close();
          return;
        }
      }
      route.send(frame);
    });
  });
  await create(page, origin);
  await page.getByLabel('Chat message (required)').fill('original <b>text</b>');
  await page.getByRole('button', { name: 'Post chat message', exact: true }).click();
  await expect(page.getByTestId('chat-status')).toContainText('uncertain');
  await expect(page.getByLabel('Chat message (required)')).toBeDisabled();
  await page.getByRole('button', { name: 'Connect game', exact: true }).click();
  await expect(page.getByTestId('connection-status')).toHaveText('attached');
  expect(posts).toHaveLength(1);
  await page.getByRole('button', { name: 'Retry original chat message', exact: true }).click();
  await expect(page.getByLabel('Chat message (required)')).toHaveValue('');
  expect(posts).toHaveLength(2);
  expect(posts[1]!.messageId).toBe(posts[0]!.messageId);
  expect(posts[1]!.text).toBe(posts[0]!.text);
  await page.getByRole('button', { name: 'Read chat from beginning', exact: true }).click();
  await expect(page.getByTestId('chat-page').getByTestId('chat-message')).toHaveCount(1);
});

test('real retained chat keeps its original game context after owner rollback to null and state-only reconnect', async ({
  browser,
  origin,
  wall,
}) => {
  const { contexts, pages } = await setup(browser, origin, wall, 2);
  const page = pages[0]!;
  const cert = readFileSync(
    new URL('../../src/server/testing/localhost-cert.pem', import.meta.url),
  );
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
  socket.on('server-message', (_m: unknown, receipt: string, ack: (r: string) => void) =>
    ack(receipt),
  );
  const rpc = (intent: object, type: ServerMessage['type']) =>
    new Promise<ServerMessage>((resolve, reject) => {
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
  try {
    await post(page, 'retained before rollback');
    const context = await page.getByTestId('chat-context').innerText();
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', () => reject(Error('Fixture connection refused')));
      socket.connect();
    });
    await rpc({ type: 'resync', lobbyId: await page.getByTestId('lobby-id').innerText() }, 'state');
    const history = await rpc(
      { type: 'owner-history', gameId: await page.getByTestId('game-id').innerText() },
      'owner-history',
    );
    if (history.type !== 'owner-history') throw Error('No owner fixture metadata');
    await rpc(
      {
        type: 'rollback',
        target: { expected: history.view.head, beforeActionVersion: 1 },
        knowledgeWarningAcknowledged: true,
      },
      'command-ack',
    );
    await expect(page.getByTestId('game-null-state')).toBeVisible();
    await page.getByRole('button', { name: 'Resync game', exact: true }).click();
    await expect(page.getByTestId('game-null-state')).toBeVisible();
    await page.getByRole('button', { name: 'Read chat from beginning', exact: true }).click();
    await expect(page.getByTestId('chat-page').getByTestId('chat-context')).toHaveText(context);
    await pages[1]!.getByRole('button', { name: 'Read chat from beginning', exact: true }).click();
    await expect(pages[1]!.getByTestId('chat-page').getByTestId('chat-text')).toHaveText(
      'retained before rollback',
    );
  } finally {
    socket.disconnect();
    await Promise.all(contexts.map((c) => c.close()));
  }
});
