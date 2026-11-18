import { isDeepStrictEqual } from 'node:util';
import { applyAction } from '../game/engine.ts';
import type { ActionBatch, BranchHead } from '../game/contracts.ts';
import type { CardId, CommandId, SeatId } from '../game/ids.ts';
import type { GameState } from '../game/model.ts';
import { projectGame } from './game.ts';
import type { GameViewer, VisibleCard } from './game.ts';

type Snapshot = Readonly<{ head: BranchHead; state: GameState | null }>;
export type ActionProjectionInput = Readonly<{
  before: Snapshot;
  after: Snapshot;
  action: ActionBatch;
  /** Server-owned delivery classification, not evidence of authentication or commit. */
  delivery: 'fresh' | 'duplicate';
}>;
export type ActionObservation =
  | Readonly<{
      type: 'card-drawn';
      seatId: SeatId;
      destination: 'hand' | 'stump';
      card: VisibleCard | null;
    }>
  | Readonly<{ type: 'draw-rejected'; seatId: SeatId }>
  | Readonly<{ type: 'card-played'; seatId: SeatId; card: VisibleCard }>
  | Readonly<{ type: 'bottom-taken'; seatId: SeatId; card: VisibleCard; automatic: boolean }>
  | Readonly<{ type: 'stump-opened'; seatId: SeatId; card: VisibleCard | null }>
  | Readonly<{ type: 'stump-peeked'; card: VisibleCard }>
  | Readonly<{
      type: 'violation';
      seatId: SeatId;
      reason:
        | 'draw-out-of-turn'
        | 'invalid-beat'
        | 'play-out-of-turn'
        | 'peek'
        | 'must-open-stump'
        | 'claim';
    }>
  | Readonly<{ type: 'penalty-transfer'; fromSeatId: SeatId; toSeatId: SeatId; card: VisibleCard }>;
export type ActionView = Readonly<{
  head: BranchHead;
  commandId: CommandId;
  observations: readonly ActionObservation[];
}>;

/**
 * Project ONE exact committed action pair, never a history/reconnect/rollback feed.
 * Adjacency and deterministic replay validate consistency, not freshness/durability.
 * The server must supply the pair from its committed boundary and mark retries as
 * duplicate. A runtime job can contain multiple actions: do not substitute its
 * overall head/state for an individual action's pair. No intermediate state is returned.
 * Stateless projection cannot itself enforce exactly-once delivery across calls.
 */
export function projectAction(input: ActionProjectionInput, viewer: GameViewer): ActionView {
  const { before, after, action } = input;
  const base = projectGame(after, viewer);
  try {
    const old = before.head;
    const head = after.head;
    if (
      !after.state ||
      old.gameId !== head.gameId ||
      old.branchId !== head.branchId ||
      (before.state && before.state.gameId !== old.gameId) ||
      !Number.isSafeInteger(old.version) ||
      old.version < 0 ||
      !Number.isSafeInteger(head.version) ||
      head.version !== old.version + 1 ||
      (input.delivery !== 'fresh' && input.delivery !== 'duplicate') ||
      !isDeepStrictEqual(applyAction(before.state, action), after.state)
    )
      throw new Error();
  } catch {
    // Replay diagnostics contain private identifiers and must never reach a viewer.
    throw new Error('Invalid action projection context');
  }
  const observations: ActionObservation[] = [];
  const result: ActionView = { head: base.head, commandId: action.commandId, observations };
  if (input.delivery === 'duplicate') return result;
  const state = after.state!;
  const isOwn = (seatId: SeatId) => viewer.type === 'seat' && viewer.seatId === seatId;
  const cardView = (cardId: CardId): VisibleCard => {
    const card = state.cards.find((card) => card.id === cardId);
    if (!card) throw new Error('Projection card unavailable');
    return { id: card.id, face: { suit: card.face.suit, rank: card.face.rank } };
  };
  // A nonzero completion consumes the pre-action penalty's reserved choices.
  // Newly auto-started penalties cannot receive another user response in this action.
  const penalty = before.state?.procedure?.type === 'penalty' ? before.state.procedure : null;
  let responses = { ...penalty?.responses };
  for (const { event } of action.events) {
    switch (event.type) {
      case 'card-drawn':
        observations.push({
          type: 'card-drawn',
          seatId: event.seatId,
          destination: event.destination,
          card: event.destination === 'hand' && isOwn(event.seatId) ? cardView(event.cardId) : null,
        });
        break;
      case 'out-of-turn-draw':
        observations.push({ type: 'draw-rejected', seatId: event.seatId });
        break;
      case 'card-played':
        observations.push({
          type: 'card-played',
          seatId: event.seatId,
          card: cardView(event.cardId),
        });
        break;
      case 'bottom-taken':
        observations.push({
          type: 'bottom-taken',
          seatId: event.seatId,
          card: cardView(event.cardId),
          automatic: event.automatic,
        });
        break;
      case 'stump-opened':
        observations.push({
          type: 'stump-opened',
          seatId: event.seatId,
          card: isOwn(event.seatId) ? cardView(event.cardId) : null,
        });
        break;
      case 'violation-detected':
        observations.push({
          type: 'violation',
          seatId: event.penalty.recipientId,
          reason: event.penalty.reason,
        });
        if (event.peekedCardId !== undefined && isOwn(event.penalty.recipientId))
          observations.push({ type: 'stump-peeked', card: cardView(event.peekedCardId) });
        break;
      case 'penalty-answered':
        if (event.procedureId === penalty?.timer.id)
          responses = { ...responses, [event.seatId]: event.cardId ?? 'refuse' };
        break;
      case 'penalty-completed':
        if (event.procedureId === penalty?.timer.id) {
          for (const donor of penalty.eligibleSeatIds) {
            const cardId = Object.hasOwn(responses, donor) ? responses[donor] : undefined;
            if (
              cardId !== undefined &&
              cardId !== 'refuse' &&
              (isOwn(donor) || isOwn(penalty.penalty.recipientId))
            )
              observations.push({
                type: 'penalty-transfer',
                fromSeatId: donor,
                toSeatId: penalty.penalty.recipientId,
                card: cardView(cardId),
              });
          }
        }
        break;
      // No default event serialization: creation, shuffle, reveal, private
      // reservation, clock/repetition metadata and future events stay server-only.
      default:
        break;
    }
  }
  return result;
}
