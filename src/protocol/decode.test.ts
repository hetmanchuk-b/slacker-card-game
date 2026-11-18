import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeClientMessage } from './decode.ts';
import { PROTOCOL_LIMITS } from './contracts.ts';

const route = { gameId: 'game-1', branchId: 'branch-1' };
const wire = (intent: unknown) => ({ protocolVersion: 1, requestId: 'request-1', intent });
const validIntents = [
  { type: 'draw-card', ...route },
  { type: 'take-bottom', ...route },
  { type: 'play-card', ...route, cardId: 'opaque-card' },
  { type: 'open-stump', ...route, cardId: 'opaque-stump' },
  { type: 'penalty-response', ...route, procedureId: 'exact-timer', cardId: null },
  { type: 'penalty-response', ...route, procedureId: 'exact-timer', cardId: 'opaque-card' },
  { type: 'cast-vote', ...route, procedureId: 'exact-timer', vote: 'yes' },
  { type: 'request-withdrawal', ...route, claimId: 'exact-claim' },
  { type: 'withdrawal-response', ...route, procedureId: 'exact-timer', approve: false },
  { type: 'propose-bot', ...route, absentSeatId: '__proto__' },
  { type: 'replacement-vote', ...route, procedureId: 'exact-timer', vote: 'abstain' },
  {
    type: 'submit-claim',
    ...route,
    accusedId: 'seat-2',
    reason: '  exact reason  ',
    evidence: { type: 'spoken', key: 'episode' },
  },
  {
    type: 'submit-claim',
    ...route,
    accusedId: 'seat-2',
    reason: 'chat',
    evidence: { type: 'chat', messageId: 'message-1' },
  },
  {
    type: 'submit-claim',
    ...route,
    accusedId: 'seat-2',
    reason: 'action',
    evidence: { type: 'action', commandId: 'original-action' },
  },
  {
    type: 'rollback',
    target: { expected: { gameId: 'game-1', branch: 2, version: 4 }, beforeActionVersion: 3 },
    knowledgeWarningAcknowledged: true,
  },
  { type: 'owner-history', gameId: 'game-1' },
  { type: 'resync', lobbyId: 'lobby-1' },
  { type: 'post-chat', lobbyId: 'lobby-1', messageId: 'message-1', text: '  exact\ntext 😀  ' },
  { type: 'chat-history', lobbyId: 'lobby-1', afterSequence: '9223372036854775807', limit: 100 },
  { type: 'start-match', lobbyId: 'lobby-1', expected: null },
  { type: 'start-match', lobbyId: 'lobby-1', expected: { ...route, version: 42 } },
];

test('each explicit external intent decodes without coercion, mutation or loss of retry identity', () => {
  for (const intent of validIntents) {
    const input = wire(intent);
    const before = structuredClone(input);
    const result = decodeClientMessage(input);
    assert.deepEqual(result, { type: 'decoded', message: input });
    assert.deepEqual(input, before);
    if (result.type !== 'decoded') assert.fail();
    assert.notEqual(result.message, input);
    assert.notEqual(result.message.intent, intent);
    assert.deepEqual(decodeClientMessage(input), result);
  }
});

test('unknown/system commands and forged authority are rejected instead of stripped or dispatched', () => {
  for (const type of [
    'start-game',
    'expire-reveal',
    'expire-claim-vote',
    'expire-withdrawal',
    'expire-penalty',
    'suspend-clock',
    'resume-clock',
    'disconnect',
    'reconnect',
    'handoff',
    'SECRET-UNKNOWN',
  ]) {
    assert.deepEqual(decodeClientMessage(wire({ type, ...route })), {
      type: 'rejected',
      code: 'invalid-message',
    });
  }
  for (const key of [
    'actorId',
    'ownerId',
    'authorSessionId',
    'controller',
    'sessionId',
    'nowMs',
    'randomInt',
    'cards',
    'state',
    'scope',
    'scopeNumber',
    'version',
  ]) {
    assert.deepEqual(decodeClientMessage(wire({ type: 'draw-card', ...route, [key]: 'SECRET' })), {
      type: 'rejected',
      code: 'invalid-message',
    });
    assert.deepEqual(decodeClientMessage({ ...wire(validIntents[0]), [key]: 'SECRET' }), {
      type: 'rejected',
      code: 'invalid-message',
    });
  }
});

