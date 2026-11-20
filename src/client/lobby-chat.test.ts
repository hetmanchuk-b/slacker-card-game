import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LobbyChat } from './lobby-chat.ts';
const row = (sequence = '1') => ({
  id: `message-${sequence}`,
  lobbyId: 'lobby',
  authorSeatId: 'seat',
  text: ' <img src=x>\r\n 😀 ',
  sequence,
  atMs: 1000,
  context: { head: null, scope: 'lobby', scopeNumber: null },
});
function fixture() {
  let id = 0;
  const chat = new LobbyChat('lobby', 'seat', () => `id-${++id}`);
  return {
    chat,
    reply: (requestId: string, messages: object[]) => ({
      protocolVersion: 1,
      type: 'chat-page',
      requestId,
      messages,
    }),
  };
}
test('uncertain post freezes exact text/message ID while correlation IDs change; history cursor is independent', () => {
  const { chat, reply } = fixture();
  const first = chat.post(' <img src=x>\r\n 😀 ')!;
  chat.interrupt();
  assert.equal(chat.post('changed'), null);
  const retry = chat.retry()!;
  assert.deepEqual(retry.intent, first.intent);
  assert.notEqual(retry.requestId, first.requestId);
  const message = { ...row('9007199254740993'), id: first.intent.messageId };
  assert.equal(chat.receive(reply(retry.requestId, [message])), 'accepted');
  assert.equal(chat.current.cursor, '0');
  const read = chat.read()!;
  assert.equal(read.intent.afterSequence, '0');
  assert.equal(
    chat.receive(reply(read.requestId, [row('2'), row('9007199254740994')])),
    'accepted',
  );
  assert.equal(chat.current.cursor, '9007199254740994');
  assert.equal(chat.current.empty, false);
  const next = chat.read()!;
  assert.equal(next.intent.afterSequence, '9007199254740994');
  chat.receive(reply(next.requestId, []));
  assert.equal(chat.current.empty, true);
});
test('strict replies reject privacy fields, altered posts, wrong lobby, invalid sequences/context and unordered pages', () => {
  for (const change of [
    (r: ReturnType<typeof row>) => Object.assign(r, { authorSessionId: 'PRIVATE' }),
    (r: ReturnType<typeof row>) => {
      r.lobbyId = 'other';
    },
    (r: ReturnType<typeof row>) => {
      r.sequence = '01';
    },
    (r: ReturnType<typeof row>) =>
      Object.assign(r.context, { head: null, scope: 'round', scopeNumber: 1 }),
    (r: ReturnType<typeof row>) => {
      r.text = '\0';
    },
  ]) {
    const { chat, reply } = fixture();
    const read = chat.read()!;
    const value = row();
    change(value);
    assert.equal(chat.receive(reply(read.requestId, [value])), 'invalid');
    assert.deepEqual(chat.current.page, []);
  }
  const { chat, reply } = fixture();
  const read = chat.read()!;
  assert.equal(chat.receive(reply(read.requestId, [row('2'), row('1')])), 'invalid');
});
test('late replies are ignored after interruption; identical post retry retains original context and no private payload', () => {
  const { chat, reply } = fixture();
  const read = chat.read()!;
  chat.interrupt();
  assert.equal(chat.receive(reply(read.requestId, [row()])), 'ignored');
  const post = chat.post('hello')!;
  const value = { ...row(), id: post.intent.messageId, text: 'different' };
  assert.equal(chat.receive(reply(post.requestId, [value])), 'invalid');
  assert.equal(chat.current.retry, true);
  assert.equal(JSON.stringify(chat.current).includes('different'), false);
  assert.equal(chat.post(''), null);
  assert.equal(chat.post('\ud800'), null);
});
