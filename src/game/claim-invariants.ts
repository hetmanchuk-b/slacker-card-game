import { incidentKey } from './claims.ts';
import type { ClaimVote, GameState } from './model.ts';

/** Server-only diagnostics for claims, nested ballots and their penalty links. */
export function validateClaims(state: GameState): readonly string[] {
  const errors: string[] = [];
  const active = state.players
    .filter((player) => player.status === 'active')
    .map((player) => player.id);
  const seats = state.players.map((player) => player.id);
  if (new Set(state.claims.map((record) => record.claim.id)).size !== state.claims.length)
    errors.push('Duplicate claim ID');
  if (new Set(state.claims.map((record) => record.claim.commandId)).size !== state.claims.length)
    errors.push('Duplicate claim command');
  if (new Set(state.claims.map((record) => record.claim.incidentKey)).size !== state.claims.length)
    errors.push('Duplicate claim incident');
  if (new Set(state.automaticIncidents).size !== state.automaticIncidents.length)
    errors.push('Duplicate automatic incident');
  for (const record of state.claims) {
    const claim = record.claim;
    if (!seats.includes(claim.claimantId) || !seats.includes(claim.accusedId))
      errors.push('Unknown claim participant');
    if (
      !claim.reason.trim() ||
      claim.incidentKey !== incidentKey(claim.incident) ||
      !Number.isSafeInteger(claim.scopeNumber) ||
      claim.scopeNumber < 0
    )
      errors.push('Invalid claim record');
    if (
      record.resolution === 'pending' &&
      (!active.includes(claim.claimantId) || !active.includes(claim.accusedId))
    )
      errors.push('Pending claim participant exited');
    if (
      record.punishmentStarted &&
      record.resolution !== 'upheld' &&
      record.resolution !== 'rejected'
    )
      errors.push('Invalid claim punishment status');
    if (
      record.withdrawalRequested &&
      (record.punishmentStarted ||
        record.resolution === 'tied' ||
        record.resolution === 'withdrawn')
    )
      errors.push('Invalid pending withdrawal');
    if (
      (record.resolution === 'upheld' || record.resolution === 'rejected') &&
      !record.punishmentStarted &&
      !state.pendingPenalties.some(
        (penalty) => penalty.reason === 'claim' && penalty.incidentId === claim.commandId,
      )
    )
      errors.push('Unstarted claim punishment missing');
  }
  const validateVote = (vote: ClaimVote) => {
    const record = state.claims.find((record) => record.claim.id === vote.claim.id);
    if (!record || record.resolution !== 'pending')
      errors.push('Claim procedure has no pending record');
    const eligible = active.filter((seat) => seat !== vote.claim.accusedId);
    if (JSON.stringify(vote.eligibleSeatIds) !== JSON.stringify(eligible))
      errors.push('Invalid claim voters');
    for (const [seat, value] of Object.entries(vote.votes)) {
      if (!eligible.some((id) => id === seat) || !['yes', 'no', 'abstain'].includes(value ?? ''))
        errors.push('Invalid claim ballot');
    }
    if (
      !Number.isSafeInteger(vote.timer.remainingMs) ||
      vote.timer.remainingMs < 0 ||
      vote.timer.remainingMs > 10000
    )
      errors.push('Invalid claim timer');
  };
  const procedure = state.procedure;
  if (procedure?.type === 'claim-vote') validateVote(procedure);
  if (procedure?.type === 'withdrawal') {
    const record = state.claims.find((record) => record.claim.id === procedure.claim.id);
    if (!record || !record.withdrawalRequested || record.punishmentStarted)
      errors.push('Withdrawal has no pending request');
    const eligible = active.filter((seat) => seat !== procedure.claim.claimantId);
    if (JSON.stringify(procedure.eligibleSeatIds) !== JSON.stringify(eligible))
      errors.push('Invalid withdrawal approvers');
    for (const [seat, value] of Object.entries(procedure.approvals)) {
      if (!eligible.some((id) => id === seat) || typeof value !== 'boolean')
        errors.push('Invalid withdrawal approval');
    }
    if (procedure.suspendedVote !== null) {
      validateVote(procedure.suspendedVote);
      if (procedure.suspendedVote.claim.id !== procedure.claim.id)
        errors.push('Withdrawal suspends another claim');
      if (procedure.suspendedVote.timer.startedAtMs !== null)
        errors.push('Suspended claim timer is running');
    }
  }
  for (const penalty of [
    ...state.pendingPenalties,
    ...(procedure?.type === 'penalty' ? [procedure.penalty] : []),
  ]) {
    if (penalty.reason !== 'claim') continue;
    const record = state.claims.find((record) => record.claim.commandId === penalty.incidentId);
    if (!record || (record.resolution !== 'upheld' && record.resolution !== 'rejected')) {
      errors.push('Claim penalty has no verdict');
      continue;
    }
    const recipient =
      record.resolution === 'upheld' ? record.claim.accusedId : record.claim.claimantId;
    if (penalty.recipientId !== recipient) errors.push('Claim penalty disagrees with verdict');
  }
  if (
    state.phase.type === 'finished' &&
    state.claims.some((record) => record.resolution === 'pending' || record.withdrawalRequested)
  )
    errors.push('Finished game still has pending claims');
  return errors;
}
