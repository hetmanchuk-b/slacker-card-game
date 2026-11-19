import { validLobbyLocator as text } from './lobby-membership.ts';
export type GameSnapshot = Readonly<{
  head: Readonly<{ gameId: string; branchId: string; version: number }>;
  paused: boolean;
  state: Readonly<{
    phase: string;
    deckCount: number;
    tableCount: number;
    discardCount: number;
    players: readonly Readonly<{
      id: string;
      status: string;
      handCount: number;
      stumpCount: number;
    }>[];
  }> | null;
  connections: readonly Readonly<{ seatId: string; connected: boolean; controller: string }>[];
}>;
export const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  object(v) && Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
const count = (v: unknown, max = 36): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= max;
function snapshot(raw: unknown, seatId: string): GameSnapshot | null {
  if (
    !exact(raw, ['head', 'state', 'transient', 'procedure', 'control']) ||
    !exact(raw.head, ['gameId', 'branchId', 'version']) ||
    !text(raw.head.gameId) ||
    !text(raw.head.branchId) ||
    !count(raw.head.version, Number.MAX_SAFE_INTEGER) ||
    !exact(raw.control, ['paused', 'connections', 'replacementVote']) ||
    typeof raw.control.paused !== 'boolean' ||
    !Array.isArray(raw.control.connections) ||
    raw.control.connections.length > 8
  )
    return null;
  let state: GameSnapshot['state'] = null;
  if (raw.state !== null) {
    const s = raw.state;
    if (
      !exact(s, ['viewer', 'players', 'own', 'deckCount', 'table', 'discardCount', 'phase']) ||
      !exact(s.viewer, ['type', 'seatId']) ||
      typeof s.viewer.type !== 'string' ||
      !['participant', 'finished-player'].includes(s.viewer.type) ||
      s.viewer.seatId !== seatId ||
      !object(s.own) ||
      s.own.seatId !== seatId ||
      !Array.isArray(s.own.hand) ||
      s.own.hand.length > 36 ||
      !Array.isArray(s.own.stumps) ||
      s.own.stumps.length > 2 ||
      !Array.isArray(s.players) ||
      s.players.length < 2 ||
      s.players.length > 8 ||
      !count(s.deckCount) ||
      !count(s.discardCount) ||
      !Array.isArray(s.table) ||
      s.table.length > 36 ||
      !object(s.phase) ||
      typeof s.phase.type !== 'string' ||
      ![
        'dealing',
        'trump-reveal',
        'pre-game-penalties',
        'between-rounds',
        'round',
        'finished',
      ].includes(s.phase.type)
    )
      return null;
    const players: NonNullable<GameSnapshot['state']>['players'][number][] = [];
    for (const p of s.players) {
      if (
        !exact(p, ['id', 'status', 'handCount', 'stumpCount']) ||
        !text(p.id) ||
        typeof p.status !== 'string' ||
        !['active', 'won'].includes(p.status) ||
        !count(p.handCount) ||
        !count(p.stumpCount, 2) ||
        players.some((other) => other.id === p.id)
      )
        return null;
      players.push({
        id: p.id,
        status: p.status,
        handCount: p.handCount,
        stumpCount: p.stumpCount,
      });
    }
    if (!players.some((p) => p.id === seatId)) return null;
    state = {
      players,
      phase: s.phase.type,
      deckCount: s.deckCount,
      tableCount: s.table.length,
      discardCount: s.discardCount,
    };
  }
  const connections: GameSnapshot['connections'][number][] = [];
  for (const c of raw.control.connections) {
    if (
      !exact(c, ['seatId', 'connected', 'controller']) ||
      !text(c.seatId) ||
      typeof c.connected !== 'boolean' ||
      typeof c.controller !== 'string' ||
      !['human', 'bot'].includes(c.controller) ||
      connections.some((other) => other.seatId === c.seatId) ||
      (state && !state.players.some((p) => p.id === c.seatId))
    )
      return null;
    connections.push({
      seatId: c.seatId,
      connected: c.connected,
      controller: c.controller,
    });
  }
  // Faces, handles, procedures and transient/action observations are deliberately
  // not retained by this 9.4 read-only summary. They belong to later increments.
  return {
    head: { gameId: raw.head.gameId, branchId: raw.head.branchId, version: raw.head.version },
    state,
    paused: raw.control.paused,
    connections,
  };
}
export class GameStream {
  readonly #seatId: string;
  #epoch: string | null = null;
  #sequence = -1;
  #retired = new Set<string>();
  snapshot: GameSnapshot | null = null;
  constructor(seatId: string) {
    this.#seatId = seatId;
  }
  receive(message: unknown): 'state' | 'meta' | 'ignored' | 'invalid' {
    if (!object(message) || message.protocolVersion !== 1 || typeof message.type !== 'string')
      return 'invalid';
    if (['command-ack', 'match-start-ack', 'chat-page'].includes(message.type)) return 'ignored';
    if (
      !['state', 'action', 'rollback-notice', 'owner-history'].includes(message.type) ||
      !exact(message.delivery, ['epoch', 'sequence']) ||
      !text(message.delivery.epoch) ||
      !count(message.delivery.sequence, Number.MAX_SAFE_INTEGER)
    )
      return 'invalid';
    const { epoch, sequence } = message.delivery;
    if (this.#retired.has(epoch)) return 'ignored';
    if (epoch !== this.#epoch) {
      if (this.#retired.size >= 64) return 'invalid';
      if (this.#epoch !== null) this.#retired.add(this.#epoch);
      this.#epoch = epoch;
      this.#sequence = -1;
      this.snapshot = null;
    }
    if (sequence <= this.#sequence) return 'ignored';
    if (this.#sequence !== -1 && sequence !== this.#sequence + 1) return 'invalid';
    this.#sequence = sequence;
    if (message.type !== 'state') {
      if (message.type !== 'owner-history') this.snapshot = null;
      return 'meta';
    }
    const next = snapshot(message.view, this.#seatId);
    if (!next) return 'invalid';
    this.snapshot = next;
    return 'state';
  }
}
