import { CaptureStore } from './capture-store.ts';
import type { CaptureHandle, CaptureWriter } from './capture-store.ts';
import { startBotRunner } from '../bots/runner.ts';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import type { GameId, LobbyId } from '../game/ids.ts';
import { id } from '../game/ids.ts';
import { admitChat, PostgresLobby } from '../persistence/lobby.ts';
import type {
  ChatAdmissionOptions,
  MatchStartOutcome,
  StartAdmissionOptions,
} from '../persistence/lobby.ts';
import type { ChatInput, ChatMessage } from '../persistence/lobby-contracts.ts';
import type { LiveMatch } from '../persistence/lobby.ts';
import type { MatchStart } from '../persistence/lobby-contracts.ts';
import { PostgresSession } from '../persistence/postgres.ts';
import { GameRuntime } from '../runtime/runtime.ts';
import type {
  ClaimRequest,
  DispatchOptions,
  RuntimeOptions,
  RuntimeSnapshot,
  RuntimePublication,
} from '../runtime/runtime.ts';
import { resolveClaimEvidence } from './claim-evidence.ts';
import { systemInputs } from '../runtime/system.ts';
import type { GuestMembership } from './guest-access.ts';
import { RuntimeAdmissionError } from '../runtime/runtime.ts';
import type { RollbackCommand, RuntimeResult } from '../runtime/runtime.ts';
import type { HistoryHead, OwnerHistoryInput, RollbackNotice } from '../projections/history.ts';
import { projectRollbackNotice } from '../projections/history.ts';

export type OwnerRollbackRequest = Readonly<{
  id: RollbackCommand['id'];
  actorId: RollbackCommand['actorId'];
  target: Readonly<{ expected: HistoryHead; beforeActionVersion: number }>;
  knowledgeWarningAcknowledged: boolean;
}>;

const hostedCaptures = new CaptureStore();

type Inputs = Omit<RuntimeOptions, 'history' | 'commit' | 'connectedSeatIds'>;
type Entry = LiveMatch & {
  gameId: GameId;
  lobbyId: LobbyId;
  epoch: string;
  stopBots?: () => void;
  stopCapture?: () => void;
  capture?: CaptureHandle;
  captureWriter?: CaptureWriter;
};
type Connection = Pick<GuestMembership, 'lobbyId' | 'seatId'>;
export type HostedSnapshot = Readonly<{ epoch: string; snapshot: RuntimeSnapshot }>;
/** Private committed stream/lifecycle seam, never a network payload. */
export type HostPublication =
  | Readonly<{
      type: 'publication';
      epoch: string;
      publication: RuntimePublication;
      rollback?: RollbackNotice;
      /** Borrowed for this callback only; retain synchronously for async work. */
      capture?: CaptureHandle;
    }>
  | Readonly<{ type: 'invalidated'; epoch: string }>;
