import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { id } from '../game/ids.ts';
import type { GameId, LobbyId, SeatId, SessionId } from '../game/ids.ts';
import { MemoryHistory } from '../persistence/memory-history.ts';
import { PostgresSession } from '../persistence/postgres.ts';
import { createGuestToken, guestTokenHash, GUEST_TTL_MS } from './guest-session.ts';

type AccessCode =
  | 'invalid-time'
  | 'authentication-required'
  | 'membership-required'
  | 'owner-only'
  | 'lobby-unavailable'
  | 'lobby-full'
  | 'match-running'
  | 'storage-unavailable';
export class GuestAccessError extends Error {
  readonly code: AccessCode;
  constructor(code: AccessCode) {
    super(code);
    this.name = 'GuestAccessError';
    this.code = code;
  }
}
export type GuestSession = Readonly<{ sessionId: SessionId; expiresAtMs: number }>;
/** Server-private grant: the token must be emitted only as a Secure HttpOnly cookie. */
export type GuestGrant = Readonly<{ token: string; expiresAtMs: number }>;
/** Server-private authenticated binding, not a generic browser payload or a
 * reusable authorization capability. Recheck on every operation. Lobby membership
 * does not make a new seat a participant of an already-created match.
 */
export type GuestMembership = GuestSession &
  Readonly<{
    lobbyId: LobbyId;
    seatId: SeatId;
    position: number;
    isOwner: boolean;
    seatIds: readonly SeatId[];
    currentGameId: GameId | null;
  }>;
type LobbyRow = {
  owner_session_id: SessionId;
  owner_seat_id: SeatId;
  current_game_id: GameId | null;
};
type MemberRow = { session_id: SessionId; seat_id: SeatId; seat_index: number };

function time(nowMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > Number.MAX_SAFE_INTEGER - GUEST_TTL_MS)
    throw new GuestAccessError('invalid-time');
  return nowMs + GUEST_TTL_MS;
}

/** Durable guest identity/membership gate, no sockets or account system.
 * Time is trusted server wall time, not the rollbackable gameplay clock or a
 * browser timestamp. Queries never receive plaintext credentials.
 */
