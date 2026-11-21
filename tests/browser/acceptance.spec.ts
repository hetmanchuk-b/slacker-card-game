import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import type { Page } from '@playwright/test';
import type { ClientMessage, ServerMessage } from '../../src/protocol/contracts.ts';
import { test } from './fixtures.ts';
import { GameStream } from '../../src/client/game-stream.ts';
import { setup, initialRecipient } from './dealing-helpers.ts';

// No authority seam: all decisions below read actor DOM/public DOM. The only
// injected websocket code forwards native frames or drops an actual reply.
// Never import engine, runtime, Node socket clients or trusted match fixtures.
function face(text: string) {
  const m = /(6|7|8|9|10|Jack|Queen|King|Ace) of (clubs|diamonds|hearts|spades)/.exec(text);
  if (!m) throw Error(`Missing visible card: ${text}`);
  return { rank: Number(m[1]) || { Jack: 11, Queen: 12, King: 13, Ace: 14 }[m[1]!]!, suit: m[2]! };
}
async function click(pages: Page[], actor: Page, name: string, wall: { now: number }) {
  const version = Number(await actor.getByTestId('game-version').innerText());
  wall.now += 1001; // HTTP/transport rate policy clock only; never gameplay deadlines.
  const button = actor.getByRole('button', { name, exact: true });
  await expect(button).toBeEnabled({ timeout: 5000 });
  await button.click({ timeout: 5000 });
  await expect
    .poll(async () => Number(await actor.getByTestId('game-version').innerText()))
    .toBeGreaterThan(version);
  const next = await actor.getByTestId('game-version').innerText();
  await Promise.all(pages.map((page) => expect(page.getByTestId('game-version')).toHaveText(next)));
}
async function finish(pages: Page[], trump: string | null, wall: { now: number }) {
  const totals = { play: 0, take: 0, open: 0 };
  for (let step = 0; step < 1000; step++) {
    const phase = await pages[0]!.getByTestId('game-phase').innerText();
    if (phase === 'finished') return totals;
    expect(['round', 'between-rounds']).toContain(phase);
    const context = await pages[0]!
      .getByTestId(phase === 'round' ? 'round-context' : 'round-leader')
      .innerText();
    const index = Number(/(?:turn:|Next lead:) Seat (\d+)/.exec(context)?.[1]) - 1;
    const actor = pages[index];
    if (step % 50 === 0) console.log(JSON.stringify({ seats: pages.length, step, totals }));
    if (!actor) throw Error(`Missing public actor: ${context}`);
    const cards = actor.getByTestId('own-hand').getByRole('button');
    const labels = await cards.allTextContents();
    if (!labels.length) {
      // §6.3 automatically takes for empty no-right actors before a settled
      // state is published. A settled empty current actor must open a stump.
      await expect(actor.getByTestId('own-stumps').getByRole('button').first()).toBeVisible();
      await click(pages, actor, 'Use closed stump 1', wall);
      await expect(actor.getByTestId('move-result')).toHaveText('Move accepted.');
      totals.open++;
      continue;
    }
    const table = await actor.getByTestId('public-table').getByRole('listitem').allTextContents();
    const top = table.length ? face(table.at(-1)!) : null;
    const choice = labels.find((label) => {
      const card = face(label);
      return (
        !top ||
        (card.suit === top.suit
          ? card.rank > top.rank || (top.rank === 14 && card.rank === 6)
          : top.suit !== 'spades' && card.suit === trump)
      );
    });
    await click(pages, actor, choice ?? 'Take bottom card', wall);
    await expect(actor.getByTestId('move-result')).toHaveText('Move accepted.');
    totals[choice ? 'play' : 'take']++;
  }
  throw Error(`UI match exceeded 1000 moves: ${JSON.stringify(totals)}`);
}

