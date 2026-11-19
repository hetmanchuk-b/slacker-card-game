import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { LobbyMembership } from '../protocol/lobby.ts';
import type { LobbyWorkflow } from '../protocol/lobby-workflow.ts';
import { LobbyAgreementsClient, validAgreementText } from './lobby-agreements.ts';
import type { WorkflowResult } from './lobby-agreements.ts';

const messages = {
  unavailable:
    'The result could not be confirmed. It may have committed. Refresh agreements before making another change.',
  unauthorized:
    'Your session or permission could not be confirmed. Restore membership with the original guest session; no replacement was issued.',
  conflict:
    'The agreements changed or lobby changes are locked. Refresh and review before making a new decision. Nothing will be resubmitted automatically.',
  'rate-limited': 'Too many lobby requests. Wait a minute, then refresh agreements.',
  'invalid-response':
    'The response could not be verified. Refresh agreements; no unverified data is displayed.',
  'invalid-input':
    'Use exact, well-formed text without NUL, at most 4096 UTF-8 bytes. Empty agreements are allowed.',
  busy: 'Another request is still pending. Wait for confirmation.',
} as const;

type Props = Readonly<{
  membership: LobbyMembership;
  busy: boolean;
  onBusy: (busy: boolean) => void;
}>;
export function LobbyAgreements({ membership, busy, onBusy }: Props) {
  const [client] = useState(
    () => new LobbyAgreementsClient({ membership, fetch: (input, init) => fetch(input, init) }),
  );
  const [view, setView] = useState<LobbyWorkflow | null>(null);
  const [draft, setDraft] = useState('');
  const [needsRefresh, setNeedsRefresh] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [invalidText, setInvalidText] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const running = useRef(false);
  const mutable = !!view && view.editable && !needsRefresh && !busy;
  const own = view?.members.find((member) => member.seatId === membership.seatId);

  async function execute(
    operation: () => Promise<WorkflowResult>,
    kind: 'read' | 'edit' | 'accept',
  ) {
    if (busy || running.current) return;
    running.current = true;
    onBusy(true);
    setProblem(null);
    setStatus('Confirming agreements with the server…');
    try {
      const result = await operation();
      if (result.type === 'confirmed') {
        setView(result.view); // Install same-epoch flag changes too: epoch is not a whole-view cursor.
        setNeedsRefresh(false);
        if (kind !== 'accept') {
          setDraft(result.view.text);
          input.current?.setCustomValidity('');
          setInvalidText(false);
        }
        setStatus(
          kind === 'read'
            ? 'Agreements refreshed.'
            : kind === 'edit'
              ? 'Agreements saved.'
              : 'Acceptance confirmed.',
        );
      } else {
        setNeedsRefresh(true);
        if (result.code === 'unauthorized') setView(null);
        // Keep only the previously verified snapshot/local draft on malformed
        // replies. It is visibly stale and cannot authorize another mutation.
        setProblem(messages[result.code]);
        setStatus('');
      }
    } finally {
      running.current = false;
      onBusy(false);
    }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mutable || !view) return;
    if (!validAgreementText(draft)) {
      input.current?.setCustomValidity(messages['invalid-input']);
      setInvalidText(true);
      input.current?.reportValidity();
      return;
    }
    void execute(() => client.edit(view.revision, draft), 'edit');
  }
  return (
    <section className="agreements" aria-labelledby="agreements-title">
      <h3 id="agreements-title">Lobby agreements</h3>
      <p id="agreements-refresh-help" className="quiet">
        This is a snapshot, not live updates. Refresh replaces any unsaved draft. Acceptance means
        agreement to the current terms only, not general readiness to play.
      </p>
      <button
        type="button"
        disabled={busy}
        aria-describedby="agreements-refresh-help"
        onClick={() => {
          void execute(() => client.read(), 'read');
        }}
      >
        Refresh agreements
      </button>
      <p role="status">{status}</p>
      {problem ? (
        <p role="alert" className="error">
          {problem}
        </p>
      ) : null}
      {view ? (
        <>
          {needsRefresh ? (
            <p className="notice">
              Last confirmed snapshot only. Refresh is required before another change.
            </p>
          ) : null}
          <p>
            Acceptance epoch: <span data-testid="agreements-epoch">{view.revision}</span>
          </p>
          <h4>Saved lobby text</h4>
          <pre className="agreement-text" data-testid="agreements-text">
            {view.text}
          </pre>
          {membership.isOwner ? (
            <form
              action="/api/lobbies/agreements"
              method="post"
              aria-labelledby="agreements-editor-title"
              onSubmit={save}
            >
              <h4 id="agreements-editor-title">Owner editing</h4>
              <label htmlFor="agreements-draft">Edit lobby agreements</label>
              <textarea
                ref={input}
                id="agreements-draft"
                name="text"
                rows={5}
                maxLength={4096}
                value={draft}
                readOnly={!mutable}
                aria-invalid={invalidText || undefined}
                aria-describedby="agreements-text-help"
                onChange={(event) => {
                  setDraft(event.target.value);
                  event.target.setCustomValidity('');
                  setInvalidText(false);
                }}
              />
              <p id="agreements-text-help" className="quiet">
                Exact text; empty is allowed. Limit: 4096 UTF-8 bytes, not characters. Saving
                changed text resets everyone's acceptance.
              </p>
              <button type="submit" disabled={!mutable}>
                Save agreements
              </button>
            </form>
          ) : (
            <p className="quiet">
              Only the owner may edit text. You can confirm or withdraw your own acceptance.
            </p>
          )}
          <h4>Agreement acceptance</h4>
          <p className="quiet">
            Acceptance applies to the saved text above, not an unsaved draft. All durable members,
            including the owner and disconnected members, must accept before a new match.
          </p>
          <ol aria-label="Agreement acceptance">
            {view.members.map((member) => (
              <li key={member.seatId} data-testid={`acceptance-${member.position}`}>
                Seat {member.position + 1}
                {member.seatId === membership.seatId ? ' (you)' : ''}:{' '}
                {member.ready ? 'Accepted' : 'Not accepted'}
              </li>
            ))}
          </ol>
          <button
            type="button"
            disabled={!mutable || !own}
            onClick={() => {
              if (view && own)
                void execute(() => client.accept(view.revision, !own.ready), 'accept');
            }}
          >
            {own?.ready ? 'Withdraw acceptance' : 'Accept current agreements'}
          </button>
          {!view.editable ? (
            <p className="notice">
              Lobby changes are locked while the current match is unfinished. No text or acceptance
              changes can be made.
            </p>
          ) : null}
          {view.matchAgreements ? (
            <section aria-labelledby="match-agreements-title">
              <h4 id="match-agreements-title">Original match agreements (read-only)</h4>
              <p>
                Accepted epoch:{' '}
                <span data-testid="match-agreements-epoch">{view.matchAgreements.revision}</span>
              </p>
              <pre className="agreement-text" data-testid="match-agreements-text">
                {view.matchAgreements.text}
              </pre>
            </section>
          ) : (
            <p className="quiet">
              No original match agreements are available. No historical text is inferred.
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}
