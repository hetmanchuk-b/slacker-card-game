import { createBotMemory, rememberBotObservation, restoreBotMemory } from '../bots/memory.ts';
import type { BotMemory } from '../bots/memory.ts';
import { observeBotCurrent, observeBotAction } from '../bots/observation.ts';
import {
  BOT_MEMORY_CHECKPOINT_CAPACITY,
  validateBotMemoryStorage,
} from '../bots/memory-storage.ts';
import type { BotMemoryStorage } from '../bots/memory-storage.ts';
import { decide } from '../game/engine.ts';
import { isDeepStrictEqual } from 'node:util';
import { id } from '../game/ids.ts';
import type {
  ActionBatch,
  BranchHead,
  GameCommand,
  RejectionCode,
  SubmitClaim,
} from '../game/contracts.ts';
import type { BranchId, CommandId, ProcedureId, SeatId } from '../game/ids.ts';
import type { GameState, Timer, Vote } from '../game/model.ts';
import type {
  BranchInfo,
  ForkResult,
  History,
  HistorySnapshot,
  RollbackAudit,
} from '../persistence/history.ts';
import type { CancelTask, Clock } from './clock.ts';

export type RuntimeOptions = Readonly<{
  history: History;
  clock: Clock;
  connectedSeatIds: readonly SeatId[];
  randomInt: (upperExclusive: number) => number;
  nextCommandId: () => CommandId;
  /** Atomically store history and this checkpoint before publication/acknowledgment. */
  commit?: (checkpoint: RuntimeCheckpoint) => Promise<void>;
}>;

export type RuntimeSnapshot = Readonly<{
  head: BranchHead;
  state: GameState | null;
  connections: readonly SeatPresence[];
  paused: boolean;
  replacementVote: ReplacementVote | null;
  controlEvents: readonly ControlEvent[];
}>;

/** Exact newly appended action, private until the whole queue job publishes. */
export type RuntimeActionPair = Readonly<{
  before: Readonly<{ head: BranchHead; state: GameState | null }>;
  action: ActionBatch;
  after: Readonly<{ head: BranchHead; state: GameState | null }>;
  delivery: 'fresh';
}>;

/** Server-private data, NOT a network payload. Sequence is local to this runtime
 * instance, not a durable revision/transport epoch. Initial subscription is a
 * baseline with no replayed actions. Consumers must apply viewer projections.
 */
export type RuntimePublication = Readonly<{
  sequence: number;
  kind: 'initial' | 'update' | 'rollback' | 'rollback-closed' | 'handoff';
  nowMs: number;
  snapshot: RuntimeSnapshot;
  actions: readonly RuntimeActionPair[];
}>;
type Subscription = Readonly<{
  receive: (publication: RuntimePublication) => void | Promise<void>;
  report: ((sequence: number) => void | Promise<void>) | undefined;
}>;

export type RuntimeResult =
  | Readonly<{
      type: 'accepted';
      outcome: 'played' | 'violation' | 'control';
      head: BranchHead;
      duplicate: boolean;
    }>
  | Readonly<{
      type: 'rejected';
      code:
        | RejectionCode
        | Extract<ForkResult, { type: 'rejected' }>['code']
        | 'closed'
        | 'not-connected'
        | 'wrong-controller'
        | 'wrong-branch'
        | 'command-id-reused'
        | 'system-command'
        | 'replacement-too-early'
        | 'replacement-active'
        | 'not-absent';
      head: BranchHead;
    }>;

/** Unresolved server-bound claim, never a browser identity or scope. */
export type ClaimRequest = Omit<SubmitClaim, 'scope' | 'scopeNumber'>;
export type ClaimCapture = Readonly<{
  snapshot: RuntimeSnapshot;
  history: HistorySnapshot;
  branches: readonly BranchInfo[];
}>;
export type ClaimResolver = (
  capture: ClaimCapture,
) => Promise<
  | Readonly<{ type: 'resolved'; scope: SubmitClaim['scope']; scopeNumber: number }>
  | Readonly<{ type: 'rejected'; code: 'invalid-claim' | 'scope-closed' }>
>;

function claimIdentity(command: ClaimRequest): ClaimRequest {
  return {
    type: command.type,
    id: command.id,
    actorId: command.actorId,
    accusedId: command.accusedId,
    reason: command.reason,
    incident: command.incident,
  };
}

export type ConnectionCommand =
  | Readonly<{ type: 'disconnect'; id: CommandId; seatId: SeatId }>
  | Readonly<{ type: 'reconnect'; id: CommandId; seatId: SeatId }>;
export type ReplacementCommand =
  | Readonly<{ type: 'propose-bot'; id: CommandId; actorId: SeatId; seatId: SeatId }>
  | Readonly<{
      type: 'replacement-vote';
      id: CommandId;
      actorId: SeatId;
      procedureId: ProcedureId;
      vote: Vote;
    }>;
