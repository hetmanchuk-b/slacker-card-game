import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAction, decide } from '../game/engine.ts';
import type { GameCommand } from '../game/contracts.ts';
import type { GameState } from '../game/model.ts';
import { id } from '../game/ids.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import { observeBotAction, observeBotCurrent } from './observation.ts';
import { GameRuntime } from '../runtime/runtime.ts';

function pair(state: GameState, command: GameCommand, nowMs: number) {
  const result = decide(state, command, { nowMs, randomInt: (upper) => upper - 1 });
  if (result.type !== 'accepted') assert.fail(result.code);
  const head = { gameId: state.gameId, branchId: id('branch', 'main'), version: 100 };
  return {
    before: { head, state },
    after: { head: { ...head, version: 101 }, state: applyAction(state, result.action) },
    action: result.action,
    delivery: 'fresh' as const,
  };
}

for (const count of [2, 4, 8]) {
  test(`${count} seats: private transfers reach only donor and recipient and never baseline replay`, async () => {
    const { history, seats, options, clock } = fixture('penalty', count);
    const state = history.read().state!;
    const procedure = state.procedure;
    if (procedure?.type !== 'penalty') assert.fail();
    const donor = state.players.find((player) => procedure.eligibleSeatIds.includes(player.id))!;
    const reservation = pair(
      state,
      {
        type: 'penalty-response',
        id: id('command', 'reserve'),
        actorId: donor.id,
        procedureId: procedure.timer.id,
        cardId: donor.hand[0]!,
      },
      11000,
    );
    const transfer =
      count === 2
        ? reservation
        : pair(
            reservation.after.state,
            { type: 'expire-penalty', id: id('command', 'expire'), timerId: procedure.timer.id },
            21000,
          );
    for (const seat of seats) {
      const observations = observeBotAction(transfer, seat).observations;
      assert.equal(
        observations.some((item) => item.type === 'penalty-transfer'),
        seat === donor.id || seat === procedure.penalty.recipientId,
      );
      assert.deepEqual(
        observeBotAction({ ...transfer, delivery: 'duplicate' }, seat).observations,
        [],
      );
      const original = structuredClone(transfer);
      const privateCard = observations.find((item) => item.type === 'penalty-transfer');
      if (privateCard?.type === 'penalty-transfer')
        (privateCard.card.face as { rank: number }).rank = 99;
      assert.deepEqual(transfer, original);
    }
    const runtime = await GameRuntime.create(options);
    try {
      const snapshot = runtime.read();
      for (const seat of seats) {
        const reserved = observeBotCurrent(
          { ...snapshot, state: reservation.after.state },
          seat,
          11000,
        );
        const p = reserved.procedure;
        if (count > 2) {
          if (p?.type !== 'penalty') assert.fail();
          assert.equal(p.ownResponse !== null, seat === donor.id);
        }
      }
      const finished = {
        ...snapshot,
        state: {
          ...snapshot.state!,
          players: snapshot.state!.players.map((player) =>
            player.id === seats[0] ? { ...player, status: 'won' as const } : player,
          ),
        },
      };
      const input = observeBotCurrent(finished, seats[0]!, clock.now());
      assert.equal(input.state!.viewer.type, 'finished-player');
      assert.equal(Object.hasOwn(input, 'observations'), false);
      const completed = {
        ...finished,
        state: {
          ...finished.state,
          phase: {
            type: 'finished' as const,
            result: { type: 'all-won' as const, winnerIds: seats },
          },
        },
      };
      assert.equal(
        observeBotCurrent(completed, seats[0]!, clock.now()).state!.viewer.type,
        'finished-player',
      );
      for (const fixture of [finished, completed]) {
        const baseline = observeBotCurrent(fixture, seats[0]!, clock.now());
        const opponentIds = fixture.state.players[1]!.hand;
        assert.ok(opponentIds.length > 0);
        for (const cardId of opponentIds)
          assert.equal(JSON.stringify(baseline).includes(`"${cardId}"`), false);
        const changed = structuredClone(fixture);
        const card = changed.state.cards.find((card) => card.id === opponentIds[0])!;
        (card.face as { rank: number }).rank = card.face.rank === 14 ? 6 : 14;
        assert.deepEqual(observeBotCurrent(changed, seats[0]!, clock.now()), baseline);
      }
      const revealFixture = fixture('reveal', count);
      const revealRuntime = await GameRuntime.create(revealFixture.options);
      try {
        const reveal = revealRuntime.read();
        assert.ok(observeBotCurrent(reveal, seats[0]!, revealFixture.clock.now()).transient.reveal);
        assert.equal(
          observeBotCurrent(reveal, seats[0]!, revealFixture.clock.now() + 10000).transient.reveal,
          null,
        );
        await revealFixture.clock.advanceBy(4000);
        await revealRuntime.dispatch({
          type: 'disconnect',
          id: id('command', 'leave'),
          seatId: seats[1]!,
        });
        assert.equal(
          observeBotCurrent(revealRuntime.read(), seats[0]!, revealFixture.clock.now()).transient
            .reveal,
          null,
        );
        await revealFixture.clock.advanceBy(2000);
        await revealRuntime.dispatch({
          type: 'reconnect',
          id: id('command', 'return'),
          seatId: seats[1]!,
        });
        assert.equal(
          observeBotCurrent(revealRuntime.read(), seats[0]!, revealFixture.clock.now()).transient
            .reveal!.timer.remainingMs,
          6000,
        );
      } finally {
        await revealRuntime.dispose();
      }
    } finally {
      await runtime.dispose();
    }
  });
}
