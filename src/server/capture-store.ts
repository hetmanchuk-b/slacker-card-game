import { isDeepStrictEqual } from 'node:util';
import type { GameId } from '../game/ids.ts';
import type { BranchHead } from '../game/contracts.ts';
import type { GameState } from '../game/model.ts';
import type { RollbackNotice } from '../projections/history.ts';
import type { RuntimePublication } from '../runtime/runtime.ts';

// Provisional logical payload quotas, NOT a V8/native/RSS ceiling. Runtime's
// existing clone/freeze and detached legacy consumers are outside this ledger.
export const CAPTURE_LIMITS = Object.freeze({
  publicationBytes: 2 * 1024 * 1024,
  gameBytes: 8 * 1024 * 1024,
  globalBytes: 64 * 1024 * 1024,
  games: 8,
  publicationsPerGame: 64,
  handles: 2048,
});
type Limits = { [Key in keyof typeof CAPTURE_LIMITS]: number };
type Root = { state: GameState | null; bytes: number; refs: number };
type Game = { bytes: number; publications: number };
type RecordEntry = {
  value: Readonly<{ epoch: string; publication: RuntimePublication; rollback?: RollbackNotice }>;
  bytes: number;
  metadataBytes: number;
  roots: Map<string, Root>;
  refs: number;
};
export type CaptureHandle = Readonly<{
  value: RecordEntry['value'];
  bytes: number;
  retain: () => CaptureHandle;
  release: () => void;
}>;
export type CaptureWriter = Readonly<{
  capture: (publication: RuntimePublication, rollback?: RollbackNotice) => CaptureHandle;
}>;
function unavailable(): never {
  throw new Error('Capture unavailable');
}

// Each root is traversed once for its cached conservative weight. Aliases within
// a root count once; shared descendants across distinct roots count again.
// Metadata is sized separately, with all state slots replaced by null.
function weight(value: unknown, limit: number): number {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  let bytes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (item === null || item === undefined) bytes += 8;
    else if (typeof item === 'string') bytes += 24 + item.length * 2;
    else if (typeof item === 'number' || typeof item === 'boolean') bytes += 8;
    else if (typeof item === 'object') {
      if (seen.has(item)) continue;
      if (!Object.isFrozen(item)) unavailable();
      seen.add(item);
      bytes += 64;
      for (const key of Object.keys(item)) {
        bytes += 32 + key.length * 2;
        // Abort while enumerating too, before accumulating a huge work list.
        if (bytes > limit) unavailable();
        pending.push((item as Record<string, unknown>)[key]);
      }
    } else unavailable();
    if (bytes > limit) unavailable();
  }
  return bytes;
}

/** Entry-owned trusted seam. A writer capability must be created only for a
 * live committed runtime/epoch, never from browser-supplied provenance. There
 * is no cross-writer cache, and the registry has no roots without live handles.
 */
