import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id } from '../game/ids.ts';
import { GameRuntime } from '../runtime/runtime.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import { projectLiveGame } from './live.ts';

for (const count of [2, 4, 8]) {
  test(`${count} seats receive the initial notice only before the first successful draw`, async () => {
    const { options, seats, clock } = fixture('vote', count);
    const runtime = await GameRuntime.create(options);
    try {
      const view = () => runtime.read();
      const first = view().state!.phase;
      assert.equal(first.type, 'dealing');
      if (first.type !== 'dealing') assert.fail();
      for (const seatId of seats) {
        const viewer = { type: 'seat' as const, seatId };
        const projected = projectLiveGame(view(), viewer, clock.now());
        assert.equal(projected.transient.initialRecipientNotice, seatId === first.nextSeatId);
        assert.deepEqual(
          projectLiveGame(view(), viewer, clock.now()),
          projected,
          'refresh is safe',
        );
      }
      assert.equal(
        projectLiveGame(view(), { type: 'public' }, clock.now()).transient.initialRecipientNotice,
        false,
      );
      // Finish the dealing claim without punishment, then make an incorrect draw.
      await clock.advanceBy(10000);
      await runtime.dispatch({
        type: 'draw-card',
        id: id('command', 'wrong-first'),
        actorId: seats[0]!,
      });
      assert.equal(
        projectLiveGame(view(), { type: 'seat', seatId: first.nextSeatId }, clock.now()).transient
          .initialRecipientNotice,
        true,
      );
      await runtime.dispatch({
        type: 'draw-card',
        id: id('command', 'first'),
        actorId: first.nextSeatId,
      });
      for (const seatId of seats) {
        assert.equal(
          projectLiveGame(view(), { type: 'seat', seatId }, clock.now()).transient
            .initialRecipientNotice,
          false,
        );
      }
    } finally {
      await runtime.dispose();
    }
  });
}

test('reveal is hidden at its deadline, during claims and disconnects, and resumes only remaining time', async () => {
  const { options, clock, seats } = fixture('reveal', 4);
  const runtime = await GameRuntime.create(options);
  const viewer = { type: 'public' as const };
  const live = () => projectLiveGame(runtime.read(), viewer, clock.now());
  try {
    assert.equal(live().transient.reveal!.timer.remainingMs, 10000);
    const reveal = runtime.read().state!.phase;
    if (reveal.type !== 'trump-reveal') assert.fail();
    assert.equal(live().transient.reveal!.card.id, reveal.cardId);
    await clock.advanceBy(4000);
    await runtime.dispatch({
      type: 'submit-claim',
      id: id('command', 'reveal-claim'),
      actorId: seats[0]!,
      accusedId: seats[1]!,
      reason: 'spoken',
      incident: { type: 'spoken', key: 'one' },
      scope: 'dealing',
      scopeNumber: 0,
    });
    assert.equal(live().transient.reveal, null);
    assert.equal(live().procedure!.timer.remainingMs, 10000);
    await runtime.dispatch({ type: 'disconnect', id: id('command', 'leave'), seatId: seats[2]! });
    await clock.advanceBy(20000);
    assert.equal(live().transient.reveal, null);
    assert.equal(live().procedure!.timer.paused, true);
    await runtime.dispatch({ type: 'reconnect', id: id('command', 'return'), seatId: seats[2]! });
    assert.equal(live().transient.reveal, null, 'claim still suspends reveal');
    await clock.advanceBy(10000);
    assert.equal(live().transient.reveal!.timer.remainingMs, 6000);
    const beforeExpiry = runtime.read();
    assert.equal(
      projectLiveGame(beforeExpiry, viewer, clock.now() + 6000).transient.reveal,
      null,
      'hide even before an expiry callback runs',
    );
    await clock.advanceBy(6000);
    assert.equal(live().transient.reveal, null);
    assert.equal(JSON.stringify(live()).includes('"trump"'), false);
  } finally {
    await runtime.dispose();
  }
});

test('withdrawal shows safe claim and own ballots while preserving the nested suspended timer', async () => {
  const { options, seats, clock } = fixture('withdrawal', 4);
  const runtime = await GameRuntime.create(options);
  try {
    const snapshot = runtime.read();
    const procedure = snapshot.state!.procedure!;
    assert.equal(procedure.type, 'withdrawal');
    Object.assign(procedure, { secret: 'SECRET-PROCEDURE' });
    if (procedure.type !== 'withdrawal') assert.fail();
    Object.assign(procedure.claim, { secret: 'SECRET-CLAIM' });
    const view = projectLiveGame(snapshot, { type: 'seat', seatId: seats[0]! }, clock.now());
    const withdrawal = view.procedure;
    assert.equal(withdrawal?.type, 'withdrawal');
    if (withdrawal?.type !== 'withdrawal') assert.fail();
    assert.deepEqual(withdrawal.suspendedVote!.timer, {
      id: procedure.suspendedVote!.timer.id,
      remainingMs: 6000,
      paused: true,
    });
    assert.equal(withdrawal.ownApproval, null);
    assert.equal(withdrawal.suspendedVote!.ownVote, null);
    assert.equal(JSON.stringify(view).includes('SECRET-'), false);
    assert.equal(JSON.stringify(view).includes('incidentKey'), false);
    assert.equal(JSON.stringify(view).includes('"incident"'), false);
    const result = await runtime.dispatch({
      type: 'withdrawal-response',
      id: id('command', 'deny'),
      actorId: seats[1]!,
      procedureId: procedure.timer.id,
      approve: false,
    });
    assert.equal(result.type, 'accepted');
    assert.equal(
      projectLiveGame(runtime.read(), { type: 'public' }, clock.now()).procedure!.timer.remainingMs,
      6000,
    );
  } finally {
    await runtime.dispose();
  }
});

