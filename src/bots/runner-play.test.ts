import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id } from '../game/ids.ts';
import { GameRuntime } from '../runtime/runtime.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import { startBotRunner } from './runner.ts';
import { MemoryHistory } from '../persistence/memory-history.ts';
import { FakeClock } from '../runtime/testing/fake-clock.ts';
import { observeBotCurrent } from './observation.ts';
import { chooseDealingDraw } from './dealing.ts';
import { chooseRoundPlay } from './play.ts';

test('runner leads from committed seat memory after replacement and stops on human handback', async () => {
  const { options, clock, seats } = fixture('reveal');
  const runtime = await GameRuntime.create(options);
  let stop = () => {};
  try {
    const actor = seats[0]!;
    await runtime.dispatch({ type: 'disconnect', id: id('command', 'leave'), seatId: actor });
    await clock.advanceBy(30001);
    await runtime.dispatch({
      type: 'propose-bot',
      id: id('command', 'replace'),
      actorId: seats[1]!,
      seatId: actor,
    });
    await runtime.dispatch({
      type: 'replacement-vote',
      id: id('command', 'yes'),
      actorId: seats[1]!,
      procedureId: runtime.read().replacementVote!.timer.id,
      vote: 'yes',
    });
    const before = runtime.read().state!.players[0]!.hand.length;
    const errors: unknown[] = [];
    stop = await startBotRunner(runtime, options.nextCommandId, (e) => errors.push(e));
    await clock.advanceBy(10000);
    await runtime.observe(async () => {});
    assert.equal(runtime.read().state!.players[0]!.hand.length, before - 1);
    assert.equal(runtime.read().state!.table.length, 1);
    const receipts = (await runtime.checkpoint()).receipts.filter((r) => r.controller === 'bot');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.command.type, 'play-card');
    await runtime.dispatch({ type: 'reconnect', id: id('command', 'return'), seatId: actor });
    await runtime.observe(async () => {});
    assert.equal(runtime.read().connections[0]!.controller, 'human');
    assert.equal(
      (await runtime.checkpoint()).receipts.filter((r) => r.controller === 'bot').length,
      1,
    );
    assert.deepEqual(errors, []);
  } finally {
    stop();
    await runtime.dispose();
  }
});

for (const count of [2, 4, 5, 8]) {
  test(`${count}: committed runtime play either finishes or waits only for unknown opening proof`, async (t) => {
    const seats = Array.from({ length: count }, (_, i) => id('seat', `seat-${i}`));
    const history = new MemoryHistory(id('game', `play-${count}`), id('branch', 'main'));
    const clock = new FakeClock();
    let n = 0;
    const nextId = () => id('command', `complete-${n++}`);
    const runtime = await GameRuntime.create({
      history,
      clock,
      connectedSeatIds: seats,
      randomInt: (upper) => upper - 1,
      nextCommandId: nextId,
    });
    try {
      await runtime.dispatch({
        type: 'start-game',
        id: nextId(),
        gameId: history.read().head.gameId,
        ownerId: seats[0]!,
        seatIds: seats,
        cardIds: Array.from({ length: 36 }, (_, i) => id('card', `opaque-${i}`)),
      });
      while (runtime.read().state!.phase.type !== 'finished' && n < 1000) {
        if (runtime.read().state!.phase.type === 'trump-reveal') {
          await clock.advanceBy(10000);
          continue;
        }
        let moved = false;
        for (const actorId of seats) {
          const current = observeBotCurrent(runtime.read(), actorId, clock.now());
          // Exercise the policy with bot controller visibility, while real
          // dispatch remains human-bound. Memory comes only from committed runtime.
          const view = {
            ...current,
            control: {
              ...current.control,
              connections: current.control.connections.map((p) => ({
                ...p,
                controller: 'bot' as const,
              })),
            },
          };
          const memory = runtime.readBotMemory(actorId);
          const move = chooseDealingDraw(view, memory)
            ? { type: 'draw-card' as const }
            : chooseRoundPlay(view, memory);
          if (!move) continue;
          assert.equal(
            (await runtime.dispatch({ ...move, id: nextId(), actorId })).type,
            'accepted',
          );
          assert.equal(runtime.read().state!.procedure, null);
          moved = true;
          break;
        }
        if (!moved) {
          const phase = runtime.read().state!.phase;
          assert.ok(phase.type === 'round' || phase.type === 'between-rounds');
          const actor = phase.type === 'round' ? phase.turnSeatId : phase.leaderId;
          const own = observeBotCurrent(runtime.read(), actor, clock.now()).state!.own!;
          assert.equal(own.hand.length, 0);
          assert.ok(own.stumps.length > 0);
          assert.equal(runtime.readBotMemory(actor).opening, null);
          break;
        }
      }
      assert.ok(n < 1000);
      t.diagnostic(`Settled after ${n} commands: ${runtime.read().state!.phase.type}`);
    } finally {
      await runtime.dispose();
    }
  });
}

