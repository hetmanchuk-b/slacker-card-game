import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OwnerHistory, summary } from './owner-history.ts';
export function historyPage(requestId: string, offset = 0) {
  const head = { gameId: 'game', branch: 1, version: 1 };
  const entries = [
    { type: 'branch', branch: { head, label: 'active', parent: null } },
    {
      type: 'action',
      branch: 1,
      action: {
        version: 1,
        origin: { branch: 1, version: 1 },
        occurredAtMs: 1,
        summaries: [{ type: 'game-started', actorId: 'seat-0' }],
        rollbackTarget: { expected: head, beforeActionVersion: 1 },
      },
    },
  ];
  return {
    protocolVersion: 1,
    type: 'owner-history-page',
    requestId,
    delivery: { epoch: 'epoch', sequence: offset + 2 },
    result: {
      type: 'page',
      head,
      rollbackOpen: true,
      snapshot: 'a'.repeat(64),
      entries: entries.slice(offset, offset + 1),
      next: offset === 0 ? { snapshot: 'a'.repeat(64), offset: 1 } : null,
    },
  };
}
test('history traversal retains complete ordered pages and selects only complete active targets', () => {
  const h = new OwnerHistory();
  h.request('a', 'game', true);
  assert.equal(h.receive(historyPage('wrong')), 'ignored');
  assert.equal(h.receive(historyPage('a')), 'accepted');
  h.select(1, 1);
  assert.equal(h.current.selected, null);
  h.request('b', 'game', false);
  assert.equal(h.receive(historyPage('b', 1)), 'accepted');
  assert.equal(h.current.entries.length, 2);
  h.select(1, 1);
  assert.deepEqual(h.current.selected, { branch: 1, version: 1 });
  h.interrupt();
  assert.equal(h.current.entries.length, 0);
  assert.equal(h.current.selected, null);
});
test('summary privacy is exact even for historical own cards and ballot choices', () => {
  assert.equal(summary({ type: 'card-played', actorId: 'seat-0' }), true);
  for (const field of ['card', 'cardId', 'face', 'votes', 'ownVote', 'commandId'])
    assert.equal(summary({ type: 'card-played', actorId: 'seat-0', [field]: 'private' }), false);
});
test('changed snapshot, stale and invalid ordering clear incomplete history', () => {
  for (const mode of ['stale', 'snapshot', 'order']) {
    const h = new OwnerHistory();
    h.request('a', 'game', true);
    h.receive(historyPage('a'));
    h.request('b', 'game', false);
    const p = historyPage('b', 1);
    if (mode === 'snapshot') p.result.snapshot = 'b'.repeat(64);
    if (mode === 'order') p.result.entries = historyPage('a').result.entries;
    const raw = mode === 'stale' ? { ...p, result: { type: 'stale' } } : p;
    h.receive(raw);
    assert.equal(h.current.entries.length, 0);
    assert.equal(h.current.selected, null);
  }
});

import { connection, ballotWire } from './claims.test.ts';
import { GameStream } from './game-stream.ts';
test('shared connection consumes delayed mismatched page sequence without installing its head; live updates fence traversal', () => {
  const { client, sent, deliver } = connection();
  client.readHistory();
  const requestId = (sent.at(-1) as { requestId: string }).requestId;
  const page = historyPage(requestId);
  page.delivery.sequence = 2;
  deliver(page);
  assert.equal(client.current.history.status, 'partial');
  assert.equal(client.current.view?.head.branchId, 'branch');
  deliver({ ...page, requestId: 'old', delivery: { ...page.delivery, sequence: 3 } });
  assert.equal(client.current.history.status, 'partial');
  deliver(ballotWire(4, 4));
  assert.equal(client.current.status, 'observing');
  assert.equal(client.current.history.status, 'uncertain');
  client.readHistory(false);
  assert.equal((sent.at(-1) as { requestId: string }).requestId, requestId);
});
test('history page consumes sequence but never resets a current live snapshot; gaps fail closed', () => {
  const s = new GameStream('seat-0');
  s.receive(ballotWire());
  assert.equal(s.receive(historyPage('request')), 'meta');
  assert.ok(s.snapshot);
  assert.equal(
    s.receive({ ...historyPage('other'), delivery: { epoch: 'epoch', sequence: 4 } }),
    'invalid',
  );
});

