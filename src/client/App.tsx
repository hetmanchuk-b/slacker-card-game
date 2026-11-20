import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { CREATION_REFERENCE, LobbyCreation } from './lobby-creation.ts';
import type { CreationResult } from './lobby-creation.ts';
import {
  LobbyMembershipClient,
  lobbyFragment,
  readLobbyLocator,
  validLobbyLocator,
} from './lobby-membership.ts';
import type { MembershipResult } from './lobby-membership.ts';
import { LobbyAgreements } from './LobbyAgreements.tsx';
import { GameConnectionView } from './GameConnectionView.tsx';

const messages = {
  unavailable:
    'The request could not be confirmed. Check the lobby reference and retry the same operation.',
  'session-unavailable':
    'The original guest session is unavailable. We have not replaced it. Lost guest access cannot be recovered by lobby reference.',
  'rate-limited': 'Too many requests. Wait a minute, then retry the same operation.',
  'storage-unavailable':
    'This tab cannot save its creation reference. Allow site storage before creating a lobby.',
  'invalid-reference':
    'This tab has an unreadable creation reference. No new lobby request was sent. Do not discard it while a previous request is uncertain.',
  'invalid-response':
    'The lobby response could not be verified. Retry to confirm the original lobby.',
  'invalid-locator':
    'Enter the exact lobby reference: nonblank, at most 256 characters, without invalid Unicode or NUL.',
  'locator-unavailable':
    'This browser cannot retain the lobby address. No join was sent. Keep the exact reference and retry.',
  'admission-unavailable':
    'This lobby cannot admit a new member. It may be full or have a match in progress. Existing members must use their original guest session.',
} as const;

export function App() {
  const [locator, setLocator] = useState(() => readLobbyLocator(window.location.hash));
  const [joinTarget, setJoinTarget] = useState(() => readLobbyLocator(window.location.hash) ?? '');
  const [newGuest, setNewGuest] = useState(false);
  const [invalidTarget, setInvalidTarget] = useState(false);
  const [navigationWarning, setNavigationWarning] = useState(false);
  const targetInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  function locate(lobbyId: string) {
    window.history.replaceState(null, '', lobbyFragment(lobbyId));
    setLocator(lobbyId);
    setJoinTarget(lobbyId);
    targetInput.current?.setCustomValidity('');
    setInvalidTarget(false);
  }
  const [membershipClient] = useState(
    () =>
      new LobbyMembershipClient({
        fetch: (input, init) => fetch(input, init),
        locate,
        hasCreationReference: () => window.sessionStorage.getItem(CREATION_REFERENCE) !== null,
      }),
  );
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
  const [agreementGeneration, setAgreementGeneration] = useState(0);
  const [result, setResult] = useState<CreationResult | MembershipResult | null>(null);
  const secure = window.isSecureContext && window.location.protocol === 'https:';
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!secure || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNavigationWarning(false);
    setResult(null);
    const next = await client.create();
    if (next.type === 'created') {
      try {
        locate(next.membership.lobbyId);
      } catch {
        setNavigationWarning(true);
      }
    }
    setResult(next);
    try {
      setHasReference(window.sessionStorage.getItem(CREATION_REFERENCE) !== null);
    } catch {
      /* Reported by client. */
    }
    setBusy(false);
    inFlight.current = false;
  }
  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!secure || inFlight.current) return;
    if (!validLobbyLocator(joinTarget)) {
      targetInput.current?.setCustomValidity(messages['invalid-locator']);
      setInvalidTarget(true);
      targetInput.current?.reportValidity();
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setResult(null);
    setNavigationWarning(false);
    const consent = newGuest;
    setNewGuest(false); // Consent is one explicit fresh-entry attempt, never restored/retried automatically.
    const next = await membershipClient.join(joinTarget, consent);
    setResult(next);
    setBusy(false);
    inFlight.current = false;
  }
  const membership = result && result.type !== 'error' ? result.membership : null;
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
                : result?.type === 'created'
                  ? 'Confirm lobby identity'
                  : hasReference
                    ? 'Resume lobby creation'
                    : 'Create lobby'}
            </button>
          </form>
          <section className="join" aria-labelledby="join-title">
            <h2 id="join-title">Join or restore a lobby</h2>
            <form
              action="/api/lobbies/join"
              method="post"
              aria-labelledby="join-title"
              onSubmit={join}
            >
              <label htmlFor="lobby-reference">Lobby reference (required)</label>
              <input
                ref={targetInput}
                id="lobby-reference"
                name="lobbyId"
                type="text"
                required
                maxLength={256}
                value={joinTarget}
                readOnly={busy}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint="go"
                aria-invalid={invalidTarget || undefined}
                aria-describedby="join-help"
                onInvalid={() => setInvalidTarget(true)}
                onChange={(event) => {
                  setJoinTarget(event.target.value);
                  event.target.setCustomValidity('');
                  setInvalidTarget(false);
                  setResult(null);
                }}
              />
              <p id="join-help" className="quiet">
                Use the exact reference or open a lobby link. Confirm with your original browser
                session to restore your seat. A link is not a recovery credential.
              </p>
              <label className="consent">
                <input
                  type="checkbox"
                  name="newGuest"
                  checked={newGuest}
                  disabled={busy}
                  onChange={(event) => setNewGuest(event.target.checked)}
                />
                Allow a new guest if no session exists. This creates a new identity, not recovery of
                a lost seat.
              </label>
              <button type="submit" disabled={busy || !secure}>
                {newGuest
                  ? 'Join as a new guest'
                  : locator === joinTarget
                    ? 'Restore my seat'
                    : 'Join lobby'}
              </button>
            </form>
          </section>
          {!secure ? (
            <p role="alert" className="error">
              Open Penky over HTTPS before creating a lobby.
            </p>
          ) : null}
          <p role="status">{busy ? 'Confirming the request with the server.' : ''}</p>
          {navigationWarning ? (
            <p role="alert">
              Lobby confirmed, but its address could not be saved. Keep the lobby reference or open
              its link in another tab.
            </p>
          ) : null}
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
              <p role="status">
                {membership.isOwner
                  ? 'Lobby confirmed. You are its owner.'
                  : 'Lobby confirmed. You are a member.'}
              </p>
              <a href={lobbyFragment(membership.lobbyId)} target="_blank" rel="noopener">
                Open lobby in another tab
              </a>
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
              <GameConnectionView
                key={`game:${membership.lobbyId}:${membership.seatId}`}
                onRouteChange={() => setAgreementGeneration((value) => value + 1)}
                membership={membership}
                busy={busy}
                onBusy={(value) => {
                  inFlight.current = value;
                  setBusy(value);
                }}
              />
              <LobbyAgreements
                key={`${membership.lobbyId}:${membership.seatId}:ui:${agreementGeneration}`}
                membership={membership}
                busy={busy}
                onBusy={(value) => {
                  inFlight.current = value;
                  setBusy(value);
                }}
              />
            </>
          ) : (
            <p className="quiet">
              Your lobby reference and server-assigned seat will appear here after confirmation.
            </p>
          )}
        </section>
      </main>
      <footer>
        Functional click/keyboard, drag play and retained chat. Claims and later controls are still
        planned.
      </footer>
    </>
  );
}
