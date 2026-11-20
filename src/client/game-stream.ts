import { validLobbyLocator as text } from './lobby-membership.ts';
export type Card = Readonly<{ id: string; face: Readonly<{ suit: string; rank: number }> }>;
export type Draw = Readonly<{ seatId: string; rejected: boolean; destination?: 'hand' | 'stump' }>;
export type Reveal = Readonly<{ card: Card; recipientId: string; expiresAt: number }>;
export type DisplayTimer = Readonly<{
  id: string;
  remainingMs: number;
  paused: boolean;
  expiresAt: number | null;
}>;
export type Penalty = Readonly<{
  recipientId: string;
  reason: string;
  eligibleSeatIds: readonly string[];
  ownResponse: Readonly<{ type: 'refuse' }> | Readonly<{ type: 'card'; card: Card }> | null;
  timer: DisplayTimer;
}>;
export type Transfer = Readonly<{ fromSeatId: string; toSeatId: string; card: Card }>;
export const remainingTime = (timer: DisplayTimer, now: number): number =>
  timer.paused ? timer.remainingMs : Math.max(0, (timer.expiresAt ?? now) - now);
export type GameSnapshot = Readonly<{
  penalty: Penalty | null;
  hasProcedure: boolean;
  initialRecipientNotice: boolean;
  reveal: Reveal | null;
  head: Readonly<{ gameId: string; branchId: string; version: number }>;
  paused: boolean;
  state: Readonly<{
    own: Readonly<{ hand: readonly Card[]; stumps: readonly string[] }>;
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
export const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  object(v) && Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
const count = (v: unknown, max = 36): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= max;
function card(raw: unknown): Card | null {
  if (
    !exact(raw, ['id', 'face']) ||
    !text(raw.id) ||
    !exact(raw.face, ['suit', 'rank']) ||
    typeof raw.face.suit !== 'string' ||
    !['clubs', 'diamonds', 'hearts', 'spades'].includes(raw.face.suit) ||
    !Number.isInteger(raw.face.rank) ||
    Number(raw.face.rank) < 6 ||
    Number(raw.face.rank) > 14
  )
    return null;
  return { id: raw.id, face: { suit: raw.face.suit, rank: Number(raw.face.rank) } };
}
export function head(raw: unknown): raw is GameSnapshot['head'] {
  return (
    exact(raw, ['gameId', 'branchId', 'version']) &&
    text(raw.gameId) &&
    text(raw.branchId) &&
    count(raw.version, Number.MAX_SAFE_INTEGER)
  );
}
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
      !exact(s.own, ['seatId', 'hand', 'stumps']) ||
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
    const ownPlayer = players.find((p) => p.id === seatId);
    const hand = s.own.hand.map(card);
    const stumps = s.own.stumps;
    if (
      !ownPlayer ||
      hand.some((c) => c === null) ||
      !stumps.every(text) ||
      ownPlayer.handCount !== hand.length ||
      ownPlayer.stumpCount !== stumps.length ||
      new Set([...hand.map((c) => c!.id), ...stumps]).size !== hand.length + stumps.length
    )
      return null;
    state = {
      own: { hand: hand as Card[], stumps: [...stumps] },
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
  if (
    !exact(raw.transient, ['initialRecipientNotice', 'reveal']) ||
    typeof raw.transient.initialRecipientNotice !== 'boolean'
  )
    return null;
  const initialRecipientNotice = raw.transient.initialRecipientNotice;
  if (initialRecipientNotice && state?.phase !== 'dealing') return null;
  let reveal: Reveal | null = null;
  if (raw.transient.reveal !== null) {
    const r = raw.transient.reveal;
    if (
      !exact(r, ['card', 'recipientId', 'timer']) ||
      !card(r.card) ||
      !text(r.recipientId) ||
      !state?.players.some((p) => p.id === r.recipientId) ||
      state.phase !== 'trump-reveal' ||
      raw.control.paused ||
      !exact(r.timer, ['id', 'remainingMs', 'paused']) ||
      !text(r.timer.id) ||
      typeof r.timer.remainingMs !== 'number' ||
      !Number.isFinite(r.timer.remainingMs) ||
      r.timer.remainingMs <= 0 ||
      r.timer.remainingMs > 10000 ||
      r.timer.paused !== false
    )
      return null;
    // Duration is converted to a monotonic deadline by GameStream at receipt.
    reveal = { card: card(r.card)!, recipientId: r.recipientId, expiresAt: r.timer.remainingMs };
  }
  let penalty: Penalty | null = null;
  if (raw.procedure !== null) {
    const p = raw.procedure;
    if (
      !state ||
      !object(p) ||
      typeof p.type !== 'string' ||
      !['penalty', 'claim-vote', 'withdrawal'].includes(p.type)
    )
      return null;
    if (p.type === 'penalty') {
      if (
        !exact(p, ['type', 'recipientId', 'reason', 'eligibleSeatIds', 'ownResponse', 'timer']) ||
        !text(p.recipientId) ||
        !state.players.some((s) => s.id === p.recipientId && s.status === 'active') ||
        typeof p.reason !== 'string' ||
        ![
          'draw-out-of-turn',
          'invalid-beat',
          'play-out-of-turn',
          'peek',
          'must-open-stump',
          'claim',
        ].includes(p.reason) ||
        !Array.isArray(p.eligibleSeatIds) ||
        p.eligibleSeatIds.length > 7 ||
        !p.eligibleSeatIds.every(text) ||
        new Set(p.eligibleSeatIds).size !== p.eligibleSeatIds.length ||
        p.eligibleSeatIds.some(
          (id) =>
            id === p.recipientId ||
            !state!.players.some((s) => s.id === id && s.status === 'active'),
        ) ||
        !exact(p.timer, ['id', 'remainingMs', 'paused']) ||
        !text(p.timer.id) ||
        !count(p.timer.remainingMs, 10000) ||
        typeof p.timer.paused !== 'boolean' ||
        (raw.control.paused && !p.timer.paused)
      )
        return null;
      let ownResponse: Penalty['ownResponse'] = null;
      if (p.ownResponse !== null) {
        const r = p.ownResponse;
        if (!p.eligibleSeatIds.includes(seatId) || !object(r)) return null;
        if (exact(r, ['type']) && r.type === 'refuse') ownResponse = { type: 'refuse' };
        else if (exact(r, ['type', 'card']) && r.type === 'card') {
          const selected = card(r.card);
          if (
            !selected ||
            state.own.hand.length < 2 ||
            !state.own.hand.some(
              (c) =>
                c.id === selected.id &&
                c.face.suit === selected.face.suit &&
                c.face.rank === selected.face.rank,
            )
          )
            return null;
          ownResponse = { type: 'card', card: selected };
        } else return null;
      }
      penalty = {
        recipientId: p.recipientId,
        reason: p.reason,
        eligibleSeatIds: [...p.eligibleSeatIds],
        ownResponse,
        timer: {
          id: p.timer.id,
          remainingMs: p.timer.remainingMs,
          paused: p.timer.paused,
          expiresAt: null,
        },
      };
    }
  }
  return {
    penalty,
    hasProcedure: raw.procedure !== null,
    initialRecipientNotice,
    reveal,
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
  draw: Draw | null = null;
  transfers: readonly Transfer[] = [];
  reset = false;
  #penaltyTimer: { key: string; timer: DisplayTimer } | null = null;
  #route: string | null = null;
  readonly #now: () => number;
  #revealKey: string | null = null;
  #revealDeadline = 0;
  constructor(seatId: string, now: () => number = () => performance.now()) {
    this.#seatId = seatId;
    this.#now = now;
  }
  #routeTo(head: GameSnapshot['head']) {
    const route = JSON.stringify([head.gameId, head.branchId]);
    if (this.#route !== null && route !== this.#route) {
      this.snapshot = null;
      this.draw = null;
      this.transfers = [];
      this.#penaltyTimer = null;
      this.#revealKey = null;
      this.reset = true;
    }
    this.#route = route;
  }
  expireReveal() {
    if (this.snapshot?.reveal && this.#now() >= this.snapshot.reveal.expiresAt)
      this.snapshot = { ...this.snapshot, reveal: null };
  }
  receive(message: unknown): 'state' | 'meta' | 'ignored' | 'invalid' {
    this.reset = false;
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
      this.draw = null;
      this.transfers = [];
      this.#penaltyTimer = null;
      this.reset = true;
      this.#revealKey = null;
    }
    if (sequence <= this.#sequence) return 'ignored';
    if (this.#sequence !== -1 && sequence !== this.#sequence + 1) return 'invalid';
    this.#sequence = sequence;
    if (message.type !== 'state') {
      if (message.type === 'action') {
        const v = message.view;
        if (
          !exact(v, ['head', 'commandId', 'observations']) ||
          !head(v.head) ||
          !text(v.commandId) ||
          !Array.isArray(v.observations) ||
          v.observations.length > 128
        )
          return 'invalid';
        this.#routeTo(v.head);
        const transfers: Transfer[] = [];
        for (const o of v.observations) {
          if (!object(o) || typeof o.type !== 'string') return 'invalid';
          if (o.type === 'penalty-transfer') {
            if (
              !exact(o, ['type', 'fromSeatId', 'toSeatId', 'card']) ||
              !text(o.fromSeatId) ||
              !text(o.toSeatId) ||
              o.fromSeatId === o.toSeatId ||
              (o.fromSeatId !== this.#seatId && o.toSeatId !== this.#seatId) ||
              !card(o.card) ||
              (this.snapshot?.state &&
                [o.fromSeatId, o.toSeatId].some(
                  (id) => !this.snapshot!.state!.players.some((p) => p.id === id),
                )) ||
              transfers.length >= 7
            )
              return 'invalid';
            transfers.push({ fromSeatId: o.fromSeatId, toSeatId: o.toSeatId, card: card(o.card)! });
            continue;
          }
          if (o.type !== 'card-drawn' && o.type !== 'draw-rejected') continue;
          if (
            !text(o.seatId) ||
            (this.snapshot?.state && !this.snapshot.state.players.some((p) => p.id === o.seatId))
          )
            return 'invalid';
          if (o.type === 'draw-rejected') {
            if (!exact(o, ['type', 'seatId'])) return 'invalid';
            this.draw = { seatId: o.seatId, rejected: true };
          } else {
            if (
              !exact(o, ['type', 'seatId', 'destination', 'card']) ||
              (o.destination !== 'hand' && o.destination !== 'stump') ||
              (o.card !== null &&
                (o.seatId !== this.#seatId || o.destination !== 'hand' || !card(o.card)))
            )
              return 'invalid';
            this.draw = { seatId: o.seatId, rejected: false, destination: o.destination };
          }
        }
        this.transfers = transfers;
      }
      if (message.type !== 'owner-history') this.snapshot = null;
      if (message.type === 'rollback-notice') {
        this.transfers = [];
        this.#penaltyTimer = null;
        this.draw = null;
        this.reset = true;
        this.#revealKey = null;
      }
      return 'meta';
    }
    let next = snapshot(message.view, this.#seatId);
    if (!next) return 'invalid';
    this.#routeTo(next.head);
    if (this.draw && next.state && !next.state.players.some((p) => p.id === this.draw!.seatId))
      return 'invalid';
    const players = next.state?.players;
    if (!players) this.transfers = [];
    else if (
      this.transfers.some((t) =>
        [t.fromSeatId, t.toSeatId].some((id) => !players.some((p) => p.id === id)),
      )
    )
      return 'invalid';
    if (next.penalty) {
      const p = next.penalty;
      const key = JSON.stringify([next.head.gameId, next.head.branchId, p.timer.id]);
      const prior = this.#penaltyTimer;
      const expiresAt = p.timer.paused
        ? null
        : prior?.key === key && !prior.timer.paused
          ? Math.min(prior.timer.expiresAt!, this.#now() + p.timer.remainingMs)
          : this.#now() + p.timer.remainingMs;
      const timer = { ...p.timer, expiresAt };
      this.#penaltyTimer = { key, timer };
      next = { ...next, penalty: { ...p, timer } };
    } else this.#penaltyTimer = null;
    if (next.reveal) {
      const raw = message.view as { transient: { reveal: { timer: { id: string } } } };
      const key = JSON.stringify([
        next.head.gameId,
        next.head.branchId,
        raw.transient.reveal.timer.id,
      ]);
      const deadline = this.#now() + next.reveal.expiresAt;
      this.#revealDeadline =
        key === this.#revealKey ? Math.min(this.#revealDeadline, deadline) : deadline;
      this.#revealKey = key;
      next = {
        ...next,
        reveal:
          this.#revealDeadline > this.#now()
            ? { ...next.reveal, expiresAt: this.#revealDeadline }
            : null,
      };
    } else if (
      next.paused ||
      (object(message.view) && message.view.procedure !== null) ||
      next.state?.phase !== 'trump-reveal'
    ) {
      this.#revealKey = null;
    }
    this.snapshot = next;
    return 'state';
  }
}
