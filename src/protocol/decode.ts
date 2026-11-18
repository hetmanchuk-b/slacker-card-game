import { id } from '../game/ids.ts';
import { PROTOCOL_LIMITS, PROTOCOL_VERSION } from './contracts.ts';
import type { BranchHead } from '../game/contracts.ts';
import type { HistoryHead } from '../projections/history.ts';
import type {
  Ballot,
  ClientIntent,
  DecodeResult,
  EvidenceReference,
  GameRoute,
} from './contracts.ts';

function plainRecord(value: unknown): asserts value is object {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    throw new Error();
}

/** Read only own data properties, never accessors or inherited identity fields. */
function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  plainRecord(value);
  if (Reflect.ownKeys(value).length !== names.length) throw new Error();
  return Object.fromEntries(
    names.map((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error();
      return [name, descriptor.value];
    }),
  );
}

function kind(value: unknown): string {
  plainRecord(value);
  const descriptor = Object.getOwnPropertyDescriptor(value, 'type');
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string')
    throw new Error();
  return descriptor.value;
}

function text(value: unknown, max: number, nonblank = true): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    !value.isWellFormed() ||
    value.includes('\0') ||
    (nonblank && !value.trim())
  )
    throw new Error();
  return value;
}
const reference = (value: unknown): string => text(value, PROTOCOL_LIMITS.reference);
const requestId = (value: unknown) => id('command', text(value, PROTOCOL_LIMITS.requestId));
function integer(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error();
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error();
  return value;
}
function ballot(value: unknown): Ballot {
  if (value !== 'yes' && value !== 'no' && value !== 'abstain') throw new Error();
  return value;
}
function route(record: Record<string, unknown>): GameRoute {
  return {
    gameId: id('game', reference(record.gameId)),
    branchId: id('branch', reference(record.branchId)),
  };
}
function runtimeHead(value: unknown): BranchHead {
  const record = fields(value, ['gameId', 'branchId', 'version']);
  return { ...route(record), version: integer(record.version) };
}
function displayHead(value: unknown): HistoryHead {
  const record = fields(value, ['gameId', 'branch', 'version']);
  return {
    gameId: id('game', reference(record.gameId)),
    branch: integer(record.branch, 1),
    version: integer(record.version),
  };
}
function evidence(value: unknown): EvidenceReference {
  switch (kind(value)) {
    case 'spoken': {
      const record = fields(value, ['type', 'key']);
      return { type: 'spoken', key: reference(record.key) };
    }
    case 'chat': {
      const record = fields(value, ['type', 'messageId']);
      return { type: 'chat', messageId: id('message', reference(record.messageId)) };
    }
    case 'action': {
      const record = fields(value, ['type', 'commandId']);
      return { type: 'action', commandId: id('command', reference(record.commandId)) };
    }
    default:
      throw new Error();
  }
}

