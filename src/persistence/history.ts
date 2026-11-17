import type { ActionBatch, BranchHead } from '../game/contracts.ts';
import type { GameState } from '../game/model.ts';
import type { BranchId, CommandId, SeatId } from '../game/ids.ts';

export type RollbackPoint = Readonly<{
  head: BranchHead;
  beforeCommandId: CommandId;
  atMs: number;
  state: GameState | null;
}>;
export type ForkRequest = Readonly<{
  id: CommandId;
  actorId: SeatId;
  beforeCommandId: CommandId;
  branchId: BranchId;
  nowMs: number;
  resumeClock: boolean;
  knowledgeWarningAcknowledged: boolean;
}>;
export type ForkResult =
  | Readonly<{ type: 'committed' | 'duplicate'; head: BranchHead }>
  | Readonly<{
      type: 'rejected';
      code:
        | 'wrong-branch'
        | 'version-conflict'
        | 'command-id-reused'
        | 'owner-only'
        | 'warning-required'
        | 'unknown-target'
        | 'branch-exists'
        | 'rollback-closed'
        | 'invalid-time';
      head: BranchHead;
    }>;
export type BranchInfo = Readonly<{
  head: BranchHead;
  parent: BranchHead | null;
  active: boolean;
}>;
export type RollbackAudit = Readonly<{
  commandId: CommandId;
  actorId: SeatId;
  beforeCommandId: CommandId;
  atMs: number;
  abandonedHead: BranchHead;
  parent: BranchHead;
  head: BranchHead;
  knowledgeWarningAcknowledged: true;
}>;

/** Private storage interface; never expose these snapshots directly to clients. */
export type HistorySnapshot = Readonly<{
  head: BranchHead;
  actions: readonly ActionBatch[];
  state: GameState | null;
}>;

export type AppendResult =
  | Readonly<{ type: 'committed' | 'duplicate'; head: BranchHead }>
  | Readonly<{
      type: 'rejected';
      code: 'wrong-branch' | 'version-conflict' | 'command-id-reused';
      head: BranchHead;
    }>;

export interface History {
  read(branchId?: BranchId): HistorySnapshot;
  append(expected: BranchHead, action: ActionBatch): AppendResult;
  rollbackPoint(beforeCommandId: CommandId): RollbackPoint | null;
  fork(expected: BranchHead, request: ForkRequest): ForkResult;
  branches(): readonly BranchInfo[];
  audit(): readonly RollbackAudit[];
  closeRollback(): void;
}
