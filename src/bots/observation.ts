import type { SeatId } from '../game/ids.ts';
import type { GameState } from '../game/model.ts';
import type { RuntimeSnapshot } from '../runtime/runtime.ts';
import { projectLiveGame } from '../projections/live.ts';
import type { LiveGameView } from '../projections/live.ts';
import { projectAction } from '../projections/actions.ts';
import type { ActionProjectionInput, ActionView } from '../projections/actions.ts';

/** Policy inputs contain only detached, seat-authorized projections. */
export type BotCurrentObservation = LiveGameView;
export type BotActionObservation = ActionView;

function bindSeat(state: GameState | null, seatId: SeatId): void {
  if (!state?.players.some((player) => player.id === seatId)) throw new Error('Invalid bot seat');
}

/**
 * Trusted server adapter, not a policy callback. Supply a committed snapshot and
 * server time. Entitlement is availability to the seat, not network receipt or
 * proof a human saw it. Finished seats retain only their usual seat visibility.
 * Null state has no seat binding and must instead invalidate downstream work.
 */
export function observeBotCurrent(
  snapshot: RuntimeSnapshot,
  seatId: SeatId,
  nowMs: number,
): BotCurrentObservation {
  bindSeat(snapshot.state, seatId);
  return projectLiveGame(snapshot, { type: 'seat', seatId }, nowMs);
}

/**
 * Supply exactly one committed action pair, freshly captured for this seat.
 * `delivery` classifies capture freshness, NOT socket delivery. Duplicate captures
 * disclose nothing; recovery/resync/rollback must not replay history as fresh.
 * This pure adapter cannot prove commit/freshness or provide deduplication/memory.
 * Never pass the trusted input itself to a policy.
 */
export function observeBotAction(
  input: ActionProjectionInput,
  seatId: SeatId,
): BotActionObservation {
  bindSeat(input.after.state, seatId);
  return projectAction(input, { type: 'seat', seatId });
}