function intent(value: unknown): ClientIntent {
  const type = kind(value);
  const gameFields = ['type', 'gameId', 'branchId'];
  switch (type) {
    case 'draw-card':
    case 'take-bottom': {
      const record = fields(value, gameFields);
      return { type, ...route(record) };
    }
    case 'play-card':
    case 'open-stump': {
      const record = fields(value, [...gameFields, 'cardId']);
      return { type, ...route(record), cardId: id('card', reference(record.cardId)) };
    }
    case 'penalty-response': {
      const record = fields(value, [...gameFields, 'procedureId', 'cardId']);
      return {
        type,
        ...route(record),
        procedureId: id('procedure', reference(record.procedureId)),
        cardId: record.cardId === null ? null : id('card', reference(record.cardId)),
      };
    }
    case 'cast-vote':
    case 'replacement-vote': {
      const record = fields(value, [...gameFields, 'procedureId', 'vote']);
      return {
        type,
        ...route(record),
        procedureId: id('procedure', reference(record.procedureId)),
        vote: ballot(record.vote),
      };
    }
    case 'request-withdrawal': {
      const record = fields(value, [...gameFields, 'claimId']);
      return { type, ...route(record), claimId: id('claim', reference(record.claimId)) };
    }
    case 'withdrawal-response': {
      const record = fields(value, [...gameFields, 'procedureId', 'approve']);
      return {
        type,
        ...route(record),
        procedureId: id('procedure', reference(record.procedureId)),
        approve: boolean(record.approve),
      };
    }
    case 'propose-bot': {
      const record = fields(value, [...gameFields, 'absentSeatId']);
      return { type, ...route(record), absentSeatId: id('seat', reference(record.absentSeatId)) };
    }
    case 'submit-claim': {
      const record = fields(value, [...gameFields, 'accusedId', 'reason', 'evidence']);
      return {
        type,
        ...route(record),
        accusedId: id('seat', reference(record.accusedId)),
        reason: text(record.reason, PROTOCOL_LIMITS.text),
        evidence: evidence(record.evidence),
      };
    }
    case 'rollback': {
      const record = fields(value, ['type', 'target', 'knowledgeWarningAcknowledged']);
      const target = fields(record.target, ['expected', 'beforeActionVersion']);
      const expected = displayHead(target.expected);
      const beforeActionVersion = integer(target.beforeActionVersion, 1);
      if (beforeActionVersion > expected.version) throw new Error();
      return {
        type,
        target: { expected, beforeActionVersion },
        knowledgeWarningAcknowledged: boolean(record.knowledgeWarningAcknowledged),
      };
    }
    case 'owner-history': {
      const record = fields(value, ['type', 'gameId']);
      return { type, gameId: id('game', reference(record.gameId)) };
    }
    case 'resync': {
      const record = fields(value, ['type', 'lobbyId']);
      return { type, lobbyId: id('lobby', reference(record.lobbyId)) };
    }
    case 'post-chat': {
      const record = fields(value, ['type', 'lobbyId', 'messageId', 'text']);
      return {
        type,
        lobbyId: id('lobby', reference(record.lobbyId)),
        messageId: id('message', reference(record.messageId)),
        text: text(record.text, PROTOCOL_LIMITS.text, false),
      };
    }
    case 'chat-history': {
      const record = fields(value, ['type', 'lobbyId', 'afterSequence', 'limit']);
      const afterSequence = text(record.afterSequence, 19);
      const limit = integer(record.limit, 1);
      if (
        !/^(0|[1-9]\d*)$/.test(afterSequence) ||
        BigInt(afterSequence) > 9223372036854775807n ||
        limit > PROTOCOL_LIMITS.page
      )
        throw new Error();
      return { type, lobbyId: id('lobby', reference(record.lobbyId)), afterSequence, limit };
    }
    case 'start-match': {
      const record = fields(value, ['type', 'lobbyId', 'expected']);
      return {
        type,
        lobbyId: id('lobby', reference(record.lobbyId)),
        expected: record.expected === null ? null : runtimeHead(record.expected),
      };
    }
    default:
      throw new Error();
  }
}

/** Decode already-deserialized untrusted data, NOT raw bytes or an authorized command.
 * Socket/HTTP byte limits, membership, evidence/ordinal resolution, canonical start
 * retries and current-game/branch routing remain server adapter responsibilities.
 * No turn, ownership, beat/stump legality or current version is consulted here.
 */
export function decodeClientMessage(input: unknown): DecodeResult {
  try {
    const record = fields(input, ['protocolVersion', 'requestId', 'intent']);
    if (record.protocolVersion !== PROTOCOL_VERSION) {
      if (
        typeof record.protocolVersion === 'number' &&
        Number.isSafeInteger(record.protocolVersion) &&
        record.protocolVersion > 0
      )
        return { type: 'rejected', code: 'unsupported-version' };
      throw new Error();
    }
    return {
      type: 'decoded',
      message: {
        protocolVersion: PROTOCOL_VERSION,
        requestId: requestId(record.requestId),
        intent: intent(record.intent),
      },
    };
  } catch {
    return { type: 'rejected', code: 'invalid-message' };
  }
}
