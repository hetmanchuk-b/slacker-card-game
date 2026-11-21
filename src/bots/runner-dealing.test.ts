import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id } from '../game/ids.ts';
import { MemoryHistory } from '../persistence/memory-history.ts';
import { GameRuntime } from '../runtime/runtime.ts';
import type { RuntimeOptions } from '../runtime/runtime.ts';
import { FakeClock } from '../runtime/testing/fake-clock.ts';
import { observeBotCurrent } from './observation.ts';
import { chooseDealingDraw } from './dealing.ts';
import { startBotRunner } from './runner.ts';

async function setup(count = 2, commit?: RuntimeOptions['commit']) {
  const seats = Array.from({ length: count }, (_, i) => id('seat', `seat-${i}`));
  const history = new MemoryHistory(id('game', 'dealing'), id('branch', 'main'));
  const clock = new FakeClock();
  let n = 0;
  const options = {
    history,
    clock,
    connectedSeatIds: seats,
    randomInt: (upper: number) => upper - 1,
    nextCommandId: () => id('command', `command-${n++}`),
    ...(commit ? { commit } : {}),
  };
  const runtime = await GameRuntime.create(options);
  await runtime.dispatch({
    type: 'start-game',
    id: options.nextCommandId(),
    gameId: history.read().head.gameId,
    ownerId: seats[0]!,
    seatIds: seats,
    cardIds: Array.from({ length: 36 }, (_, i) => id('card', `opaque-${i}`)),
  });
  return { runtime, seats, history, clock, options };
}

for (const count of [2, 4, 8]) {
  test(`${count}: projected dealing policy follows two stump passes and unequal hands, then waits`, async () => {
    const { runtime, seats, clock, options } = await setup(count);
    try {
      for (let draw = 0; draw < 36; draw++) {
        const snapshot = runtime.read();
        const actor = seats.find((seatId) => {
          const view = observeBotCurrent(snapshot, seatId, clock.now());
          // Policy fixtures change only controller visibility; all card/order knowledge
          // comes from the real runtime's committed seat memory and projector.
          const control = {
            ...view.control,
            connections: view.control.connections.map((p) => ({
              ...p,
              controller: 'bot' as const,
            })),
          };
          return chooseDealingDraw({ ...view, control }, runtime.readBotMemory(seatId));
        });
        assert.ok(actor, `known recipient at draw ${draw}`);
        assert.equal(
          (
            await runtime.dispatch({
              type: 'draw-card',
              id: options.nextCommandId(),
              actorId: actor,
            })
          ).type,
          'accepted',
        );
        const state = runtime.read().state!;
        if (draw < count * 2) {
          assert.ok(state.players.every((p) => p.hand.length === 0));
          assert.equal(
            state.players.reduce((sum, p) => sum + p.stumps.length, 0),
            draw + 1,
          );
          assert.ok(state.players.every((p) => p.stumps.length <= Math.ceil((draw + 1) / count)));
        }
      }
      const snapshot = runtime.read();
      assert.equal(snapshot.state!.phase.type, 'trump-reveal');
      assert.deepEqual(
        snapshot.state!.players.map((p) => p.hand.length).sort(),
        count === 2 ? [16, 16] : count === 4 ? [7, 7, 7, 7] : [2, 2, 2, 2, 3, 3, 3, 3],
      );
      for (const seatId of seats) {
        const view = observeBotCurrent(snapshot, seatId, clock.now());
        assert.equal(chooseDealingDraw(view, runtime.readBotMemory(seatId)), false);
        assert.notEqual(runtime.readBotMemory(seatId).trump, null);
        assert.ok(view.transient.reveal);
        const suit = view.transient.reveal.card.face.suit;
        assert.equal(runtime.readBotMemory(seatId).trump!.suit, suit === 'spades' ? null : suit);
      }
    } finally {
      await runtime.dispose();
    }
  });
}

test('seat memory read is detached and never exposes an uncommitted or failed draw', async () => {
  let block = false;
  let entered!: () => void;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const committing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const { runtime, seats, options } = await setup(2, async () => {
    if (block) {
      entered();
      await gate;
      throw new Error('storage failure');
    }
  });
  const actor = seats.find((s) => runtime.readBotMemory(s).dealing !== null)!;
  const before = runtime.readBotMemory(actor);
  const detached = runtime.readBotMemory(actor);
  Object.assign(detached, { dealing: null });
  assert.deepEqual(runtime.readBotMemory(actor), before);
  block = true;
  const draw = runtime.dispatch({ type: 'draw-card', id: options.nextCommandId(), actorId: actor });
  await committing;
  assert.deepEqual(runtime.readBotMemory(actor), before);
  release();
  await assert.rejects(draw, /storage failure/);
  assert.throws(() => runtime.readBotMemory(actor), /Runtime/);
  await runtime.dispose();
});

