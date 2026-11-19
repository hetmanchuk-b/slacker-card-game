import { applyAction } from '../game/engine.ts';
import type { BranchHead, DomainEvent } from '../game/contracts.ts';
import type { LobbyId, SeatId } from '../game/ids.ts';
import type { GameState } from '../game/model.ts';
import type { ChatMessage } from '../persistence/lobby-contracts.ts';
import type { ClaimCapture, ClaimRequest, ClaimResolver } from '../runtime/runtime.ts';

type Resolution = Awaited<ReturnType<ClaimResolver>>;
function scope(state: GameState | null): Resolution {
  if (!state || state.phase.type === 'finished') return { type: 'rejected', code: 'scope-closed' };
  if (state.phase.type === 'round')
    return { type: 'resolved', scope: 'round', scopeNumber: state.phase.number };
  return state.completedRounds === 0
    ? { type: 'resolved', scope: 'dealing', scopeNumber: 0 }
    : { type: 'resolved', scope: 'between-rounds', scopeNumber: state.completedRounds };
}

/** A chat head denotes a point after a committed action. Ancestor heads are
 * valid only within every fork's retained prefix, including nested early forks.
 */
function retained(head: BranchHead, capture: ClaimCapture): boolean {
  if (head.gameId !== capture.history.head.gameId || head.version < 1) return false;
  let cursor: BranchHead | null = capture.history.head;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.branchId)) {
    if (head.branchId === cursor.branchId) return head.version <= cursor.version;
    seen.add(cursor.branchId);
    const parent = capture.branches.find(
      (branch) => branch.head.branchId === cursor!.branchId,
    )?.parent;
    cursor = parent ? { ...parent, version: Math.min(cursor.version, parent.version) } : null;
  }
  return false;
}

/** Only an initiating player event identifies the command actor. Never infer
 * authorship from automatic pickups/transfers/verdicts later in an action.
 */
function actor(event: DomainEvent | undefined): SeatId | null {
  switch (event?.type) {
    case 'card-drawn':
    case 'out-of-turn-draw':
    case 'card-played':
    case 'stump-opened':
    case 'penalty-answered':
    case 'claim-vote-cast':
    case 'withdrawal-requested':
    case 'withdrawal-answered':
      return event.seatId;
    case 'bottom-taken':
      return event.automatic ? null : event.seatId;
    case 'violation-detected':
      return event.penalty.recipientId;
    case 'claim-submitted':
      return event.claim.claimantId;
    default:
      return null;
  }
}

/** Trusted queue capture + immutable lobby-scoped chat only. No state, author,
 * existence diagnostics or raw evidence escapes in a rejection.
 */
export function resolveClaimEvidence(
  request: ClaimRequest,
  capture: ClaimCapture,
  lobbyId: LobbyId,
  chat: ChatMessage | null,
): Resolution {
  const invalid: Resolution = { type: 'rejected', code: 'invalid-claim' };
  const incident = request.incident;
  if (incident.type === 'spoken') return scope(capture.snapshot.state);
  if (incident.type === 'chat') {
    if (
      !chat ||
      chat.id !== incident.messageId ||
      chat.lobbyId !== lobbyId ||
      chat.authorSeatId !== request.accusedId ||
      !chat.context.head ||
      !retained(chat.context.head, capture) ||
      chat.context.scope === 'lobby' ||
      chat.context.scopeNumber === null
    )
      return invalid;
    return { type: 'resolved', scope: chat.context.scope, scopeNumber: chat.context.scopeNumber };
  }
  let before: GameState | null = null;
  for (const action of capture.history.actions) {
    if (action.commandId === incident.commandId) {
      const first = action.events[0]?.event;
      if (actor(first) !== request.accusedId) return invalid;
      // A successful lead starts a round in this very event; the final action
      // of a round still belongs to the pre-action round, not its settled gap.
      if (first?.type === 'card-played' && before?.phase.type === 'between-rounds')
        return { type: 'resolved', scope: 'round', scopeNumber: before.completedRounds + 1 };
      return scope(before);
    }
    before = applyAction(before, action);
  }
  return invalid;
}
