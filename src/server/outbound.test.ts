import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AcknowledgedOutbound } from './outbound.ts';
import { protocolError } from '../protocol/messages.ts';

test('outbound waits for one transport receipt, bounds queued work and never retries uncertain emission', async () => {
  let release!: () => void;
  let sent = 0;
  let failures = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = new AcknowledgedOutbound(
    async () => {
      sent++;
      await gate;
    },
    () => {
      failures++;
    },
    { messages: 2, bytes: 4096 },
  );
  queue.enqueue(protocolError('unavailable'));
  queue.enqueue(protocolError('unauthorized'));
  assert.equal(sent, 1);
  queue.enqueue(protocolError('wrong-game'));
  assert.equal(failures, 1);
  release();
  await queue.drained();
  assert.equal(sent, 1, 'overflow discards, never retries or flushes uncertain work');
});

test('prepared emission cannot leak after invalidation during asynchronous authorization', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sent = 0;
  const queue = new AcknowledgedOutbound(
    async () => {
      sent++;
    },
    () => assert.fail(),
  );
  const pending = queue.prepare(
    async (emit) => {
      await gate;
      emit(protocolError('unavailable'));
    },
    4096,
    1,
  );
  queue.invalidate(2);
  release();
  await pending;
  await queue.drained();
  assert.equal(sent, 0);
});

test('a single oversized frame is refused before entering underlying transport buffers', async () => {
  let sent = 0;
  let failures = 0;
  const queue = new AcknowledgedOutbound(
    async () => {
      sent++;
    },
    () => {
      failures++;
    },
    { messages: 4, bytes: 32 },
  );
  queue.enqueue(protocolError('unavailable'));
  await queue.drained();
  assert.equal(sent, 0);
  assert.equal(failures, 1);
});

test('outbound invalidation drops unsent stream packets but preserves non-stream receipts', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent: string[] = [];
  const queue = new AcknowledgedOutbound(
    async (message) => {
      sent.push(message.type === 'error' ? message.code : message.type);
      if (sent.length === 1) await gate;
    },
    () => assert.fail(),
    { messages: 8, bytes: 4096 },
  );
  queue.enqueue(protocolError('unavailable'), 1);
  queue.enqueue(protocolError('wrong-game'), 1);
  queue.enqueue(protocolError('invalid-message'));
  queue.invalidate();
  queue.enqueue(protocolError('unauthorized'), 2);
  release();
  await queue.drained();
  assert.deepEqual(sent, ['unavailable', 'invalid-message', 'unauthorized']);
});