export type RollbackCommand = Readonly<{
  type: 'rollback';
  id: CommandId;
  actorId: SeatId;
  expected: BranchHead;
  beforeCommandId: CommandId;
  knowledgeWarningAcknowledged: boolean;
}>;
export type RuntimeCommand = GameCommand | ConnectionCommand | ReplacementCommand | RollbackCommand;
export type ReplacementVote = Readonly<{
  absentSeatId: SeatId;
  eligibleSeatIds: readonly SeatId[];
  votes: Readonly<Partial<Record<SeatId, Vote>>>;
  timer: Timer & Readonly<{ startedAtMs: number }>;
}>;
export type ControlEvent = Readonly<{ commandId: CommandId; atMs: number }> &
  (
    | Readonly<{ type: 'connection-changed'; seatId: SeatId; connected: boolean }>
    | Readonly<{ type: 'replacement-started'; vote: ReplacementVote }>
    | Readonly<{ type: 'replacement-ballot'; procedureId: ProcedureId; seatId: SeatId; vote: Vote }>
    | Readonly<{ type: 'replacement-resolved'; vote: ReplacementVote; replaced: boolean }>
    | Readonly<{
        type: 'replacement-canceled';
        procedureId: ProcedureId;
        seatId: SeatId;
        reason?: 'reconnected' | 'rollback';
      }>
    | Readonly<{ type: 'human-control-restored'; seatId: SeatId }>
    | Readonly<{ type: 'runtime-restored'; capturedAtMs: number }>
    | Readonly<{ type: 'rollback-completed'; rollback: RollbackAudit }>
  );
/** Technical admission denial, not an engine rejection or runtime fault.
 * No game head, private guard error or authorization context is exposed.
 */
export class RuntimeAdmissionError extends Error {
  readonly code: 'unauthorized' | 'unavailable';
  constructor(code: 'unauthorized' | 'unavailable' = 'unauthorized') {
    super('Runtime admission denied');
    this.name = 'RuntimeAdmissionError';
    this.code = code;
  }
}
export type DispatchOptions = Readonly<{
  branchId?: BranchId;
  controller?: 'human' | 'bot';
  /** Trusted, bounded, non-reentrant authorization at queue admission, before
   * receipts/rules. Receives a detached snapshot; only true permits dispatch.
   * False/throw/rejection changes no state/receipts/storage/scheduling.
   */
  admit?: (snapshot: RuntimeSnapshot) => boolean | Promise<boolean>;
}>;
export type SeatPresence = Readonly<{
  seatId: SeatId;
  connected: boolean;
  controller: 'human' | 'bot';
  disconnectedAtMs: number | null;
}>;
export type StoredReceipt = Readonly<{
  command: RuntimeCommand;
  controller: 'human' | 'bot';
  result: Extract<RuntimeResult, { type: 'accepted' }>;
}>;
type RuntimeCheckpointBase = Readonly<{
  capturedAtMs: number;
  head: BranchHead;
  connections: readonly SeatPresence[];
  replacementVote: ReplacementVote | null;
  controlEvents: readonly ControlEvent[];
  receipts: readonly StoredReceipt[];
}>;

export type RuntimeCheckpoint = RuntimeCheckpointBase &
  (Readonly<{ schemaVersion: 1 }> | Readonly<{ schemaVersion: 2; botMemory: BotMemoryStorage }>);

/** One serialized, server-only runtime per game. Snapshots are not network payloads. */
export class GameRuntime {
  #options: RuntimeOptions;
  #memory: BotMemory[] = [];
  #memoryBefore: BotMemoryStorage['beforeCommands'][number][] = [];
  #suppressTransient = false;
  #tail: Promise<void> = Promise.resolve();
  #cancel: CancelTask[] = [];
  #generation = 0;
  #closed = false;
  #fault: unknown = null;
  #published: RuntimeSnapshot | null = null;
  #schedulePending = false;
  #requiresBranch: boolean;
  #connections: SeatPresence[];
  #replacement: ReplacementVote | null = null;
  #controlEvents: ControlEvent[] = [];
  #receipts = new Map<CommandId, StoredReceipt>();
  #subscriptions = new Set<Subscription>();
  #publicationSequence = 0;
  #pendingActions: RuntimeActionPair[] = [];
  #pendingPublication: RuntimePublication | null = null;
  #pendingClosure = false;
  #closureAnnounced = false;

