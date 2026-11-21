import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id } from '../game/ids.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import { MemoryHistory } from '../persistence/memory-history.ts';
import { projectOwnerHistory } from '../projections/history.ts';
import { makeOwnerHistoryPage } from './history-page.ts';
import { decodeClientMessage } from './decode.ts';
import type { OwnerHistoryView } from '../projections/history.ts';
import type { OwnerHistoryCursor, OwnerHistoryEntry } from './contracts.ts';

const delivery = { epoch: 'test', sequence: 1 };
const requestId = id('command', 'page');
function source() {
  const { history, seats } = fixture('reveal', 8);
  assert.equal(
    history.fork(history.read().head, {
      id: id('command', 'fork'),
      actorId: seats[0]!,
      beforeCommandId: id('command', 'draw-0'),
      branchId: id('branch', 'fork'),
      nowMs: 12000,
      resumeClock: true,
      knowledgeWarningAcknowledged: true,
    }).type,
    'committed',
  );
  return { history, seats };
}
function view() {
  const { history, seats } = source();
  return projectOwnerHistory(history.snapshot().value, { type: 'seat', seatId: seats[0]! });
}
function page(
  value: OwnerHistoryView,
  cursor: OwnerHistoryCursor | null = null,
  bytes = 65536,
  limit = 100,
) {
  return makeOwnerHistoryPage(value, requestId, delivery, cursor, limit, bytes);
}
test('history-page strictly decodes bounded cursors and limits', () => {
  const intent = { type: 'owner-history-page', gameId: 'game', cursor: null, limit: 100 };
  const decode = (changes: object) =>
    decodeClientMessage({ protocolVersion: 1, requestId, intent: { ...intent, ...changes } });
  assert.equal(decode({}).type, 'decoded');
  assert.equal(decode({ cursor: { snapshot: 'a'.repeat(64), offset: 0 } }).type, 'decoded');
  for (const changes of [
    { extra: true },
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { cursor: {} },
    ...['A'.repeat(64), 'a'.repeat(63), 'private'].map((snapshot) => ({
      cursor: { snapshot, offset: 0 },
    })),
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'].map((offset) => ({
      cursor: { snapshot: 'a'.repeat(64), offset },
    })),
    { cursor: { snapshot: 'a'.repeat(64), offset: 0, extra: true } },
  ])
    assert.equal(decode(changes).type, 'rejected');
});
test('large eight-seat fork reconstructs ordered history exactly across byte bounded pages', () => {
  const value = view();
  // Retain the real eight-seat fork, with long public metadata to exceed one frame.
  for (const branch of value.branches)
    for (const row of branch.actions)
      (row.summaries as unknown[]).push({
        type: 'claim-submitted',
        claim: {
          submittedAtVersion: row.version,
          claimantId: value.rollbacks[0]!.actorId,
          accusedId: value.rollbacks[0]!.actorId,
          reason: 'public 😀'.repeat(250),
          scope: 'dealing',
          scopeNumber: 0,
        },
      });
  assert.ok(Buffer.byteLength(JSON.stringify(value)) > 97000);
  const entries: OwnerHistoryEntry[] = [];
  let cursor: OwnerHistoryCursor | null = null;
  let count = 0;
  do {
    const result = page(value, cursor);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) + 128 <= 65536);
    assert.equal(result.requestId, requestId);
    if (result.result.type !== 'page') assert.fail();
    assert.ok(result.result.entries.length > 0);
    entries.push(...result.result.entries);
    cursor = result.result.next;
    assert.ok(++count < 100);
  } while (cursor);
  assert.ok(count > 1);
  const branches: {
    head: OwnerHistoryView['head'];
    label: 'active' | 'abandoned';
    parent: OwnerHistoryView['head'] | null;
    actions: unknown[];
  }[] = [];
  const rollbacks = [];
  for (const entry of entries) {
    if (entry.type === 'branch') branches.push({ ...entry.branch, actions: [] });
    else if (entry.type === 'action')
      branches.find((branch) => branch.head.branch === entry.branch)!.actions.push(entry.action);
    else rollbacks.push(entry.rollback);
  }
  assert.deepEqual(
    { head: value.head, rollbackOpen: value.rollbackOpen, branches, rollbacks },
    value,
  );
  for (const secret of ['opaque-', 'commandId', 'branchId', 'events', 'cards'])
    assert.equal(JSON.stringify(entries).includes(secret), false);
});
test('complete public identity binds continuation including same-head closure, metadata and audit', () => {
  const value = view();
  const first = page(value, null, 65536, 1);
  if (first.result.type !== 'page' || !first.result.next) assert.fail();
  for (const change of [
    (v: OwnerHistoryView) => ({ ...v, rollbackOpen: false }),
    (v: OwnerHistoryView) => ({ ...v, head: { ...v.head, version: v.head.version + 1 } }),
    (v: OwnerHistoryView) => ({ ...v, branches: v.branches.slice(1) }),
    (v: OwnerHistoryView) => ({ ...v, rollbacks: [] }),
    (v: OwnerHistoryView) => ({ ...v, head: { ...v.head, gameId: id('game', 'wrong') } }),
  ])
    assert.deepEqual(page(change(value), first.result.next).result, { type: 'stale' });
  assert.deepEqual(page(value, { ...first.result.next, offset: 999999 }).result, {
    type: 'unavailable',
  });
});
test('exact envelope byte boundary, oversized record and empty actions have safe outcomes', () => {
  const value = view();
  const first = page(value, null, 65536, 1);
  const size = Buffer.byteLength(JSON.stringify(first)) + 128;
  assert.deepEqual(page(value, null, size, 1), first);
  assert.deepEqual(page(value, null, size - 1, 1).result, { type: 'unavailable' });
  const empty = {
    ...value,
    branches: value.branches.map((branch) => ({ ...branch, actions: [] })),
    rollbacks: [],
  };
  const result = page(empty);
  if (result.result.type !== 'page') assert.fail();
  assert.equal(result.result.next, null);
  assert.equal(result.result.entries.length, value.branches.length);
  const huge = {
    ...value,
    branches: value.branches.map((branch) => ({
      ...branch,
      actions: branch.actions.map((row) => ({
        ...row,
        summaries: [
          {
            type: 'claim-submitted' as const,
            claim: {
              submittedAtVersion: 1,
              claimantId: value.rollbacks[0]!.actorId,
              accusedId: value.rollbacks[0]!.actorId,
              reason: 'x'.repeat(70000),
              scope: 'dealing' as const,
              scopeNumber: 0,
            },
          },
        ],
      })),
    })),
  };
  const start = page(huge, null, 65536, 1);
  if (start.result.type !== 'page') assert.fail();
  assert.deepEqual(page(huge, start.result.next).result, { type: 'unavailable' });
});

