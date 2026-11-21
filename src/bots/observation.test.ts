import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id } from '../game/ids.ts';
import { GameRuntime } from '../runtime/runtime.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import { projectLiveGame } from '../projections/live.ts';
import { observeBotCurrent, observeBotAction } from './observation.ts';

for (const count of [2, 4, 8]) {
  for (const phase of ['vote', 'withdrawal', 'penalty', 'reveal'] as const) {
    test(`${count} seats: ${phase} bot input is exactly the detached seat projection`, async () => {
      const { options, seats, clock } = fixture(phase, count);
      const runtime = await GameRuntime.create(options);
      try {
        if (phase === 'vote' && count > 2) {
          const p = runtime.read().state!.procedure;
          if (p?.type !== 'claim-vote') assert.fail();
          const voter = p.eligibleSeatIds[0]!;
          await runtime.dispatch({
            type: 'cast-vote',
            id: id('command', 'ballot'),
            actorId: voter,
            procedureId: p.timer.id,
            vote: 'yes',
          });
          for (const seatId of seats) {
            const observed = observeBotCurrent(runtime.read(), seatId, clock.now()).procedure;
            if (observed?.type !== 'claim-vote') assert.fail();
            assert.equal(observed.ownVote, seatId === voter ? 'yes' : null);
          }
        }
        const snapshot = runtime.read();
        for (const seatId of seats) {
          const input = observeBotCurrent(snapshot, seatId, clock.now());
          assert.deepEqual(input, projectLiveGame(snapshot, { type: 'seat', seatId }, clock.now()));
          assert.equal(JSON.stringify(input).includes('"trump"'), false);
          const original = structuredClone(snapshot);
          (input.control.connections as unknown[]).length = 0;
          assert.deepEqual(snapshot, original);
        }
        const altered = structuredClone(snapshot);
        const hidden = altered.state!.players[1]!.stumps[0] ?? altered.state!.deck[0];
        if (hidden) {
          const card = altered.state!.cards.find((card) => card.id === hidden)!;
          (card.face as { rank: number }).rank = card.face.rank === 14 ? 6 : 14;
          assert.deepEqual(
            observeBotCurrent(altered, seats[0]!, clock.now()),
            observeBotCurrent(snapshot, seats[0]!, clock.now()),
          );
        }
        assert.throws(
          () => observeBotCurrent(snapshot, id('seat', 'outsider'), clock.now()),
          /Invalid bot seat/,
        );
        assert.throws(
          () => observeBotCurrent({ ...snapshot, state: null }, seats[0]!, clock.now()),
          /Invalid bot seat/,
        );
      } finally {
        await runtime.dispose();
      }
    });
  }
}

test('bot action input suppresses duplicates and rejects unbound seats', async () => {
  const { options, seats, clock } = fixture('vote');
  const runtime = await GameRuntime.create(options);
  try {
    await clock.advanceBy(10000);
    const before = runtime.read();
    const phase = before.state!.phase;
    if (phase.type !== 'dealing') assert.fail();
    const result = await runtime.dispatch({
      type: 'draw-card',
      id: id('command', 'bot-draw'),
      actorId: phase.nextSeatId,
    });
    assert.equal(result.type, 'accepted');
    const after = runtime.read();
    const action = options.history.read().actions.at(-1)!;
    const pair = { before, after, action, delivery: 'fresh' as const };
    assert.equal(observeBotAction(pair, seats[0]!).observations.length > 0, true);
    assert.deepEqual(
      observeBotAction({ ...pair, delivery: 'duplicate' }, seats[0]!).observations,
      [],
    );
    assert.throws(() => observeBotAction(pair, id('seat', 'outsider')), /Invalid bot seat/);
  } finally {
    await runtime.dispose();
  }
});
