import { isDeepStrictEqual } from 'node:util';
import type { RuntimePublication } from './runtime.ts';
import { setImmediate } from 'node:timers/promises';

/** Logical admission bounds, not a physical heap limit. */
export const CAPTURE_LIMITS = Object.freeze({
  publicationBytes: 2 * 1024 * 1024,
  gameBytes: 8 * 1024 * 1024,
  globalBytes: 64 * 1024 * 1024,
  games: 8,
  publicationsPerGame: 64,
  handles: 2048,
});

/** Borrow only proven equal detached committed roots for the shared source.
 * The original legacy publication and authoritative published view stay intact.
 */
export function captureSource(publication: RuntimePublication): RuntimePublication {
  const last = publication.actions.at(-1);
  const head = publication.snapshot.head;
  if (
    !last ||
    last.after.head.gameId !== head.gameId ||
    last.after.head.branchId !== head.branchId ||
    last.after.head.version !== head.version
  )
    return publication;
  // Bound the added content comparison before traversing either candidate root.
  // Refused roots remain unaliased and fail ordinary source admission below.
  try {
    sourceWeight(last.after.state, CAPTURE_LIMITS.publicationBytes);
    sourceWeight(publication.snapshot.state, CAPTURE_LIMITS.publicationBytes);
  } catch {
    return publication;
  }
  if (!isDeepStrictEqual(last.after.state, publication.snapshot.state)) return publication;
  return { ...publication, snapshot: { ...publication.snapshot, state: last.after.state } };
}

export function sourceWeight(value: unknown, limit: number): number {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  let bytes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (item === null || item === undefined) bytes += 8;
    else if (typeof item === 'string') bytes += 24 + item.length * 2;
    else if (typeof item === 'number' || typeof item === 'boolean') bytes += 8;
    else if (typeof item === 'object') {
      if (seen.has(item)) continue;
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
        throw new Error('Capture unavailable');
      seen.add(item);
      bytes += 64;
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        bytes += 32 + key.length * 2;
        if (bytes > limit) throw new Error('Capture unavailable');
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!('value' in descriptor)) throw new Error('Capture unavailable');
        pending.push(descriptor.value);
      }
    } else throw new Error('Capture unavailable');
    if (bytes > limit) throw new Error('Capture unavailable');
  }
  return bytes;
}

type Job = () => Promise<void>;
const games = new Map<string, Job[]>();
let running = false;

/** One process-wide construction, with ready games rotated after every job.
 * Admission/ownership is the caller's responsibility before submitting a job.
 */
export function constructCapture<T>(game: string, source: T): Promise<T> {
  sourceWeight(source, CAPTURE_LIMITS.publicationBytes);
  return new Promise<T>((resolve, reject) => {
    const jobs = games.get(game) ?? [];
    games.set(game, jobs);
    jobs.push(async () => {
      try {
        resolve(await cloneFrozen(source));
      } catch (error) {
        reject(error);
      }
    });
    if (!running) {
      running = true;
      void pump();
    }
  });
}
async function pump(): Promise<void> {
  await setImmediate();
  while (games.size) {
    const [game, jobs] = games.entries().next().value!;
    const job = jobs.shift()!;
    games.delete(game);
    if (jobs.length) games.set(game, jobs);
    await job();
  }
  running = false;
}

// Plain records/arrays only. Copy properties incrementally, preserving aliases.
// No native structuredClone scratch. Individual wide-object enumeration/freeze
// remains synchronous, bounded by admission rather than strictly preemptible.
async function cloneFrozen<T>(source: T): Promise<T> {
  const copies = new Map<object, object>();
  const work: {
    source: Record<string, unknown>;
    target: Record<string, unknown>;
    keys: Generator<string>;
  }[] = [];
  function* ownKeys(value: object) {
    for (const key in value) if (Object.hasOwn(value, key)) yield key;
  }
  const copy = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    const known = copies.get(value);
    if (known) return known;
    const target = (
      Array.isArray(value) ? new Array(value.length) : Object.create(Object.getPrototypeOf(value))
    ) as Record<string, unknown>;
    copies.set(value, target);
    work.push({ source: value as Record<string, unknown>, target, keys: ownKeys(value) });
    return target;
  };
  const result = copy(source) as T;
  let steps = 0;
  while (work.length) {
    const current = work[work.length - 1]!;
    const next = current.keys.next();
    if (next.done) {
      Object.freeze(current.target);
      work.pop();
    } else {
      Object.defineProperty(current.target, next.value, {
        value: copy(current.source[next.value]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (++steps % 512 === 0) await setImmediate();
  }
  return result;
}

const pending = new Map<string, number>();
let pendingBytes = 0;
/** Default standalone runtime budget. Hosted runtimes use their store ledger. */
export function defaultCaptureConstruction<T>(game: string, source: T): Promise<T> {
  sourceWeight(source, CAPTURE_LIMITS.publicationBytes);
  const bytes = CAPTURE_LIMITS.publicationBytes;
  const count = pending.get(game) ?? 0;
  if (
    (!count && pending.size >= CAPTURE_LIMITS.games) ||
    (count + 1) * bytes > CAPTURE_LIMITS.gameBytes ||
    pendingBytes + bytes > CAPTURE_LIMITS.globalBytes
  )
    throw new Error('Capture unavailable');
  pending.set(game, count + 1);
  pendingBytes += bytes;
  return constructCapture(game, source).finally(() => {
    const remaining = pending.get(game)! - 1;
    if (remaining) pending.set(game, remaining);
    else pending.delete(game);
    pendingBytes -= bytes;
  });
}
