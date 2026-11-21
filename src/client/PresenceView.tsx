import type { GameConnection, ConnectionState } from './game-connection.ts';
import { RemainingTime, useRemainingTime } from './RemainingTime.tsx';

export function PresenceView({
  client,
  connection,
  seatId,
  busy,
}: Readonly<{
  client: GameConnection;
  connection: ConnectionState;
  seatId: string;
  busy: boolean;
}>) {
  const view = connection.view;
  const vote = view?.replacementVote ?? null;
  const remaining = useRemainingTime(vote?.timer ?? null);
  if (!view) return null;
  const label = (id: string) => {
    const index = view.state?.players.findIndex((p) => p.id === id) ?? -1;
    return index >= 0 ? `Seat ${index + 1}${id === seatId ? ' (you)' : ''}` : id;
  };
  const human =
    connection.status === 'observing' &&
    view.connections.some((c) => c.seatId === seatId && c.connected && c.controller === 'human') &&
    view.state?.players.some((p) => p.id === seatId && p.status === 'active');
  const canVote =
    human &&
    !busy &&
    !!vote &&
    vote.ownVote === null &&
    vote.eligibleSeatIds.includes(seatId) &&
    remaining > 0;
  return (
    <section aria-labelledby="presence-title" data-testid="presence">
      <h4 id="presence-title">Presence and replacement</h4>
      <div role="status">
        <p>
          {view.paused
            ? 'Gameplay suspended. Gameplay timers retain their remaining time.'
            : 'Gameplay running.'}
        </p>
        <ul>
          {view.connections.map((c) => (
            <li key={c.seatId} data-testid={`presence-${c.seatId}`}>
              {label(c.seatId)}: {c.connected ? 'Connected' : 'Absent'};{' '}
              {c.controller === 'human' ? 'Human control' : 'Bot control (no bot decisions yet)'}.
            </li>
          ))}
        </ul>
      </div>
      <p className="quiet">
        Multiple tabs count as one seat: the last connection must leave before absence begins.
        Replacement requires more than 30 seconds of absence, checked by the server. No absence
        countdown is available. Replacement voting continues during gameplay suspension. Without a
        connected active human, gameplay stays paused.
      </p>
      <p className="quiet">
        Returning humans regain control through Connect game (or Resync game), after the current
        atomic action. Return cancels their replacement vote. Reconnect obtains state only, never
        missed private observations.
      </p>
      {!vote
        ? view.connections
            .filter(
              (c) =>
                !c.connected &&
                c.controller === 'human' &&
                view.state?.players.some((p) => p.id === c.seatId && p.status === 'active'),
            )
            .map((c) => (
              <button
                type="button"
                key={c.seatId}
                disabled={!human || busy}
                onClick={() => client.proposeBot(c.seatId, view.head.gameId, view.head.branchId)}
              >
                Propose bot for {label(c.seatId)}
              </button>
            ))
        : null}
      {vote ? (
        <div data-testid="replacement-vote">
          <p role="status">
            Replacement vote for {label(vote.absentSeatId)}. Your confirmed vote:{' '}
            {vote.ownVote ?? 'none'}.
          </p>
          <RemainingTime remainingMs={remaining} paused={false} />
          {vote.eligibleSeatIds.includes(seatId) ? (
            <div className="connection-actions">
              {(['yes', 'no', 'abstain'] as const).map((answer) => (
                <button
                  type="button"
                  key={answer}
                  disabled={!canVote}
                  onClick={() =>
                    client.voteReplacement(
                      vote.timer.id,
                      answer,
                      view.head.gameId,
                      view.head.branchId,
                    )
                  }
                >
                  Replacement vote {answer}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <p role="status" data-testid="replacement-feedback">
        {connection.replacementStatus === 'rejected'
          ? connection.replacementRejection === 'replacement-too-early'
            ? 'Proposal rejected: absence must exceed 30 seconds. Inspect presence before a new attempt.'
            : 'Replacement attempt rejected by the server. Inspect current presence and vote before a new attempt.'
          : connection.replacementStatus === 'accepted'
            ? 'Replacement command accepted. Current presence and vote show the authoritative result.'
            : connection.replacementStatus === 'uncertain'
              ? 'Replacement outcome uncertain. Explicitly reconnect; no command will be replayed.'
              : ''}
      </p>
    </section>
  );
}
