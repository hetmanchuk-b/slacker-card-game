import { isDeepStrictEqual } from 'node:util';
import { validateState } from '../game/engine.ts';
import type { BranchHead } from '../game/contracts.ts';
import type { BranchId, SeatId } from '../game/ids.ts';
import type { ForkRequest, HistorySnapshot, RollbackAudit } from './history.ts';
import type { HistoryArchive } from './memory-history.ts';
import { jsonDigest } from './json-digest.ts';

export type ForkReceipt = Readonly<{
  expected: BranchHead;
  request: ForkRequest;
  head: BranchHead;
}>;
export type CachedHistory = Readonly<{
  active: HistorySnapshot;
  ownerId: SeatId | null;
  closedRollback: boolean;
  parents: readonly (readonly [BranchId, BranchHead | null])[];
  archives: readonly HistorySnapshot[];
  audit: readonly RollbackAudit[];
  forks: readonly ForkReceipt[];
}>;
export type HistoryCache = Readonly<{
  schemaVersion: 1;
  operationCount: number;
  archiveDigest: string;
  snapshotDigest: string;
  value: CachedHistory;
}>;

/** Internal cache validation; the public seams are MemoryHistory and PostgresSession. */
export function validateCache(archive: HistoryArchive, cache: HistoryCache): CachedHistory {
  if (
    archive.schemaVersion !== 1 ||
    cache.schemaVersion !== 1 ||
    !Array.isArray(archive.operations) ||
    !Number.isSafeInteger(cache.operationCount) ||
    cache.operationCount < 0 ||
    cache.operationCount > archive.operations.length
  )
    throw new Error('Unsupported history snapshot');
  const prefix = { ...archive, operations: archive.operations.slice(0, cache.operationCount) };
  if (
    jsonDigest(prefix) !== cache.archiveDigest ||
    jsonDigest(cache.value) !== cache.snapshotDigest
  )
    throw new Error('History snapshot integrity mismatch');
  const value = structuredClone(cache.value);
  const snapshots = [value.active, ...value.archives];
  const byBranch = new Map(snapshots.map((snapshot) => [snapshot.head.branchId, snapshot]));
  const parents = new Map(value.parents);
  if (
    byBranch.size !== snapshots.length ||
    parents.size !== value.parents.length ||
    parents.size !== snapshots.length ||
    parents.get(archive.rootBranchId) !== null ||
    parents.size !== value.audit.length + 1 ||
    value.audit.length !== value.forks.length
  )
    throw new Error('Invalid snapshot branch index');
  const creations = prefix.operations
    .flatMap((operation) => (operation.type === 'append' ? operation.action.events : []))
    .filter((envelope) => envelope.event.type === 'game-started');
  const initial = creations[0]?.event;
  const owner = initial?.type === 'game-started' ? initial.ownerId : null;
  if (
    value.ownerId !== owner ||
    typeof value.closedRollback !== 'boolean' ||
    value.closedRollback !==
      prefix.operations.some((operation) => operation.type === 'close-rollback')
  )
    throw new Error('Invalid snapshot ownership or closure');
  for (const snapshot of snapshots) {
    const { head, state, actions } = snapshot;
    const parent = parents.get(head.branchId);
    if (
      head.gameId !== archive.gameId ||
      !Number.isSafeInteger(head.version) ||
      head.version !== actions.length ||
      parent === undefined ||
      (head.branchId !== archive.rootBranchId && parent === null) ||
      (state === null
        ? actions.length !== 0
        : actions.length === 0 ||
          state.schemaVersion !== 1 ||
          state.gameId !== archive.gameId ||
          state.ownerId !== owner ||
          validateState(state).length !== 0)
    )
      throw new Error('Invalid snapshot state or head');
    if (
      parent !== null &&
      (parent.gameId !== archive.gameId ||
        !Number.isSafeInteger(parent.version) ||
        parent.version < 0 ||
        !byBranch.has(parent.branchId) ||
        parent.version > byBranch.get(parent.branchId)!.head.version)
    )
      throw new Error('Invalid snapshot ancestry');
    if (
      new Set(actions.map((action) => action.commandId)).size !== actions.length ||
      new Set(actions.flatMap((action) => action.events.map((event) => event.id))).size !==
        actions.reduce((n, action) => n + action.events.length, 0) ||
      actions.some(
        (action, index) =>
          action.events.length === 0 ||
          !Number.isSafeInteger(action.occurredAtMs) ||
          action.occurredAtMs < (actions[index - 1]?.occurredAtMs ?? 0),
      )
    )
      throw new Error('Invalid snapshot action index');
  }
  const forks = prefix.operations.filter((operation) => operation.type === 'fork');
  if (
    forks.length !== value.forks.length ||
    new Set(value.forks.map((receipt) => receipt.request.id)).size !== forks.length
  )
    throw new Error('Invalid snapshot fork index');
  for (const [index, receipt] of value.forks.entries()) {
    const audit = value.audit[index]!;
    const operation = forks[index]!;
    if (
      !isDeepStrictEqual(receipt.expected, operation.expected) ||
      !isDeepStrictEqual(receipt.request, operation.request) ||
      !isDeepStrictEqual(receipt.head, audit.head) ||
      !isDeepStrictEqual(receipt.expected, audit.abandonedHead) ||
      receipt.request.id !== audit.commandId ||
      receipt.request.actorId !== owner ||
      audit.actorId !== owner ||
      receipt.request.beforeCommandId !== audit.beforeCommandId ||
      receipt.request.nowMs !== audit.atMs ||
      receipt.request.branchId !== audit.head.branchId ||
      audit.knowledgeWarningAcknowledged !== true ||
      !isDeepStrictEqual(parents.get(audit.head.branchId), audit.parent) ||
      !isDeepStrictEqual(byBranch.get(audit.abandonedHead.branchId)?.head, audit.abandonedHead)
    )
      throw new Error('Invalid snapshot rollback metadata');
  }
  if (value.active.head.branchId !== (forks.at(-1)?.request.branchId ?? archive.rootBranchId))
    throw new Error('Invalid snapshot active branch');
  return value;
}
