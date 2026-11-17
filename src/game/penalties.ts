import { id } from './ids.ts';
import { enterBetweenRounds } from './rounds.ts';
import type {
  Decision,
  DecisionContext,
  PenaltyCommand,
  PenaltyEvent,
  RejectionCode,
} from './contracts.ts';
import type { CardId, ProcedureId, SeatId } from './ids.ts';
import type { GameState, Timer } from './model.ts';

type PenaltyProcedure = Extract<NonNullable<GameState['procedure']>, { type: 'penalty' }>;

export function automaticPenaltyEvent(
  state: GameState,
  procedureId: ProcedureId,
): PenaltyEvent | null {
  const procedure = state.procedure;
  if (
    procedure?.type === 'penalty' &&
    procedure.eligibleSeatIds.every((seat) => answer(procedure, seat) !== undefined)
  ) {
    return { type: 'penalty-completed', procedureId: procedure.timer.id };
  }
  if (
    state.procedure !== null ||
    state.pendingPenalties.length === 0 ||
    state.phase.type === 'dealing' ||
    state.phase.type === 'trump-reveal' ||
    state.phase.type === 'finished'
  )
    return null;
  const pending = state.pendingPenalties[0]!;
  if (
    pending.reason === 'claim' &&
    state.claims.some(
      (record) => record.claim.commandId === pending.incidentId && record.withdrawalRequested,
    )
  )
    return null;
  return { type: 'penalty-started', procedureId };
}

function answer(procedure: PenaltyProcedure, seatId: SeatId): CardId | 'refuse' | undefined {
  return Object.hasOwn(procedure.responses, seatId) ? procedure.responses[seatId] : undefined;
}

function due(timer: Timer, nowMs: number): boolean {
  return timer.startedAtMs !== null && nowMs - timer.startedAtMs >= timer.remainingMs;
}

function responseError(
  state: GameState,
  procedure: PenaltyProcedure,
  seatId: SeatId,
  cardId: CardId | null,
): RejectionCode | null {
  if (!procedure.eligibleSeatIds.includes(seatId)) return 'not-eligible';
  if (answer(procedure, seatId) !== undefined) return 'already-answered';
  if (cardId !== null) {
    const player = state.players.find((player) => player.id === seatId)!;
    if (!player.hand.includes(cardId)) return 'card-not-owned';
    if (player.hand.length <= 1) return 'last-card-protected';
  }
  return null;
}

export function decidePenaltyCommand(
  state: GameState | null,
  command: PenaltyCommand,
  context: DecisionContext,
): Decision {
  if (state === null) return { type: 'rejected', code: 'not-started' };
  const procedure = state.procedure;
  if (procedure?.type !== 'penalty') return { type: 'rejected', code: 'wrong-phase' };
  const procedureId = command.type === 'expire-penalty' ? command.timerId : command.procedureId;
  if (procedureId !== procedure.timer.id) return { type: 'rejected', code: 'stale-timer' };
  let event: PenaltyEvent;
  if (command.type === 'expire-penalty') {
    if (!due(procedure.timer, context.nowMs)) return { type: 'rejected', code: 'timer-not-due' };
    event = { type: 'penalty-expired', procedureId };
  } else {
    if (procedure.timer.startedAtMs === null) return { type: 'rejected', code: 'procedure-active' };
    if (context.nowMs < procedure.timer.startedAtMs)
      return { type: 'rejected', code: 'invalid-time' };
    if (due(procedure.timer, context.nowMs)) return { type: 'rejected', code: 'timer-expired' };
    const error = responseError(state, procedure, command.actorId, command.cardId);
    if (error) return { type: 'rejected', code: error };
    event = {
      type: 'penalty-answered',
      procedureId,
      seatId: command.actorId,
      cardId: command.cardId,
    };
  }
  return {
    type: 'accepted',
    outcome: 'played',
    action: {
      commandId: command.id,
      occurredAtMs: context.nowMs,
      events: [{ id: id('event', `${command.id}:0`), event }],
    },
  };
}

export function applyPenaltyEvent(state: GameState, event: PenaltyEvent, nowMs: number): GameState {
  if (event.type === 'penalty-started') {
    if (
      state.procedure !== null ||
      state.pendingPenalties.length === 0 ||
      state.phase.type === 'dealing' ||
      state.phase.type === 'trump-reveal' ||
      state.phase.type === 'finished'
    )
      throw new Error('Cannot start this penalty');
    const penalty = state.pendingPenalties[0]!;
    return {
      ...state,
      pendingPenalties: state.pendingPenalties.slice(1),
      claims: state.claims.map((record) =>
        penalty.reason === 'claim' && record.claim.commandId === penalty.incidentId
          ? { ...record, punishmentStarted: true }
          : record,
      ),
      procedure: {
        type: 'penalty',
        penalty: { ...penalty },
        eligibleSeatIds: state.players
          .filter((player) => player.status === 'active' && player.id !== penalty.recipientId)
          .map((player) => player.id),
        responses: {},
        timer: { id: event.procedureId, remainingMs: 10000, startedAtMs: nowMs },
      },
    };
  }
  const procedure = state.procedure;
  if (procedure?.type !== 'penalty' || procedure.timer.id !== event.procedureId)
    throw new Error('No matching penalty');
  if (event.type === 'penalty-answered') {
    if (
      procedure.timer.startedAtMs === null ||
      nowMs < procedure.timer.startedAtMs ||
      due(procedure.timer, nowMs) ||
      responseError(state, procedure, event.seatId, event.cardId)
    )
      throw new Error('Invalid penalty response');
    return {
      ...state,
      procedure: {
        ...procedure,
        responses: { ...procedure.responses, [event.seatId]: event.cardId ?? 'refuse' },
      },
    };
  }
  if (event.type === 'penalty-expired') {
    if (!due(procedure.timer, nowMs)) throw new Error('Penalty timer is not due');
    return {
      ...state,
      procedure: {
        ...procedure,
        responses: Object.fromEntries(
          procedure.eligibleSeatIds.map((seat) => [seat, answer(procedure, seat) ?? 'refuse']),
        ),
      },
    };
  }
  if (!procedure.eligibleSeatIds.every((seat) => answer(procedure, seat) !== undefined))
    throw new Error('Penalty still awaits responses');
  const incoming = procedure.eligibleSeatIds.flatMap((seat) => {
    const response = answer(procedure, seat);
    return response !== undefined && response !== 'refuse' ? [response] : [];
  });
  for (const seatId of procedure.eligibleSeatIds) {
    const response = answer(procedure, seatId);
    if (response !== undefined && response !== 'refuse') {
      const player = state.players.find((player) => player.id === seatId)!;
      if (player.hand.length < 2 || !player.hand.includes(response))
        throw new Error('Invalid reserved contribution');
    }
  }
  const next: GameState = {
    ...state,
    procedure: null,
    players: state.players.map((player) =>
      player.id === procedure.penalty.recipientId
        ? { ...player, hand: [...player.hand, ...incoming] }
        : {
            ...player,
            hand: player.hand.filter((card) => card !== answer(procedure, player.id)),
          },
    ),
  };
  return state.phase.type === 'pre-game-penalties' && state.pendingPenalties.length === 0
    ? enterBetweenRounds(next, state.phase.firstLeaderId)
    : next;
}
