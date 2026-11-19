import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide } from '../game/engine.ts';
import { id } from '../game/ids.ts';
import { MemoryHistory } from '../persistence/memory-history.ts';
import { GameRuntime } from '../runtime/runtime.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import { finishMatch } from '../runtime/testing/match.ts';
import type { GameCommand } from '../game/contracts.ts';
import type { CommandId } from '../game/ids.ts';
import { projectOwnerHistory, projectRollbackNotice } from './history.ts';

test('rollback notices contain only actor and ordinal target/result, including rollback before creation', () => {
  const { history, seats } = fixture('reveal', 4);
  fork(history, id('command', 'draw-0'));
  const first = projectRollbackNotice(history.snapshot().value);
  assert.deepEqual(first, {
    actorId: seats[0],
    target: {
      expected: { gameId: history.read().head.gameId, branch: 1, version: 37 },
      beforeActionVersion: 2,
    },
    head: { gameId: history.read().head.gameId, branch: 2, version: 2 },
  });
  fork(history, id('command', 'start'), 'empty', 13000);
  const empty = projectRollbackNotice(history.snapshot().value);
  assert.deepEqual(empty.head, { gameId: history.read().head.gameId, branch: 3, version: 0 });
  assert.equal(empty.target.beforeActionVersion, 1);
  assert.equal(empty.target.expected.branch, 2);
  for (const text of ['opaque-', 'commandId', 'branchId', 'state', 'events', 'cards', 'draw-0'])
    assert.equal(JSON.stringify(empty).includes(text), false, text);
});

function append(history: MemoryHistory, command: GameCommand, nowMs = 11000) {
  const snapshot = history.read();
  const decision = decide(snapshot.state, command, { nowMs, randomInt: (upper) => upper - 1 });
  if (decision.type !== 'accepted') assert.fail(decision.code);
  assert.equal(history.append(snapshot.head, decision.action).type, 'committed');
}

function fork(history: MemoryHistory, beforeCommandId: CommandId, label = 'fork', nowMs = 12000) {
  const result = history.fork(history.read().head, {
    id: id('command', label),
    actorId: history.snapshot().value.ownerId!,
    beforeCommandId,
    branchId: id('branch', label),
    nowMs,
    resumeClock: true,
    knowledgeWarningAcknowledged: true,
  });
  assert.equal(result.type, 'committed');
}

for (const count of [2, 4, 8]) {
  test(`${count}-seat owner timeline is one row per completed action with no card data or creation notice`, () => {
    const { history, seats } = fixture('reveal', count);
    const input = history.snapshot().value;
    const before = structuredClone(input);
    const view = projectOwnerHistory(input, { type: 'seat', seatId: seats[0]! });
    assert.deepEqual(view.head, { gameId: input.active.head.gameId, branch: 1, version: 37 });
    assert.equal(view.rollbackOpen, true);
    assert.equal(view.branches.length, 1);
    const branch = view.branches[0]!;
    assert.equal(branch.label, 'active');
    assert.equal(branch.parent, null);
    assert.equal(branch.actions.length, input.active.actions.length);
    assert.deepEqual(branch.actions[0], {
      version: 1,
      origin: { branch: 1, version: 1 },
      occurredAtMs: 1000,
      summaries: [{ type: 'game-started', actorId: seats[0] }],
      rollbackTarget: { expected: view.head, beforeActionVersion: 1 },
    });
    assert.deepEqual(branch.actions.at(-1)!.summaries, [
      { type: 'card-drawn', actorId: seats[(count - 1 + 35) % count], destination: 'hand' },
    ]);
    const serialized = JSON.stringify(view);
    for (const key of [
      'opaque-',
      'cardId',
      'cards',
      'deck',
      'trump',
      'firstRecipient',
      'state',
      'events',
      'draw-35',
      '"start"',
    ]) {
      assert.equal(serialized.includes(key), false, key);
    }
    assert.deepEqual(input, before);
  });
}

test('non-owner, public and never-created viewers fail with a fixed error', () => {
  const { history, seats } = fixture('vote', 4);
  for (const viewer of [
    { type: 'public' as const },
    { type: 'seat' as const, seatId: seats[1]! },
    { type: 'seat' as const, seatId: id('seat', 'SECRET-UNKNOWN') },
  ]) {
    assert.throws(() => projectOwnerHistory(history.snapshot().value, viewer), {
      message: 'Owner history unavailable',
    });
  }
  const empty = new MemoryHistory(id('game', 'empty'), id('branch', 'main'));
  assert.throws(
    () => projectOwnerHistory(empty.snapshot().value, { type: 'seat', seatId: seats[0]! }),
    { message: 'Owner history unavailable' },
  );
});

