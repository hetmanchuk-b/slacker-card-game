import type { Clock } from '../clock.ts';

/** Controlled clock adapter. Runtime tasks, not sleeps, drive all temporal tests. */
export class FakeClock implements Clock {
  #now: number;
  #sequence = 0;
  #tasks: { at: number; order: number; task: () => Promise<void>; canceled: boolean }[] = [];

  constructor(nowMs = 1000) {
    this.#now = nowMs;
  }
  now(): number {
    return this.#now;
  }

  scheduleAt(deadlineMs: number, task: () => Promise<void>): () => void {
    const scheduled = {
      at: Math.max(this.#now, deadlineMs),
      order: this.#sequence++,
      task,
      canceled: false,
    };
    this.#tasks.push(scheduled);
    return () => {
      scheduled.canceled = true;
    };
  }

  async advanceBy(milliseconds: number): Promise<void> {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
      throw new Error('Clock cannot run backwards');
    const target = this.#now + milliseconds;
    for (let executed = 0; ; executed++) {
      if (executed > 10000) throw new Error('Runaway scheduled tasks');
      this.#tasks = this.#tasks.filter((task) => !task.canceled);
      this.#tasks.sort((a, b) => a.at - b.at || a.order - b.order);
      const next = this.#tasks[0];
      if (!next || next.at > target) break;
      this.#tasks.shift();
      this.#now = next.at;
      await next.task();
    }
    this.#now = target;
  }
}
