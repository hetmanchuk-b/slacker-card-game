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

export type StoredGame = Readonly<{
  schemaVersion: 1;
  history: HistoryArchive;
  snapshot: HistorySnapshot;
  checkpoint: RuntimeCheckpoint;
  /** Optional for backward compatibility with frames written before cache support. */
  cache?: HistoryCache;
}>;

/** Explicit, transactional, checksum-checked migrations; requires DDL permission. */
export async function migrate(pool: Pool): Promise<void> {
  const sql = await readFile(new URL('../../migrations/001_runtime.sql', import.meta.url), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
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
    const prior = await client.query<{ checksum: string }>(
      'SELECT checksum FROM penky_schema_migrations WHERE version = 1',
    );
    if (prior.rows[0]) {
      if (prior.rows[0].checksum !== checksum) throw new Error('Migration checksum mismatch');
    } else {
      await client.query(sql);
      await client.query('INSERT INTO penky_schema_migrations(version, checksum) VALUES (1, $1)', [
        checksum,
      ]);
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
    const snapshot = this.history.read();
    if (
      !isDeepStrictEqual(snapshot.head, checkpoint.head) ||
      checkpoint.head.gameId !== this.#gameId
    )
      throw new Error('Checkpoint does not match staged history');
    const payload: StoredGame = {
      schemaVersion: 1,
      history: this.history.archive(),
      snapshot,
      checkpoint: structuredClone(checkpoint),
      cache: this.history.snapshot(),
    };
    const encoded = JSON.stringify(payload);
    const checksum = jsonDigest(payload);
    this.#saving = true;
    try {
      await this.#client.query('BEGIN');
      const moved = await this.#client.query<{ revision: string }>(
        `UPDATE penky_game_heads SET revision = revision + 1, branch_id = $3, head_version = $4
         WHERE game_id = $1 AND revision = $2 RETURNING revision::text`,
        [this.#gameId, this.#revision, snapshot.head.branchId, snapshot.head.version],
      );
      const next = moved.rows[0]?.revision;
      if (!next) throw new Error('Durable revision conflict');
      await this.#client.query(
        'INSERT INTO penky_game_frames(game_id, revision, schema_version, payload, checksum) VALUES ($1, $2, 1, $3::jsonb, $4)',
        [this.#gameId, next, encoded, checksum],
      );
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
      this.#client.removeListener('error', this.#onError);
      this.#client.release();
    } catch (error) {
      this.#client.removeListener('error', this.#onError);
      this.#client.release(true);
      throw error;
    }
  }
}