test('retained branches have labels but no targets; active inherited rows remain selectable', () => {
  const { history, seats } = fixture('reveal', 4);
  const abandoned = history.read();
  fork(history, abandoned.actions[10]!.commandId);
  const input = history.snapshot().value;
  const view = projectOwnerHistory(input, { type: 'seat', seatId: seats[0]! });
  assert.deepEqual(
    view.branches.map((branch) => branch.label),
    ['abandoned', 'active'],
  );
  const old = view.branches[0]!;
  const active = view.branches[1]!;
  assert.equal(old.actions.length, 37);
  assert.ok(old.actions.every((action) => action.rollbackTarget === null));
  assert.deepEqual(active.parent, { gameId: input.active.head.gameId, branch: 1, version: 10 });
  assert.equal(active.actions.length, 11, 'inherited prefix plus synthetic rebase');
  assert.deepEqual(active.actions[0]!.origin, { branch: 1, version: 1 });
  assert.deepEqual(active.actions[10]!.origin, { branch: 2, version: 11 });
  assert.deepEqual(active.actions[10]!.summaries, [
    { type: 'rollback', actorId: seats[0], rollback: 1 },
  ]);
  for (const row of active.actions)
    assert.deepEqual(row.rollbackTarget, { expected: view.head, beforeActionVersion: row.version });
  assert.deepEqual(view.rollbacks, [
    {
      actorId: seats[0],
      occurredAtMs: 12000,
      abandoned: { gameId: input.active.head.gameId, branch: 1, version: 37 },
      parent: { gameId: input.active.head.gameId, branch: 1, version: 10 },
      restored: { gameId: input.active.head.gameId, branch: 2, version: 11 },
      beforeAction: { branch: 1, version: 11 },
    },
  ]);
});

test('nested branches preserve origin ordinals and synthetic rebase rollback targets', () => {
  const { history, seats } = fixture('reveal', 4);
  fork(history, history.read().actions[10]!.commandId, '__proto__');
  fork(history, history.read().actions[10]!.commandId, 'constructor', 13000);
  const view = projectOwnerHistory(history.snapshot().value, { type: 'seat', seatId: seats[0]! });
  const active = view.branches[2]!;
  assert.equal(active.label, 'active');
  assert.equal(view.rollbacks.length, 2);
  assert.deepEqual(
    active.actions.slice(0, 10).map((row) => row.origin.branch),
    Array(10).fill(1),
  );
  assert.deepEqual(active.actions[10]!.origin, { branch: 3, version: 11 });
  assert.deepEqual(active.actions[10]!.summaries, [
    { type: 'rollback', actorId: seats[0], rollback: 2 },
  ]);
});

test('original owner retains access after rollback before creation without a fabricated action or preview', () => {
  const { history, seats } = fixture('reveal', 4);
  fork(history, history.read().actions[0]!.commandId, 'before-creation');
  const input = history.snapshot().value;
  assert.equal(input.active.state, null);
  const view = projectOwnerHistory(input, { type: 'seat', seatId: seats[0]! });
  assert.deepEqual(view.branches[1]!.actions, []);
  assert.equal(view.head.version, 0);
  assert.equal(view.rollbacks.length, 1);
  assert.deepEqual(view.rollbacks[0]!.beforeAction, { branch: 1, version: 1 });
  assert.equal(JSON.stringify(view).includes('state'), false);
  assert.throws(() => projectOwnerHistory(input, { type: 'seat', seatId: seats[1]! }), {
    message: 'Owner history unavailable',
  });
});

test('irreversible closure disables every target but retains all timeline and audit metadata', () => {
  const { history, seats } = fixture('reveal', 4);
  fork(history, history.read().actions[10]!.commandId);
  const open = projectOwnerHistory(history.snapshot().value, { type: 'seat', seatId: seats[0]! });
  history.closeRollback();
  const closed = projectOwnerHistory(history.snapshot().value, { type: 'seat', seatId: seats[0]! });
  assert.equal(closed.rollbackOpen, false);
  assert.deepEqual(closed.head, open.head, 'closure need not change action head');
  assert.deepEqual(closed.rollbacks, open.rollbacks);
  assert.ok(
    closed.branches.flatMap((branch) => branch.actions).every((row) => row.rollbackTarget === null),
  );
});

