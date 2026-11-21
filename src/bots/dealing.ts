import type { BotMemory } from './memory.ts';
import type { BotCurrentObservation } from './observation.ts';

/** Unknown order deliberately waits, even if no participant can advance it. */
export function chooseDealingDraw(view: BotCurrentObservation, memory: BotMemory): boolean {
  const own = view.state?.own;
  return !!(
    own &&
    view.state?.phase.type === 'dealing' &&
    view.state.deckCount > 0 &&
    !view.control.paused &&
    view.procedure === null &&
    view.control.connections.some((p) => p.seatId === own.seatId && p.controller === 'bot') &&
    memory.gameId === view.head.gameId &&
    memory.seatId === own.seatId &&
    memory.head?.branchId === view.head.branchId &&
    memory.head.version === view.head.version &&
    (view.transient.initialRecipientNotice || memory.dealing?.nextSeatId === own.seatId)
  );
}
