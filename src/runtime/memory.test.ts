import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GameRuntime } from './runtime.ts';
import { fixture } from './testing/fixtures.ts';

test('permitted memory is captured without subscribers and legacy recovery stays unknown', async () => {
  const { options, seats } = fixture('reveal');
  const runtime = await GameRuntime.create(options);
  const checkpoint = await runtime.checkpoint();
  assert.equal(checkpoint.schemaVersion, 2);
  if (checkpoint.schemaVersion !== 2) throw new Error('Expected v2');
  assert.equal(checkpoint.botMemory.current.length, seats.length);
  assert.ok(checkpoint.botMemory.current.every((memory) => memory.trump));
  await runtime.dispose();
  const { botMemory, ...base } = checkpoint;
  assert.ok(botMemory);
  const recovered = await GameRuntime.restore(options, { ...base, schemaVersion: 1 });
  const next = await recovered.checkpoint();
  assert.equal(next.schemaVersion, 2);
  if (next.schemaVersion !== 2) throw new Error('Expected v2');
  assert.ok(next.botMemory.current.every((memory) => memory.trump === null));
  await recovered.dispose();
});

function memory(checkpoint: Awaited<ReturnType<GameRuntime['checkpoint']>>) {
  if (checkpoint.schemaVersion !== 2) throw new Error('Expected v2');
  return checkpoint.botMemory;
}

test('exact action memory, immutable pre-action targets, retries and rollback including before creation', async () => {
  const { options, seats } = fixture('vote');
  const runtime = await GameRuntime.create(options);
  const { id } = await import('../game/ids.ts');
  const draw = {
    type: 'draw-card' as const,
    id: id('command', 'memory-draw'),
    actorId:
      runtime.read().state!.phase.type === 'dealing'
        ? runtime.read().state!.players[0]!.id
        : seats[0]!,
  };
  // Close the preexisting claim; both ballots are fresh runtime actions.
  for (const seat of seats) {
    if (!runtime.read().state!.procedure) break;
    await runtime.dispatch({
      type: 'cast-vote',
      id: id('command', `no-${seat}`),
      actorId: seat,
      procedureId: runtime.read().state!.procedure!.timer.id,
      vote: 'no',
    });
  }
  const phase = runtime.read().state!.phase;
  assert.equal(phase.type, 'dealing');
  if (phase.type !== 'dealing') throw new Error('Expected dealing');
  draw.actorId = phase.nextSeatId;
  const before = memory(await runtime.checkpoint()).current;
  assert.equal((await runtime.dispatch(draw)).type, 'accepted');
  const captured = memory(await runtime.checkpoint());
  assert.ok(captured.current.every((m) => m.dealing));
  assert.deepEqual(
    captured.beforeCommands.find((item) => item.commandId === draw.id)!.memories,
    before,
  );
  await runtime.dispatch(draw);
  assert.deepEqual(memory(await runtime.checkpoint()), captured);
  await runtime.dispatch({
    type: 'rollback',
    id: id('command', 'memory-rollback'),
    actorId: seats[0]!,
    expected: runtime.read().head,
    beforeCommandId: draw.id,
    knowledgeWarningAcknowledged: true,
  });
  assert.deepEqual(
    memory(await runtime.checkpoint()).current.map((m) => m.dealing),
    before.map((m) => m.dealing),
  );
  await runtime.dispatch({
    type: 'rollback',
    id: id('command', 'memory-null'),
    actorId: seats[0]!,
    expected: runtime.read().head,
    beforeCommandId: id('command', 'start'),
    knowledgeWarningAcknowledged: true,
  });
  assert.equal(runtime.read().state, null);
  assert.ok(memory(await runtime.checkpoint()).current.every((m) => !m.trump && !m.dealing));
  await runtime.dispose();
});

test('new memory formats reject corruption before mutating recovery history', async () => {
  const { options, history } = fixture('reveal');
  const runtime = await GameRuntime.create(options);
  const frame = await runtime.checkpoint();
  await runtime.dispose();
  const before = history.read();
  for (const [path, value] of [
    ['botMemory', null],
    ['botMemory.schemaVersion', 2],
    ['botMemory.secret', 'hidden'],
    ['botMemory.current.0.secret', 'hidden'],
    ['botMemory.current.0.trump.suit', 'invalid'],
    ['botMemory.current.0.trump.head.version', 999],
    ['botMemory.current.0.seatId', 'unknown'],
    ['botMemory.current.1', memory(frame).current[0]],
    ['botMemory.beforeCommands', Array(257).fill({})],
    ['schemaVersion', 3],
  ] as const) {
    const copy = structuredClone(frame);
    const parts = path.split('.');
    let target = copy as unknown as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
    target[parts.at(-1)!] = value;
    await assert.rejects(GameRuntime.restore(options, copy));
    assert.deepEqual(history.read(), before);
  }
});

