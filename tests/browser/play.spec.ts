import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './fixtures.ts';
import { setup, deal } from './dealing-helpers.ts';
import { installScenario } from './play-fixture.ts';
import { scenario, heart, club, spade } from '../../src/game/testing/scenarios.ts';
import type { ServerMessage } from '../../src/protocol/contracts.ts';

const play = (page: Page, label: string) =>
  page.getByRole('button', { name: `Play ${label}`, exact: true }).click();
const take = (page: Page) =>
  page.getByRole('button', { name: 'Take bottom card', exact: true }).click();
const stump = (page: Page) =>
  page.getByRole('button', { name: 'Use closed stump 1', exact: true }).click();
async function refuse(pages: Page[], recipient: number) {
  for (const [index, page] of pages.entries())
    if (index !== recipient) {
      await page.getByRole('button', { name: 'Refuse contribution', exact: true }).click();
    }
  for (const page of pages) await expect(page.getByTestId('penalty-procedure')).toHaveCount(0);
}
function observe(page: Page) {
  const messages: ServerMessage[] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string' || !payload.startsWith('42')) return;
      const tuple = JSON.parse(payload.slice(payload.indexOf('[')));
      if (tuple[0] === 'server-message') messages.push(tuple[1] as ServerMessage);
    }),
  );
  return messages;
}

