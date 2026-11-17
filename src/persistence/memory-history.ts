import { applyAction } from '../game/engine.ts';
import { isDeepStrictEqual } from 'node:util';
import { jsonDigest } from './json-digest.ts';
import { validateCache } from './history-cache.ts';
import type { ForkReceipt, HistoryCache, CachedHistory } from './history-cache.ts';
import { id } from '../game/ids.ts';
import type { ActionBatch, BranchHead } from '../game/contracts.ts';
import type { BranchId, CommandId, GameId, SeatId } from '../game/ids.ts';
import type { GameState } from '../game/model.ts';
import type {
  AppendResult,
  BranchInfo,
  ForkRequest,
  ForkResult,
  History,
  HistorySnapshot,
  RollbackAudit,
  RollbackPoint,
} from './history.ts';

export type HistoryOperation =
  | Readonly<{ type: 'append'; expected: BranchHead; action: ActionBatch }>
  | Readonly<{ type: 'fork'; expected: BranchHead; request: ForkRequest }>
  | Readonly<{ type: 'close-rollback' }>;
export type HistoryArchive = Readonly<{
  schemaVersion: 1;
  gameId: GameId;
  rootBranchId: BranchId;
  operations: readonly HistoryOperation[];
}>;

/** Atomic in-memory branch history; server-only and not crash-safe storage. */
export class MemoryHistory implements History {
  #head: BranchHead;
  #rootBranchId: BranchId;
  #operations: HistoryOperation[] = [];
  #actions: ActionBatch[] = [];
  #state: GameState | null = null;
  #ownerId: SeatId | null = null;
  #closedRollback = false;
  #parents = new Map<BranchId, BranchHead | null>();
  #archives = new Map<BranchId, HistorySnapshot>();
  #audit: RollbackAudit[] = [];
  #forkReceipts = new Map<CommandId, ForkReceipt>();

  constructor(gameId: GameId, branchId: BranchId) {
    this.#head = { gameId, branchId, version: 0 };
    this.#rootBranchId = branchId;
    this.#parents.set(branchId, null);
  }

  archive(): HistoryArchive {
    return structuredClone({
      schemaVersion: 1,
      gameId: this.#head.gameId,
      rootBranchId: this.#rootBranchId,
      operations: this.#operations,
    });
  }

  static restore(archive: HistoryArchive): MemoryHistory {
    if (archive.schemaVersion !== 1 || !Array.isArray(archive.operations))
      throw new Error('Unsupported history archive');
    const history = new MemoryHistory(
      id('game', archive.gameId),
      id('branch', archive.rootBranchId),
    );
    history.#replay(archive.operations);
    return history;
  }

