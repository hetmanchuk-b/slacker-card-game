import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, validateState } from './engine.ts';
import { id } from './ids.ts';
import { heart, scenario, seat, step } from './testing/scenarios.ts';

test('a runtime clock suspension freezes the running ballot and rejects gameplay until resume', () => {
  let state = step(scenario({ hands: [[heart(9)], [heart(10)]], table: [heart(8)], turn: 0 }), {
    type: 'submit-claim',
    id: id('command', 'claim'),
    actorId: seat(0),
    accusedId: seat(1),
    reason: 'House rule',
    incident: { type: 'spoken', key: 'episode' },
    scope: 'round',
    scopeNumber: 2,
  });
  if (state.procedure?.type !== 'claim-vote') throw new Error('Expected vote');
  const timerId = state.procedure.timer.id;
  state = step(state, { type: 'suspend-clock', id: id('command', 'pause') }, 5000);
  assert.deepEqual(state.clock, { type: 'suspended', timerIds: [timerId] });
  if (state.procedure?.type !== 'claim-vote') throw new Error('Vote disappeared');
  assert.equal(state.procedure.timer.remainingMs, 6000);
  assert.equal(state.procedure.timer.startedAtMs, null);
  assert.ok(
    validateState({
      ...state,
      clock: { type: 'suspended', timerIds: [id('procedure', 'missing')] },
    }).includes('Unknown suspended timer'),
  );
  assert.ok(
    validateState({
      ...state,
      procedure: { ...state.procedure, timer: { ...state.procedure.timer, startedAtMs: 5000 } },
    }).includes('A gameplay timer is running during suspension'),
  );
  assert.deepEqual(
    decide(
      state,
      {
        type: 'cast-vote',
        id: id('command', 'blocked'),
        actorId: seat(0),
        procedureId: timerId,
        vote: 'yes',
      },
      { nowMs: 8000, randomInt: () => 0 },
    ),
    { type: 'rejected', code: 'game-suspended' },
  );
  state = step(state, { type: 'resume-clock', id: id('command', 'resume') }, 9000);
  assert.deepEqual(state.clock, { type: 'running' });
  if (state.procedure?.type !== 'claim-vote') throw new Error('Vote disappeared');
  assert.equal(state.procedure.timer.remainingMs, 6000);
  assert.equal(state.procedure.timer.startedAtMs, 9000);
});
