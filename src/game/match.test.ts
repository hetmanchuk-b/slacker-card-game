import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canBeat } from './cards.ts';
import { applyAction, decide, validateState } from './engine.ts';
import { id } from './ids.ts';
import type { ActionBatch, GameCommand } from './contracts.ts';
import type { CardId } from './ids.ts';

// Full-information legal policy is a test driver, not the production bot interface.
for (let count = 2; count <= 8; count++) {
  test(`a complete deterministic ${count}-seat match finishes and replays without violating invariants`, () => {
    let sequence = 0;
    let nowMs = 0;
    const commandId = () => id('command', `command-${sequence++}`);
    const seats = Array.from({ length: count }, (_, index) => id('seat', `seat-${index}`));
    const created = decide(
      null,
      {
        type: 'start-game',
        id: commandId(),
        gameId: id('game', `match-${count}`),
        ownerId: seats[0]!,
        seatIds: seats,
        cardIds: Array.from({ length: 36 }, (_, index) => id('card', `opaque-${index}`)),
      },
      { nowMs: nowMs++, randomInt: (upper) => upper - 1 },
    );
    if (created.type !== 'accepted') assert.fail('Creation rejected');
    const actions: ActionBatch[] = [created.action];
    let state = applyAction(null, created.action);
    function run(command: GameCommand) {
      const result = decide(state, command, { nowMs: nowMs++, randomInt: (upper) => upper - 1 });
      if (result.type !== 'accepted') assert.fail(`Rejected legal command: ${result.code}`);
      assert.equal(result.outcome, 'played');
      actions.push(result.action);
      const next = applyAction(state, result.action);
      assert.deepEqual(validateState(next), []);
      assert.equal(next.procedure, null, 'Legal play should not create a punishment');
      return next;
    }
    while (state.phase.type === 'dealing')
      state = run({ type: 'draw-card', id: commandId(), actorId: state.phase.nextSeatId });
    if (state.phase.type !== 'trump-reveal') assert.fail('Expected reveal');
    nowMs += 10000;
    state = run({ type: 'expire-reveal', id: commandId(), timerId: state.phase.timer.id });
    while (state.phase.type !== 'finished' && sequence < 1000) {
      const phase = state.phase;
      if (phase.type !== 'round' && phase.type !== 'between-rounds')
        assert.fail('Unexpected gameplay phase');
      const actorId = phase.type === 'round' ? phase.turnSeatId : phase.leaderId;
      const player = state.players.find((player) => player.id === actorId)!;
      if (player.hand.length === 0) {
        assert.ok(
          player.stumps.length > 0,
          'Empty turns without entitlements must already be normalized',
        );
        state = run({ type: 'open-stump', id: commandId(), actorId, cardId: player.stumps[0]! });
        continue;
      }
      const face = (cardId: CardId) => state.cards.find((card) => card.id === cardId)!.face;
      const top = state.table.at(-1);
      const cardId = player.hand.find(
        (card) => top === undefined || canBeat(face(top), face(card), state.trump),
      );
      state = run(
        cardId === undefined
          ? { type: 'take-bottom', id: commandId(), actorId }
          : { type: 'play-card', id: commandId(), actorId, cardId },
      );
    }
    assert.equal(
      state.phase.type,
      'finished',
      'The deterministic policy must finish within this regression budget',
    );
    const replayed = actions
      .slice(1)
      .reduce((current, action) => applyAction(current, action), applyAction(null, actions[0]!));
    assert.deepEqual(replayed, state);
    if (count === 5) {
      assert.equal(state.phase.type, 'finished');
      if (state.phase.type === 'finished')
        assert.equal(state.phase.result.type, 'draw', 'Formerly looping five-seat match must draw');
    }
  });
}
