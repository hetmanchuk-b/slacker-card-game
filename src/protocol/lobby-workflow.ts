import { id } from '../game/ids.ts';
import type { GameId, LobbyId, SeatId } from '../game/ids.ts';

export const AGREEMENT_MAX_BYTES = 4096;
export const WORKFLOW_BODY_MAX_BYTES = 32768;
export type LobbyWorkflow = Readonly<{
  lobbyId: LobbyId;
  /** Acceptance epoch, NOT a whole-view version. Ready updates do not advance it. */
  revision: string;
  text: string;
  editable: boolean;
  members: readonly Readonly<{ seatId: SeatId; position: number; ready: boolean }>[];
  matchAgreements: Readonly<{ gameId: GameId; revision: string; text: string }> | null;
}>;
export type WorkflowInput =
  | Readonly<{ type: 'state'; lobbyId: LobbyId }>
  | Readonly<{ type: 'agreements'; lobbyId: LobbyId; expectedRevision: string; text: string }>
  | Readonly<{ type: 'ready'; lobbyId: LobbyId; expectedRevision: string; ready: boolean }>;

export function validRevision(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9]\d{0,18})$/.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}
export function validAgreements(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.isWellFormed() &&
    !value.includes('\0') &&
    new TextEncoder().encode(value).length <= AGREEMENT_MAX_BYTES
  );
}
export function decodeWorkflow(value: unknown, type: WorkflowInput['type']): WorkflowInput | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    return null;
  const names =
    type === 'state'
      ? ['lobbyId']
      : ['lobbyId', 'expectedRevision', type === 'ready' ? 'ready' : 'text'];
  if (Reflect.ownKeys(value).length !== names.length) return null;
  const fields: Record<string, unknown> = {};
  for (const name of names) {
    const field = Object.getOwnPropertyDescriptor(value, name);
    if (!field || !Object.hasOwn(field, 'value')) return null;
    fields[name] = field.value;
  }
  const lobbyId = fields.lobbyId;
  if (
    typeof lobbyId !== 'string' ||
    !lobbyId.trim() ||
    lobbyId.length > 256 ||
    !lobbyId.isWellFormed() ||
    lobbyId.includes('\0')
  )
    return null;
  if (type === 'state') return { type, lobbyId: id('lobby', lobbyId) };
  if (!validRevision(fields.expectedRevision)) return null;
  if (type === 'ready')
    return typeof fields.ready === 'boolean'
      ? {
          type,
          lobbyId: id('lobby', lobbyId),
          expectedRevision: fields.expectedRevision,
          ready: fields.ready,
        }
      : null;
  return validAgreements(fields.text)
    ? {
        type,
        lobbyId: id('lobby', lobbyId),
        expectedRevision: fields.expectedRevision,
        text: fields.text,
      }
    : null;
}
export function lobbyWorkflow(view: LobbyWorkflow): LobbyWorkflow {
  return {
    lobbyId: view.lobbyId,
    revision: view.revision,
    text: view.text,
    editable: view.editable,
    members: view.members.map((member) => ({
      seatId: member.seatId,
      position: member.position,
      ready: member.ready,
    })),
    matchAgreements: view.matchAgreements
      ? {
          gameId: view.matchAgreements.gameId,
          revision: view.matchAgreements.revision,
          text: view.matchAgreements.text,
        }
      : null,
  };
}