test('malformed values, missing fields, unsafe numbers and wrong enum/boolean/null values fail technically', () => {
  const invalid = [
    null,
    [],
    'SECRET',
    42,
    true,
    {},
    { ...wire(validIntents[0]), requestId: '' },
    { ...wire(validIntents[0]), requestId: '   ' },
    { ...wire(validIntents[0]), protocolVersion: '1' },
    wire({ type: 'penalty-response', ...route, procedureId: 'timer' }),
    wire({ type: 'penalty-response', ...route, procedureId: 'timer', cardId: false }),
    wire({ type: 'cast-vote', ...route, procedureId: 'timer', vote: 'YES' }),
    wire({ type: 'withdrawal-response', ...route, procedureId: 'timer', approve: 'false' }),
    wire({ type: 'start-match', lobbyId: 'lobby', expected: { ...route, version: NaN } }),
    wire({ type: 'start-match', lobbyId: 'lobby', expected: { ...route, version: Infinity } }),
    wire({
      type: 'start-match',
      lobbyId: 'lobby',
      expected: { ...route, version: Number.MAX_SAFE_INTEGER + 1 },
    }),
    wire({ type: 'start-match', lobbyId: 'lobby', expected: { ...route, version: -1 } }),
    wire({
      type: 'chat-history',
      lobbyId: 'lobby',
      afterSequence: '9223372036854775808',
      limit: 100,
    }),
    wire({ type: 'chat-history', lobbyId: 'lobby', afterSequence: '-1', limit: 100 }),
    wire({ type: 'chat-history', lobbyId: 'lobby', afterSequence: '1', limit: 0 }),
    wire({ type: 'chat-history', lobbyId: 'lobby', afterSequence: '1', limit: 101 }),
  ];
  for (const input of invalid)
    assert.deepEqual(decodeClientMessage(input), { type: 'rejected', code: 'invalid-message' });
  assert.deepEqual(decodeClientMessage({ ...wire(validIntents[0]), protocolVersion: 2 }), {
    type: 'rejected',
    code: 'unsupported-version',
  });
});

test('claims remain unresolved references, never client-authored canonical evidence/scope', () => {
  const claim = validIntents[11]!;
  for (const extra of [
    { scope: 'round' },
    { scopeNumber: 1 },
    { actorId: 'other' },
    { incident: { type: 'spoken', key: 'other' } },
  ]) {
    assert.equal(decodeClientMessage(wire({ ...claim, ...extra })).type, 'rejected');
  }
  for (const evidence of [
    { type: 'spoken', key: 'episode', scope: 'round' },
    { type: 'chat', messageId: 'm', authorSeatId: 'other' },
    { type: 'action', commandId: 'c', head: route },
    { type: 'action', commandId: '' },
  ])
    assert.equal(decodeClientMessage(wire({ ...claim, evidence })).type, 'rejected');
});

test('rollback uses positive display ordinals and exact observed versions, never raw command selectors', () => {
  const base = {
    type: 'rollback',
    target: { expected: { gameId: 'game', branch: 1, version: 4 }, beforeActionVersion: 2 },
    knowledgeWarningAcknowledged: false,
  };
  assert.equal(
    decodeClientMessage(wire(base)).type,
    'decoded',
    'false acknowledgment is a later business rejection',
  );
  for (const target of [
    { expected: { gameId: 'game', branch: 0, version: 4 }, beforeActionVersion: 2 },
    { expected: { gameId: 'game', branch: 1, version: 4 }, beforeActionVersion: 0 },
    { expected: { gameId: 'game', branch: 1, version: 4 }, beforeActionVersion: 5 },
    { expected: { ...route, version: 4 }, beforeActionVersion: 2 },
    { expected: base.target.expected, beforeCommandId: 'SECRET-COMMAND' },
    { expected: { ...base.target.expected, actorId: 'forged' }, beforeActionVersion: 2 },
  ])
    assert.equal(decodeClientMessage(wire({ ...base, target })).type, 'rejected');
});

