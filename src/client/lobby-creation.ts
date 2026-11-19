import type { LobbyMembership } from '../protocol/lobby.ts';

export const CREATION_REFERENCE = 'penky.lobby-creation.v1';
export type CreationResult =
  | Readonly<{ type: 'created'; membership: LobbyMembership }>
  | Readonly<{
      type: 'error';
      code:
        | 'unavailable'
        | 'session-unavailable'
        | 'rate-limited'
        | 'storage-unavailable'
        | 'invalid-response'
        | 'invalid-reference';
    }>;
type Dependencies = Readonly<{
  fetch: typeof fetch;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  requestId: () => string;
}>;
const text = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 256 &&
  !!value.trim() &&
  value.isWellFormed() &&
  !value.includes('\0');
const error = (code: Extract<CreationResult, { type: 'error' }>['code']): CreationResult => ({
  type: 'error',
  code,
});

/** Cookie-only HTTP seam. Stores only a nonsecret canonical creation reference,
 * never a credential, trusted membership, game state or private observation.
 */
export class LobbyCreation {
  readonly #dependencies: Dependencies;
  #pending: Promise<CreationResult> | null = null;
  constructor(dependencies: Dependencies) {
    this.#dependencies = dependencies;
  }

  create(): Promise<CreationResult> {
    if (this.#pending) return this.#pending;
    const operation = this.#create();
    this.#pending = operation;
    void operation.finally(() => {
      if (this.#pending === operation) this.#pending = null;
    });
    return operation;
  }

  async #post(path: string, requestId?: string): Promise<Response> {
    return this.#dependencies.fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
      ...(requestId === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId }) }),
    });
  }

  async #create(): Promise<CreationResult> {
    let requestId: string | undefined;
    try {
      const saved = this.#dependencies.storage.getItem(CREATION_REFERENCE);
      if (saved !== null) {
        let record: unknown;
        try {
          record = JSON.parse(saved);
        } catch {
          return error('invalid-reference');
        }
        if (
          !record ||
          typeof record !== 'object' ||
          Array.isArray(record) ||
          Object.keys(record).length !== 2 ||
          !('version' in record) ||
          record.version !== 1 ||
          !('requestId' in record) ||
          !text(record.requestId) ||
          record.requestId.length > 128
        )
          return error('invalid-reference');
        requestId = record.requestId;
      }
    } catch {
      return error('storage-unavailable');
    }
    try {
      const refresh = await this.#post('/api/guest/session/refresh');
      if (refresh.status === 401) {
        // A previously dispatched creation belongs to its original guest. Never
        // issue a replacement identity just to replay that reference.
        if (requestId !== undefined) return error('session-unavailable');
        const issued = await this.#post('/api/guest/session');
        if (issued.status === 409 || issued.status === 401) return error('session-unavailable');
        if (issued.status !== 204)
          return error(issued.status === 429 ? 'rate-limited' : 'unavailable');
      } else if (refresh.status !== 204)
        return error(refresh.status === 429 ? 'rate-limited' : 'unavailable');
      if (requestId === undefined) {
        requestId = this.#dependencies.requestId();
        if (!text(requestId) || requestId.length > 128) return error('invalid-reference');
        try {
          this.#dependencies.storage.setItem(
            CREATION_REFERENCE,
            JSON.stringify({ version: 1, requestId }),
          );
        } catch {
          return error('storage-unavailable');
        }
      }
      const response = await this.#post('/api/lobbies', requestId);
      if (response.status !== 200)
        return error(
          response.status === 401
            ? 'session-unavailable'
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
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== 4 ||
        !('lobbyId' in value) ||
        !text(value.lobbyId) ||
        !('seatId' in value) ||
        !text(value.seatId) ||
        !('position' in value) ||
        value.position !== 0 ||
        !('isOwner' in value) ||
        value.isOwner !== true
      )
        return error('invalid-response');
      const membership = {
        lobbyId: value.lobbyId,
        seatId: value.seatId,
        position: 0,
        isOwner: true,
      } as LobbyMembership;
      return { type: 'created', membership };
    } catch {
      return error('unavailable');
    }
  }
}
