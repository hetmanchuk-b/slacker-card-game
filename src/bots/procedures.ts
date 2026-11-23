import type { ProcedureId } from '../game/ids.ts';
import type { BotCurrentObservation } from './observation.ts';

type ProcedureResponse =
  | { type: 'cast-vote'; procedureId: ProcedureId; vote: 'abstain' }
  | { type: 'withdrawal-response'; procedureId: ProcedureId; approve: true }
  | { type: 'penalty-response'; procedureId: ProcedureId; cardId: null };

/** Evidence-independent abstention, explicit withdrawal consent, or penalty refusal. */
export function chooseProcedureResponse(view: BotCurrentObservation): ProcedureResponse | null {
  const own = view.state?.own;
  const procedure = view.procedure;
  if (
    !own ||
    view.control.paused ||
    !view.control.connections.some((p) => p.seatId === own.seatId && p.controller === 'bot') ||
    !procedure ||
    procedure.timer.paused ||
    !procedure.eligibleSeatIds.includes(own.seatId)
  )
    return null;
  const procedureId = procedure.timer.id;
  switch (procedure.type) {
    case 'claim-vote':
      return procedure.ownVote === null
        ? { type: 'cast-vote', procedureId, vote: 'abstain' }
        : null;
    case 'withdrawal':
      return procedure.ownApproval === null
        ? { type: 'withdrawal-response', procedureId, approve: true }
        : null;
    case 'penalty':
      return procedure.ownResponse === null
        ? { type: 'penalty-response', procedureId, cardId: null }
        : null;
  }
}
