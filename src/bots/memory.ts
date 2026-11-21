import type { BranchHead } from '../game/contracts.ts';
import type { GameId, SeatId } from '../game/ids.ts';
import type { Card } from '../game/cards.ts';
import type { BotActionObservation, BotCurrentObservation } from './observation.ts';

type Source = Readonly<{ head: BranchHead }>;
export type BotMemory = Readonly<{
  gameId: GameId;
  seatId: SeatId;
  head: BranchHead | null;
  trump: (Source & Readonly<{ suit: Card['suit'] | null }>) | null;
  dealing: (Source & Readonly<{ nextSeatId: SeatId; successfulDraws: number | null }>) | null;
  opening: (Source & Readonly<{ round: number; available: boolean }>) | null;
  phase: string | null;
}>;

export function createBotMemory(gameId: GameId, seatId: SeatId): BotMemory {
  return { gameId, seatId, head: null, trump: null, dealing: null, opening: null, phase: null };
}

/** Pure reducer of permitted observations only, independent of controller type.
 * Call once per committed head with its matching action projection, then for
 * same-head current timer/reveal updates. Missing action history stays unknown.
 * Inputs are trusted adapter outputs, never authoritative state/history.
 */
export function rememberBotObservation(
  memory: BotMemory,
  current: BotCurrentObservation,
  action?: BotActionObservation,
): BotMemory {
  const { head, state } = current;
  const old = memory.head;
  if (
    head.gameId !== memory.gameId ||
    state?.own?.seatId !== memory.seatId ||
    (old && (head.branchId !== old.branchId || head.version < old.version)) ||
    (action &&
      (action.head.gameId !== head.gameId ||
        action.head.branchId !== head.branchId ||
        action.head.version !== head.version))
  )
    throw new Error('Invalid memory context');
  const same = old?.version === head.version;
  const adjacent = old !== null && head.version === old.version + 1;
  // An empty ActionView may be a duplicate-redacted capture, not proof that
  // nothing happened. Without a positive capture, continuity is unknown.
  const complete = action && action.observations.length > 0;
  let dealing = same || (adjacent && complete) ? memory.dealing : null;
  let opening = same || (adjacent && complete) ? memory.opening : null;
  let trump = memory.trump;
  const phase = state.phase;
  const round =
    phase.type === 'round'
      ? phase.number
      : phase.type === 'between-rounds'
        ? phase.nextRoundNumber
        : null;
  const phaseKey = `${phase.type}:${round ?? ''}`;
  if (!same && phase.type === 'between-rounds' && memory.phase !== phaseKey) {
    // Only the observable empty-hand boundary establishes entitlement. If an
    // intermediate boundary was missed, do not infer rights from later hands.
    const exactBoundary =
      adjacent &&
      memory.phase === `round:${phase.nextRoundNumber - 1}` &&
      action &&
      action.observations.length > 0 &&
      action.observations.every((item) => item.type === 'card-played');
    opening =
      exactBoundary && state.own.hand.length === 0 && state.own.stumps.length > 0
        ? { head, round: phase.nextRoundNumber, available: true }
        : null;
  }
  if (opening && opening.round !== round) opening = null;
  if (!same && action) {
    for (const observation of action.observations) {
      if (observation.type === 'card-drawn' && phase.type === 'dealing') {
        const index = state.players.findIndex((player) => player.id === observation.seatId);
        const nextSeatId = state.players[(index + 1) % state.players.length]!.id;
        dealing = {
          head,
          nextSeatId,
          successfulDraws:
            dealing?.successfulDraws === undefined || dealing.successfulDraws === null
              ? null
              : dealing.successfulDraws + 1,
        };
      }
      if (
        observation.type === 'card-drawn' &&
        observation.destination === 'hand' &&
        observation.seatId === memory.seatId &&
        observation.card &&
        state.deckCount === 0 &&
        phase.type === 'trump-reveal'
      ) {
        const suit = observation.card.face.suit;
        trump = { head, suit: suit === 'spades' ? null : suit };
      }
      if (
        observation.type === 'stump-opened' &&
        observation.seatId === memory.seatId &&
        round !== null
      )
        opening = { head, round, available: false };
    }
  }
  if (phase.type === 'dealing' && current.transient.initialRecipientNotice && !dealing)
    dealing = { head, nextSeatId: memory.seatId, successfulDraws: 0 };
  if (phase.type !== 'dealing') dealing = null;
  if (current.transient.reveal) {
    const suit = current.transient.reveal.card.face.suit;
    trump = { head, suit: suit === 'spades' ? null : suit };
  }
  return structuredClone({ ...memory, head, trump, dealing, opening, phase: phaseKey });
}

/** Restore an exact previously captured permitted checkpoint at the fork target.
 * The caller owns target/checkpoint provenance; this function cannot authenticate
 * ancestry. Never supply a later checkpoint or enrich it from private history.
 * Empty memory represents missing knowledge, including rollback before creation.
 */
export function restoreBotMemory(checkpoint: BotMemory, target: BranchHead): BotMemory {
  if (
    checkpoint.gameId !== target.gameId ||
    (checkpoint.head && checkpoint.head.version !== target.version)
  )
    throw new Error('Invalid memory context');
  return structuredClone({ ...checkpoint, head: target });
}
