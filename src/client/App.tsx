import { useState } from 'react';
import type { FormEvent } from 'react';
import { CREATION_REFERENCE, LobbyCreation } from './lobby-creation.ts';
import type { CreationResult } from './lobby-creation.ts';

const messages = {
  unavailable: 'The request could not be confirmed. Retry with the same saved creation reference.',
  'session-unavailable':
    'The original guest session is unavailable. We have not replaced it. Lost guest access cannot be recovered by lobby reference.',
  'rate-limited': 'Too many requests. Wait a minute, then retry with the same creation reference.',
  'storage-unavailable':
    'This tab cannot save its creation reference. Allow site storage before creating a lobby.',
  'invalid-reference':
    'This tab has an unreadable creation reference. No new lobby request was sent. Do not discard it while a previous request is uncertain.',
  'invalid-response':
    'The lobby response could not be verified. Retry to confirm the original lobby.',
} as const;

export function App() {
  const [client] = useState(
    () =>
      new LobbyCreation({
        fetch: (input, init) => fetch(input, init),
        storage: {
          getItem: (key) => window.sessionStorage.getItem(key),
          setItem: (key, value) => window.sessionStorage.setItem(key, value),
        },
        requestId: () => crypto.randomUUID(),
      }),
  );
  const [hasReference, setHasReference] = useState(() => {
    try {
      return window.sessionStorage.getItem(CREATION_REFERENCE) !== null;
    } catch {
      return false;
    }
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CreationResult | null>(null);
  const secure = window.isSecureContext && window.location.protocol === 'https:';
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!secure || busy) return;
    setBusy(true);
    setResult(null);
    const next = await client.create();
    setResult(next);
    try {
      setHasReference(window.sessionStorage.getItem(CREATION_REFERENCE) !== null);
    } catch {
      /* Reported by client. */
    }
    setBusy(false);
  }
  const membership = result?.type === 'created' ? result.membership : null;
  return (
    <>
      <header className="masthead">
        <span className="brand">Penky</span>
        <span>A place for your next game</span>
      </header>
      <main>
        <section className="welcome" aria-labelledby="welcome-title">
          <h1 id="welcome-title">Create a lobby</h1>
          <p className="intro">
            Start with a place at the table. Your browser keeps your guest session; no account is
            required.
          </p>
          <form
            action="/api/lobbies"
            method="post"
            aria-labelledby="welcome-title"
            onSubmit={create}
          >
            <p id="guest-warning" className="notice">
              Keep this browser’s site data. Losing your guest session loses access to your seat and
              owner controls.
            </p>
            <button type="submit" disabled={busy || !secure} aria-describedby="guest-warning">
              {busy
                ? 'Confirming…'
                : membership
                  ? 'Confirm lobby identity'
                  : hasReference
                    ? 'Resume lobby creation'
                    : 'Create lobby'}
            </button>
          </form>
          {!secure ? (
            <p role="alert" className="error">
              Open Penky over HTTPS before creating a lobby.
            </p>
          ) : null}
          {busy ? <p role="status">Checking your guest session and confirming one lobby.</p> : null}
          {result?.type === 'error' ? (
            <p role="alert" className="error">
              {messages[result.code]}
            </p>
          ) : null}
        </section>
        <section className="place" aria-labelledby="place-title">
          <h2 id="place-title">{membership ? 'Your lobby' : 'Your place'}</h2>
          {membership ? (
            <>
              <div className="seat" aria-hidden="true">
                {membership.position + 1}
              </div>
              <p role="status">Lobby confirmed. You are its owner.</p>
              <dl>
                <dt>Lobby reference</dt>
                <dd data-testid="lobby-id" className="reference">
                  {membership.lobbyId}
                </dd>
                <dt>Your seat</dt>
                <dd data-testid="seat-number">{membership.position + 1}</dd>
                <dt>Seat reference</dt>
                <dd data-testid="seat-id" className="reference">
                  {membership.seatId}
                </dd>
                <dt>Role</dt>
                <dd data-testid="seat-role">{membership.isOwner ? 'Owner' : 'Member'}</dd>
              </dl>
              <p className="quiet">
                Seat numbers identify places in the lobby, not whose turn it is.
              </p>
            </>
          ) : (
            <p className="quiet">
              Your lobby reference and server-assigned seat will appear here after confirmation.
            </p>
          )}
        </section>
      </main>
      <footer>Joining, agreements and the game table arrive in later increments.</footer>
    </>
  );
}
