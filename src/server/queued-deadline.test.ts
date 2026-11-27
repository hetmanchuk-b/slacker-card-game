import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueuedDeadline } from './queued-deadline.ts';

test('queued age expires at exactly two seconds without arrivals, separately from active receipt lifetime', () => {
  let now = 0;
  const pending = new Map<() => void, number>();
  const clock = {
    now: () => now,
    set: (delay: number, expire: () => void) => {
      pending.set(expire, now + delay);
      return () => {
        pending.delete(expire);
      };
    },
  };
  const advance = (time: number) => {
    now = time;
    for (const [expire, due] of pending)
      if (due <= now) {
        pending.delete(expire);
        expire();
      }
  };
  let expired = 0;
  const active = new QueuedDeadline(
    2000,
    () => assert.fail('active receipt is not queued age'),
    clock,
  );
  active.started();
  new QueuedDeadline(
    2000,
    () => {
      expired++;
    },
    clock,
  );
  advance(1999);
  assert.equal(expired, 0);
  advance(2000);
  assert.equal(expired, 1);
  const cancelled = new QueuedDeadline(2000, () => assert.fail('obsolete generation'), clock);
  cancelled.started();
  advance(4000);
  assert.equal(expired, 1);
  assert.equal(pending.size, 0);
});