  private constructor(options: RuntimeOptions) {
    this.#options = options;
    this.#requiresBranch = options.history.branches().length > 1;
    this.#connections = options.connectedSeatIds.map((seatId) => ({
      seatId,
      connected: true,
      controller: 'human',
      disconnectedAtMs: null,
    }));
  }

  static async create(options: RuntimeOptions): Promise<GameRuntime> {
    const runtime = new GameRuntime(options);
    await runtime.#enqueue(() => {
      runtime.#ensureRoster();
      runtime.#reconcile();
      runtime.#reschedule();
    });
    return runtime;
  }

  static async restore(
    options: RuntimeOptions,
    checkpoint: RuntimeCheckpoint,
  ): Promise<GameRuntime> {
    const snapshot = options.history.read();
    if (
      ![1, 2].includes(checkpoint.schemaVersion) ||
      !isDeepStrictEqual(snapshot.head, checkpoint.head)
    )
      throw new Error('Checkpoint does not match the current history head');
    if (
      !Number.isSafeInteger(checkpoint.capturedAtMs) ||
      checkpoint.capturedAtMs < (snapshot.actions.at(-1)?.occurredAtMs ?? 0) ||
      checkpoint.capturedAtMs > options.clock.now()
    )
      throw new Error('Invalid checkpoint capture time');
    const seatIds =
      snapshot.state?.players.map((player) => player.id) ??
      checkpoint.connections.map((item) => item.seatId);
    if (
      new Set(checkpoint.connections.map((item) => item.seatId)).size !==
        checkpoint.connections.length ||
      checkpoint.connections.some(
        (item) =>
          !seatIds.includes(item.seatId) ||
          !['human', 'bot'].includes(item.controller) ||
          typeof item.connected !== 'boolean' ||
          (item.disconnectedAtMs !== null &&
            (!Number.isSafeInteger(item.disconnectedAtMs) ||
              item.disconnectedAtMs < 0 ||
              item.disconnectedAtMs > checkpoint.capturedAtMs)),
      )
    )
      throw new Error('Invalid checkpoint connections');
    if (
      new Set(checkpoint.receipts.map((receipt) => receipt.command.id)).size !==
      checkpoint.receipts.length
    )
      throw new Error('Duplicate checkpoint receipt');
    if (
      checkpoint.receipts.some(
        (receipt) =>
          !['human', 'bot'].includes(receipt.controller) ||
          receipt.result.type !== 'accepted' ||
          receipt.result.head.gameId !== checkpoint.head.gameId ||
          !options.history
            .branches()
            .some(
              (branch) =>
                branch.head.branchId === receipt.result.head.branchId &&
                Number.isSafeInteger(receipt.result.head.version) &&
                receipt.result.head.version >= 0 &&
                receipt.result.head.version <= branch.head.version,
            ),
      )
    )
      throw new Error('Invalid checkpoint receipt');
    const replacement = checkpoint.replacementVote;
    if (replacement) {
      const target = checkpoint.connections.find(
        (item) => item.seatId === replacement.absentSeatId,
      );
      const active =
        snapshot.state?.players
          .filter((player) => player.status === 'active')
          .map((player) => player.id) ?? [];
      if (
        !target ||
        target.connected ||
        target.controller !== 'human' ||
        !active.includes(target.seatId) ||
        replacement.timer.remainingMs !== 10000 ||
        !Number.isSafeInteger(replacement.timer.startedAtMs) ||
        replacement.timer.startedAtMs < 0 ||
        replacement.timer.startedAtMs > checkpoint.capturedAtMs ||
        replacement.eligibleSeatIds.length === 0 ||
        new Set(replacement.eligibleSeatIds).size !== replacement.eligibleSeatIds.length ||
        replacement.eligibleSeatIds.some(
          (seat) => !active.includes(seat) || seat === target.seatId,
        ) ||
        Object.entries(replacement.votes).some(
          ([seat, vote]) =>
            !replacement.eligibleSeatIds.some((id) => id === seat) ||
            !['yes', 'no', 'abstain'].includes(vote ?? ''),
        )
      )
        throw new Error('Invalid checkpoint replacement vote');
    }
    const runtime = new GameRuntime({ ...options, connectedSeatIds: [] });
    if (checkpoint.schemaVersion === 2) {
      validateBotMemoryStorage(
        checkpoint.botMemory,
        options.history,
        checkpoint.connections.map((item) => item.seatId),
      );
      runtime.#memory = structuredClone([...checkpoint.botMemory.current]);
      runtime.#memoryBefore = structuredClone([...checkpoint.botMemory.beforeCommands]);
    } else if ('botMemory' in checkpoint) {
      throw new Error('Invalid legacy bot memory checkpoint');
    }
    runtime.#suppressTransient = true;
    runtime.#connections = checkpoint.connections.map((item) => ({
      ...item,
      connected: false,
      disconnectedAtMs: item.disconnectedAtMs ?? checkpoint.capturedAtMs,
    }));
    runtime.#replacement = structuredClone(checkpoint.replacementVote);
    runtime.#controlEvents = structuredClone([...checkpoint.controlEvents]);
    runtime.#receipts = new Map(
      checkpoint.receipts.map((receipt) => [receipt.command.id, structuredClone(receipt)]),
    );
    await runtime.#enqueue(() => {
      runtime.#ensureRoster();
      runtime.#reconcile(runtime.#connections, checkpoint.capturedAtMs);
      runtime.#controlEvents.push({
        type: 'runtime-restored',
        commandId: options.nextCommandId(),
        atMs: options.clock.now(),
        capturedAtMs: checkpoint.capturedAtMs,
      });
      runtime.#reschedule();
    });
    return runtime;
  }

  checkpoint(): Promise<RuntimeCheckpoint> {
    return this.#enqueue(() => {
      if (this.#closed) throw new Error('Cannot checkpoint a closed runtime');
      return this.#capture();
    });
  }

  #remember(snapshot = this.#view(), pair?: RuntimeActionPair): void {
    const seats =
      snapshot.state?.players.map((p) => p.id) ?? this.#connections.map((p) => p.seatId);
    this.#memory = seats.map((seatId) => {
      const previous =
        this.#memory.find((m) => m.seatId === seatId) ??
        createBotMemory(snapshot.head.gameId, seatId);
      if (!snapshot.state) return previous;
      const current = observeBotCurrent(snapshot, seatId, this.#options.clock.now());
      const safeCurrent = this.#suppressTransient
        ? { ...current, transient: { initialRecipientNotice: false, reveal: null } }
        : current;
      return rememberBotObservation(
        previous,
        safeCurrent,
        pair ? observeBotAction(pair, seatId) : undefined,
      );
    });
  }

  #rememberBefore(commandId: CommandId, head: BranchHead): void {
    if (this.#memoryBefore.some((item) => item.commandId === commandId)) return;
    this.#memoryBefore.push(structuredClone({ commandId, head, memories: this.#memory }));
    if (this.#memoryBefore.length > BOT_MEMORY_CHECKPOINT_CAPACITY) this.#memoryBefore.shift();
  }

  #capture(): RuntimeCheckpoint {
    const snapshot = this.#view();
    const capturedAtMs = this.#options.clock.now();
    if (
      !Number.isSafeInteger(capturedAtMs) ||
      capturedAtMs < (this.#options.history.read().actions.at(-1)?.occurredAtMs ?? 0)
    )
      throw new Error('Invalid checkpoint clock');
    return structuredClone({
      schemaVersion: 2,
      botMemory: { schemaVersion: 1, current: this.#memory, beforeCommands: this.#memoryBefore },
      capturedAtMs,
      head: snapshot.head,
      connections: this.#connections,
      replacementVote: this.#replacement,
      controlEvents: this.#controlEvents,
      receipts: [...this.#receipts.values()],
    });
  }

  read(): RuntimeSnapshot {
    if (this.#fault !== null) throw new Error('Runtime scheduling failed', { cause: this.#fault });
    if (this.#published === null) throw new Error('Runtime is not initialized');
    return structuredClone(this.#published);
  }

  /** Subscribe only after obtaining a live runtime (never during private match
   * preparation). Registration is serialized and receives the current baseline.
   * Invocation is ordered, completion is not awaited. Unsubscribe is immediate.
   * Capture extra committed history synchronously here, before any await; never
   * reread mutable staging state later to reconstruct an earlier publication.
   */
  subscribe(
    receive: Subscription['receive'],
    report?: Subscription['report'],
  ): Promise<() => void> {
    return this.#enqueue(
      () => {
        if (this.#closed || this.#fault !== null || this.#published === null)
          throw new Error('Runtime subscription unavailable');
        if (typeof receive !== 'function') throw new Error('Invalid runtime subscription');
        const subscription: Subscription = { receive, report };
        this.#subscriptions.add(subscription);
        this.#deliver(subscription, {
          sequence: this.#publicationSequence,
          kind: 'initial',
          nowMs: this.#options.clock.now(),
          snapshot: this.#published,
          actions: [],
        });
        return () => {
          this.#subscriptions.delete(subscription);
        };
      },
      false,
      false,
    );
  }

  #deliver(subscription: Subscription, publication: RuntimePublication): void {
    if (!this.#subscriptions.has(subscription)) return;
    const report = () => {
      // No exception/cause or raw private payload enters notification diagnostics.
      try {
        void Promise.resolve(subscription.report?.(publication.sequence)).catch(() => {});
      } catch {
        /* Diagnostic failure cannot undo a committed publication either. */
      }
    };
    try {
      void Promise.resolve(subscription.receive(structuredClone(publication))).catch(report);
    } catch {
      report();
    }
  }

  #view(): RuntimeSnapshot {
    if (this.#fault !== null) throw new Error('Runtime scheduling failed', { cause: this.#fault });
    const { head, state } = this.#options.history.read();
    return {
      head,
      state,
      connections: structuredClone(this.#connections),
      paused: state?.clock.type === 'suspended',
      replacementVote: structuredClone(this.#replacement),
      controlEvents: structuredClone(this.#controlEvents),
    };
  }

  dispatch(command: RuntimeCommand, options: DispatchOptions = {}): Promise<RuntimeResult> {
    return this.#dispatch(command, options);
  }

  /** Resolve trusted evidence inside the action queue, after authorization and
   * accepted-retry lookup. Resolver failures are technical, never runtime faults.
   * Resolver must be bounded and must not re-enter runtime/host queues.
   */
  dispatchClaim(
    request: ClaimRequest,
    resolve: ClaimResolver,
    options: DispatchOptions = {},
  ): Promise<RuntimeResult> {
    return this.#dispatch(claimIdentity(request), options, resolve);
  }

  #dispatch(
    command: RuntimeCommand | ClaimRequest,
    options: DispatchOptions,
    resolve?: ClaimResolver,
  ): Promise<RuntimeResult> {
    const input = structuredClone(command);
    const origin = { ...options };
    return this.#enqueue(
      async () => {
        const snapshot = this.#view();
        const reject = (
          code: Extract<RuntimeResult, { type: 'rejected' }>['code'],
        ): RuntimeResult => ({ type: 'rejected', code, head: snapshot.head });
        if (this.#closed) return reject('closed');
        if (origin.branchId !== undefined && origin.branchId !== snapshot.head.branchId)
          return reject('wrong-branch');
        const connection = input.type === 'disconnect' || input.type === 'reconnect';
        if (
          this.#requiresBranch &&
          !connection &&
          input.type !== 'rollback' &&
          origin.branchId === undefined
        )
          return reject('wrong-branch');
        const controller = origin.controller ?? 'human';
        const cached = this.#receipts.get(input.id);
        if (
          cached &&
          cached.result.head.branchId !== snapshot.head.branchId &&
          !connection &&
          input.type !== 'rollback'
        )
          return reject('wrong-branch');
        if (cached)
          return isDeepStrictEqual(
            resolve && cached.command.type === 'submit-claim'
              ? claimIdentity(cached.command)
              : cached.command,
            input,
          ) && cached.controller === controller
            ? { ...structuredClone(cached.result), duplicate: true }
            : reject('command-id-reused');
        if (
          this.#options.history.read().actions.some((action) => action.commandId === input.id) ||
          this.#controlEvents.some((event) => event.commandId === input.id)
        )
          return reject('command-id-reused');
        let result: RuntimeResult;
        let receiptCommand: RuntimeCommand;
        if (input.type === 'rollback') {
          receiptCommand = input;
          if (controller !== 'human') return reject('wrong-controller');
          const presence = this.#connections.find((item) => item.seatId === input.actorId);
          if (!presence?.connected) return reject('not-connected');
          if (presence.controller !== 'human') return reject('wrong-controller');
          result = this.#rollback(input);
        } else if (input.type === 'propose-bot' || input.type === 'replacement-vote') {
          receiptCommand = input;
          if (controller !== 'human') return reject('wrong-controller');
          result = this.#replacementCommand(input);
        } else if (input.type === 'disconnect' || input.type === 'reconnect') {
          receiptCommand = input;
          result = this.#connection(input);
        } else {
          if (
            input.type === 'suspend-clock' ||
            input.type === 'resume-clock' ||
            input.type.startsWith('expire-')
          )
            return reject('system-command');
          if (snapshot.paused) return reject('game-suspended');
          if ('actorId' in input) {
            const presence = this.#connections.find((item) => item.seatId === input.actorId);
            if (!presence) return reject('unknown-seat');
            if (presence.controller !== controller) return reject('wrong-controller');
            if (controller === 'human' && !presence.connected) return reject('not-connected');
          }
          let canonical: GameCommand;
          if (input.type === 'submit-claim' && !('scope' in input)) {
            if (!resolve) throw new RuntimeAdmissionError('unavailable');
            let resolution: Awaited<ReturnType<ClaimResolver>>;
            try {
              resolution = await resolve({
                snapshot: this.read(),
                history: this.#options.history.read(),
                branches: this.#options.history.branches(),
              });
            } catch {
              throw new RuntimeAdmissionError('unavailable');
            }
            if (resolution.type === 'rejected') return reject(resolution.code);
            canonical = { ...input, scope: resolution.scope, scopeNumber: resolution.scopeNumber };
          } else canonical = input;
          receiptCommand = canonical;
          result = this.#commit(canonical, this.#options.clock.now());
          this.#ensureRoster();
          this.#reconcile();
        }
        this.#reschedule();
        if (result.type === 'accepted') {
          result = { ...result, head: this.#view().head };
          this.#receipts.set(
            input.id,
            structuredClone({ command: receiptCommand, controller, result }),
          );
        }
        return structuredClone(result);
      },
      true,
      true,
      origin.admit
        ? async () => {
            let permitted: boolean;
            try {
              permitted = (await origin.admit!(this.read())) === true;
            } catch {
              // Infrastructure/guard failure is not proof of invalid identity.
              // Sanitize it without entering the mutation/fault path.
              throw new RuntimeAdmissionError('unavailable');
            }
            if (!permitted) throw new RuntimeAdmissionError();
          }
        : undefined,
    ).catch((error) => {
      if (!(error instanceof RuntimeAdmissionError)) {
        this.#fault = error;
        this.#cancelTasks();
      }
      throw error;
    });
  }

  #rollback(command: RollbackCommand): RuntimeResult {
    const point = this.#options.history.rollbackPoint(command.beforeCommandId);
    const knowledge = this.#memoryBefore.find((item) => item.commandId === command.beforeCommandId);
    const result = this.#options.history.fork(command.expected, {
      id: command.id,
      actorId: command.actorId,
      beforeCommandId: command.beforeCommandId,
      branchId: id('branch', `${command.id}:branch`),
      nowMs: this.#options.clock.now(),
      resumeClock: !this.#shouldSuspend(point?.state ?? null, this.#connections),
      knowledgeWarningAcknowledged: command.knowledgeWarningAcknowledged,
    });
    if (result.type === 'rejected') return result;
    if (result.type === 'committed') {
      this.#requiresBranch = true;
      const target = this.#options.history.read().head;
      this.#suppressTransient = true;
      this.#memory = this.#connections.map(({ seatId }) => {
        const prior =
          knowledge && point && knowledge.head.version === point.head.version
            ? knowledge.memories.find((m) => m.seatId === seatId)
            : undefined;
        // Administrative rebasing is not a new disclosure.
        return restoreBotMemory(
          prior ? { ...prior, head: null } : createBotMemory(target.gameId, seatId),
          target,
        );
      });
      // Fork rebases are new administrative actions on the CHILD branch, not
      // replays of the inherited prefix or observations from abandoned futures.
      if (point?.state && this.#subscriptions.size) {
        const after = this.#options.history.read();
        this.#pendingActions.push({
          before: { head: { ...after.head, version: point.head.version }, state: point.state },
          action: after.actions.at(-1)!,
          after: { head: after.head, state: after.state },
          delivery: 'fresh',
        });
      }
      if (this.#replacement) {
        this.#controlEvents.push({
          type: 'replacement-canceled',
          commandId: command.id,
          atMs: this.#options.clock.now(),
          procedureId: this.#replacement.timer.id,
          seatId: this.#replacement.absentSeatId,
          reason: 'rollback',
        });
        this.#replacement = null;
      }
      const rollback = this.#options.history.audit().find((item) => item.commandId === command.id)!;
      this.#controlEvents.push({
        type: 'rollback-completed',
        commandId: command.id,
        atMs: this.#options.clock.now(),
        rollback,
      });
      this.#ensureRoster();
      this.#reconcile();
    }
    return {
      type: 'accepted',
      outcome: 'control',
      head: result.head,
      duplicate: result.type === 'duplicate',
    };
  }

  #ensureRoster() {
    const state = this.#options.history.read().state;
    if (!state) return;
    this.#connections = state.players.map(
      (player) =>
        this.#connections.find((item) => item.seatId === player.id) ?? {
          seatId: player.id,
          connected: false,
          controller: 'human',
          disconnectedAtMs: this.#options.clock.now(),
        },
    );
  }

  #shouldSuspend(state: GameState | null, connections: readonly SeatPresence[]): boolean {
    if (!state || state.phase.type === 'finished') return false;
    const active = connections.filter((connection) =>
      state.players.some((player) => player.id === connection.seatId && player.status === 'active'),
    );
    return (
      active.some((item) => item.controller === 'human' && !item.connected) ||
      !active.some((item) => item.connected)
    );
  }

  #reconcile(
    connections: readonly SeatPresence[] = this.#connections,
    nowMs = this.#options.clock.now(),
  ) {
    const state = this.#options.history.read().state;
    if (!state) return;
    const suspend = this.#shouldSuspend(state, connections);
    if (suspend === (state.clock.type === 'suspended')) return;
    const result = this.#commit(
      { type: suspend ? 'suspend-clock' : 'resume-clock', id: this.#options.nextCommandId() },
      nowMs,
    );
    if (result.type !== 'accepted')
      throw new Error(`Clock reconciliation rejected: ${result.code}`);
  }

  #connection(command: ConnectionCommand): RuntimeResult {
    const snapshot = this.#view();
    const current = this.#connections.find((item) => item.seatId === command.seatId);
    if (!current) return { type: 'rejected', code: 'unknown-seat', head: snapshot.head };
    const nowMs = this.#options.clock.now();
    const next = this.#connections.map((item) =>
      item.seatId !== command.seatId
        ? item
        : command.type === 'reconnect'
          ? { ...item, connected: true, controller: 'human' as const, disconnectedAtMs: null }
          : { ...item, connected: false, disconnectedAtMs: item.disconnectedAtMs ?? nowMs },
    );
    this.#reconcile(next, nowMs);
    this.#connections = next;
    this.#controlEvents.push({
      type: 'connection-changed',
      commandId: command.id,
      atMs: nowMs,
      seatId: command.seatId,
      connected: command.type === 'reconnect',
    });
    if (command.type === 'reconnect' && current.controller === 'bot')
      this.#controlEvents.push({
        type: 'human-control-restored',
        commandId: command.id,
        atMs: nowMs,
        seatId: command.seatId,
      });
    if (command.type === 'reconnect' && this.#replacement?.absentSeatId === command.seatId) {
      this.#controlEvents.push({
        type: 'replacement-canceled',
        commandId: command.id,
        atMs: nowMs,
        seatId: command.seatId,
        procedureId: this.#replacement.timer.id,
        reason: 'reconnected',
      });
      this.#replacement = null;
    }
    return { type: 'accepted', outcome: 'control', head: this.#view().head, duplicate: false };
  }

  #humanError(seatId: SeatId): Extract<RuntimeResult, { type: 'rejected' }>['code'] | null {
    const state = this.#options.history.read().state;
    if (!state) return 'not-started';
    if (state.phase.type === 'finished') return 'wrong-phase';
    const player = state.players.find((player) => player.id === seatId);
    if (!player) return 'unknown-seat';
    if (player.status !== 'active') return 'inactive-seat';
    const presence = this.#connections.find((item) => item.seatId === seatId)!;
    if (presence.controller !== 'human') return 'wrong-controller';
    return presence.connected ? null : 'not-connected';
  }

  #replacementCommand(command: ReplacementCommand): RuntimeResult {
    const reject = (code: Extract<RuntimeResult, { type: 'rejected' }>['code']): RuntimeResult => ({
      type: 'rejected',
      code,
      head: this.#view().head,
    });
    const error = this.#humanError(command.actorId);
    if (error) return reject(error);
    const nowMs = this.#options.clock.now();
    if (command.type === 'propose-bot') {
      if (this.#replacement !== null) return reject('replacement-active');
      const target = this.#connections.find((item) => item.seatId === command.seatId);
      if (!target) return reject('unknown-seat');
      if (
        !this.#view().state!.players.some(
          (player) => player.id === target.seatId && player.status === 'active',
        )
      )
        return reject('inactive-seat');
      if (target.connected || target.controller !== 'human' || target.disconnectedAtMs === null)
        return reject('not-absent');
      if (nowMs - target.disconnectedAtMs <= 30000) return reject('replacement-too-early');
      const eligibleSeatIds = this.#connections
        .filter((item) => this.#humanError(item.seatId) === null)
        .map((item) => item.seatId);
      this.#replacement = {
        absentSeatId: target.seatId,
        eligibleSeatIds,
        votes: {},
        timer: {
          id: id('procedure', `${command.id}:replacement`),
          remainingMs: 10000,
          startedAtMs: nowMs,
        },
      };
      this.#controlEvents.push({
        type: 'replacement-started',
        commandId: command.id,
        atMs: nowMs,
        vote: structuredClone(this.#replacement),
      });
    } else {
      const vote = this.#replacement;
      if (!vote) return reject('wrong-phase');
      if (vote.timer.id !== command.procedureId) return reject('stale-timer');
      if (nowMs - vote.timer.startedAtMs >= vote.timer.remainingMs) return reject('timer-expired');
      if (!vote.eligibleSeatIds.includes(command.actorId)) return reject('not-eligible');
      if (Object.hasOwn(vote.votes, command.actorId)) return reject('already-answered');
      if (!['yes', 'no', 'abstain'].includes(command.vote)) return reject('invalid-vote');
      const next = { ...vote, votes: { ...vote.votes, [command.actorId]: command.vote } };
      const event: ControlEvent = {
        type: 'replacement-ballot',
        commandId: command.id,
        atMs: nowMs,
        procedureId: vote.timer.id,
        seatId: command.actorId,
        vote: command.vote,
      };
      if (vote.eligibleSeatIds.every((seat) => Object.hasOwn(next.votes, seat)))
        this.#finishReplacement(next, command.id, [event]);
      else {
        this.#replacement = next;
        this.#controlEvents.push(event);
      }
    }
    return { type: 'accepted', outcome: 'control', head: this.#view().head, duplicate: false };
  }

  #finishReplacement(
    vote: ReplacementVote,
    commandId: CommandId,
    prefix: readonly ControlEvent[] = [],
  ) {
    const nowMs = this.#options.clock.now();
    const yes = Object.values(vote.votes).filter((value) => value === 'yes').length;
    const no = Object.values(vote.votes).filter((value) => value === 'no').length;
    const state = this.#options.history.read().state;
    const target = this.#connections.find((item) => item.seatId === vote.absentSeatId);
    const replaced =
      yes > no &&
      target?.controller === 'human' &&
      !target.connected &&
      state?.players.some((player) => player.id === target.seatId && player.status === 'active') ===
        true;
    const next = this.#connections.map((item) =>
      replaced && item.seatId === vote.absentSeatId
        ? { ...item, controller: 'bot' as const }
        : item,
    );
    this.#reconcile(next, nowMs);
    this.#connections = next;
    this.#replacement = null;
    this.#controlEvents.push(...prefix, {
      type: 'replacement-resolved',
      commandId,
      atMs: nowMs,
      vote: structuredClone(vote),
      replaced,
    });
  }

  /** Read-only server operation ordered against play, timers and rollback. Do not re-enter this queue. */
  observe<T>(operation: (snapshot: RuntimeSnapshot, nowMs: number) => Promise<T>): Promise<T> {
    return this.#enqueue(
      () => {
        if (this.#closed) throw new Error('Game runtime is closed');
        return operation(this.#view(), this.#options.clock.now());
      },
      false,
      false,
    );
  }

  /** Publisher must atomically store the closed old checkpoint and actual successor. */
  handoff(
    publish: (checkpoint: RuntimeCheckpoint) => Promise<void | false>,
    expected?: BranchHead,
    options: Pick<DispatchOptions, 'admit'> & { readonly deferClosure?: boolean } = {},
  ): Promise<boolean> {
    const admit = options.admit;
    const deferClosure = options.deferClosure === true;
    return this.#enqueue(
      async () => {
        if (this.#closed || this.#view().state?.phase.type !== 'finished') return false;
        if (expected && !isDeepStrictEqual(expected, this.#view().head)) return false;
        // A transactional publisher may refuse policy admission without changing
        // history. It must persist a closed history copy on successful handoff.
        if (!deferClosure) this.#options.history.closeRollback();
        const committed = await publish(this.#capture());
        if (committed === false) {
          if (!deferClosure) throw new Error('Handoff refusal requires deferred closure');
          return false;
        }
        if (deferClosure) this.#options.history.closeRollback();
        await this.#publish('handoff', false);
        this.#closed = true;
        this.#cancelTasks();
        return true;
      },
      false,
      true,
      admit
        ? async () => {
            let permitted: boolean;
            try {
              permitted = (await admit(this.read())) === true;
            } catch {
              throw new RuntimeAdmissionError('unavailable');
            }
            if (!permitted) throw new RuntimeAdmissionError();
          }
        : undefined,
    );
  }

  /** Low-level legacy guard only. Actual starts must use handoff via PostgresLobby. */
  closeForNextMatch(): Promise<boolean> {
    return this.#enqueue(() => {
      if (this.#closed || this.#view().state?.phase.type !== 'finished') return false;
      this.#options.history.closeRollback();
      if (!this.#closureAnnounced) {
        this.#pendingClosure = true;
        this.#closureAnnounced = true;
      }
      return true;
    });
  }

  dispose(): Promise<void> {
    return this.#enqueue(() => {
      this.#closed = true;
      this.#cancelTasks();
      this.#subscriptions.clear();
    }, false);
  }

  #enqueue<T>(
    job: () => T | Promise<T>,
    persist = true,
    faultOnFailure = true,
    admit?: () => Promise<void>,
  ): Promise<T> {
    const result = this.#tail.then(async () => {
      if (persist && this.#fault !== null)
        throw new Error('Runtime is faulted', { cause: this.#fault });
      // Outside the mutation/fault/publication path: denial is a technical gate.
      if (admit) await admit();
      this.#pendingActions = [];
      this.#pendingPublication = null;
      this.#pendingClosure = false;
      try {
        const value = await job();
        if (persist && !this.#closed)
          await this.#publish(this.#pendingClosure ? 'rollback-closed' : undefined);
        if (this.#schedulePending) {
          this.#schedulePending = false;
          this.#armSchedule();
        }
        const publication = this.#pendingPublication;
        this.#pendingPublication = null;
        if (publication) {
          for (const subscription of [...this.#subscriptions])
            this.#deliver(subscription, publication);
        }
        return value;
      } catch (error) {
        if (faultOnFailure && !(error instanceof RuntimeAdmissionError)) {
          this.#fault = error;
          this.#cancelTasks();
        }
        throw error;
      } finally {
        this.#pendingActions = [];
        this.#pendingPublication = null;
        this.#pendingClosure = false;
      }
    });
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #publish(kind?: 'handoff' | 'rollback-closed', persist = true): Promise<void> {
    const view = this.#view();
    this.#remember(view);
    if (persist && this.#options.commit) await this.#options.commit(this.#capture());
    const previous = this.#published;
    this.#published = view;
    if (kind || previous === null || !isDeepStrictEqual(previous, view)) {
      this.#publicationSequence++;
      if (this.#subscriptions.size)
        this.#pendingPublication = {
          sequence: this.#publicationSequence,
          kind:
            kind ??
            (previous === null
              ? 'initial'
              : previous.head.branchId !== view.head.branchId
                ? 'rollback'
                : 'update'),
          nowMs: this.#options.clock.now(),
          snapshot: view,
          actions: kind ? [] : [...this.#pendingActions],
        };
    }
  }

  #commit(command: GameCommand, nowMs: number): RuntimeResult {
    if (this.#fault !== null) throw new Error('Runtime is faulted', { cause: this.#fault });
    const snapshot = this.#options.history.read();
    const decision = decide(snapshot.state, command, { nowMs, randomInt: this.#options.randomInt });
    if (decision.type === 'rejected') return { ...decision, head: snapshot.head };
    this.#remember();
    if (command.type === 'start-game') {
      this.#memory = command.seatIds.map(
        (seatId) =>
          this.#memory.find((m) => m.seatId === seatId) ??
          createBotMemory(snapshot.head.gameId, seatId),
      );
    }
    this.#rememberBefore(command.id, snapshot.head);
    const appended = this.#options.history.append(snapshot.head, decision.action);
    if (appended.type === 'rejected') throw new Error(`History append rejected: ${appended.code}`);
    if (appended.type === 'committed') {
      const after = this.#options.history.read();
      const pair: RuntimeActionPair = {
        before: { head: snapshot.head, state: snapshot.state },
        action: decision.action,
        after: { head: after.head, state: after.state },
        delivery: 'fresh',
      };
      if (
        decision.action.events.some(
          (event) => event.event.type === 'card-drawn' || event.event.type === 'game-started',
        )
      )
        this.#suppressTransient = false;
      this.#remember({ ...this.#view(), head: after.head, state: after.state }, pair);
      if (this.#subscriptions.size) this.#pendingActions.push(pair);
    }
    return {
      type: 'accepted',
      outcome: decision.outcome,
      head: appended.head,
      duplicate: appended.type === 'duplicate',
    };
  }

  #cancelTasks() {
    this.#generation++;
    for (const cancel of this.#cancel) cancel();
    this.#cancel = [];
  }

  #reschedule() {
    this.#schedulePending = true;
  }

  #armSchedule() {
    this.#cancelTasks();
    if (this.#closed || this.#fault !== null) return;
    const { state, head } = this.#options.history.read();
    if (state === null) return;
    const replacement = this.#replacement;
    if (replacement)
      this.#schedule(replacement.timer.startedAtMs + replacement.timer.remainingMs, head, () => {
        const current = this.#replacement;
        if (!current || current.timer.id !== replacement.timer.id) return;
        const votes = Object.fromEntries(
          current.eligibleSeatIds.map((seat) => [
            seat,
            Object.hasOwn(current.votes, seat) ? current.votes[seat] : 'abstain',
          ]),
        );
        this.#finishReplacement({ ...current, votes }, this.#options.nextCommandId());
      });
    if (state.clock.type === 'suspended') return;
    const procedure = state.procedure;
    const timer =
      procedure?.timer ?? (state.phase.type === 'trump-reveal' ? state.phase.timer : null);
    if (timer === null || timer.startedAtMs === null) return;
    const type =
      procedure?.type === 'claim-vote'
        ? 'expire-claim-vote'
        : procedure?.type === 'withdrawal'
          ? 'expire-withdrawal'
          : procedure?.type === 'penalty'
            ? 'expire-penalty'
            : 'expire-reveal';
    this.#schedule(timer.startedAtMs + timer.remainingMs, head, () => {
      const result = this.#commit(
        { type, id: this.#options.nextCommandId(), timerId: timer.id },
        this.#options.clock.now(),
      );
      if (result.type !== 'accepted') throw new Error(`Scheduled expiry rejected: ${result.code}`);
    });
  }

  #schedule(deadlineMs: number, head: BranchHead, task: () => void) {
    const generation = this.#generation;
    this.#cancel.push(
      this.#options.clock.scheduleAt(deadlineMs, () =>
        this.#enqueue(async () => {
          if (this.#closed || generation !== this.#generation) return;
          const current = this.#options.history.read().head;
          if (current.branchId !== head.branchId || current.version !== head.version) {
            this.#ensureRoster();
            this.#reconcile();
            this.#reschedule();
            await this.#publish();
            return;
          }
          task();
          this.#ensureRoster();
          this.#reconcile();
          this.#reschedule();
          await this.#publish();
        }, false).catch((error) => {
          this.#fault = error;
          this.#cancelTasks();
        }),
      ),
    );
  }
}
