import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import type { BranchId, GameId } from '../game/ids.ts';
import type { RuntimeCheckpoint } from '../runtime/runtime.ts';
import type { HistorySnapshot } from './history.ts';
import { MemoryHistory } from './memory-history.ts';
import type { HistoryArchive } from './memory-history.ts';
import type { HistoryCache } from './history-cache.ts';
import { jsonDigest } from './json-digest.ts';
import type { LobbyBinding, MatchStart } from './lobby-contracts.ts';

export type StoredGame = Readonly<{
  schemaVersion: 1;
  history: HistoryArchive;
  snapshot: HistorySnapshot;
  checkpoint: RuntimeCheckpoint;
  /** Optional for backward compatibility with frames written before cache support. */
  cache?: HistoryCache;
}>;

function frame(history: MemoryHistory, checkpoint: RuntimeCheckpoint): StoredGame {
  const snapshot = history.read();
  if (!isDeepStrictEqual(snapshot.head, checkpoint.head))
    throw new Error('Checkpoint does not match staged history');
  return {
    schemaVersion: 1,
    history: history.archive(),
    snapshot,
    checkpoint: structuredClone(checkpoint),
    cache: history.snapshot(),
  };
}

async function writeFrame(
  client: PoolClient,
  payload: StoredGame,
  revision: string,
): Promise<string> {
  const head = payload.snapshot.head;
  const moved = await client.query<{ revision: string }>(
    `UPDATE penky_game_heads SET revision = revision + 1, branch_id = $3, head_version = $4
     WHERE game_id = $1 AND revision = $2 RETURNING revision::text`,
    [head.gameId, revision, head.branchId, head.version],
  );
  const next = moved.rows[0]?.revision;
  if (!next) throw new Error('Durable revision conflict');
  await client.query(
    'INSERT INTO penky_game_frames(game_id, revision, schema_version, payload, checksum) VALUES ($1, $2, 1, $3::jsonb, $4)',
    [head.gameId, next, JSON.stringify(payload), jsonDigest(payload)],
  );
  return next;
}