test('claim submissions and final verdicts are visible but individual ballot and approval choices stay private', () => {
  const { history, seats } = fixture('vote', 4);
  const initial = history.read().state!.procedure!;
  append(
    history,
    {
      type: 'cast-vote',
      id: id('command', 'ballot'),
      actorId: seats[0]!,
      procedureId: initial.timer.id,
      vote: 'yes',
    },
    1000,
  );
  append(history, {
    type: 'expire-claim-vote',
    id: id('command', 'deadline'),
    timerId: initial.timer.id,
  });
  const view = projectOwnerHistory(history.snapshot().value, { type: 'seat', seatId: seats[0]! });
  const rows = view.branches[0]!.actions;
  assert.deepEqual(rows[1]!.summaries[0], {
    type: 'claim-submitted',
    claim: {
      submittedAtVersion: 2,
      claimantId: seats[0],
      accusedId: seats[1],
      reason: 'Spoken incident',
      scope: 'dealing',
      scopeNumber: 0,
    },
  });
  assert.deepEqual(rows[2]!.summaries, [{ type: 'claim-vote-cast', actorId: seats[0] }]);
  assert.ok(
    rows[3]!.summaries.some(
      (item) =>
        item.type === 'claim-vote-resolved' &&
        item.submittedAtVersion === 2 &&
        item.resolution === 'upheld',
    ),
  );
  const serialized = JSON.stringify(view);
  for (const hidden of [
    '"yes"',
    'incidentKey',
    '"incident"',
    'procedureId',
    'claimId',
    'commandId',
  ])
    assert.equal(serialized.includes(hidden), false, hidden);
});

test('withdrawal timeline shows actors and final outcome, not individual approvals', () => {
  const { history, seats } = fixture('withdrawal', 4);
  const procedure = history.read().state!.procedure!;
  append(
    history,
    {
      type: 'withdrawal-response',
      id: id('command', 'denial'),
      actorId: seats[1]!,
      procedureId: procedure.timer.id,
      approve: false,
    },
    5000,
  );
  const view = projectOwnerHistory(history.snapshot().value, { type: 'seat', seatId: seats[0]! });
  assert.deepEqual(view.branches[0]!.actions.at(-1)!.summaries, [
    { type: 'withdrawal-answered', actorId: seats[1] },
    { type: 'withdrawal-resolved', submittedAtVersion: 2, approved: false },
  ]);
});

test('penalty choices and transferred cards never appear even in the owner timeline', () => {
  const { history, seats } = fixture('penalty', 4);
  const state = history.read().state!;
  const procedure = state.procedure!;
  const selected = state.players[1]!.hand[0]!;
  append(history, {
    type: 'penalty-response',
    id: id('command', `SECRET-${selected}`),
    actorId: seats[1]!,
    procedureId: procedure.timer.id,
    cardId: selected,
  });
  append(
    history,
    { type: 'expire-penalty', id: id('command', 'timeout'), timerId: procedure.timer.id },
    21000,
  );
  const view = projectOwnerHistory(history.snapshot().value, { type: 'seat', seatId: seats[0]! });
  assert.deepEqual(view.branches[0]!.actions.at(-2)!.summaries, [
    { type: 'penalty-answered', actorId: seats[1] },
  ]);
  assert.equal(JSON.stringify(view).includes(selected), false);
  assert.equal(JSON.stringify(view).includes('SECRET-'), false);
  assert.equal(JSON.stringify(view).includes('refuse'), false);
});

test('hidden faces, knowledge and unknown properties do not affect history metadata and output is detached', () => {
  const { history, seats } = fixture('reveal', 4);
  const input = history.snapshot().value;
  const baseline = projectOwnerHistory(input, { type: 'seat', seatId: seats[0]! });
  const changed = structuredClone(input);
  Object.defineProperty(changed.active, 'state', {
    get() {
      throw new Error('State must never be inspected');
    },
  });
  Object.assign(changed, { secret: 'SECRET-ROOT' });
  Object.assign(changed.active.head, { secret: 'SECRET-HEAD' });
  for (const action of changed.active.actions) {
    Object.assign(action, { secret: 'SECRET-ACTION' });
    for (const envelope of action.events) {
      Object.assign(envelope, { secret: 'SECRET-ENVELOPE' });
      Object.assign(envelope.event, { secret: 'SECRET-EVENT' });
    }
  }
  const view = projectOwnerHistory(changed, { type: 'seat', seatId: seats[0]! });
  assert.deepEqual(view, baseline);
  (view.head as { version: number }).version = 999;
  (view.branches[0]!.actions as unknown[]).length = 0;
  assert.equal(input.active.actions.length, 37);
  assert.equal(input.active.head.version, 37);
  assert.equal(baseline.head.version, 37);
});

