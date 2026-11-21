import type { CommandId, ProcedureId, SeatId } from '../game/ids.ts';
import { RuntimeAdmissionError } from '../runtime/runtime.ts';
import type { GameRuntime } from '../runtime/runtime.ts';
import { observeBotCurrent } from './observation.ts';
import type { BotCurrentObservation } from './observation.ts';

/** The sole approved policy: explicit refusal, never a timeout or contribution. */
export function choosePenaltyRefusal(view: BotCurrentObservation): ProcedureId | null {
  const own = view.state?.own;
  const procedure = view.procedure;
  return own &&
    !view.control.paused &&
    view.control.connections.some((p) => p.seatId === own.seatId && p.controller === 'bot') &&
    procedure?.type === 'penalty' &&
    !procedure.timer.paused &&
    procedure.eligibleSeatIds.includes(own.seatId) &&
    procedure.ownResponse === null
    ? procedure.timer.id
    : null;
}

/** Trusted live-writer adapter. Raw publications never enter the policy. */
export async function startBotRunner(
  runtime: GameRuntime,
  nextCommandId: () => CommandId,
  report: (error: unknown) => void = () => {},
): Promise<() => void> {
  let stopped = false;
  let sequence = -1;
  let pending: AbortController[] = [];
  const cancel = () => {
    for (const token of pending) token.abort();
    pending = [];
  };
  const stop = await runtime.subscribe(
    (publication) => {
      if (stopped || publication.sequence <= sequence) return;
      sequence = publication.sequence;
      cancel();
      if (!publication.snapshot.state || publication.snapshot.paused) return;
      for (const presence of publication.snapshot.connections) {
        if (presence.controller !== 'bot') continue;
        const seatId: SeatId = presence.seatId;
        const view = observeBotCurrent(publication.snapshot, seatId, publication.nowMs);
        const procedureId = choosePenaltyRefusal(view);
        if (procedureId === null) continue;
        const token = new AbortController();
        pending.push(token);
        const admission = runtime.botAdmission(seatId, token.signal);
        void runtime
          .dispatch(
            {
              type: 'penalty-response',
              id: nextCommandId(),
              actorId: seatId,
              procedureId,
              cardId: null,
            },
            admission,
          )
          .catch((error: unknown) => {
            if (!(error instanceof RuntimeAdmissionError)) report(error);
          });
      }
    },
    () => report(new Error('Bot subscription failed')),
  );
  return () => {
    stopped = true;
    cancel();
    stop();
  };
}
