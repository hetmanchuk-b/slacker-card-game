import { id } from './ids.ts';
import type {
  ClaimCommand,
  ClaimEvent,
  Decision,
  DecisionContext,
  RejectionCode,
  WithdrawalCommand,
  WithdrawalEvent,
} from './contracts.ts';
import type { ClaimId, ProcedureId, SeatId } from './ids.ts';
import type { Claim, ClaimVote, GameState, IncidentReference, Timer, Vote } from './model.ts';

/** Namespaced identity; descriptions of a spoken episode are deliberately not interpreted. */
export function incidentKey(incident: IncidentReference): string {
  switch (incident.type) {
    case 'spoken':
      return JSON.stringify(['spoken', incident.key]);
    case 'chat':
      return JSON.stringify(['chat', incident.messageId]);
    case 'action':
      return JSON.stringify(['action', incident.commandId]);
  }
}

function scopeOpen(state: GameState, claim: Claim): boolean {
  if (state.phase.type === 'finished') return false;
  if (claim.scope === 'dealing')
    return claim.scopeNumber === 0 && state.completedRounds === 0 && state.phase.type !== 'round';
  if (claim.scope === 'round')
    return state.phase.type === 'round' && state.phase.number === claim.scopeNumber;
  return state.phase.type === 'between-rounds' && state.completedRounds === claim.scopeNumber;
}

function submissionError(state: GameState, claim: Claim, nowMs: number): RejectionCode | null {
  const starts = [
    state.procedure?.timer.startedAtMs ?? null,
    state.phase.type === 'trump-reveal' ? state.phase.timer.startedAtMs : null,
  ];
  if (starts.some((start) => start !== null && nowMs < start)) return 'invalid-time';
  const claimant = state.players.find((player) => player.id === claim.claimantId);
  const accused = state.players.find((player) => player.id === claim.accusedId);
  if (!claimant || !accused) return 'unknown-seat';
  if (claimant.status !== 'active' || accused.status !== 'active') return 'inactive-seat';
  if (!scopeOpen(state, claim)) return 'scope-closed';
  const reference =
    claim.incident.type === 'spoken'
      ? claim.incident.key
      : claim.incident.type === 'chat'
        ? claim.incident.messageId
        : claim.incident.commandId;
  if (
    !claim.reason.trim() ||
    !reference.trim() ||
    !Number.isSafeInteger(claim.scopeNumber) ||
    claim.scopeNumber < 0 ||
    claim.incidentKey !== incidentKey(claim.incident)
  )
    return 'invalid-claim';
  if (
    state.automaticIncidents.includes(claim.incidentKey) ||
    state.claims.some(
      (record) =>
        record.claim.incidentKey === claim.incidentKey ||
        record.claim.id === claim.id ||
        record.claim.commandId === claim.commandId,
    )
  )
    return 'incident-already-handled';
  return null;
}

export function decideClaimCommand(
  state: GameState | null,
  command: ClaimCommand,
  context: DecisionContext,
): Decision {
  if (state === null) return { type: 'rejected', code: 'not-started' };
  if (
    command.type === 'request-withdrawal' ||
    command.type === 'withdrawal-response' ||
    command.type === 'expire-withdrawal'
  )
    return decideWithdrawal(state, command, context);
  if (command.type === 'expire-claim-vote') {
    const procedure = state.procedure;
    if (procedure?.type !== 'claim-vote') return { type: 'rejected', code: 'wrong-phase' };
    if (procedure.timer.id !== command.timerId) return { type: 'rejected', code: 'stale-timer' };
    if (!timerDue(procedure.timer, context.nowMs))
      return { type: 'rejected', code: 'timer-not-due' };
    return accepted(command, { type: 'claim-vote-expired', procedureId: command.timerId }, context);
  }
  if (command.type === 'cast-vote') {
    const procedure = state.procedure;
    if (procedure?.type !== 'claim-vote') return { type: 'rejected', code: 'wrong-phase' };
    if (procedure.timer.id !== command.procedureId)
      return { type: 'rejected', code: 'stale-timer' };
    const error = voteError(procedure, command.actorId, command.vote, context.nowMs);
    if (error) return { type: 'rejected', code: error };
    return accepted(
      command,
      {
        type: 'claim-vote-cast',
        procedureId: command.procedureId,
        seatId: command.actorId,
        vote: command.vote,
      },
      context,
    );
  }
  const claim: Claim = {
    id: id('claim', `${command.id}:claim`),
    commandId: command.id,
    claimantId: command.actorId,
    accusedId: command.accusedId,
    reason: command.reason.trim(),
    incident: structuredClone(command.incident),
    incidentKey: incidentKey(command.incident),
    scope: command.scope,
    scopeNumber: command.scopeNumber,
  };
  const error = submissionError(state, claim, context.nowMs);
  if (error) return { type: 'rejected', code: error };
  return accepted(command, { type: 'claim-submitted', claim }, context);
}

