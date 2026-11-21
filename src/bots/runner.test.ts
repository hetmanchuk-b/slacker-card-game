import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuntimeOptions } from '../runtime/runtime.ts';
import { GameRuntime, RuntimeAdmissionError } from '../runtime/runtime.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import { id } from '../game/ids.ts';
import { observeBotCurrent } from './observation.ts';
import { choosePenaltyRefusal, startBotRunner } from './runner.ts';

async function botFixture(commit?: RuntimeOptions['commit'], count = 2) {
  const f = fixture('penalty', count);
  const runtime = await GameRuntime.create({ ...f.options, ...(commit ? { commit } : {}) });
  await runtime.dispatch({ type: 'disconnect', id: id('command', 'leave'), seatId: f.seats[1]! });
  await f.clock.advanceBy(30001);
  await runtime.dispatch({
    type: 'propose-bot',
    id: id('command', 'propose'),
    actorId: f.seats[0]!,
    seatId: f.seats[1]!,
  });
  await runtime.dispatch({
    type: 'replacement-vote',
    id: id('command', 'yes'),
    actorId: f.seats[0]!,
    procedureId: runtime.read().replacementVote!.timer.id,
    vote: 'yes',
  });
  if (count > 2) await f.clock.advanceBy(10000);
  return { ...f, runtime };
}

test('runner refuses only an eligible unanswered penalty and hands control back', async () => {
  const { runtime, seats, options } = await botFixture();
  const stop = await startBotRunner(runtime, options.nextCommandId);
  await runtime.observe(async () => {});
  const state = runtime.read().state!;
  assert.equal(state.procedure, null);
  await runtime.dispatch({
    type: 'reconnect',
    id: id('command', 'human-return'),
    seatId: seats[1]!,
  });
  assert.equal(runtime.read().connections[1]!.controller, 'human');
  stop();
  await runtime.dispose();
});

test('bot admission denies canceled and stale decisions before accepted receipt lookup', async () => {
  const { runtime, seats } = await botFixture();
  const procedure = runtime.read().state!.procedure!;
  const command = {
    type: 'penalty-response' as const,
    id: id('command', 'refusal'),
    actorId: seats[1]!,
    cardId: null,
    procedureId: procedure.timer.id,
  };
  const cancel = new AbortController();
  const origin = runtime.botAdmission(seats[1]!, cancel.signal);
  assert.equal((await runtime.dispatch(command, origin)).type, 'accepted');
  await assert.rejects(runtime.dispatch(command, origin), RuntimeAdmissionError);
  const fresh = runtime.botAdmission(seats[1]!, cancel.signal);
  cancel.abort();
  await assert.rejects(runtime.dispatch(command, fresh), RuntimeAdmissionError);
  await runtime.dispose();
});

test('queued human handback fences bot work; ordinary human dispatch stays unchanged', async () => {
  const { runtime, seats } = await botFixture();
  const procedure = runtime.read().state!.procedure!;
  const origin = runtime.botAdmission(seats[1]!, new AbortController().signal);
  const handback = runtime.dispatch({
    type: 'reconnect',
    id: id('command', 'handback'),
    seatId: seats[1]!,
  });
  const decision = runtime.dispatch(
    {
      type: 'penalty-response',
      id: id('command', 'obsolete'),
      actorId: seats[1]!,
      cardId: null,
      procedureId: procedure.timer.id,
    },
    origin,
  );
  await handback;
  await assert.rejects(decision, RuntimeAdmissionError);
  assert.equal(
    (
      await runtime.dispatch({
        type: 'penalty-response',
        id: id('command', 'human-refusal'),
        actorId: seats[1]!,
        cardId: null,
        procedureId: procedure.timer.id,
      })
    ).type,
    'accepted',
  );
  await runtime.dispose();
});

test('runner does not continue with no connected human', async () => {
  const { runtime, seats, options } = await botFixture();
  await runtime.dispatch({
    type: 'disconnect',
    id: id('command', 'last-human-leaves'),
    seatId: seats[0]!,
  });
  const stop = await startBotRunner(runtime, options.nextCommandId);
  await runtime.observe(async () => {});
  assert.equal(runtime.read().paused, true);
  assert.equal(runtime.read().state!.procedure?.type, 'penalty');
  await runtime.dispatch({
    type: 'reconnect',
    id: id('command', 'human-resumes'),
    seatId: seats[0]!,
  });
  await runtime.observe(async () => {});
  assert.equal(runtime.read().state!.procedure, null);
  stop();
  await runtime.dispose();
});

test('bot-human-bot ABA invalidates the original controller tenure', async () => {
  const { runtime, seats, clock } = await botFixture();
  const head = runtime.read().head;
  const procedureId = runtime.read().state!.procedure!.timer.id;
  const origin = runtime.botAdmission(seats[1]!, new AbortController().signal);
  await runtime.dispatch({ type: 'reconnect', id: id('command', 'aba-return'), seatId: seats[1]! });
  await runtime.dispatch({ type: 'disconnect', id: id('command', 'aba-leave'), seatId: seats[1]! });
  await clock.advanceBy(30001);
  await runtime.dispatch({
    type: 'propose-bot',
    id: id('command', 'aba-propose'),
    actorId: seats[0]!,
    seatId: seats[1]!,
  });
  await runtime.dispatch({
    type: 'replacement-vote',
    id: id('command', 'aba-yes'),
    actorId: seats[0]!,
    procedureId: runtime.read().replacementVote!.timer.id,
    vote: 'yes',
  });
  // Suspension/resume are real engine actions; controller tenure additionally
  // fences ABA independently of the exact-head fence.
  assert.equal(runtime.read().connections[1]!.controller, 'bot');
  assert.equal(runtime.read().head.branchId, head.branchId);
  await assert.rejects(
    runtime.dispatch(
      {
        type: 'penalty-response',
        id: id('command', 'aba-old'),
        actorId: seats[1]!,
        procedureId,
        cardId: null,
      },
      origin,
    ),
    RuntimeAdmissionError,
  );
  await runtime.dispose();
});