for (const count of [2, 4, 8]) {
  test(`acceptance native UI completes isolated ${count}-seat match`, async ({
    browser,
    origin,
    wall,
  }) => {
    test.setTimeout(600000);
    const requests: ClientMessage[] = [];
    const requestPages = new Map<string, Page>();
    const messages: ServerMessage[][] = [];
    let loseDraw = false;
    let lostRequest: string | null = null;
    const { pages, contexts } = await setup(
      browser,
      origin,
      wall,
      count,
      async (page) => {
        const received: ServerMessage[] = [];
        messages.push(received);
        await page.routeWebSocket('**/socket.io/**', (route) => {
          const server = route.connectToServer();
          route.onMessage((frame) => {
            if (typeof frame === 'string' && frame.startsWith('42')) {
              const [event, message] = JSON.parse(frame.slice(frame.indexOf('[')));
              if (event === 'client-message') {
                requests.push(message);
                requestPages.set(message.requestId, page);
                if (loseDraw && message.intent.type === 'draw-card')
                  lostRequest = message.requestId;
              }
            }
            server.send(frame);
          });
          server.onMessage(async (frame) => {
            if (typeof frame === 'string' && frame.startsWith('42')) {
              const [event, message] = JSON.parse(frame.slice(frame.indexOf('[')));
              if (event === 'server-message') received.push(message);
              if (
                loseDraw &&
                event === 'server-message' &&
                message.type === 'command-ack' &&
                message.requestId === lostRequest
              ) {
                loseDraw = false;
                await route.close();
                return;
              }
            }
            route.send(frame);
          });
        });
      },
      true,
    );
    try {
      if (count === 8) {
        await pages[0]!.setViewportSize({ width: 360, height: 800 });
        expect(
          await pages[0]!.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        ).toBe(true);
      }
      const first = await initialRecipient(pages);
      if (count === 4) await procedures(pages, wall);
      if (count === 2) {
        loseDraw = true;
        await pages[first]!.getByRole('button', { name: 'Draw card', exact: true }).click();
        await expect(pages[first]!.getByTestId('draw-result')).toContainText('uncertain');
        const draws = requests.filter((r) => r.intent.type === 'draw-card').length;
        await pages[first]!.getByRole('button', { name: 'Connect game', exact: true }).click();
        await expect(pages[first]!.getByTestId('deck-count')).toHaveText('35');
        await expect(pages[first]!.getByTestId('draw-actor')).toBeEmpty();
        expect(requests.filter((r) => r.intent.type === 'draw-card')).toHaveLength(draws);
      }
      for (let n = count === 2 ? 1 : 0; n < 36; n++) {
        wall.now += 1001;
        const button = pages[(first + n) % count]!.getByRole('button', {
          name: 'Draw card',
          exact: true,
        });
        if (n === 0 && count === 8) {
          const actor = pages[(first + n) % count]!;
          const session = await actor.context().newCDPSession(actor);
          await session.send('Emulation.setTouchEmulationEnabled', { enabled: true });
          await button.scrollIntoViewIfNeeded();
          const box = (await button.boundingBox())!;
          await session.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
          });
          await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await session.detach();
        } else if (n === 0) {
          await button.focus();
          await button.press('Enter');
        } else await button.click();
        for (const p of pages) await expect(p.getByTestId('deck-count')).toHaveText(String(35 - n));
      }
      const remembered = face(await pages[0]!.getByTestId('final-reveal').innerText());
      const trump = remembered.suit === 'spades' ? null : remembered.suit;
      // Await the real server reveal deadline; never advance browser gameplay time.
      await expect(pages[0]!.getByTestId('game-phase')).not.toHaveText('trump-reveal', {
        timeout: 15000,
      });
      if (count === 4) {
        await penalty(pages, wall);
        await rollback(pages, wall);
      }
      const totals = await finish(pages, trump, wall);
      if (count === 4) {
        const transferred = messages
          .flat()
          .filter((m) => m.type === 'action')
          .flatMap((m) => m.view.observations)
          .filter((o) => o.type === 'penalty-transfer');
        expect(transferred).toHaveLength(2); // Exactly donor and recipient receive the one reserved card.
      }
      for (const page of pages) {
        await expect(page.getByTestId('game-phase')).toHaveText('finished');
        await expect(page.getByTestId('match-results')).toContainText(
          /Last player|All players won|Draw/,
        );
      }
      for (let i = 0; i < count; i++) {
        const seat = await pages[i]!.getByTestId('seat-id').innerText();
        privacy(messages[i]!, seat, requests, pages[i]!, requestPages);
        await expect(pages[i]!.getByTestId('own-stumps')).not.toContainText(
          /of (clubs|diamonds|hearts|spades)/,
        );
        const before = messages[i]!.filter((m) => m.type === 'action').length;
        const states = messages[i]!.filter((m) => m.type === 'state').length;
        await pages[i]!.getByRole('button', { name: 'Resync game', exact: true }).click();
        await expect
          .poll(() => messages[i]!.filter((m) => m.type === 'state').length)
          .toBeGreaterThan(states);
        await expect(pages[i]!.getByTestId('game-phase')).toHaveText('finished');
        await expect(pages[i]!.getByTestId('draw-actor')).toBeEmpty();
        await expect(pages[i]!.getByTestId('play-observations')).toBeEmpty();
        await expect(pages[i]!.getByTestId('penalty-transfers')).toBeEmpty();
        await expect(pages[i]!.getByTestId('fresh-peek')).toHaveCount(0);
        expect(messages[i]!.filter((m) => m.type === 'action')).toHaveLength(before);
        privacy(messages[i]!, seat, requests, pages[i]!, requestPages);
      }
      if (count === 2)
        expect(requests.filter((r) => r.intent.type === 'draw-card')).toHaveLength(36);
      expect(new Set(requests.map((r) => r.requestId)).size).toBe(requests.length);
      console.log(
        JSON.stringify({
          seats: count,
          completed: true,
          totals,
          nativeRequests: requests.length,
          intents: Object.fromEntries(
            [...new Set(requests.map((r) => r.intent.type))].map((type) => [
              type,
              requests.filter((r) => r.intent.type === type).length,
            ]),
          ),
          acceptedAcksObservedAtProxy: messages
            .flat()
            .filter((m) => m.type === 'command-ack' && m.result.type === 'accepted').length,
          result: await pages[0]!.getByTestId('match-results').innerText(),
        }),
      );
    } finally {
      await Promise.all(contexts.map((c) => c.close()));
    }
  });
}