test('every summary variant accepts only its complete public metadata schema', () => {
  const values = [
    ...[
      'game-started',
      'card-played',
      'stump-opened',
      'claim-vote-cast',
      'withdrawal-answered',
      'penalty-answered',
    ].map((type) => ({ type, actorId: 'seat' })),
    ...[
      'claim-vote-expired',
      'withdrawal-expired',
      'penalty-started',
      'penalty-expired',
      'penalty-completed',
      'reveal-finished',
      'reveal-resumed',
      'clock-suspended',
      'clock-resumed',
      'server-action',
    ].map((type) => ({ type })),
    { type: 'card-drawn', actorId: 'seat', destination: 'hand' },
    { type: 'bottom-taken', actorId: 'seat', automatic: true },
    { type: 'violation', actorId: 'seat', reason: 'peek' },
    {
      type: 'claim-submitted',
      claim: {
        submittedAtVersion: 1,
        claimantId: 'seat',
        accusedId: 'other',
        reason: '<b>Exact public text</b>',
        scope: 'round',
        scopeNumber: 1,
      },
    },
    ...['claim-vote-started', 'withdrawal-started'].map((type) => ({
      type,
      submittedAtVersion: 1,
    })),
    { type: 'withdrawal-requested', submittedAtVersion: 1, actorId: 'seat' },
    { type: 'claim-vote-resolved', submittedAtVersion: 1, resolution: 'tied' },
    { type: 'withdrawal-resolved', submittedAtVersion: 1, approved: false },
    { type: 'rollback', actorId: 'seat', rollback: 1 },
  ];
  for (const v of values) {
    assert.equal(summary(v), true, v.type);
    assert.equal(summary({ ...v, cards: [] }), false, v.type);
  }
});
test('closed and abandoned rows cannot gain selectors; nested private fields fail closed', () => {
  for (const change of [
    (p: ReturnType<typeof historyPage>) => {
      p.result.rollbackOpen = false;
    },
    (p: ReturnType<typeof historyPage>) => {
      Object.assign(p.result.entries[0]!.branch!, { label: 'abandoned' });
    },
    (p: ReturnType<typeof historyPage>) => {
      Object.assign(p.result.entries[1]!.action!, { cards: [] });
    },
    (p: ReturnType<typeof historyPage>) => {
      Object.assign(p.result.entries[1]!.action!.rollbackTarget.expected, { branchId: 'private' });
    },
  ]) {
    const h = new OwnerHistory();
    h.request('a', 'game', true);
    const p = historyPage('a');
    p.result.entries.push(...historyPage('a', 1).result.entries);
    p.result.next = null;
    change(p);
    assert.equal(h.receive(p), 'invalid');
    assert.equal(h.current.entries.length, 0);
  }
});
test('disconnect fences delayed history and clears complete selection', () => {
  const { client, sent, deliver, listeners } = connection();
  client.readHistory();
  const requestId = (sent.at(-1) as { requestId: string }).requestId;
  const p = historyPage(requestId);
  p.result.entries.push(...historyPage(requestId, 1).result.entries);
  p.result.next = null;
  deliver(p);
  assert.equal(client.current.history.status, 'complete', JSON.stringify(client.current.history));
  client.selectHistory(1, 1);
  assert.ok(client.current.history.selected);
  listeners.get('disconnect')?.();
  assert.equal(client.current.history.selected, null);
  deliver({ ...p, delivery: { epoch: 'epoch', sequence: 3 } });
  assert.equal(client.current.history.entries.length, 0);
});