function accepted(command: ClaimCommand, event: ClaimEvent, context: DecisionContext): Decision {
  return {
    type: 'accepted',
    outcome: 'played',
    action: {
      commandId: command.id,
      occurredAtMs: context.nowMs,
      events: [{ id: id('event', `${command.id}:0`), event }],
    },
  };
}

function timerDue(timer: Timer, nowMs: number): boolean {
  return timer.startedAtMs !== null && nowMs - timer.startedAtMs >= timer.remainingMs;
}

function timerInputError(timer: Timer, nowMs: number): RejectionCode | null {
  if (timer.startedAtMs === null) return 'procedure-active';
  if (nowMs < timer.startedAtMs) return 'invalid-time';
  return nowMs - timer.startedAtMs >= timer.remainingMs ? 'timer-expired' : null;
}

function voteError(
  procedure: ClaimVote,
  seatId: Claim['claimantId'],
  vote: Vote,
  nowMs: number,
): RejectionCode | null {
  const error = timerInputError(procedure.timer, nowMs);
  if (error) return error;
  if (!procedure.eligibleSeatIds.includes(seatId)) return 'not-eligible';
  if (Object.hasOwn(procedure.votes, seatId)) return 'already-answered';
  if (!['yes', 'no', 'abstain'].includes(vote)) return 'invalid-vote';
  return null;
}

function resolution(procedure: ClaimVote): 'upheld' | 'rejected' | 'tied' {
  const votes = Object.values(procedure.votes);
  const yes = votes.filter((vote) => vote === 'yes').length;
  const no = votes.filter((vote) => vote === 'no').length;
  return yes > no ? 'upheld' : no > yes ? 'rejected' : 'tied';
}

type Withdrawal = Extract<NonNullable<GameState['procedure']>, { type: 'withdrawal' }>;

function withdrawalError(
  state: GameState,
  claimId: ClaimId,
  actorId: SeatId,
  nowMs: number,
): RejectionCode | null {
  const record = state.claims.find((record) => record.claim.id === claimId);
  if (!record) return 'unknown-claim';
  if (record.claim.claimantId !== actorId) return 'not-eligible';
  if (record.punishmentStarted) return 'punishment-started';
  if (record.resolution === 'withdrawn' || record.resolution === 'tied') return 'claim-closed';
  if (record.withdrawalRequested) return 'already-requested';
  if (state.procedure?.type === 'claim-vote' && state.procedure.claim.id === claimId)
    return timerInputError(state.procedure.timer, nowMs);
  return null;
}

function approvalError(
  procedure: Withdrawal,
  actorId: SeatId,
  nowMs: number,
): RejectionCode | null {
  const error = timerInputError(procedure.timer, nowMs);
  if (error) return error;
  if (!procedure.eligibleSeatIds.includes(actorId)) return 'not-eligible';
  return Object.hasOwn(procedure.approvals, actorId) ? 'already-answered' : null;
}

function decideWithdrawal(
  state: GameState,
  command: WithdrawalCommand,
  context: DecisionContext,
): Decision {
  if (command.type === 'request-withdrawal') {
    const error = withdrawalError(state, command.claimId, command.actorId, context.nowMs);
    return error
      ? { type: 'rejected', code: error }
      : accepted(
          command,
          { type: 'withdrawal-requested', claimId: command.claimId, seatId: command.actorId },
          context,
        );
  }
  const procedure = state.procedure;
  if (procedure?.type !== 'withdrawal') return { type: 'rejected', code: 'wrong-phase' };
  const procedureId = command.type === 'expire-withdrawal' ? command.timerId : command.procedureId;
  if (procedureId !== procedure.timer.id) return { type: 'rejected', code: 'stale-timer' };
  if (command.type === 'expire-withdrawal') {
    if (!timerDue(procedure.timer, context.nowMs))
      return { type: 'rejected', code: 'timer-not-due' };
    return accepted(command, { type: 'withdrawal-expired', procedureId }, context);
  }
  const error = approvalError(procedure, command.actorId, context.nowMs);
  if (error) return { type: 'rejected', code: error };
  return accepted(
    command,
    { type: 'withdrawal-answered', procedureId, seatId: command.actorId, approve: command.approve },
    context,
  );
}

function pauseTimer(timer: Timer, nowMs: number): Timer {
  return {
    ...timer,
    remainingMs:
      timer.startedAtMs === null
        ? timer.remainingMs
        : Math.max(0, timer.remainingMs - (nowMs - timer.startedAtMs)),
    startedAtMs: null,
  };
}

