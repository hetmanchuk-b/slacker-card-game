import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { GameId, LobbyId } from '../game/ids.ts';
import { id } from '../game/ids.ts';
import { PostgresLobby } from '../persistence/lobby.ts';
import type { LiveMatch } from '../persistence/lobby.ts';
import type { MatchStart } from '../persistence/lobby-contracts.ts';
import { PostgresSession } from '../persistence/postgres.ts';
import { GameRuntime } from '../runtime/runtime.ts';
import type { RuntimeOptions, RuntimeSnapshot } from '../runtime/runtime.ts';
import { systemInputs } from '../runtime/system.ts';
import type { GuestMembership } from './guest-access.ts';

type Inputs = Omit<RuntimeOptions, 'history' | 'commit' | 'connectedSeatIds'>;
type Entry = LiveMatch & { gameId: GameId; lobbyId: LobbyId; epoch: string };
type Connection = Pick<GuestMembership, 'lobbyId' | 'seatId'>;
export type HostedSnapshot = Readonly<{ epoch: string; snapshot: RuntimeSnapshot }>;
export class GameHostError extends Error {
  constructor(code: 'host-closed' | 'wrong-game' | 'game-unavailable') {
    super(code);
    this.name = 'GameHostError';
  }
}

/** Private local writer registry, NOT an authentication or transport endpoint.
 * Lifecycle operations are serialized; callbacks must not re-enter the host or
 * retain writable runtime/session references. The caller reauthorizes each use.
 */
export class PostgresGameHost {
  readonly #pool: Pool;
  readonly #inputs: (onError: (error: unknown) => void) => Inputs;
  #tail: Promise<void> = Promise.resolve();
  #entries = new Map<GameId, Entry>();
  #connections = new Set<Connection>();
  #closed = false;
  #closing: Promise<void> | null = null;

  constructor(
    pool: Pool,
    options: { inputs?: (onError: (error: unknown) => void) => Inputs } = {},
  ) {
    this.#pool = pool;
    this.#inputs = options.inputs ?? systemInputs;
  }

