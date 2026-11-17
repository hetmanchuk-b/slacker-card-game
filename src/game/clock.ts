import { id } from './ids.ts';
import type { ClockCommand, Decision, DecisionContext } from './contracts.ts';
import type { GameState, Timer } from './model.ts';

export function decideClock(
  state: GameState | null,
  command: ClockCommand,
  context: DecisionContext,
): Decision {
  if (state === null) return { type: 'rejected', code: 'not-started' };
  const suspend = command.type === 'suspend-clock';
  if (
    suspend === (state.clock.type === 'suspended') ||
    (suspend && state.phase.type === 'finished')
  )
    return { type: 'rejected', code: 'wrong-phase' };
  const timers = [
    state.procedure?.timer,
    state.phase.type === 'trump-reveal' ? state.phase.timer : undefined,
  ];
  if (
    timers.some(
      (timer) =>
        timer?.startedAtMs !== undefined &&
        timer.startedAtMs !== null &&
        timer.startedAtMs > context.nowMs,
    )
  )
    return { type: 'rejected', code: 'invalid-time' };
  return {
    type: 'accepted',
    outcome: 'played',
    action: {
      commandId: command.id,
      occurredAtMs: context.nowMs,
      events: [
        {
          id: id('event', `${command.id}:0`),
          event: { type: suspend ? 'clock-suspended' : 'clock-resumed' },
        },
      ],
    },
  };
}

export function applyClock(
  state: GameState,
  type: 'clock-suspended' | 'clock-resumed',
  nowMs: number,
): GameState {
  const suspend = type === 'clock-suspended';
  if (suspend === (state.clock.type === 'suspended'))
    throw new Error('Clock transition disagrees with state');
  const captured = state.clock.type === 'suspended' ? state.clock.timerIds : [];
  const changed: Timer['id'][] = [];
  const map = (timer: Timer): Timer => {
    if (suspend) {
      if (timer.startedAtMs === null) return timer;
      if (timer.startedAtMs > nowMs) throw new Error('Clock suspension predates its timer');
      changed.push(timer.id);
      return {
        ...timer,
        remainingMs: Math.max(0, timer.remainingMs - (nowMs - timer.startedAtMs)),
        startedAtMs: null,
      };
    }
    if (!captured.includes(timer.id)) return timer;
    if (timer.startedAtMs !== null) throw new Error('Captured timer is already running');
    changed.push(timer.id);
    return { ...timer, startedAtMs: nowMs };
  };
  const phase =
    state.phase.type === 'trump-reveal'
      ? { ...state.phase, timer: map(state.phase.timer) }
      : state.phase;
  const procedure =
    state.procedure === null ? null : { ...state.procedure, timer: map(state.procedure.timer) };
  if (
    !suspend &&
    (changed.length !== captured.length || new Set(captured).size !== captured.length)
  )
    throw new Error('Captured timer is no longer present');
  return {
    ...state,
    phase,
    procedure,
    clock: suspend ? { type: 'suspended', timerIds: changed } : { type: 'running' },
  };
}
