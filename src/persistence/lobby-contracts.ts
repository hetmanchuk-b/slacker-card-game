import type { BranchHead } from '../game/contracts.ts';
import type {
  BranchId,
  CardId,
  CommandId,
  GameId,
  LobbyId,
  MessageId,
  SeatId,
  SessionId,
} from '../game/ids.ts';

/** Expected pre-write start denial; infrastructure failures must not use this path. */
export class MatchStartRefusal extends Error {
  readonly code: 'not-ready' | 'invalid-configuration';
  constructor(code: 'not-ready' | 'invalid-configuration') {
    super(code);
    this.code = code;
  }
}

export type LobbyBinding = Readonly<{
  id: LobbyId;
  ownerSessionId: SessionId;
  ownerSeatId: SeatId;
}>;
export type LobbyRecord = LobbyBinding & Readonly<{ currentGameId: GameId | null }>;
export type ChatInput = Readonly<{
  id: MessageId;
  authorSessionId: SessionId;
  authorSeatId: SeatId | null;
  text: string;
}>;
export type ChatContext = Readonly<{
  head: BranchHead | null;
  scope: 'lobby' | 'dealing' | 'between-rounds' | 'round';
  scopeNumber: number | null;
}>;
export type ChatMessage = ChatInput &
  Readonly<{ lobbyId: LobbyId; sequence: string; atMs: number; context: ChatContext }>;
export type MatchStart = Readonly<{
  id: CommandId;
  actorSessionId: SessionId;
  expectedGameId: GameId | null;
  expectedHead: BranchHead | null;
  gameId: GameId;
  branchId: BranchId;
  seatIds: readonly SeatId[];
  cardIds: readonly CardId[];
}>;
