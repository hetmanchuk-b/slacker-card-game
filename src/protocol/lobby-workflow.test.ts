import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeWorkflow, lobbyWorkflow, validAgreements } from './lobby-workflow.ts';
import { id } from '../game/ids.ts';

test('workflow decoding has exact authority-free shapes, bounded text and canonical epochs', () => {
  assert.deepEqual(
    decodeWorkflow({ lobbyId: 'opaque', expectedRevision: '0', ready: true }, 'ready'),
    { type: 'ready', lobbyId: 'opaque', expectedRevision: '0', ready: true },
  );
  for (const revision of ['01', '-1', '1.0', '9223372036854775808', 0])
    assert.equal(
      decodeWorkflow({ lobbyId: 'lobby', expectedRevision: revision, ready: true }, 'ready'),
      null,
    );
  for (const value of [
    null,
    [],
    { lobbyId: 'lobby', seatId: 'forged' },
    Object.create({ lobbyId: 'lobby' }),
    Object.defineProperty({}, 'lobbyId', {
      get() {
        throw new Error('must not read');
      },
    }),
  ])
    assert.equal(decodeWorkflow(value, 'state'), null);
  assert.equal(validAgreements(''), true);
  assert.equal(validAgreements('é'.repeat(2048)), true);
  assert.equal(validAgreements('é'.repeat(2049)), false);
  assert.equal(validAgreements('\ud800'), false);
  assert.equal(validAgreements('a\0b'), false);
  assert.equal(
    decodeWorkflow({ lobbyId: 'lobby', expectedRevision: '0', ready: 'true' }, 'ready'),
    null,
  );
  assert.deepEqual(
    decodeWorkflow({ lobbyId: 'lobby', expectedRevision: '1', text: ' verbatim\n ' }, 'agreements'),
    { type: 'agreements', lobbyId: 'lobby', expectedRevision: '1', text: ' verbatim\n ' },
  );
});

test('workflow response is a detached allowlist without credential or game state', () => {
  const value = {
    lobbyId: id('lobby', 'lobby'),
    revision: '1',
    text: '',
    editable: true,
    members: [{ seatId: id('seat', 'seat'), position: 0, ready: false, sessionId: 'PRIVATE' }],
    matchAgreements: {
      gameId: id('game', 'game'),
      revision: '0',
      text: 'original',
      state: 'PRIVATE',
    },
    sessionId: 'PRIVATE',
  };
  const view = lobbyWorkflow(value);
  assert.equal(JSON.stringify(view).includes('PRIVATE'), false);
  assert.notEqual(view.members, value.members);
  assert.deepEqual(Object.keys(view).sort(), [
    'editable',
    'lobbyId',
    'matchAgreements',
    'members',
    'revision',
    'text',
  ]);
});
