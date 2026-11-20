import { useId } from 'react';
import type { ConnectionState } from './game-connection.ts';
import { cardLabel } from './DealingView.tsx';
import { RemainingTime, useRemainingTime } from './RemainingTime.tsx';

const notes = {
  none: '',
  pending: 'Response awaiting confirmation.',
  accepted:
    'Response accepted. Only the current server state confirms a reservation or completion.',
  rejected:
    'Response technically rejected. Inspect the current procedure before another deliberate attempt.',
  uncertain:
    'Response outcome uncertain. Reconnect to inspect the current procedure. No response is automatically retried.',
} as const;
export function PenaltyView({
  connection,
  seatId,
  busy,
  onSelect,
  onRespond,
}: Readonly<{
  connection: ConnectionState;
  seatId: string;
  busy: boolean;
  onSelect: (cardId: string | null) => void;
  onRespond: (cardId: string | null) => void;
}>) {
  const view = connection.view;
  const penalty = view?.penalty;
  const remaining = useRemainingTime(penalty?.timer ?? null);
  const labelId = useId();
  const selectId = useId();
  const players = view?.state?.players;
  const seat = (id: string) => `Seat ${(players?.findIndex((p) => p.id === id) ?? -1) + 1}`;
  const eligible = !!penalty?.eligibleSeatIds.includes(seatId);
  const disabled =
    busy ||
    connection.status !== 'observing' ||
    !!view?.paused ||
    !!penalty?.timer.paused ||
    remaining <= 0;
  const hand = view?.state?.own.hand ?? [];
  return (
    <section className="penalty">
      <h4 id={labelId}>Penalty contribution</h4>
      <p role="status" data-testid="penalty-result">
        {notes[connection.penaltyStatus]}
      </p>
      {penalty ? (
        <div data-testid="penalty-procedure">
          <p data-testid="penalty-recipient">
            {seat(penalty.recipientId)} receives a penalty: {penalty.reason}.
          </p>
          <RemainingTime remainingMs={remaining} paused={penalty.timer.paused} />
          <p className="quiet">
            Choose one hand card or refuse. A choice reserves the card; transfers happen only when
            the server completes the procedure. Silence becomes refusal at the server deadline.
          </p>
          <p data-testid="own-reservation">
            {penalty.ownResponse?.type === 'card'
              ? `Reserved by you: ${cardLabel(penalty.ownResponse.card)}. Still in your hand until completion.`
              : penalty.ownResponse?.type === 'refuse'
                ? 'Your refusal is confirmed.'
                : ''}
          </p>
          {eligible && penalty.ownResponse === null ? (
            <>
              <form
                method="post"
                aria-labelledby={labelId}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (connection.selectedCardId !== null) onRespond(connection.selectedCardId);
                }}
              >
                <fieldset disabled={disabled || hand.length < 2}>
                  <legend>Reserve one of your hand cards</legend>
                  <label htmlFor={selectId}>Card to reserve (required)</label>
                  <select
                    id={selectId}
                    name="cardId"
                    required
                    value={connection.selectedCardId ?? ''}
                    onChange={(event) => onSelect(event.currentTarget.value || null)}
                  >
                    <option value="">Choose a hand card</option>
                    {hand.length >= 2
                      ? hand.map((card) => (
                          <option key={card.id} value={card.id}>
                            {cardLabel(card)}
                          </option>
                        ))
                      : null}
                  </select>
                  <button type="submit">Reserve selected card</button>
                </fieldset>
              </form>
              {hand.length < 2 ? (
                <p>Your last hand card cannot be donated. Closed stumps cannot be donated.</p>
              ) : null}
              <button type="button" disabled={disabled} onClick={() => onRespond(null)}>
                Refuse contribution
              </button>
            </>
          ) : (
            <p>
              {eligible
                ? 'Your response is recorded; wait for completion.'
                : 'You do not respond to this penalty.'}
            </p>
          )}
        </div>
      ) : null}
      <div data-testid="penalty-transfers" role="status">
        {players && connection.transfers.length ? (
          <ul>
            {connection.transfers.map((transfer) => (
              <li key={transfer.card.id}>
                {seat(transfer.fromSeatId)} transferred {cardLabel(transfer.card)} to{' '}
                {seat(transfer.toSeatId)}.
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
