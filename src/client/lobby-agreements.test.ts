import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LobbyMembership } from '../protocol/lobby.ts';
import { LobbyAgreementsClient, validAgreementText } from './lobby-agreements.ts';

const membership = {
  lobbyId: 'opaque-lobby',
  seatId: 'own-seat',
  position: 0,
  isOwner: true,
} as LobbyMembership;
const view = {
  lobbyId: membership.lobbyId,
  revision: '4',
  text: '  Exact\r\ntext 🂡\n',
  editable: true,
  members: [{ seatId: 'own-seat', position: 0, ready: false }],
  matchAgreements: null,
};
test('explicit workflow reads and edits preserve exact text and the observed acceptance epoch', async () => {
  const calls: { path: string; init: RequestInit }[] = [];
  const client = new LobbyAgreementsClient({
    membership,
    fetch: async (path, init) => {
      calls.push({ path: String(path), init: init! });
      return Response.json(view);
    },
  });
  assert.deepEqual(await client.read(), { type: 'confirmed', view });
  assert.deepEqual(await client.edit('4', view.text), { type: 'confirmed', view });
  assert.deepEqual(
    calls.map(({ path }) => path),
    ['/api/lobbies/state', '/api/lobbies/agreements'],
  );
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), {
    lobbyId: 'opaque-lobby',
    expectedRevision: '4',
    text: view.text,
  });
  for (const { init } of calls) {
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
  }
});

test('explicit reads install changed acceptance flags at the same epoch', async () => {
  let ready = false;
  const client = new LobbyAgreementsClient({
    membership,
    fetch: async () => Response.json({ ...view, members: [{ ...view.members[0], ready }] }),
  });
  const first = await client.read();
  ready = true;
  const second = await client.read();
  assert.equal(first.type === 'confirmed' && first.view.members[0]!.ready, false);
  assert.equal(second.type === 'confirmed' && second.view.members[0]!.ready, true);
  assert.equal(second.type === 'confirmed' && second.view.revision, '4');
});

test('uncertain mutations and stale CAS never trigger retries, refreshes or retargeted changes', async () => {
  const bodies: unknown[] = [];
  let status = 409;
  const client = new LobbyAgreementsClient({
    membership,
    fetch: async (_path, init) => {
      bodies.push(JSON.parse(String(init!.body)));
      if (status === 0) throw Error('PRIVATE SQL/TOKEN');
      return new Response('PRIVATE SQL/TOKEN', { status });
    },
  });
  assert.deepEqual(await client.edit('4', 'exact draft'), { type: 'error', code: 'conflict' });
  status = 0;
  assert.deepEqual(await client.accept('4', true), { type: 'error', code: 'unavailable' });
  assert.deepEqual(bodies, [
    { lobbyId: membership.lobbyId, expectedRevision: '4', text: 'exact draft' },
    { lobbyId: membership.lobbyId, expectedRevision: '4', ready: true },
  ]);
});

test('nested allowlists reject private fields, wrong viewers, malformed epochs and inconsistent rosters', async () => {
  const member = view.members[0]!;
  const match = { gameId: 'opaque-game', revision: '3', text: 'original\r\n' };
  for (const value of [
    null,
    [],
    { ...view, lobbyId: 'other' },
    { ...view, sessionId: 'PRIVATE' },
    { ...view, editable: 1 },
    { ...view, revision: '04' },
    { ...view, revision: '9223372036854775808' },
    { ...view, text: '\ud800' },
    { ...view, members: [] },
    { ...view, members: [{ ...member, seatId: 'other' }] },
    { ...view, members: [{ ...member, position: 0.5 }] },
    { ...view, members: [{ ...member, ready: 'true' }] },
    { ...view, members: [member, { ...member, position: 1 }] },
    { ...view, members: [{ ...member, cards: ['PRIVATE'] }] },
    { ...view, matchAgreements: { ...match, state: 'PRIVATE' } },
    { ...view, matchAgreements: { ...match, gameId: '\0' } },
  ]) {
    const client = new LobbyAgreementsClient({
      membership,
      fetch: async () => Response.json(value),
    });
    assert.deepEqual(await client.read(), { type: 'error', code: 'invalid-response' });
  }
  const client = new LobbyAgreementsClient({
    membership,
    fetch: async () => Response.json({ ...view, matchAgreements: match }),
  });
  assert.deepEqual(await client.read(), {
    type: 'confirmed',
    view: { ...view, matchAgreements: match },
  });
});

test('input limits use UTF-8 bytes and canonical bigint epochs; member editing is never offered as authority', async () => {
  for (const text of ['', 'x'.repeat(4096), '🂡'.repeat(1024)])
    assert.equal(validAgreementText(text), true);
  for (const text of ['x'.repeat(4097), '🂡'.repeat(1025), '\0', '\ud800'])
    assert.equal(validAgreementText(text), false);
  let calls = 0;
  const client = new LobbyAgreementsClient({
    membership,
    fetch: async () => {
      calls++;
      return Response.json(view);
    },
  });
  for (const revision of ['01', '-1', '1e2', '9223372036854775808'])
    assert.deepEqual(await client.edit(revision, ''), { type: 'error', code: 'invalid-input' });
  assert.deepEqual(await client.edit('4', '🂡'.repeat(1025)), {
    type: 'error',
    code: 'invalid-input',
  });
  assert.equal(calls, 0);
  assert.equal((await client.edit('9223372036854775807', '')).type, 'confirmed');
  const member = new LobbyAgreementsClient({
    membership: { ...membership, isOwner: false },
    fetch: async () => assert.fail('No owner mutation'),
  });
  assert.deepEqual(await member.edit('4', ''), { type: 'error', code: 'unauthorized' });
});

test('pending operations reject overlapping intents rather than queueing or retargeting them', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bodies: unknown[] = [];
  const client = new LobbyAgreementsClient({
    membership,
    fetch: async (_path, init) => {
      bodies.push(JSON.parse(String(init!.body)));
      await gate;
      return Response.json(view);
    },
  });
  const pending = client.read();
  assert.deepEqual(await client.accept('4', true), { type: 'error', code: 'busy' });
  assert.deepEqual(await client.edit('4', 'not queued'), { type: 'error', code: 'busy' });
  release();
  assert.equal((await pending).type, 'confirmed');
  assert.deepEqual(bodies, [{ lobbyId: membership.lobbyId }]);
});

test('status and malformed-response failures stay fixed and never issue guest credentials', async () => {
  for (const [status, code] of [
    [400, 'unavailable'],
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [409, 'conflict'],
    [429, 'rate-limited'],
    [503, 'unavailable'],
  ] as const) {
    const client = new LobbyAgreementsClient({
      membership,
      fetch: async (path) => {
        assert.equal(path, '/api/lobbies/state');
        return new Response('PRIVATE', { status });
      },
    });
    assert.deepEqual(await client.read(), { type: 'error', code });
  }
  const client = new LobbyAgreementsClient({
    membership,
    fetch: async () => new Response('PRIVATE invalid JSON'),
  });
  assert.deepEqual(await client.read(), { type: 'error', code: 'invalid-response' });
});
