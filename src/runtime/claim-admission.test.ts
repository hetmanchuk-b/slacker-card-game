import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id } from '../game/ids.ts';
import { GameRuntime, RuntimeAdmissionError } from './runtime.ts';
import type { ClaimRequest } from './runtime.ts';
import { fixture } from './testing/fixtures.ts';

test('claim resolution is queued, while accepted retries retain their original scope before resolution', async () => {
  const { options, seats, clock } = fixture('reveal');
  const runtime = await GameRuntime.create(options);
  const request = {
    type: 'submit-claim' as const,
    id: id('command', 'external-claim'),
    actorId: seats[0]!,
    accusedId: seats[1]!,
    reason: ' Exact reason ',
    incident: { type: 'spoken' as const, key: 'exact-episode' },
  };
  let resolutions = 0;
  const result = await runtime.dispatchClaim(request, async (capture) => {
    resolutions++;
    assert.equal(capture.snapshot.state?.phase.type, 'trump-reveal');
    assert.equal(capture.history.head.version, capture.snapshot.head.version);
    return { type: 'resolved', scope: 'dealing', scopeNumber: 0 };
  });
  assert.equal(result.type, 'accepted');
  await clock.advanceBy(10000);
  const retry = await runtime.dispatchClaim(request, async () => {
    assert.fail('A retry must not resolve a mutable scope again');
  });
  assert.deepEqual(retry, { ...result, duplicate: true });
  assert.equal(resolutions, 1);
  const changed = await runtime.dispatchClaim({ ...request, reason: 'different' }, async () => {
    assert.fail('An ID collision must not resolve evidence');
  });
  assert.equal(changed.type, 'rejected');
  if (changed.type === 'rejected') assert.equal(changed.code, 'command-id-reused');
  await runtime.dispose();
});

test('claim resolver failure is sanitized and preserves receipts, publications, timers and runtime health', async () => {
  const { options, seats, clock } = fixture('reveal');
  let commits = 0;
  const runtime = await GameRuntime.create({
    ...options,
    commit: async () => {
      commits++;
    },
  });
  const request: ClaimRequest = {
    type: 'submit-claim',
    id: id('command', 'sql-failure'),
    actorId: seats[0]!,
    accusedId: seats[1]!,
    reason: 'Reason',
    incident: { type: 'chat', messageId: 'message' },
  };
  const before = runtime.read();
  const saved = commits;
  let notices = 0;
  await runtime.subscribe(() => {
    notices++;
  });
  await assert.rejects(
    runtime.dispatchClaim(request, async () => {
      throw new Error('PRIVATE SQL');
    }),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeAdmissionError);
      assert.equal(error.code, 'unavailable');
      assert.equal(error.cause, undefined);
      assert.equal(error.message.includes('PRIVATE'), false);
      return true;
    },
  );
  assert.deepEqual(runtime.read(), before);
  assert.equal(commits, saved);
  assert.equal(notices, 1);
  assert.equal(
    (await runtime.checkpoint()).receipts.some((item) => item.command.id === request.id),
    false,
  );
  await clock.advanceBy(10000);
  assert.equal(runtime.read().state!.phase.type, 'between-rounds');
  await runtime.dispose();
});

test('claim resolution and execution are one queue job ordered against play and rollback', async () => {
  for (const claimFirst of [true, false]) {
    const { options, seats, clock } = fixture('reveal');
    const runtime = await GameRuntime.create(options);
    await clock.advanceBy(10000);
    const state = runtime.read().state!;
    if (state.phase.type !== 'between-rounds') assert.fail();
    const actorId = state.phase.leaderId;
    const play = {
      type: 'play-card' as const,
      id: id('command', 'ordered-lead'),
      actorId,
      cardId: state.players.find((player) => player.id === actorId)!.hand[0]!,
    };
    const request: ClaimRequest = {
      type: 'submit-claim',
      id: id('command', 'ordered-claim'),
      actorId: seats[0]!,
      accusedId: seats[1]!,
      reason: 'Order',
      incident: { type: 'spoken', key: 'ordered' },
    };
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lead = claimFirst ? null : runtime.dispatch(play);
    const claim = runtime.dispatchClaim(request, async (capture) => {
      entered();
      await gate;
      assert.equal(capture.snapshot.state!.phase.type, claimFirst ? 'between-rounds' : 'round');
      return {
        type: 'resolved',
        scope: claimFirst ? 'dealing' : 'round',
        scopeNumber: claimFirst ? 0 : 1,
      };
    });
    await waiting;
    const later = claimFirst ? runtime.dispatch(play) : null;
    const rollback = runtime.dispatch({
      type: 'rollback',
      id: id('command', 'ordered-rollback'),
      actorId: seats[0]!,
      expected: runtime.read().head,
      beforeCommandId: id('command', 'draw-0'),
      knowledgeWarningAcknowledged: true,
    });
    release();
    assert.equal((await claim).type, 'accepted');
    if (lead) assert.equal((await lead).type, 'accepted');
    if (later) {
      const result = await later;
      assert.equal(result.type, 'rejected');
      if (result.type === 'rejected') assert.equal(result.code, 'procedure-active');
    }
    const fork = await rollback;
    assert.equal(fork.type, 'rejected');
    if (fork.type === 'rejected') assert.equal(fork.code, 'version-conflict');
    await runtime.dispose();
  }
});

test('claim admission protects cached receipts and exact retries survive scope advancement and recovery', async () => {
  const { options, seats, clock } = fixture('reveal');
  let runtime = await GameRuntime.create(options);
  const request: ClaimRequest = {
    type: 'submit-claim',
    id: id('command', 'recover-claim'),
    actorId: seats[0]!,
    accusedId: seats[1]!,
    reason: 'Exact',
    incident: { type: 'spoken', key: 'recover' },
  };
  const result = await runtime.dispatchClaim(request, async () => ({
    type: 'resolved',
    scope: 'dealing',
    scopeNumber: 0,
  }));
  await clock.advanceBy(20000);
  const state = runtime.read().state!;
  if (state.phase.type !== 'between-rounds') assert.fail();
  const leader = state.phase.leaderId;
  await runtime.dispatch({
    type: 'play-card',
    id: id('command', 'lead'),
    actorId: leader,
    cardId: state.players.find((player) => player.id === leader)!.hand[0]!,
  });
  assert.equal(runtime.read().state!.phase.type, 'round');
  await assert.rejects(
    runtime.dispatchClaim(
      request,
      async () => {
        assert.fail('Unauthorized resolver');
      },
      { admit: () => false },
    ),
    RuntimeAdmissionError,
  );
  const checkpoint = await runtime.checkpoint();
  await runtime.dispose();
  runtime = await GameRuntime.restore(options, checkpoint);
  for (const seatId of seats)
    await runtime.dispatch({ type: 'reconnect', id: id('command', `return-${seatId}`), seatId });
  assert.deepEqual(
    await runtime.dispatchClaim(request, async () => {
      assert.fail('Recovered retry must not resolve scope');
    }),
    { ...result, duplicate: true },
  );
  const mismatch = await runtime.dispatchClaim({ ...request, actorId: seats[1]! }, async () => {
    assert.fail('Cross-seat collision');
  });
  assert.equal(mismatch.type, 'rejected');
  if (mismatch.type === 'rejected') assert.equal(mismatch.code, 'command-id-reused');
  await runtime.dispose();
});
