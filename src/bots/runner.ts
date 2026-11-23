import type { CommandId, ProcedureId, SeatId } from '../game/ids.ts';
import { RuntimeAdmissionError } from '../runtime/runtime.ts';
import type { GameRuntime } from '../runtime/runtime.ts';
import { observeBotCurrent } from './observation.ts';
import { chooseDealingDraw } from './dealing.ts';
import { chooseRoundPlay } from './play.ts';
import type { BotCurrentObservation } from './observation.ts';
import { chooseProcedureResponse } from './procedures.ts';

/** Explicit refusal, never a timeout or contribution. */
export function choosePenaltyRefusal(view: BotCurrentObservation): ProcedureId | null {
  const response = chooseProcedureResponse(view);
  return response?.type === 'penalty-response' ? response.procedureId : null;
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
        const response = chooseProcedureResponse(view);
        const draw =
          view.state?.phase.type === 'dealing' &&
          chooseDealingDraw(view, runtime.readBotMemory(seatId));
        const play =
          view.state?.phase.type === 'round' || view.state?.phase.type === 'between-rounds'
            ? chooseRoundPlay(view, runtime.readBotMemory(seatId))
            : null;
        if (response === null && !draw && play === null) continue;
        const token = new AbortController();
        pending.push(token);
        const admission = runtime.botAdmission(seatId, token.signal);
        void runtime
          .dispatch(
            response !== null
              ? {
                  ...response,
                  id: nextCommandId(),
                  actorId: seatId,
                }
              : {
                  ...(play ?? { type: 'draw-card' as const }),
                  id: nextCommandId(),
                  actorId: seatId,
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
