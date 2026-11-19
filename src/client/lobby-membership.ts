import type { LobbyMembership } from '../protocol/lobby.ts';

export type MembershipResult =
  | Readonly<{ type: 'joined'; membership: LobbyMembership }>
  | Readonly<{
      type: 'error';
      code:
        | 'unavailable'
        | 'session-unavailable'
        | 'rate-limited'
        | 'invalid-response'
        | 'invalid-locator'
        | 'locator-unavailable'
        | 'admission-unavailable';
    }>;
type Dependencies = Readonly<{
  fetch: typeof fetch;
  /** Save only the nonsecret target before dispatch, never cached identity. */
  locate: (lobbyId: string) => void;
  hasCreationReference: () => boolean;
}>;
export const validLobbyLocator = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 256 &&
  !!value.trim() &&
  value.isWellFormed() &&
  !value.includes('\0');
export const lobbyFragment = (lobbyId: string): string =>
  `#${new URLSearchParams({ lobby: lobbyId })}`;
export function readLobbyLocator(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const lobbyId = params.get('lobby');
  return [...params].length === 1 && validLobbyLocator(lobbyId) ? lobbyId : null;
}
const error = (code: Extract<MembershipResult, { type: 'error' }>['code']): MembershipResult => ({
  type: 'error',
  code,
});

/** Restore by default. Fresh issuance requires explicit new-guest consent and
 * must never replay an outstanding canonical creation under another guest. */
export class LobbyMembershipClient {
  readonly #dependencies: Dependencies;
  #pending: Promise<MembershipResult> | null = null;
  constructor(dependencies: Dependencies) {
    this.#dependencies = dependencies;
  }

  join(lobbyId: string, newGuest = false): Promise<MembershipResult> {
    if (this.#pending) return this.#pending;
    const operation = this.#join(lobbyId, newGuest);
    this.#pending = operation;
    void operation.finally(() => {
      if (this.#pending === operation) this.#pending = null;
    });
    return operation;
  }

  async #post(path: string, lobbyId?: string): Promise<Response> {
    return this.#dependencies.fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
      ...(lobbyId === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lobbyId }) }),
    });
  }

  async #join(lobbyId: string, newGuest: boolean): Promise<MembershipResult> {
    if (!validLobbyLocator(lobbyId)) return error('invalid-locator');
    try {
      const refresh = await this.#post('/api/guest/session/refresh');
      if (refresh.status !== 204) {
        if (refresh.status !== 401)
          return error(refresh.status === 429 ? 'rate-limited' : 'unavailable');
        if (!newGuest || this.#dependencies.hasCreationReference())
          return error('session-unavailable');
        const issued = await this.#post('/api/guest/session');
        if (issued.status !== 204)
          return error(
            issued.status === 401 || issued.status === 409
              ? 'session-unavailable'
              : issued.status === 429
                ? 'rate-limited'
                : 'unavailable',
          );
      }
      try {
        this.#dependencies.locate(lobbyId);
      } catch {
        return error('locator-unavailable');
      }
      const response = await this.#post('/api/lobbies/join', lobbyId);
      if (response.status !== 200)
        return error(
          response.status === 401
            ? 'session-unavailable'
            : response.status === 409
              ? 'admission-unavailable'
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
        value.lobbyId !== lobbyId ||
        !('seatId' in value) ||
        !validLobbyLocator(value.seatId) ||
        !('position' in value) ||
        typeof value.position !== 'number' ||
        !Number.isInteger(value.position) ||
        value.position < 0 ||
        value.position > 7 ||
        !('isOwner' in value) ||
        value.isOwner !== (value.position === 0)
      )
        return error('invalid-response');
      return {
        type: 'joined',
        membership: {
          lobbyId: value.lobbyId,
          seatId: value.seatId,
          position: value.position,
          isOwner: value.isOwner,
        } as LobbyMembership,
      };
    } catch {
      return error('unavailable');
    }
  }
}
