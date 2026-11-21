import { projectLiveGame } from '../../src/projections/live.ts';
import { expect } from '@playwright/test';
import { test } from './fixtures.ts';
import { setup } from './dealing-helpers.ts';
import { installScenario } from './play-fixture.ts';
import type { GameState } from '../../src/game/model.ts';
import { scenario, heart } from '../../src/game/testing/scenarios.ts';

for (const variant of ['last-player', 'all-won', 'draw'] as const) {
  test(`explicit late engine/projector fixture: ${variant} result and retained prior winners (not UI-completed match)`, async ({
    browser,
    origin,
    wall,
  }) => {
    const { contexts, pages } = await setup(browser, origin, wall, 3);
    try {
      const initial = scenario({ hands: [[heart(8)], [heart(6)], [heart(7)]] });
      const won = (i: number) =>
        variant === 'all-won' || i === 0 || (variant === 'last-player' && i === 2);
      const state: GameState = {
        ...initial,
        discard: [...initial.discard, ...initial.players.flatMap((p, i) => (won(i) ? p.hand : []))],
        players: initial.players.map((p, i) => ({
          ...p,
          hand: won(i) ? [] : p.hand,
          status: won(i) ? 'won' : 'active',
        })),
        phase: {
          type: 'finished',
          result:
            variant === 'all-won'
              ? { type: variant }
              : variant === 'last-player'
                ? { type: variant, loserId: initial.players[1]!.id }
                : { type: variant, remainingSeatIds: initial.players.slice(1).map((p) => p.id) },
        },
      };
      const wire = await installScenario(pages, state);
      const owner = pages[0]!;
      await expect(owner.getByTestId('match-results')).toContainText(
        variant === 'all-won'
          ? 'All players won.'
          : variant === 'last-player'
            ? 'Last player — loser: Seat 2.'
            : 'Draw — remaining participants: Seat 2, Seat 3.',
      );
      await expect(owner.getByTestId('match-results')).toContainText('Winners: Seat 1');
      await expect(
        owner.getByRole('button', { name: 'Attempt next match', exact: true }),
      ).toBeEnabled();
      await expect(
        pages[1]!.getByRole('button', { name: 'Attempt next match', exact: true }),
      ).toHaveCount(0);
      if (variant !== 'all-won') {
        expect(JSON.stringify(wire.packets[0])).not.toContain('"rank":6');
        await expect(owner.getByTestId('own-hand')).not.toContainText('6 of hearts');
      }
      await expect(owner.getByTestId('fresh-peek')).toHaveCount(0);
    } finally {
      await Promise.all(contexts.map((c) => c.close()));
    }
  });
}

