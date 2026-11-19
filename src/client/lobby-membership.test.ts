import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LobbyMembershipClient, lobbyFragment, readLobbyLocator } from './lobby-membership.ts';

const member = { lobbyId: 'known-lobby', seatId: 'own-seat', position: 3, isOwner: false };
test('joining retries the exact opaque locator and returns only confirmed own membership', async () => {
  const calls: { path: string; init: RequestInit }[] = [];
  const locators: string[] = [];
  let attempt = 0;
  const client = new LobbyMembershipClient({
    fetch: async (path, init) => {
      calls.push({ path: String(path), init: init! });
      if (String(path).endsWith('/refresh')) return new Response(null, { status: 204 });
      assert.equal(locators.at(-1), 'known-lobby');
      if (attempt++ === 0) throw new Error('PRIVATE DIAGNOSTIC');
      return Response.json(member);
    },
    locate: (lobbyId) => {
      locators.push(lobbyId);
    },
    hasCreationReference: () => false,
  });
  assert.deepEqual(await client.join('known-lobby'), { type: 'error', code: 'unavailable' });
  assert.deepEqual(await client.join('known-lobby'), { type: 'joined', membership: member });
  assert.deepEqual(
    calls.map(({ path }) => path),
    [
      '/api/guest/session/refresh',
      '/api/lobbies/join',
      '/api/guest/session/refresh',
      '/api/lobbies/join',
    ],
  );
  for (const { init } of calls) {
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.redirect, 'error');
  }
  assert.equal(calls[1]!.init.body, '{"lobbyId":"known-lobby"}');
  assert.equal(calls[3]!.init.body, calls[1]!.init.body);
});

test('navigation round-trips exact nonsecret opaque targets and rejects ambiguous locators', () => {
  const id = ' lobby/#?&%+\u00e9 ';
  assert.equal(readLobbyLocator(lobbyFragment(id)), id);
  for (const hash of [
    '',
    '#seat=private',
    '#lobby=a&lobby=b',
    '#lobby=a&isOwner=true',
    '#lobby=',
    '#lobby=%00',
  ])
    assert.equal(readLobbyLocator(hash), null);
});

test('restore never issues credentials; explicit new-guest consent cannot bypass a saved creation', async () => {
  for (const [consent, saved] of [
    [false, false],
    [true, true],
  ] as const) {
    const paths: string[] = [];
    const client = new LobbyMembershipClient({
      fetch: async (path) => {
        paths.push(String(path));
        return new Response(null, { status: 401 });
      },
      locate: () => assert.fail('No admission'),
      hasCreationReference: () => saved,
    });
    assert.deepEqual(await client.join('known-lobby', consent), {
      type: 'error',
      code: 'session-unavailable',
    });
    assert.deepEqual(paths, ['/api/guest/session/refresh']);
  }
});

test('explicit fresh entry issues only after missing refresh and preserves named-cookie conflicts', async () => {
  for (const status of [204, 409, 429, 503]) {
    const paths: string[] = [];
    const client = new LobbyMembershipClient({
      fetch: async (path) => {
        paths.push(String(path));
        return String(path).endsWith('/refresh')
          ? new Response(null, { status: 401 })
          : String(path).endsWith('/join')
            ? Response.json(member)
            : new Response(null, { status });
      },
      locate: () => {},
      hasCreationReference: () => false,
    });
    assert.deepEqual(
      await client.join('known-lobby', true),
      status === 204
        ? { type: 'joined', membership: member }
        : {
            type: 'error',
            code:
              status === 409
                ? 'session-unavailable'
                : status === 429
                  ? 'rate-limited'
                  : 'unavailable',
          },
    );
    assert.equal(paths.includes('/api/lobbies/join'), status === 204);
  }
});

test('refusals are generic and invalid input/navigation failure cannot dispatch admission', async () => {
  for (const [status, code] of [
    [401, 'session-unavailable'],
    [409, 'admission-unavailable'],
    [429, 'rate-limited'],
    [503, 'unavailable'],
  ] as const) {
    const client = new LobbyMembershipClient({
      fetch: async (path) =>
        new Response(null, { status: String(path).endsWith('/refresh') ? 204 : status }),
      locate: () => {},
      hasCreationReference: () => false,
    });
    assert.deepEqual(await client.join('known-lobby'), { type: 'error', code });
  }
  let calls = 0;
  const client = new LobbyMembershipClient({
    fetch: async () => {
      calls++;
      return new Response(null, { status: 204 });
    },
    locate: () => {
      throw Error('PRIVATE NAVIGATION');
    },
    hasCreationReference: () => false,
  });
  for (const id of ['', ' ', '\0', '\ud800', 'x'.repeat(257)])
    assert.deepEqual(await client.join(id), { type: 'error', code: 'invalid-locator' });
  assert.equal(calls, 0);
  assert.deepEqual(await client.join('known-lobby'), {
    type: 'error',
    code: 'locator-unavailable',
  });
  assert.equal(calls, 1);
});

test('untrusted responses cannot substitute target, seat ordering, owner authority or private fields', async () => {
  for (const value of [
    null,
    [],
    { ...member, lobbyId: 'another-lobby' },
    { ...member, position: -1 },
    { ...member, position: 8 },
    { ...member, position: 0.5 },
    { ...member, isOwner: 'false' },
    { ...member, isOwner: true },
    { ...member, seatId: '\ud800' },
    { ...member, sessionId: 'PRIVATE' },
  ]) {
    const client = new LobbyMembershipClient({
      fetch: async (path) =>
        String(path).endsWith('/refresh')
          ? new Response(null, { status: 204 })
          : Response.json(value),
      locate: () => {},
      hasCreationReference: () => false,
    });
    assert.deepEqual(await client.join('known-lobby'), { type: 'error', code: 'invalid-response' });
  }
});

test('concurrent submissions coalesce without retargeting the in-flight lobby', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const targets: string[] = [];
  const client = new LobbyMembershipClient({
    fetch: async (path) => {
      if (String(path).endsWith('/refresh')) {
        await gate;
        return new Response(null, { status: 204 });
      }
      return Response.json(member);
    },
    locate: (id) => {
      targets.push(id);
    },
    hasCreationReference: () => false,
  });
  const first = client.join('known-lobby');
  const second = client.join('other-lobby', true);
  assert.equal(first, second);
  release();
  assert.equal((await first).type, 'joined');
  assert.deepEqual(targets, ['known-lobby']);
});
