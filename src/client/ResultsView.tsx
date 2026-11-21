import type { GameConnection, ConnectionState } from './game-connection.ts';

type Props = Readonly<{
  client: GameConnection;
  connection: ConnectionState;
  isOwner: boolean;
  busy: boolean;
}>;
export function ResultsView({ client, connection, isOwner, busy }: Props) {
  const state = connection.view?.state;
  const result = state?.result;
  const attached = connection.status === 'attached' || connection.status === 'observing';
  const seat = (id: string) => `Seat ${(state?.players.findIndex((p) => p.id === id) ?? -1) + 1}`;
  if (!result && !connection.successorRetry) return null;
  return (
    <section aria-labelledby="results-title">
      <h4 id="results-title">Match results and next match</h4>
      {result ? (
        <div data-testid="match-results">
          {result.type === 'last-player' ? (
            <p>Last player — loser: {seat(result.loserId)}.</p>
          ) : result.type === 'all-won' ? (
            <p>All players won.</p>
          ) : (
            <p>
              Draw — remaining participants: {result.remainingSeatIds.map(seat).join(', ')}. These
              participants are not declared losers.
            </p>
          )}
          <p>
            Winners:{' '}
            {state!.players
              .filter((p) => p.status === 'won')
              .map((p) => seat(p.id))
              .join(', ') || 'None'}
            .
          </p>
          <p className="quiet">
            Results use the current executable rules. No post-game minigame is available. Owner
            rollback remains server-authorized until an actual next match starts.
          </p>
        </div>
      ) : null}
      {isOwner ? (
        <>
          <p className="quiet">
            Refresh agreements and obtain fresh acceptance from every durable member, including the
            owner, new members and disconnected members. The server alone checks admission. Failed
            starts do not clear consent or close rollback.
          </p>
          <button
            type="button"
            disabled={busy || !attached || (!result && !connection.successorRetry)}
            onClick={() => client.startNext()}
          >
            {connection.successorRetry ? 'Retry original next match' : 'Attempt next match'}
          </button>
          {connection.successorRetry ? (
            <>
              <p role="status">
                Original next-match request retained in this mounted page only. Retries keep its
                exact finished head even after a fork or successor. Reload loses this reference;
                acknowledgments never install historical state.
              </p>
              <button type="button" disabled={busy} onClick={() => client.discardSuccessorRetry()}>
                Discard original next-match retry
              </button>
              <p className="quiet">
                Discarding cannot cancel a committed start. Inspect fresh state before making a new
                attempt.
              </p>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
