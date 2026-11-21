import { useRef, useState } from 'react';
import type { GameConnection, ConnectionState } from './game-connection.ts';
import type { RollbackCapture } from './owner-history.ts';
export function RollbackView({
  client,
  connection,
  busy,
}: {
  client: GameConnection;
  connection: ConnectionState;
  busy: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [capture, setCapture] = useState<RollbackCapture | null>(null);
  const current = client.captureRollback();
  const stale = !capture || JSON.stringify(current) !== JSON.stringify(capture);
  return (
    <section aria-labelledby="rollback-title">
      <h4 id="rollback-title">Owner rollback</h4>
      <button
        type="button"
        disabled={busy || !current || connection.rollbackRetry || connection.status !== 'observing'}
        onClick={() => {
          const selected = client.captureRollback();
          if (!selected) return;
          setCapture(selected);
          dialog.current!.showModal();
        }}
      >
        Review selected rollback
      </button>
      {connection.rollbackRetry && connection.rollbackStatus === 'uncertain' && (
        <button
          type="button"
          disabled={busy || !['attached', 'observing'].includes(connection.status)}
          onClick={() => client.retryRollback()}
        >
          Retry original rollback
        </button>
      )}
      <p role="status" data-testid="rollback-status">
        Rollback: {connection.rollbackStatus}.{' '}
        {connection.rollbackStatus === 'uncertain' &&
          'Outcome unknown. Reconnect, then explicitly retry the original request; nothing is retargeted.'}
      </p>
      <p>
        Retry references exist only while this page is mounted. Reload loses an uncertain rollback
        reference; inspect fresh history and state before any new attempt. A technical
        acknowledgment is not the restored baseline.
      </p>
      <dialog
        ref={dialog}
        aria-labelledby="rollback-confirm-title"
        aria-describedby="rollback-warning"
        onClose={() => {
          dialog.current!.returnValue = '';
          setCapture(null);
        }}
      >
        <h4 id="rollback-confirm-title">Confirm owner rollback</h4>
        <p id="rollback-warning">
          Rollback cannot erase human memory. Players cannot forget cards or trump already seen.
          Restoring a closed card does not make that knowledge unknown.
        </p>
        {capture && (
          <p>
            Restore before branch {capture.selected.branch}, action{' '}
            {capture.target.beforeActionVersion}. Expected head: branch{' '}
            {capture.target.expected.branch}, action {capture.target.expected.version}.
          </p>
        )}
        {stale && (
          <p role="status">
            Selection or history changed. Cancel and refresh; no rollback will be sent.
          </p>
        )}
        <form method="dialog">
          <button value="cancel" autoFocus>
            Cancel rollback
          </button>
          <button
            value="confirm"
            disabled={busy || stale}
            onClick={() => {
              if (capture && !stale) {
                dialog.current!.close('confirm');
                client.confirmRollback(capture);
              }
            }}
          >
            Confirm rollback — I understand
          </button>
        </form>
      </dialog>
    </section>
  );
}