test('an admitted atomic refusal finishes despite cancellation and queued human handback', async () => {
  let block = false;
  let entered!: () => void;
  let release!: () => void;
  const committing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { runtime, seats } = await botFixture(async () => {
    if (block) {
      entered();
      await gate;
    }
  });
  const cancel = new AbortController();
  const origin = runtime.botAdmission(seats[1]!, cancel.signal);
  const procedureId = runtime.read().state!.procedure!.timer.id;
  block = true;
  const refusal = runtime.dispatch(
    {
      type: 'penalty-response',
      id: id('command', 'atomic-refusal'),
      actorId: seats[1]!,
      procedureId,
      cardId: null,
    },
    origin,
  );
  await committing;
  cancel.abort();
  const handback = runtime.dispatch({
    type: 'reconnect',
    id: id('command', 'atomic-handback'),
    seatId: seats[1]!,
  });
  release();
  assert.equal((await refusal).type, 'accepted');
  await handback;
  assert.equal(runtime.read().state!.procedure, null);
  assert.equal(runtime.read().connections[1]!.controller, 'human');
  await runtime.dispose();
});

test('duplicate publications and unchanged checkpoints do not schedule extra refusals', async () => {
  const { runtime, options } = await botFixture();
  const subscribe = runtime.subscribe.bind(runtime);
  runtime.subscribe = (receive, report) =>
    subscribe((publication) => {
      void receive(publication);
      void receive(structuredClone(publication));
    }, report);
  let count = 0;
  const stop = await startBotRunner(runtime, () => {
    count++;
    return options.nextCommandId();
  });
  await runtime.observe(async () => {});
  await runtime.checkpoint();
  await runtime.checkpoint();
  assert.equal(count, 1);
  stop();
  await runtime.dispose();
});

test('rollback and writer disposal invalidate previously captured admission', async () => {
  const { runtime, seats } = await botFixture();
  const origin = runtime.botAdmission(seats[1]!, new AbortController().signal);
  const command = {
    type: 'penalty-response' as const,
    id: id('command', 'old-branch'),
    actorId: seats[1]!,
    procedureId: runtime.read().state!.procedure!.timer.id,
    cardId: null,
  };
  await runtime.dispatch({
    type: 'rollback',
    id: id('command', 'fork'),
    actorId: seats[0]!,
    expected: runtime.read().head,
    beforeCommandId: id('command', 'reveal-done'),
    knowledgeWarningAcknowledged: true,
  });
  await assert.rejects(runtime.dispatch(command, origin), RuntimeAdmissionError);
  const retired = runtime.botAdmission(seats[1]!, new AbortController().signal);
  await runtime.dispose();
  await assert.rejects(runtime.dispatch(command, retired), RuntimeAdmissionError);
});

test('policy accepts only seat-authorized eligible unanswered unpaused penalties', async () => {
  const { runtime, seats, clock } = await botFixture();
  const view = observeBotCurrent(runtime.read(), seats[1]!, clock.now());
  const procedure = view.procedure;
  if (procedure?.type !== 'penalty') assert.fail();
  assert.equal(choosePenaltyRefusal(view), procedure.timer.id);
  assert.equal(choosePenaltyRefusal({ ...view, procedure: null }), null);
  assert.equal(
    choosePenaltyRefusal({ ...view, procedure: { ...procedure, ownResponse: { type: 'refuse' } } }),
    null,
  );
  assert.equal(
    choosePenaltyRefusal({ ...view, procedure: { ...procedure, eligibleSeatIds: [] } }),
    null,
  );
  assert.equal(choosePenaltyRefusal({ ...view, control: { ...view.control, paused: true } }), null);
  assert.equal(
    choosePenaltyRefusal(observeBotCurrent(runtime.read(), seats[0]!, clock.now())),
    null,
  );
  await runtime.dispose();
});

test('a stale exact-head decision is canceled and a fresh decision can refuse the current procedure', async () => {
  const { runtime, seats } = await botFixture(undefined, 4);
  const origin = runtime.botAdmission(seats[1]!, new AbortController().signal);
  const procedureId = runtime.read().state!.procedure!.timer.id;
  assert.equal(
    (
      await runtime.dispatch({
        type: 'penalty-response',
        id: id('command', 'other-response'),
        actorId: seats[2]!,
        procedureId,
        cardId: null,
      })
    ).type,
    'accepted',
  );
  const command = {
    type: 'penalty-response' as const,
    id: id('command', 'stale-head'),
    actorId: seats[1]!,
    procedureId,
    cardId: null,
  };
  await assert.rejects(runtime.dispatch(command, origin), RuntimeAdmissionError);
  assert.equal(
    (await runtime.dispatch(command, runtime.botAdmission(seats[1]!, new AbortController().signal)))
      .type,
    'accepted',
  );
  await runtime.dispose();
});
