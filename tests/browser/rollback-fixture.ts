import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { projectLiveGame } from '../../src/projections/live.ts';
import type { RuntimeSnapshot } from '../../src/runtime/runtime.ts';

/** Projected engine/runtime checkpoint lane only; NOT authenticated gameplay or a UI-completed match. */
export async function installRollbackFixture(
  pages: Page[],
  before: RuntimeSnapshot,
  restored: RuntimeSnapshot,
) {
  const actual = await Promise.all(pages.map((p) => p.getByTestId('seat-id').innerText()));
  const replacements = new Map<string, string>(
    before.state!.players.map((p, i) => [p.id, actual[i]!]),
  );
  for (const c of before.state!.cards) replacements.set(c.id, randomUUID());
  const convert = (v: unknown) =>
    JSON.parse(
      JSON.stringify(v, (_key, value: unknown) =>
        typeof value === 'string' ? (replacements.get(value) ?? value) : value,
      ),
    );
  let rolled = false,
    nonce = 1000000;
  const channels: { send: (m: object) => void; baseline: () => void; reset: () => void }[] = [];
  const packets: object[][] = pages.map(() => []);
  for (const [index, page] of pages.entries()) {
    await page.routeWebSocket('**/socket.io/**', (route) => {
      const server = route.connectToServer();
      let sequence = 0;
      const send = (m: object) => {
        packets[index]!.push(m);
        route.send(`42${++nonce}${JSON.stringify(['server-message', convert(m), randomUUID()])}`);
      };
      const baseline = () =>
        send({
          protocolVersion: 1,
          type: 'state',
          delivery: { epoch: rolled ? 'restored' : 'initial', sequence: ++sequence },
          view: projectLiveGame(
            rolled ? restored : before,
            { type: 'seat', seatId: before.state!.players[index]!.id },
            100000,
          ),
        });
      channels[index] = {
        send,
        baseline,
        reset: () => {
          sequence = 1;
        },
      };
      route.onMessage((frame) => {
        if (typeof frame === 'string' && frame.startsWith('43')) return;
        if (typeof frame !== 'string' || !frame.startsWith('42')) {
          server.send(frame);
          return;
        }
        const t = JSON.parse(frame.slice(frame.indexOf('['))),
          m = t[1];
        if (t[0] !== 'client-message') {
          server.send(frame);
          return;
        }
        if (m.intent.type === 'resync') {
          baseline();
          return;
        }
        if (m.intent.type === 'owner-history-page') {
          const head = { gameId: before.head.gameId, branch: 1, version: 1 };
          send({
            protocolVersion: 1,
            type: 'owner-history-page',
            requestId: m.requestId,
            delivery: { epoch: 'initial', sequence: ++sequence },
            result: {
              type: 'page',
              head,
              rollbackOpen: true,
              snapshot: 'a'.repeat(64),
              next: null,
              entries: [
                { type: 'branch', branch: { head, label: 'active', parent: null } },
                {
                  type: 'action',
                  branch: 1,
                  action: {
                    version: 1,
                    origin: { branch: 1, version: 1 },
                    occurredAtMs: 1000,
                    summaries: [{ type: 'server-action' }],
                    rollbackTarget: { expected: head, beforeActionVersion: 1 },
                  },
                },
              ],
            },
          });
          return;
        }
        if (m.intent.type === 'rollback') {
          expect(m.intent.knowledgeWarningAcknowledged).toBe(true);
          rolled = true;
          for (const c of channels) {
            c.reset();
            c.send({
              protocolVersion: 1,
              type: 'rollback-notice',
              delivery: { epoch: 'restored', sequence: 1 },
              notice: {
                actorId: before.state!.ownerId,
                target: m.intent.target,
                head: { gameId: before.head.gameId, branch: 2, version: 1 },
              },
            });
            c.baseline();
          }
          send({
            protocolVersion: 1,
            type: 'command-ack',
            requestId: m.requestId,
            result: { type: 'accepted', outcome: 'control', head: restored.head, duplicate: false },
          });
          return;
        }
        throw Error('Unexpected fixture intent');
      });
      server.onMessage((frame) => {
        if (typeof frame === 'string' && frame.startsWith('42')) return;
        route.send(frame);
      });
    });
  }
  for (const page of pages) {
    await page.reload();
    await page.getByRole('button', { name: 'Restore my seat', exact: true }).click();
    await page.getByRole('button', { name: 'Connect game', exact: true }).click();
    await expect(page.getByTestId('connection-status')).toHaveText('observing');
  }
  return packets;
}
