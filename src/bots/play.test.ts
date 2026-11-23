import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAction, decide } from '../game/engine.ts';
import type { GameCommand } from '../game/contracts.ts';
import type { GameState } from '../game/model.ts';
import { id } from '../game/ids.ts';
import { scenario, heart, club, spade, seat, cardId } from '../game/testing/scenarios.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import { GameRuntime } from '../runtime/runtime.ts';
import { observeBotAction, observeBotCurrent } from './observation.ts';
import { createBotMemory, rememberBotObservation } from './memory.ts';
import { chooseRoundPlay } from './play.ts';

// Late-state fixtures use the real engine/projectors; no policy sees fixture internals.
async function harness(state: GameState) {
  const { options } = fixture('reveal', state.players.length);
  const runtime = await GameRuntime.create(options);
  let snapshot = {
    ...runtime.read(),
    state,
    head: { gameId: state.gameId, branchId: id('branch', 'main'), version: 10 },
  };
  const view = (index: number) => {
    const current = observeBotCurrent(snapshot, seat(index), 11000);
    return {
      ...current,
      control: {
        ...current.control,
        paused: false,
        connections: current.control.connections.map((p) => ({ ...p, controller: 'bot' as const })),
      },
    };
  };
  let memories = state.players.map((p, i) =>
    rememberBotObservation(createBotMemory(state.gameId, p.id), view(i)),
  );
  let n = 0;
  const run = (command: GameCommand) => {
    const before = snapshot;
    const decision = decide(before.state, command, {
      nowMs: 11000,
      randomInt: (upper) => upper - 1,
    });
    if (decision.type !== 'accepted') assert.fail(decision.code);
    snapshot = {
      ...before,
      head: { ...before.head, version: before.head.version + 1 },
      state: applyAction(before.state, decision.action),
    };
    memories = memories.map((m, i) =>
      rememberBotObservation(
        m,
        view(i),
        observeBotAction(
          { before, after: snapshot, action: decision.action, delivery: 'fresh' },
          seat(i),
        ),
      ),
    );
    return decision;
  };
  return {
    runtime,
    view,
    memory: (i: number) => memories[i]!,
    state: () => snapshot.state,
    choice: (i: number) => chooseRoundPlay(view(i), memories[i]!),
    play: (i: number, face: ReturnType<typeof heart>) =>
      run({
        type: 'play-card',
        id: id('command', `manual-${n++}`),
        actorId: seat(i),
        cardId: cardId(snapshot.state, face),
      }),
    run,
    act: (i: number) => {
      const move = chooseRoundPlay(view(i), memories[i]!);
      assert.ok(move);
      const result = run({ ...move, id: id('command', `bot-${n++}`), actorId: seat(i) });
      assert.equal(result.outcome, 'played');
      return result;
    },
  };
}

for (const [name, top, hand, trump, expected] of [
  ['six over ace', heart(14), [heart(6)], null, 'play-card'],
  ['spade isolation', spade(8), [heart(14)], 'hearts', 'take-bottom'],
  ['known trump', club(14), [heart(6)], 'hearts', 'play-card'],
  ['unknown trump cross-suit', club(14), [heart(6)], undefined, 'take-bottom'],
  ['unknown trump same-suit', heart(14), [heart(6)], undefined, 'play-card'],
] as const) {
  test(`play policy: ${name}`, async () => {
    const h = await harness(
      scenario({ hands: [hand, [club(7)]], table: [top], turn: 0, trump: trump ?? null }),
    );
    try {
      const memory = {
        ...h.memory(0),
        trump: trump === undefined ? null : { head: h.view(0).head, suit: trump },
      };
      assert.equal(chooseRoundPlay(h.view(0), memory)?.type, expected);
      assert.equal(h.choice(1), null, 'never play out of turn');
      assert.equal(
        chooseRoundPlay({ ...h.view(0), control: { ...h.view(0).control, paused: true } }, memory),
        null,
      );
      assert.equal(chooseRoundPlay(h.view(0), { ...memory, seatId: seat(1) }), null);
      assert.equal(
        chooseRoundPlay(h.view(0), { ...memory, head: { ...h.view(0).head, version: 0 } }),
        null,
      );
    } finally {
      await h.runtime.dispose();
    }
  });
}

test('unknown opening waits indefinitely without pickup/peek; a hand can still lead', async () => {
  const h = await harness(
    scenario({ hands: [[], [club(7)]], stumps: [[heart(6)], []], openingSeats: [0] }),
  );
  try {
    assert.equal(h.choice(0), null);
    assert.equal(h.choice(0), null);
  } finally {
    await h.runtime.dispose();
  }
  const lead = await harness(scenario({ hands: [[heart(6), club(6)], [club(7)]] }));
  try {
    assert.equal(lead.choice(0)?.type, 'play-card');
    lead.act(0);
  } finally {
    await lead.runtime.dispose();
  }
});

