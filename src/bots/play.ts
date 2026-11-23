import { canBeat } from '../game/cards.ts';
import type { Trump } from '../game/cards.ts';
import type { RoundCommand } from '../game/contracts.ts';
import type { BotMemory } from './memory.ts';
import type { BotCurrentObservation } from './observation.ts';

type PlayChoice =
  | Pick<Extract<RoundCommand, { type: 'play-card' | 'open-stump' }>, 'type' | 'cardId'>
  | Readonly<{ type: 'take-bottom' }>;

/** First provably legal move, never a probe for missing knowledge. */
export function chooseRoundPlay(view: BotCurrentObservation, memory: BotMemory): PlayChoice | null {
  const state = view.state;
  const own = state?.own;
  if (
    !own ||
    !state ||
    view.control.paused ||
    view.procedure !== null ||
    !view.control.connections.some((p) => p.seatId === own.seatId && p.controller === 'bot') ||
    !state.players.some((p) => p.id === own.seatId && p.status === 'active') ||
    memory.gameId !== view.head.gameId ||
    memory.seatId !== own.seatId ||
    memory.head?.branchId !== view.head.branchId ||
    memory.head.version !== view.head.version
  )
    return null;
  const phase = state.phase;
  if (phase.type !== 'round' && phase.type !== 'between-rounds') return null;
  const turn = phase.type === 'round' ? phase.turnSeatId : phase.leaderId;
  if (turn !== own.seatId) return null;
  const round = phase.type === 'round' ? phase.number : phase.nextRoundNumber;
  if (own.hand.length === 0) {
    // Unknown rights deliberately wait, possibly indefinitely. Empty turns
    // without an entitlement are normalized by the server, not this policy.
    return own.stumps[0] && memory.opening?.round === round && memory.opening.available
      ? { type: 'open-stump', cardId: own.stumps[0] }
      : null;
  }
  const top = state.table.at(-1);
  const trumps: readonly Trump[] =
    memory.trump && memory.trump.suit !== 'spades'
      ? [memory.trump.suit]
      : [null, 'clubs', 'diamonds', 'hearts'];
  const card = own.hand.find(
    (card) =>
      phase.type === 'between-rounds' ||
      (top && trumps.every((trump) => canBeat(top.face, card.face, trump))),
  );
  if (card) return { type: 'play-card', cardId: card.id };
  return phase.type === 'round' && top ? { type: 'take-bottom' } : null;
}
