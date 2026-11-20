import { expect } from '@playwright/test';
import type { Page, WebSocketRoute } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { decide, applyAction, validateState } from '../../src/game/engine.ts';
import { id } from '../../src/game/ids.ts';
import type { GameCommand, BranchHead } from '../../src/game/contracts.ts';
import type { GameState } from '../../src/game/model.ts';
import { projectLiveGame } from '../../src/projections/live.ts';
import { projectAction } from '../../src/projections/actions.ts';

/** Explicit late-scenario wire fixture, NOT a persisted/authenticated gameplay server.
 * Real lobby bootstrap supplies identities; only the game-message lane is replaced.
 * Engine transitions and authorized projectors remain real. No raw state is sent.
 */
export async function installScenario(pages: Page[], initial: GameState) {
  const seats = await Promise.all(pages.map((p) => p.getByTestId('seat-id').innerText()));
  const replacements = new Map<string, string>(
    initial.players.map((p, index) => [p.id, seats[index]!]),
  );
  for (const card of initial.cards) replacements.set(card.id, randomUUID());
  replacements.set(initial.gameId, randomUUID());
  let state = JSON.parse(
    JSON.stringify(initial, (_key, value: unknown) =>
      typeof value === 'string' ? (replacements.get(value) ?? value) : value,
    ),
  ) as GameState;
  expect(validateState(state)).toEqual([]);
  let head: BranchHead = { gameId: state.gameId, branchId: id('branch', randomUUID()), version: 1 };
  const epoch = randomUUID();
  let nonce = 1000000;
  const channels = new Map<number, { route: WebSocketRoute; sequence: number }>();
  const packets = pages.map(() => [] as object[]);
  const commands: { type: string; actor: number }[] = [];
  function send(index: number, message: object) {
    const channel = channels.get(index);
    if (!channel) return;
    packets[index]!.push(message);
    channel.route.send(`42${++nonce}${JSON.stringify(['server-message', message, randomUUID()])}`);
  }
  function baseline(index: number) {
    const channel = channels.get(index)!;
    send(index, {
      protocolVersion: 1,
      type: 'state',
      delivery: { epoch, sequence: ++channel.sequence },
      view: projectLiveGame(
        {
          head,
          state,
          connections: state.players.map((p) => ({
            seatId: p.id,
            connected: true,
            controller: 'human',
            disconnectedAtMs: null,
          })),
          paused: state.clock.type !== 'running',
          replacementVote: null,
          controlEvents: [],
        },
        { type: 'seat', seatId: state.players[index]!.id },
        1000,
      ),
    });
  }
  for (const [index, page] of pages.entries()) {
    await page.routeWebSocket('**/socket.io/**', (route) => {
      const server = route.connectToServer();
      route.onMessage((frame) => {
        if (typeof frame === 'string' && frame.startsWith('43')) return; // Synthetic delivery receipts.
        if (typeof frame !== 'string' || !frame.startsWith('42')) {
          server.send(frame);
          return;
        }
        const tuple = JSON.parse(frame.slice(frame.indexOf('[')));
        if (tuple[0] !== 'client-message') {
          server.send(frame);
          return;
        }
        const message = tuple[1] as {
          requestId: string;
          intent: {
            type: string;
            gameId?: string;
            branchId?: string;
            cardId?: string | null;
            procedureId?: string;
          };
        };
        const intent = message.intent;
        if (intent.type === 'resync') {
          channels.set(index, { route, sequence: 0 });
          baseline(index);
          return;
        }
        commands.push({ type: intent.type, actor: index });
        if (intent.gameId !== head.gameId || intent.branchId !== head.branchId)
          throw Error('Wrong fixture route');
        const common = { id: id('command', message.requestId), actorId: state.players[index]!.id };
        let command: GameCommand;
        if (intent.type === 'play-card' || intent.type === 'open-stump')
          command = { ...common, type: intent.type, cardId: id('card', intent.cardId!) };
        else if (intent.type === 'take-bottom') command = { ...common, type: 'take-bottom' };
        else if (intent.type === 'penalty-response')
          command = {
            ...common,
            type: 'penalty-response',
            procedureId: id('procedure', intent.procedureId!),
            cardId: intent.cardId === null ? null : id('card', intent.cardId!),
          };
        else throw Error('Unscoped fixture command');
        const before = { head, state };
        const decision = decide(state, command, { nowMs: 1000, randomInt: (upper) => upper - 1 });
        if (decision.type === 'rejected') {
          send(index, {
            protocolVersion: 1,
            type: 'command-ack',
            requestId: message.requestId,
            result: { type: 'rejected', code: decision.code, head },
          });
          return;
        }
        state = applyAction(state, decision.action);
        head = { ...head, version: head.version + 1 };
        expect(validateState(state)).toEqual([]);
        for (const seat of channels.keys()) {
          const channel = channels.get(seat)!;
          send(seat, {
            protocolVersion: 1,
            type: 'action',
            delivery: { epoch, sequence: ++channel.sequence },
            view: projectAction(
              { before, after: { head, state }, action: decision.action, delivery: 'fresh' },
              { type: 'seat', seatId: state.players[seat]!.id },
            ),
          });
          baseline(seat);
        }
        send(index, {
          protocolVersion: 1,
          type: 'command-ack',
          requestId: message.requestId,
          result: { type: 'accepted', outcome: decision.outcome, duplicate: false, head },
        });
      });
      server.onMessage((frame) => {
        if (typeof frame === 'string' && frame.startsWith('42')) return; // Never mix real and fixture game streams.
        route.send(frame);
      });
    });
  }
  // Register routes before navigation (routing an existing WebSocket is unsupported).
  for (const page of pages) {
    await page.reload();
    await page.getByRole('button', { name: 'Restore my seat', exact: true }).click();
    await expect(page.getByTestId('seat-id')).toBeVisible();
    await page.getByRole('button', { name: 'Connect game', exact: true }).click();
    await expect(page.getByTestId('game-phase')).toHaveText(initial.phase.type);
  }
  return { packets, commands };
}
