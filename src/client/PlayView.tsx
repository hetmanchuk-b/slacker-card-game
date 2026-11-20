import type { ConnectionState } from './game-connection.ts';
import { cardLabel } from './DealingView.tsx';
import type { CardDragUI } from './use-card-drag.ts';
export function PlayView({
  drag,
  connection,
  busy,
  seatId,
  onTake,
  onDismissPeek,
}: Readonly<{
  drag: CardDragUI;
  connection: ConnectionState;
  busy: boolean;
  seatId: string;
  onTake: () => void;
  onDismissPeek: () => void;
}>) {
  const view = connection.view;
  const state = view?.state;
  const ordinary = state?.phase === 'round' || state?.phase === 'between-rounds';
  const seat = (id: string) => `Seat ${(state?.players.findIndex((p) => p.id === id) ?? -1) + 1}`;
  const notes = {
    none: '',
    pending: 'Move awaiting confirmation.',
    played: 'Move accepted.',
    violation: 'Move accepted as an in-game violation.',
    rejected:
      'Move technically rejected; inspect the current state before another deliberate attempt.',
    uncertain:
      'Move outcome uncertain. Reconnect to inspect current state; no move is automatically retried.',
  } as const;
  return (
    <section className="play">
      <h4>Table and play</h4>
      <p role="status" data-testid="move-result">
        {notes[connection.moveStatus]}
      </p>
      {state ? (
        <>
          {state.round ? (
            <p data-testid="round-context">
              Round {state.round.number}; fixed target: {state.round.targetSize}; turn:{' '}
              {seat(state.round.turnSeatId)}.
            </p>
          ) : null}
          {state.leaderId ? (
            <p data-testid="round-leader">Next lead: {seat(state.leaderId)}.</p>
          ) : null}
          <p>Public table, bottom to top:</p>
          <ol
            ref={drag.tableTarget}
            className="drag-area"
            data-drop-active={drag.dragging?.type === 'play-card'}
            data-testid="public-table"
          >
            {state.table.map((card, index) => (
              <li key={card.id}>
                {cardLabel(card)}
                {index === 0 ? ' — bottom' : ''}
                {index === state.table.length - 1 ? ' — top' : ''}
              </li>
            ))}
          </ol>
          {ordinary ? (
            <button
              type="button"
              disabled={
                busy ||
                connection.status !== 'observing' ||
                view!.paused ||
                view!.hasProcedure ||
                !state.players.some((p) => p.id === seatId && p.status === 'active')
              }
              onClick={onTake}
            >
              Take bottom card
            </button>
          ) : null}
          {ordinary ? (
            <p className="quiet">
              Hand clicks attempt a play; taking removes only the bottom card. The same own-stump
              click may legally open or cause a punishable private peek. There are no turn, beat or
              opening-right hints disabling attempts.
            </p>
          ) : null}
          <div role="status" data-testid="play-observations">
            {connection.playObservations.length ? (
              <ul>
                {connection.playObservations.map((o, index) => (
                  <li key={index}>
                    {o.type === 'card-played'
                      ? `${seat(o.seatId)} played ${cardLabel(o.card)}.`
                      : o.type === 'bottom-taken'
                        ? `${seat(o.seatId)} ${o.automatic ? 'automatically took' : 'took'} bottom ${cardLabel(o.card)}.`
                        : o.type === 'stump-opened'
                          ? `${seat(o.seatId)} opened a stump${o.card ? `: ${cardLabel(o.card)}` : ''}.`
                          : `${seat(o.seatId)} violation: ${o.reason}.`}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </>
      ) : null}
      {connection.peek ? (
        <div className="notice" data-testid="fresh-peek">
          <p role="status">
            Private stump peek: {cardLabel(connection.peek.card)}. The stump has not moved.
          </p>
          <button type="button" onClick={onDismissPeek}>
            Dismiss private peek
          </button>
        </div>
      ) : null}
    </section>
  );
}
