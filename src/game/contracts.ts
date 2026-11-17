import type {
  BranchId,
  CardId,
  ClaimId,
  CommandId,
  EventId,
  GameId,
  ProcedureId,
  SeatId,
} from './ids.ts';
import type {
  Claim,
  ClaimResolution,
  GameCard,
  GameState,
  IncidentReference,
  Penalty,
  Vote,
} from './model.ts';

/** Internal commands. Transport must bind trusted identity before constructing these. */
export type StartGame = Readonly<{
  type: 'start-game';
  id: CommandId;
  gameId: GameId;
  ownerId: SeatId;
  seatIds: readonly SeatId[];
  cardIds: readonly CardId[];
}>;

export type DrawCard = Readonly<{ type: 'draw-card'; id: CommandId; actorId: SeatId }>;
export type ExpireReveal = Readonly<{ type: 'expire-reveal'; id: CommandId; timerId: ProcedureId }>;
export type RoundCommand =
  | Readonly<{ type: 'play-card'; id: CommandId; actorId: SeatId; cardId: CardId }>
  | Readonly<{ type: 'take-bottom'; id: CommandId; actorId: SeatId }>
  | Readonly<{ type: 'open-stump'; id: CommandId; actorId: SeatId; cardId: CardId }>;
export type PenaltyCommand =
  | Readonly<{
      type: 'penalty-response';
      id: CommandId;
      actorId: SeatId;
      procedureId: ProcedureId;
      cardId: CardId | null;
    }>
  | Readonly<{ type: 'expire-penalty'; id: CommandId; timerId: ProcedureId }>;
export type SubmitClaim = Readonly<{
  type: 'submit-claim';
  id: CommandId;
  actorId: SeatId;
  accusedId: SeatId;
  reason: string;
  incident: IncidentReference;
  scope: Claim['scope'];
  scopeNumber: number;
}>;
export type WithdrawalCommand =
  | Readonly<{ type: 'request-withdrawal'; id: CommandId; actorId: SeatId; claimId: ClaimId }>
  | Readonly<{
      type: 'withdrawal-response';
      id: CommandId;
      actorId: SeatId;
      procedureId: ProcedureId;
      approve: boolean;
    }>
  | Readonly<{ type: 'expire-withdrawal'; id: CommandId; timerId: ProcedureId }>;
export type ClaimCommand =
  | SubmitClaim
  | WithdrawalCommand
  | Readonly<{
      type: 'cast-vote';
      id: CommandId;
      actorId: SeatId;
      procedureId: ProcedureId;
      vote: Vote;
    }>
  | Readonly<{ type: 'expire-claim-vote'; id: CommandId; timerId: ProcedureId }>;
export type ClockCommand =
  | Readonly<{ type: 'suspend-clock'; id: CommandId }>
  | Readonly<{ type: 'resume-clock'; id: CommandId }>;
export type GameCommand =
  StartGame | DrawCard | ExpireReveal | RoundCommand | PenaltyCommand | ClaimCommand | ClockCommand;

export type WithdrawalEvent =
  | Readonly<{ type: 'withdrawal-requested'; claimId: ClaimId; seatId: SeatId }>
  | Readonly<{ type: 'withdrawal-started'; claimId: ClaimId; procedureId: ProcedureId }>
  | Readonly<{
      type: 'withdrawal-answered';
      procedureId: ProcedureId;
      seatId: SeatId;
      approve: boolean;
    }>
  | Readonly<{ type: 'withdrawal-expired'; procedureId: ProcedureId }>
  | Readonly<{ type: 'withdrawal-resolved'; claimId: ClaimId; approved: boolean }>;

export type ClaimEvent =
  | Readonly<{ type: 'reveal-resumed'; timerId: ProcedureId }>
  | WithdrawalEvent
  | Readonly<{ type: 'claim-submitted'; claim: Claim }>
  | Readonly<{ type: 'claim-vote-started'; claimId: ClaimId; procedureId: ProcedureId }>
  | Readonly<{ type: 'claim-vote-cast'; procedureId: ProcedureId; seatId: SeatId; vote: Vote }>
  | Readonly<{ type: 'claim-vote-expired'; procedureId: ProcedureId }>
  | Readonly<{
      type: 'claim-vote-resolved';
      claimId: ClaimId;
      resolution: Exclude<ClaimResolution, 'pending' | 'withdrawn'>;
    }>;