  snapshot(): HistoryCache {
    const value: CachedHistory = structuredClone({
      active: this.read(),
      ownerId: this.#ownerId,
      closedRollback: this.#closedRollback,
      parents: [...this.#parents],
      archives: [...this.#archives.values()],
      audit: this.#audit,
      forks: [...this.#forkReceipts.values()],
    });
    return {
      schemaVersion: 1,
      operationCount: this.#operations.length,
      archiveDigest: jsonDigest(this.archive()),
      snapshotDigest: jsonDigest(value),
      value,
    };
  }

  static restoreSnapshot(archive: HistoryArchive, cache: HistoryCache): MemoryHistory {
    const value = validateCache(archive, cache);
    const history = new MemoryHistory(
      id('game', archive.gameId),
      id('branch', archive.rootBranchId),
    );
    history.#head = value.active.head;
    history.#actions = [...value.active.actions];
    history.#state = value.active.state;
    history.#ownerId = value.ownerId;
    history.#closedRollback = value.closedRollback;
    history.#parents = new Map(value.parents);
    history.#archives = new Map(
      value.archives.map((snapshot) => [snapshot.head.branchId, snapshot]),
    );
    history.#audit = [...value.audit];
    history.#forkReceipts = new Map(value.forks.map((receipt) => [receipt.request.id, receipt]));
    history.#operations = structuredClone([...archive.operations.slice(0, cache.operationCount)]);
    history.#replay(archive.operations.slice(cache.operationCount));
    return history;
  }

  #replay(operations: readonly HistoryOperation[]): void {
    for (const operation of operations) {
      switch (operation.type) {
        case 'append':
          if (this.append(operation.expected, operation.action).type !== 'committed')
            throw new Error('Invalid archived append');
          break;
        case 'fork':
          if (this.fork(operation.expected, operation.request).type !== 'committed')
            throw new Error('Invalid archived fork');
          break;
        case 'close-rollback':
          this.closeRollback();
          break;
        default:
          throw new Error('Unknown archived operation');
      }
    }
  }

  read(branchId: BranchId = this.#head.branchId): HistorySnapshot {
    if (branchId !== this.#head.branchId) {
      const stored = this.#archives.get(branchId);
      if (!stored) throw new Error('Unknown history branch');
      return structuredClone(stored);
    }
    return structuredClone({ head: this.#head, actions: this.#actions, state: this.#state });
  }

  branches(): readonly BranchInfo[] {
    return [...this.#parents].map(([branchId, parent]) => ({
      head: this.read(branchId).head,
      parent: structuredClone(parent),
      active: branchId === this.#head.branchId,
    }));
  }

  audit(): readonly RollbackAudit[] {
    return structuredClone(this.#audit);
  }

  /** Trusted host hook: call when the next match starts; never rolled back. */
  closeRollback(): void {
    if (!this.#closedRollback) this.#operations.push({ type: 'close-rollback' });
    this.#closedRollback = true;
  }

  rollbackPoint(beforeCommandId: CommandId): RollbackPoint | null {
    const index = this.#actions.findIndex((action) => action.commandId === beforeCommandId);
    if (index === -1) return null;
    const state = this.#actions
      .slice(0, index)
      .reduce((state, action) => applyAction(state, action), null as GameState | null);
    const action = this.#actions[index]!;
    const rebase = action.events.find((item) => item.event.type === 'clock-rebased')?.event;
    return structuredClone({
      head: { ...this.#head, version: index },
      beforeCommandId,
      atMs: rebase?.type === 'clock-rebased' ? rebase.capturedAtMs : action.occurredAtMs,
      state,
    });
  }

  fork(expected: BranchHead, input: ForkRequest): ForkResult {
    const request = structuredClone(input);
    const reject = (code: Extract<ForkResult, { type: 'rejected' }>['code']): ForkResult => ({
      type: 'rejected',
      code,
      head: { ...this.#head },
    });
    if (request.actorId !== this.#ownerId) return reject('owner-only');
    const cached = this.#forkReceipts.get(request.id);
    if (cached)
      return isDeepStrictEqual(cached.expected, expected) &&
        isDeepStrictEqual(cached.request, request)
        ? { type: 'duplicate', head: { ...cached.head } }
        : reject('command-id-reused');
    if (this.#closedRollback) return reject('rollback-closed');
    if (expected.gameId !== this.#head.gameId || expected.branchId !== this.#head.branchId)
      return reject('wrong-branch');
    if (expected.version !== this.#head.version) return reject('version-conflict');
    if (request.knowledgeWarningAcknowledged !== true) return reject('warning-required');
    if (this.#parents.has(request.branchId)) return reject('branch-exists');
    if (this.#actions.some((action) => action.commandId === request.id))
      return reject('command-id-reused');
    if (
      !Number.isSafeInteger(request.nowMs) ||
      request.nowMs < (this.#actions.at(-1)?.occurredAtMs ?? 0)
    )
      return reject('invalid-time');
    const point = this.rollbackPoint(request.beforeCommandId);
    if (!point) return reject('unknown-target');
    const actions = this.#actions.slice(0, point.head.version);
    let state = point.state;
    if (state !== null) {
      const rebase: ActionBatch = {
        commandId: request.id,
        occurredAtMs: request.nowMs,
        events: [
          {
            id: id('event', `${request.id}:rebase`),
            event: {
              type: 'clock-rebased',
              capturedAtMs: point.atMs,
              suspended: !request.resumeClock,
            },
          },
        ],
      };
      if (
        actions.some((action) => action.events.some((event) => event.id === rebase.events[0]!.id))
      )
        throw new Error('Duplicate event ID across actions');
      state = applyAction(state, rebase);
      actions.push(rebase);
    }
    const head = { ...point.head, branchId: request.branchId, version: actions.length };
    const audit: RollbackAudit = {
      commandId: request.id,
      actorId: request.actorId,
      beforeCommandId: request.beforeCommandId,
      atMs: request.nowMs,
      abandonedHead: { ...this.#head },
      parent: point.head,
      head,
      knowledgeWarningAcknowledged: true,
    };
    // Build and validate everything before publishing any branch mutation.
    this.#archives.set(this.#head.branchId, this.read());
    this.#parents.set(request.branchId, point.head);
    this.#actions = actions;
    this.#state = state;
    this.#head = head;
    this.#audit.push(audit);
    this.#forkReceipts.set(request.id, { expected: { ...expected }, request, head });
    this.#operations.push(structuredClone({ type: 'fork', expected, request }));
    return { type: 'committed', head: { ...head } };
  }

  append(expected: BranchHead, action: ActionBatch): AppendResult {
    if (expected.gameId !== this.#head.gameId || expected.branchId !== this.#head.branchId) {
      return { type: 'rejected', code: 'wrong-branch', head: { ...this.#head } };
    }
    const priorIndex = this.#actions.findIndex((item) => item.commandId === action.commandId);
    if (priorIndex !== -1) {
      if (!isDeepStrictEqual(this.#actions[priorIndex], action)) {
        return { type: 'rejected', code: 'command-id-reused', head: { ...this.#head } };
      }
      return { type: 'duplicate', head: { ...this.#head, version: priorIndex + 1 } };
    }
    if (this.#forkReceipts.has(action.commandId)) {
      return { type: 'rejected', code: 'command-id-reused', head: { ...this.#head } };
    }
    if (expected.version !== this.#head.version) {
      return { type: 'rejected', code: 'version-conflict', head: { ...this.#head } };
    }
    const last = this.#actions.at(-1);
    if (last !== undefined && action.occurredAtMs < last.occurredAtMs) {
      throw new Error('Actions must be chronological');
    }
    const knownEventIds = new Set(
      this.#actions.flatMap((item) => item.events.map((event) => event.id)),
    );
    if (action.events.some((event) => knownEventIds.has(event.id))) {
      throw new Error('Duplicate event ID across actions');
    }
    const recorded = structuredClone(action);
    const next = applyAction(this.#state, recorded);
    if (next.gameId !== this.#head.gameId) throw new Error('Action belongs to another game');
    if (this.#ownerId !== null && next.ownerId !== this.#ownerId)
      throw new Error('Game owner cannot change');
    // All validation happens before any stored state changes.
    this.#actions.push(recorded);
    this.#state = next;
    this.#ownerId = next.ownerId;
    this.#operations.push(structuredClone({ type: 'append', expected, action: recorded }));
    this.#head = { ...this.#head, version: this.#head.version + 1 };
    return { type: 'committed', head: { ...this.#head } };
  }
}
