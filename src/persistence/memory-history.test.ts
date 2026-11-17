import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAction, decide } from '../game/engine.ts';
import type { CardId } from '../game/ids.ts';
import { id } from '../game/ids.ts';
import { MemoryHistory } from './memory-history.ts';

function fixture() {
  const gameId = id('game', 'game-1');
  const history = new MemoryHistory(gameId, id('branch', 'main'));
  const decision = decide(
    null,
    {
      type: 'start-game',
      id: id('command', 'start-1'),
      gameId,
      ownerId: id('seat', 'a'),
      seatIds: [id('seat', 'a'), id('seat', 'b')],
      cardIds: Array.from({ length: 36 }, (_, index) => id('card', `card-${index}`)),
    },
    { nowMs: 0, randomInt: (upper) => upper - 1 },
  );
  if (decision.type !== 'accepted') throw new Error('Invalid fixture');
  return { history, action: decision.action };
}

function nextDraw(history: MemoryHistory, commandId: string, nowMs = 10) {
  const { state } = history.read();
  if (state?.phase.type !== 'dealing') throw new Error('Expected dealing');
  const result = decide(
    state,
    {
      type: 'draw-card',
      id: id('command', commandId),
      actorId: state.phase.nextSeatId,
    },
    { nowMs, randomInt: (upper) => upper - 1 },
  );
  if (result.type !== 'accepted') throw new Error('Invalid draw fixture');
  return result.action;
}

test('history atomically commits an action and recovers its game state', () => {
  const { history, action } = fixture();
  const result = history.append(history.read().head, action);
  assert.equal(result.type, 'committed');
  const snapshot = history.read();
  assert.equal(snapshot.head.version, 1);
  assert.equal(snapshot.actions.length, 1);
  assert.equal(snapshot.state?.phase.type, 'dealing');
  assert.deepEqual(snapshot.actions[0], action);
});

test('retrying the exact same action commits once, even with its original expected version', () => {
  const { history, action } = fixture();
  const originalHead = history.read().head;
  assert.equal(history.append(originalHead, action).type, 'committed');
  assert.deepEqual(history.append(originalHead, action), {
    type: 'duplicate',
    head: { ...originalHead, version: 1 },
  });
  assert.equal(history.read().actions.length, 1);
  assert.equal(history.append(originalHead, { ...action, occurredAtMs: 1 }).type, 'rejected');
  assert.equal(history.read().actions.length, 1);
});

test('optimistic version and branch checks prevent a stale writer from changing state', () => {
  const { history, action } = fixture();
  const originalHead = history.read().head;
  history.append(originalHead, action);
  const before = history.read();
  const draw = nextDraw(history, 'draw-1');
  assert.deepEqual(history.append(originalHead, draw), {
    type: 'rejected',
    code: 'version-conflict',
    head: before.head,
  });
  assert.deepEqual(history.append({ ...before.head, branchId: id('branch', 'other') }, draw), {
    type: 'rejected',
    code: 'wrong-branch',
    head: before.head,
  });
  assert.deepEqual(history.read(), before);
});

test('a failing event inside a batch does not commit earlier events in that batch', () => {
  const { history, action } = fixture();
  history.append(history.read().head, action);
  const before = history.read();
  const draw = nextDraw(history, 'draw-1');
  const broken = {
    ...draw,
    events: [...draw.events, { ...draw.events[0]!, id: id('event', 'second-broken-event') }],
  };
  assert.throws(() => history.append(before.head, broken));
  assert.deepEqual(history.read(), before);
});

test('history owns its recorded arrays and returned snapshots are detached', () => {
  const { history, action } = fixture();
  history.append(history.read().head, action);
  const snapshot = history.read();
  const creation = action.events[0]!.event;
  if (creation.type !== 'game-started' || snapshot.state === null)
    throw new Error('Expected creation');
  (creation.deck as CardId[])[0] = id('card', 'changed-input');
  (snapshot.state.deck as CardId[])[0] = id('card', 'changed-output');
  assert.equal(history.read().state?.deck[0], 'card-0');
});

test('full dealing history can be recovered using only the recorded events', () => {
  const { history, action } = fixture();
  history.append(history.read().head, action);
  for (let index = 0; index < 36; index++) {
    assert.equal(
      history.append(history.read().head, nextDraw(history, `draw-${index}`, index + 1)).type,
      'committed',
    );
  }
  const snapshot = history.read();
  const replayed = snapshot.actions.reduce(
    (state, recorded) => applyAction(state, recorded),
    null as typeof snapshot.state,
  );
  assert.deepEqual(replayed, snapshot.state);
  assert.equal(snapshot.head.version, 37);
  assert.equal(snapshot.state?.phase.type, 'trump-reveal');
});

test('backdated commits and reused event identities cannot corrupt chronological history', () => {
  const { history, action } = fixture();
  history.append(history.read().head, action);
  const draw = nextDraw(history, 'draw-1', 10);
  history.append(history.read().head, draw);
  const before = history.read();
  assert.throws(() => history.append(before.head, nextDraw(history, 'draw-2', 5)), /chronological/);
  const another = nextDraw(history, 'draw-3', 11);
  assert.throws(
    () =>
      history.append(before.head, {
        ...another,
        events: [{ ...another.events[0]!, id: action.events[0]!.id }],
      }),
    /event ID/,
  );
  assert.deepEqual(history.read(), before);
});
