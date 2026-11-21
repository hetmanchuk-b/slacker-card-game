import type { OwnerHistory } from './owner-history.ts';
import type { HistorySummary } from '../projections/history.ts';
function describe(s: HistorySummary): string {
  switch (s.type) {
    case 'claim-submitted':
      return `${s.type}: action ${s.claim.submittedAtVersion}; ${s.claim.claimantId} accused ${s.claim.accusedId}; ${s.claim.reason}; ${s.claim.scope} ${s.claim.scopeNumber}`;
    case 'card-drawn':
      return `${s.type}: ${s.actorId}, ${s.destination}`;
    case 'bottom-taken':
      return `${s.type}: ${s.actorId}${s.automatic ? ' (automatic)' : ''}`;
    case 'violation':
      return `${s.type}: ${s.actorId}, ${s.reason}`;
    case 'claim-vote-resolved':
      return `${s.type}: action ${s.submittedAtVersion}, ${s.resolution}`;
    case 'withdrawal-resolved':
      return `${s.type}: action ${s.submittedAtVersion}, ${s.approved ? 'approved' : 'refused'}`;
    case 'rollback':
      return `${s.type}: ${s.actorId}, audit ${s.rollback}`;
    default:
      return `${s.type}${'actorId' in s ? `: ${s.actorId}` : ''}${'submittedAtVersion' in s ? `; action ${s.submittedAtVersion}` : ''}`;
  }
}
export function OwnerHistoryView({
  history,
  busy,
  available,
  read,
  select,
}: {
  history: OwnerHistory['current'];
  busy: boolean;
  available: boolean;
  read: (first: boolean) => void;
  select: (branch: number, version: number) => void;
}) {
  let rollbackOrdinal = 0;
  return (
    <section className="owner-history" aria-labelledby="history-title">
      <h3 id="history-title">Owner metadata timeline</h3>
      <p>
        Current match only. No card previews or ballot choices. Selection does not execute rollback.
      </p>
      <button type="button" disabled={busy || !available} onClick={() => read(true)}>
        Refresh owner history
      </button>
      {history.status === 'partial' && (
        <button type="button" disabled={busy || !available} onClick={() => read(false)}>
          Read next history page
        </button>
      )}
      <p role="status">
        History: {history.status}. {history.entries.length} records loaded.{' '}
        {history.head &&
          (history.rollbackOpen ? 'Rollback window open.' : 'Rollback window closed; read-only.')}
        {['stale', 'uncertain', 'unavailable'].includes(history.status) &&
          ' Refresh owner history to explicitly restart.'}
      </p>
      {history.selected && (
        <p>
          Selected completed action: branch {history.selected.branch}, action{' '}
          {history.selected.version}. No rollback sent.
        </p>
      )}
      {history.entries.length > 0 && (
        <div
          className="history-scroll"
          role="region"
          aria-label="Owner history records"
          tabIndex={0}
        >
          <table>
            <caption>
              Complete metadata records in server order; targets available only after all pages are
              read
            </caption>
            <thead>
              <tr>
                <th scope="col">Record</th>
                <th scope="col">Details</th>
                <th scope="col">Target</th>
              </tr>
            </thead>
            <tbody>
              {history.entries.map((e, index) => (
                <tr key={index}>
                  <th scope="row">
                    {e.type === 'branch'
                      ? `Branch ${e.branch.head.branch}: ${e.branch.label}`
                      : e.type === 'action'
                        ? `Branch ${e.branch}, action ${e.action.version}`
                        : `Rollback audit ${++rollbackOrdinal}`}
                  </th>
                  <td>
                    {e.type === 'branch' ? (
                      <>
                        Head action {e.branch.head.version}. Parent:{' '}
                        {e.branch.parent
                          ? `branch ${e.branch.parent.branch}, action ${e.branch.parent.version}`
                          : 'none'}
                        .
                      </>
                    ) : e.type === 'action' ? (
                      <>
                        Origin: branch {e.action.origin.branch}, action {e.action.origin.version}.
                        Time: {e.action.occurredAtMs}.{' '}
                        {e.action.summaries.map((s, i) => (
                          <p key={i}>{describe(s)}</p>
                        ))}
                      </>
                    ) : (
                      <>
                        Actor {e.rollback.actorId}. Time {e.rollback.occurredAtMs}. Abandoned branch{' '}
                        {e.rollback.abandoned.branch} action {e.rollback.abandoned.version}; parent
                        branch {e.rollback.parent.branch} action {e.rollback.parent.version};
                        restored branch {e.rollback.restored.branch} action{' '}
                        {e.rollback.restored.version}; before branch{' '}
                        {e.rollback.beforeAction.branch} action {e.rollback.beforeAction.version}.
                      </>
                    )}
                  </td>
                  <td>
                    {e.type === 'action' &&
                    e.action.rollbackTarget &&
                    history.status === 'complete' ? (
                      <>
                        <input
                          type="radio"
                          id={`history-target-${e.branch}-${e.action.version}`}
                          name="history-target"
                          disabled={busy || !available}
                          checked={
                            history.selected?.branch === e.branch &&
                            history.selected.version === e.action.version
                          }
                          onChange={() => select(e.branch, e.action.version)}
                        />
                        <label htmlFor={`history-target-${e.branch}-${e.action.version}`}>
                          Select branch {e.branch} action {e.action.version}
                        </label>
                      </>
                    ) : (
                      'Read-only'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
