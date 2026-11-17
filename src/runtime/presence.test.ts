import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canBeat } from '../game/cards.ts';
import { id } from '../game/ids.ts';
import { GameRuntime } from './runtime.ts';
import { fixture } from './testing/fixtures.ts';

test('a finished player or an unknown spectator cannot pause the still-running match', async () => {
  const { options, clock, history } = fixture('reveal', 8);
  const runtime = await GameRuntime.create(options);
  await clock.advanceBy(10000);
  let sequence = 0;
  for (
    ;
    sequence < 500 && !runtime.read().state!.players.some((player) => player.status === 'won');
    sequence++
  ) {
    const state = runtime.read().state!;
    const phase = state.phase;
    if (phase.type !== 'between-rounds' && phase.type !== 'round')
      assert.fail('Unexpected early finish');
    const actorId = phase.type === 'round' ? phase.turnSeatId : phase.leaderId;
    const player = state.players.find((player) => player.id === actorId)!;
    const commandId = id('command', `progress-${sequence}`);
    if (player.hand.length === 0) {
      assert.ok(player.stumps.length > 0);
      await runtime.dispatch({
        type: 'open-stump',
        id: commandId,
        actorId,
        cardId: player.stumps[0]!,
      });
    } else {
      const top = state.table.at(-1);
      const topFace =
        top === undefined ? undefined : state.cards.find((card) => card.id === top)!.face;
      const cardId = player.hand.find(
        (card) =>
          topFace === undefined ||
          canBeat(topFace, state.cards.find((item) => item.id === card)!.face, state.trump),
      );
      const result = await runtime.dispatch(
        cardId === undefined
          ? { type: 'take-bottom', id: commandId, actorId }
          : { type: 'play-card', id: commandId, actorId, cardId },
      );
      assert.equal(result.type, 'accepted');
    }
  }
  const state = runtime.read().state!;
  assert.notEqual(state.phase.type, 'finished');
  const winner = state.players.find((player) => player.status === 'won');
  assert.ok(winner, 'The legal deterministic driver must reach an intermediate winner');
  const version = history.read().head.version;
  await runtime.dispatch({
    type: 'disconnect',
    id: id('command', 'winner-leaves'),
    seatId: winner.id,
  });
  await runtime.dispatch({
    type: 'disconnect',
    id: id('command', 'spectator-leaves'),
    seatId: id('seat', 'spectator'),
  });
  assert.equal(runtime.read().paused, false);
  assert.equal(history.read().head.version, version);
  await runtime.dispose();
});