test('fresh pickup-boundary rights are checkpointed; recovery, retries and missing rollback knowledge never reconstruct them', async () => {
  const { options, clock, seats, history } = fixture('reveal');
  let runtime = await GameRuntime.create(options);
  let n = 0;
  const nextId = () => id('command', `boundary-runtime-${n++}`);
  try {
    await clock.advanceBy(10000);
    let boundaryCommand: Parameters<GameRuntime['dispatch']>[0] | undefined;
    let entitled: (typeof seats)[number] | undefined;
    while (n < 500 && runtime.read().state!.phase.type !== 'finished') {
      let moved = false;
      for (const actorId of seats) {
        const current = observeBotCurrent(runtime.read(), actorId, clock.now());
        const view = {
          ...current,
          control: {
            ...current.control,
            connections: current.control.connections.map((p) => ({
              ...p,
              controller: 'bot' as const,
            })),
          },
        };
        const move = chooseRoundPlay(view, runtime.readBotMemory(actorId));
        if (!move) continue;
        const command = { ...move, id: nextId(), actorId };
        assert.equal((await runtime.dispatch(command)).type, 'accepted');
        moved = true;
        const action = history.read().actions.at(-1)!;
        if (
          runtime.read().state!.phase.type === 'between-rounds' &&
          action.events.some((e) => e.event.type === 'bottom-taken')
        ) {
          entitled = seats.find((s) => runtime.readBotMemory(s).opening?.available);
          if (entitled) boundaryCommand = command;
        }
        break;
      }
      if (boundaryCommand || !moved) break;
    }
    assert.ok(boundaryCommand, 'real runtime reached a freshly observed pickup boundary');
    assert.ok(entitled);
    const saved = await runtime.checkpoint();
    if (saved.schemaVersion !== 2) assert.fail();
    assert.equal(
      saved.botMemory.current.find((m) => m.seatId === entitled)!.opening?.available,
      true,
    );
    await runtime.dispose();
    runtime = await GameRuntime.restore(options, saved);
    assert.equal(
      runtime.readBotMemory(entitled).opening,
      null,
      'recovery suspension breaks observation continuity conservatively',
    );
    for (const seatId of seats) await runtime.dispatch({ type: 'reconnect', id: nextId(), seatId });
    await runtime.dispatch(boundaryCommand);
    assert.equal(
      runtime.readBotMemory(entitled).opening,
      null,
      'recovery suspension breaks observation continuity conservatively',
    );
    const restored = await runtime.checkpoint();
    if (restored.schemaVersion !== 2) assert.fail();
    await runtime.dispose();
    runtime = await GameRuntime.restore(options, {
      ...restored,
      botMemory: {
        ...restored.botMemory,
        beforeCommands: [],
        current: restored.botMemory.current.map((m) => ({ ...m, opening: null })),
      },
    });
    for (const seatId of seats) await runtime.dispatch({ type: 'reconnect', id: nextId(), seatId });
    await runtime.dispatch(boundaryCommand);
    assert.equal(
      runtime.readBotMemory(entitled).opening,
      null,
      'retry/reconnect never repairs unknown at the same head',
    );
    assert.equal(
      (
        await runtime.dispatch({
          type: 'rollback',
          id: nextId(),
          actorId: seats[0]!,
          expected: runtime.read().head,
          beforeCommandId: boundaryCommand.id,
          knowledgeWarningAcknowledged: true,
        })
      ).type,
      'accepted',
    );
    assert.equal(
      runtime.readBotMemory(entitled).opening,
      null,
      'missing target checkpoint remains unknown',
    );
  } finally {
    await runtime.dispose();
  }
});