test('explicit projector wire fixture: failed/uncertain next start, exact retry after fork and historical ack state-only adoption', async ({
  browser,
  origin,
  wall,
}) => {
  let active = false;
  let finishedView: object;
  let current: object;
  let actualBaseline: ReturnType<typeof projectLiveGame> | null = null;
  let response: 'reject' | 'lose' | 'accept' = 'reject';
  const requests: { requestId: string; intent: { expected: object } }[] = [];
  let nonce = 100000;
  const { contexts, pages } = await setup(browser, origin, wall, 2, async (page) => {
    await page.routeWebSocket('**/socket.io/**', (route) => {
      const server = route.connectToServer();
      let sequence = 0;
      const send = (message: object) =>
        route.send(`42${++nonce}${JSON.stringify(['server-message', message, `nonce-${nonce}`])}`);
      route.onMessage(async (frame) => {
        if (active && typeof frame === 'string' && frame.startsWith('43')) return;
        if (active && typeof frame === 'string' && frame.startsWith('42')) {
          const tuple = JSON.parse(frame.slice(frame.indexOf('[')));
          const m = tuple[1];
          if (tuple[0] === 'client-message' && m.intent.type === 'resync') {
            send({
              protocolVersion: 1,
              type: 'state',
              delivery: { epoch: `fixture-${nonce}`, sequence: ++sequence },
              view: current,
            });
            return;
          }
          if (tuple[0] === 'client-message' && m.intent.type === 'start-match') {
            requests.push(m);
            if (response === 'lose') {
              await route.close();
              return;
            }
            send({
              protocolVersion: 1,
              type: 'match-start-ack',
              requestId: m.requestId,
              result:
                response === 'reject'
                  ? { type: 'rejected', code: 'unavailable' }
                  : { type: 'started', gameId: 'historical-ack-game', duplicate: true },
            });
            return;
          }
        }
        server.send(frame);
      });
      server.onMessage((frame) => {
        if (typeof frame === 'string' && frame.startsWith('42')) {
          const t = JSON.parse(frame.slice(frame.indexOf('[')));
          if (t[1]?.type === 'state') actualBaseline = t[1].view;
          if (active) return;
        }
        route.send(frame);
      });
    });
  });
  try {
    const owner = pages[0]!;
    const ownId = await owner.getByTestId('seat-id').innerText();
    const otherId = await pages[1]!.getByTestId('seat-id').innerText();
    const initial = scenario({ hands: [[heart(8)], [heart(6)]] });
    const state: GameState = {
      ...initial,
      players: initial.players.map((p, i) => ({
        ...p,
        id: (i === 0 ? ownId : otherId) as typeof p.id,
        hand: i === 0 ? [] : p.hand,
        status: i === 0 ? 'won' : 'active',
      })),
      discard: [...initial.discard, ...initial.players[0]!.hand],
      phase: {
        type: 'finished',
        result: { type: 'last-player', loserId: otherId as typeof initial.ownerId },
      },
    };
    finishedView = projectLiveGame(
      {
        head: { gameId: state.gameId, branchId: 'finished-branch' as never, version: 7 },
        state,
        connections: [],
        paused: false,
        replacementVote: null,
        controlEvents: [],
      },
      { type: 'seat', seatId: ownId as never },
      1000,
    );
    current = finishedView;
    active = true;
    await owner.getByRole('button', { name: 'Resync game', exact: true }).click();
    await expect(owner.getByTestId('match-results')).toContainText('Last player');
    await owner.getByRole('button', { name: 'Attempt next match', exact: true }).click();
    await expect(
      owner.getByText('The server rejected this start attempt.', { exact: false }),
    ).toBeVisible();
    await expect(owner.getByTestId('match-results')).toBeVisible();
    response = 'lose';
    await owner.getByRole('button', { name: 'Retry original next match', exact: true }).click();
    await expect(owner.getByTestId('connection-status')).toHaveText('uncertain');
    current = { ...finishedView, head: { gameId: state.gameId, branchId: 'fork', version: 9 } };
    await owner.getByRole('button', { name: 'Connect game', exact: true }).click();
    await expect(owner.getByTestId('match-results')).toBeVisible();
    expect(requests).toHaveLength(2);
    response = 'accept';
    current = {
      ...((actualBaseline as ReturnType<typeof projectLiveGame> | null) ?? {}),
      head: { gameId: 'actual-next-game', branchId: 'actual-next-branch', version: 0 },
      transient: { initialRecipientNotice: false, reveal: null },
    };
    await owner.getByRole('button', { name: 'Retry original next match', exact: true }).click();
    await expect(owner.getByTestId('game-id')).toHaveText('actual-next-game');
    await expect(owner.getByTestId('match-results')).toHaveCount(0);
    await expect(owner.getByTestId('fresh-peek')).toHaveCount(0);
    await owner.getByRole('button', { name: 'Retry original next match', exact: true }).click();
    await expect(owner.getByTestId('connection-status')).toHaveText('observing');
    await expect(owner.getByTestId('game-id')).toHaveText('actual-next-game');
    expect(requests).toHaveLength(4);
    for (const request of requests) expect(request).toEqual(requests[0]);
    expect(requests[0]!.intent.expected).toEqual({
      gameId: state.gameId,
      branchId: 'finished-branch',
      version: 7,
    });
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
