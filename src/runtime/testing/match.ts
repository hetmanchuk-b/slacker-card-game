import assert from 'node:assert/strict';
import { canBeat } from '../../game/cards.ts';
import { id } from '../../game/ids.ts';
import type { CardId } from '../../game/ids.ts';
import type { GameRuntime } from '../runtime.ts';

/** Full-information legal test driver, never a production bot observation interface. */
export async function finishMatch(runtime: GameRuntime): Promise<void> {
  for (let sequence = 0; sequence < 1000; sequence++) {
    const state = runtime.read().state!;
    const phase = state.phase;
    if (phase.type === 'finished') return;
    if (phase.type !== 'round' && phase.type !== 'between-rounds') assert.fail('Expected play');
    const actorId = phase.type === 'round' ? phase.turnSeatId : phase.leaderId;
    const player = state.players.find((player) => player.id === actorId)!;
    const commandId = id('command', `finish-${sequence}`);
    if (player.hand.length === 0) {
      assert.ok(player.stumps.length > 0);
      assert.equal(
        (
          await runtime.dispatch({
            type: 'open-stump',
            id: commandId,
            actorId,
            cardId: player.stumps[0]!,
          })
        ).type,
        'accepted',
      );
      continue;
    }
    const face = (cardId: CardId) => state.cards.find((card) => card.id === cardId)!.face;
    const top = state.table.at(-1);
    const cardId = player.hand.find(
      (card) => top === undefined || canBeat(face(top), face(card), state.trump),
    );
    const result = await runtime.dispatch(
      cardId === undefined
        ? { type: 'take-bottom', id: commandId, actorId }
        : { type: 'play-card', id: commandId, actorId, cardId },
    );
    assert.equal(result.type, 'accepted');
  }
  assert.fail('Legal match driver exceeded its regression budget');
}
