import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TransportLimiter } from './transport-limits.ts';

test('transport rate buckets refuse excess without extending windows', () => {
  const limiter = new TransportLimiter(2);
  assert.equal(limiter.take('ip', 1000, 2, 1000), true);
  assert.equal(limiter.take('ip', 1001, 2, 1000), true);
  assert.equal(limiter.take('ip', 1999, 2, 1000), false);
  assert.equal(limiter.take('ip', 2000, 2, 1000), true);
});

test('limiter cardinality is bounded and expires idle keys without evicting active rate limits', () => {
  const limiter = new TransportLimiter(2);
  assert.equal(limiter.take('first', 0, 1, 100), true);
  assert.equal(limiter.take('second', 0, 1, 100), true);
  assert.equal(limiter.take('third', 1, 1, 100), false);
  assert.equal(limiter.take('first', 1, 1, 100), false);
  assert.equal(limiter.take('third', 100, 1, 100), true);
});
