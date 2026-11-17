import type { DomainEvent } from './contracts.ts';
import type { GameState } from './model.ts';

type RepetitionEvent = Extract<DomainEvent, { type: 'repetition-checked' }>;

/** Server-only key: includes private hands and must never enter public history. */
function meaningfulKey(state: GameState): string | null {
  if (
    (state.phase.type !== 'between-rounds' && state.phase.type !== 'round') ||
    state.procedure !== null ||
    state.pendingPenalties.length !== 0
  )
    return null;
  const phase =
    state.phase.type === 'round'
      ? {
          type: 'round',
          participantIds: state.phase.participantIds,
          targetSize: state.phase.targetSize,
          turnSeatId: state.phase.turnSeatId,
        }
      : { type: 'between-rounds', leaderId: state.phase.leaderId };
  return JSON.stringify({
    phase,
    table: [...state.table],
    players: state.players.map((player) => ({
      id: player.id,
      status: player.status,
      hand: [...player.hand].sort(),
      stumps: [...player.stumps],
    })),
    discard: [...state.discard].sort(),
    trump: state.trump,
    openingRights: state.players.map((player) =>
      state.openingRights.some(
        (right) => right.seatId === player.id && right.throughRound === state.completedRounds + 1,
      ),
    ),
  });
}

/** Called only after other automatic consequences have settled. No-op procedures do not add occurrences. */
export function automaticRepetitionEvent(state: GameState): RepetitionEvent | null {
  const key = meaningfulKey(state);
  return key !== null && key !== state.lastRepetitionKey ? { type: 'repetition-checked' } : null;
}

export function recordRepetition(state: GameState): GameState {
  const key = meaningfulKey(state);
  if (key === null || key === state.lastRepetitionKey)
    throw new Error('Repetition requires a new settled gameplay state');
  const count = (state.repetitions[key] ?? 0) + 1;
  const next = {
    ...state,
    repetitions: { ...state.repetitions, [key]: count },
    lastRepetitionKey: key,
  };
  if (count < 3) return next;
  return {
    ...next,
    phase: {
      type: 'finished',
      result: {
        type: 'draw',
        remainingSeatIds: state.players
          .filter((player) => player.status === 'active')
          .map((player) => player.id),
      },
    },
  };
}
