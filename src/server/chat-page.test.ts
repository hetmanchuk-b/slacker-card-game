import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id } from '../game/ids.ts';
import type { ChatMessage } from '../persistence/lobby-contracts.ts';
import { boundedChatPage } from './chat-page.ts';

const requestId = id('command', 'request');
function row(sequence: string, text = '\n'.repeat(200)): ChatMessage {
  return {
    id: id('message', `message-${sequence}`),
    lobbyId: id('lobby', 'lobby'),
    authorSessionId: id('session', 'PRIVATE'),
    authorSeatId: id('seat', 'seat'),
    text,
    sequence,
    atMs: 1000,
    context: { head: null, scope: 'lobby', scopeNumber: null },
  };
}
test('chat pages return an ordered byte-bounded prefix without truncating text or exposing private author sessions', () => {
  const messages = [row('2'), row('9')];
  const page = boundedChatPage(requestId, messages, 1024);
  assert.deepEqual(
    page.messages.map((message) => message.sequence),
    ['2'],
  );
  assert.equal(page.messages[0]!.text, messages[0]!.text);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) + 128 <= 1024);
  assert.equal(JSON.stringify(page).includes('PRIVATE'), false);
  const next = boundedChatPage(requestId, messages.slice(1), 1024);
  assert.deepEqual(
    next.messages.map((message) => message.sequence),
    ['9'],
  );
  assert.deepEqual(boundedChatPage(requestId, [], 1024).messages, []);
});
test('individually oversized trusted rows fail rather than truncate, skip or produce an endless empty page', () => {
  const oversized = row('9', 'SECRET'.repeat(2000));
  assert.throws(() => boundedChatPage(requestId, [oversized], 1024), {
    message: 'Chat page unavailable',
  });
  assert.deepEqual(
    boundedChatPage(requestId, [row('2'), oversized], 1024).messages.map(
      (message) => message.sequence,
    ),
    ['2'],
  );
});
