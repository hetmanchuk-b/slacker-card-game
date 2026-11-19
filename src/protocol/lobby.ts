import { id } from '../game/ids.ts';
import type { LobbyId, SeatId } from '../game/ids.ts';
import { PROTOCOL_LIMITS } from './contracts.ts';

/** Separate HTTP contract, not a socket intent or a private membership binding. */
export type LobbyMembership = Readonly<{
  lobbyId: LobbyId;
  seatId: SeatId;
  position: number;
  isOwner: boolean;
}>;
export const LOBBY_BODY_MAX_BYTES = 2048;

export function decodeLobbyRequest(value: unknown, kind: 'create'): { requestId: string } | null;
export function decodeLobbyRequest(value: unknown, kind: 'join'): { lobbyId: LobbyId } | null;
export function decodeLobbyRequest(value: unknown, kind: 'create' | 'join') {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).length !== 1
  )
    return null;
  const name = kind === 'create' ? 'requestId' : 'lobbyId';
  const field = Object.getOwnPropertyDescriptor(value, name);
  if (!field || !Object.hasOwn(field, 'value')) return null;
  const text: unknown = field.value;
  if (
    typeof text !== 'string' ||
    !text.trim() ||
    !text.isWellFormed() ||
    text.includes('\0') ||
    text.length > (kind === 'create' ? PROTOCOL_LIMITS.requestId : PROTOCOL_LIMITS.reference)
  )
    return null;
  return kind === 'create' ? { requestId: text } : { lobbyId: id('lobby', text) };
}

export function lobbyMembership(binding: LobbyMembership): LobbyMembership {
  return {
    lobbyId: binding.lobbyId,
    seatId: binding.seatId,
    position: binding.position,
    isOwner: binding.isOwner,
  };
}
