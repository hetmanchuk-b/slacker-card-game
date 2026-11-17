import type { ActionBatch, BranchHead } from '../game/contracts.ts';
import type { GameState } from '../game/model.ts';

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
  read(): HistorySnapshot;
  append(expected: BranchHead, action: ActionBatch): AppendResult;
}
