import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PreparationScheduler } from './preparation-scheduler.ts';

test('preparations rotate games and peers, release before receipt and honor shrinking capacity', async () => {
  let capacity = 0;
  const scheduler = new PreparationScheduler(() => capacity);
  const order: string[] = [];
  const tasks = [
    ['a', '1'],
    ['a', '2'],
    ['b', '3'],
    ['b', '4'],
  ].map(([game, peer]) =>
    scheduler.run(game!, peer!, async () => {
      order.push(`${game}${peer}`);
    }),
  );
  capacity = 1;
  scheduler.wake();
  await Promise.all(tasks);
  assert.deepEqual(order, ['a1', 'b3', 'a2', 'b4']);
  const gate = Promise.withResolvers<void>();
  const active = scheduler.run('a', '1', () => gate.promise);
  await Promise.resolve();
  capacity = 0;
  const queued = scheduler.run('b', '2', async () => {
    order.push('later');
  });
  gate.resolve();
  await active;
  assert.equal(order.includes('later'), false);
  capacity = 1;
  scheduler.wake();
  await queued;
  assert.equal(scheduler.active, 0);
});

test('cancelled preparations do not execute; active cancellation retains slot until settlement', async () => {
  const scheduler = new PreparationScheduler(() => 1);
  const gate = Promise.withResolvers<void>();
  const cancellation = new AbortController();
  const entered = Promise.withResolvers<void>();
  const active = scheduler.run(
    'a',
    '1',
    async () => {
      entered.resolve();
      await gate.promise;
    },
    cancellation.signal,
  );
  await entered.promise;
  const queued = scheduler.run('a', '2', async () => assert.fail(), cancellation.signal);
  cancellation.abort();
  await queued;
  assert.equal(scheduler.active, 1);
  gate.resolve();
  await active;
  assert.equal(scheduler.active, 0);
});
