import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameStream, remainingTime } from './game-stream.ts';

export function ballotWire(count = 4, sequence = 1, paused = false) {
  const players = Array.from({ length: count }, (_, i) => ({
    id: `seat-${i}`,
    status: 'active',
    handCount: 0,
    stumpCount: 0,
  }));
  return {
    protocolVersion: 1,
    type: 'state',
    delivery: { epoch: 'epoch', sequence },
    view: {
      head: { gameId: 'game', branchId: 'branch', version: sequence },
      state: {
        viewer: { type: 'participant', seatId: 'seat-0' },
        own: { seatId: 'seat-0', hand: [], stumps: [] },
        players,
        deckCount: 0,
        table: [],
        discardCount: 0,
        phase: { type: 'between-rounds', leaderId: 'seat-0', nextRoundNumber: 2 },
      },
      transient: { initialRecipientNotice: false, reveal: null },
      procedure: {
        type: 'claim-vote',
        claim: {
          id: 'claim',
          claimantId: 'seat-0',
          accusedId: 'seat-1',
          reason: '<exact reason>',
          scope: 'round',
          scopeNumber: 1,
        },
        eligibleSeatIds: players.filter((p) => p.id !== 'seat-1').map((p) => p.id),
        ownVote: null as string | null,
        timer: { id: 'vote', remainingMs: 10000, paused },
      },
      control: { paused, connections: [], replacementVote: null },
    },
  };
}
for (const count of [2, 4, 8])
  test(`claim ballot ${count} seats: own answer only and empty hand eligibility`, () => {
    const stream = new GameStream('seat-0', () => 100);
    for (const [index, vote] of [null, 'yes', 'no', 'abstain'].entries()) {
      const wire = ballotWire(count, index + 1);
      wire.view.procedure.ownVote = vote;
      assert.equal(stream.receive(wire), 'state');
      assert.equal(stream.snapshot?.ballot?.ownVote, vote);
      assert.ok(stream.snapshot?.ballot?.eligibleSeatIds.includes('seat-0'));
    }
  });
test('ballot timer freezes and resumes without extending; foreign ballots fail closed', () => {
  let now = 100;
  const stream = new GameStream('seat-0', () => now);
  assert.equal(stream.receive(ballotWire()), 'state');
  now = 3100;
  assert.equal(stream.receive(ballotWire(4, 2)), 'state');
  assert.equal(remainingTime(stream.snapshot!.ballot!.timer, now), 7000);
  const paused = ballotWire(4, 3, true);
  paused.view.procedure.timer.remainingMs = 6000;
  assert.equal(stream.receive(paused), 'state');
  now = 50000;
  assert.equal(remainingTime(stream.snapshot!.ballot!.timer, now), 6000);
  const bad = ballotWire(4, 4);
  Object.assign(bad.view.procedure, { votes: { 'seat-2': 'no' } });
  assert.equal(stream.receive(bad), 'invalid');
});

import { GameConnection } from './game-connection.ts';
function connection() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const sent: object[] = [];
  const socket = {
    connected: true,
    on: (e: string, f: (...args: unknown[]) => void) => {
      listeners.set(e, f);
    },
    connect: () => listeners.get('connect')?.(),
    disconnect: () => {},
    send: (m: object) => {
      sent.push(m);
    },
  };
  let id = 0;
  const client = new GameConnection({
    lobbyId: 'lobby',
    seatId: 'seat-0',
    isOwner: true,
    factory: () => socket,
    requestId: () => `req-${++id}`,
    storage: { getItem: () => null, setItem: () => {} },
    schedule: () => () => {},
    now: () => 100,
  });
  const deliver = (m: object) => listeners.get('server-message')?.(m, 'nonce', () => {});
  client.connect();
  deliver(ballotWire());
  return { client, sent, deliver, listeners };
}
test('claims send exact manual keys, no inferred fields; vote is bound to captured procedure', () => {
  const { client, sent, deliver } = connection();
  const before = sent.length;
  client.submitClaim('seat-1', 'reason', { type: 'spoken', key: '' });
  assert.equal(sent.length, before);
  client.submitClaim('seat-1', 'reason', { type: 'spoken', key: '  Manual Episode  ' });
  assert.deepEqual((sent.at(-1) as { intent: unknown }).intent, {
    type: 'submit-claim',
    gameId: 'game',
    branchId: 'branch',
    accusedId: 'seat-1',
    reason: 'reason',
    evidence: { type: 'spoken', key: '  Manual Episode  ' },
  });
  const requestId = (sent.at(-1) as { requestId: string }).requestId;
  deliver({
    protocolVersion: 1,
    type: 'command-ack',
    requestId,
    result: {
      type: 'rejected',
      code: 'scope-closed',
      head: { gameId: 'game', branchId: 'branch', version: 1 },
    },
  });
  assert.equal(client.current.claimStatus, 'rejected');
  client.castVote('obsolete', 'yes', 'game', 'branch');
  assert.equal(sent.length, before + 1);
  client.castVote('vote', 'abstain', 'game', 'branch');
  assert.equal((sent.at(-1) as { intent: { vote: string } }).intent.vote, 'abstain');
  const next = ballotWire(4, 2);
  next.view.procedure.timer.id = 'next';
  deliver(next);
  assert.equal(client.current.voteStatus, 'none');
  client.castVote('vote', 'yes', 'game', 'branch');
  assert.equal(sent.length, before + 2);
});