test('observed boundary grants mandatory opening, consumed once; automatic pickup remains engine-owned', async () => {
  const h = await harness(
    scenario({
      hands: [[heart(10)], [heart(12), club(7), club(10)]],
      stumps: [[club(8), club(9)], []],
    }),
  );
  try {
    h.act(0);
    h.act(1);
    assert.equal(h.memory(0).opening?.available, true);
    assert.equal(h.choice(0), null, 'no voluntary out-of-turn opening');
    h.act(1);
    assert.equal(h.choice(0)?.type, 'open-stump');
    h.act(0);
    assert.equal(h.memory(0).opening?.available, false);
    h.act(0);
    assert.equal(h.state().phase.type, 'between-rounds');
  } finally {
    await h.runtime.dispose();
  }
});

test('fixed N and empty-hand automatic bottom pickup are settled before next policy choice (scenario 5)', async () => {
  const h = await harness(
    scenario({ hands: [[heart(10)], [heart(12), club(8)], [club(6)], [heart(14), club(7)]] }),
  );
  try {
    h.act(0);
    h.act(1);
    h.act(2);
    h.act(3);
    const state = h.state();
    assert.equal(state.phase.type, 'round');
    if (state.phase.type !== 'round') assert.fail();
    assert.equal(state.phase.targetSize, 4);
    assert.equal(state.phase.turnSeatId, seat(1));
    assert.deepEqual(state.players[0]!.hand, [cardId(state, heart(12))]);
    assert.deepEqual(state.table, [cardId(state, heart(14))]);
    assert.equal(h.choice(0), null);
  } finally {
    await h.runtime.dispose();
  }
});

test('penalty-restored hand preserves right, blocks opening, and interrupted turn resumes', async () => {
  const h = await harness(
    scenario({
      hands: [[heart(10)], [heart(12), club(7), club(9), club(10)]],
      stumps: [[club(8)], []],
    }),
  );
  try {
    h.act(0);
    h.act(1);
    h.act(1);
    h.run({ type: 'take-bottom', id: id('command', 'human-violation'), actorId: seat(0) });
    assert.equal(h.choice(0), null, 'procedure blocks play');
    const procedure = h.state().procedure;
    assert.equal(procedure?.type, 'penalty');
    if (procedure?.type !== 'penalty') assert.fail();
    h.run({
      type: 'penalty-response',
      id: id('command', 'donate'),
      actorId: seat(1),
      procedureId: procedure.timer.id,
      cardId: cardId(h.state(), club(9)),
    });
    assert.equal(h.memory(0).opening?.available, true);
    assert.equal(h.choice(0)?.type, 'play-card', 'restored hand plays rather than opening');
    h.act(0);
    assert.equal(h.state().procedure, null);
  } finally {
    await h.runtime.dispose();
  }
});

test('D001 repetition completes from projected legal choices without forced discard', async () => {
  const h = await harness(
    scenario({
      hands: [[heart(6), club(6)], [club(7)], [heart(14), heart(7), club(8)]],
      leader: 2,
    }),
  );
  try {
    h.act(2);
    const table = [...h.state().table];
    const discard = [...h.state().discard];
    for (let n = 0; n < 100 && h.state().phase.type !== 'finished'; n++) {
      const actor = [0, 1, 2].find((i) => h.choice(i) !== null);
      assert.notEqual(actor, undefined);
      h.act(actor!);
    }
    assert.deepEqual(h.state().phase, {
      type: 'finished',
      result: { type: 'draw', remainingSeatIds: [seat(0), seat(1), seat(2)] },
    });
    assert.deepEqual(h.state().table, table);
    assert.deepEqual(h.state().discard, discard);
  } finally {
    await h.runtime.dispose();
  }
});

test('compound penalty loses proof conservatively even when authoritative opening right survives', async () => {
  const h = await harness(
    scenario({
      hands: [
        [heart(10)],
        [heart(11), club(9), club(10)],
        [heart(12), heart(6)],
        [heart(13), club(7), club(11)],
      ],
      stumps: [[club(8)], [], [], []],
    }),
  );
  try {
    for (const i of [0, 1, 2, 3]) h.act(i);
    assert.equal(h.memory(0).opening?.available, true);
    h.act(3);
    h.run({ type: 'take-bottom', id: id('command', 'obstruct'), actorId: seat(0) });
    const procedure = h.state().procedure;
    if (procedure?.type !== 'penalty') assert.fail();
    for (const i of [1, 2, 3])
      h.run({
        type: 'penalty-response',
        id: id('command', `response-${i}`),
        actorId: seat(i),
        procedureId: procedure.timer.id,
        cardId: i === 1 ? cardId(h.state(), club(9)) : null,
      });
    assert.equal(h.choice(0)?.type, 'play-card');
    for (const i of [0, 1, 2, 3]) h.act(i);
    assert.equal(h.memory(0).opening, null);
    assert.ok(h.state().openingRights.some((right) => right.seatId === seat(0)));
    assert.equal(h.choice(0), null, 'unknown right must not be bypassed by a pickup');
  } finally {
    await h.runtime.dispose();
  }
});