test('replacement during dealing waits for fresh successful draw, then runner draws exactly once', async () => {
  const { runtime, seats, clock, options } = await setup();
  // Initial recipient is seat 1; give it its first stump while still human.
  await runtime.dispatch({ type: 'draw-card', id: options.nextCommandId(), actorId: seats[1]! });
  await runtime.dispatch({ type: 'disconnect', id: options.nextCommandId(), seatId: seats[1]! });
  await clock.advanceBy(30001);
  await runtime.dispatch({
    type: 'propose-bot',
    id: options.nextCommandId(),
    actorId: seats[0]!,
    seatId: seats[1]!,
  });
  await runtime.dispatch({
    type: 'replacement-vote',
    id: options.nextCommandId(),
    actorId: seats[0]!,
    procedureId: runtime.read().replacementVote!.timer.id,
    vote: 'yes',
  });
  const stop = await startBotRunner(runtime, options.nextCommandId);
  await runtime.observe(async () => {});
  assert.equal(runtime.read().state!.deck.length, 35);
  await runtime.dispatch({ type: 'draw-card', id: options.nextCommandId(), actorId: seats[0]! });
  await runtime.observe(async () => {});
  assert.equal(runtime.read().state!.deck.length, 33);
  assert.equal(runtime.read().state!.players[1]!.stumps.length, 2);
  stop();
  await runtime.dispose();
});

test('rejected draw and duplicate captures do not advance known recipient', async () => {
  const { runtime, seats, options } = await setup();
  await runtime.dispatch({ type: 'draw-card', id: options.nextCommandId(), actorId: seats[1]! });
  const before = runtime.readBotMemory(seats[0]!);
  const command = { type: 'draw-card' as const, id: options.nextCommandId(), actorId: seats[1]! };
  await runtime.dispatch(command);
  assert.deepEqual(runtime.readBotMemory(seats[0]!).dealing, before.dealing);
  const after = runtime.readBotMemory(seats[0]!);
  await runtime.dispatch(command);
  assert.deepEqual(runtime.readBotMemory(seats[0]!), after);
  await runtime.dispose();
});

test('unknown legacy recovery waits until a fresh permitted draw establishes order', async () => {
  const { runtime, seats, options, clock } = await setup();
  await runtime.dispatch({ type: 'draw-card', id: options.nextCommandId(), actorId: seats[1]! });
  const saved = await runtime.checkpoint();
  assert.equal(saved.schemaVersion, 2);
  if (saved.schemaVersion !== 2) assert.fail();
  const checkpoint = {
    capturedAtMs: saved.capturedAtMs,
    head: saved.head,
    connections: saved.connections,
    replacementVote: saved.replacementVote,
    controlEvents: saved.controlEvents,
    receipts: saved.receipts,
  };
  await runtime.dispose();
  const restored = await GameRuntime.restore(options, { ...checkpoint, schemaVersion: 1 });
  try {
    for (const seatId of seats) {
      await restored.dispatch({ type: 'reconnect', id: options.nextCommandId(), seatId });
      assert.equal(restored.readBotMemory(seatId).dealing, null);
      assert.equal(restored.readBotMemory(seatId).trump, null);
    }
    const view = observeBotCurrent(restored.read(), seats[0]!, clock.now());
    assert.equal(
      chooseDealingDraw(
        {
          ...view,
          control: {
            ...view.control,
            connections: view.control.connections.map((p) => ({
              ...p,
              controller: 'bot' as const,
            })),
          },
        },
        restored.readBotMemory(seats[0]!),
      ),
      false,
    );
    await restored.dispatch({ type: 'draw-card', id: options.nextCommandId(), actorId: seats[0]! });
    assert.equal(restored.readBotMemory(seats[1]!).dealing?.nextSeatId, seats[1]);
  } finally {
    await restored.dispose();
  }
});

