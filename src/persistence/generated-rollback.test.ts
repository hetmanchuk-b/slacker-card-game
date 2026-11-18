import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAction, validateState } from '../game/engine.ts';
import { id } from '../game/ids.ts';
import type { GameState, Timer } from '../game/model.ts';
import { GameRuntime } from '../runtime/runtime.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import { finishMatch } from '../runtime/testing/match.ts';
import { MemoryHistory } from './memory-history.ts';

function expectedAt(state: GameState | null, atMs: number, resumedAtMs: number): GameState | null {
  if (!state) return null;
  const timer = (value: Timer): Timer =>
    value.startedAtMs === null
      ? value
      : {
          ...value,
          remainingMs: Math.max(0, value.remainingMs - (atMs - value.startedAtMs)),
          startedAtMs: resumedAtMs,
        };
  return {
    ...structuredClone(state),
    phase:
      state.phase.type === 'trump-reveal'
        ? { ...state.phase, timer: timer(state.phase.timer) }
        : state.phase,
    procedure: state.procedure ? { ...state.procedure, timer: timer(state.procedure.timer) } : null,
    clock: { type: 'running' },
  };
}

function verify(history: MemoryHistory, ownerId: GameState['ownerId'], indices: readonly number[]) {
  const source = history.read();
  const before: (GameState | null)[] = [];
  let state: GameState | null = null;
  for (const action of source.actions) {
    before.push(state);
    state = applyAction(state, action);
  }
  let sequence = 0;
  for (const index of [...new Set(indices)].sort((a, b) => b - a)) {
    const action = source.actions[index]!;
    const nowMs = 100000 + sequence++ * 1000;
    assert.equal(
      history.fork(history.read().head, {
        id: id('command', `generated-${source.head.gameId}-${index}`),
        actorId: ownerId,
        beforeCommandId: action.commandId,
        branchId: id('branch', `generated-${index}`),
        nowMs,
        resumeClock: true,
        knowledgeWarningAcknowledged: true,
      }).type,
      'committed',
    );
    const restored = history.read().state;
    assert.deepEqual(restored, expectedAt(before[index]!, action.occurredAtMs, nowMs));
    if (restored) assert.deepEqual(validateState(restored), []);
  }
  assert.deepEqual(history.read(source.head.branchId), source);
  const cached = MemoryHistory.restoreSnapshot(history.archive(), history.snapshot());
  const replay = MemoryHistory.restore(history.archive());
  assert.deepEqual(cached.snapshot(), replay.snapshot());
}

for (const count of [2, 4, 8]) {
  for (const phase of ['reveal', 'vote', 'withdrawal', 'penalty'] as const) {
    test(`generated ${count}-seat ${phase} history restores every completed pre-action point`, async () => {
      const { options, clock, history, seats } = fixture(phase, count);
      const runtime = await GameRuntime.create(options);
      await clock.advanceBy(1000);
      const state = runtime.read().state!;
      const procedure = state.procedure;
      const commandId = id('command', 'generated-response');
      if (phase === 'reveal')
        await runtime.dispatch({
          type: 'submit-claim',
          id: commandId,
          actorId: seats[0]!,
          accusedId: seats[1]!,
          reason: 'Generated spoken incident',
          incident: { type: 'spoken', key: 'generated' },
          scope: 'dealing',
          scopeNumber: 0,
        });
      else if (procedure?.type === 'withdrawal')
        await runtime.dispatch({
          type: 'withdrawal-response',
          id: commandId,
          actorId: seats[1]!,
          procedureId: procedure.timer.id,
          approve: false,
        });
      else if (procedure?.type === 'claim-vote')
        await runtime.dispatch({
          type: 'cast-vote',
          id: commandId,
          actorId: procedure.eligibleSeatIds[0]!,
          procedureId: procedure.timer.id,
          vote: 'abstain',
        });
      else if (procedure?.type === 'penalty')
        await runtime.dispatch({
          type: 'penalty-response',
          id: commandId,
          actorId: procedure.eligibleSeatIds[0]!,
          procedureId: procedure.timer.id,
          cardId: null,
        });
      await runtime.dispose();
      verify(
        history,
        seats[0]!,
        history.read().actions.map((_, index) => index),
      );
    });
  }
}

for (let count = 2; count <= 8; count++) {
  test(`generated rollback checkpoints of a complete ${count}-seat match preserve exits, rights and repetition`, async () => {
    const { options, clock, history, seats } = fixture('reveal', count);
    const runtime = await GameRuntime.create(options);
    await clock.advanceBy(10000);
    await finishMatch(runtime);
    await runtime.dispose();
    const length = history.read().actions.length;
    let seed = count * 7919;
    const indices = [0, 1, 36, 37, 38, length - 1];
    for (let index = 0; index < 8; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      indices.push(seed % length);
    }
    verify(history, seats[0]!, indices);
  });
}
