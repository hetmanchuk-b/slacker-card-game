import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ballotWire, connection } from './claims.test.ts';
import { GameStream, remainingTime } from './game-stream.ts';

export function presenceWire(sequence = 2, vote = true) {
  const w = ballotWire(4, sequence, true);
  return {
    ...w,
    view: {
      ...w.view,
      control: {
        paused: true,
        connections: w.view.state.players.map((p, i) => ({
          seatId: p.id,
          connected: i !== 1,
          controller: 'human',
        })),
        replacementVote: vote
          ? {
              absentSeatId: 'seat-1',
              eligibleSeatIds: ['seat-0', 'seat-2', 'seat-3'],
              ownVote: null as string | null,
              timer: { id: 'replacement', remainingMs: 10000, paused: false },
            }
          : null,
      },
    },
  };
}
test('replacement clock runs during gameplay suspension; duplicate state cannot extend it', () => {
  let now = 100;
  const stream = new GameStream('seat-0', () => now);
  assert.equal(stream.receive(presenceWire()), 'state');
  now += 3000;
  assert.equal(stream.receive(presenceWire(3)), 'state');
  assert.equal(remainingTime(stream.snapshot!.replacementVote!.timer, now), 7000);
  assert.equal(remainingTime(stream.snapshot!.ballot!.timer, now), 10000);
  assert.equal(stream.receive(presenceWire(4, false)), 'state');
  assert.equal(stream.snapshot!.replacementVote, null);
});
test('replacement parser rejects private ballots, malformed answers, timers and unknown seats', () => {
  for (const mutate of [
    (w: ReturnType<typeof presenceWire>) =>
      Object.assign(w.view.control.replacementVote!, { votes: { 'seat-2': 'yes' } }),
    (w: ReturnType<typeof presenceWire>) => {
      w.view.control.replacementVote!.ownVote = 'maybe';
    },
    (w: ReturnType<typeof presenceWire>) => {
      w.view.control.replacementVote!.timer.paused = true;
    },
    (w: ReturnType<typeof presenceWire>) => {
      w.view.control.replacementVote!.absentSeatId = 'unknown';
    },
  ]) {
    const w = presenceWire();
    mutate(w);
    assert.equal(new GameStream('seat-0').receive(w), 'invalid');
  }
});
test('replacement commands use captured route and own human presence while paused; no stale retarget', () => {
  const { client, sent, deliver } = connection();
  deliver(presenceWire(2, false));
  const before = sent.length;
  client.proposeBot('seat-1', 'game', 'wrong');
  assert.equal(sent.length, before);
  client.proposeBot('seat-1', 'game', 'branch');
  assert.deepEqual((sent.at(-1) as { intent: unknown }).intent, {
    type: 'propose-bot',
    gameId: 'game',
    branchId: 'branch',
    absentSeatId: 'seat-1',
  });
  deliver({
    protocolVersion: 1,
    type: 'command-ack',
    requestId: (sent.at(-1) as { requestId: string }).requestId,
    result: {
      type: 'rejected',
      code: 'replacement-too-early',
      head: { gameId: 'game', branchId: 'branch', version: 2 },
    },
  });
  assert.equal(client.current.replacementStatus, 'rejected');
  assert.equal(client.current.replacementRejection, 'replacement-too-early');
  deliver(presenceWire(3));
  client.voteReplacement('replacement', 'no', 'game', 'branch');
  assert.equal((sent.at(-1) as { intent: { type: string } }).intent.type, 'replacement-vote');
  deliver(presenceWire(4, false));
  const total = sent.length;
  client.voteReplacement('replacement', 'yes', 'game', 'branch');
  assert.equal(sent.length, total);
});

test('replacement human gates reject finished, bot and disconnected callers and answered ballots', () => {
  for (const mode of ['finished', 'bot', 'disconnected', 'answered']) {
    const { client, sent, deliver } = connection();
    const w = presenceWire();
    if (mode === 'finished') {
      w.view.state.players[0]!.status = 'won';
      w.view.state.phase.leaderId = 'seat-2';
      w.view.procedure.claim.claimantId = 'seat-2';
      w.view.procedure.eligibleSeatIds = ['seat-2', 'seat-3'];
      w.view.control.replacementVote!.eligibleSeatIds = ['seat-2', 'seat-3'];
    }
    if (mode === 'bot') w.view.control.connections[0]!.controller = 'bot';
    if (mode === 'disconnected') w.view.control.connections[0]!.connected = false;
    if (mode === 'answered') w.view.control.replacementVote!.ownVote = 'abstain';
    deliver(w);
    assert.equal(client.current.status, 'observing');
    const before = sent.length;
    client.voteReplacement('replacement', 'yes', 'game', 'branch');
    assert.equal(sent.length, before, mode);
  }
});

test('replacement lost reply is uncertain; stale/mismatched acknowledgments and retired epochs never replay', () => {
  const { client, sent, deliver, listeners } = connection();
  deliver(presenceWire());
  client.voteReplacement('replacement', 'yes', 'game', 'branch');
  const requestId = (sent.at(-1) as { requestId: string }).requestId;
  const ack = {
    protocolVersion: 1,
    type: 'command-ack',
    requestId: 'wrong',
    result: {
      type: 'accepted',
      outcome: 'control',
      duplicate: false,
      head: { gameId: 'historical', branchId: 'historical', version: 999 },
    },
  };
  deliver(ack);
  assert.equal(client.current.replacementStatus, 'pending');
  const before = sent.length;
  const oldListener = listeners.get('server-message')!;
  listeners.get('disconnect')?.();
  assert.equal(client.current.replacementStatus, 'uncertain');
  const currentView = () => client.current.view;
  assert.equal(currentView(), null);
  client.connect();
  const fresh = presenceWire(1, false);
  fresh.delivery.epoch = 'fresh';
  deliver(fresh);
  const afterConnect = sent.length;
  assert.equal(afterConnect, before + 1); // resync only
  deliver({ ...ack, requestId });
  assert.equal(currentView()?.head.gameId, 'game');
  oldListener(presenceWire(10), 'nonce', () => {}); // old physical connection cannot restore its vote
  assert.equal(currentView()?.replacementVote, null);
  assert.equal(sent.length, afterConnect);
});

test('cancelled replacement clears pending ballot and delayed old ack cannot settle the next vote', () => {
  const { client, sent, deliver } = connection();
  deliver(presenceWire());
  client.voteReplacement('replacement', 'no', 'game', 'branch');
  const old = (sent.at(-1) as { requestId: string }).requestId;
  deliver(presenceWire(3, false));
  assert.equal(client.current.replacementStatus, 'none');
  const next = presenceWire(4);
  next.view.control.replacementVote!.timer.id = 'new-vote';
  deliver(next);
  client.voteReplacement('replacement', 'yes', 'game', 'branch');
  client.voteReplacement('new-vote', 'abstain', 'game', 'branch');
  deliver({
    protocolVersion: 1,
    type: 'command-ack',
    requestId: old,
    result: {
      type: 'accepted',
      outcome: 'control',
      duplicate: false,
      head: { gameId: 'game', branchId: 'branch', version: 1 },
    },
  });
  assert.equal(client.current.replacementStatus, 'pending');
  const branch = presenceWire(1, false);
  branch.delivery.epoch = 'branch-epoch';
  branch.view.head.branchId = 'fork';
  deliver(branch);
  assert.equal(client.current.replacementStatus, 'none');
  const total = sent.length;
  client.proposeBot('seat-1', 'game', 'branch');
  assert.equal(sent.length, total);
});
