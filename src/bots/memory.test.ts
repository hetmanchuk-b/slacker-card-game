import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id } from '../game/ids.ts';
import { GameRuntime } from '../runtime/runtime.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import { observeBotCurrent } from './observation.ts';
import { createBotMemory, rememberBotObservation, restoreBotMemory } from './memory.ts';

for (const count of [2, 4, 8]) {
  test(`${count} seats: permitted memory, duplicates, gaps and branch restoration`, async () => {
    const { options, seats, clock } = fixture('reveal', count);
    const runtime = await GameRuntime.create(options);
    try {
      const current = observeBotCurrent(runtime.read(), seats[0]!, clock.now());
      const empty = createBotMemory(current.head.gameId, seats[0]!);
      assert.equal(empty.trump, null);
      const learned = rememberBotObservation(empty, current);
      assert.ok(learned.trump);
      assert.deepEqual(rememberBotObservation(learned, current), learned);
      const paused = { ...current, transient: { initialRecipientNotice: false, reveal: null } };
      assert.deepEqual(rememberBotObservation(learned, paused).trump, learned.trump);
      const branch = id('branch', 'fork');
      const restored = restoreBotMemory(empty, { ...current.head, branchId: branch });
      assert.equal(restored.trump, null, 'abandoned reveal not recovered');
      assert.throws(
        () =>
          rememberBotObservation(learned, {
            ...current,
            head: { ...current.head, branchId: branch },
          }),
        /Invalid memory context/,
      );
      const boundary = {
        ...current,
        head: { ...current.head, version: current.head.version + 1 },
        state: {
          ...current.state!,
          own: { ...current.state!.own!, hand: [] },
          phase: { type: 'between-rounds' as const, leaderId: seats[0]!, nextRoundNumber: 2 },
        },
      };
      const priorRound = { ...learned, phase: 'round:1' };
      assert.equal(
        rememberBotObservation(learned, boundary).opening,
        null,
        'generic between-round baseline cannot prove grant',
      );
      const right = rememberBotObservation(priorRound, boundary, {
        head: boundary.head,
        commandId: id('command', 'round-end'),
        observations: [
          { type: 'card-played', seatId: seats[0]!, card: current.state!.own!.hand[0]! },
        ],
      });
      assert.equal(right.opening?.available, true);
      const round = {
        ...boundary,
        head: { ...boundary.head, version: boundary.head.version + 1 },
        state: {
          ...boundary.state,
          own: { ...boundary.state.own, hand: current.state!.own!.hand },
          phase: { type: 'round' as const, number: 2, targetSize: count, turnSeatId: seats[0]! },
        },
      };
      const obstructed = rememberBotObservation(right, round, {
        head: round.head,
        commandId: id('command', 'obstruct'),
        observations: [
          {
            type: 'penalty-transfer',
            fromSeatId: seats[1]!,
            toSeatId: seats[0]!,
            card: current.state!.own!.hand[0]!,
          },
        ],
      });
      assert.equal(obstructed.opening?.available, true, 'hand obstruction does not erase right');
      assert.equal(
        rememberBotObservation(right, round, {
          head: round.head,
          commandId: id('command', 'redacted-open'),
          observations: [],
        }).opening,
        null,
      );
      const next = { ...round, head: { ...round.head, version: round.head.version + 1 } };
      const consumed = rememberBotObservation(obstructed, next, {
        head: next.head,
        commandId: id('command', 'open'),
        observations: [{ type: 'stump-opened', seatId: seats[0]!, card: null }],
      });
      assert.equal(consumed.opening?.available, false);
      assert.equal(
        rememberBotObservation(consumed, {
          ...next,
          head: { ...next.head, version: next.head.version + 2 },
        }).opening,
        null,
      );
      assert.deepEqual(
        restoreBotMemory(right, { ...right.head!, branchId: branch }).opening,
        right.opening,
      );
      assert.throws(
        () => restoreBotMemory(right, { ...right.head!, version: right.head!.version - 1 }),
        /Invalid memory context/,
      );
      assert.throws(
        () =>
          rememberBotObservation(learned, {
            ...current,
            head: { ...current.head, gameId: id('game', 'other') },
          }),
        /Invalid memory context/,
      );
      assert.throws(
        () => rememberBotObservation({ ...learned, seatId: seats[1]! }, current),
        /Invalid memory context/,
      );
      const unknown = rememberBotObservation(
        createBotMemory(current.head.gameId, seats[0]!),
        paused,
      );
      assert.equal(unknown.trump, null, 'missed reveal remains unknown');
      const cloned = structuredClone(learned);
      const output = rememberBotObservation(learned, paused);
      if (output.trump) (output.trump as { suit: string | null }).suit = 'changed';
      assert.deepEqual(learned, cloned);
    } finally {
      await runtime.dispose();
    }
  });
}
