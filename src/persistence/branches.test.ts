import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id } from '../game/ids.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import { applyAction } from '../game/engine.ts';
import { MemoryHistory } from './memory-history.ts';

test('forking before a completed action retains the old future and restores the pre-action state', () => {
  const { history, seats } = fixture('reveal');
  const before = history.read();
  const target = before.actions.at(-1)!;
  const point = history.rollbackPoint(target.commandId)!;
  assert.equal(point.head.version, 36);
  assert.equal(point.state?.deck.length, 1);
  const result = history.fork(before.head, {
    id: id('command', 'rollback'),
    actorId: seats[0]!,
    beforeCommandId: target.commandId,
    branchId: id('branch', 'second'),
    nowMs: 5000,
    resumeClock: true,
    knowledgeWarningAcknowledged: true,
  });
  assert.equal(result.type, 'committed');
  assert.equal(history.read().state?.deck.length, 1);
  assert.deepEqual(history.read(before.head.branchId), before);
  assert.equal(history.read().head.branchId, 'second');
  assert.equal(history.branches().length, 2);
  assert.equal(history.audit()[0]?.actorId, seats[0]);
  assert.equal(history.audit()[0]?.beforeCommandId, target.commandId);
});

test('forking before a prior clock rebase preserves the original six-second rollback point', () => {
  const { history, seats } = fixture('withdrawal');
  const first = {
    id: id('command', 'first'),
    actorId: seats[0]!,
    beforeCommandId: id('command', 'withdraw'),
    branchId: id('branch', 'first-branch'),
    nowMs: 25000,
    resumeClock: true,
    knowledgeWarningAcknowledged: true,
  };
  assert.equal(history.fork(history.read().head, first).type, 'committed');
  assert.equal(history.read().state?.procedure?.timer.remainingMs, 6000);
  assert.equal(
    history.fork(history.read().head, {
      ...first,
      id: id('command', 'second'),
      branchId: id('branch', 'second-branch'),
      beforeCommandId: first.id,
      nowMs: 35000,
    }).type,
    'committed',
  );
  assert.equal(history.read().state?.procedure?.timer.remainingMs, 6000);
  assert.equal(history.read().state?.procedure?.timer.startedAtMs, 35000);
});

test('invalid rollback requests never mutate branches, state or the audit trail', () => {
  const { history, seats } = fixture('withdrawal');
  const before = history.read();
  const request = {
    id: id('command', 'rollback'),
    actorId: seats[0]!,
    beforeCommandId: id('command', 'withdraw'),
    branchId: id('branch', 'second'),
    nowMs: 25000,
    resumeClock: true,
    knowledgeWarningAcknowledged: true,
  };
  for (const [patch, code] of [
    [{ actorId: seats[1]! }, 'owner-only'],
    [{ knowledgeWarningAcknowledged: false }, 'warning-required'],
    [{ beforeCommandId: id('command', 'unknown') }, 'unknown-target'],
    [{ branchId: before.head.branchId }, 'branch-exists'],
    [{ nowMs: 4999 }, 'invalid-time'],
    [{ id: id('command', 'claim') }, 'command-id-reused'],
  ] as const) {
    const result = history.fork(before.head, { ...request, ...patch });
    assert.equal(result.type, 'rejected');
    if (result.type === 'rejected') assert.equal(result.code, code);
    assert.deepEqual(history.read(), before);
    assert.equal(history.branches().length, 1);
    assert.deepEqual(history.audit(), []);
  }
  assert.equal(history.fork({ ...before.head, version: 0 }, request).type, 'rejected');
  assert.equal(
    history.fork({ ...before.head, branchId: id('branch', 'stale') }, request).type,
    'rejected',
  );
  assert.deepEqual(history.read(), before);
  assert.equal(history.rollbackPoint(id('command', 'not-recorded')), null);
});

test('fork retries are idempotent and a changed payload cannot reuse the administrative command ID', () => {
  const { history, seats } = fixture('withdrawal');
  const head = history.read().head;
  const request = {
    id: id('command', 'rollback'),
    actorId: seats[0]!,
    beforeCommandId: id('command', 'withdraw'),
    branchId: id('branch', 'second'),
    nowMs: 25000,
    resumeClock: true,
    knowledgeWarningAcknowledged: true,
  };
  const first = history.fork(head, request);
  assert.equal(first.type, 'committed');
  const beforeRetry = history.read();
  assert.deepEqual(history.fork(head, request), { type: 'duplicate', head: first.head });
  const reused = history.fork(head, { ...request, nowMs: 26000 });
  assert.equal(reused.type, 'rejected');
  if (reused.type === 'rejected') assert.equal(reused.code, 'command-id-reused');
  assert.deepEqual(history.read(), beforeRetry);
  assert.equal(history.audit().length, 1);
  assert.deepEqual(
    history
      .read()
      .actions.reduce(
        (state, action) => applyAction(state, action),
        null as typeof beforeRetry.state,
      ),
    beforeRetry.state,
  );
});