export class PostgresGuestAccess {
  readonly #pool: Pool;
  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async issue(nowMs: number): Promise<GuestGrant> {
    const expiresAtMs = time(nowMs);
    const token = createGuestToken();
    try {
      await this.#pool.query(
        'INSERT INTO penky_guest_sessions(session_id,token_hash,created_at_ms,last_seen_at_ms,expires_at_ms) VALUES ($1,$2,$3,$3,$4)',
        [id('session', randomUUID()), guestTokenHash(token), nowMs, expiresAtMs],
      );
      return { token, expiresAtMs };
    } catch {
      throw new GuestAccessError('storage-unavailable');
    }
  }

  async authenticate(token: unknown, nowMs: number): Promise<GuestSession | null> {
    try {
      return await this.#withSession(token, nowMs, async (_client, session) => session);
    } catch (error) {
      if (error instanceof GuestAccessError && error.code === 'authentication-required')
        return null;
      throw error;
    }
  }

  async revoke(token: unknown, nowMs: number): Promise<boolean> {
    time(nowMs);
    const hash = guestTokenHash(token);
    if (hash === null) return false;
    try {
      const result = await this.#pool.query(
        'UPDATE penky_guest_sessions SET revoked_at_ms=GREATEST($2,last_seen_at_ms) WHERE token_hash=$1 AND revoked_at_ms IS NULL AND created_at_ms <= $2 RETURNING session_id',
        [hash, nowMs],
      );
      return result.rowCount === 1;
    } catch {
      throw new GuestAccessError('storage-unavailable');
    }
  }

  /** lobbyId is a host-generated creation identity, not proof of ownership. */
  createLobby(token: unknown, lobbyId: LobbyId, nowMs: number): Promise<GuestMembership> {
    return this.#withSession(token, nowMs, async (client, session) => {
      const seatId = id('seat', randomUUID());
      const inserted = await client.query(
        'INSERT INTO penky_lobbies(lobby_id,owner_session_id,owner_seat_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING lobby_id',
        [lobbyId, session.sessionId, seatId],
      );
      const lobby = await this.#lobby(client, lobbyId);
      if (lobby.owner_session_id !== session.sessionId) throw new GuestAccessError('owner-only');
      if (inserted.rowCount)
        await client.query(
          'INSERT INTO penky_lobby_members(lobby_id,session_id,seat_id,seat_index) VALUES ($1,$2,$3,0)',
          [lobbyId, session.sessionId, seatId],
        );
      return this.#binding(session, lobbyId, lobby, await this.#members(client, lobbyId, lobby));
    });
  }

  joinLobby(token: unknown, lobbyId: LobbyId, nowMs: number): Promise<GuestMembership> {
    return this.#withSession(token, nowMs, async (client, session) => {
      const lobby = await this.#lobby(client, lobbyId);
      const members = await this.#members(client, lobbyId, lobby);
      if (!members.some((member) => member.session_id === session.sessionId)) {
        await this.#admission(client, lobby.current_game_id);
        if (members.length >= 8) throw new GuestAccessError('lobby-full');
        const member = {
          session_id: session.sessionId,
          seat_id: id('seat', randomUUID()),
          seat_index: members.length,
        };
        await client.query(
          'INSERT INTO penky_lobby_members(lobby_id,session_id,seat_id,seat_index) VALUES ($1,$2,$3,$4)',
          [lobbyId, member.session_id, member.seat_id, member.seat_index],
        );
        members.push(member);
      }
      return this.#binding(session, lobbyId, lobby, members);
    });
  }

  membership(token: unknown, lobbyId: LobbyId, nowMs: number): Promise<GuestMembership> {
    return this.#lookup(token, lobbyId, nowMs, false);
  }
  requireOwner(token: unknown, lobbyId: LobbyId, nowMs: number): Promise<GuestMembership> {
    return this.#lookup(token, lobbyId, nowMs, true);
  }
  #lookup(
    token: unknown,
    lobbyId: LobbyId,
    nowMs: number,
    owner: boolean,
  ): Promise<GuestMembership> {
    return this.#withSession(token, nowMs, async (client, session) => {
      const lobby = await this.#lobby(client, lobbyId);
      const binding = this.#binding(
        session,
        lobbyId,
        lobby,
        await this.#members(client, lobbyId, lobby),
      );
      if (owner && !binding.isOwner) throw new GuestAccessError('owner-only');
      return binding;
    });
  }

  async #withSession<T>(
    token: unknown,
    nowMs: number,
    operation: (client: PoolClient, session: GuestSession) => Promise<T>,
  ): Promise<T> {
    const expiresAtMs = time(nowMs);
    const hash = guestTokenHash(token);
    if (hash === null) throw new GuestAccessError('authentication-required');
    let client: PoolClient | undefined;
    let broken = false;
    const onError = () => {
      broken = true;
    };
    try {
      client = await this.#pool.connect();
      client.on('error', onError);
      await client.query('BEGIN');
      // UPDATE is also the row lock shared with revoke. A late older request
      // cannot shorten a later request's sliding lifetime.
      const result = await client.query<{ session_id: SessionId; expires_at_ms: string }>(
        `UPDATE penky_guest_sessions SET last_seen_at_ms=GREATEST(last_seen_at_ms,$2), expires_at_ms=GREATEST(expires_at_ms,$3)
         WHERE token_hash=$1 AND revoked_at_ms IS NULL AND expires_at_ms > $2 AND created_at_ms <= $2
         RETURNING session_id,expires_at_ms::text`,
        [hash, nowMs, expiresAtMs],
      );
      const row = result.rows[0];
      if (!row) throw new GuestAccessError('authentication-required');
      const value = await operation(client, {
        sessionId: row.session_id,
        expiresAtMs: Number(row.expires_at_ms),
      });
      await client.query('COMMIT');
      return value;
    } catch (error) {
      if (client)
        await client.query('ROLLBACK').catch(() => {
          broken = true;
        });
      if (error instanceof GuestAccessError) throw error;
      throw new GuestAccessError('storage-unavailable');
    } finally {
      client?.removeListener('error', onError);
      client?.release(broken);
    }
  }

  async #lobby(client: PoolClient, lobbyId: LobbyId): Promise<LobbyRow> {
    const result = await client.query<LobbyRow>(
      'SELECT owner_session_id,owner_seat_id,current_game_id FROM penky_lobbies WHERE lobby_id=$1 FOR UPDATE',
      [lobbyId],
    );
    if (!result.rows[0]) throw new GuestAccessError('lobby-unavailable');
    return result.rows[0];
  }
  async #members(client: PoolClient, lobbyId: LobbyId, lobby: LobbyRow): Promise<MemberRow[]> {
    const result = await client.query<MemberRow>(
      'SELECT session_id,seat_id,seat_index FROM penky_lobby_members WHERE lobby_id=$1 ORDER BY seat_index',
      [lobbyId],
    );
    const members = result.rows;
    if (
      !members.length ||
      members[0]!.session_id !== lobby.owner_session_id ||
      members[0]!.seat_id !== lobby.owner_seat_id ||
      members.some((member, index) => member.seat_index !== index)
    )
      throw new GuestAccessError('lobby-unavailable');
    return members;
  }
  #binding(
    session: GuestSession,
    lobbyId: LobbyId,
    lobby: LobbyRow,
    members: readonly MemberRow[],
  ): GuestMembership {
    const member = members.find((member) => member.session_id === session.sessionId);
    if (!member) throw new GuestAccessError('membership-required');
    return {
      sessionId: session.sessionId,
      expiresAtMs: session.expiresAtMs,
      lobbyId,
      seatId: member.seat_id,
      position: member.seat_index,
      isOwner:
        lobby.owner_session_id === session.sessionId && lobby.owner_seat_id === member.seat_id,
      seatIds: members.map((member) => member.seat_id),
      currentGameId: lobby.current_game_id,
    };
  }

  async #admission(client: PoolClient, gameId: GameId | null): Promise<void> {
    if (gameId === null) return;
    try {
      // Match handoff also takes lobby then game-head locks. Never await a runtime
      // queue while holding these locks. Separate statements see the revision that
      // actually won a lock wait, not a stale joined frame from a prior snapshot.
      const result = await client.query<{
        revision: string;
        branch_id: string;
        head_version: number;
        root_branch_id: string;
      }>(
        'SELECT revision::text,branch_id,head_version,root_branch_id FROM penky_game_heads WHERE game_id=$1 FOR UPDATE',
        [gameId],
      );
      const head = result.rows[0];
      if (!head) throw new Error();
      const stored = await PostgresSession.load(client, gameId, head.revision);
      if (!stored) throw new Error();
      const history = stored.cache
        ? MemoryHistory.restoreSnapshot(stored.history, stored.cache)
        : MemoryHistory.restore(stored.history);
      if (
        stored.history.rootBranchId !== head.root_branch_id ||
        !isDeepStrictEqual(history.read(), stored.snapshot) ||
        !isDeepStrictEqual(stored.snapshot.head, stored.checkpoint.head) ||
        stored.snapshot.head.branchId !== head.branch_id ||
        stored.snapshot.head.version !== head.head_version
      )
        throw new Error();
      // A reserved current match restored before creation is not a completed
      // match. Keep admission closed rather than infer a new roster from null.
      if (stored.snapshot.state?.phase.type !== 'finished')
        throw new GuestAccessError('match-running');
    } catch (error) {
      if (error instanceof GuestAccessError) throw error;
      throw new GuestAccessError('lobby-unavailable');
    }
  }
}
