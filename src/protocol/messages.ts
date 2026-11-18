import type { BranchHead } from '../game/contracts.ts';
import type { CommandId } from '../game/ids.ts';
import type { ChatMessage } from '../persistence/lobby-contracts.ts';
import type { MatchStartResult } from '../persistence/lobby.ts';
import { projectAction } from '../projections/actions.ts';
import type { ActionProjectionInput } from '../projections/actions.ts';
import type { GameViewer } from '../projections/game.ts';
import { projectOwnerHistory } from '../projections/history.ts';
import type { OwnerHistoryInput } from '../projections/history.ts';
import { projectLiveGame } from '../projections/live.ts';
import type { RuntimeResult, RuntimeSnapshot } from '../runtime/runtime.ts';
import { PROTOCOL_LIMITS, PROTOCOL_VERSION, PUBLIC_REJECTIONS } from './contracts.ts';
import type {
  ActionMessage,
  ChatPage,
  CommandAck,
  Delivery,
  ErrorMessage,
  MatchStartAck,
  OwnerHistoryMessage,
  PublicChatMessage,
  StateMessage,
  TechnicalError,
} from './contracts.ts';

function headView(head: BranchHead): BranchHead {
  return { gameId: head.gameId, branchId: head.branchId, version: head.version };
}
function deliveryView(delivery: Delivery): Delivery {
  if (
    typeof delivery.epoch !== 'string' ||
    !delivery.epoch.trim() ||
    delivery.epoch.length > PROTOCOL_LIMITS.reference ||
    !delivery.epoch.isWellFormed() ||
    delivery.epoch.includes('\0') ||
    !Number.isSafeInteger(delivery.sequence) ||
    delivery.sequence < 0
  )
    throw new Error('Invalid server message context');
  return { epoch: delivery.epoch, sequence: delivery.sequence };
}

/** Fixed codes only: never accept exception messages, causes or request objects. */
export function protocolError(code: TechnicalError): ErrorMessage {
  const allowed: readonly TechnicalError[] = [
    'invalid-message',
    'unsupported-version',
    'unauthorized',
    'wrong-game',
    'unavailable',
  ];
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'error',
    code: allowed.includes(code) ? code : 'unavailable',
  };
}

/** Caller supplies a committed result for an authenticated, validated request. */
export function makeCommandAck(
  requestId: CommandId,
  result: RuntimeResult,
): CommandAck | ErrorMessage {
  if (
    result.type === 'accepted' &&
    ['played', 'violation', 'control'].includes(result.outcome) &&
    typeof result.duplicate === 'boolean'
  ) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      type: 'command-ack',
      requestId,
      result: {
        type: 'accepted',
        outcome: result.outcome,
        duplicate: result.duplicate,
        head: headView(result.head),
      },
    };
  }
  if (result.type === 'rejected') {
    const code = PUBLIC_REJECTIONS.find((allowed) => allowed === result.code);
    if (code)
      return {
        protocolVersion: PROTOCOL_VERSION,
        type: 'command-ack',
        requestId,
        result: { type: 'rejected', code, head: headView(result.head) },
      };
  }
  return protocolError('unavailable');
}

/** Builders take authoritative inputs plus trusted viewer bindings, not arbitrary
 * projected blobs. This prevents extra properties on an otherwise typed DTO from
 * becoming network payloads. They do not authenticate, commit, publish or allocate
 * stream counters; only the later server publisher may call them for delivery.
 */
export function makeStateMessage(
  snapshot: RuntimeSnapshot,
  viewer: GameViewer,
  nowMs: number,
  delivery: Delivery,
): StateMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'state',
    delivery: deliveryView(delivery),
    view: projectLiveGame(snapshot, viewer, nowMs),
  };
}
export function makeActionMessage(
  input: ActionProjectionInput,
  viewer: GameViewer,
  delivery: Delivery,
): ActionMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'action',
    delivery: deliveryView(delivery),
    view: projectAction(input, viewer),
  };
}
export function makeOwnerHistoryMessage(
  input: OwnerHistoryInput,
  viewer: GameViewer,
  delivery: Delivery,
): OwnerHistoryMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'owner-history',
    delivery: deliveryView(delivery),
    view: projectOwnerHistory(input, viewer),
  };
}

function chatView(message: ChatMessage): PublicChatMessage {
  return {
    id: message.id,
    lobbyId: message.lobbyId,
    authorSeatId: message.authorSeatId,
    text: message.text,
    sequence: message.sequence,
    atMs: message.atMs,
    context: {
      head: message.context.head ? headView(message.context.head) : null,
      scope: message.context.scope,
      scopeNumber: message.context.scopeNumber,
    },
  };
}
/** Caller authenticates lobby membership. Text and original context remain verbatim;
 * stable session IDs are private even though they are not cookie credentials.
 */
export function makeChatPage(requestId: CommandId, messages: readonly ChatMessage[]): ChatPage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'chat-page',
    requestId,
    messages: messages.map(chatView),
  };
}

/** Never serialize MatchStartResult directly: it can contain a live DB session/runtime. */
export function makeMatchStartAck(
  requestId: CommandId,
  result: MatchStartResult,
): MatchStartAck | ErrorMessage {
  if (result.type === 'started' || result.type === 'duplicate')
    return {
      protocolVersion: PROTOCOL_VERSION,
      type: 'match-start-ack',
      requestId,
      result: { type: 'started', gameId: result.gameId, duplicate: result.type === 'duplicate' },
    };
  if (result.type === 'rejected') {
    const codes = {
      'owner-only': 'owner-only',
      'game-mismatch': 'wrong-game',
      'match-not-finished': 'wrong-phase',
      'invalid-configuration': 'invalid-configuration',
      'command-id-reused': 'command-id-reused',
      'stale-head': 'version-conflict',
    } as const;
    if (Object.hasOwn(codes, result.code))
      return {
        protocolVersion: PROTOCOL_VERSION,
        type: 'match-start-ack',
        requestId,
        result: { type: 'rejected', code: codes[result.code] },
      };
  }
  return protocolError('unavailable');
}