test('unchanged recovered public history has identical identity; private capture extras are ignored', () => {
  const { history, seats } = source();
  const input = history.snapshot().value;
  const original = projectOwnerHistory(input, { type: 'seat', seatId: seats[0]! });
  const changed = { ...input, privateBallots: ['secret'], cardFaces: ['secret'] };
  const projected = projectOwnerHistory(changed, { type: 'seat', seatId: seats[0]! });
  assert.deepEqual(page(projected), page(original));
  const restored = MemoryHistory.restore(history.archive());
  assert.deepEqual(
    page(projectOwnerHistory(restored.snapshot().value, { type: 'seat', seatId: seats[0]! })),
    page(original),
  );
});

test('actual long eight-seat retained forks exceed 97KB and page without losing inherited rows or audit', () => {
  const { history, seats } = fixture('reveal', 8);
  let target = id('command', 'draw-34');
  for (let index = 0; index < 16; index++) {
    const command = id('command', `fork-${index}`);
    assert.equal(
      history.fork(history.read().head, {
        id: command,
        actorId: seats[0]!,
        beforeCommandId: target,
        branchId: id('branch', `fork-${index}`),
        nowMs: 12000 + index,
        resumeClock: true,
        knowledgeWarningAcknowledged: true,
      }).type,
      'committed',
    );
    target = command;
  }
  const original = projectOwnerHistory(history.snapshot().value, {
    type: 'seat',
    seatId: seats[0]!,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(original)) > 97000);
  const expected: OwnerHistoryEntry[] = original.branches.flatMap((branch) => [
    {
      type: 'branch' as const,
      branch: { head: branch.head, label: branch.label, parent: branch.parent },
    },
    ...branch.actions.map((action) => ({
      type: 'action' as const,
      branch: branch.head.branch,
      action,
    })),
  ]);
  expected.push(...original.rollbacks.map((rollback) => ({ type: 'rollback' as const, rollback })));
  let cursor: OwnerHistoryCursor | null = null;
  const actual: OwnerHistoryEntry[] = [];
  do {
    const result = page(original, cursor);
    if (result.result.type !== 'page') assert.fail();
    assert.ok(Buffer.byteLength(JSON.stringify(result)) + 128 <= 65536);
    actual.push(...result.result.entries);
    cursor = result.result.next;
  } while (cursor);
  assert.deepEqual(actual, expected);
  const first = page(original, null, 65536, 1);
  if (first.result.type !== 'page') assert.fail();
  history.closeRollback();
  const closed = projectOwnerHistory(history.snapshot().value, { type: 'seat', seatId: seats[0]! });
  assert.deepEqual(closed.head, original.head);
  assert.ok(
    closed.branches.every((branch) =>
      branch.actions.every((action) => action.rollbackTarget === null),
    ),
  );
  assert.deepEqual(page(closed, first.result.next).result, { type: 'stale' });
});
