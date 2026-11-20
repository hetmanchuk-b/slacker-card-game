import { useId, useState } from 'react';
import type { ConnectionState, GameConnection } from './game-connection.ts';
import type { Vote } from './game-stream.ts';
import { RemainingTime, useRemainingTime } from './RemainingTime.tsx';

const feedback = (kind: string, status: ConnectionState['claimStatus']) =>
  ({
    none: '',
    pending: `${kind} awaiting technical confirmation.`,
    accepted: `${kind} accepted by the server. This is not a social verdict.`,
    rejected: `${kind} technically rejected. No social verdict or punishment is inferred. Inspect current evidence and procedure before a new attempt.`,
    uncertain: `${kind} outcome uncertain. Resync to inspect current state; nothing is automatically retried.`,
  })[status];

function ClaimForm({ client, connection, seatId, busy }: Props) {
  const prefix = useId();
  const [kind, setKind] = useState<'spoken' | 'chat' | 'action'>('spoken');
  const [reference, setReference] = useState('');
  const view = connection.view;
  const rows = [
    ...connection.chat.page,
    ...(connection.chat.lastPost ? [connection.chat.lastPost] : []),
  ].filter((row, index, all) => all.findIndex((r) => r.id === row.id) === index);
  const disabled =
    busy ||
    connection.status !== 'observing' ||
    !view?.state ||
    view.paused ||
    view.state.phase === 'finished' ||
    !view.state.players.some((p) => p.id === seatId && p.status === 'active');
  return (
    <form
      method="post"
      aria-label="Submit violation claim"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        client.submitClaim(
          String(data.get('accused')),
          String(data.get('reason')),
          kind === 'spoken'
            ? { type: 'spoken', key: reference }
            : kind === 'chat'
              ? { type: 'chat', messageId: reference }
              : { type: 'action', commandId: reference },
        );
        // Episode identity is never carried into the next deliberate claim.
        setReference('');
        setKind('spoken');
        event.currentTarget.reset();
      }}
    >
      <fieldset disabled={disabled}>
        <legend>Report a violation</legend>
        <label htmlFor={`${prefix}-accused`}>Accused seat (required)</label>
        <select id={`${prefix}-accused`} name="accused" required defaultValue="">
          <option value="">Choose accused seat</option>
          {view?.state?.players
            .filter((p) => p.id !== seatId && p.status === 'active')
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.id}
              </option>
            ))}
        </select>
        <label htmlFor={`${prefix}-reason`}>Reason (required)</label>
        <textarea id={`${prefix}-reason`} name="reason" required maxLength={4096} />
        <label htmlFor={`${prefix}-kind`}>Evidence type</label>
        <select
          id={`${prefix}-kind`}
          value={kind}
          onChange={(e) => {
            setKind(e.currentTarget.value as typeof kind);
            setReference('');
          }}
        >
          <option value="spoken">Spoken episode</option>
          <option value="chat">Retained chat message</option>
          <option value="action">Observed action</option>
        </select>
        {kind === 'spoken' ? (
          <>
            <label htmlFor={`${prefix}-ref`}>Exact spoken episode key (required)</label>
            <input
              id={`${prefix}-ref`}
              name="evidence"
              required
              maxLength={256}
              pattern=".*\S.*"
              type="text"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              value={reference}
              onChange={(e) => setReference(e.currentTarget.value)}
            />
            <p>
              Enter the exact key manually. No key is generated, inferred, suggested or reused. Only
              a deliberate manual entry can refer to the same episode again.
            </p>
          </>
        ) : (
          <>
            <label htmlFor={`${prefix}-ref`}>
              {kind === 'chat' ? 'Exact message ID' : 'Exact action command ID'} (required)
            </label>
            <select
              id={`${prefix}-ref`}
              name="evidence"
              required
              value={reference}
              onChange={(e) => setReference(e.currentTarget.value)}
            >
              <option value="">Choose visible evidence ID</option>
              {kind === 'chat'
                ? rows.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.id} — author {row.authorSeatId ?? 'legacy'}
                    </option>
                  ))
                : connection.actionIds.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
            </select>
          </>
        )}
        <p>
          Retention or visibility does not mean evidence is still eligible. The server determines
          original author, scope and deadline; boundary races can technically reject a claim.
        </p>
        <button type="submit">Submit claim</button>
      </fieldset>
    </form>
  );
}
type Props = Readonly<{
  client: GameConnection;
  connection: ConnectionState;
  seatId: string;
  busy: boolean;
}>;
export function ClaimsView(props: Props) {
  const { connection, client, seatId, busy } = props;
  const ballot = connection.view?.ballot;
  const withdrawal = connection.view?.withdrawal;
  const withdrawalRemaining = useRemainingTime(withdrawal?.timer ?? null);
  const remaining = useRemainingTime(ballot?.timer ?? null);
  const disabled =
    busy ||
    connection.status !== 'observing' ||
    !!connection.view?.paused ||
    !!ballot?.timer.paused ||
    remaining <= 0;
  return (
    <section className="claims" aria-label="Claims and voting">
      <h3>Claims and voting</h3>
      <p role="status" data-testid="claim-result">
        {feedback('Claim', connection.claimStatus)}
      </p>
      <ClaimForm
        key={JSON.stringify([
          connection.status,
          connection.view?.head.gameId,
          connection.view?.head.branchId,
          connection.view?.head.version,
          connection.view?.paused,
          ballot?.timer.id,
        ])}
        {...props}
      />
      <p role="status" data-testid="vote-result">
        {feedback('Vote', connection.voteStatus)}
      </p>
      <p role="status" data-testid="withdrawal-result">
        {feedback('Withdrawal command', connection.withdrawalStatus)}
      </p>
      {withdrawal ? (
        <div data-testid="withdrawal-procedure">
          <h4>Withdrawal consent</h4>
          <p>
            Claim {withdrawal.claim.id}: {withdrawal.claim.claimantId} requests withdrawal.
          </p>
          <RemainingTime remainingMs={withdrawalRemaining} paused={withdrawal.timer.paused} />
          <p role="status">
            {withdrawal.ownApproval === null
              ? 'No confirmed approval from you.'
              : `Your confirmed approval: ${withdrawal.ownApproval ? 'yes' : 'no'}.`}
          </p>
          {withdrawal.eligibleSeatIds.includes(seatId) && withdrawal.ownApproval === null ? (
            <fieldset
              disabled={
                busy ||
                connection.status !== 'observing' ||
                !!connection.view?.paused ||
                withdrawal.timer.paused ||
                withdrawalRemaining <= 0
              }
            >
              <legend>Your withdrawal response</legend>
              {([true, false] as const).map((approve) => (
                <button
                  type="button"
                  key={String(approve)}
                  onClick={() =>
                    client.answerWithdrawal(
                      withdrawal.timer.id,
                      approve,
                      connection.view!.head.gameId,
                      connection.view!.head.branchId,
                    )
                  }
                >
                  {approve ? 'Approve withdrawal' : 'Refuse withdrawal'}
                </button>
              ))}
            </fieldset>
          ) : (
            <p>
              {withdrawal.ownApproval === null
                ? 'The claimant does not answer their own request.'
                : 'Your response is recorded.'}
            </p>
          )}
          <p>
            All other active seats, including the accused, must approve. Silence is not consent.
            Denial or timeout restores the original ballot and its remaining time. Local zero does
            not decide withdrawal.
          </p>
        </div>
      ) : null}
      {ballot ? (
        <div data-testid="claim-ballot">
          <p>
            Claim {ballot.claim.id}: {ballot.claim.claimantId} accuses {ballot.claim.accusedId}:{' '}
            {ballot.claim.reason}
          </p>
          <p>
            Server scope: {ballot.claim.scope} {ballot.claim.scopeNumber}
          </p>
          {withdrawal ? <p>Suspended original ballot (separate timer and answer).</p> : null}
          {!withdrawal && ballot.claim.claimantId === seatId ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                client.requestWithdrawal(
                  ballot.claim.id,
                  connection.view!.head.gameId,
                  connection.view!.head.branchId,
                )
              }
            >
              Request withdrawal
            </button>
          ) : null}
          <RemainingTime remainingMs={remaining} paused={ballot.timer.paused} />
          <p role="status">
            {ballot.ownVote
              ? `Your confirmed vote: ${ballot.ownVote}.`
              : 'No confirmed vote from you.'}
          </p>
          {ballot.eligibleSeatIds.includes(seatId) && ballot.ownVote === null ? (
            <fieldset disabled={disabled}>
              <legend>Your ballot</legend>
              {(['yes', 'no', 'abstain'] as const).map((vote: Vote) => (
                <button
                  key={vote}
                  type="button"
                  onClick={() =>
                    client.castVote(
                      ballot.timer.id,
                      vote,
                      connection.view!.head.gameId,
                      connection.view!.head.branchId,
                    )
                  }
                >
                  {vote === 'yes' ? 'Vote yes' : vote === 'no' ? 'Vote no' : 'Abstain'}
                </button>
              ))}
            </fieldset>
          ) : (
            <p>
              {ballot.ownVote
                ? 'Your answer is recorded.'
                : 'You are not eligible to vote on this claim.'}
            </p>
          )}
          <p>
            Only your ballot is shown. Silence becomes abstention at the server deadline. Yes wins:
            accused penalized; no wins: claimant penalized; ties (including 0:0): nobody penalized.
            Local zero does not decide the outcome. Procedures are handled sequentially.
          </p>
        </div>
      ) : null}
    </section>
  );
}
