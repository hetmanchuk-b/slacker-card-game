import { decide } from '../game/engine.ts';
import { isDeepStrictEqual } from 'node:util';
import { id } from '../game/ids.ts';
import type { BranchHead, GameCommand, RejectionCode } from '../game/contracts.ts';
import type { BranchId, CommandId, ProcedureId, SeatId } from '../game/ids.ts';
import type { GameState, Timer, Vote } from '../game/model.ts';
import type { ForkResult, History, RollbackAudit } from '../persistence/history.ts';
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
export type DispatchOptions = Readonly<{ branchId?: BranchId; controller?: 'human' | 'bot' }>;
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
export type RuntimeCheckpoint = Readonly<{
  schemaVersion: 1;
  capturedAtMs: number;
  head: BranchHead;
  connections: readonly SeatPresence[];
  replacementVote: ReplacementVote | null;
  controlEvents: readonly ControlEvent[];
  receipts: readonly StoredReceipt[];
}>;

/** One serialized, server-only runtime per game. Snapshots are not network payloads. */
export class GameRuntime {
  #options: RuntimeOptions;
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
    if (checkpoint.schemaVersion !== 1 || !isDeepStrictEqual(snapshot.head, checkpoint.head))
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

  #capture(): RuntimeCheckpoint {
    const snapshot = this.#view();
    const capturedAtMs = this.#options.clock.now();
    if (
      !Number.isSafeInteger(capturedAtMs) ||
      capturedAtMs < (this.#options.history.read().actions.at(-1)?.occurredAtMs ?? 0)
    )
      throw new Error('Invalid checkpoint clock');
    return structuredClone({
      schemaVersion: 1,
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
    const input = structuredClone(command);
    const origin = { ...options };
    return this.#enqueue(() => {
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
        return isDeepStrictEqual(cached.command, input) && cached.controller === controller
          ? { ...structuredClone(cached.result), duplicate: true }
          : reject('command-id-reused');
      if (
        this.#options.history.read().actions.some((action) => action.commandId === input.id) ||
        this.#controlEvents.some((event) => event.commandId === input.id)
      )
        return reject('command-id-reused');
      let result: RuntimeResult;
      if (input.type === 'rollback') {
        if (controller !== 'human') return reject('wrong-controller');
        const presence = this.#connections.find((item) => item.seatId === input.actorId);
        if (!presence?.connected) return reject('not-connected');
        if (presence.controller !== 'human') return reject('wrong-controller');
        result = this.#rollback(input);
      } else if (input.type === 'propose-bot' || input.type === 'replacement-vote') {
        if (controller !== 'human') return reject('wrong-controller');
        result = this.#replacementCommand(input);
      } else if (input.type === 'disconnect' || input.type === 'reconnect') {
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
        result = this.#commit(input, this.#options.clock.now());
        this.#ensureRoster();
        this.#reconcile();
      }
      this.#reschedule();
      if (result.type === 'accepted') {
        result = { ...result, head: this.#view().head };
        this.#receipts.set(input.id, structuredClone({ command: input, controller, result }));
      }
      return structuredClone(result);
    }).catch((error) => {
      this.#fault = error;
      this.#cancelTasks();
      throw error;
    });
  }

  #rollback(command: RollbackCommand): RuntimeResult {
    const point = this.#options.history.rollbackPoint(command.beforeCommandId);
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
    publish: (checkpoint: RuntimeCheckpoint) => Promise<void>,
    expected?: BranchHead,
  ): Promise<boolean> {
    return this.#enqueue(async () => {
      if (this.#closed || this.#view().state?.phase.type !== 'finished') return false;
      if (expected && !isDeepStrictEqual(expected, this.#view().head)) return false;
      this.#options.history.closeRollback();
      await publish(this.#capture());
      this.#published = this.#view();
      this.#closed = true;
      this.#cancelTasks();
      return true;
    }, false);
  }

  /** Low-level legacy guard only. Actual starts must use handoff via PostgresLobby. */
  closeForNextMatch(): Promise<boolean> {
    return this.#enqueue(() => {
      if (this.#closed || this.#view().state?.phase.type !== 'finished') return false;
      this.#options.history.closeRollback();
      return true;
    });
  }

  dispose(): Promise<void> {
    return this.#enqueue(() => {
      this.#closed = true;
      this.#cancelTasks();
    }, false);
  }

  #enqueue<T>(job: () => T | Promise<T>, persist = true, faultOnFailure = true): Promise<T> {
    const result = this.#tail.then(async () => {
      if (persist && this.#fault !== null)
        throw new Error('Runtime is faulted', { cause: this.#fault });
      try {
        const value = await job();
        if (persist && !this.#closed) await this.#publish();
        if (this.#schedulePending) {
          this.#schedulePending = false;
          this.#armSchedule();
        }
        return value;
      } catch (error) {
        if (faultOnFailure) {
          this.#fault = error;
          this.#cancelTasks();
        }
        throw error;
      }
    });
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #publish(): Promise<void> {
    const view = this.#view();
    if (this.#options.commit) await this.#options.commit(this.#capture());
    this.#published = view;
  }

  #commit(command: GameCommand, nowMs: number): RuntimeResult {
    if (this.#fault !== null) throw new Error('Runtime is faulted', { cause: this.#fault });
    const snapshot = this.#options.history.read();
    const decision = decide(snapshot.state, command, { nowMs, randomInt: this.#options.randomInt });
    if (decision.type === 'rejected') return { ...decision, head: snapshot.head };
    const appended = this.#options.history.append(snapshot.head, decision.action);
    if (appended.type === 'rejected') throw new Error(`History append rejected: ${appended.code}`);
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
