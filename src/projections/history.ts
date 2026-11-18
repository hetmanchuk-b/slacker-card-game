import type { ActionBatch, BranchHead, DomainEvent } from '../game/contracts.ts';
import type { BranchId, ClaimId, GameId, SeatId } from '../game/ids.ts';
import type { RollbackAudit } from '../persistence/history.ts';
import type { GameViewer } from './game.ts';

/** Private, trusted committed capture; structurally compatible with snapshot().value.
 * Storage validates/reconstructs this capture. Never accept it from a browser.
 * State, cache digests and fork receipts are deliberately not part of this seam.
 */
type BranchCapture = Readonly<{ head: BranchHead; actions: readonly ActionBatch[] }>;
export type OwnerHistoryInput = Readonly<{
  active: BranchCapture;
  archives: readonly BranchCapture[];
  parents: readonly (readonly [BranchId, BranchHead | null])[];
  ownerId: SeatId | null;
  closedRollback: boolean;
  audit: readonly RollbackAudit[];
}>;

/** Branch numbers are stable ordinals in this game's persisted ancestry order.
 * No raw branch/command/event/claim/procedure identifiers are display payloads.
 */
export type HistoryHead = Readonly<{ gameId: GameId; branch: number; version: number }>;
export type HistorySummary =
  | Readonly<{
      type:
        | 'game-started'
        | 'card-played'
        | 'stump-opened'
        | 'claim-vote-cast'
        | 'withdrawal-answered'
        | 'penalty-answered';
      actorId: SeatId;
    }>
  | Readonly<{ type: 'card-drawn'; actorId: SeatId; destination: 'hand' | 'stump' }>
  | Readonly<{ type: 'bottom-taken'; actorId: SeatId; automatic: boolean }>
  | Readonly<{
      type: 'violation';
      actorId: SeatId;
      reason:
        | 'draw-out-of-turn'
        | 'invalid-beat'
        | 'play-out-of-turn'
        | 'peek'
        | 'must-open-stump'
        | 'claim';
    }>
  | Readonly<{
      type: 'claim-submitted';
      claim: Readonly<{
        submittedAtVersion: number;
        claimantId: SeatId;
        accusedId: SeatId;
        reason: string;
        scope: 'dealing' | 'between-rounds' | 'round';
        scopeNumber: number;
      }>;
    }>
  | Readonly<{ type: 'claim-vote-started' | 'withdrawal-started'; submittedAtVersion: number }>
  | Readonly<{ type: 'withdrawal-requested'; submittedAtVersion: number; actorId: SeatId }>
  | Readonly<{
      type: 'claim-vote-resolved';
      submittedAtVersion: number;
      resolution: 'upheld' | 'rejected' | 'tied';
    }>
  | Readonly<{ type: 'withdrawal-resolved'; submittedAtVersion: number; approved: boolean }>
  | Readonly<{ type: 'rollback'; actorId: SeatId; rollback: number }>
  | Readonly<{
      type:
        | 'claim-vote-expired'
        | 'withdrawal-expired'
        | 'penalty-started'
        | 'penalty-expired'
        | 'penalty-completed'
        | 'reveal-finished'
        | 'reveal-resumed'
        | 'clock-suspended'
        | 'clock-resumed'
        | 'server-action';
    }>;
export type HistoryRow = Readonly<{
  version: number;
  origin: Readonly<{ branch: number; version: number }>;
  occurredAtMs: number;
  summaries: readonly HistorySummary[];
  /** Resolve against a fresh matching committed head on the server before rollback.
   * beforeActionVersion selects the completed action, NOT an event/pre-state index.
   */
  rollbackTarget: Readonly<{ expected: HistoryHead; beforeActionVersion: number }> | null;
}>;
export type OwnerHistoryView = Readonly<{
  head: HistoryHead;
  rollbackOpen: boolean;
  branches: readonly Readonly<{
    head: HistoryHead;
    label: 'active' | 'abandoned';
    parent: HistoryHead | null;
    actions: readonly HistoryRow[];
  }>[];
  rollbacks: readonly Readonly<{
    actorId: SeatId;
    occurredAtMs: number;
    abandoned: HistoryHead;
    parent: HistoryHead;
    restored: HistoryHead;
    beforeAction: Readonly<{ branch: number; version: number }>;
  }>[];
}>;