  read(lobbyId: LobbyId): Promise<HostedSnapshot | null> {
    return this.#enqueue(async () => {
      const entry = await this.#current(lobbyId);
      return entry ? { epoch: entry.epoch, snapshot: entry.runtime.read() } : null;
    });
  }

  /** expectedGameId prevents an old intent from silently reaching a successor.
   * No ordinary-play version/turn gate is added. Raw results remain server-only.
   */
  withCurrent<T>(
    lobbyId: LobbyId,
    expectedGameId: GameId,
    operation: (runtime: GameRuntime, epoch: string) => Promise<T>,
  ): Promise<T> {
    return this.#enqueue(async () => {
      const entry = await this.#current(lobbyId, expectedGameId);
      if (!entry) throw new GameHostError('wrong-game');
      try {
        return await operation(entry.runtime, entry.epoch);
      } catch (error) {
        if (!this.#healthy(entry)) await this.#release(entry, false);
        throw error;
      }
    });
  }

  /** Binding must come from a fresh guest membership check, never a browser.
   * Returned handle belongs to exactly this connection; repeated detach is safe.
   * Lobby-only members are tracked but do not join an existing game's roster.
   */
  attach(binding: GuestMembership, signal?: AbortSignal): Promise<() => Promise<void>> {
    const connection: Connection = { lobbyId: binding.lobbyId, seatId: binding.seatId };
    const expected = binding.currentGameId;
    return this.#enqueue(async () => {
      // Cancellation is checked inside admission, not only by a transport after
      // awaiting its detach handle. Already-admitted atomic commits still drain.
      signal?.throwIfAborted();
      const entry = await this.#current(connection.lobbyId, expected);
      signal?.throwIfAborted();
      this.#connections.add(connection);
      try {
        if (entry) await this.#presence(entry);
      } catch {
        this.#connections.delete(connection);
        if (entry) await this.#release(entry, false);
        throw new GameHostError('game-unavailable');
      }
      return () =>
        this.#enqueue(async () => {
          if (!this.#connections.delete(connection)) return;
          try {
            const current = await this.#current(connection.lobbyId);
            if (current) await this.#presence(current);
          } catch {
            // The departure is real even if routing/storage is unavailable.
            // Never leave an old connected view running after losing the ledger
            // entry; recovery will restore disconnected and reconcile survivors.
            for (const entry of this.#entries.values())
              if (entry.lobbyId === connection.lobbyId) await this.#release(entry, false);
            throw new GameHostError('game-unavailable');
          }
        }, true);
    });
  }

  /** Explicit recovery never reexecutes a failed command. Retry its original ID
   * separately, allowing the recovered durable receipt to settle ambiguity.
   */
  recover(lobbyId: LobbyId): Promise<HostedSnapshot | null> {
    return this.#enqueue(async () => {
      for (const entry of this.#entries.values())
        if (entry.lobbyId === lobbyId) await this.#release(entry, false);
      const entry = await this.#current(lobbyId);
      return entry ? { epoch: entry.epoch, snapshot: entry.runtime.read() } : null;
    });
  }

  /** Trusted canonical start only. Authentication, readiness and browser-intent
   * retry orchestration are separate future adapters. No live references escape.
   */
  startMatch(lobbyId: LobbyId, input: MatchStart) {
    const request = structuredClone(input);
    return this.#enqueue(async () => {
      const lobby = await PostgresLobby.open(this.#pool, lobbyId);
      const current = await this.#current(lobbyId);
      const epoch = randomUUID();
      try {
        const result = await lobby.startMatch(
          request,
          {
            ...this.#runtimeInputs(request.gameId, epoch),
            connectedSeatIds: [],
          },
          current ?? undefined,
        );
        if (result.type !== 'started') return result;
        if (current) await this.#release(current, false);
        const entry: Entry = { ...result, lobbyId, epoch };
        this.#entries.set(result.gameId, entry);
        try {
          await this.#presence(entry);
        } catch {
          await this.#release(entry, false);
          throw new GameHostError('game-unavailable');
        }
        return { type: 'started' as const, gameId: result.gameId };
      } catch {
        if (current && !this.#healthy(current)) await this.#release(current, false);
        throw new GameHostError('game-unavailable');
      }
    });
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = this.#tail.then(async () => {
      let failed = false;
      for (const entry of [...this.#entries.values()]) {
        try {
          await this.#release(entry, true);
        } catch {
          failed = true;
        }
      }
      this.#connections.clear();
      if (failed) throw new GameHostError('game-unavailable');
    });
    this.#tail = this.#closing.catch(() => {});
    return this.#closing;
  }

  #enqueue<T>(operation: () => Promise<T>, detach = false): Promise<T> {
    if (this.#closed)
      return detach
        ? Promise.resolve(undefined as T)
        : Promise.reject(new GameHostError('host-closed'));
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  #runtimeInputs(gameId: GameId, epoch: string): Inputs {
    const check = () => {
      // Do not await this queue from a clock task: a trusted host operation may
      // itself be waiting for that task. Late old tasks cannot evict a new epoch.
      void this.#enqueue(async () => {
        const entry = this.#entries.get(gameId);
        if (entry?.epoch === epoch && !this.#healthy(entry)) await this.#release(entry, false);
      }).catch(() => {});
    };
    const inputs = this.#inputs(check);
    return {
      ...inputs,
      clock: {
        now: () => inputs.clock.now(),
        scheduleAt: (deadline, task) =>
          inputs.clock.scheduleAt(deadline, async () => {
            try {
              await task();
            } finally {
              check();
            }
          }),
      },
    };
  }

  #healthy(entry: Entry): boolean {
    try {
      entry.runtime.read();
      return true;
    } catch {
      return false;
    }
  }

  async #current(lobbyId: LobbyId, expected?: GameId | null): Promise<Entry | null> {
    const lobby = await PostgresLobby.open(this.#pool, lobbyId);
    const { currentGameId } = await lobby.read();
    if (expected !== undefined && currentGameId !== expected) throw new GameHostError('wrong-game');
    for (const [gameId, entry] of this.#entries)
      if (entry.lobbyId === lobbyId && gameId !== currentGameId) await this.#release(entry, false);
    if (!currentGameId) return null;
    const existing = this.#entries.get(currentGameId);
    if (existing) {
      if (existing.lobbyId !== lobbyId) throw new GameHostError('game-unavailable');
      if (this.#healthy(existing)) return existing;
      await this.#release(existing, false);
    }
    let session: PostgresSession | undefined;
    let runtime: GameRuntime | undefined;
    try {
      // Routing is existing-game-only. Never let open() fabricate a missing
      // game using a browser-supplied root branch or discard a durable checkpoint.
      const result = await this.#pool.query<{ root_branch_id: string }>(
        'SELECT root_branch_id FROM penky_game_heads WHERE game_id=$1 AND revision > 0',
        [currentGameId],
      );
      const root = result.rows[0]?.root_branch_id;
      if (!root) throw new GameHostError('game-unavailable');
      session = await PostgresSession.open(this.#pool, currentGameId, id('branch', root));
      const checkpoint = session.checkpoint;
      if (!checkpoint) throw new GameHostError('game-unavailable');
      const epoch = randomUUID();
      runtime = await GameRuntime.restore(
        {
          ...this.#runtimeInputs(currentGameId, epoch),
          history: session.history,
          commit: session.commit,
          connectedSeatIds: [],
        },
        checkpoint,
      );
      const entry: Entry = { session, runtime, gameId: currentGameId, lobbyId, epoch };
      await this.#presence(entry);
      this.#entries.set(currentGameId, entry);
      return entry;
    } catch {
      if (runtime) await runtime.dispose();
      if (session) await session.close();
      // No automatic retry: contention and integrity/storage faults are all safe
      // unavailability. A later request may retry after the lease is released.
      throw new GameHostError('game-unavailable');
    }
  }

  async #presence(entry: Entry): Promise<void> {
    for (const seat of entry.runtime.read().connections) {
      const connected = [...this.#connections].some(
        (connection) => connection.lobbyId === entry.lobbyId && connection.seatId === seat.seatId,
      );
      if (connected === seat.connected) continue;
      const result = await entry.runtime.dispatch({
        type: connected ? 'reconnect' : 'disconnect',
        id: id('command', randomUUID()),
        seatId: seat.seatId,
      });
      if (result.type !== 'accepted') throw new GameHostError('game-unavailable');
    }
  }

  async #release(entry: Entry, save: boolean): Promise<void> {
    if (this.#entries.get(entry.gameId) === entry) this.#entries.delete(entry.gameId);
    try {
      if (save && this.#healthy(entry)) await entry.runtime.checkpoint();
    } finally {
      try {
        await entry.runtime.dispose();
      } finally {
        await entry.session.close();
      }
    }
  }
}
