import type { LobbyMembership } from '../protocol/lobby.ts';
import type { LobbyWorkflow } from '../protocol/lobby-workflow.ts';
import { validLobbyLocator } from './lobby-membership.ts';

export type WorkflowResult =
  | Readonly<{ type: 'confirmed'; view: LobbyWorkflow }>
  | Readonly<{
      type: 'error';
      code:
        | 'unavailable'
        | 'unauthorized'
        | 'conflict'
        | 'rate-limited'
        | 'invalid-response'
        | 'invalid-input'
        | 'busy';
    }>;
const error = (code: Extract<WorkflowResult, { type: 'error' }>['code']): WorkflowResult => ({
  type: 'error',
  code,
});
const record = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
export const validAgreementText = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.isWellFormed() &&
  !value.includes('\0') &&
  new TextEncoder().encode(value).length <= 4096;
const revision = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^(0|[1-9]\d{0,18})$/.test(value) &&
  BigInt(value) <= 9223372036854775807n;

function decode(value: unknown, membership: LobbyMembership): LobbyWorkflow | null {
  if (
    !record(value, ['lobbyId', 'revision', 'text', 'editable', 'members', 'matchAgreements']) ||
    value.lobbyId !== membership.lobbyId ||
    !revision(value.revision) ||
    !validAgreementText(value.text) ||
    typeof value.editable !== 'boolean' ||
    !Array.isArray(value.members) ||
    value.members.length < 1 ||
    value.members.length > 8
  )
    return null;
  const members: LobbyWorkflow['members'][number][] = [];
  const ids = new Set<string>();
  for (const [position, member] of value.members.entries()) {
    if (
      !record(member, ['seatId', 'position', 'ready']) ||
      !validLobbyLocator(member.seatId) ||
      ids.has(member.seatId) ||
      member.position !== position ||
      typeof member.ready !== 'boolean'
    )
      return null;
    ids.add(member.seatId);
    members.push({
      seatId: member.seatId,
      position,
      ready: member.ready,
    } as LobbyWorkflow['members'][number]);
  }
  if (members[membership.position]?.seatId !== membership.seatId) return null;
  let matchAgreements: LobbyWorkflow['matchAgreements'] = null;
  if (value.matchAgreements !== null) {
    const match = value.matchAgreements;
    if (
      !record(match, ['gameId', 'revision', 'text']) ||
      !validLobbyLocator(match.gameId) ||
      !revision(match.revision) ||
      !validAgreementText(match.text)
    )
      return null;
    matchAgreements = {
      gameId: match.gameId,
      revision: match.revision,
      text: match.text,
    } as NonNullable<LobbyWorkflow['matchAgreements']>;
  }
  return {
    lobbyId: membership.lobbyId,
    revision: value.revision,
    text: value.text,
    editable: value.editable,
    members,
    matchAgreements,
  };
}

/** Explicit request/response only. Epoch is a CAS input, not a view cursor.
 * No cached authority, issuance, automatic retries or conflict retargeting. */
export class LobbyAgreementsClient {
  readonly #membership: LobbyMembership;
  readonly #fetch: typeof fetch;
  #pending = false;
  constructor(dependencies: Readonly<{ membership: LobbyMembership; fetch: typeof fetch }>) {
    this.#membership = { ...dependencies.membership };
    this.#fetch = dependencies.fetch;
  }
  read(): Promise<WorkflowResult> {
    return this.#request('state', {});
  }
  edit(expectedRevision: string, text: string): Promise<WorkflowResult> {
    if (!revision(expectedRevision) || !validAgreementText(text))
      return Promise.resolve(error('invalid-input'));
    if (!this.#membership.isOwner) return Promise.resolve(error('unauthorized'));
    return this.#request('agreements', { expectedRevision, text });
  }
  accept(expectedRevision: string, ready: boolean): Promise<WorkflowResult> {
    if (!revision(expectedRevision) || typeof ready !== 'boolean')
      return Promise.resolve(error('invalid-input'));
    return this.#request('ready', { expectedRevision, ready });
  }
  async #request(kind: 'state' | 'agreements' | 'ready', fields: object): Promise<WorkflowResult> {
    if (this.#pending) return error('busy');
    this.#pending = true;
    try {
      const response = await this.#fetch(`/api/lobbies/${kind}`, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lobbyId: this.#membership.lobbyId, ...fields }),
      });
      if (response.status !== 200)
        return error(
          response.status === 401 || response.status === 403
            ? 'unauthorized'
            : response.status === 409
              ? 'conflict'
              : response.status === 429
                ? 'rate-limited'
                : 'unavailable',
        );
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        return error('invalid-response');
      }
      const view = decode(value, this.#membership);
      return view ? { type: 'confirmed', view } : error('invalid-response');
    } catch {
      return error('unavailable');
    } finally {
      this.#pending = false;
    }
  }
}