test('penalty reservation is visible only to its donor, not recipient or other viewers', async () => {
  const { options, clock, seats } = fixture('penalty', 4);
  const runtime = await GameRuntime.create(options);
  try {
    const state = runtime.read().state!;
    const procedure = state.procedure!;
    const donor = seats[1]!;
    const selected = state.players[1]!.hand[0]!;
    await runtime.dispatch({
      type: 'penalty-response',
      id: id('command', 'reserve'),
      actorId: donor,
      procedureId: procedure.timer.id,
      cardId: selected,
    });
    for (const viewer of [
      { type: 'public' as const },
      ...seats.map((seatId) => ({ type: 'seat' as const, seatId })),
    ]) {
      const projected = projectLiveGame(runtime.read(), viewer, clock.now());
      const penalty = projected.procedure!;
      if (penalty.type !== 'penalty') assert.fail();
      assert.deepEqual(
        penalty.ownResponse,
        viewer.type === 'seat' && viewer.seatId === donor
          ? { type: 'card', card: state.cards.find((card) => card.id === selected) }
          : null,
      );
      if (viewer.type !== 'seat' || viewer.seatId !== donor)
        assert.equal(JSON.stringify(projected).includes(selected), false);
      assert.equal(JSON.stringify(penalty).includes('"responses"'), false);
    }
  } finally {
    await runtime.dispose();
  }
});

test('replacement clock continues during gameplay pause and control audit never appears', async () => {
  const { options, clock, seats } = fixture('vote', 4);
  const runtime = await GameRuntime.create(options);
  try {
    await runtime.dispatch({ type: 'disconnect', id: id('command', 'leave'), seatId: seats[1]! });
    await clock.advanceBy(30001);
    const result = await runtime.dispatch({
      type: 'propose-bot',
      id: id('command', 'propose'),
      actorId: seats[0]!,
      seatId: seats[1]!,
    });
    assert.equal(result.type, 'accepted');
    await clock.advanceBy(4000);
    const snapshot = runtime.read();
    const view = projectLiveGame(snapshot, { type: 'seat', seatId: seats[0]! }, clock.now());
    assert.equal(view.control.paused, true);
    assert.equal(view.procedure!.timer.remainingMs, 10000);
    assert.deepEqual(view.control.replacementVote!.timer, {
      id: snapshot.replacementVote!.timer.id,
      remainingMs: 6000,
      paused: false,
    });
    assert.equal(JSON.stringify(view).includes('controlEvents'), false);
    assert.equal(JSON.stringify(view).includes('disconnectedAtMs'), false);
    assert.equal(JSON.stringify(view).includes('startedAtMs'), false);
    assert.deepEqual(view.control.connections[1], {
      seatId: seats[1],
      connected: false,
      controller: 'human',
    });
  } finally {
    await runtime.dispose();
  }
});

test('live projections reject invalid time and unknown viewers with fixed errors', async () => {
  const { options, clock } = fixture('reveal');
  const runtime = await GameRuntime.create(options);
  try {
    for (const now of [-1, NaN, Infinity, clock.now() - 1]) {
      assert.throws(() => projectLiveGame(runtime.read(), { type: 'public' }, now), {
        message: 'Invalid projection time',
      });
    }
    assert.throws(
      () =>
        projectLiveGame(
          runtime.read(),
          { type: 'seat', seatId: id('seat', 'SECRET-UNKNOWN') },
          clock.now(),
        ),
      { message: 'Unknown viewer seat' },
    );
    const snapshot = runtime.read();
    const view = projectLiveGame(snapshot, { type: 'public' }, clock.now());
    assert.notEqual(
      view.transient.reveal!.card.face,
      snapshot.state!.cards.find((card) => card.id === view.transient.reveal!.card.id)!.face,
    );
    assert.notEqual(view.control.connections, snapshot.connections);
  } finally {
    await runtime.dispose();
  }
});

test('ballots are seat-local and projected arrays/claims never alias private state', async () => {
  const { options, clock, seats } = fixture('vote', 4);
  const runtime = await GameRuntime.create(options);
  try {
    const procedure = runtime.read().state!.procedure!;
    await runtime.dispatch({
      type: 'cast-vote',
      id: id('command', 'yes'),
      actorId: seats[0]!,
      procedureId: procedure.timer.id,
      vote: 'yes',
    });
    const snapshot = runtime.read();
    const before = structuredClone(snapshot);
    for (const viewer of [
      { type: 'public' as const },
      ...seats.map((seatId) => ({ type: 'seat' as const, seatId })),
    ]) {
      const view = projectLiveGame(snapshot, viewer, clock.now());
      const ballot = view.procedure;
      if (ballot?.type !== 'claim-vote') assert.fail();
      assert.equal(
        ballot.ownVote,
        viewer.type === 'seat' && viewer.seatId === seats[0] ? 'yes' : null,
      );
      assert.equal(JSON.stringify(ballot).includes('"votes"'), false);
      assert.notEqual(
        ballot.claim,
        snapshot.state!.procedure!.type === 'claim-vote' ? snapshot.state!.procedure!.claim : null,
      );
      (ballot.eligibleSeatIds as unknown as string[]).length = 0;
      (ballot.claim as { reason: string }).reason = 'changed';
    }
    assert.deepEqual(snapshot, before);
  } finally {
    await runtime.dispose();
  }
});