test('rollback before game creation retains ownership and the next-match boundary cannot be rolled back', () => {
  const { history, seats } = fixture('reveal');
  const request = {
    id: id('command', 'rollback'),
    actorId: seats[0]!,
    beforeCommandId: id('command', 'start'),
    branchId: id('branch', 'empty'),
    nowMs: 25000,
    resumeClock: true,
    knowledgeWarningAcknowledged: true,
  };
  assert.equal(history.fork(history.read().head, request).type, 'committed');
  assert.equal(history.read().state, null);
  assert.equal(history.read().head.version, 0);
  assert.equal(history.audit().length, 1);
  const creation = history.read(id('branch', 'main')).actions[0]!;
  history.append(history.read().head, { ...creation, occurredAtMs: 26000 });
  history.closeRollback();
  const before = history.read();
  const result = history.fork(before.head, {
    ...request,
    id: id('command', 'after-next-match'),
    branchId: id('branch', 'forbidden'),
    nowMs: 27000,
  });
  assert.equal(result.type, 'rejected');
  if (result.type === 'rejected') assert.equal(result.code, 'rollback-closed');
  assert.deepEqual(history.read(), before);
});

test('a malformed clock rebase fails atomically and branch snapshots never alias callers', () => {
  const { history, seats } = fixture('withdrawal');
  const before = history.read();
  const request = {
    id: id('command', 'rollback'),
    actorId: seats[0]!,
    beforeCommandId: id('command', 'withdraw'),
    branchId: id('branch', 'second'),
    nowMs: 25000,
    resumeClock: true,
    knowledgeWarningAcknowledged: true,
  };
  assert.equal(history.fork(before.head, request).type, 'committed');
  const current = history.read();
  const rebase = current.actions.at(-1)!;
  const broken = {
    ...rebase,
    commandId: id('command', 'bad-rebase'),
    events: [
      {
        id: id('event', 'bad-rebase'),
        event: { type: 'clock-rebased' as const, capturedAtMs: 999, suspended: false },
      },
    ],
  };
  assert.throws(() => history.append(current.head, broken), /rebase/);
  assert.deepEqual(history.read(), current);
  const archive = history.read(before.head.branchId);
  (archive.actions as unknown[]).length = 0;
  (history.audit() as unknown[]).length = 0;
  assert.deepEqual(history.read(before.head.branchId), before);
  assert.equal(history.audit().length, 1);
  assert.deepEqual(history.branches().find((branch) => branch.active)?.parent, {
    ...before.head,
    version: 2,
  });
});

test('a synthetic rollback event cannot duplicate an event identity in the inherited prefix', () => {
  const { history: source, seats } = fixture('withdrawal');
  const history = new MemoryHistory(source.read().head.gameId, id('branch', 'main'));
  for (const [index, action] of source.read().actions.entries()) {
    const changed =
      index === 0
        ? { ...action, events: [{ ...action.events[0]!, id: id('event', 'rollback:rebase') }] }
        : action;
    history.append(history.read().head, changed);
  }
  const before = history.read();
  assert.throws(
    () =>
      history.fork(before.head, {
        id: id('command', 'rollback'),
        actorId: seats[0]!,
        beforeCommandId: id('command', 'withdraw'),
        branchId: id('branch', 'second'),
        nowMs: 25000,
        resumeClock: true,
        knowledgeWarningAcknowledged: true,
      }),
    /event ID/,
  );
  assert.deepEqual(history.read(), before);
  assert.equal(history.branches().length, 1);
  assert.deepEqual(history.audit(), []);
});

test('rollback before an out-of-turn random reinsertion restores the original deck and removes its punishment', () => {
  const { history, seats } = fixture('penalty');
  const abandoned = history.read();
  assert.equal(
    history.fork(abandoned.head, {
      id: id('command', 'undo-random-draw'),
      actorId: seats[0]!,
      beforeCommandId: id('command', 'wrong-draw'),
      branchId: id('branch', 'before-violation'),
      nowMs: 25000,
      resumeClock: true,
      knowledgeWarningAcknowledged: true,
    }).type,
    'committed',
  );
  const state = history.read().state!;
  assert.deepEqual(
    state.deck,
    Array.from({ length: 36 }, (_, index) => id('card', `opaque-${index}`)),
  );
  assert.equal(state.phase.type, 'dealing');
  if (state.phase.type === 'dealing') assert.equal(state.phase.nextSeatId, seats[1]);
  assert.equal(
    state.players.every((player) => player.hand.length === 0 && player.stumps.length === 0),
    true,
  );
  assert.deepEqual(state.pendingPenalties, []);
  assert.equal(state.procedure, null);
  assert.deepEqual(state.automaticIncidents, []);
  assert.deepEqual(history.read(abandoned.head.branchId), abandoned);
});

test('a rollback to empty history still reserves its administrative command identity', () => {
  const { history, seats } = fixture('reveal');
  const creation = history.read().actions[0]!;
  const rollbackId = id('command', 'rollback');
  history.fork(history.read().head, {
    id: rollbackId,
    actorId: seats[0]!,
    beforeCommandId: creation.commandId,
    branchId: id('branch', 'empty'),
    nowMs: 25000,
    resumeClock: true,
    knowledgeWarningAcknowledged: true,
  });
  const result = history.append(history.read().head, {
    ...creation,
    commandId: rollbackId,
    occurredAtMs: 26000,
  });
  assert.equal(result.type, 'rejected');
  if (result.type === 'rejected') assert.equal(result.code, 'command-id-reused');
  assert.equal(history.read().state, null);
});
