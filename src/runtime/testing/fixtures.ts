import assert from 'node:assert/strict';
import { decide } from '../../game/engine.ts';
import { id } from '../../game/ids.ts';
import { MemoryHistory } from '../../persistence/memory-history.ts';
import { FakeClock } from './fake-clock.ts';
import type { GameCommand } from '../../game/contracts.ts';
import type { GameState } from '../../game/model.ts';

export function fixture(phase: 'reveal' | 'vote' | 'penalty' | 'withdrawal', count = 2) {
  const seats = Array.from({ length: count }, (_, index) => id('seat', `seat-${index}`));
  const history = new MemoryHistory(id('game', 'runtime-game'), id('branch', 'main'));
  let nowMs = 1000;
  function run(command: GameCommand) {
    const snapshot = history.read();
    const result = decide(snapshot.state, command, { nowMs, randomInt: (upper) => upper - 1 });
    if (result.type !== 'accepted') assert.fail(`Fixture rejected: ${result.code}`);
    assert.equal(history.append(snapshot.head, result.action).type, 'committed');
  }
  const state = (): GameState => {
    const state = history.read().state;
    if (!state) throw new Error('No fixture game');
    return state;
  };
  run({
    type: 'start-game',
    id: id('command', 'start'),
    gameId: id('game', 'runtime-game'),
    ownerId: seats[0]!,
    seatIds: seats,
    cardIds: Array.from({ length: 36 }, (_, index) => id('card', `opaque-${index}`)),
  });
  if (phase === 'vote' || phase === 'withdrawal') {
    run({
      type: 'submit-claim',
      id: id('command', 'claim'),
      actorId: seats[0]!,
      accusedId: seats[1]!,
      reason: 'Spoken incident',
      incident: { type: 'spoken', key: 'episode' },
      scope: 'dealing',
      scopeNumber: 0,
    });
    if (phase === 'withdrawal') {
      nowMs = 5000;
      run({
        type: 'request-withdrawal',
        id: id('command', 'withdraw'),
        actorId: seats[0]!,
        claimId: state().claims[0]!.claim.id,
      });
    }
  } else {
    if (phase === 'penalty')
      run({ type: 'draw-card', id: id('command', 'wrong-draw'), actorId: seats[0]! });
    for (let draw = 0; draw < 36; draw++) {
      const current = state().phase;
      if (current.type !== 'dealing') throw new Error('Expected dealing');
      run({ type: 'draw-card', id: id('command', `draw-${draw}`), actorId: current.nextSeatId });
    }
    if (phase === 'penalty') {
      nowMs = 11000;
      const reveal = state().phase;
      if (reveal.type !== 'trump-reveal') throw new Error('Expected reveal');
      run({ type: 'expire-reveal', id: id('command', 'reveal-done'), timerId: reveal.timer.id });
    }
  }
  let nextId = 0;
  const clock = new FakeClock(nowMs);
  return {
    history,
    clock,
    seats,
    options: {
      history,
      clock,
      connectedSeatIds: seats,
      randomInt: (upper: number) => upper - 1,
      nextCommandId: () => id('command', `runtime-${nextId++}`),
    },
  };
}
