import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OwnerHistory } from './owner-history.ts';
import { historyPage } from './owner-history.test.ts';
import { connection } from './claims.test.ts';
function selected(h: OwnerHistory) {
  h.request('a', 'game', true);
  h.receive(historyPage('a'));
  h.request('b', 'game', false);
  h.receive(historyPage('b', 1));
  h.select(1, 1);
}
test('rollback confirmation captures exact selected target and snapshot; stale selection cannot confirm', () => {
  const h = new OwnerHistory();
  selected(h);
  const capture = h.captureRollback()!;
  assert.equal(h.matchesRollback(capture), true);
  assert.deepEqual(capture.target, {
    expected: { gameId: 'game', branch: 1, version: 1 },
    beforeActionVersion: 1,
  });
  h.select(9, 9);
  assert.equal(h.matchesRollback(capture), false);
  selected(h);
  h.interrupt();
  assert.equal(h.matchesRollback(capture), false);
});
test('rollback sends warning and immutable original request; ack never installs historical head', () => {
  const { client, sent, deliver } = connection();
  const page = (offset: number, sequence: number) => {
    client.readHistory(offset === 0);
    const p = historyPage((sent.at(-1) as { requestId: string }).requestId, offset);
    p.delivery.sequence = sequence;
    deliver(p);
  };
  page(0, 2);
  page(1, 3);
  client.selectHistory(1, 1);
  const capture = client.captureRollback()!;
  client.confirmRollback(capture);
  const original = structuredClone(sent.at(-1));
  assert.deepEqual(original, {
    protocolVersion: 1,
    requestId: (original as { requestId: string }).requestId,
    intent: { type: 'rollback', target: capture.target, knowledgeWarningAcknowledged: true },
  });
  deliver({
    protocolVersion: 1,
    type: 'command-ack',
    requestId: (original as { requestId: string }).requestId,
    result: {
      type: 'accepted',
      outcome: 'control',
      head: { gameId: 'game', branchId: 'historical', version: 99 },
      duplicate: true,
    },
  });
  assert.equal(client.current.view?.head.branchId, 'branch');
  assert.equal(client.current.rollbackStatus, 'accepted');
});
test('fresh rollback notice clears obsolete work and keeps retained chat; malformed notice fails closed', () => {
  const { client, deliver } = connection();
  const revision = client.current.interactionRevision;
  const notice = {
    actorId: 'seat-0',
    target: { expected: { gameId: 'game', branch: 1, version: 2 }, beforeActionVersion: 1 },
    head: { gameId: 'game', branch: 2, version: 0 },
  };
  deliver({
    protocolVersion: 1,
    type: 'rollback-notice',
    delivery: { epoch: 'fork', sequence: 1 },
    notice,
  });
  assert.deepEqual(client.current.rollbackNotice, notice);
  assert.equal(client.current.view, null);
  assert.ok(client.current.interactionRevision > revision);
  assert.deepEqual(client.current.actionIds, []);
  const r = client.current.interactionRevision;
  deliver({
    protocolVersion: 1,
    type: 'rollback-notice',
    delivery: { epoch: 'fork', sequence: 1 },
    notice,
  });
  assert.equal(client.current.interactionRevision, r);
  deliver({
    protocolVersion: 1,
    type: 'rollback-notice',
    delivery: { epoch: 'fork', sequence: 2 },
    notice: { ...notice, cards: ['secret'] },
  });
  assert.equal(client.current.status, 'failed');
  assert.equal(client.current.rollbackNotice, null);
});
test('uncertain rollback retries exact request after reconnect and fork; no automatic resend or retarget', () => {
  const { client, sent, deliver, listeners } = connection();
  for (const offset of [0, 1]) {
    client.readHistory(offset === 0);
    const p = historyPage((sent.at(-1) as { requestId: string }).requestId, offset);
    p.delivery.sequence = offset + 2;
    deliver(p);
  }
  client.selectHistory(1, 1);
  client.confirmRollback(client.captureRollback()!);
  const request = structuredClone(sent.at(-1));
  listeners.get('disconnect')?.();
  assert.equal(client.current.rollbackStatus, 'uncertain');
  client.connect();
  deliver({ ...awaitlessWire(), delivery: { epoch: 'fork', sequence: 1 } });
  const length = sent.length;
  client.retryRollback();
  assert.equal(sent.length, length + 1);
  assert.deepEqual(sent.at(-1), request);
  client.close();
});
function awaitlessWire() {
  return {
    protocolVersion: 1,
    type: 'state',
    view: {
      head: { gameId: 'game', branchId: 'fork', version: 0 },
      state: null,
      transient: { initialRecipientNotice: false, reveal: null },
      procedure: null,
      control: { paused: false, connections: [], replacementVote: null },
    },
  };
}
