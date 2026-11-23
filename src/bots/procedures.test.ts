import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../runtime/testing/fixtures.ts';
import { GameRuntime } from '../runtime/runtime.ts';
import { observeBotCurrent } from './observation.ts';
import { chooseProcedureResponse } from './procedures.ts';

for (const phase of ['vote', 'withdrawal', 'penalty'] as const) {
  test(`procedure policy: ${phase} uses only eligible unanswered active own procedure`, async () => {
    const f = fixture(phase, 4);
    const runtime = await GameRuntime.create(f.options);
    try {
      for (const seatId of f.seats) {
        const human = observeBotCurrent(runtime.read(), seatId, f.clock.now());
        assert.equal(chooseProcedureResponse(human), null);
        const view = {
          ...human,
          control: {
            ...human.control,
            connections: human.control.connections.map((p) => ({
              ...p,
              controller: 'bot' as const,
            })),
          },
        };
        const procedure = view.procedure!;
        const expected = !procedure.eligibleSeatIds.includes(seatId)
          ? null
          : procedure.type === 'claim-vote'
            ? { type: 'cast-vote', procedureId: procedure.timer.id, vote: 'abstain' }
            : procedure.type === 'withdrawal'
              ? { type: 'withdrawal-response', procedureId: procedure.timer.id, approve: true }
              : { type: 'penalty-response', procedureId: procedure.timer.id, cardId: null };
        assert.deepEqual(chooseProcedureResponse(view), expected);
        assert.equal(chooseProcedureResponse({ ...view, state: null }), null);
        assert.equal(chooseProcedureResponse({ ...view, procedure: null }), null);
        assert.equal(
          chooseProcedureResponse({ ...view, control: { ...view.control, paused: true } }),
          null,
        );
        assert.equal(
          chooseProcedureResponse({ ...view, procedure: { ...procedure, eligibleSeatIds: [] } }),
          null,
        );
        assert.equal(
          chooseProcedureResponse({
            ...view,
            procedure: { ...procedure, timer: { ...procedure.timer, paused: true } },
          }),
          null,
        );
        if (procedure.type === 'claim-vote') {
          for (const ownVote of ['yes', 'no', 'abstain'] as const)
            assert.equal(
              chooseProcedureResponse({ ...view, procedure: { ...procedure, ownVote } }),
              null,
            );
        } else if (procedure.type === 'withdrawal') {
          assert.equal(procedure.suspendedVote?.timer.paused, true);
          for (const ownApproval of [true, false])
            assert.equal(
              chooseProcedureResponse({ ...view, procedure: { ...procedure, ownApproval } }),
              null,
            );
        } else {
          assert.equal(
            chooseProcedureResponse({
              ...view,
              procedure: { ...procedure, ownResponse: { type: 'refuse' } },
            }),
            null,
          );
        }
      }
    } finally {
      await runtime.dispose();
    }
  });
}
