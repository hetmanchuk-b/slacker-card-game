import { applyAction } from '../game/engine.ts';
import type { ActionBatch, BranchHead } from '../game/contracts.ts';
import type { BranchId, GameId } from '../game/ids.ts';
import type { GameState } from '../game/model.ts';
import type { AppendResult, History, HistorySnapshot } from './history.ts';

/** Single-branch adapter for the initial runtime. Durable forks arrive in Stage 7. */
export class MemoryHistory implements History {
  #head: BranchHead;
  #actions: ActionBatch[] = [];
  #state: GameState | null = null;

  constructor(gameId: GameId, branchId: BranchId) {
    this.#head = { gameId, branchId, version: 0 };
  }

  read(): HistorySnapshot {
    return structuredClone({ head: this.#head, actions: this.#actions, state: this.#state });
  }

  append(expected: BranchHead, action: ActionBatch): AppendResult {
    if (expected.gameId !== this.#head.gameId || expected.branchId !== this.#head.branchId) {
      return { type: 'rejected', code: 'wrong-branch', head: { ...this.#head } };
    }
    const priorIndex = this.#actions.findIndex((item) => item.commandId === action.commandId);
    if (priorIndex !== -1) {
      if (JSON.stringify(this.#actions[priorIndex]) !== JSON.stringify(action)) {
        return { type: 'rejected', code: 'command-id-reused', head: { ...this.#head } };
      }
      return { type: 'duplicate', head: { ...this.#head, version: priorIndex + 1 } };
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
    // All validation happens before any stored state changes.
    this.#actions.push(recorded);
    this.#state = next;
    this.#head = { ...this.#head, version: this.#head.version + 1 };
    return { type: 'committed', head: { ...this.#head } };
  }
}
