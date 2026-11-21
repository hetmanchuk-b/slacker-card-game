import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { io } from 'socket.io-client';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ServerMessage, StateMessage } from '../../src/protocol/contracts.ts';

/** Authenticated Node seat driver precondition, NOT a browser/UI-completed match.
 * Choices use only each seat's own wire hand, public table and remembered reveal. */
export async function finishThroughSeats(pages: Page[], origin: string, wall: { now: number }) {
  const peers = await Promise.all(
    pages.map(async (page) => {
      const cookie = (await page.context().cookies(origin)).find(
        (c) => c.name === '__Host-penky_guest',
      )!;
      const seatId = await page.getByTestId('seat-id').innerText();
      const lobbyId = await page.getByTestId('lobby-id').innerText();
      const socket = io(origin, {
        ca: readFileSync(
          new URL('../../src/server/testing/localhost-cert.pem', import.meta.url),
        ).toString(),
        transports: ['websocket'],
        reconnection: false,
        autoConnect: false,
        extraHeaders: { Origin: origin, Cookie: `${cookie.name}=${cookie.value}` },
      });
      const peer = {
        socket,
        seatId,
        lobbyId,
        state: null as StateMessage | null,
        trump: undefined as string | null | undefined,
        messages: [] as ServerMessage[],
      };
      socket.on(
        'server-message',
        (message: ServerMessage, receipt: string, ack: (r: string) => void) => {
          peer.messages.push(message);
          if (message.type === 'state') {
            peer.state = message;
            const reveal = message.view.transient.reveal;
            if (reveal)
              peer.trump = reveal.card.face.suit === 'spades' ? null : reveal.card.face.suit;
          }
          ack(receipt);
        },
      );
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
        socket.connect();
      });
      return peer;
    }),
  );
  async function rpc(peer: (typeof peers)[number], intent: object, requestId = randomUUID()) {
    wall.now += 1001;
    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        peer.socket.off('server-message', receive);
        reject(Error('Node precondition response missing'));
      }, 10000);
      function receive(m: ServerMessage) {
        if (
          m.type !== 'error' &&
          ((intent as { type: string }).type === 'resync'
            ? m.type !== 'state'
            : !('requestId' in m) || m.requestId !== requestId)
        )
          return;
        clearTimeout(timer);
        peer.socket.off('server-message', receive);
        resolve(m);
      }
      peer.socket.on('server-message', receive);
      peer.socket.emit('client-message', { protocolVersion: 1, requestId, intent });
    });
  }
  try {
    for (const peer of peers)
      expect((await rpc(peer, { type: 'resync', lobbyId: peer.lobbyId })).type).toBe('state');
    const first = peers.findIndex((p) => p.state!.view.transient.initialRecipientNotice);
    expect(first).toBeGreaterThanOrEqual(0);
    async function command(peer: (typeof peers)[number], intent: object) {
      const ack = await rpc(peer, intent);
      expect(ack.type).toBe('command-ack');
      if (ack.type !== 'command-ack' || ack.result.type !== 'accepted')
        throw Error(`Precondition command rejected ${JSON.stringify(ack)}`);
      const version = ack.result.head.version;
      await expect
        .poll(() => peers.every((p) => p.state?.view.head.version === version))
        .toBe(true);
    }
    for (let n = 0; n < 36; n++) {
      const peer = peers[(first + n) % peers.length]!;
      const head = peer.state!.view.head;
      await command(peer, { type: 'draw-card', gameId: head.gameId, branchId: head.branchId });
    }
    expect(peers.every((p) => p.trump !== undefined)).toBe(true);
    await expect
      .poll(() => peers[0]!.state?.view.state?.phase.type, { timeout: 15000 })
      .not.toBe('trump-reveal');
    for (let n = 0; n < 1000; n++) {
      const publicView = peers[0]!.state!.view;
      const phase = publicView.state!.phase;
      if (phase.type === 'finished')
        return {
          peers,
          rpc,
          head: publicView.head,
          close: () => peers.forEach((p) => p.socket.disconnect()),
        };
      if (phase.type !== 'round' && phase.type !== 'between-rounds')
        throw Error(`Unexpected phase ${phase.type}`);
      const actor = peers.find(
        (p) => p.seatId === (phase.type === 'round' ? phase.turnSeatId : phase.leaderId),
      )!;
      const view = actor.state!.view;
      const own = view.state!.own!;
      const route = { gameId: view.head.gameId, branchId: view.head.branchId };
      if (!own.hand.length) {
        await command(actor, { type: 'open-stump', ...route, cardId: own.stumps[0] });
        continue;
      }
      const top = view.state!.table.at(-1)?.face;
      const card = own.hand.find(
        ({ face }) =>
          !top ||
          (top.suit === face.suit
            ? face.rank > top.rank || (top.rank === 14 && face.rank === 6)
            : top.suit !== 'spades' && face.suit === actor.trump),
      );
      await command(
        actor,
        card ? { type: 'play-card', ...route, cardId: card.id } : { type: 'take-bottom', ...route },
      );
    }
    throw Error('Node precondition exceeded 1000 moves');
  } catch (error) {
    peers.forEach((p) => p.socket.disconnect());
    throw error;
  }
}