test('real two-seat browser lead, bottom pickup and wrong-turn attempt use committed state', async ({
  browser,
  origin,
  wall,
}) => {
  test.setTimeout(60000);
  const { contexts, pages } = await setup(browser, origin, wall, 2);
  try {
    const { leader } = await deal(pages);
    wall.now += 1001; // Move into the next real transport rate window; never disable its policy.
    for (const page of pages)
      await expect(page.getByTestId('game-phase')).toHaveText('between-rounds', { timeout: 15000 });
    const actor = pages[leader]!,
      other = pages[1 - leader]!;
    const card = await actor.getByTestId('own-hand').getByRole('button').first().innerText();
    const actorCount = await actor.getByTestId('own-hand').getByRole('listitem').count();
    const otherCount = await other.getByTestId('own-hand').getByRole('listitem').count();
    // An empty-table attempt is a technical rejection, not an accepted violation.
    await take(actor);
    await expect(actor.getByTestId('move-result')).toContainText('technically rejected');
    await expect(actor.getByTestId('penalty-procedure')).toHaveCount(0);
    // Native keyboard activation, not a synthetic command/fixture for this move.
    await actor.getByTestId('own-hand').getByRole('button').first().focus();
    await actor.getByTestId('own-hand').getByRole('button').first().press('Enter');
    for (const page of pages)
      await expect(page.getByTestId('public-table').getByRole('listitem')).toHaveCount(1);
    await expect(actor.getByTestId('own-hand').getByRole('listitem')).toHaveCount(actorCount - 1);
    await take(other);
    for (const page of pages)
      await expect(page.getByTestId('public-table').getByRole('listitem')).toHaveCount(0);
    await expect(other.getByTestId('own-hand').getByRole('listitem')).toHaveCount(otherCount + 1);
    await expect(other.getByTestId('own-hand')).toContainText(card.slice(5));
    await expect(actor.getByTestId('round-leader')).toHaveText(`Next lead: Seat ${leader + 1}.`);
    await other.getByTestId('own-hand').getByRole('button').first().click();
    await expect(other.getByTestId('penalty-recipient')).toContainText('play-out-of-turn');
    await expect(other.getByTestId('own-hand').getByRole('listitem')).toHaveCount(otherCount + 1);
    await refuse(pages, 1 - leader);
    await expect(actor.getByTestId('round-leader')).toHaveText(`Next lead: Seat ${leader + 1}.`);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('real four-seat own-stump peek is actor-only, dismissible, penalty-bound and never replayed', async ({
  browser,
  origin,
  wall,
}) => {
  test.setTimeout(60000);
  const { contexts, pages } = await setup(browser, origin, wall, 4);
  try {
    await deal(pages);
    for (const page of pages)
      await expect(page.getByTestId('game-phase')).toHaveText('between-rounds', { timeout: 15000 });
    const logs = pages.map(observe);
    // Fence connections so every test observer sees only current authorized wire data.
    for (const page of pages) {
      await page.getByRole('button', { name: 'Resync game', exact: true }).click();
      await expect(page.getByTestId('game-phase')).toHaveText('between-rounds');
    }
    const actor = pages[0]!;
    const count = await actor.getByTestId('own-hand').getByRole('listitem').count();
    await stump(actor);
    await expect(actor.getByTestId('fresh-peek')).toBeVisible();
    await expect(actor.getByTestId('own-stumps').getByRole('listitem')).toHaveCount(2);
    await expect(actor.getByTestId('own-hand').getByRole('listitem')).toHaveCount(count);
    const observation = logs[0]!
      .flatMap((m) => (m.type === 'action' ? m.view.observations : []))
      .find((o) => o.type === 'stump-peeked');
    if (observation?.type !== 'stump-peeked') throw Error('Missing fresh actor observation');
    for (let i = 1; i < 4; i++) {
      await expect(pages[i]!.getByTestId('fresh-peek')).toHaveCount(0);
      expect(JSON.stringify(logs[i])).not.toContain(observation.card.id);
    }
    await actor.getByRole('button', { name: 'Dismiss private peek', exact: true }).click();
    await expect(actor.getByTestId('fresh-peek')).toHaveCount(0);
    await pages[1]!.getByRole('button', { name: 'Refuse contribution', exact: true }).click();
    await expect(actor.getByTestId('fresh-peek')).toHaveCount(0);
    for (const page of pages.slice(2))
      await page.getByRole('button', { name: 'Refuse contribution', exact: true }).click();
    await expect(actor.getByTestId('penalty-procedure')).toHaveCount(0);
    await stump(actor);
    await expect(actor.getByTestId('fresh-peek')).toBeVisible();
    await pages[1]!.getByRole('button', { name: 'Disconnect game', exact: true }).click();
    await expect(actor.getByTestId('game-paused')).toHaveText('Paused');
    await expect(actor.getByTestId('fresh-peek')).toHaveCount(0);
    await pages[1]!.getByRole('button', { name: 'Connect game', exact: true }).click();
    await expect(actor.getByTestId('game-paused')).toHaveText('Running');
    await expect(actor.getByTestId('fresh-peek')).toHaveCount(0);
    await refuse(pages, 0);
    await stump(actor);
    await expect(actor.getByTestId('fresh-peek')).toBeVisible();
    await refuse(pages, 0);
    await expect(actor.getByTestId('fresh-peek')).toHaveCount(0);
    await stump(actor);
    await expect(actor.getByTestId('fresh-peek')).toBeVisible();
    await actor.getByRole('button', { name: 'Resync game', exact: true }).click();
    await expect(actor.getByTestId('penalty-procedure')).toBeVisible();
    await expect(actor.getByTestId('fresh-peek')).toHaveCount(0);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('explicit engine/projector wire scenarios 2–3: discard, temporary empty hand and final bottom pickup', async ({
  browser,
  origin,
  wall,
}) => {
  const { contexts, pages } = await setup(browser, origin, wall, 2);
  try {
    const fixture = await installScenario(
      pages,
      scenario({
        hands: [
          [heart(6), heart(9)],
          [heart(7), heart(8)],
        ],
      }),
    );
    await play(pages[0]!, '6 of hearts');
    await play(pages[1]!, '7 of hearts');
    await expect(pages[0]!.getByTestId('public-table').getByRole('listitem')).toHaveCount(0);
    await expect(pages[0]!.getByTestId('play-observations')).toContainText('played 7 of hearts');
    await play(pages[1]!, '8 of hearts');
    await take(pages[0]!);
    await expect(pages[0]!.getByTestId('game-phase')).toHaveText('finished');
    expect(fixture.commands.map((c) => c.type)).toEqual([
      'play-card',
      'play-card',
      'play-card',
      'take-bottom',
    ]);
    await installScenario(pages, scenario({ hands: [[heart(10)], [heart(12), club(7)]] }));
    await play(pages[0]!, '10 of hearts');
    await expect(pages[0]!.getByTestId('round-context')).toContainText('fixed target: 2');
    await expect(pages[0]!.getByTestId('own-hand').getByRole('listitem')).toHaveCount(0);
    await take(pages[1]!);
    await expect(pages[0]!.getByTestId('game-phase')).toHaveText('finished');
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('explicit engine/projector wire scenarios 4 and 10: ordered multi-card bottom, six over ace and invalid beat', async ({
  browser,
  origin,
  wall,
}) => {
  const { contexts, pages } = await setup(browser, origin, wall, 4);
  try {
    await installScenario(
      pages,
      scenario({
        hands: [
          [heart(10), heart(6), club(6)],
          [heart(12), heart(9), club(7)],
          [club(8)],
          [heart(14), club(9)],
        ],
      }),
    );
    await play(pages[0]!, '10 of hearts');
    await play(pages[1]!, 'Queen of hearts');
    await play(pages[2]!, '8 of clubs');
    await expect(pages[2]!.getByTestId('penalty-recipient')).toContainText('invalid-beat');
    await expect(pages[0]!.getByTestId('public-table').getByRole('listitem')).toHaveText([
      '10 of hearts — bottom',
      'Queen of hearts — top',
    ]);
    await refuse(pages, 2);
    await take(pages[2]!);
    await expect(pages[2]!.getByTestId('own-hand')).toContainText('10 of hearts');
    await expect(pages[0]!.getByTestId('public-table').getByRole('listitem')).toHaveText([
      'Queen of hearts — bottom — top',
    ]);
    await play(pages[3]!, 'Ace of hearts');
    await play(pages[0]!, '6 of hearts');
    await play(pages[1]!, '9 of hearts');
    await expect(pages[0]!.getByTestId('public-table').getByRole('listitem')).toHaveCount(0);
    await expect(pages[0]!.getByTestId('round-leader')).toHaveText('Next lead: Seat 2.');
    await installScenario(
      pages,
      scenario({
        hands: [
          [club(6)],
          [{ suit: 'diamonds', rank: 10 }, spade(9), club(7)],
          [club(8)],
          [club(9)],
        ],
        table: [spade(8)],
        turn: 1,
        trump: 'diamonds',
      }),
    );
    await play(pages[1]!, '10 of diamonds');
    await refuse(pages, 1);
    await expect(pages[1]!.getByTestId('round-context')).toContainText('turn: Seat 2');
    await expect(pages[1]!.getByTestId('own-hand')).toContainText('10 of diamonds');
    await play(pages[1]!, '9 of spades');
    await expect(pages[0]!.getByTestId('public-table').getByRole('listitem')).toHaveText([
      '8 of spades — bottom',
      '9 of spades — top',
    ]);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('explicit engine/projector wire scenarios 5 and 8: empty active hand peeks without movement and automatically takes bottom', async ({
  browser,
  origin,
  wall,
}) => {
  const { contexts, pages } = await setup(browser, origin, wall, 4);
  try {
    await installScenario(
      pages,
      scenario({
        hands: [[heart(10)], [heart(12), club(7)], [club(8)], [heart(14), club(9)]],
        stumps: [[heart(6)], [], [], []],
      }),
    );
    await play(pages[0]!, '10 of hearts');
    await stump(pages[0]!);
    await expect(pages[0]!.getByTestId('fresh-peek')).toContainText('6 of hearts');
    await expect(pages[0]!.getByTestId('own-hand').getByRole('listitem')).toHaveCount(0);
    await refuse(pages, 0);
    await expect(pages[0]!.getByTestId('fresh-peek')).toHaveCount(0);
    await play(pages[1]!, 'Queen of hearts');
    await take(pages[2]!);
    await play(pages[3]!, 'Ace of hearts');
    await expect(pages[0]!.getByTestId('play-observations')).toContainText(
      'automatically took bottom Queen of hearts',
    );
    await expect(pages[0]!.getByTestId('own-hand')).toContainText('Queen of hearts');
    await expect(pages[0]!.getByTestId('round-context')).toHaveText(
      'Round 2; fixed target: 4; turn: Seat 2.',
    );
    await expect(pages[0]!.getByTestId('public-table').getByRole('listitem')).toHaveText([
      'Ace of hearts — bottom — top',
    ]);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('explicit engine/projector wire scenarios 7 and 9: off-turn legal opening and penalty-updated mandatory opening', async ({
  browser,
  origin,
  wall,
}) => {
  const { contexts, pages } = await setup(browser, origin, wall, 4);
  try {
    const fixture = await installScenario(
      pages,
      scenario({
        hands: [[], [heart(8)], [heart(9)], [heart(10)]],
        stumps: [[club(7)], [], [], []],
        openingSeats: [0],
        leader: 1,
      }),
    );
    await play(pages[1]!, '8 of hearts');
    await stump(pages[0]!);
    await expect(pages[0]!.getByTestId('own-hand')).toContainText('7 of clubs');
    await expect(pages[0]!.getByTestId('own-stumps').getByRole('listitem')).toHaveCount(0);
    await expect(pages[0]!.getByTestId('fresh-peek')).toHaveCount(0);
    await expect(pages[0]!.getByTestId('round-context')).toContainText('turn: Seat 3');
    for (let i = 1; i < 4; i++)
      expect(JSON.stringify(fixture.packets[i])).not.toContain('"rank":7');
    await installScenario(
      pages,
      scenario({
        hands: [
          [],
          [{ suit: 'diamonds', rank: 7 }, heart(7), heart(8)],
          [{ suit: 'diamonds', rank: 8 }],
          [club(6), { suit: 'diamonds', rank: 9 }],
        ],
        stumps: [[heart(6)], [], [], []],
        openingSeats: [0],
        table: [club(8), club(10)],
        turn: 0,
      }),
    );
    await take(pages[0]!);
    await expect(pages[0]!.getByTestId('penalty-recipient')).toContainText('must-open-stump');
    await pages[1]!
      .getByLabel('Card to reserve (required)')
      .selectOption({ label: '7 of diamonds' });
    await pages[1]!.getByRole('button', { name: 'Reserve selected card', exact: true }).click();
    for (const p of pages.slice(2))
      await p.getByRole('button', { name: 'Refuse contribution', exact: true }).click();
    await expect(pages[0]!.getByTestId('own-hand')).toContainText('7 of diamonds');
    await expect(pages[0]!.getByTestId('round-context')).toContainText('turn: Seat 1');
    await take(pages[0]!);
    await expect(pages[0]!.getByTestId('own-hand')).toContainText('8 of clubs');
    await expect(pages[0]!.getByTestId('own-stumps').getByRole('listitem')).toHaveCount(1);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('explicit engine/projector wire scenario 6: eight-seat frozen target and simultaneous boundary exits', async ({
  browser,
  origin,
  wall,
}) => {
  test.setTimeout(60000);
  const { contexts, pages } = await setup(browser, origin, wall, 8);
  try {
    const ranks = [6, 7, 8, 9, 10, 11, 12, 13] as const;
    const extras = [6, 7, 8, 9, 10, 11] as const;
    await installScenario(
      pages,
      scenario({
        hands: ranks.map((rank, i) =>
          i === 0 || i === 7 ? [heart(rank)] : [heart(rank), club(extras[i - 1]!)],
        ),
      }),
    );
    for (let i = 0; i < 8; i++) {
      const label =
        i + 6 === 11 ? 'Jack' : i + 6 === 12 ? 'Queen' : i + 6 === 13 ? 'King' : String(i + 6);
      await play(pages[i]!, `${label} of hearts`);
      if (i < 7)
        await expect(pages[0]!.getByTestId('round-context')).toContainText('fixed target: 8');
    }
    await expect(pages[0]!.getByTestId('public-table').getByRole('listitem')).toHaveCount(0);
    await expect(pages[0]!.getByTestId('round-leader')).toHaveText('Next lead: Seat 2.');
    const seats = pages[0]!.getByRole('list', { name: 'Game seat counts' }).getByRole('listitem');
    await expect(seats.nth(0)).toContainText('won');
    await expect(seats.nth(7)).toContainText('won');
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
