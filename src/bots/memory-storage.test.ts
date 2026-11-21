import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBotMemory } from './memory.ts';
import { validateBotMemoryStorage } from './memory-storage.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import { GameRuntime } from '../runtime/runtime.ts';

test('memory storage validates checkpoint command binding, deduplication, provenance and capacity', async () => {
  const { options, history, seats } = fixture('reveal');
  const runtime = await GameRuntime.create(options);
  const checkpoint = await runtime.checkpoint();
  await runtime.dispose();
  if (checkpoint.schemaVersion !== 2) assert.fail();
  const head = { ...checkpoint.head, version: 0 };
  const entry = {
    commandId: history.read().actions[0]!.commandId,
    head,
    memories: seats.map((seat) => createBotMemory(head.gameId, seat)),
  };
  const valid = { ...checkpoint.botMemory, beforeCommands: [entry] };
  validateBotMemoryStorage(valid, history, seats);
  for (const invalid of [
    { ...valid, beforeCommands: [entry, entry] },
    { ...valid, beforeCommands: Array(257).fill(entry) },
    { ...valid, beforeCommands: [{ ...entry, head: { ...head, version: 1 } }] },
    {
      ...valid,
      beforeCommands: [{ ...entry, head: { ...head, version: Number.MAX_SAFE_INTEGER + 1 } }],
    },
    {
      ...valid,
      current: valid.current.map((m) => ({
        ...m,
        head: { ...head, branchId: 'abandoned' as typeof head.branchId },
      })),
    },
  ])
    assert.throws(
      () => validateBotMemoryStorage(invalid, history, seats),
      /Invalid bot memory checkpoint/,
    );
});
