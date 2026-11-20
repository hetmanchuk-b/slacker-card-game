import type { ConnectionState } from './game-connection.ts';
import type { Card } from './game-stream.ts';

export function cardLabel(card: Card) {
  const rank = card.face.rank;
  return `${rank === 11 ? 'Jack' : rank === 12 ? 'Queen' : rank === 13 ? 'King' : rank === 14 ? 'Ace' : rank} of ${card.face.suit}`;
}
const results = {
  none: '',
  pending: 'Draw awaiting confirmation.',
  played: 'Draw accepted.',
  violation: 'Draw accepted as an in-game violation; punishment is queued.',
  rejected: 'Draw technically rejected; no accepted action was confirmed.',
  uncertain:
    'Draw outcome uncertain. Reconnect to inspect current state before a deliberate new attempt. No draw is automatically retried.',
} as const;
export function DealingView({
  connection,
  busy,
  onDraw,
}: Readonly<{
  connection: ConnectionState;
  busy: boolean;
  onDraw: () => void;
}>) {
  const view = connection.view;
  const state = view?.state;
  const draw = connection.draw;
  const actor = state?.players.findIndex((player) => player.id === draw?.seatId) ?? -1;
  return (
    <section className="dealing">
      <h4>Cards and dealing</h4>
      <p role="status" data-testid="draw-result">
        {results[connection.drawStatus]}
      </p>
      <p role="status" data-testid="draw-actor">
        {draw && actor >= 0
          ? `Seat ${actor + 1} ${draw.rejected ? 'attempted an out-of-turn draw; no card kept.' : `drew a ${draw.destination === 'stump' ? 'closed stump' : 'hand card'}.`}`
          : ''}
      </p>
      {state && view ? (
        <>
          {view.initialRecipientNotice ? (
            <p className="notice" data-testid="initial-recipient">
              You are the initial recipient. Take the first card.
            </p>
          ) : null}
          <p>
            Deck cards remaining: <span data-testid="deck-count">{state.deckCount}</span>
          </p>
          {state.phase === 'dealing' ? (
            <>
              <button
                type="button"
                disabled={
                  busy || connection.status !== 'observing' || view.paused || view.hasProcedure
                }
                onClick={onDraw}
              >
                Draw card
              </button>
              <p className="quiet">
                Take one card by clicking the face-down deck. Follow actual draws clockwise; an
                out-of-turn attempt is permitted and punishable.
              </p>
            </>
          ) : null}
          {view.reveal ? (
            <p className="notice" data-testid="final-reveal">
              Final card: {cardLabel(view.reveal.card)}. Remember it; this public display is
              temporary.
            </p>
          ) : null}
          <h5>Your hand</h5>
          <ul className="cards" data-testid="own-hand">
            {state.own.hand.map((card) => (
              <li key={card.id}>{cardLabel(card)}</li>
            ))}
          </ul>
          <h5>Your closed stumps</h5>
          <ul data-testid="own-stumps">
            {state.own.stumps.map((id, index) => (
              <li key={id}>Closed stump {index + 1} — face down</li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
