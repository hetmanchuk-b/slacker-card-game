import type { BranchHead } from '../game/contracts.ts';
import type {
  BranchId,
  CardId,
  ClaimId,
  CommandId,
  GameId,
  LobbyId,
  MessageId,
  ProcedureId,
  SeatId,
} from '../game/ids.ts';
import type { ActionView } from '../projections/actions.ts';
import type { HistoryHead, OwnerHistoryView, RollbackNotice } from '../projections/history.ts';
import type { LiveGameView } from '../projections/live.ts';

export const PROTOCOL_VERSION = 1;
/** Technical API bounds in UTF-16 code units, not gameplay punishments.
 * Reference room leaves space for procedure/branch suffixes derived from request IDs.
 */
export const PROTOCOL_LIMITS = Object.freeze({
  requestId: 128,
  reference: 256,
  text: 4096,
  page: 100,
});
export type Ballot = 'yes' | 'no' | 'abstain';
export type GameRoute = Readonly<{ gameId: GameId; branchId: BranchId }>;
export type EvidenceReference =
  | Readonly<{ type: 'spoken'; key: string }>
  | Readonly<{ type: 'chat'; messageId: MessageId }>
  | Readonly<{ type: 'action'; commandId: CommandId }>;

/** Explicit browser vocabulary. Never derive it by omitting fields from internal commands. */
export type ClientIntent =
  | (GameRoute &
      (
        | Readonly<{ type: 'draw-card' | 'take-bottom' }>
        | Readonly<{ type: 'play-card' | 'open-stump'; cardId: CardId }>
        | Readonly<{ type: 'penalty-response'; procedureId: ProcedureId; cardId: CardId | null }>
        | Readonly<{
            type: 'cast-vote' | 'replacement-vote';
            procedureId: ProcedureId;
            vote: Ballot;
          }>
        | Readonly<{ type: 'request-withdrawal'; claimId: ClaimId }>
        | Readonly<{ type: 'withdrawal-response'; procedureId: ProcedureId; approve: boolean }>
        | Readonly<{ type: 'propose-bot'; absentSeatId: SeatId }>
        | Readonly<{
            type: 'submit-claim';
            accusedId: SeatId;
            reason: string;
            evidence: EvidenceReference;
          }>
      ))
  | Readonly<{
      type: 'rollback';
      target: Readonly<{ expected: HistoryHead; beforeActionVersion: number }>;
      knowledgeWarningAcknowledged: boolean;
    }>
  | Readonly<{ type: 'owner-history'; gameId: GameId }>
  | Readonly<{ type: 'resync'; lobbyId: LobbyId }>
  | Readonly<{ type: 'post-chat'; lobbyId: LobbyId; messageId: MessageId; text: string }>
  | Readonly<{ type: 'chat-history'; lobbyId: LobbyId; afterSequence: string; limit: number }>
  | Readonly<{ type: 'start-match'; lobbyId: LobbyId; expected: BranchHead | null }>;

export type ClientMessage = Readonly<{
  protocolVersion: 1;
  requestId: CommandId;
  intent: ClientIntent;
}>;
export type DecodeResult =
  | Readonly<{ type: 'decoded'; message: ClientMessage }>
  | Readonly<{ type: 'rejected'; code: 'invalid-message' | 'unsupported-version' }>;

/** Reviewed error vocabulary, not exception text. Internal additions are not auto-exposed. */
export const PUBLIC_REJECTIONS = Object.freeze([
  'already-started',
  'not-started',
  'game-suspended',
  'unknown-seat',
  'inactive-seat',
  'invalid-claim',
  'invalid-vote',
  'unknown-claim',
  'claim-closed',
  'punishment-started',
  'already-requested',
  'scope-closed',
  'incident-already-handled',
  'card-not-owned',
  'empty-table',
  'not-eligible',
  'already-answered',
  'last-card-protected',
  'timer-expired',
  'wrong-phase',
  'procedure-active',
  'stale-timer',
  'timer-not-due',
  'invalid-configuration',
  'invalid-time',
  'wrong-branch',
  'version-conflict',
  'command-id-reused',
  'owner-only',
  'warning-required',
  'unknown-target',
  'branch-exists',
  'rollback-closed',
  'closed',
  'not-connected',
  'wrong-controller',
  'system-command',
  'replacement-too-early',
  'replacement-active',
  'not-absent',
] as const);
export type PublicRejection = (typeof PUBLIC_REJECTIONS)[number];
export type TechnicalError =
  'invalid-message' | 'unsupported-version' | 'unauthorized' | 'wrong-game' | 'unavailable';
export type ErrorMessage = Readonly<{ protocolVersion: 1; type: 'error'; code: TechnicalError }>;
export type CommandAck = Readonly<{
  protocolVersion: 1;
  type: 'command-ack';
  requestId: CommandId;
  result:
    | Readonly<{
        type: 'accepted';
        outcome: 'played' | 'violation' | 'control';
        head: BranchHead;
        duplicate: boolean;
      }>
    | Readonly<{ type: 'rejected'; code: PublicRejection; head: BranchHead }>;
}>;
/** Server-owned stream ordering, independent of action-head versions.
 * Allocation, resync and restart/epoch lifecycle belong to the later publisher.
 */
export type Delivery = Readonly<{ epoch: string; sequence: number }>;
export type StateMessage = Readonly<{
  protocolVersion: 1;
  type: 'state';
  delivery: Delivery;
  view: LiveGameView;
}>;
export type ActionMessage = Readonly<{
  protocolVersion: 1;
  type: 'action';
  delivery: Delivery;
  view: ActionView;
}>;
export type OwnerHistoryMessage = Readonly<{
  protocolVersion: 1;
  type: 'owner-history';
  delivery: Delivery;
  view: OwnerHistoryView;
}>;
export type RollbackNoticeMessage = Readonly<{
  protocolVersion: 1;
  type: 'rollback-notice';
  delivery: Delivery;
  notice: RollbackNotice;
}>;
export type PublicChatMessage = Readonly<{
  id: MessageId;
  lobbyId: LobbyId;
  authorSeatId: SeatId | null;
  text: string;
  sequence: string;
  atMs: number;
  context: Readonly<{
    head: BranchHead | null;
    scope: 'lobby' | 'dealing' | 'between-rounds' | 'round';
    scopeNumber: number | null;
  }>;
}>;
export type ChatPage = Readonly<{
  protocolVersion: 1;
  type: 'chat-page';
  requestId: CommandId;
  messages: readonly PublicChatMessage[];
}>;
export type MatchStartAck = Readonly<{
  protocolVersion: 1;
  type: 'match-start-ack';
  requestId: CommandId;
  result:
    | Readonly<{ type: 'started'; gameId: GameId; duplicate: boolean }>
    | Readonly<{
        type: 'rejected';
        code:
          | 'owner-only'
          | 'wrong-game'
          | 'wrong-phase'
          | 'invalid-configuration'
          | 'command-id-reused'
          | 'version-conflict';
      }>;
}>;
export type ServerMessage =
  | ErrorMessage
  | CommandAck
  | StateMessage
  | ActionMessage
  | OwnerHistoryMessage
  | RollbackNoticeMessage
  | ChatPage
  | MatchStartAck;