test('chat/action references serialize only visible exact IDs; closed scope is technical even for retained evidence', () => {
  for (const type of ['chat', 'action'] as const) {
    const { client, sent, deliver } = connection();
    const id = type === 'chat' ? 'Exact-message-ID' : 'Exact-action-ID';
    if (type === 'chat') {
      client.readChat(true);
      deliver({
        protocolVersion: 1,
        type: 'chat-page',
        requestId: (sent.at(-1) as { requestId: string }).requestId,
        messages: [
          {
            id,
            lobbyId: 'lobby',
            authorSeatId: 'seat-1',
            text: 'immutable text',
            sequence: '1',
            atMs: 1000,
            context: { head: null, scope: 'lobby', scopeNumber: null },
          },
        ],
      });
    } else {
      deliver({
        protocolVersion: 1,
        type: 'action',
        delivery: { epoch: 'epoch', sequence: 2 },
        view: {
          head: { gameId: 'game', branchId: 'branch', version: 2 },
          commandId: id,
          observations: [],
        },
      });
      deliver(ballotWire(4, 3));
    }
    client.submitClaim(
      'seat-1',
      'reason',
      type === 'chat' ? { type, messageId: id } : { type, commandId: id },
    );
    assert.deepEqual(
      (sent.at(-1) as { intent: { evidence: unknown } }).intent.evidence,
      type === 'chat' ? { type, messageId: id } : { type, commandId: id },
    );
    deliver({
      protocolVersion: 1,
      type: 'command-ack',
      requestId: (sent.at(-1) as { requestId: string }).requestId,
      result: {
        type: 'rejected',
        code: 'scope-closed',
        head: { gameId: 'game', branchId: 'branch', version: 3 },
      },
    });
    assert.equal(client.current.claimStatus, 'rejected');
  }
});
test('malformed, disconnected and stale branch votes never automatically replay or retarget', () => {
  for (const mode of ['malformed', 'disconnect', 'branch']) {
    const { client, sent, deliver, listeners } = connection();
    client.castVote('vote', 'yes', 'game', 'branch');
    const total = sent.length;
    if (mode === 'malformed')
      deliver({
        protocolVersion: 1,
        type: 'command-ack',
        requestId: (sent.at(-1) as { requestId: string }).requestId,
        result: {
          type: 'accepted',
          head: { gameId: 'game', branchId: 'branch', version: 2 },
          outcome: 'control',
          duplicate: 'false',
        },
      });
    else if (mode === 'disconnect') listeners.get('disconnect')?.();
    else {
      const next = ballotWire(4, 2);
      next.view.head.branchId = 'new-branch';
      deliver(next);
    }
    assert.equal(sent.length, total);
    assert.equal(client.current.voteStatus, mode === 'branch' ? 'none' : 'uncertain');
    client.castVote('vote', 'yes', 'game', 'branch');
    assert.equal(sent.length, total);
  }
});
test('accused/exited eligibility and opponent answer maps are rejected; nested withdrawal freezes ballot', () => {
  for (const mutate of [
    (w: ReturnType<typeof ballotWire>) => {
      w.view.procedure.eligibleSeatIds.push('seat-1');
    },
    (w: ReturnType<typeof ballotWire>) => {
      w.view.state.players[2]!.status = 'exited';
    },
    (w: ReturnType<typeof ballotWire>) => {
      Object.assign(w.view.procedure, { votes: { 'seat-2': 'yes' } });
    },
    (w: ReturnType<typeof ballotWire>) => {
      w.view.procedure.ownVote = 'unknown';
    },
  ]) {
    const w = ballotWire();
    mutate(w);
    assert.equal(new GameStream('seat-0').receive(w), 'invalid');
  }
  const w = ballotWire();
  const suspended = {
    ...w.view.procedure,
    timer: { ...w.view.procedure.timer, paused: true, remainingMs: 6000 },
  };
  const nested = {
    ...w,
    view: {
      ...w.view,
      procedure: {
        type: 'withdrawal',
        claim: suspended.claim,
        eligibleSeatIds: ['seat-1', 'seat-2', 'seat-3'],
        ownApproval: null,
        suspendedVote: suspended,
        timer: { id: 'withdrawal', remainingMs: 10000, paused: false },
      },
    },
  };
  const stream = new GameStream('seat-0', () => 100);
  assert.equal(stream.receive(nested), 'state');
  assert.equal(remainingTime(stream.snapshot!.ballot!.timer, 50000), 6000);
});

test('blank/over-limit spoken keys and reasons do not fabricate evidence or issue commands', () => {
  const { client, sent } = connection();
  const count = sent.length;
  for (const key of ['', '   ', 'x'.repeat(257), '\0'])
    client.submitClaim('seat-1', 'reason', { type: 'spoken', key });
  for (const reason of ['', 'x'.repeat(4097), '\0'])
    client.submitClaim('seat-1', reason, { type: 'spoken', key: 'manual' });
  assert.equal(sent.length, count);
});