type Observer = {
  active: boolean;
  epoch: string | null;
  shared: boolean;
  receive: (notice: HostPublication) => void | Promise<void>;
  report: (() => void) | undefined;
};
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
  readonly #captures: CaptureStore;
  readonly #inputs: (onError: (error: unknown) => void) => Inputs;
  #tail: Promise<void> = Promise.resolve();
  #entries = new Map<GameId, Entry>();
  #connections = new Set<Connection>();
  #observers = new Map<LobbyId, Set<Observer>>();
  #closed = false;
  #closing: Promise<void> | null = null;

  constructor(
    pool: Pool,
    options: {
      inputs?: (onError: (error: unknown) => void) => Inputs;
      captures?: CaptureStore;
    } = {},
  ) {
    this.#pool = pool;
    this.#captures = options.captures ?? hostedCaptures;
    this.#inputs = options.inputs ?? systemInputs;
  }

  read(lobbyId: LobbyId): Promise<HostedSnapshot | null> {
    return this.#enqueue(async () => {
      const entry = await this.#current(lobbyId);
      return entry ? { epoch: entry.epoch, snapshot: entry.runtime.read() } : null;
    });
  }

  /** Observer lifetime follows committed live writers, not prepared successors.
   * Callbacks must return promptly; delivery promises are never awaited.
   */
  subscribe(
    lobbyId: LobbyId,
    receive: Observer['receive'],
    report?: () => void,
    expectedGameId?: GameId,
  ): Promise<() => void> {
    return this.#subscribe(lobbyId, receive, report, expectedGameId, false);
  }

  /** Trusted immutable capture handles; never a viewer payload. */
  subscribeCommittedCapture(
    lobbyId: LobbyId,
    receive: Observer['receive'],
    report?: () => void,
    expectedGameId?: GameId,
  ): Promise<() => void> {
    return this.#subscribe(lobbyId, receive, report, expectedGameId, true);
  }

  #subscribe(
    lobbyId: LobbyId,
    receive: Observer['receive'],
    report: (() => void) | undefined,
    expectedGameId: GameId | undefined,
    shared: boolean,
  ): Promise<() => void> {
    return this.#enqueue(async () => {
      const entry = await this.#current(lobbyId, expectedGameId);
      const observer: Observer = { active: true, epoch: null, shared, receive, report };
      const observers = this.#observers.get(lobbyId) ?? new Set<Observer>();
      this.#observers.set(lobbyId, observers);
      observers.add(observer);
      const stop = () => {
        if (!observer.active) return;
        observer.active = false;
        observer.epoch = null;
        observers.delete(observer);
        if (!observers.size) {
          this.#observers.delete(lobbyId);
          for (const current of this.#entries.values())
            if (current.lobbyId === lobbyId) {
              current.capture?.release();
              delete current.capture;
            }
        }
      };
      try {
        if (entry) await this.#bind(observer, entry);
      } catch (error) {
        stop();
        throw error;
      }
      return stop;
    });
  }

  #report(observer: Observer): void {
    try {
      void Promise.resolve(observer.report?.()).catch(() => {});
    } catch {
      /* isolated */
    }
  }

  #notify(observer: Observer, notice: HostPublication): void {
    if (!observer.active) return;
    const report = () => this.#report(observer);
    try {
      void Promise.resolve(
        observer.receive(
          observer.shared
            ? notice
            : structuredClone(
                notice.type === 'publication'
                  ? {
                      type: notice.type,
                      epoch: notice.epoch,
                      publication: notice.publication,
                      ...(notice.rollback ? { rollback: notice.rollback } : {}),
                    }
                  : notice,
              ),
        ),
      ).catch(report);
    } catch {
      report();
    }
  }

  #baseline(publication: RuntimePublication, nowMs = publication.nowMs): RuntimePublication {
    return Object.freeze({ ...publication, kind: 'initial', nowMs, actions: Object.freeze([]) });
  }

  #dropCapture(entry: Entry): void {
    entry.capture?.release();
    delete entry.capture;
  }

  async #ownCapture(entry: Entry): Promise<void> {
    entry.captureWriter = this.#captures.writer(entry.epoch, entry.gameId);
    entry.stopCapture = await entry.runtime.subscribeCommittedCapture(
      (publication) => {
        if (this.#entries.get(entry.gameId) !== entry || !this.#observers.get(entry.lobbyId)?.size)
          return;
        let full: CaptureHandle | undefined;
        let owner: CaptureHandle | undefined;
        try {
          const rollback =
            publication.kind === 'rollback'
              ? projectRollbackNotice(this.#history(entry))
              : undefined;
          if (rollback) {
            Object.freeze(rollback.target.expected);
            Object.freeze(rollback.target);
            Object.freeze(rollback.head);
            Object.freeze(rollback);
          }
          full = entry.captureWriter!.capture(publication, rollback);
          owner = entry.captureWriter!.capture(this.#baseline(full.value.publication));
          this.#dropCapture(entry);
          entry.capture = owner;
          owner = undefined;
          const notice: HostPublication = Object.freeze({
            type: 'publication',
            ...full.value,
            capture: full,
          });
          for (const observer of [...(this.#observers.get(entry.lobbyId) ?? [])])
            if (observer.epoch === entry.epoch) this.#notify(observer, notice);
        } catch {
          // Delivery admission is not a failed authoritative commit. Never keep
          // a stale baseline or propagate store pressure into the writer queue.
          this.#dropCapture(entry);
          for (const observer of [...(this.#observers.get(entry.lobbyId) ?? [])])
            if (observer.epoch === entry.epoch) this.#report(observer);
        } finally {
          owner?.release();
          full?.release();
          if (!this.#observers.get(entry.lobbyId)?.size) this.#dropCapture(entry);
        }
      },
      () => {
        if (this.#entries.get(entry.gameId) !== entry) return;
        this.#dropCapture(entry);
        for (const observer of [...(this.#observers.get(entry.lobbyId) ?? [])])
          if (observer.epoch === entry.epoch) this.#report(observer);
      },
    );
  }

  async #bind(observer: Observer, entry: Entry): Promise<void> {
    if (!entry.capture) {
      // Registration must be outside observe: both serialize on the same queue.
      // This temporary listener only installs its action-free baseline. A later
      // committed update must never be replaced by an older baseline.
      const stop = await entry.runtime.subscribeCommittedCapture((publication) => {
        if (
          publication.kind !== 'initial' ||
          !observer.active ||
          this.#entries.get(entry.gameId) !== entry ||
          entry.capture
        )
          return;
        try {
          entry.capture = entry.captureWriter!.capture(publication);
        } catch {
          /* fail closed below */
        }
      });
      stop();
    }
    await entry.runtime.observe(async (_snapshot, nowMs) => {
      if (!observer.active || this.#entries.get(entry.gameId) !== entry) return;
      if (!entry.capture) throw new GameHostError('game-unavailable');
      const baseline = entry.captureWriter!.capture(
        this.#baseline(entry.capture.value.publication, nowMs),
      );
      try {
        observer.epoch = entry.epoch;
        this.#notify(
          observer,
          Object.freeze({ type: 'publication', ...baseline.value, capture: baseline }),
        );
      } finally {
        baseline.release();
      }
    });
  }

  async #bindObservers(entry: Entry): Promise<void> {
    await this.#ownCapture(entry);
    for (const observer of [...(this.#observers.get(entry.lobbyId) ?? [])])
      if (observer.active) {
        try {
          await this.#bind(observer, entry);
        } catch (error) {
          if (!this.#healthy(entry)) throw error;
          this.#report(observer);
        }
      }
  }

  /** expectedGameId prevents an old intent from silently reaching a successor.
   * No ordinary-play version/turn gate is added. Raw results remain server-only.
   */
  withCurrent<T>(
    lobbyId: LobbyId,
    expectedGameId: GameId,
    operation: (runtime: GameRuntime, epoch: string) => Promise<T>,
  ): Promise<T> {
    return this.#withEntry(lobbyId, expectedGameId, (entry) =>
      operation(entry.runtime, entry.epoch),
    );
  }

  #withEntry<T>(
    lobbyId: LobbyId,
    expectedGameId: GameId,
    operation: (entry: Entry) => Promise<T>,
  ): Promise<T> {
    return this.#enqueue(async () => {
      const entry = await this.#current(lobbyId, expectedGameId);
      if (!entry) throw new GameHostError('wrong-game');
      try {
        return await operation(entry);
      } catch (error) {
        if (!this.#healthy(entry)) await this.#release(entry, false);
        throw error;
      }
    });
  }

  /** Only call from a runtime observation or synchronous committed publication.
   * A matching head alone does not prove the staging history is committed.
   */
  #history(entry: Entry): OwnerHistoryInput {
    entry.runtime.read(); // Reject a faulted draft, including a failed same-head closure.
    const value = entry.session.history.snapshot().value;
    const branch = ({ head, actions }: OwnerHistoryInput['active']) => ({ head, actions });
    return {
      active: branch(value.active),
      archives: value.archives.map(branch),
      parents: value.parents,
      ownerId: value.ownerId,
      closedRollback: value.closedRollback,
      audit: value.audit,
    };
  }

  /** Bounded server callback under a committed read-only queue point. Never
   * re-enter host/runtime queues or await network delivery from the callback.
   */
  observeHistory<T>(
    lobbyId: LobbyId,
    gameId: GameId,
    operation: (capture: OwnerHistoryInput, epoch: string) => Promise<T>,
  ): Promise<T> {
    return this.#withEntry(lobbyId, gameId, (entry) =>
      entry.runtime.observe(async () => operation(this.#history(entry), entry.epoch)),
    );
  }

  rollback(
    lobbyId: LobbyId,
    gameId: GameId,
    request: OwnerRollbackRequest,
    options: DispatchOptions = {},
  ): Promise<RuntimeResult> {
    const input = structuredClone(request);
    return this.#withEntry(lobbyId, gameId, async (entry) => {
      const resolved = await entry.runtime.observe(
        async (snapshot): Promise<RollbackCommand | RuntimeResult> => {
          const capture = this.#history(entry);
          if (capture.ownerId !== input.actorId) throw new RuntimeAdmissionError();
          const expected = input.target.expected;
          const branchId = capture.parents[expected.branch - 1]?.[0];
          const source = [capture.active, ...capture.archives].find(
            (branch) => branch.head.branchId === branchId,
          );
          const action = source?.actions[input.target.beforeActionVersion - 1];
          if (
            expected.gameId !== gameId ||
            !source ||
            !action ||
            input.target.beforeActionVersion < 1 ||
            input.target.beforeActionVersion > expected.version ||
            expected.version > source.head.version
          )
            return { type: 'rejected', code: 'unknown-target', head: snapshot.head };
          // Retained source branches also reconstruct accepted retry identity.
          // New archived/stale requests still fail dispatch's exact-head checks.
          return {
            type: 'rollback',
            id: input.id,
            actorId: input.actorId,
            expected: { gameId, branchId: source.head.branchId, version: expected.version },
            beforeCommandId: action.commandId,
            knowledgeWarningAcknowledged: input.knowledgeWarningAcknowledged,
          };
        },
      );
      if (resolved.type !== 'rollback') return resolved;
      // Never dispatch from inside observe. Preserve canonical expected head;
      // an intervening action or same-head closure rejects instead of retargeting.
      return entry.runtime.dispatch(resolved, {
        controller: options.controller ?? 'human',
        ...(options.admit ? { admit: options.admit } : {}),
      });
    });
  }

  /** Lobby-only chat never grants game participation. Select current context
   * inside host serialization; storage owns the single queued scope/admit job.
   */
  postChat(
    lobbyId: LobbyId,
    input: ChatInput,
    nowMs: number,
    options: ChatAdmissionOptions = {},
  ): Promise<ChatMessage> {
    const message = structuredClone(input);
    const origin = { ...options };
    return this.#enqueue(async () => {
      const entry = await this.#current(lobbyId);
      const lobby = await PostgresLobby.open(this.#pool, lobbyId);
      try {
        return await lobby.postChat(message, nowMs, entry?.runtime, origin);
      } catch (error) {
        if (entry && !this.#healthy(entry)) await this.#release(entry, false);
        throw error;
      }
    });
  }

  chatHistory(
    lobbyId: LobbyId,
    afterSequence: string,
    limit: number,
    options: ChatAdmissionOptions = {},
  ): Promise<readonly ChatMessage[]> {
    const origin = { ...options };
    return this.#enqueue(async () => {
      await admitChat(origin);
      return (await PostgresLobby.open(this.#pool, lobbyId)).messages(afterSequence, limit);
    });
  }

  /** Trusted bound claim only; resolver SQL runs inside the runtime queue, not
   * through a re-entrant host operation. No chat/history payload is returned.
   */
  submitClaim(
    lobbyId: LobbyId,
    gameId: GameId,
    request: ClaimRequest,
    options: DispatchOptions = {},
  ) {
    const input = structuredClone(request);
    return this.withCurrent(lobbyId, gameId, (runtime) =>
      runtime.dispatchClaim(
        input,
        async (capture) => {
          const chat =
            input.incident.type === 'chat'
              ? await (
                  await PostgresLobby.open(this.#pool, lobbyId)
                ).message(id('message', input.incident.messageId))
              : null;
          return resolveClaimEvidence(input, capture, lobbyId, chat);
        },
        options,
      ),
    );
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

  /** Original authenticated intent only. Admission returns fresh server-owned
   * membership, never a browser roster; callbacks must not re-enter this host.
   */
  startFromIntent(
    lobbyId: LobbyId,
    input: Pick<MatchStart, 'id' | 'actorSessionId' | 'expectedHead'>,
    admit: () => Promise<GuestMembership | null>,
  ): Promise<MatchStartOutcome> {
    const intent = structuredClone(input);
    const authorize = async () => {
      let binding: GuestMembership | null;
      try {
        binding = await admit();
      } catch {
        throw new RuntimeAdmissionError('unavailable');
      }
      if (
        !binding ||
        binding.lobbyId !== lobbyId ||
        !binding.isOwner ||
        binding.sessionId !== intent.actorSessionId
      )
        throw new RuntimeAdmissionError();
      return binding;
    };
    return this.#enqueue(async () => {
      const binding = await authorize();
      const lobby = await PostgresLobby.open(this.#pool, lobbyId);
      const prior = await lobby.startReceipt(intent.id);
      if (prior)
        return prior.request.actorSessionId === intent.actorSessionId &&
          isDeepStrictEqual(prior.request.expectedHead, intent.expectedHead) &&
          prior.request.expectedGameId === (intent.expectedHead?.gameId ?? null)
          ? { type: 'duplicate', gameId: prior.gameId }
          : { type: 'rejected', code: 'command-id-reused' };
      const current = await this.#current(lobbyId);
      const snapshot = current?.runtime.read();
      if ((snapshot?.head.gameId ?? null) !== (intent.expectedHead?.gameId ?? null))
        return { type: 'rejected', code: 'game-mismatch' };
      if (!isDeepStrictEqual(snapshot?.head ?? null, intent.expectedHead))
        return { type: 'rejected', code: 'stale-head' };
      if (current && snapshot?.state?.phase.type !== 'finished')
        return { type: 'rejected', code: 'match-not-finished' };
      if (
        binding.seatIds.length < 2 ||
        binding.seatIds.length > 8 ||
        binding.seatIds[0] !== binding.seatId ||
        new Set(binding.seatIds).size !== binding.seatIds.length
      )
        return { type: 'rejected', code: 'invalid-configuration' };
      // Only a validated genuinely new intent allocates opaque configuration.
      const request: MatchStart = {
        ...intent,
        expectedGameId: intent.expectedHead?.gameId ?? null,
        gameId: id('game', randomUUID()),
        branchId: id('branch', randomUUID()),
        seatIds: [...binding.seatIds],
        cardIds: Array.from({ length: 36 }, () => id('card', randomUUID())),
      };
      return this.#startCanonical(lobbyId, lobby, current, request, {
        admit: async () => {
          try {
            await authorize();
            return true;
          } catch (error) {
            if (error instanceof RuntimeAdmissionError && error.code === 'unauthorized')
              return false;
            throw error;
          }
        },
      });
    });
  }

  /** Trusted canonical start; authenticated browser intents use startFromIntent. */
  startMatch(lobbyId: LobbyId, input: MatchStart): Promise<MatchStartOutcome> {
    const request = structuredClone(input);
    return this.#enqueue(async () => {
      const lobby = await PostgresLobby.open(this.#pool, lobbyId);
      const current = await this.#current(lobbyId);
      return this.#startCanonical(lobbyId, lobby, current, request);
    });
  }

  async #startCanonical(
    lobbyId: LobbyId,
    lobby: PostgresLobby,
    current: Entry | null,
    request: MatchStart,
    options: StartAdmissionOptions = {},
  ): Promise<MatchStartOutcome> {
    const epoch = randomUUID();
    try {
      const result = await lobby.startMatch(
        request,
        {
          ...this.#runtimeInputs(request.gameId, epoch),
          connectedSeatIds: [],
        },
        current ?? undefined,
        options,
      );
      if (result.type !== 'started') return result;
      if (current) await this.#release(current, false);
      const entry: Entry = { ...result, lobbyId, epoch };
      this.#entries.set(result.gameId, entry);
      try {
        await this.#presence(entry);
        await this.#bindObservers(entry);
        entry.stopBots = await startBotRunner(
          entry.runtime,
          () => id('command', randomUUID()),
          () => this.#checkRuntimeHealth(entry.gameId, entry.epoch),
        );
      } catch {
        await this.#release(entry, false);
        throw new GameHostError('game-unavailable');
      }
      return { type: 'started' as const, gameId: result.gameId };
    } catch (error) {
      if (current && !this.#healthy(current)) await this.#release(current, false);
      if (error instanceof RuntimeAdmissionError) throw error;
      throw new GameHostError('game-unavailable');
    }
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
      for (const observers of this.#observers.values())
        for (const observer of observers) {
          observer.active = false;
          observer.epoch = null;
        }
      this.#observers.clear();
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

  #checkRuntimeHealth(gameId: GameId, epoch: string): void {
    // Never await the host queue from runtime work: a trusted host operation
    // may itself await it. Late failures cannot evict a replacement writer.
    void this.#enqueue(async () => {
      const entry = this.#entries.get(gameId);
      if (entry?.epoch === epoch && !this.#healthy(entry)) await this.#release(entry, false);
    }).catch(() => {});
  }

  #runtimeInputs(gameId: GameId, epoch: string): Inputs {
    const check = () => this.#checkRuntimeHealth(gameId, epoch);
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
      try {
        await this.#bindObservers(entry);
        entry.stopBots = await startBotRunner(
          entry.runtime,
          () => id('command', randomUUID()),
          () => this.#checkRuntimeHealth(entry.gameId, entry.epoch),
        );
      } catch (error) {
        await this.#release(entry, false);
        throw error;
      }
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
    entry.stopBots?.();
    entry.stopCapture?.();
    delete entry.stopCapture;
    this.#dropCapture(entry);
    delete entry.captureWriter;
    if (this.#entries.get(entry.gameId) === entry) this.#entries.delete(entry.gameId);
    for (const observer of [...(this.#observers.get(entry.lobbyId) ?? [])]) {
      if (observer.epoch !== entry.epoch) continue;
      observer.epoch = null;
      this.#notify(observer, Object.freeze({ type: 'invalidated', epoch: entry.epoch }));
    }
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
