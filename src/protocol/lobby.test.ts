import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeLobbyRequest, lobbyMembership } from './lobby.ts';
import { id } from '../game/ids.ts';

test('lobby HTTP bodies accept only exact bounded data, without client authority', () => {
  assert.deepEqual(decodeLobbyRequest({ requestId: ' original ' }, 'create'), {
    requestId: ' original ',
  });
  assert.deepEqual(decodeLobbyRequest({ lobbyId: 'opaque' }, 'join'), { lobbyId: 'opaque' });
  const invalid: unknown[] = [
    null,
    [],
    'value',
    {},
    { requestId: '' },
    { requestId: ' ' },
    { requestId: 1 },
    { requestId: 'x'.repeat(129) },
    { requestId: '\ud800' },
    { requestId: 'a\0b' },
    { requestId: 'key', ownerId: 'forged' },
    Object.create({ requestId: 'inherited' }),
    Object.defineProperty({}, 'requestId', {
      get() {
        throw new Error('must not read');
      },
    }),
  ];
  for (const value of invalid) assert.equal(decodeLobbyRequest(value, 'create'), null);
  for (const value of [
    { lobbyId: 'x'.repeat(257) },
    { lobbyId: 'lobby', seatId: 'forged' },
    { requestId: 'x' },
  ])
    assert.equal(decodeLobbyRequest(value, 'join'), null);
  assert.ok(decodeLobbyRequest({ requestId: 'x'.repeat(128) }, 'create'));
  assert.ok(decodeLobbyRequest({ lobbyId: 'x'.repeat(256) }, 'join'));
});

test('lobby response allowlists own membership identity, never private bindings', () => {
  const binding = {
    lobbyId: id('lobby', 'opaque-lobby'),
    seatId: id('seat', 'own-seat'),
    position: 0,
    isOwner: true,
    sessionId: 'SECRET',
    expiresAtMs: 123,
    seatIds: ['OTHER'],
    currentGameId: 'GAME',
    extra: 'PRIVATE',
  };
  assert.deepEqual(lobbyMembership(binding), {
    lobbyId: 'opaque-lobby',
    seatId: 'own-seat',
    position: 0,
    isOwner: true,
  });
});