function applyWithdrawal(state: GameState, event: WithdrawalEvent, nowMs: number): GameState {
  if (event.type === 'withdrawal-requested') {
    if (withdrawalError(state, event.claimId, event.seatId, nowMs))
      throw new Error('Invalid withdrawal request');
    return {
      ...state,
      claims: state.claims.map((record) =>
        record.claim.id === event.claimId ? { ...record, withdrawalRequested: true } : record,
      ),
    };
  }
  if (event.type === 'withdrawal-started') {
    const record = state.claims.find((record) => record.claim.id === event.claimId);
    if (
      !record ||
      !record.withdrawalRequested ||
      record.punishmentStarted ||
      (state.procedure !== null &&
        (state.procedure.type !== 'claim-vote' || state.procedure.claim.id !== event.claimId))
    )
      throw new Error('Cannot start withdrawal');
    const suspendedVote =
      state.procedure?.type === 'claim-vote'
        ? { ...state.procedure, timer: pauseTimer(state.procedure.timer, nowMs) }
        : null;
    return {
      ...state,
      procedure: {
        type: 'withdrawal',
        claim: structuredClone(record.claim),
        suspendedVote,
        eligibleSeatIds: state.players
          .filter((player) => player.status === 'active' && player.id !== record.claim.claimantId)
          .map((player) => player.id),
        approvals: {},
        timer: { id: event.procedureId, remainingMs: 10000, startedAtMs: nowMs },
      },
    };
  }
  const procedure = state.procedure;
  if (procedure?.type !== 'withdrawal') throw new Error('No active withdrawal');
  if (event.type === 'withdrawal-answered') {
    if (procedure.timer.id !== event.procedureId || approvalError(procedure, event.seatId, nowMs))
      throw new Error('Invalid withdrawal approval');
    return {
      ...state,
      procedure: {
        ...procedure,
        approvals: { ...procedure.approvals, [event.seatId]: event.approve },
      },
    };
  }
  if (event.type === 'withdrawal-expired') {
    if (procedure.timer.id !== event.procedureId || !timerDue(procedure.timer, nowMs))
      throw new Error('Withdrawal timer is not due');
    return {
      ...state,
      procedure: {
        ...procedure,
        approvals: Object.fromEntries(
          procedure.eligibleSeatIds.map((seat) => [
            seat,
            Object.hasOwn(procedure.approvals, seat) ? procedure.approvals[seat] : false,
          ]),
        ),
      },
    };
  }
  const approved = procedure.eligibleSeatIds.every(
    (seat) => Object.hasOwn(procedure.approvals, seat) && procedure.approvals[seat] === true,
  );
  const rejected = Object.values(procedure.approvals).some((value) => value === false);
  if (
    procedure.claim.id !== event.claimId ||
    (!approved && !rejected) ||
    approved !== event.approved
  )
    throw new Error('Invalid withdrawal result');
  const pendingPenalties = approved
    ? state.pendingPenalties.filter(
        (penalty) =>
          !(penalty.reason === 'claim' && penalty.incidentId === procedure.claim.commandId),
      )
    : state.pendingPenalties;
  const restored =
    !approved && procedure.suspendedVote !== null
      ? {
          ...procedure.suspendedVote,
          timer: { ...procedure.suspendedVote.timer, startedAtMs: nowMs },
        }
      : null;
  return {
    ...state,
    pendingPenalties,
    procedure: restored,
    claims: state.claims.map((record) =>
      record.claim.id === event.claimId
        ? {
            ...record,
            withdrawalRequested: false,
            resolution: approved ? 'withdrawn' : record.resolution,
          }
        : record,
    ),
    phase:
      state.phase.type === 'pre-game-penalties' && pendingPenalties.length === 0
        ? { type: 'between-rounds', leaderId: state.phase.firstLeaderId, nextRoundNumber: 1 }
        : state.phase,
  };
}

export function automaticClaimEvent(state: GameState, procedureId: ProcedureId): ClaimEvent | null {
  const procedure = state.procedure;
  if (procedure?.type === 'withdrawal') {
    const rejected = Object.values(procedure.approvals).some((value) => value === false);
    const approved = procedure.eligibleSeatIds.every(
      (seat) => Object.hasOwn(procedure.approvals, seat) && procedure.approvals[seat] === true,
    );
    return rejected || approved
      ? { type: 'withdrawal-resolved', claimId: procedure.claim.id, approved }
      : null;
  }
  if (
    procedure?.type === 'claim-vote' &&
    state.claims.find((record) => record.claim.id === procedure.claim.id)?.withdrawalRequested
  )
    return { type: 'withdrawal-started', claimId: procedure.claim.id, procedureId };
  if (
    procedure?.type === 'claim-vote' &&
    procedure.eligibleSeatIds.every((seat) => Object.hasOwn(procedure.votes, seat))
  ) {
    return {
      type: 'claim-vote-resolved',
      claimId: procedure.claim.id,
      resolution: resolution(procedure),
    };
  }
  if (state.procedure !== null || state.phase.type === 'finished') return null;
  const next = state.claims.find(
    (record) => record.resolution === 'pending' || record.withdrawalRequested,
  );
  if (!next)
    return state.phase.type === 'trump-reveal' && state.phase.timer.startedAtMs === null
      ? { type: 'reveal-resumed', timerId: state.phase.timer.id }
      : null;
  return {
    type: next.withdrawalRequested ? 'withdrawal-started' : 'claim-vote-started',
    claimId: next.claim.id,
    procedureId,
  };
}

