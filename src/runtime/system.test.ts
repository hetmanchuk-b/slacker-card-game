import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SystemClock, systemInputs } from './system.ts';

test(
  'the system clock cancels tasks and reports scheduled failures without unhandled rejections',
  { timeout: 2000 },
  async () => {
    const expected = new Error('scheduled failure');
    const errors: unknown[] = [];
    let resolveFailure!: () => void;
    const failure = new Promise<void>((resolve) => {
      resolveFailure = resolve;
    });
    const clock = new SystemClock((error) => {
      errors.push(error);
      resolveFailure();
    });
    let canceledFired = false;
    const cancel = clock.scheduleAt(clock.now(), async () => {
      canceledFired = true;
    });
    cancel();
    clock.scheduleAt(clock.now(), async () => {
      throw expected;
    });
    await failure;
    assert.equal(canceledFired, false);
    assert.deepEqual(errors, [expected]);
  },
);

test('system inputs provide bounded cryptographic randomness and opaque unique command identities', () => {
  const inputs = systemInputs(() => undefined);
  const ids = new Set(Array.from({ length: 32 }, () => inputs.nextCommandId()));
  assert.equal(ids.size, 32);
  for (const id of ids) assert.match(id, /^[0-9a-f-]{36}$/);
  for (let index = 0; index < 32; index++) {
    const value = inputs.randomInt(36);
    assert.ok(Number.isInteger(value) && value >= 0 && value < 36);
  }
  assert.ok(Number.isSafeInteger(inputs.clock.now()));
});