test('archive replay and snapshot-assisted recovery preserve identical metadata views including closure', () => {
  const { history, seats } = fixture('withdrawal', 4);
  fork(history, history.read().actions.at(-1)!.commandId);
  history.closeRollback();
  const viewer = { type: 'seat' as const, seatId: seats[0]! };
  const expected = projectOwnerHistory(history.snapshot().value, viewer);
  for (const recovered of [
    MemoryHistory.restore(history.archive()),
    MemoryHistory.restoreSnapshot(history.archive(), history.snapshot()),
  ]) {
    assert.deepEqual(projectOwnerHistory(recovered.snapshot().value, viewer), expected);
  }
});

test('mixed-game or invalid branch captures fail without echoing raw diagnostic data', () => {
  const { history, seats } = fixture('reveal');
  const input = history.snapshot().value;
  const viewer = { type: 'seat' as const, seatId: seats[0]! };
  for (const changed of [
    { ...input, active: { ...input.active, head: { ...input.active.head, version: 900 } } },
    { ...input, parents: [] },
    {
      ...input,
      archives: [
        { ...input.active, head: { ...input.active.head, gameId: id('game', 'SECRET-OTHER') } },
      ],
    },
  ])
    assert.throws(() => projectOwnerHistory(changed, viewer), {
      message: 'Invalid owner history context',
    });
});

test('publicly played cards and private peek data stay absent from abandoned and active history', () => {
  const { history, seats } = fixture('reveal', 4);
  const reveal = history.read().state!.phase;
  if (reveal.type !== 'trump-reveal') assert.fail();
  append(history, {
    type: 'expire-reveal',
    id: id('command', 'reveal-done'),
    timerId: reveal.timer.id,
  });
  const stump = history.read().state!.players[0]!.stumps[0]!;
  append(history, {
    type: 'open-stump',
    id: id('command', `PRIVATE-${stump}`),
    actorId: seats[0]!,
    cardId: stump,
  });
  const penalty = history.read().state!.procedure!;
  append(
    history,
    { type: 'expire-penalty', id: id('command', 'penalty-done'), timerId: penalty.timer.id },
    21000,
  );
  const state = history.read().state!;
  const phase = state.phase;
  if (phase.type !== 'between-rounds') assert.fail();
  const played = state.players.find((player) => player.id === phase.leaderId)!.hand[0]!;
  const playId = id('command', `PUBLIC-${played}`);
  append(
    history,
    { type: 'play-card', id: playId, actorId: phase.leaderId, cardId: played },
    21000,
  );
  const round = history.read().state!.phase;
  if (round.type !== 'round') assert.fail();
  append(
    history,
    { type: 'take-bottom', id: id('command', 'take'), actorId: round.turnSeatId },
    21000,
  );
  fork(history, playId, `SECRET-BRANCH-${stump}`, 22000);
  const view = projectOwnerHistory(history.snapshot().value, { type: 'seat', seatId: seats[0]! });
  const summaries = view.branches.flatMap((branch) =>
    branch.actions.flatMap((row) => row.summaries),
  );
  assert.ok(summaries.some((item) => item.type === 'card-played'));
  assert.ok(summaries.some((item) => item.type === 'bottom-taken'));
  assert.ok(summaries.some((item) => item.type === 'violation' && item.reason === 'peek'));
  for (const hidden of [
    'opaque-',
    'PRIVATE-',
    'PUBLIC-',
    'SECRET-',
    'peekedStumps',
    'cardId',
    '"rank"',
    '"suit"',
  ]) {
    assert.equal(JSON.stringify(view).includes(hidden), false, hidden);
  }
});

test('finished matches retain owner history and targets until queued rollback closure', async () => {
  const { history, options, clock, seats } = fixture('reveal', 2);
  const runtime = await GameRuntime.create(options);
  try {
    await clock.advanceBy(10000);
    await finishMatch(runtime);
    assert.equal(runtime.read().state!.phase.type, 'finished');
    const viewer = { type: 'seat' as const, seatId: seats[0]! };
    const open = projectOwnerHistory(history.snapshot().value, viewer);
    assert.equal(open.rollbackOpen, true);
    assert.ok(open.branches[0]!.actions.every((row) => row.rollbackTarget !== null));
    assert.equal(await runtime.closeForNextMatch(), true);
    const closed = projectOwnerHistory(history.snapshot().value, viewer);
    assert.equal(closed.rollbackOpen, false);
    assert.ok(closed.branches[0]!.actions.every((row) => row.rollbackTarget === null));
    assert.equal(closed.branches[0]!.actions.length, open.branches[0]!.actions.length);
  } finally {
    await runtime.dispose();
  }
});