test('FIFO knowledge checkpoints are bounded; same-head controls cannot replay recovered reveals', async () => {
  const { options, seats } = fixture('reveal');
  const { id } = await import('../game/ids.ts');
  let runtime = await GameRuntime.create(options);
  const original = await runtime.checkpoint();
  // Explicit legacy recovery during an active reveal must not learn it on reconnect.
  const { botMemory, ...base } = original.schemaVersion === 2 ? original : assert.fail();
  assert.ok(botMemory);
  await runtime.dispose();
  runtime = await GameRuntime.restore(options, { ...base, schemaVersion: 1 });
  for (let i = 0; i < 270; i++) {
    await runtime.dispatch({
      type: i % 2 ? 'disconnect' : 'reconnect',
      id: id('command', `toggle-${i}`),
      seatId: seats[0]!,
    });
  }
  const saved = memory(await runtime.checkpoint());
  assert.ok(saved.current.every((m) => m.trump === null));
  // Force clock-changing actions by toggling the final absent seat too.
  for (let i = 0; i < 270; i++) {
    for (const seatId of seats)
      await runtime.dispatch({
        type: i % 2 ? 'disconnect' : 'reconnect',
        id: id('command', `all-${i}-${seatId}`),
        seatId,
      });
  }
  const bounded = memory(await runtime.checkpoint());
  assert.equal(bounded.beforeCommands.length, 256);
  assert.ok(!bounded.beforeCommands.some((entry) => entry.commandId === id('command', 'toggle-0')));
  const checkpoint = await runtime.checkpoint();
  await runtime.dispose();
  runtime = await GameRuntime.restore(options, checkpoint);
  assert.ok(memory(await runtime.checkpoint()).current.every((m) => m.trump === null));
  await runtime.dispose();
});

test('memory and pre-command checkpoints publish only in the successful authoritative frame', async () => {
  const { options, seats } = fixture('vote');
  const { id } = await import('../game/ids.ts');
  let fail = false;
  let stored: Awaited<ReturnType<GameRuntime['checkpoint']>> | undefined;
  const runtime = await GameRuntime.create({
    ...options,
    commit: async (frame) => {
      if (fail) throw new Error('memory storage unavailable');
      stored = structuredClone(frame);
    },
  });
  const before = structuredClone(stored);
  let publications = 0;
  await runtime.subscribe(() => {
    publications++;
  });
  fail = true;
  await assert.rejects(
    runtime.dispatch({
      type: 'cast-vote',
      id: id('command', 'failed-memory'),
      actorId: seats[0]!,
      procedureId: runtime.read().state!.procedure!.timer.id,
      vote: 'no',
    }),
    /memory storage unavailable/,
  );
  assert.deepEqual(stored, before);
  assert.equal(publications, 1);
  assert.throws(() => runtime.read(), /Runtime scheduling failed/);
  await runtime.dispose();
});

test('evicted reveal targets restore unknown rather than abandoned-future or live historical knowledge', async () => {
  const { options, seats } = fixture('reveal');
  const { id } = await import('../game/ids.ts');
  const runtime = await GameRuntime.create(options);
  await runtime.dispatch({
    type: 'disconnect',
    id: id('command', 'first-absence'),
    seatId: seats[0]!,
  });
  const target = memory(await runtime.checkpoint()).beforeCommands[0]!;
  assert.ok(target.memories.every((m) => m.trump));
  for (let i = 0; i < 260; i++) {
    for (const seatId of seats)
      await runtime.dispatch({
        type: i % 2 ? 'disconnect' : 'reconnect',
        id: id('command', `evict-${i}-${seatId}`),
        seatId,
      });
  }
  assert.ok(
    !memory(await runtime.checkpoint()).beforeCommands.some(
      (item) => item.commandId === target.commandId,
    ),
  );
  await runtime.dispatch({
    type: 'reconnect',
    id: id('command', 'evicted-owner-return'),
    seatId: seats[0]!,
  });
  const result = await runtime.dispatch({
    type: 'rollback',
    id: id('command', 'evicted-fork'),
    actorId: seats[0]!,
    expected: runtime.read().head,
    beforeCommandId: target.commandId,
    knowledgeWarningAcknowledged: true,
  });
  assert.equal(result.type, 'accepted');
  assert.equal(runtime.read().state?.phase.type, 'trump-reveal');
  assert.ok(memory(await runtime.checkpoint()).current.every((m) => m.trump === null));
  await runtime.dispose();
});

test('each fresh staged draw teaches every seat without subscribers or controller ownership', async () => {
  const { options, history, seats } = fixture('vote');
  const { id } = await import('../game/ids.ts');
  const { MemoryHistory } = await import('../persistence/memory-history.ts');
  const fresh = new MemoryHistory(history.read().head.gameId, id('branch', 'main'));
  fresh.append(fresh.read().head, history.read().actions[0]!);
  const runtime = await GameRuntime.create({ ...options, history: fresh });
  for (let draw = 0; draw < 36; draw++) {
    const phase = runtime.read().state!.phase;
    if (phase.type !== 'dealing') assert.fail('Expected dealing');
    await runtime.dispatch({
      type: 'draw-card',
      id: id('command', `captured-draw-${draw}`),
      actorId: phase.nextSeatId,
    });
    const saved = memory(await runtime.checkpoint());
    if (draw < 35) {
      const next = seats[(seats.indexOf(phase.nextSeatId) + 1) % seats.length];
      assert.ok(saved.current.every((m) => m.dealing?.nextSeatId === next));
    } else {
      assert.ok(saved.current.every((m) => m.trump));
      const target = saved.beforeCommands.find(
        (item) => item.commandId === id('command', 'captured-draw-35'),
      )!;
      assert.ok(target.memories.every((m) => m.trump === null));
    }
  }
  await runtime.dispose();
});
