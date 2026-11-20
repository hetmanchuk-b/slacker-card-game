import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import type { LobbyMembership } from '../protocol/lobby.ts';
import { GameConnection } from './game-connection.ts';
import { DealingView } from './DealingView.tsx';
import { PenaltyView } from './PenaltyView.tsx';
import { PlayView } from './PlayView.tsx';

const notes = {
  none: '',
  unavailable:
    'No current baseline was confirmed. This does not prove that the lobby has no assigned game.',
  unauthorized:
    'The original session or game participation could not be authorized. No replacement guest was issued.',
  'invalid-message': 'The stream could not be verified. Reconnect for a fresh state-only baseline.',
  'storage-unavailable':
    'The original first-start reference cannot be retained or verified. Start is blocked; keep site data and reload after fixing storage.',
  'start-rejected':
    'The server rejected this start attempt. Refresh agreements and inspect the current game before deliberately retrying the original intent.',
} as const;
type Props = Readonly<{
  membership: LobbyMembership;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onRouteChange: () => void;
}>;
export function GameConnectionView({ membership, busy, onBusy, onRouteChange }: Props) {
  const routeChanged = useRef(onRouteChange);
  const [client] = useState(
    () =>
      new GameConnection({
        lobbyId: membership.lobbyId,
        seatId: membership.seatId,
        isOwner: membership.isOwner,
        onBusy,
        storage: {
          getItem: (key) => sessionStorage.getItem(key),
          setItem: (key, value) => sessionStorage.setItem(key, value),
        },
        requestId: () => crypto.randomUUID(),
        factory: () => {
          const socket = io(window.location.origin, {
            autoConnect: false,
            reconnection: false,
            forceNew: true,
            transports: ['websocket'],
            withCredentials: true,
            timeout: 5000,
          });
          return {
            get connected() {
              return socket.connected;
            },
            on: (event, listener) => {
              socket.on(event, listener);
            },
            connect: () => {
              socket.connect();
            },
            disconnect: () => {
              socket.disconnect();
            },
            send: (message) => {
              socket.volatile.emit('client-message', message);
            },
          };
        },
      }),
  );
  const [connection, setConnection] = useState(client.current);
  useEffect(() => {
    let route: string | null = null;
    const unsubscribe = client.subscribe((next) => {
      setConnection(next);
      if (next.view) {
        const current = JSON.stringify([next.view.head.gameId, next.view.head.branchId]);
        if (current !== route) {
          route = current;
          routeChanged.current();
        }
      }
    });
    return () => {
      unsubscribe();
      client.close();
    };
  }, [client]);
  const attached = connection.status === 'attached' || connection.status === 'observing';
  const view = connection.view;
  return (
    <section className="game-connection" aria-labelledby="game-connection-title">
      <h3 id="game-connection-title">Game connection</h3>
      <p className="quiet">
        Manual dealing and current observations. Refresh agreements and obtain every durable
        member's acceptance before attempting a first start. Only the server decides admission. A
        confirmed game or branch change clears the old agreement snapshot and unsaved draft; refresh
        agreements again.
      </p>
      <p role="status">
        Connection: <span data-testid="connection-status">{connection.status}</span>
      </p>
      {connection.note !== 'none' ? <p className="notice">{notes[connection.note]}</p> : null}
      <div className="connection-actions">
        <button type="button" disabled={busy} onClick={() => client.connect()}>
          {attached ? 'Resync game' : 'Connect game'}
        </button>
        <button
          type="button"
          disabled={busy || connection.status === 'disconnected'}
          onClick={() => client.close()}
        >
          Disconnect game
        </button>
        {membership.isOwner ? (
          <button
            type="button"
            disabled={
              busy ||
              !attached ||
              (connection.assigned && !connection.retry) ||
              connection.note === 'storage-unavailable'
            }
            onClick={() => client.startFirst()}
          >
            {connection.retry ? 'Retry original first start' : 'Attempt first start'}
          </button>
        ) : null}
      </div>
      <p className="quiet">
        Resync uses a fresh connection to fence old packets. No offline commands or missed
        observations are replayed. First-start retries keep the original ID and null expected head;
        this is a proposal, not a claim that the lobby is unassigned.
      </p>
      {view ? (
        <section aria-labelledby="game-baseline-title">
          <h4 id="game-baseline-title">Confirmed game baseline</h4>
          <dl>
            <dt>Game reference</dt>
            <dd className="reference" data-testid="game-id">
              {view.head.gameId}
            </dd>
            <dt>Action version</dt>
            <dd data-testid="game-version">{view.head.version}</dd>
            <dt>Suspension</dt>
            <dd data-testid="game-paused">{view.paused ? 'Paused' : 'Running'}</dd>
          </dl>
          {view.state ? (
            <>
              <p>
                Phase: <span data-testid="game-phase">{view.state.phase}</span>
              </p>
              <p>
                Deck: {view.state.deckCount}; table: {view.state.tableCount}; discard:{' '}
                {view.state.discardCount}.
              </p>
              <ol aria-label="Game seat counts">
                {view.state.players.map((player, index) => (
                  <li key={player.id}>
                    Seat {index + 1}
                    {player.id === membership.seatId ? ' (you)' : ''}: {player.handCount} hand
                    cards, {player.stumpCount} closed stumps; {player.status}.
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p data-testid="game-null-state">
              An assigned match has no current game state, for example after rollback before
              creation. This is not an unassigned lobby.
            </p>
          )}
        </section>
      ) : (
        <p>No current game baseline is displayed. Reconnect/resync to confirm it.</p>
      )}
      <DealingView
        connection={connection}
        busy={busy}
        seatId={membership.seatId}
        onDraw={() => client.drawCard()}
        onPlay={(id) => client.playCard(id)}
        onStump={(id) => client.openStump(id)}
      />
      <PlayView
        connection={connection}
        busy={busy}
        seatId={membership.seatId}
        onTake={() => client.takeBottom()}
        onDismissPeek={() => client.dismissPeek()}
      />
      <PenaltyView
        connection={connection}
        seatId={membership.seatId}
        busy={busy}
        onSelect={(id) => client.selectPenaltyCard(id)}
        onRespond={(id) => client.respondToPenalty(id)}
      />
      <p className="quiet">
        Drag, chat/claim and owner-history controls arrive in later increments. No permanent trump
        or next-recipient indicator is shown.
      </p>
    </section>
  );
}
