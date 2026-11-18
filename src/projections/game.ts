import type { Card } from '../game/cards.ts';
import type { BranchHead } from '../game/contracts.ts';
import type { CardId, SeatId } from '../game/ids.ts';
import type { GameState, Phase } from '../game/model.ts';

/** Trusted server binding, never a client-supplied authorization credential. */
export type GameViewer = Readonly<{ type: 'seat'; seatId: SeatId }> | Readonly<{ type: 'public' }>;

export type VisibleCard = Readonly<{ id: CardId; face: Card }>;
export type VisibleResult =
  | Readonly<{ type: 'last-player'; loserId: SeatId }>
  | Readonly<{ type: 'all-won' }>
  | Readonly<{ type: 'draw'; remainingSeatIds: readonly SeatId[] }>;

/** Baseline only: transient disclosures and procedure/control views are separate future work. */
export type VisiblePhase =
  | Readonly<{ type: 'dealing' | 'trump-reveal' | 'pre-game-penalties' }>
  | Readonly<{ type: 'between-rounds'; leaderId: SeatId; nextRoundNumber: number }>
  | Readonly<{ type: 'round'; number: number; targetSize: number; turnSeatId: SeatId }>
  | Readonly<{ type: 'finished'; result: VisibleResult }>;

export type CurrentGameView = Readonly<{
  viewer:
    | Readonly<{ type: 'participant' | 'finished-player'; seatId: SeatId }>
    | Readonly<{ type: 'spectator' }>;
  players: readonly Readonly<{
    id: SeatId;
    status: 'active' | 'won';
    handCount: number;
    stumpCount: number;
  }>[];
  own: Readonly<{
    seatId: SeatId;
    hand: readonly VisibleCard[];
    /** Only the bound seat's command handles; no closed stump faces. */
    stumps: readonly CardId[];
  }> | null;
  deckCount: number;
  table: readonly VisibleCard[];
  discardCount: number;
  phase: VisiblePhase;
}>;

export type GameView = Readonly<{ head: BranchHead; state: CurrentGameView | null }>;

function phaseView(phase: Phase): VisiblePhase {
  switch (phase.type) {
    case 'dealing':
    case 'trump-reveal':
    case 'pre-game-penalties':
      return { type: phase.type };
    case 'between-rounds':
      return { type: phase.type, leaderId: phase.leaderId, nextRoundNumber: phase.nextRoundNumber };
    case 'round':
      return {
        type: phase.type,
        number: phase.number,
        targetSize: phase.targetSize,
        turnSeatId: phase.turnSeatId,
      };
    case 'finished': {
      const result = phase.result;
      switch (result.type) {
        case 'last-player':
          return { type: 'finished', result: { type: result.type, loserId: result.loserId } };
        case 'all-won':
          return { type: 'finished', result: { type: result.type } };
        case 'draw':
          return {
            type: 'finished',
            result: { type: result.type, remainingSeatIds: [...result.remainingSeatIds] },
          };
      }
    }
  }
}

/**
 * Pure allowlisted baseline view of a committed server snapshot.
 * The caller authenticates viewers and supplies opaque, face-independent card IDs.
 * Owner status grants no additional visibility here. This is not a bot memory,
 * history, transient reveal, or complete transport/resync payload.
 */
export function projectGame(
  snapshot: Readonly<{ head: BranchHead; state: GameState | null }>,
  viewer: GameViewer,
): GameView {
  const { state } = snapshot;
  const head: BranchHead = {
    gameId: snapshot.head.gameId,
    branchId: snapshot.head.branchId,
    version: snapshot.head.version,
  };
  if (state === null) return { head, state: null };
  if (state.gameId !== head.gameId) throw new Error('Projection game mismatch');
  const own =
    viewer.type === 'seat' ? state.players.find((player) => player.id === viewer.seatId) : null;
  if (viewer.type === 'seat' && !own) throw new Error('Unknown viewer seat');
  const cardView = (cardId: CardId): VisibleCard => {
    const card = state.cards.find((card) => card.id === cardId);
    if (!card) throw new Error('Projection card unavailable');
    return { id: card.id, face: { suit: card.face.suit, rank: card.face.rank } };
  };
  return {
    head,
    state: {
      viewer: own
        ? { type: own.status === 'active' ? 'participant' : 'finished-player', seatId: own.id }
        : { type: 'spectator' },
      players: state.players.map((player) => ({
        id: player.id,
        status: player.status,
        handCount: player.hand.length,
        stumpCount: player.stumps.length,
      })),
      own: own ? { seatId: own.id, hand: own.hand.map(cardView), stumps: [...own.stumps] } : null,
      deckCount: state.deck.length,
      table: state.table.map(cardView),
      discardCount: state.discard.length,
      phase: phaseView(state.phase),
    },
  };
}
