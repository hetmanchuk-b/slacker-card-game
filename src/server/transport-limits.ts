/** Bounded fixed windows. Refuse new keys at capacity rather than evicting an
 * active limit and letting an attacker reset it through key churn.
 */
export class TransportLimiter {
  readonly #capacity: number;
  #buckets = new Map<string, { until: number; used: number }>();
  constructor(capacity = 4096) {
    this.#capacity = capacity;
  }
  take(key: string, now: number, maximum: number, windowMs: number): boolean {
    let bucket = this.#buckets.get(key);
    if (bucket && now >= bucket.until) {
      this.#buckets.delete(key);
      bucket = undefined;
    }
    if (!bucket) {
      if (this.#buckets.size >= this.#capacity) {
        for (const [other, value] of this.#buckets)
          if (now >= value.until) this.#buckets.delete(other);
        if (this.#buckets.size >= this.#capacity) return false;
      }
      bucket = { until: now + windowMs, used: 0 };
      this.#buckets.set(key, bucket);
    }
    if (bucket.used >= maximum) return false;
    bucket.used++;
    return true;
  }
}
