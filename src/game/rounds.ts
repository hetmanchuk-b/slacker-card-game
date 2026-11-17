import { canBeat } from './cards.ts';
import { id } from './ids.ts';
import { incidentKey } from './claims.ts';
import type { Decision, DecisionContext, RoundCommand, RoundEvent } from './contracts.ts';
import type { CardId, SeatId } from './ids.ts';
import type { GameState } from './model.ts';

export function decideRoundCommand(
  state: GameState | null,
  command: RoundCommand,
  context: DecisionContext,
): Decision {
  if (state === null) return { type: 'rejected', code: 'not-started' };
  const player = state.players.find((player) => player.id === command.actorId);
  if (!player) return { type: 'rejected', code: 'unknown-seat' };
  if (player.status !== 'active') return { type: 'rejected', code: 'inactive-seat' };
  if (state.procedure !== null) return { type: 'rejected', code: 'procedure-active' };
  if (command.type === 'open-stump') {
    if (state.phase.type === 'finished') return { type: 'rejected', code: 'wrong-phase' };
    if (!player.stumps.includes(command.cardId))
      return { type: 'rejected', code: 'card-not-owned' };
    const event: RoundEvent =
      player.hand.length === 0 && hasOpeningRight(state, player.id)
        ? { type: 'stump-opened', seatId: player.id, cardId: command.cardId }
        : {
            type: 'violation-detected',
            penalty: { incidentId: command.id, recipientId: player.id, reason: 'peek' },
            peekedCardId: command.cardId,
          };
    return roundDecision(command, event, context);
  }
  if (state.phase.type !== 'between-rounds' && state.phase.type !== 'round')
    return { type: 'rejected', code: 'wrong-phase' };
  if (command.type === 'play-card' && !player.hand.includes(command.cardId))
    return { type: 'rejected', code: 'card-not-owned' };
  const turnSeatId = state.phase.type === 'round' ? state.phase.turnSeatId : state.phase.leaderId;
  let event: RoundEvent;
  if (turnSeatId !== command.actorId) {
    event = {
      type: 'violation-detected',
      penalty: { incidentId: command.id, recipientId: command.actorId, reason: 'play-out-of-turn' },
    };
  } else if (
    command.type === 'take-bottom' &&
    player.hand.length === 0 &&
    player.stumps.length > 0 &&
    hasOpeningRight(state, player.id)
  ) {
    event = {
      type: 'violation-detected',
      penalty: { incidentId: command.id, recipientId: player.id, reason: 'must-open-stump' },
    };
  } else if (command.type === 'take-bottom') {
    if (state.phase.type !== 'round' || state.table.length === 0)
      return { type: 'rejected', code: 'empty-table' };
    event = { type: 'bottom-taken', seatId: player.id, cardId: state.table[0]!, automatic: false };
  } else if (
    state.phase.type === 'round' &&
    !canBeat(face(state, state.table.at(-1)!), face(state, command.cardId), state.trump)
  ) {
    event = {
      type: 'violation-detected',
      penalty: { incidentId: command.id, recipientId: command.actorId, reason: 'invalid-beat' },
    };
  } else {
    event = { type: 'card-played', seatId: player.id, cardId: command.cardId };
  }
  return roundDecision(command, event, context);
}

function roundDecision(
  command: RoundCommand,
  event: RoundEvent,
  context: DecisionContext,
): Decision {
  return {
    type: 'accepted',
    outcome: event.type === 'violation-detected' ? 'violation' : 'played',
    action: {
      commandId: command.id,
      occurredAtMs: context.nowMs,
      events: [{ id: id('event', `${command.id}:0`), event }],
    },
  };
}

function face(state: GameState, cardId: CardId) {
  const card = state.cards.find((card) => card.id === cardId);
  if (!card) throw new Error('Unknown card in round');
  return card.face;
}

function nextActive(state: GameState, after: SeatId): SeatId {
  const index = state.players.findIndex((player) => player.id === after);
  if (index === -1) throw new Error('Unknown acting seat');
  for (let offset = 1; offset <= state.players.length; offset++) {
    const player = state.players[(index + offset) % state.players.length]!;
    if (player.status === 'active') return player.id;
  }
  throw new Error('No active seat remains');
}

export function hasOpeningRight(state: GameState, seatId: SeatId): boolean {
  const number =
    state.phase.type === 'round'
      ? state.phase.number
      : state.phase.type === 'between-rounds'
        ? state.phase.nextRoundNumber
        : null;
  return (
    number !== null &&
    state.openingRights.some((right) => right.seatId === seatId && right.throughRound === number)
  );
}

export function automaticRoundEvent(state: GameState): RoundEvent | null {
  if (state.procedure !== null || state.pendingPenalties.length > 0 || state.phase.type !== 'round')
    return null;
  const turnSeatId = state.phase.turnSeatId;
  const player = state.players.find((player) => player.id === turnSeatId)!;
  if (player.hand.length > 0 || (player.stumps.length > 0 && hasOpeningRight(state, player.id)))
    return null;
  return { type: 'bottom-taken', seatId: player.id, cardId: state.table[0]!, automatic: true };
}

