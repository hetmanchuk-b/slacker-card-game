import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id } from '../game/ids.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import { MemoryHistory } from './memory-history.ts';

test('a versioned JSON history archive recovers branches, owner, fork receipts and rollback closure', () => {
  const { history, seats } = fixture('withdrawal');
  const head = history.read().head;
  const fork = {
    id: id('command', 'rollback'),
    actorId: seats[0]!,
    beforeCommandId: id('command', 'withdraw'),
    branchId: id('branch', 'second'),
    nowMs: 25000,
    resumeClock: true,
    knowledgeWarningAcknowledged: true,
  };
  history.fork(head, fork);
  history.closeRollback();
  const archive = JSON.parse(JSON.stringify(history.archive()));
  const restored = MemoryHistory.restore(archive);
  assert.deepEqual(restored.read(), history.read());
  assert.deepEqual(restored.branches(), history.branches());
  assert.deepEqual(restored.audit(), history.audit());
  assert.equal(restored.fork(head, fork).type, 'duplicate');
  const closed = restored.fork(restored.read().head, {
    ...fork,
    id: id('command', 'new'),
    branchId: id('branch', 'third'),
  });
  assert.equal(closed.type, 'rejected');
  if (closed.type === 'rejected') assert.equal(closed.code, 'rollback-closed');
});

test('snapshot-assisted recovery of a forked archive plus its tail equals independent full replay', () => {
  const { history, seats } = fixture('withdrawal');
  const head = history.read().head;
  const fork = {
    id: id('command', 'rollback'),
    actorId: seats[0]!,
    beforeCommandId: id('command', 'withdraw'),
    branchId: id('branch', 'second'),
    nowMs: 25000,
    resumeClock: true,
    knowledgeWarningAcknowledged: true,
  };
  history.fork(head, fork);
  const snapshot = JSON.parse(JSON.stringify(history.snapshot()));
  history.fork(history.read().head, {
    ...fork,
    id: id('command', 'again'),
    branchId: id('branch', 'third'),
    beforeCommandId: fork.id,
    nowMs: 35000,
  });
  history.closeRollback();
  const archive = history.archive();
  const assisted = MemoryHistory.restoreSnapshot(archive, snapshot);
  const replayed = MemoryHistory.restore(archive);
  assert.deepEqual(assisted.read(), replayed.read());
  assert.deepEqual(assisted.branches(), replayed.branches());
  for (const branch of replayed.branches())
    assert.deepEqual(assisted.read(branch.head.branchId), replayed.read(branch.head.branchId));
  assert.deepEqual(assisted.audit(), replayed.audit());
  assert.deepEqual(assisted.archive(), replayed.archive());
});

for (const phase of ['reveal', 'vote', 'withdrawal', 'penalty'] as const) {
  test(`a ${phase} snapshot restores the same nested clocks and private state as full replay`, () => {
    const { history } = fixture(phase);
    const cached = MemoryHistory.restoreSnapshot(
      history.archive(),
      JSON.parse(JSON.stringify(history.snapshot())),
    );
    assert.deepEqual(cached.read(), MemoryHistory.restore(history.archive()).read());
    assert.deepEqual(cached.snapshot(), history.snapshot());
  });
}

test('snapshot integrity rejects changed cache content, wrong archive prefixes and unsupported versions', () => {
  const { history } = fixture('withdrawal');
  const snapshot = history.snapshot();
  const changed = structuredClone(snapshot);
  (changed.value.active.actions as unknown[]).length = 0;
  assert.throws(() => MemoryHistory.restoreSnapshot(history.archive(), changed), /integrity/);
  const wrong = { ...history.archive(), gameId: id('game', 'other') };
  assert.throws(() => MemoryHistory.restoreSnapshot(wrong, snapshot), /integrity/);
  assert.throws(
    () => MemoryHistory.restoreSnapshot(history.archive(), { ...snapshot, operationCount: -1 }),
    /Unsupported/,
  );
  assert.throws(
    () =>
      MemoryHistory.restoreSnapshot(history.archive(), {
        ...snapshot,
        schemaVersion: 999,
      } as unknown as typeof snapshot),
    /Unsupported/,
  );
  assert.deepEqual(
    MemoryHistory.restoreSnapshot(history.archive(), snapshot).read(),
    history.read(),
  );
});

test('an empty-state snapshot keeps original owner and administrative command reservations', () => {
  const empty = new MemoryHistory(id('game', 'not-started'), id('branch', 'main'));
  assert.deepEqual(
    MemoryHistory.restoreSnapshot(empty.archive(), empty.snapshot()).read(),
    empty.read(),
  );
  const { history, seats } = fixture('reveal');
  const creation = history.read().actions[0]!;
  const command = {
    id: id('command', 'rollback'),
    actorId: seats[0]!,
    beforeCommandId: creation.commandId,
    branchId: id('branch', 'empty'),
    nowMs: 25000,
    resumeClock: true,
    knowledgeWarningAcknowledged: true,
  };
  history.fork(history.read().head, command);
  const snapshot = history.snapshot();
  const cached = MemoryHistory.restoreSnapshot(history.archive(), snapshot);
  assert.equal(cached.read().state, null);
  assert.equal(
    cached.append(cached.read().head, { ...creation, commandId: command.id, occurredAtMs: 26000 })
      .type,
    'rejected',
  );
  history.append(history.read().head, {
    ...creation,
    commandId: id('command', 'restart'),
    occurredAtMs: 26000,
  });
  assert.deepEqual(
    MemoryHistory.restoreSnapshot(history.archive(), snapshot).read(),
    MemoryHistory.restore(history.archive()).read(),
  );
});

test('unknown archive versions, operation kinds and duplicated operations fail recovery', () => {
  const { history } = fixture('vote');
  const archive = history.archive();
  const before = history.read();
  assert.throws(
    () => MemoryHistory.restore({ ...archive, schemaVersion: 999 } as unknown as typeof archive),
    /Unsupported/,
  );
  assert.throws(
    () =>
      MemoryHistory.restore({
        ...archive,
        operations: [...archive.operations, archive.operations[0]!],
      }),
    /Invalid archived append/,
  );
  assert.throws(
    () =>
      MemoryHistory.restore({
        ...archive,
        operations: [{ type: 'unknown' }],
      } as unknown as typeof archive),
    /Unknown archived operation/,
  );
  assert.deepEqual(history.read(), before);
});
