import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAction, decide } from '../game/engine.ts';
import { id } from '../game/ids.ts';
import { cardId, club, heart, scenario, seat } from '../game/testing/scenarios.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import { projectLiveGame } from '../projections/live.ts';
import { projectOwnerHistory } from '../projections/history.ts';
import {
  makeStateMessage,
  makeActionMessage,
  makeOwnerHistoryMessage,
  makeCommandAck,
  makeChatPage,
  makeMatchStartAck,
  protocolError,
} from './messages.ts';
import type { ChatMessage } from '../persistence/lobby-contracts.ts';
import type { MatchStartResult } from '../persistence/lobby.ts';
import type { RuntimeResult, RuntimeSnapshot } from '../runtime/runtime.ts';

const delivery = { epoch: 'server-epoch', sequence: 3 };
const requestId = id('command', 'request');

test('state and owner-history envelopes invoke only authorized projections and copy stream metadata', () => {
  const { history, seats, clock } = fixture('reveal', 4);
  const read = history.read();
  const snapshot: RuntimeSnapshot = {
    head: read.head,
    state: read.state,
    connections: [],
    paused: false,
    replacementVote: null,
    controlEvents: [],
  };
  Object.assign(snapshot, { secret: 'SECRET-SNAPSHOT' });
  Object.assign(delivery, { secret: 'SECRET-STREAM' });
  for (const viewer of [
    { type: 'public' as const },
    ...seats.map((seatId) => ({ type: 'seat' as const, seatId })),
  ]) {
    const message = makeStateMessage(snapshot, viewer, clock.now(), delivery);
    assert.deepEqual(message, {
      protocolVersion: 1,
      type: 'state',
      delivery: { epoch: 'server-epoch', sequence: 3 },
      view: projectLiveGame(snapshot, viewer, clock.now()),
    });
    assert.equal(JSON.stringify(message).includes('SECRET'), false);
  }
  const owner = { type: 'seat' as const, seatId: seats[0]! };
  assert.deepEqual(makeOwnerHistoryMessage(history.snapshot().value, owner, delivery), {
    protocolVersion: 1,
    type: 'owner-history',
    delivery: { epoch: 'server-epoch', sequence: 3 },
    view: projectOwnerHistory(history.snapshot().value, owner),
  });
  assert.throws(
    () => makeOwnerHistoryMessage(history.snapshot().value, { type: 'public' }, delivery),
    { message: 'Owner history unavailable' },
  );
  for (const invalid of [
    { epoch: '', sequence: 0 },
    { epoch: 'epoch', sequence: -1 },
    { epoch: 'epoch', sequence: NaN },
    { epoch: 'epoch', sequence: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() => makeStateMessage(snapshot, owner, clock.now(), invalid), {
      message: 'Invalid server message context',
    });
  }
});

test('fresh action envelope remains seat-private and neither duplicate nor state refresh replays a peek', () => {
  const state = scenario({ hands: [[heart(8)], [heart(9)]], stumps: [[club(7)], [club(8)]] });
  const command = {
    type: 'open-stump' as const,
    id: requestId,
    actorId: seat(0),
    cardId: cardId(state, club(7)),
  };
  const decision = decide(state, command, { nowMs: 1000, randomInt: (upper) => upper - 1 });
  if (decision.type !== 'accepted') assert.fail();
  const head = { gameId: state.gameId, branchId: id('branch', 'main'), version: 1 };
  const input = {
    before: { head, state },
    action: decision.action,
    after: { head: { ...head, version: 2 }, state: applyAction(state, decision.action) },
    delivery: 'fresh' as const,
  };
  const own = makeActionMessage(input, { type: 'seat', seatId: seat(0) }, delivery);
  assert.ok(own.view.observations.some((item) => item.type === 'stump-peeked'));
  assert.equal(
    JSON.stringify(makeActionMessage(input, { type: 'public' }, delivery)).includes(command.cardId),
    false,
  );
  assert.deepEqual(
    makeActionMessage(
      { ...input, delivery: 'duplicate' },
      { type: 'seat', seatId: seat(0) },
      delivery,
    ).view.observations,
    [],
  );
  const snapshot = {
    ...input.after,
    connections: [],
    paused: false,
    replacementVote: null,
    controlEvents: [],
  };
  assert.equal(
    JSON.stringify(
      makeStateMessage(snapshot, { type: 'seat', seatId: seat(0) }, 1000, delivery),
    ).includes('stump-peeked'),
    false,
  );
});

test('command acknowledgments allowlist outcomes, heads and codes, never raw receipts or diagnostics', () => {
  const head = { gameId: id('game', 'game'), branchId: id('branch', 'branch'), version: 8 };
  for (const result of [
    { type: 'accepted' as const, outcome: 'violation' as const, head, duplicate: false },
    { type: 'accepted' as const, outcome: 'played' as const, head, duplicate: true },
    { type: 'rejected' as const, code: 'card-not-owned' as const, head },
  ]) {
    const expected = {
      ...result,
      head: { gameId: head.gameId, branchId: head.branchId, version: head.version },
    };
    Object.assign(result, {
      secret: 'SECRET-RESULT',
      state: { secret: 'SECRET-STATE' },
      command: { actorId: 'SECRET-ACTOR' },
    });
    Object.assign(head, { secret: 'SECRET-HEAD' });
    const message = makeCommandAck(requestId, result);
    assert.deepEqual(message, {
      protocolVersion: 1,
      type: 'command-ack',
      requestId,
      result: expected,
    });
    assert.equal(JSON.stringify(message).includes('SECRET'), false);
  }
  const unknown = { type: 'rejected', code: 'SECRET-DIAGNOSTIC', head } as unknown as RuntimeResult;
  assert.deepEqual(makeCommandAck(requestId, unknown), protocolError('unavailable'));
  assert.deepEqual(protocolError('SECRET' as never), {
    protocolVersion: 1,
    type: 'error',
    code: 'unavailable',
  });
  assert.deepEqual(protocolError(new Error('SECRET') as never), {
    protocolVersion: 1,
    type: 'error',
    code: 'unavailable',
  });
});

test('chat pages preserve immutable text/context but exclude author sessions and extra properties', () => {
  const record: ChatMessage = {
    id: id('message', 'message'),
    lobbyId: id('lobby', 'lobby'),
    authorSessionId: id('session', 'SECRET-SESSION'),
    authorSeatId: null,
    text: '  exact\ntext 😀  ',
    sequence: '12',
    atMs: 1000,
    context: {
      head: { gameId: id('game', 'old-game'), branchId: id('branch', 'abandoned'), version: 7 },
      scope: 'round',
      scopeNumber: 2,
    },
  };
  Object.assign(record, { secret: 'SECRET-MESSAGE' });
  Object.assign(record.context, { secret: 'SECRET-CONTEXT' });
  const message = makeChatPage(requestId, [record]);
  assert.deepEqual(message, {
    protocolVersion: 1,
    type: 'chat-page',
    requestId,
    messages: [
      {
        id: record.id,
        lobbyId: record.lobbyId,
        authorSeatId: null,
        text: record.text,
        sequence: '12',
        atMs: 1000,
        context: { head: record.context.head, scope: 'round', scopeNumber: 2 },
      },
    ],
  });
  assert.equal(JSON.stringify(message).includes('SECRET'), false);
  assert.notEqual(message.messages[0]!.context, record.context);
  assert.notEqual(message.messages[0]!.context.head, record.context.head);
});

test('match-start acknowledgment never serializes live runtime/session or canonical private configuration', () => {
  for (const type of ['started', 'duplicate'] as const) {
    const result = {
      type,
      gameId: id('game', 'successor'),
      runtime: { secret: 'SECRET-RUNTIME' },
      session: { secret: 'SECRET-SESSION' },
      request: { cardIds: ['SECRET-CARD'], seatIds: ['SECRET-SEAT'] },
    } as unknown as MatchStartResult;
    assert.deepEqual(makeMatchStartAck(requestId, result), {
      protocolVersion: 1,
      type: 'match-start-ack',
      requestId,
      result: { type: 'started', gameId: 'successor', duplicate: type === 'duplicate' },
    });
  }
  assert.deepEqual(makeMatchStartAck(requestId, { type: 'rejected', code: 'stale-head' }), {
    protocolVersion: 1,
    type: 'match-start-ack',
    requestId,
    result: { type: 'rejected', code: 'version-conflict' },
  });
});