export function applyRoundEvent(state: GameState, event: RoundEvent): GameState {
  if (event.type === 'violation-detected') {
    const player = state.players.find((player) => player.id === event.penalty.recipientId);
    if (
      !player ||
      player.status !== 'active' ||
      state.phase.type === 'finished' ||
      state.procedure !== null
    )
      throw new Error('Invalid violation recipient');
    if (
      event.penalty.reason === 'peek' &&
      (!event.peekedCardId || !player.stumps.includes(event.peekedCardId))
    )
      throw new Error('Peek is not an owned stump');
    const peekedStumps =
      event.peekedCardId !== undefined &&
      !state.peekedStumps.some(
        (item) => item.seatId === player.id && item.cardId === event.peekedCardId,
      )
        ? [...state.peekedStumps, { seatId: player.id, cardId: event.peekedCardId }]
        : state.peekedStumps;
    return {
      ...state,
      peekedStumps,
      automaticIncidents: [
        ...new Set([
          ...state.automaticIncidents,
          incidentKey({ type: 'action', commandId: event.penalty.incidentId }),
        ]),
      ],
      pendingPenalties: [...state.pendingPenalties, { ...event.penalty }],
    };
  }
  if (state.procedure !== null) throw new Error('Cannot play during a procedure');
  const player = state.players.find((player) => player.id === event.seatId);
  if (!player || player.status !== 'active') throw new Error('Round actor is not active');
  if (event.type === 'stump-opened') {
    if (
      player.hand.length !== 0 ||
      !hasOpeningRight(state, player.id) ||
      !player.stumps.includes(event.cardId)
    )
      throw new Error('Stump is not legally available');
    return {
      ...state,
      players: state.players.map((item) =>
        item.id !== player.id
          ? item
          : {
              ...item,
              hand: [event.cardId],
              stumps: item.stumps.filter((card) => card !== event.cardId),
            },
      ),
      openingRights: state.openingRights.filter((right) => right.seatId !== player.id),
    };
  }
  if (event.type === 'card-played') {
    const phase = state.phase;
    if (phase.type !== 'between-rounds' && phase.type !== 'round')
      throw new Error('Play outside a round');
    const turn = phase.type === 'round' ? phase.turnSeatId : phase.leaderId;
    if (turn !== player.id || !player.hand.includes(event.cardId))
      throw new Error('Illegal recorded card play');
    if (
      phase.type === 'round' &&
      !canBeat(face(state, state.table.at(-1)!), face(state, event.cardId), state.trump)
    )
      throw new Error('Recorded card does not beat top');
    const participantIds =
      phase.type === 'round'
        ? phase.participantIds
        : state.players.filter((player) => player.status === 'active').map((player) => player.id);
    const next: GameState = {
      ...state,
      table: [...state.table, event.cardId],
      players: state.players.map((item) =>
        item.id === player.id
          ? { ...item, hand: item.hand.filter((card) => card !== event.cardId) }
          : item,
      ),
      phase: {
        type: 'round',
        number: phase.type === 'round' ? phase.number : phase.nextRoundNumber,
        participantIds: [...participantIds],
        targetSize: participantIds.length,
        turnSeatId: nextActive(state, player.id),
      },
    };
    return next.table.length === participantIds.length ? finishRound(next, player.id, true) : next;
  }
  if (
    state.phase.type !== 'round' ||
    state.phase.turnSeatId !== player.id ||
    state.table[0] !== event.cardId
  )
    throw new Error('Illegal recorded bottom pickup');
  if (player.hand.length === 0 && player.stumps.length > 0 && hasOpeningRight(state, player.id))
    throw new Error('Must open a stump before taking');
  if (event.automatic && player.hand.length !== 0) throw new Error('Invalid automatic pickup');
  const next = {
    ...state,
    table: state.table.slice(1),
    players: state.players.map((item) =>
      item.id === player.id ? { ...item, hand: [...item.hand, event.cardId] } : item,
    ),
    phase: { ...state.phase, turnSeatId: nextActive(state, player.id) },
  };
  return next.table.length === 0 ? finishRound(next, player.id, false) : next;
}

function finishRound(state: GameState, actorId: SeatId, discarded: boolean): GameState {
  if (state.phase.type !== 'round') throw new Error('Cannot finish an inactive round');
  const players = state.players.map((player) =>
    player.hand.length === 0 && player.stumps.length === 0
      ? { ...player, status: 'won' as const }
      : player,
  );
  const next: GameState = {
    ...state,
    players,
    table: [],
    discard: discarded ? [...state.discard, ...state.table] : state.discard,
    completedRounds: state.phase.number,
    openingRights: [],
  };
  const active = players.filter((player) => player.status === 'active');
  if (active.length === 0)
    return { ...next, phase: { type: 'finished', result: { type: 'all-won' } } };
  if (active.length === 1)
    return {
      ...next,
      phase: { type: 'finished', result: { type: 'last-player', loserId: active[0]!.id } },
    };
  const leaderId =
    discarded && active.some((player) => player.id === actorId)
      ? actorId
      : nextActive(next, actorId);
  return enterBetweenRounds(next, leaderId);
}

export function enterBetweenRounds(state: GameState, leaderId: SeatId): GameState {
  const active = state.players.filter((player) => player.status === 'active');
  return {
    ...state,
    phase: { type: 'between-rounds', leaderId, nextRoundNumber: state.completedRounds + 1 },
    openingRights: active
      .filter((player) => player.hand.length === 0 && player.stumps.length > 0)
      .map((player) => ({ seatId: player.id, throughRound: state.completedRounds + 1 })),
  };
}