export type RoundEvent =
  | Readonly<{ type: 'card-played'; seatId: SeatId; cardId: CardId }>
  | Readonly<{ type: 'bottom-taken'; seatId: SeatId; cardId: CardId; automatic: boolean }>
  | Readonly<{ type: 'stump-opened'; seatId: SeatId; cardId: CardId }>
  | Readonly<{ type: 'violation-detected'; penalty: Penalty; peekedCardId?: CardId }>;

export type PenaltyEvent =
  | Readonly<{ type: 'penalty-started'; procedureId: ProcedureId }>
  | Readonly<{
      type: 'penalty-answered';
      procedureId: ProcedureId;
      seatId: SeatId;
      cardId: CardId | null;
    }>
  | Readonly<{ type: 'penalty-expired'; procedureId: ProcedureId }>
  | Readonly<{ type: 'penalty-completed'; procedureId: ProcedureId }>;

export type DomainEvent =
  | Readonly<{ type: 'clock-suspended' }>
  | Readonly<{ type: 'clock-resumed' }>
  | Readonly<{ type: 'clock-rebased'; capturedAtMs: number; suspended: boolean }>
  | ClaimEvent
  | Readonly<{ type: 'repetition-checked' }>
  | PenaltyEvent
  | RoundEvent
  | Readonly<{ type: 'reveal-finished'; timerId: ProcedureId }>
  | Readonly<{
      type: 'out-of-turn-draw';
      seatId: SeatId;
      cardId: CardId;
      reinsertionIndex: number;
    }>
  | Readonly<{
      type: 'card-drawn';
      seatId: SeatId;
      cardId: CardId;
      destination: 'stump' | 'hand';
    }>
  | Readonly<{
      type: 'game-started';
      gameId: GameId;
      ownerId: SeatId;
      seatIds: readonly SeatId[];
      cards: readonly GameCard[];
      deck: readonly CardId[];
      firstRecipientId: SeatId;
    }>;

export type EventEnvelope = Readonly<{ id: EventId; event: DomainEvent }>;
export type ActionBatch = Readonly<{
  commandId: CommandId;
  occurredAtMs: number;
  events: readonly EventEnvelope[];
}>;

export type RejectionCode =
  | 'already-started'
  | 'not-started'
  | 'game-suspended'
  | 'unknown-seat'
  | 'inactive-seat'
  | 'invalid-claim'
  | 'invalid-vote'
  | 'unknown-claim'
  | 'claim-closed'
  | 'punishment-started'
  | 'already-requested'
  | 'scope-closed'
  | 'incident-already-handled'
  | 'card-not-owned'
  | 'empty-table'
  | 'not-eligible'
  | 'already-answered'
  | 'last-card-protected'
  | 'timer-expired'
  | 'wrong-phase'
  | 'procedure-active'
  | 'stale-timer'
  | 'timer-not-due'
  | 'invalid-configuration'
  | 'invalid-time';
export type Decision =
  | Readonly<{ type: 'accepted'; outcome: 'played' | 'violation'; action: ActionBatch }>
  | Readonly<{ type: 'rejected'; code: RejectionCode }>;

/** randomInt must return an integer in [0, upperExclusive). Replay never calls it. */
export type DecisionContext = Readonly<{
  nowMs: number;
  randomInt: (upperExclusive: number) => number;
}>;

export type BranchHead = Readonly<{
  gameId: GameId;
  branchId: BranchId;
  version: number;
}>;

/** The engine's agreed public seam. */
export type Engine = Readonly<{
  decide: (state: GameState | null, command: GameCommand, context: DecisionContext) => Decision;
  applyAction: (state: GameState | null, action: ActionBatch) => GameState;
  validateState: (state: GameState) => readonly string[];
}>;