export function applyClaimEvent(state: GameState, event: ClaimEvent, nowMs: number): GameState {
  if (event.type === 'reveal-resumed') {
    if (
      state.phase.type !== 'trump-reveal' ||
      state.phase.timer.id !== event.timerId ||
      state.phase.timer.startedAtMs !== null ||
      state.procedure !== null ||
      state.claims.some((record) => record.resolution === 'pending' || record.withdrawalRequested)
    )
      throw new Error('Cannot resume reveal');
    return {
      ...state,
      phase: { ...state.phase, timer: { ...state.phase.timer, startedAtMs: nowMs } },
    };
  }
  if (
    event.type === 'withdrawal-requested' ||
    event.type === 'withdrawal-started' ||
    event.type === 'withdrawal-answered' ||
    event.type === 'withdrawal-expired' ||
    event.type === 'withdrawal-resolved'
  )
    return applyWithdrawal(state, event, nowMs);
  if (event.type === 'claim-submitted') {
    if (submissionError(state, event.claim, nowMs)) throw new Error('Invalid recorded claim');
    return {
      ...state,
      claims: [
        ...state.claims,
        {
          claim: structuredClone(event.claim),
          resolution: 'pending',
          withdrawalRequested: false,
          punishmentStarted: false,
        },
      ],
      phase:
        state.phase.type === 'trump-reveal'
          ? { ...state.phase, timer: pauseTimer(state.phase.timer, nowMs) }
          : state.phase,
    };
  }
  if (event.type === 'claim-vote-expired') {
    const procedure = state.procedure;
    if (
      procedure?.type !== 'claim-vote' ||
      procedure.timer.id !== event.procedureId ||
      !timerDue(procedure.timer, nowMs)
    )
      throw new Error('Claim vote timer is not due');
    return {
      ...state,
      procedure: {
        ...procedure,
        votes: Object.fromEntries(
          procedure.eligibleSeatIds.map((seat) => [
            seat,
            Object.hasOwn(procedure.votes, seat) ? procedure.votes[seat] : 'abstain',
          ]),
        ),
      },
    };
  }
  if (event.type === 'claim-vote-cast') {
    const procedure = state.procedure;
    if (
      procedure?.type !== 'claim-vote' ||
      procedure.timer.id !== event.procedureId ||
      voteError(procedure, event.seatId, event.vote, nowMs)
    )
      throw new Error('Invalid recorded vote');
    return {
      ...state,
      procedure: { ...procedure, votes: { ...procedure.votes, [event.seatId]: event.vote } },
    };
  }
  if (event.type === 'claim-vote-resolved') {
    const procedure = state.procedure;
    if (
      procedure?.type !== 'claim-vote' ||
      procedure.claim.id !== event.claimId ||
      !procedure.eligibleSeatIds.every((seat) => Object.hasOwn(procedure.votes, seat)) ||
      resolution(procedure) !== event.resolution
    )
      throw new Error('Invalid claim verdict');
    const claim = procedure.claim;
    return {
      ...state,
      procedure: null,
      claims: state.claims.map((record) =>
        record.claim.id === claim.id ? { ...record, resolution: event.resolution } : record,
      ),
      pendingPenalties:
        event.resolution === 'tied'
          ? state.pendingPenalties
          : [
              ...state.pendingPenalties,
              {
                incidentId: claim.commandId,
                recipientId: event.resolution === 'upheld' ? claim.accusedId : claim.claimantId,
                reason: 'claim',
              },
            ],
    };
  }
  const record = state.claims.find((record) => record.claim.id === event.claimId);
  if (
    state.procedure !== null ||
    !record ||
    record.resolution !== 'pending' ||
    state.claims.find((item) => item.resolution === 'pending')?.claim.id !== record.claim.id
  )
    throw new Error('Cannot start claim vote');
  return {
    ...state,
    procedure: {
      type: 'claim-vote',
      claim: structuredClone(record.claim),
      eligibleSeatIds: state.players
        .filter((player) => player.status === 'active' && player.id !== record.claim.accusedId)
        .map((player) => player.id),
      votes: {},
      timer: { id: event.procedureId, remainingMs: 10000, startedAtMs: nowMs },
    },
  };
}
