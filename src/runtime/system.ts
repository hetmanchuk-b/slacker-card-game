import { randomInt, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { id } from '../game/ids.ts';
import type { CancelTask, Clock } from './clock.ts';

/** Epoch-based monotonic process clock, unaffected by later wall-clock corrections. */
export class SystemClock implements Clock {
  #epoch = Date.now();
  #origin = performance.now();
  #onError: (error: unknown) => void;

  constructor(onError: (error: unknown) => void) {
    this.#onError = onError;
  }
  now(): number {
    return Math.floor(this.#epoch + performance.now() - this.#origin);
  }

  scheduleAt(deadlineMs: number, task: () => Promise<void>): CancelTask {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0)
      throw new Error('Invalid clock deadline');
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    const run = () => {
      if (canceled) return;
      const remaining = deadlineMs - this.now();
      if (remaining > 0) {
        timer = setTimeout(run, Math.min(remaining, 2147483647));
        return;
      }
      void Promise.resolve().then(task).catch(this.#onError);
    };
    timer = setTimeout(run, Math.max(0, Math.min(deadlineMs - this.now(), 2147483647)));
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }
}

/** Host-only adapters. Error reporters should log/handle failures without throwing. */
export function systemInputs(onError: (error: unknown) => void) {
  return {
    clock: new SystemClock(onError),
    randomInt: (upperExclusive: number) => randomInt(upperExclusive),
    nextCommandId: () => id('command', randomUUID()),
  };
}
