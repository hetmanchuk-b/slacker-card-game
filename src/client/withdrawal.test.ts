import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ballotWire, connection } from './claims.test.ts';
import { GameStream, remainingTime } from './game-stream.ts';

export function withdrawalWire(sequence = 1, paused = false) {
  const w = ballotWire(4, sequence, paused);
  return {
    ...w,
    view: {
      ...w.view,
      procedure: {
        type: 'withdrawal',
        claim: w.view.procedure.claim,
        eligibleSeatIds: ['seat-1', 'seat-2', 'seat-3'],
        ownApproval: null as boolean | null,
        suspendedVote: {
          ...w.view.procedure,
          ownVote: 'yes',
          timer: { id: 'vote', remainingMs: 6000, paused: true },
        },
        timer: { id: 'withdrawal', remainingMs: 10000, paused },
      },
    },
  };
}
test('withdrawal preserves distinct own approvals and frozen votes/timers; privacy fails closed', () => {
  let now = 100;
  const stream = new GameStream('seat-2', () => now);
  const w = withdrawalWire();
  w.view.state.viewer.seatId = w.view.state.own.seatId = 'seat-2';
  w.view.procedure.ownApproval = false;
  assert.equal(stream.receive(w), 'state');
  now = 3100;
  assert.equal(stream.snapshot?.withdrawal?.ownApproval, false);
  assert.equal(remainingTime(stream.snapshot!.withdrawal!.timer, now), 7000);
  assert.equal(remainingTime(stream.snapshot!.ballot!.timer, now), 6000);
  for (const mutate of [
    (v: typeof w) => Object.assign(v.view.procedure, { approvals: { 'seat-3': true } }),
    (v: typeof w) => {
      v.view.procedure.ownApproval = 'true' as unknown as boolean;
    },
    (v: typeof w) => {
      v.view.control.paused = true;
    },
  ]) {
    const bad = structuredClone(w);
    mutate(bad);
    assert.equal(new GameStream('seat-2').receive(bad), 'invalid');
  }
});
test('request binds own visible claim and captured route, singleflight, no retarget after withdrawal', () => {
  const { client, sent, deliver } = connection();
  const before = sent.length;
  client.requestWithdrawal('claim', 'game', 'wrong');
  assert.equal(sent.length, before);
  client.requestWithdrawal('claim', 'game', 'branch');
  assert.deepEqual((sent.at(-1) as { intent: unknown }).intent, {
    type: 'request-withdrawal',
    gameId: 'game',
    branchId: 'branch',
    claimId: 'claim',
  });
  client.requestWithdrawal('claim', 'game', 'branch');
  assert.equal(sent.length, before + 1);
  deliver(withdrawalWire(2));
  client.requestWithdrawal('claim', 'game', 'branch');
  assert.equal(sent.length, before + 1);
});
test('withdrawal reply sends false exactly, rejects claimant/old timer, resets pending without retry', () => {
  const { client, sent, deliver } = connection();
  const w = withdrawalWire(2);
  // Explicit projected fixture: seat-0 is responder, seat-2 is claimant.
  w.view.procedure.claim.claimantId = 'seat-2';
  w.view.procedure.eligibleSeatIds = ['seat-0', 'seat-1', 'seat-3'];
  deliver(w);
  const before = sent.length;
  client.answerWithdrawal('obsolete', false, 'game', 'branch');
  assert.equal(sent.length, before);
  client.answerWithdrawal('withdrawal', false, 'game', 'branch');
  assert.deepEqual((sent.at(-1) as { intent: unknown }).intent, {
    type: 'withdrawal-response',
    gameId: 'game',
    branchId: 'branch',
    procedureId: 'withdrawal',
    approve: false,
  });
  const next = withdrawalWire(3);
  next.view.procedure.timer.id = 'next';
  deliver(next);
  assert.equal(client.current.withdrawalStatus, 'none');
  client.answerWithdrawal('withdrawal', true, 'game', 'branch');
  assert.equal(sent.length, before + 1);
});