async function procedures(pages: Page[], wall: { now: number }) {
  const owner = pages[0]!;
  const accused = await pages[1]!.getByTestId('seat-id').innerText();
  await owner.getByLabel('Chat message (required)').fill('  <exact acceptance> 😀\n retained  ');
  await owner.getByRole('button', { name: 'Post chat message', exact: true }).click();
  await expect(owner.getByTestId('chat-status')).toHaveText('Chat reply confirmed.');
  const retained = await owner.getByTestId('chat-message').innerText();
  await owner.getByLabel('Accused seat (required)').selectOption(accused);
  await owner.getByLabel('Reason (required)').fill('Integrated spoken episode');
  await owner.getByLabel('Exact spoken episode key (required)').fill('  acceptance episode  ');
  await click(pages, owner, 'Submit claim', wall);
  await click(pages, pages[2]!, 'Vote yes', wall);
  await expect(pages[2]!.getByTestId('claim-ballot')).toContainText('Your confirmed vote: yes');
  await click(pages, owner, 'Request withdrawal', wall);
  const frozen = await owner.getByTestId('claim-ballot').getByTestId('procedure-time').innerText();
  await pages[3]!.getByRole('button', { name: 'Disconnect game', exact: true }).click();
  await pages[2]!.getByRole('button', { name: 'Disconnect game', exact: true }).click();
  await expect(owner.getByTestId('game-paused')).toHaveText('Paused');
  await expect(
    owner.getByTestId('withdrawal-procedure').getByTestId('procedure-time'),
  ).toContainText('Paused');
  await new Promise((resolve) => setTimeout(resolve, 30100));
  await owner.getByRole('button', { name: 'Propose bot for Seat 4', exact: true }).click();
  await expect(owner.getByTestId('replacement-vote')).toBeVisible();
  await expect(owner.getByTestId('claim-ballot').getByTestId('procedure-time')).toHaveText(frozen);
  await pages[3]!.getByRole('button', { name: 'Connect game', exact: true }).click();
  await expect(owner.getByTestId('replacement-vote')).toHaveCount(0);
  await expect(
    owner.getByTestId(`presence-${await pages[3]!.getByTestId('seat-id').innerText()}`),
  ).toContainText('Human control');
  await expect(pages[3]!.getByTestId('draw-actor')).toBeEmpty();
  // Seat 3 has the same real >30s absence: complete assignment without another
  // clock advance, then return its human before continuing any game decisions.
  await expect(owner.getByTestId('game-paused')).toHaveText('Paused');
  await owner.getByRole('button', { name: 'Propose bot for Seat 3', exact: true }).click();
  await expect(owner.getByTestId('replacement-vote')).toBeVisible();
  await owner.getByRole('button', { name: 'Replacement vote yes', exact: true }).click();
  // The runtime settles after all eligible replies (or its deadline), not as
  // soon as a majority becomes inevitable. The returned fourth seat votes too.
  await Promise.all(
    [1, 3].map((index) =>
      pages[index]!.getByRole('button', { name: 'Replacement vote yes', exact: true }).click(),
    ),
  );
  const replaced = await pages[2]!.getByTestId('seat-id').innerText();
  await expect(owner.getByTestId(`presence-${replaced}`)).toContainText('Bot control');
  await expect(owner.getByTestId('deck-count')).toHaveText('36');
  await pages[2]!.getByRole('button', { name: 'Connect game', exact: true }).click();
  await expect(owner.getByTestId(`presence-${replaced}`)).toContainText('Human control');
  await expect(pages[2]!.getByTestId('draw-actor')).toBeEmpty();

  for (const page of pages.slice(1)) await click(pages, page, 'Approve withdrawal', wall);
  await expect(owner.getByTestId('claim-ballot')).toHaveCount(0);
  await expect(owner.getByTestId('chat-message')).toHaveText(retained);
  const first = await initialRecipient(pages);
  await click(pages, pages[(first + 1) % pages.length]!, 'Draw card', wall);
  await expect(pages[(first + 1) % pages.length]!.getByTestId('draw-result')).toContainText(
    'violation',
  );
}
async function penalty(pages: Page[], wall: { now: number }) {
  for (const page of pages) await expect(page.getByTestId('penalty-procedure')).toBeVisible();
  let reserved = false;
  for (const page of pages) {
    const refuse = page.getByRole('button', { name: 'Refuse contribution', exact: true });
    if (!(await refuse.count())) continue;
    if (!reserved) {
      const select = page.getByLabel('Card to reserve (required)');
      const value = await select.locator('option').nth(1).getAttribute('value');
      await select.selectOption(value!);
      await click(pages, page, 'Reserve selected card', wall);
      await expect(page.getByTestId('own-reservation')).toContainText('Still in your hand');
      reserved = true;
    } else await click(pages, page, 'Refuse contribution', wall);
  }
  expect(reserved).toBe(true);
  for (const page of pages) await expect(page.getByTestId('penalty-procedure')).toHaveCount(0);
}
async function rollback(pages: Page[], wall: { now: number }) {
  const owner = pages[0]!;
  const retained = await owner.getByTestId('chat-message').innerText();
  const hands = await Promise.all(pages.map((p) => p.getByTestId('own-hand').textContent()));
  const leader =
    Number(/Seat (\d+)/.exec(await owner.getByTestId('round-leader').innerText())![1]) - 1;
  const before = Number(await owner.getByTestId('game-version').innerText());
  const name = await pages[leader]!.getByTestId('own-hand').getByRole('button').first().innerText();
  await click(pages, pages[leader]!, name, wall);
  await owner.getByRole('button', { name: 'Refresh owner history', exact: true }).click();
  for (
    let n = 0;
    n < 30 &&
    (await owner.getByRole('button', { name: 'Read next history page', exact: true }).count());
    n++
  )
    await owner.getByRole('button', { name: 'Read next history page', exact: true }).click();
  await expect(owner.getByText('History: complete.', { exact: false })).toBeVisible();
  await owner.getByLabel(`Select branch 1 action ${before + 1}`, { exact: true }).check();
  await owner.getByRole('button', { name: 'Review selected rollback', exact: true }).click();
  const modal = owner.getByRole('dialog', { name: 'Confirm owner rollback' });
  await expect(modal.getByText(/cannot erase human memory/)).toBeVisible();
  await modal.getByRole('button', { name: 'Confirm rollback — I understand', exact: true }).click();
  for (let i = 0; i < pages.length; i++) {
    await expect(pages[i]!.getByTestId('rollback-notice')).toContainText(`action ${before + 1}`);
    await expect(pages[i]!.getByTestId('game-phase')).toHaveText('between-rounds');
    await expect(pages[i]!.getByTestId('public-table').getByRole('listitem')).toHaveCount(0);
    await expect(pages[i]!.getByTestId('own-hand')).toHaveText(hands[i]!);
  }
  await expect(owner.getByTestId('chat-message')).toHaveText(retained);
  await owner.getByRole('button', { name: 'Read chat from beginning', exact: true }).click();
  await expect(owner.getByTestId('chat-page').getByTestId('chat-message')).toHaveText(retained);
}