test('suspended reveal stays hidden and runner never expires it or plays after it', async () => {
  const { runtime, seats, clock, options } = await setup();
  // Make seat 1 a bot before dealing, retaining the personal initial notice.
  await runtime.dispatch({ type: 'disconnect', id: options.nextCommandId(), seatId: seats[1]! });
  await clock.advanceBy(30001);
  await runtime.dispatch({
    type: 'propose-bot',
    id: options.nextCommandId(),
    actorId: seats[0]!,
    seatId: seats[1]!,
  });
  await runtime.dispatch({
    type: 'replacement-vote',
    id: options.nextCommandId(),
    actorId: seats[0]!,
    procedureId: runtime.read().replacementVote!.timer.id,
    vote: 'yes',
  });
  const subscribe = runtime.subscribe.bind(runtime);
  runtime.subscribe = (receive, report) =>
    subscribe((publication) => {
      void receive(publication);
      void receive(structuredClone(publication));
    }, report);
  const stop = await startBotRunner(runtime, options.nextCommandId);
  try {
    await runtime.observe(async () => {});
    for (let i = 0; i < 18; i++) {
      await runtime.dispatch({
        type: 'draw-card',
        id: options.nextCommandId(),
        actorId: seats[0]!,
      });
      await runtime.observe(async () => {});
    }
    assert.equal(runtime.read().state!.phase.type, 'trump-reveal');
    const checkpoint = await runtime.checkpoint();
    assert.equal(
      checkpoint.receipts.filter((r) => r.controller === 'bot' && r.command.type === 'draw-card')
        .length,
      18,
    );
    const trump = runtime.readBotMemory(seats[1]!).trump;
    assert.notEqual(trump, null);
    await clock.advanceBy(2000);
    await runtime.dispatch({ type: 'disconnect', id: options.nextCommandId(), seatId: seats[0]! });
    assert.equal(observeBotCurrent(runtime.read(), seats[1]!, clock.now()).transient.reveal, null);
    await clock.advanceBy(20000);
    assert.equal(runtime.read().state!.phase.type, 'trump-reveal');
    assert.deepEqual(runtime.readBotMemory(seats[1]!).trump, trump);
    await runtime.dispatch({ type: 'reconnect', id: options.nextCommandId(), seatId: seats[0]! });
    assert.notEqual(
      observeBotCurrent(runtime.read(), seats[1]!, clock.now()).transient.reveal,
      null,
    );
    await clock.advanceBy(8000);
    await runtime.observe(async () => {});
    assert.equal(runtime.read().state!.phase.type, 'between-rounds');
    const botCommands = (await runtime.checkpoint()).receipts.filter((r) => r.controller === 'bot');
    assert.ok(botCommands.every((r) => r.command.type === 'draw-card'));
  } finally {
    stop();
    await runtime.dispose();
  }
});

test('dealing policy waits during procedures, pause, unknown order and mismatched seat/head', async () => {
  const { runtime, seats, clock, options } = await setup();
  const actor = seats[1]!;
  const botView = () => {
    const view = observeBotCurrent(runtime.read(), actor, clock.now());
    return {
      ...view,
      control: {
        ...view.control,
        connections: view.control.connections.map((p) => ({ ...p, controller: 'bot' as const })),
      },
    };
  };
  const view = botView();
  const memory = runtime.readBotMemory(actor);
  assert.equal(chooseDealingDraw(view, memory), true);
  assert.equal(
    chooseDealingDraw({ ...view, control: { ...view.control, paused: true } }, memory),
    false,
  );
  assert.equal(
    chooseDealingDraw(
      { ...view, transient: { ...view.transient, initialRecipientNotice: false } },
      { ...memory, dealing: null },
    ),
    false,
  );
  assert.equal(chooseDealingDraw(view, { ...memory, seatId: seats[0]! }), false);
  assert.equal(
    chooseDealingDraw(view, { ...memory, head: { ...view.head, version: view.head.version + 1 } }),
    false,
  );
  assert.throws(() => runtime.readBotMemory(id('seat', 'outsider')), /Invalid bot seat/);
  await runtime.dispatch({
    type: 'submit-claim',
    id: options.nextCommandId(),
    actorId: seats[0]!,
    accusedId: actor,
    reason: 'Spoken incident',
    incident: { type: 'spoken', key: 'episode' },
    scope: 'dealing',
    scopeNumber: 0,
  });
  assert.notEqual(botView().procedure, null);
  assert.equal(chooseDealingDraw(botView(), runtime.readBotMemory(actor)), false);
  await runtime.dispose();
});