export class CaptureStore {
  readonly #limits: Limits;
  readonly #games = new Map<GameId, Game>();
  #bytes = 0;
  #roots = 0;
  #publications = 0;
  #handles = 0;
  #constructing = 0;
  constructor(limits: Partial<Limits> = {}) {
    this.#limits = { ...CAPTURE_LIMITS, ...limits };
  }
  stats() {
    return {
      bytes: this.#bytes,
      roots: this.#roots,
      publications: this.#publications,
      handles: this.#handles,
      games: this.#games.size,
      constructing: this.#constructing,
    };
  }
  writer(epoch: string, gameId: GameId): CaptureWriter {
    const registry = new Map<string, Root>();
    return Object.freeze({
      capture: (publication: RuntimePublication, rollback?: RollbackNotice) => {
        const limits = this.#limits;
        const game = this.#games.get(gameId);
        // Reserve one synchronous construction allowance before making wrappers.
        // No pending raw-source queue: refusal retains nothing. Upstream runtime
        // clone/freeze is unchanged; scheduled construction is a later increment.
        if (
          this.#constructing ||
          this.#handles >= limits.handles ||
          (!game && this.#games.size >= limits.games) ||
          (game?.publications ?? 0) >= limits.publicationsPerGame
        )
          unavailable();
        // The reservation is capped by remaining budgets; final exact accounting
        // below may use existing roots rather than spending the full allowance.
        const allowance = Math.min(
          limits.publicationBytes,
          limits.globalBytes - this.#bytes,
          limits.gameBytes - (game?.bytes ?? 0),
        );
        if (allowance <= 0) unavailable();
        this.#constructing++;
        try {
          if (!Object.isFrozen(publication) || !Object.isFrozen(publication.snapshot))
            unavailable();
          const roots = new Map<string, Root>();
          const canonical = (head: BranchHead, state: GameState | null) => {
            if (
              head.gameId !== gameId ||
              !Number.isSafeInteger(head.version) ||
              head.version < 0 ||
              (state !== null && state.gameId !== gameId)
            )
              unavailable();
            const key = JSON.stringify([head.branchId, head.version]);
            let root = roots.get(key) ?? registry.get(key);
            if (root) {
              if (!isDeepStrictEqual(root.state, state)) unavailable();
            } else root = { state, bytes: weight(state, limits.publicationBytes), refs: 0 };
            roots.set(key, root);
            return root.state;
          };
          const actions = Object.freeze(
            publication.actions.map((pair) =>
              Object.freeze({
                ...pair,
                before: Object.freeze({
                  ...pair.before,
                  state: canonical(pair.before.head, pair.before.state),
                }),
                after: Object.freeze({
                  ...pair.after,
                  state: canonical(pair.after.head, pair.after.state),
                }),
              }),
            ),
          );
          const state = canonical(publication.snapshot.head, publication.snapshot.state);
          const snapshot =
            state === publication.snapshot.state
              ? publication.snapshot
              : Object.freeze({ ...publication.snapshot, state });
          const owned = Object.freeze({ ...publication, actions, snapshot });
          const metadata = Object.freeze({
            epoch,
            publication: Object.freeze({
              ...publication,
              snapshot: Object.freeze({ ...snapshot, state: null }),
              actions: Object.freeze(
                actions.map((pair) =>
                  Object.freeze({
                    ...pair,
                    before: Object.freeze({ ...pair.before, state: null }),
                    after: Object.freeze({ ...pair.after, state: null }),
                  }),
                ),
              ),
            }),
            ...(rollback ? { rollback } : {}),
          });
          const metadataBytes = weight(metadata, limits.publicationBytes);
          const bytes =
            metadataBytes + [...roots.values()].reduce((sum, root) => sum + root.bytes, 0);
          const added =
            metadataBytes +
            [...roots.values()]
              .filter((root) => root.refs === 0)
              .reduce((sum, root) => sum + root.bytes, 0);
          if (bytes > limits.publicationBytes || added > allowance) unavailable();
          const entry: RecordEntry = {
            value: Object.freeze({ epoch, publication: owned, ...(rollback ? { rollback } : {}) }),
            bytes,
            metadataBytes,
            roots,
            refs: 0,
          };
          const retainedGame = game ?? { bytes: 0, publications: 0 };
          this.#games.set(gameId, retainedGame);
          retainedGame.bytes += added;
          retainedGame.publications++;
          this.#bytes += added;
          this.#publications++;
          for (const [key, root] of roots) {
            if (!root.refs) {
              registry.set(key, root);
              this.#roots++;
            }
            root.refs++;
          }
          return this.#handle(entry, registry, gameId);
        } finally {
          this.#constructing--;
        }
      },
    });
  }
  #handle(entry: RecordEntry, registry: Map<string, Root>, gameId: GameId): CaptureHandle {
    if (this.#handles >= this.#limits.handles) unavailable();
    this.#handles++;
    entry.refs++;
    let held: RecordEntry | null = entry;
    return Object.freeze({
      get value() {
        return (held ?? unavailable()).value;
      },
      get bytes() {
        return (held ?? unavailable()).bytes;
      },
      retain: () => this.#handle(held ?? unavailable(), registry, gameId),
      release: () => {
        if (!held) return;
        const current = held;
        held = null;
        this.#handles--;
        if (--current.refs) return;
        let removed = current.metadataBytes;
        for (const [key, root] of current.roots)
          if (--root.refs === 0) {
            registry.delete(key);
            this.#roots--;
            removed += root.bytes;
          }
        const game = this.#games.get(gameId)!;
        game.bytes -= removed;
        game.publications--;
        if (!game.publications) this.#games.delete(gameId);
        this.#bytes -= removed;
        this.#publications--;
      },
    });
  }
}
