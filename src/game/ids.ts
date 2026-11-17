declare const idKind: unique symbol;

export type IdKind =
  'game' | 'seat' | 'card' | 'command' | 'event' | 'claim' | 'procedure' | 'branch';
export type Id<Kind extends IdKind> = string & { readonly [idKind]: Kind };

export type GameId = Id<'game'>;
export type SeatId = Id<'seat'>;
export type CardId = Id<'card'>;
export type CommandId = Id<'command'>;
export type EventId = Id<'event'>;
export type ClaimId = Id<'claim'>;
export type ProcedureId = Id<'procedure'>;
export type BranchId = Id<'branch'>;

/** Only brand validated identifiers at a trusted seam; this does not authenticate them. */
export function id<Kind extends IdKind>(_kind: Kind, value: string): Id<Kind> {
  if (value.trim().length === 0) throw new Error('Identifiers must not be empty');
  return value as Id<Kind>;
}