function privacy(
  messages: ServerMessage[],
  seat: string,
  requests: ClientMessage[],
  receiver: Page,
  requestPages: Map<string, Page>,
) {
  const allowed = (value: object, keys: string[]) =>
    assert.deepEqual(Object.keys(value).sort(), keys.sort());
  function facePaths(value: unknown, path = ''): string[] {
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([key, child]) => {
      const next = `${path}.${key}`;
      return key === 'face' ? [next] : facePaths(child, next);
    });
  }
  const actionIds = messages.filter((m) => m.type === 'action').map((m) => m.view.commandId);
  assert.equal(new Set(actionIds).size, actionIds.length);
  for (const message of messages) {
    for (const path of facePaths(message)) {
      const permitted =
        message.type === 'state'
          ? /^\.view\.(?:state\.(?:own\.hand|table)\.\d+|transient\.reveal\.card|procedure\.ownResponse\.card)\.face$/
          : message.type === 'action'
            ? /^\.view\.observations\.\d+\.card\.face$/
            : /$^/;
      assert.match(path, permitted);
    }
    if (message.type === 'state') {
      const v = message.view;
      assert.equal(new GameStream(seat, () => 0).receive(message), 'state');
      allowed(v, ['head', 'state', 'transient', 'procedure', 'control']);
      if (!v.state) continue;
      allowed(v.state, ['viewer', 'players', 'own', 'deckCount', 'table', 'discardCount', 'phase']);
      assert.equal(v.state.own?.seatId, seat);
      for (const player of v.state.players)
        allowed(player, ['id', 'status', 'handCount', 'stumpCount']);
      allowed(v.state.own!, ['seatId', 'hand', 'stumps']);
      assert.ok(v.state.own!.stumps.every((id) => typeof id === 'string'));
      if (v.procedure?.type === 'penalty' && v.procedure.ownResponse?.type === 'card') {
        const reservation = v.procedure.ownResponse.card;
        assert.ok(v.state.own!.hand.some((card) => isDeepStrictEqual(card, reservation)));
      }
    } else if (message.type === 'action') {
      allowed(message.view, ['head', 'commandId', 'observations']);
      for (const observation of message.view.observations) {
        if (observation.type === 'card-drawn' || observation.type === 'stump-opened') {
          if (
            observation.seatId !== seat ||
            (observation.type === 'card-drawn' && observation.destination === 'stump')
          )
            assert.equal(observation.card, null);
        }
        if (observation.type === 'penalty-transfer')
          assert.ok(
            [observation.fromSeatId, observation.toSeatId].includes(
              seat as typeof observation.fromSeatId,
            ),
          );
        if (observation.type === 'stump-peeked') {
          const request: ClientMessage | undefined = requests.find(
            (r) => r.requestId === message.view.commandId,
          );
          assert.equal(request?.intent.type, 'open-stump');
          assert.equal(requestPages.get(message.view.commandId), receiver);
        }
      }
    }
    assert.doesNotMatch(
      JSON.stringify(message),
      /"(?:cards|peekedStumps|events|randomOutcomes|shuffledDeck|trumpSuit|responses|votes)":/,
    );
  }
}