function summary(
  event: DomainEvent,
  version: number,
  claims: Map<ClaimId, number>,
): HistorySummary | null {
  const claimVersion = (id: ClaimId): number => {
    const found = claims.get(id);
    if (found === undefined) throw new Error();
    return found;
  };
  switch (event.type) {
    case 'game-started':
      return { type: 'game-started', actorId: event.ownerId };
    case 'card-drawn':
      return { type: 'card-drawn', actorId: event.seatId, destination: event.destination };
    case 'card-played':
    case 'stump-opened':
    case 'claim-vote-cast':
    case 'withdrawal-answered':
    case 'penalty-answered':
      return { type: event.type, actorId: event.seatId };
    case 'bottom-taken':
      return { type: 'bottom-taken', actorId: event.seatId, automatic: event.automatic };
    case 'out-of-turn-draw':
      return { type: 'violation', actorId: event.seatId, reason: 'draw-out-of-turn' };
    case 'violation-detected':
      return {
        type: 'violation',
        actorId: event.penalty.recipientId,
        reason: event.penalty.reason,
      };
    case 'claim-submitted': {
      const claim = event.claim;
      claims.set(claim.id, version);
      return {
        type: 'claim-submitted',
        claim: {
          submittedAtVersion: version,
          claimantId: claim.claimantId,
          accusedId: claim.accusedId,
          reason: claim.reason,
          scope: claim.scope,
          scopeNumber: claim.scopeNumber,
        },
      };
    }
    case 'claim-vote-started':
    case 'withdrawal-started':
      return { type: event.type, submittedAtVersion: claimVersion(event.claimId) };
    case 'withdrawal-requested':
      return {
        type: event.type,
        submittedAtVersion: claimVersion(event.claimId),
        actorId: event.seatId,
      };
    case 'claim-vote-resolved':
      return {
        type: event.type,
        submittedAtVersion: claimVersion(event.claimId),
        resolution: event.resolution,
      };
    case 'withdrawal-resolved':
      return {
        type: event.type,
        submittedAtVersion: claimVersion(event.claimId),
        approved: event.approved,
      };
    case 'claim-vote-expired':
    case 'withdrawal-expired':
    case 'penalty-started':
    case 'penalty-expired':
    case 'penalty-completed':
    case 'reveal-finished':
    case 'reveal-resumed':
    case 'clock-suspended':
    case 'clock-resumed':
      return { type: event.type };
    // Repetition keys and any future unknown event stay server-only. Rebases
    // are handled via administrative audit, never a replay/state preview.
    default:
      return null;
  }
}

/** Metadata-only owner history (D003), separate from current seat visibility.
 * Authentication, integrity and commit provenance are caller obligations. An
 * in-flight MemoryHistory draft is NOT made committed by calling snapshot().
 * This function never reads card catalogs, states, timers or live observations.
 */