test('technical string limits preserve exact valid text and reject NUL or malformed Unicode', () => {
  const chat = { type: 'post-chat', lobbyId: 'lobby', messageId: 'message', text: ' ' };
  assert.equal(
    decodeClientMessage(wire(chat)).type,
    'decoded',
    'whitespace chat is valid verbatim storage text',
  );
  for (const text of ['', '\0', '\ud800', '\udfff', 'x'.repeat(PROTOCOL_LIMITS.text + 1)]) {
    assert.equal(decodeClientMessage(wire({ ...chat, text })).type, 'rejected');
  }
  assert.equal(
    decodeClientMessage(wire({ ...chat, text: 'x'.repeat(PROTOCOL_LIMITS.text) })).type,
    'decoded',
  );
  for (const requestId of ['\0', '\ud800', 'x'.repeat(PROTOCOL_LIMITS.requestId + 1)]) {
    assert.equal(decodeClientMessage({ ...wire(chat), requestId }).type, 'rejected');
  }
  assert.equal(
    decodeClientMessage(
      wire({ type: 'play-card', ...route, cardId: 'x'.repeat(PROTOCOL_LIMITS.reference + 1) }),
    ).type,
    'rejected',
  );
  assert.equal(decodeClientMessage(wire({ ...validIntents[11], reason: '   ' })).type, 'rejected');
});

test('exact own data fields reject prototype pollution, symbols, accessors and exotic objects without invoking getters', () => {
  let reads = 0;
  const accessor = { ...wire(validIntents[0]) };
  Object.defineProperty(accessor, 'intent', {
    get() {
      reads++;
      throw new Error('SECRET');
    },
    enumerable: true,
  });
  const symbol = { ...wire(validIntents[0]), [Symbol('SECRET')]: true };
  const inherited = Object.create(wire(validIntents[0]));
  const pollution = JSON.parse(
    '{"protocolVersion":1,"requestId":"request","intent":{"type":"draw-card","gameId":"game","branchId":"branch","__proto__":{"actorId":"forged"}}}',
  );
  for (const input of [accessor, symbol, inherited, pollution, new Date(), new Error('SECRET')]) {
    assert.deepEqual(decodeClientMessage(input), { type: 'rejected', code: 'invalid-message' });
  }
  assert.equal(reads, 0);
  const nullPrototype = Object.assign(
    Object.create(null),
    wire({ type: 'propose-bot', ...route, absentSeatId: 'constructor' }),
  );
  assert.equal(decodeClientMessage(nullPrototype).type, 'decoded');
});

test('action evidence uses reference bounds while new request IDs retain their separate limit', () => {
  for (const length of [129, PROTOCOL_LIMITS.reference]) {
    const intent = {
      ...validIntents[11],
      evidence: { type: 'action', commandId: 'x'.repeat(length) },
    };
    assert.equal(decodeClientMessage(wire(intent)).type, 'decoded');
  }
  const tooLong = {
    ...validIntents[11],
    evidence: { type: 'action', commandId: 'x'.repeat(PROTOCOL_LIMITS.reference + 1) },
  };
  assert.deepEqual(decodeClientMessage(wire(tooLong)), {
    type: 'rejected',
    code: 'invalid-message',
  });
  const valid = wire(validIntents[0]);
  assert.equal(
    decodeClientMessage({ ...valid, requestId: 'r'.repeat(PROTOCOL_LIMITS.requestId) }).type,
    'decoded',
  );
  assert.equal(
    decodeClientMessage({ ...valid, requestId: 'r'.repeat(PROTOCOL_LIMITS.requestId + 1) }).type,
    'rejected',
  );
});

test('nested references and heads are detached without canonicalizing caller text or IDs', () => {
  for (const value of [validIntents[11]!, validIntents[14]!, validIntents[20]!]) {
    const mutable = structuredClone(value);
    const result = decodeClientMessage(wire(mutable));
    if (result.type !== 'decoded') assert.fail();
    const before = structuredClone(result.message);
    Object.assign(mutable, { type: 'changed' });
    if ('evidence' in mutable && mutable.evidence)
      Object.assign(mutable.evidence, { key: 'changed' });
    if (mutable.target) Object.assign(mutable.target.expected, { version: 999 });
    if (mutable.expected) Object.assign(mutable.expected, { version: 999 });
    assert.deepEqual(result.message, before);
  }
});