test('withdrawal nested pause preserves both remainders and resumes only the consent clock', () => {
  let now = 100;
  const stream = new GameStream('seat-0', () => now);
  assert.equal(stream.receive(withdrawalWire()), 'state');
  const paused = withdrawalWire(2, true);
  paused.view.procedure.timer.remainingMs = 7000;
  assert.equal(stream.receive(paused), 'state');
  now = 50000;
  assert.equal(remainingTime(stream.snapshot!.withdrawal!.timer, now), 7000);
  assert.equal(remainingTime(stream.snapshot!.ballot!.timer, now), 6000);
  const resumed = withdrawalWire(3);
  resumed.view.procedure.timer.remainingMs = 7000;
  assert.equal(stream.receive(resumed), 'state');
  now += 2000;
  assert.equal(remainingTime(stream.snapshot!.withdrawal!.timer, now), 5000);
  assert.equal(remainingTime(stream.snapshot!.ballot!.timer, now), 6000);
  const denied = ballotWire(4, 4);
  denied.view.procedure.timer.remainingMs = 6000;
  denied.view.procedure.ownVote = 'yes';
  assert.equal(stream.receive(denied), 'state');
  assert.equal(stream.snapshot!.withdrawal, null);
  assert.equal(stream.snapshot!.ballot!.ownVote, 'yes');
  assert.equal(remainingTime(stream.snapshot!.ballot!.timer, now), 6000);
});

test('obsolete, disconnected and malformed withdrawal replies never replay, retarget or imply a verdict', () => {
  for (const mode of ['branch', 'disconnect', 'malformed', 'accepted', 'rejected']) {
    const { client, sent, deliver, listeners } = connection();
    client.requestWithdrawal('claim', 'game', 'branch');
    const total = sent.length;
    if (mode === 'disconnect') {
      listeners.get('disconnect')?.();
      assert.equal(client.current.status, 'uncertain');
    } else if (mode === 'branch') {
      const w = ballotWire(4, 2);
      w.view.head.branchId = 'other';
      deliver(w);
    } else
      deliver({
        protocolVersion: 1,
        type: 'command-ack',
        requestId: (sent.at(-1) as { requestId: string }).requestId,
        result:
          mode === 'rejected'
            ? {
                type: 'rejected',
                code: 'punishment-started',
                head: { gameId: 'game', branchId: 'branch', version: 1 },
              }
            : {
                type: 'accepted',
                outcome: 'control',
                duplicate: mode === 'malformed' ? 'false' : false,
                head: { gameId: 'game', branchId: 'branch', version: 1 },
              },
      });
    assert.equal(
      client.current.withdrawalStatus,
      mode === 'branch'
        ? 'none'
        : mode === 'disconnect' || mode === 'malformed'
          ? 'uncertain'
          : mode,
    );
    assert.equal(sent.length, total);
    assert.equal(client.current.view?.withdrawal ?? null, null);
    client.requestWithdrawal('claim', 'game', 'obsolete-branch');
    assert.equal(sent.length, total);
  }
});

test('withdrawal pending is invalidated by epoch and rollback; delayed acknowledgments cannot revive it', () => {
  for (const rollback of [false, true]) {
    const { client, sent, deliver } = connection();
    client.requestWithdrawal('claim', 'game', 'branch');
    const requestId = (sent.at(-1) as { requestId: string }).requestId;
    if (rollback)
      deliver({
        protocolVersion: 1,
        type: 'rollback-notice',
        delivery: { epoch: 'new', sequence: 1 },
        notice: {},
      });
    const next = ballotWire(4, rollback ? 2 : 1);
    next.delivery.epoch = 'new';
    next.view.procedure.claim.id = 'replacement';
    deliver(next);
    const count = sent.length;
    deliver({
      protocolVersion: 1,
      type: 'command-ack',
      requestId,
      result: {
        type: 'accepted',
        outcome: 'control',
        duplicate: false,
        head: { gameId: 'game', branchId: 'branch', version: 1 },
      },
    });
    assert.equal(client.current.withdrawalStatus, 'none');
    assert.equal(client.current.view?.ballot?.claim.id, 'replacement');
    client.requestWithdrawal('claim', 'game', 'branch');
    assert.equal(sent.length, count);
  }
});

test('explicit queued procedure fixture has no suspended ballot; denial starts a fresh independent ballot', () => {
  // Presentation boundary only: public wire has no authoritative queued-claim listing.
  const stream = new GameStream('seat-0', () => 100);
  const queued = withdrawalWire();
  const wire = {
    ...queued,
    view: { ...queued.view, procedure: { ...queued.view.procedure, suspendedVote: null } },
  };
  assert.equal(stream.receive(wire), 'state');
  assert.equal(stream.snapshot!.ballot, null);
  assert.equal(remainingTime(stream.snapshot!.withdrawal!.timer, 100), 10000);
  assert.equal(stream.receive(ballotWire(4, 2)), 'state');
  assert.equal(stream.snapshot!.withdrawal, null);
  assert.equal(remainingTime(stream.snapshot!.ballot!.timer, 100), 10000);
});
