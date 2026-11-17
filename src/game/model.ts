import type { Card, Trump } from './cards.ts';
import type { CardId, ClaimId, CommandId, GameId, ProcedureId, SeatId } from './ids.ts';

export type GameCard = Readonly<{ id: CardId; face: Card }>;
export type Player = Readonly<{
  id: SeatId;
  hand: readonly CardId[];
  stumps: readonly CardId[];
  status: 'active' | 'won';
}>;

/** startedAtMs=null means suspended; remainingMs is captured on suspension. */
export type Timer = Readonly<{
  id: ProcedureId;
  remainingMs: number;
  startedAtMs: number | null;
}>;

export type Vote = 'yes' | 'no' | 'abstain';
export type IncidentReference =
  | Readonly<{ type: 'spoken'; key: string }>
  | Readonly<{ type: 'chat'; messageId: string }>
  | Readonly<{ type: 'action'; commandId: CommandId }>;

export type Claim = Readonly<{
  id: ClaimId;
  commandId: CommandId;
  incident: IncidentReference;
  claimantId: SeatId;
  accusedId: SeatId;
  reason: string;
  scope: 'dealing' | 'between-rounds' | 'round';
  scopeNumber: number;
  incidentKey: string;
}>;

export type ClaimResolution = 'pending' | 'upheld' | 'rejected' | 'tied' | 'withdrawn';
export type ClaimRecord = Readonly<{
  claim: Claim;
  resolution: ClaimResolution;
  withdrawalRequested: boolean;
  punishmentStarted: boolean;
}>;

export type ClaimVote = Readonly<{
  type: 'claim-vote';
  claim: Claim;
  eligibleSeatIds: readonly SeatId[];
  votes: Readonly<Partial<Record<SeatId, Vote>>>;
  timer: Timer;
}>;

export type Penalty = Readonly<{
  incidentId: CommandId;
  recipientId: SeatId;
  reason:
    'draw-out-of-turn' | 'invalid-beat' | 'play-out-of-turn' | 'peek' | 'must-open-stump' | 'claim';
}>;

/** Nested procedures preserve the gameplay phase they interrupt. */
export type Procedure =
  | ClaimVote
  | Readonly<{
      type: 'withdrawal';
      claim: Claim;
      eligibleSeatIds: readonly SeatId[];
      approvals: Readonly<Partial<Record<SeatId, boolean>>>;
      suspendedVote: ClaimVote | null;
      timer: Timer;
    }>
  | Readonly<{
      type: 'penalty';
      penalty: Penalty;
      eligibleSeatIds: readonly SeatId[];
      responses: Readonly<Partial<Record<SeatId, CardId | 'refuse'>>>;
      timer: Timer;
    }>;

export type MatchResult =
  | Readonly<{ type: 'last-player'; loserId: SeatId }>
  | Readonly<{ type: 'all-won' }>
  | Readonly<{ type: 'draw'; remainingSeatIds: readonly SeatId[] }>;

export type Phase =
  | Readonly<{ type: 'dealing'; nextSeatId: SeatId; drawCount: number }>
  | Readonly<{ type: 'trump-reveal'; cardId: CardId; recipientId: SeatId; timer: Timer }>
  | Readonly<{ type: 'pre-game-penalties'; firstLeaderId: SeatId }>
  | Readonly<{ type: 'between-rounds'; leaderId: SeatId; nextRoundNumber: number }>
  | Readonly<{
      type: 'round';
      number: number;
      participantIds: readonly SeatId[];
      targetSize: number;
      turnSeatId: SeatId;
    }>
  | Readonly<{ type: 'finished'; result: MatchResult }>;

/** Server-only state, NOT a network payload. Array order defines clockwise seat order. */
export type GameState = Readonly<{
  schemaVersion: 1;
  gameId: GameId;
  ownerId: SeatId;
  createdAtMs: number;
  cards: readonly GameCard[];
  players: readonly Player[];
  deck: readonly CardId[];
  table: readonly CardId[];
  discard: readonly CardId[];
  trump: Trump;
  phase: Phase;
  procedure: Procedure | null;
  pendingPenalties: readonly Penalty[];
  claims: readonly ClaimRecord[];
  automaticIncidents: readonly string[];
  completedRounds: number;
  openingRights: readonly Readonly<{ seatId: SeatId; throughRound: number }>[];
  repetitions: Readonly<Record<string, number>>;
  lastRepetitionKey: string | null;
  peekedStumps: readonly Readonly<{ seatId: SeatId; cardId: CardId }>[];
}>;

/** Live presence is external to rollbackable GameState. */
export type ConnectionSuspension = Readonly<{
  absentSeats: readonly Readonly<{ seatId: SeatId; disconnectedAtMs: number }>[];
  replacementVote: Readonly<{
    absentSeatId: SeatId;
    eligibleSeatIds: readonly SeatId[];
    votes: Readonly<Partial<Record<SeatId, Vote>>>;
    timer: Timer;
  }> | null;
}>;
