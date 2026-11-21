import { exact, object } from './game-stream.ts';
import { validLobbyLocator as id } from './lobby-membership.ts';
import type { OwnerHistoryEntry } from '../protocol/contracts.ts';
const n = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const pos = (v: unknown): v is number => n(v) && v > 0;
const one = (v: unknown, values: string[]) => typeof v === 'string' && values.includes(v);
const hh = (v: unknown): boolean =>
  exact(v, ['gameId', 'branch', 'version']) && id(v.gameId) && pos(v.branch) && n(v.version);
const point = (v: unknown): boolean =>
  exact(v, ['branch', 'version']) && pos(v.branch) && pos(v.version);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function summary(v: unknown): boolean {
  if (!object(v)) return false;
  if (
    one(v.type, [
      'game-started',
      'card-played',
      'stump-opened',
      'claim-vote-cast',
      'withdrawal-answered',
      'penalty-answered',
    ])
  )
    return exact(v, ['type', 'actorId']) && id(v.actorId);
  if (
    one(v.type, [
      'claim-vote-expired',
      'withdrawal-expired',
      'penalty-started',
      'penalty-expired',
      'penalty-completed',
      'reveal-finished',
      'reveal-resumed',
      'clock-suspended',
      'clock-resumed',
      'server-action',
    ])
  )
    return exact(v, ['type']);
  switch (v.type) {
    case 'card-drawn':
      return (
        exact(v, ['type', 'actorId', 'destination']) &&
        id(v.actorId) &&
        one(v.destination, ['hand', 'stump'])
      );
    case 'bottom-taken':
      return (
        exact(v, ['type', 'actorId', 'automatic']) &&
        id(v.actorId) &&
        typeof v.automatic === 'boolean'
      );
    case 'violation':
      return (
        exact(v, ['type', 'actorId', 'reason']) &&
        id(v.actorId) &&
        one(v.reason, [
          'draw-out-of-turn',
          'invalid-beat',
          'play-out-of-turn',
          'peek',
          'must-open-stump',
          'claim',
        ])
      );
    case 'claim-submitted': {
      const c = v.claim;
      return (
        exact(v, ['type', 'claim']) &&
        exact(c, [
          'submittedAtVersion',
          'claimantId',
          'accusedId',
          'reason',
          'scope',
          'scopeNumber',
        ]) &&
        pos(c.submittedAtVersion) &&
        id(c.claimantId) &&
        id(c.accusedId) &&
        typeof c.reason === 'string' &&
        c.reason.isWellFormed() &&
        !c.reason.includes('\0') &&
        one(c.scope, ['dealing', 'between-rounds', 'round']) &&
        n(c.scopeNumber)
      );
    }
    case 'claim-vote-started':
    case 'withdrawal-started':
      return exact(v, ['type', 'submittedAtVersion']) && pos(v.submittedAtVersion);
    case 'withdrawal-requested':
      return (
        exact(v, ['type', 'submittedAtVersion', 'actorId']) &&
        pos(v.submittedAtVersion) &&
        id(v.actorId)
      );
    case 'claim-vote-resolved':
      return (
        exact(v, ['type', 'submittedAtVersion', 'resolution']) &&
        pos(v.submittedAtVersion) &&
        one(v.resolution, ['upheld', 'rejected', 'tied'])
      );
    case 'withdrawal-resolved':
      return (
        exact(v, ['type', 'submittedAtVersion', 'approved']) &&
        pos(v.submittedAtVersion) &&
        typeof v.approved === 'boolean'
      );
    case 'rollback':
      return exact(v, ['type', 'actorId', 'rollback']) && id(v.actorId) && pos(v.rollback);
    default:
      return false;
  }
}
function entry(v: unknown): boolean {
  if (!object(v)) return false;
  if (v.type === 'branch') {
    const b = v.branch;
    return (
      exact(v, ['type', 'branch']) &&
      exact(b, ['head', 'label', 'parent']) &&
      hh(b.head) &&
      one(b.label, ['active', 'abandoned']) &&
      (b.parent === null || hh(b.parent))
    );
  }
  if (v.type === 'rollback') {
    const r = v.rollback;
    return (
      exact(v, ['type', 'rollback']) &&
      exact(r, ['actorId', 'occurredAtMs', 'abandoned', 'parent', 'restored', 'beforeAction']) &&
      id(r.actorId) &&
      n(r.occurredAtMs) &&
      hh(r.abandoned) &&
      hh(r.parent) &&
      hh(r.restored) &&
      point(r.beforeAction)
    );
  }
  if (v.type !== 'action' || !exact(v, ['type', 'branch', 'action']) || !pos(v.branch))
    return false;
  const a = v.action;
  return (
    exact(a, ['version', 'origin', 'occurredAtMs', 'summaries', 'rollbackTarget']) &&
    pos(a.version) &&
    point(a.origin) &&
    n(a.occurredAtMs) &&
    Array.isArray(a.summaries) &&
    a.summaries.every(summary) &&
    (a.rollbackTarget === null ||
      (exact(a.rollbackTarget, ['expected', 'beforeActionVersion']) &&
        hh(a.rollbackTarget.expected) &&
        a.rollbackTarget.beforeActionVersion === a.version))
  );
}
export class OwnerHistory {
  #pending: { requestId: string; gameId: string; offset: number } | null = null;
  current: {
    entries: readonly OwnerHistoryEntry[];
    snapshot: string | null;
    head: { gameId: string; branch: number; version: number } | null;
    rollbackOpen: boolean;
    next: { snapshot: string; offset: number } | null;
    selected: { branch: number; version: number } | null;
    status: 'idle' | 'pending' | 'partial' | 'complete' | 'stale' | 'unavailable' | 'uncertain';
  } = {
    entries: [],
    snapshot: null,
    head: null,
    rollbackOpen: false,
    next: null,
    selected: null,
    status: 'idle',
  };
  interrupt(status: 'uncertain' | 'stale' | 'unavailable' = 'uncertain') {
    this.#pending = null;
    this.current = {
      entries: [],
      snapshot: null,
      head: null,
      rollbackOpen: false,
      next: null,
      selected: null,
      status,
    };
  }
  request(requestId: string, gameId: string, first: boolean) {
    if (this.#pending || (!first && this.current.status !== 'partial')) return null;
    if (first) this.interrupt();
    const cursor = this.current.next;
    this.#pending = { requestId, gameId, offset: cursor?.offset ?? 0 };
    this.current = { ...this.current, selected: null, status: 'pending' };
    return {
      protocolVersion: 1,
      requestId,
      intent: { type: 'owner-history-page', gameId, cursor, limit: 100 },
    };
  }
  select(branch: number, version: number) {
    const found =
      this.current.status === 'complete' &&
      this.current.entries.some(
        (e) =>
          e.type === 'action' &&
          e.branch === branch &&
          e.action.version === version &&
          e.action.rollbackTarget !== null,
      );
    this.current = { ...this.current, selected: found ? { branch, version } : null };
  }
  receive(raw: unknown): 'accepted' | 'ignored' | 'invalid' {
    if (!object(raw) || raw.requestId !== this.#pending?.requestId) return 'ignored';
    const pending = this.#pending!;
    const invalid = () => {
      this.interrupt('unavailable');
      return 'invalid' as const;
    };
    if (
      !exact(raw, ['protocolVersion', 'type', 'requestId', 'delivery', 'result']) ||
      raw.protocolVersion !== 1 ||
      raw.type !== 'owner-history-page'
    )
      return invalid();
    const r = raw.result;
    if (exact(r, ['type']) && (r.type === 'stale' || r.type === 'unavailable')) {
      this.interrupt(r.type);
      return 'accepted';
    }
    if (
      !exact(r, ['type', 'head', 'rollbackOpen', 'snapshot', 'entries', 'next']) ||
      r.type !== 'page' ||
      !hh(r.head) ||
      !object(r.head) ||
      r.head.gameId !== pending.gameId ||
      typeof r.rollbackOpen !== 'boolean' ||
      !digest(r.snapshot) ||
      !Array.isArray(r.entries) ||
      r.entries.length < 1 ||
      r.entries.length > 100 ||
      !r.entries.every(entry)
    )
      return invalid();
    if (
      pending.offset &&
      (r.snapshot !== this.current.snapshot ||
        !same(r.head, this.current.head) ||
        r.rollbackOpen !== this.current.rollbackOpen)
    )
      return invalid();
    const end = pending.offset + r.entries.length;
    if (
      r.next !== null &&
      (!exact(r.next, ['snapshot', 'offset']) ||
        r.next.snapshot !== r.snapshot ||
        r.next.offset !== end)
    )
      return invalid();
    const entries = [...this.current.entries, ...structuredClone(r.entries)] as OwnerHistoryEntry[];
    let branch: Extract<OwnerHistoryEntry, { type: 'branch' }>['branch'] | null = null,
      version = 0,
      audit = false;
    const branches = new Set<number>();
    let active = 0;
    for (const e of entries) {
      if (e.type === 'branch') {
        if (
          (branch && version !== branch.head.version) ||
          audit ||
          branches.has(e.branch.head.branch) ||
          e.branch.head.gameId !== pending.gameId
        )
          return invalid();
        branches.add(e.branch.head.branch);
        branch = e.branch;
        version = 0;
        if (branch.label === 'active') {
          active++;
          if (!same(branch.head, r.head)) return invalid();
        }
      } else if (e.type === 'action') {
        if (
          audit ||
          !branch ||
          e.branch !== branch.head.branch ||
          e.action.version !== ++version ||
          version > branch.head.version
        )
          return invalid();
        const t = e.action.rollbackTarget;
        if (t && (!r.rollbackOpen || branch.label !== 'active' || !same(t.expected, r.head)))
          return invalid();
      } else {
        if (!branch || version !== branch.head.version) return invalid();
        audit = true;
      }
    }
    if (r.next === null && (!branch || version !== branch.head.version || active !== 1))
      return invalid();
    if (r.next === null) {
      const heads = new Map(
        entries.flatMap((e) =>
          e.type === 'branch' ? [[e.branch.head.branch, e.branch.head] as const] : [],
        ),
      );
      const validHead = (h: { gameId: string; branch: number; version: number }) =>
        h.gameId === pending.gameId &&
        heads.has(h.branch) &&
        h.version <= heads.get(h.branch)!.version;
      for (const e of entries) {
        if (e.type === 'branch' && e.branch.parent && !validHead(e.branch.parent)) return invalid();
        if (
          e.type === 'action' &&
          (!heads.has(e.action.origin.branch) ||
            e.action.origin.version > heads.get(e.action.origin.branch)!.version)
        )
          return invalid();
        if (
          e.type === 'rollback' &&
          (![e.rollback.abandoned, e.rollback.parent, e.rollback.restored].every(validHead) ||
            !heads.has(e.rollback.beforeAction.branch) ||
            e.rollback.beforeAction.version > heads.get(e.rollback.beforeAction.branch)!.version)
        )
          return invalid();
      }
    }
    this.#pending = null;
    this.current = {
      ...this.current,
      entries,
      snapshot: r.snapshot,
      head: structuredClone(r.head) as typeof this.current.head,
      rollbackOpen: r.rollbackOpen,
      next: structuredClone(r.next) as typeof this.current.next,
      status: r.next === null ? 'complete' : 'partial',
    };
    return 'accepted';
  }
}
