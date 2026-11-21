import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id } from '../game/ids.ts';
import { GameRuntime } from '../runtime/runtime.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import { observeBotCurrent } from './observation.ts';
import { createBotMemory, rememberBotObservation } from './memory.ts';

for (const count of [2, 4, 8]) {
  test(`${count}: initial notice, successful/rejected draws and private final draw`, async () => {
    const { options, seats, clock } = fixture('vote', count);
    const runtime = await GameRuntime.create(options);
    try {
      const snapshot = runtime.read();
      const phase = snapshot.state!.phase;
      if (phase.type !== 'dealing') assert.fail();
      const seatId = phase.nextSeatId;
      const current = observeBotCurrent(snapshot, seatId, clock.now());
      let memory = rememberBotObservation(createBotMemory(current.head.gameId, seatId), current);
      assert.equal(memory.dealing!.successfulDraws, 0);
      const next = {
        ...current,
        head: { ...current.head, version: current.head.version + 1 },
        transient: { ...current.transient, initialRecipientNotice: false },
      };
      const draw = {
        head: next.head,
        commandId: id('command', 'draw'),
        observations: [
          { type: 'card-drawn' as const, seatId, destination: 'stump' as const, card: null },
        ],
      };
      memory = rememberBotObservation(memory, next, draw);
      assert.equal(memory.dealing!.successfulDraws, 1);
      assert.equal(memory.dealing!.nextSeatId, seats[(seats.indexOf(seatId) + 1) % count]);
      assert.deepEqual(rememberBotObservation(memory, next, draw), memory);
      const redacted = { ...next, head: { ...next.head, version: next.head.version + 1 } };
      assert.equal(
        rememberBotObservation(memory, redacted, {
          head: redacted.head,
          commandId: id('command', 'redacted-draw'),
          observations: [],
        }).dealing,
        null,
      );
      const rejected = { ...next, head: { ...next.head, version: next.head.version + 1 } };
      const unchanged = rememberBotObservation(memory, rejected, {
        head: rejected.head,
        commandId: id('command', 'wrong'),
        observations: [{ type: 'draw-rejected', seatId }],
      });
      assert.deepEqual(unchanged.dealing, memory.dealing);
      const missed = rememberBotObservation(memory, {
        ...next,
        head: { ...next.head, version: next.head.version + 3 },
      });
      assert.equal(missed.dealing, null);
      const final = {
        ...next,
        head: { ...next.head, version: next.head.version + 1 },
        state: { ...next.state!, deckCount: 0, phase: { type: 'trump-reveal' as const } },
      };
      for (const suit of ['hearts', 'spades'] as const) {
        const privateDraw = {
          head: final.head,
          commandId: id('command', 'final'),
          observations: [
            {
              type: 'card-drawn' as const,
              destination: 'hand' as const,
              seatId,
              card: { id: id('card', 'opaque'), face: { rank: 6 as const, suit } },
            },
          ],
        };
        assert.equal(
          rememberBotObservation(memory, final, privateDraw).trump!.suit,
          suit === 'spades' ? null : suit,
        );
        assert.equal(
          rememberBotObservation(memory, final, {
            ...privateDraw,
            observations: [{ ...privateDraw.observations[0]!, card: null }],
          }).trump,
          null,
        );
      }
    } finally {
      await runtime.dispose();
    }
  });
}