/** Explicit, transactional, checksum-checked migrations; requires DDL permission. */
export async function migrate(pool: Pool): Promise<void> {
  const migrations = await Promise.all(
    ['001_runtime.sql', '002_lobbies.sql', '003_guest_access.sql'].map(async (name, index) => {
      const sql = await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
      return { version: index + 1, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
  const client = await pool.connect();
  let broken = false;
  const onError = () => {
    broken = true;
  };
  client.on('error', onError);
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('penky:migrations', 0))");
    await client.query(
      'CREATE TABLE IF NOT EXISTS penky_schema_migrations (version integer PRIMARY KEY, checksum text NOT NULL)',
    );
    for (const migration of migrations) {
      const prior = await client.query<{ checksum: string }>(
        'SELECT checksum FROM penky_schema_migrations WHERE version = $1',
        [migration.version],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].checksum !== migration.checksum)
          throw new Error('Migration checksum mismatch');
      } else {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO penky_schema_migrations(version, checksum) VALUES ($1, $2)',
          [migration.version, migration.checksum],
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.removeListener('error', onError);
    client.release(broken);
  }
}

/** Private per-game durable session. One connection/advisory lease per live writer. */
export class PostgresSession {
  readonly history: MemoryHistory;
  #client: PoolClient;
  #gameId: GameId;
  #revision: string;
  #checkpoint: RuntimeCheckpoint | null;
  #closed = false;
  #saving = false;
  #failure: { error: Error | null };
  #onError: (error: Error) => void;

  private constructor(
    client: PoolClient,
    gameId: GameId,
    revision: string,
    history: MemoryHistory,
    checkpoint: RuntimeCheckpoint | null,
    failure: { error: Error | null },
    onError: (error: Error) => void,
  ) {
    this.#client = client;
    this.#gameId = gameId;
    this.#revision = revision;
    this.history = history;
    this.#checkpoint = checkpoint;
    this.#failure = failure;
    this.#onError = onError;
  }

  get checkpoint(): RuntimeCheckpoint | null {
    return structuredClone(this.#checkpoint);
  }

  static async open(
    pool: Pool,
    gameId: GameId,
    rootBranchId: BranchId,
    options: Readonly<{ recovery?: 'snapshot' | 'replay' }> = {},
  ): Promise<PostgresSession> {
    const client = await pool.connect();
    const failure: { error: Error | null } = { error: null };
    const onError = (error: Error) => {
      failure.error = error;
    };
    client.on('error', onError);
    try {
      const lease = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [`penky:game:${gameId}`],
      );
      if (!lease.rows[0]?.locked) throw new Error('Game already has a writer');
      await client.query("SELECT set_config('application_name', $1, false)", [
        `penky-game:${gameId}`,
      ]);
      await client.query(
        'INSERT INTO penky_game_heads(game_id, root_branch_id, branch_id) VALUES ($1, $2, $2) ON CONFLICT DO NOTHING',
        [gameId, rootBranchId],
      );
      const result = await client.query<{
        root_branch_id: string;
        revision: string;
        branch_id: string;
        head_version: number;
      }>(
        'SELECT root_branch_id, revision::text, branch_id, head_version FROM penky_game_heads WHERE game_id = $1',
        [gameId],
      );
      const head = result.rows[0]!;
      if (head.root_branch_id !== rootBranchId)
        throw new Error('Root branch does not match stored game');
      const stored = await PostgresSession.load(client, gameId);
      if (head.revision !== '0' && stored === null) throw new Error('Missing committed game frame');
      const history = stored
        ? stored.cache && options.recovery !== 'replay'
          ? MemoryHistory.restoreSnapshot(stored.history, stored.cache)
          : MemoryHistory.restore(stored.history)
        : new MemoryHistory(gameId, rootBranchId);
      if (
        stored &&
        (stored.history.rootBranchId !== rootBranchId ||
          !isDeepStrictEqual(history.read(), stored.snapshot) ||
          !isDeepStrictEqual(history.read().head, stored.checkpoint.head) ||
          head.branch_id !== stored.snapshot.head.branchId ||
          head.head_version !== stored.snapshot.head.version)
      )
        throw new Error('Stored snapshot disagrees with recovery or head');
      return new PostgresSession(
        client,
        gameId,
        head.revision,
        history,
        stored?.checkpoint ?? null,
        failure,
        onError,
      );
    } catch (error) {
      // Destroying the connection also releases any acquired session advisory lock.
      client.removeListener('error', onError);
      client.release(true);
      throw error;
    }
  }

  /** Read-only committed frame inspection; never returns an in-flight runtime draft. */
  static async load(
    database: Pick<Pool, 'query'> | PoolClient,
    gameId: GameId,
    revision?: string,
  ): Promise<StoredGame | null> {
    const result = await database.query<{ payload: StoredGame; checksum: string }>(
      `SELECT f.payload, f.checksum FROM penky_game_frames f JOIN penky_game_heads h USING(game_id)
       WHERE f.game_id = $1 AND f.revision = COALESCE($2::bigint, h.revision)`,
      [gameId, revision ?? null],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (
      row.payload.schemaVersion !== 1 ||
      row.payload.history.gameId !== gameId ||
      jsonDigest(row.payload) !== row.checksum
    )
      throw new Error('Invalid stored game frame');
    return structuredClone(row.payload);
  }

  /** Arrow binding lets the runtime receive this directly as its commit adapter. */
  commit = async (checkpoint: RuntimeCheckpoint): Promise<void> => {
    if (this.#closed || this.#failure.error)
      throw new Error('Durable session is unavailable', { cause: this.#failure.error });
    if (this.#saving) throw new Error('Concurrent durable commits are not allowed');
    if (checkpoint.head.gameId !== this.#gameId)
      throw new Error('Checkpoint does not match staged history');
    const payload = frame(this.history, checkpoint);
    this.#saving = true;
    try {
      await this.#client.query('BEGIN');
      const next = await writeFrame(this.#client, payload, this.#revision);
      await this.#client.query('COMMIT');
      this.#revision = next;
      this.#checkpoint = structuredClone(checkpoint);
    } catch (error) {
      await this.#client.query('ROLLBACK').catch(() => {});
      this.#failure.error = error instanceof Error ? error : new Error('Durable commit failed');
      throw error;
    } finally {
      this.#saving = false;
    }
  };

  static async createLobbyGame(
    pool: Pool,
    binding: LobbyBinding,
    request: MatchStart,
    history: MemoryHistory,
    checkpoint: RuntimeCheckpoint,
  ): Promise<PostgresSession> {
    const client = await pool.connect();
    const failure: { error: Error | null } = { error: null };
    const onError = (error: Error) => {
      failure.error = error;
    };
    client.on('error', onError);
    const session = new PostgresSession(
      client,
      request.gameId,
      '0',
      history,
      null,
      failure,
      onError,
    );
    try {
      const lease = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [`penky:game:${request.gameId}`],
      );
      if (!lease.rows[0]?.locked) throw new Error('Game already has a writer');
      return await session.#transition(binding, request, history, checkpoint);
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  startSuccessor(
    binding: LobbyBinding,
    request: MatchStart,
    history: MemoryHistory,
    checkpoint: RuntimeCheckpoint,
    oldCheckpoint: RuntimeCheckpoint,
  ): Promise<PostgresSession> {
    return this.#transition(binding, request, history, checkpoint, oldCheckpoint);
  }

  async #transition(
    binding: LobbyBinding,
    request: MatchStart,
    history: MemoryHistory,
    checkpoint: RuntimeCheckpoint,
    oldCheckpoint?: RuntimeCheckpoint,
  ): Promise<PostgresSession> {
    if (this.#closed || this.#failure.error || this.#saving)
      throw new Error('Durable session is unavailable');
    const next = frame(history, checkpoint);
    if (
      request.gameId !== next.snapshot.head.gameId ||
      request.branchId !== next.history.rootBranchId ||
      next.snapshot.state?.phase.type !== 'dealing' ||
      next.snapshot.state.phase.drawCount !== 0 ||
      next.snapshot.state.ownerId !== binding.ownerSeatId ||
      request.actorSessionId !== binding.ownerSessionId
    )
      throw new Error('Invalid next-match preparation');
    const old = oldCheckpoint ? frame(this.history, oldCheckpoint) : null;
    if (
      old &&
      (request.expectedGameId !== this.#gameId ||
        !isDeepStrictEqual(request.expectedHead, old.snapshot.head) ||
        old.snapshot.state?.phase.type !== 'finished' ||
        !old.history.operations.some((operation) => operation.type === 'close-rollback'))
    )
      throw new Error('Old match was not closed for handoff');
    if (!old && request.expectedHead !== null) throw new Error('Unexpected prior match head');
    this.#saving = true;
    try {
      if (old) {
        const lease = await this.#client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
          [`penky:game:${request.gameId}`],
        );
        if (!lease.rows[0]?.locked) throw new Error('Successor already has a writer');
      }
      await this.#client.query('BEGIN');
      const room = await this.#client.query<{
        current_game_id: string | null;
        owner_session_id: string;
        owner_seat_id: string;
      }>(
        'SELECT current_game_id, owner_session_id, owner_seat_id FROM penky_lobbies WHERE lobby_id = $1 FOR UPDATE',
        [binding.id],
      );
      const record = room.rows[0];
      if (
        !record ||
        record.owner_session_id !== binding.ownerSessionId ||
        record.owner_seat_id !== binding.ownerSeatId ||
        record.current_game_id !== request.expectedGameId ||
        (old === null && record.current_game_id !== null)
      )
        throw new Error('Lobby transition conflict');
      // Authenticated lobbies retain a durable clockwise roster. A join may win
      // after private preparation: validate again under this same lobby lock.
      // Empty membership preserves legacy trusted/internal lobby behavior.
      const roster = await this.#client.query<{ seat_id: string }>(
        'SELECT seat_id FROM penky_lobby_members WHERE lobby_id=$1 ORDER BY seat_index',
        [binding.id],
      );
      if (
        roster.rows.length &&
        !isDeepStrictEqual(
          request.seatIds,
          roster.rows.map((member) => member.seat_id),
        )
      )
        throw new Error('Lobby roster changed');
      if (old) await writeFrame(this.#client, old, this.#revision);
      await this.#client.query(
        'INSERT INTO penky_game_heads(game_id, root_branch_id, branch_id) VALUES ($1,$2,$2)',
        [request.gameId, request.branchId],
      );
      const revision = await writeFrame(this.#client, next, '0');
      await this.#client.query(
        'UPDATE penky_lobbies SET current_game_id = $2 WHERE lobby_id = $1',
        [binding.id, request.gameId],
      );
      await this.#client.query(
        'INSERT INTO penky_match_starts(lobby_id, command_id, request, game_id) VALUES ($1,$2,$3::jsonb,$4)',
        [binding.id, request.id, JSON.stringify(request), request.gameId],
      );
      await this.#client.query("SELECT set_config('application_name', $1, false)", [
        `penky-game:${request.gameId}`,
      ]);
      await this.#client.query('COMMIT');
      if (old)
        await this.#client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
          `penky:game:${this.#gameId}`,
        ]);
      this.#closed = true;
      return new PostgresSession(
        this.#client,
        request.gameId,
        revision,
        history,
        structuredClone(checkpoint),
        this.#failure,
        this.#onError,
      );
    } catch (error) {
      await this.#client.query('ROLLBACK').catch(() => {});
      this.#failure.error = error instanceof Error ? error : new Error('Match transition failed');
      this.#closed = true;
      this.#client.removeListener('error', this.#onError);
      this.#client.release(true);
      throw error;
    } finally {
      this.#saving = false;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#saving) throw new Error('Cannot close during a durable commit');
    this.#closed = true;
    if (this.#failure.error) {
      this.#client.removeListener('error', this.#onError);
      this.#client.release(true);
      return;
    }
    try {
      await this.#client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
        `penky:game:${this.#gameId}`,
      ]);
      await this.#client.query('RESET application_name');
      this.#client.removeListener('error', this.#onError);
      this.#client.release();
    } catch (error) {
      this.#client.removeListener('error', this.#onError);
      this.#client.release(true);
      throw error;
    }
  }
}
