import type { CardId, ClaimId, ProcedureId, SeatId } from '../game/ids.ts';
import type { Claim, GameState, Procedure, Timer, Vote } from '../game/model.ts';
import type { RuntimeSnapshot } from '../runtime/runtime.ts';
import { projectGame } from './game.ts';
import type { GameViewer, GameView, VisibleCard } from './game.ts';

export type VisibleTimer = Readonly<{ id: ProcedureId; remainingMs: number; paused: boolean }>;
export type VisibleClaim = Readonly<{
  id: ClaimId;
  claimantId: SeatId;
  accusedId: SeatId;
  reason: string;
  scope: 'dealing' | 'between-rounds' | 'round';
  scopeNumber: number;
}>;
export type VisibleBallot = Readonly<{
  type: 'claim-vote';
  claim: VisibleClaim;
  eligibleSeatIds: readonly SeatId[];
  ownVote: Vote | null;
  timer: VisibleTimer;
}>;
export type VisibleProcedure =
  | VisibleBallot
  | Readonly<{
      type: 'withdrawal';
      claim: VisibleClaim;
      eligibleSeatIds: readonly SeatId[];
      ownApproval: boolean | null;
      suspendedVote: VisibleBallot | null;
      timer: VisibleTimer;
    }>
  | Readonly<{
      type: 'penalty';
      recipientId: SeatId;
      reason:
        | 'draw-out-of-turn'
        | 'invalid-beat'
        | 'play-out-of-turn'
        | 'peek'
        | 'must-open-stump'
        | 'claim';
      eligibleSeatIds: readonly SeatId[];
      ownResponse:
        Readonly<{ type: 'refuse' }> | Readonly<{ type: 'card'; card: VisibleCard }> | null;
      timer: VisibleTimer;
    }>;
export type LiveGameView = GameView &
  Readonly<{
    transient: Readonly<{
      initialRecipientNotice: boolean;
      reveal: Readonly<{ card: VisibleCard; recipientId: SeatId; timer: VisibleTimer }> | null;
    }>;
    procedure: VisibleProcedure | null;
    control: Readonly<{
      paused: boolean;
      connections: readonly Readonly<{
        seatId: SeatId;
        connected: boolean;
        controller: 'human' | 'bot';
      }>[];
      replacementVote: Readonly<{
        absentSeatId: SeatId;
        eligibleSeatIds: readonly SeatId[];
        ownVote: Vote | null;
        timer: VisibleTimer;
      }> | null;
    }>;
  }>;

function timerView(timer: Timer, nowMs: number): VisibleTimer {
  if (timer.startedAtMs !== null && nowMs < timer.startedAtMs)
    throw new Error('Invalid projection time');
  return {
    id: timer.id,
    remainingMs:
      timer.startedAtMs === null
        ? timer.remainingMs
        : Math.max(0, timer.remainingMs - (nowMs - timer.startedAtMs)),
    paused: timer.startedAtMs === null,
  };
}

function claimView(claim: Claim): VisibleClaim {
  return {
    id: claim.id,
    claimantId: claim.claimantId,
    accusedId: claim.accusedId,
    reason: claim.reason,
    scope: claim.scope,
    scopeNumber: claim.scopeNumber,
  };
}

function ownAnswer<T>(answers: Readonly<Partial<Record<SeatId, T>>>, viewer: GameViewer): T | null {
  return viewer.type === 'seat' && Object.hasOwn(answers, viewer.seatId)
    ? (answers[viewer.seatId] ?? null)
    : null;
}

function faceView(state: GameState, cardId: CardId): VisibleCard {
  const card = state.cards.find((card) => card.id === cardId);
  if (!card) throw new Error('Projection card unavailable');
  return { id: card.id, face: { suit: card.face.suit, rank: card.face.rank } };
}

function procedureView(
  state: GameState,
  procedure: Procedure | null,
  viewer: GameViewer,
  nowMs: number,
): VisibleProcedure | null {
  if (!procedure) return null;
  const timer = timerView(procedure.timer, nowMs);
  const eligibleSeatIds = [...procedure.eligibleSeatIds];
  switch (procedure.type) {
    case 'claim-vote':
      return {
        type: 'claim-vote',
        claim: claimView(procedure.claim),
        eligibleSeatIds,
        ownVote: ownAnswer(procedure.votes, viewer),
        timer,
      };
    case 'withdrawal':
      return {
        type: 'withdrawal',
        claim: claimView(procedure.claim),
        eligibleSeatIds,
        ownApproval: ownAnswer(procedure.approvals, viewer),
        suspendedVote: procedure.suspendedVote
          ? (procedureView(state, procedure.suspendedVote, viewer, nowMs) as VisibleBallot)
          : null,
        timer,
      };
    case 'penalty': {
      const response = ownAnswer(procedure.responses, viewer);
      return {
        type: 'penalty',
        recipientId: procedure.penalty.recipientId,
        reason: procedure.penalty.reason,
        eligibleSeatIds,
        timer,
        ownResponse:
          response === null
            ? null
            : response === 'refuse'
              ? { type: 'refuse' }
              : { type: 'card', card: faceView(state, response) },
      };
    }
  }
}

/**
 * Current authorized disclosures at trusted server time, composed with the baseline.
 * Reconnect may call this again, but must never replay fresh-action observations.
 * No peek ledger, historical reveal, raw procedure, ballots of other seats or audit is returned.
 */
export function projectLiveGame(
  snapshot: RuntimeSnapshot,
  viewer: GameViewer,
  nowMs: number,
): LiveGameView {
  const base = projectGame(snapshot, viewer);
  const state = snapshot.state;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || (state && nowMs < state.createdAtMs))
    throw new Error('Invalid projection time');
  const revealPhase = state?.phase.type === 'trump-reveal' ? state.phase : null;
  const revealTimer = revealPhase ? timerView(revealPhase.timer, nowMs) : null;
  const replacement = snapshot.replacementVote;
  return {
    ...base,
    transient: {
      initialRecipientNotice:
        state?.phase.type === 'dealing' &&
        state.phase.drawCount === 0 &&
        viewer.type === 'seat' &&
        viewer.seatId === state.phase.nextSeatId,
      reveal:
        state &&
        revealPhase &&
        revealTimer &&
        !revealTimer.paused &&
        revealTimer.remainingMs > 0 &&
        state.clock.type === 'running'
          ? {
              card: faceView(state, revealPhase.cardId),
              recipientId: revealPhase.recipientId,
              timer: revealTimer,
            }
          : null,
    },
    procedure: state ? procedureView(state, state.procedure, viewer, nowMs) : null,
    control: {
      paused: snapshot.paused,
      connections: snapshot.connections
        .filter((connection) => state?.players.some((player) => player.id === connection.seatId))
        .map((connection) => ({
          seatId: connection.seatId,
          connected: connection.connected,
          controller: connection.controller,
        })),
      replacementVote:
        state && replacement
          ? {
              absentSeatId: replacement.absentSeatId,
              eligibleSeatIds: [...replacement.eligibleSeatIds],
              ownVote: ownAnswer(replacement.votes, viewer),
              timer: timerView(replacement.timer, nowMs),
            }
          : null,
    },
  };
}
