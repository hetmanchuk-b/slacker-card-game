type Job = {
  peer: string;
  work: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  cancel: () => void;
};

/** Shared per database pool. A ready game receives one ready peer per turn. */
export class PreparationScheduler {
  readonly #capacity: () => number;
  readonly #games = new Map<string, Job[]>();
  readonly #peers = new Set<string>();
  #active = 0;
  #scheduled = false;
  get active(): number {
    return this.#active;
  }
  constructor(capacity: () => number) {
    this.#capacity = capacity;
  }
  run(game: string, peer: string, work: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    if (this.#peers.has(peer)) return Promise.reject(new Error('Preparation already pending'));
    this.#peers.add(peer);
    return new Promise<void>((resolve, reject) => {
      const job: Job = {
        peer,
        work,
        resolve,
        reject,
        ...(signal ? { signal } : {}),
        cancel: () => {
          const jobs = this.#games.get(game);
          const index = jobs?.indexOf(job) ?? -1;
          if (index < 0) return; // Active work retains its slot until finally.
          jobs!.splice(index, 1);
          if (!jobs!.length) this.#games.delete(game);
          this.#peers.delete(peer);
          signal?.removeEventListener('abort', job.cancel);
          resolve();
        },
      };
      const jobs = this.#games.get(game) ?? [];
      jobs.push(job);
      this.#games.set(game, jobs);
      signal?.addEventListener('abort', job.cancel, { once: true });
      this.wake();
    });
  }
  wake(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      while (this.#games.size && this.#active < this.#capacity()) {
        const [game, jobs] = this.#games.entries().next().value!;
        const job = jobs.shift()!;
        this.#games.delete(game);
        if (jobs.length) this.#games.set(game, jobs);
        this.#active++;
        const finish = () => {
          this.#active--;
          this.#peers.delete(job.peer);
          job.signal?.removeEventListener('abort', job.cancel);
          this.wake();
        };
        void Promise.resolve()
          .then(job.work)
          .then(
            () => {
              finish();
              job.resolve();
            },
            (error) => {
              finish();
              job.reject(error);
            },
          );
      }
    });
  }
}
