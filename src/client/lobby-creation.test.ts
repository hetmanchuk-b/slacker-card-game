import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CREATION_REFERENCE, LobbyCreation } from './lobby-creation.ts';

const membership = { lobbyId: 'lobby', seatId: 'seat', position: 0, isOwner: true };

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test('uncertain creation retries retain the exact request key across a new client instance', async () => {
  const saved = storage();
  const keys: unknown[] = [];
  let fail = true;
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    if (input === '/api/guest/session/refresh') return new Response(null, { status: 204 });
    assert.equal(input, '/api/lobbies');
    keys.push(JSON.parse(String(init?.body)).requestId);
    if (fail) throw new Error('PRIVATE NETWORK DIAGNOSTIC');
    return Response.json({
      lobbyId: 'opaque-lobby',
      seatId: 'opaque-seat',
      position: 0,
      isOwner: true,
    });
  };
  const first = new LobbyCreation({
    fetch: fetcher,
    storage: saved,
    requestId: () => 'stable-creation',
  });
  assert.deepEqual(await first.create(), { type: 'error', code: 'unavailable' });
  fail = false;
  const reloaded = new LobbyCreation({
    fetch: fetcher,
    storage: saved,
    requestId: () => 'must-not-generate-another-key',
  });
  assert.deepEqual(await reloaded.create(), {
    type: 'created',
    membership: { lobbyId: 'opaque-lobby', seatId: 'opaque-seat', position: 0, isOwner: true },
  });
  assert.deepEqual(keys, ['stable-creation', 'stable-creation']);
  assert.deepEqual(JSON.parse(saved.getItem(CREATION_REFERENCE)!), {
    version: 1,
    requestId: 'stable-creation',
  });
});

test('fresh guests refresh then issue only when absent; expired named cookies are never replaced', async () => {
  for (const issueStatus of [204, 409, 429, 503]) {
    const paths: unknown[] = [];
    const client = new LobbyCreation({
      storage: storage(),
      requestId: () => 'key',
      fetch: async (path, init) => {
        paths.push(path);
        if (path === '/api/guest/session/refresh') {
          assert.equal(init?.body, undefined);
          return new Response(null, { status: 401 });
        }
        if (path === '/api/guest/session') {
          assert.equal(init?.body, undefined);
          return new Response(null, { status: issueStatus });
        }
        return Response.json(membership);
      },
    });
    const result = await client.create();
    assert.deepEqual(
      paths,
      issueStatus === 204
        ? ['/api/guest/session/refresh', '/api/guest/session', '/api/lobbies']
        : ['/api/guest/session/refresh', '/api/guest/session'],
    );
    assert.equal(result.type, issueStatus === 204 ? 'created' : 'error');
    if (result.type === 'error')
      assert.equal(
        result.code,
        issueStatus === 409
          ? 'session-unavailable'
          : issueStatus === 429
            ? 'rate-limited'
            : 'unavailable',
      );
  }
});

test('a saved uncertain request requires its original session and never issues another guest', async () => {
  const saved = storage();
  saved.setItem(CREATION_REFERENCE, JSON.stringify({ version: 1, requestId: 'original' }));
  const paths: unknown[] = [];
  const client = new LobbyCreation({
    storage: saved,
    requestId: () => 'not-used',
    fetch: async (path) => {
      paths.push(path);
      return new Response(null, { status: 401 });
    },
  });
  assert.deepEqual(await client.create(), { type: 'error', code: 'session-unavailable' });
  assert.deepEqual(paths, ['/api/guest/session/refresh']);
});

test('single-flight creation sends one operation for concurrent submissions', async () => {
  const release = Promise.withResolvers<Response>();
  let posts = 0;
  const client = new LobbyCreation({
    storage: storage(),
    requestId: () => 'key',
    fetch: async (path) => {
      if (path === '/api/guest/session/refresh') return new Response(null, { status: 204 });
      posts++;
      return release.promise;
    },
  });
  const first = client.create();
  const duplicate = client.create();
  assert.equal(first, duplicate);
  release.resolve(Response.json(membership));
  assert.equal((await first).type, 'created');
  assert.equal(posts, 1);
});

test('unreadable references and unavailable storage fail safely without creating a lobby', async () => {
  const saved = storage();
  const never: typeof fetch = async () => {
    assert.fail('must not send');
  };
  for (const invalid of [
    '{',
    '{"version":2,"requestId":"key"}',
    '{"version":1,"requestId":"key","token":"PRIVATE"}',
  ]) {
    saved.setItem(CREATION_REFERENCE, invalid);
    const client = new LobbyCreation({ storage: saved, requestId: () => 'key', fetch: never });
    assert.deepEqual(await client.create(), { type: 'error', code: 'invalid-reference' });
  }
  const client = new LobbyCreation({
    storage: {
      getItem() {
        throw new Error('PRIVATE');
      },
      setItem() {},
    },
    requestId: () => 'key',
    fetch: never,
  });
  assert.deepEqual(await client.create(), { type: 'error', code: 'storage-unavailable' });
  const writes: unknown[] = [];
  const blocked = new LobbyCreation({
    storage: {
      getItem: () => null,
      setItem() {
        throw new Error('quota');
      },
    },
    requestId: () => 'key',
    fetch: async (path) => {
      writes.push(path);
      return new Response(null, { status: 204 });
    },
  });
  assert.deepEqual(await blocked.create(), { type: 'error', code: 'storage-unavailable' });
  assert.deepEqual(writes, ['/api/guest/session/refresh']);
});

test('untrusted success data and technical failures never disclose diagnostics or generate a new key', async () => {
  for (const value of [
    null,
    { ...membership, sessionId: 'PRIVATE' },
    { ...membership, isOwner: false },
    { ...membership, position: 1 },
    { ...membership, seatId: '\ud800' },
  ]) {
    const saved = storage();
    const client = new LobbyCreation({
      storage: saved,
      requestId: () => 'key',
      fetch: async (path) =>
        path === '/api/guest/session/refresh'
          ? new Response(null, { status: 204 })
          : Response.json(value),
    });
    assert.deepEqual(await client.create(), { type: 'error', code: 'invalid-response' });
    assert.equal(JSON.parse(saved.getItem(CREATION_REFERENCE)!).requestId, 'key');
  }
});
