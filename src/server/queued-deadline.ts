type Timers = { now: () => number; set: (delay: number, expire: () => void) => () => void };
const timers: Timers = {
  now: () => performance.now(),
  set: (delay, expire) => {
    const timer = setTimeout(expire, delay);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
/** Independent of gameplay/auth clocks and receipt deadlines. */
export class QueuedDeadline {
  readonly since: number;
  readonly #cancel: () => void;
  #waiting = true;
  constructor(ageMs: number, expire: () => void, clock: Timers = timers) {
    this.since = clock.now();
    this.#cancel = clock.set(ageMs, () => {
      if (!this.#waiting) return;
      this.#waiting = false;
      expire();
    });
  }
  started(): void {
    this.#waiting = false;
    this.#cancel();
  }
}