export function projectOwnerHistory(
  input: OwnerHistoryInput,
  viewer: GameViewer,
): OwnerHistoryView {
  if (input.ownerId === null || viewer.type !== 'seat' || viewer.seatId !== input.ownerId)
    throw new Error('Owner history unavailable');
  try {
    const gameId = input.active.head.gameId;
    const snapshots = [input.active, ...input.archives];
    const branches = new Map(snapshots.map((branch) => [branch.head.branchId, branch]));
    const parents = new Map(input.parents);
    const numbers = new Map(input.parents.map(([id], index) => [id, index + 1]));
    if (
      branches.size !== snapshots.length ||
      parents.size !== input.parents.length ||
      parents.size !== branches.size ||
      typeof input.closedRollback !== 'boolean' ||
      input.parents.filter(([, parent]) => parent === null).length !== 1
    )
      throw new Error();
    const displayHead = (head: BranchHead): HistoryHead => {
      const branch = numbers.get(head.branchId);
      const captured = branches.get(head.branchId);
      if (
        head.gameId !== gameId ||
        branch === undefined ||
        !captured ||
        !Number.isSafeInteger(head.version) ||
        head.version < 0 ||
        head.version > captured.head.version
      )
        throw new Error();
      return { gameId, branch, version: head.version };
    };
    for (const branch of snapshots) {
      const { head, actions } = branch;
      displayHead(head);
      if (
        head.version !== actions.length ||
        !parents.has(head.branchId) ||
        new Set(actions.map((action) => action.commandId)).size !== actions.length ||
        actions.some(
          (action, index) =>
            action.events.length === 0 ||
            !Number.isSafeInteger(action.occurredAtMs) ||
            action.occurredAtMs < (actions[index - 1]?.occurredAtMs ?? 0),
        )
      )
        throw new Error();
      const parent = parents.get(head.branchId)!;
      if (parent) {
        displayHead(parent);
        if (
          parent.version > actions.length ||
          actions
            .slice(0, parent.version)
            .some(
              (action, index) =>
                action.commandId !== branches.get(parent.branchId)!.actions[index]!.commandId,
            )
        )
          throw new Error();
      }
      const visited = new Set<BranchId>();
      let ancestor: BranchId | null = head.branchId;
      while (ancestor !== null) {
        if (visited.has(ancestor) || !parents.has(ancestor)) throw new Error();
        visited.add(ancestor);
        ancestor = parents.get(ancestor)?.branchId ?? null;
      }
    }
    const audits = new Map(input.audit.map((item, index) => [item.commandId, index]));
    if (audits.size !== input.audit.length || input.audit.length + 1 !== branches.size)
      throw new Error();
    const rollbacks = input.audit.map((item) => {
      const source = branches.get(item.abandonedHead.branchId);
      const parent = parents.get(item.head.branchId);
      if (
        !source ||
        item.actorId !== input.ownerId ||
        !Number.isSafeInteger(item.atMs) ||
        item.atMs < 0 ||
        item.parent.branchId !== item.abandonedHead.branchId ||
        source.head.version !== item.abandonedHead.version ||
        source.actions[item.parent.version]?.commandId !== item.beforeCommandId ||
        !parent ||
        parent.gameId !== item.parent.gameId ||
        parent.branchId !== item.parent.branchId ||
        parent.version !== item.parent.version
      )
        throw new Error();
      return {
        actorId: item.actorId,
        occurredAtMs: item.atMs,
        abandoned: displayHead(item.abandonedHead),
        parent: displayHead(item.parent),
        restored: displayHead(item.head),
        beforeAction: {
          branch: numbers.get(item.parent.branchId)!,
          version: item.parent.version + 1,
        },
      };
    });
    const origin = (
      branchId: BranchId,
      index: number,
    ): Readonly<{ branch: number; version: number }> => {
      let current = branchId;
      let parent = parents.get(current);
      while (parent && index < parent.version) {
        current = parent.branchId;
        parent = parents.get(current);
      }
      return { branch: numbers.get(current)!, version: index + 1 };
    };
    return {
      head: displayHead(input.active.head),
      rollbackOpen: !input.closedRollback,
      branches: input.parents.map(([branchId, parent]) => {
        const branch = branches.get(branchId)!;
        const active = branchId === input.active.head.branchId;
        const claims = new Map<ClaimId, number>();
        return {
          head: displayHead(branch.head),
          label: active ? 'active' : 'abandoned',
          parent: parent ? displayHead(parent) : null,
          actions: branch.actions.map((action, index) => {
            const version = index + 1;
            const summaries = action.events.flatMap(({ event }): HistorySummary[] => {
              if (event.type === 'clock-rebased') {
                const audit = audits.get(action.commandId);
                if (audit === undefined) throw new Error();
                return [
                  { type: 'rollback', actorId: input.audit[audit]!.actorId, rollback: audit + 1 },
                ];
              }
              const selected = summary(event, version, claims);
              return selected ? [selected] : [];
            });
            return {
              version,
              origin: origin(branchId, index),
              occurredAtMs: action.occurredAtMs,
              summaries: summaries.length ? summaries : [{ type: 'server-action' }],
              rollbackTarget:
                active && !input.closedRollback
                  ? { expected: displayHead(input.active.head), beforeActionVersion: version }
                  : null,
            };
          }),
        };
      }),
      rollbacks,
    };
  } catch {
    // Never echo malformed private records or identifiers in a viewer error.
    throw new Error('Invalid owner history context');
  }
}
