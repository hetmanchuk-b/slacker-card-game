import { useEffect, useId, useState } from 'react';
import type { GameConnection, ConnectionState } from './game-connection.ts';
import { chatText } from './lobby-chat.ts';
import type { ChatRow } from './lobby-chat.ts';
function Message({ message }: Readonly<{ message: ChatRow }>) {
  return (
    <li data-testid="chat-message">
      <p className="reference">
        Author: {message.authorSeatId ?? 'Legacy author'}; sequence {message.sequence}; message{' '}
        {message.id}; original time {message.atMs}.
      </p>
      <p className="agreement-text" data-testid="chat-text">
        {message.text}
      </p>
      <p className="reference" data-testid="chat-context">
        Original context: {message.context.scope}
        {message.context.scopeNumber === null ? '' : ` ${message.context.scopeNumber}`};{' '}
        {message.context.head
          ? `game ${message.context.head.gameId}, branch ${message.context.head.branchId}, action ${message.context.head.version}`
          : 'no game head'}
        . Retention does not establish current claim evidence.
      </p>
    </li>
  );
}
export function LobbyChatView({
  client,
  connection,
  busy,
}: Readonly<{ client: GameConnection; connection: ConnectionState; busy: boolean }>) {
  const [draft, setDraft] = useState('');
  const heading = useId(),
    input = useId();
  const chat = connection.chat;
  useEffect(() => {
    if (chat.lastPost) setDraft('');
  }, [chat.lastPost]);
  const attached = connection.status === 'attached' || connection.status === 'observing';
  const notes = {
    idle: '',
    pending: 'Chat request awaiting confirmation.',
    confirmed: 'Chat reply confirmed.',
    uncertain:
      'Chat outcome uncertain. Connect again and explicitly retry the original message if offered.',
    invalid: 'Chat reply could not be verified. No unverified text was displayed.',
  };
  return (
    <section className="game-connection" aria-labelledby={heading}>
      <h3 id={heading}>Retained lobby chat</h3>
      <p className="quiet">
        Uses the shared game connection, even when game visibility is denied. No live push: load
        pages explicitly. This mounted lobby retains an uncertain message ID/text in memory only;
        keep the tab open to retry. Agreements remain separately accessible.
      </p>
      <p role="status" data-testid="chat-status">
        {notes[chat.status]}
      </p>
      <form
        method="post"
        aria-labelledby={heading}
        onSubmit={(event) => {
          event.preventDefault();
          const field = event.currentTarget.elements.namedItem('chatText') as HTMLTextAreaElement;
          if (!chatText(draft)) {
            field.setCustomValidity('Enter 1–4096 characters without NUL or malformed Unicode.');
            field.reportValidity();
            return;
          }
          client.postChat(draft);
        }}
      >
        <label htmlFor={input}>Chat message (required)</label>
        <textarea
          id={input}
          name="chatText"
          required
          maxLength={4096}
          value={draft}
          disabled={busy || chat.retry}
          onChange={(event) => {
            event.currentTarget.setCustomValidity('');
            setDraft(event.currentTarget.value);
          }}
        />
        <button type="submit" disabled={busy || !attached || chat.retry}>
          Post chat message
        </button>
        {chat.retry ? (
          <button type="button" disabled={busy || !attached} onClick={() => client.retryChat()}>
            Retry original chat message
          </button>
        ) : null}
      </form>
      <div className="connection-actions">
        <button type="button" disabled={busy || !attached} onClick={() => client.readChat(true)}>
          Read chat from beginning
        </button>
        <button type="button" disabled={busy || !attached} onClick={() => client.readChat()}>
          Read next chat page
        </button>
      </div>
      <p data-testid="chat-cursor">
        History cursor: {chat.cursor}.{' '}
        {chat.empty
          ? 'Empty page at this read; new messages may arrive later.'
          : 'A short page does not prove completion.'}{' '}
        Each page replaces the previous page; post replies never advance this cursor.
      </p>
      <ol data-testid="chat-page">
        {chat.page.map((message) => (
          <Message key={message.id} message={message} />
        ))}
      </ol>
      {chat.lastPost && !chat.page.some((message) => message.id === chat.lastPost!.id) ? (
        <>
          <h4>Last confirmed post (separate from paging)</h4>
          <ol data-testid="chat-last-post">
            <Message message={chat.lastPost} />
          </ol>
        </>
      ) : null}
    </section>
  );
}
