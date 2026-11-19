import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import type { RuntimeSnapshot, RuntimeOptions } from '../runtime/runtime.ts';
import { PostgresSession } from './postgres.ts';
import { MemoryHistory } from './memory-history.ts';
import type { MatchStart } from './lobby-contracts.ts';
import { GameRuntime } from '../runtime/runtime.ts';
import type {
  LobbyBinding,
  LobbyRecord,
  ChatInput,
  ChatMessage,
  ChatContext,
} from './lobby-contracts.ts';

export class ChatAdmissionError extends Error {
  readonly code: 'unauthorized' | 'unavailable';
  constructor(code: 'unauthorized' | 'unavailable') {
    super('Chat admission denied');
    this.name = 'ChatAdmissionError';
    this.code = code;
  }
}
export type ChatAdmissionOptions = Readonly<{
  /** Trusted bounded non-reentrant gate, inside queue admission before lookup. */
  admit?: () => boolean | Promise<boolean>;
}>;
export async function admitChat(options: ChatAdmissionOptions): Promise<void> {
  if (!options.admit) return;
  let permitted: boolean;
  try {
    permitted = (await options.admit()) === true;
  } catch {
    throw new ChatAdmissionError('unavailable');
  }
  if (!permitted) throw new ChatAdmissionError('unauthorized');
}

function context(snapshot: RuntimeSnapshot): ChatContext {
  const state = snapshot.state;
  if (!state || state.phase.type === 'finished')
    return { head: snapshot.head, scope: 'lobby', scopeNumber: null };
  if (state.phase.type === 'round')
    return { head: snapshot.head, scope: 'round', scopeNumber: state.phase.number };
  if (state.completedRounds === 0) return { head: snapshot.head, scope: 'dealing', scopeNumber: 0 };
  return { head: snapshot.head, scope: 'between-rounds', scopeNumber: state.completedRounds };
}

export type LiveMatch = Readonly<{ session: PostgresSession; runtime: GameRuntime }>;
export type MatchStartResult =
  | (LiveMatch & Readonly<{ type: 'started'; gameId: MatchStart['gameId'] }>)
  | Readonly<{ type: 'duplicate'; gameId: MatchStart['gameId'] }>
  | Readonly<{
      type: 'rejected';
      code:
        | 'owner-only'
        | 'game-mismatch'
        | 'match-not-finished'
        | 'invalid-configuration'
        | 'command-id-reused'
        | 'stale-head';
    }>;

/** Trusted server storage, not a browser authorization interface. */
export class PostgresLobby {
  #pool: Pool;
  #binding: LobbyBinding;
  #startTail: Promise<void> = Promise.resolve();

  private constructor(pool: Pool, binding: LobbyBinding) {
    this.#pool = pool;
    this.#binding = { ...binding };
  }

  static async create(pool: Pool, binding: LobbyBinding): Promise<PostgresLobby> {
    await pool.query(
      'INSERT INTO penky_lobbies(lobby_id, owner_session_id, owner_seat_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [binding.id, binding.ownerSessionId, binding.ownerSeatId],
    );
    const lobby = new PostgresLobby(pool, binding);
    const record = await lobby.read();
    if (
      record.ownerSessionId !== binding.ownerSessionId ||
      record.ownerSeatId !== binding.ownerSeatId
    )
      throw new Error('Lobby ownership mismatch');
    return lobby;
  }

  static async open(pool: Pool, lobbyId: LobbyBinding['id']): Promise<PostgresLobby> {
    const result = await pool.query<{
      owner_session_id: LobbyBinding['ownerSessionId'];
      owner_seat_id: LobbyBinding['ownerSeatId'];
    }>('SELECT owner_session_id, owner_seat_id FROM penky_lobbies WHERE lobby_id = $1', [lobbyId]);
    const row = result.rows[0];
    if (!row) throw new Error('Unknown lobby');
    return new PostgresLobby(pool, {
      id: lobbyId,
      ownerSessionId: row.owner_session_id,
      ownerSeatId: row.owner_seat_id,
    });
  }

  async read(): Promise<LobbyRecord> {
    const result = await this.#pool.query<{
      owner_session_id: LobbyBinding['ownerSessionId'];
      owner_seat_id: LobbyBinding['ownerSeatId'];
      current_game_id: LobbyRecord['currentGameId'];
    }>(
      'SELECT owner_session_id, owner_seat_id, current_game_id FROM penky_lobbies WHERE lobby_id = $1',
      [this.#binding.id],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Unknown lobby');
    return {
      id: this.#binding.id,
      ownerSessionId: row.owner_session_id,
      ownerSeatId: row.owner_seat_id,
      currentGameId: row.current_game_id,
    };
  }

  startMatch(
    input: MatchStart,
    inputs: Omit<RuntimeOptions, 'history' | 'commit'>,
    current?: LiveMatch,
  ): Promise<MatchStartResult> {
    const request = structuredClone(input);
    const result = this.#startTail.then(() => this.#start(request, { ...inputs }, current));
    this.#startTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Private canonical intent lookup; contains server card identities, never a client payload. */
  async startReceipt(
    commandId: MatchStart['id'],
  ): Promise<Readonly<{ request: MatchStart; gameId: MatchStart['gameId'] }> | null> {
    const result = await this.#pool.query<{ request: MatchStart; game_id: MatchStart['gameId'] }>(
      'SELECT request, game_id FROM penky_match_starts WHERE lobby_id = $1 AND command_id = $2',
      [this.#binding.id, commandId],
    );
    const row = result.rows[0];
    return row ? { request: row.request, gameId: row.game_id } : null;
  }

  async #start(
    request: MatchStart,
    inputs: Omit<RuntimeOptions, 'history' | 'commit'>,
    current?: LiveMatch,
  ): Promise<MatchStartResult> {
    const room = await this.read();
    if (request.actorSessionId !== room.ownerSessionId)
      return { type: 'rejected', code: 'owner-only' };
    const previous = await this.startReceipt(request.id);
    if (previous)
      return isDeepStrictEqual(previous.request, request)
        ? { type: 'duplicate', gameId: previous.gameId }
        : { type: 'rejected', code: 'command-id-reused' };
    if (
      room.currentGameId !== request.expectedGameId ||
      (current?.runtime.read().head.gameId ?? null) !== room.currentGameId
    )
      return { type: 'rejected', code: 'game-mismatch' };
    if (request.gameId === room.currentGameId)
      return { type: 'rejected', code: 'invalid-configuration' };
    if (!isDeepStrictEqual(request.expectedHead, current?.runtime.read().head ?? null))
      return { type: 'rejected', code: 'stale-head' };
    if (current && current.runtime.read().state?.phase.type !== 'finished')
      return { type: 'rejected', code: 'match-not-finished' };
    const history = new MemoryHistory(request.gameId, request.branchId);
    const sink: { session: PostgresSession | null } = { session: null };
    // Private preparation: no reference escapes before the atomic durable transition.
    const runtime = await GameRuntime.create({
      ...inputs,
      history,
      commit: async (checkpoint) => {
        if (sink.session) await sink.session.commit(checkpoint);
      },
    });
    let handingOff = false;
    try {
      const started = await runtime.dispatch({
        type: 'start-game',
        id: request.id,
        gameId: request.gameId,
        ownerId: room.ownerSeatId,
        seatIds: request.seatIds,
        cardIds: request.cardIds,
      });
      if (started.type !== 'accepted') {
        await runtime.dispose();
        return { type: 'rejected', code: 'invalid-configuration' };
      }
      const checkpoint = await runtime.checkpoint();
      if (current) {
        handingOff = true;
        const moved = await current.runtime.handoff(async (oldCheckpoint) => {
          sink.session = await current.session.startSuccessor(
            this.#binding,
            request,
            history,
            checkpoint,
            oldCheckpoint,
          );
        }, request.expectedHead ?? undefined);
        if (!moved) {
          await runtime.dispose();
          return {
            type: 'rejected',
            code: isDeepStrictEqual(request.expectedHead, current.runtime.read().head)
              ? 'match-not-finished'
              : 'stale-head',
          };
        }
      } else
        sink.session = await PostgresSession.createLobbyGame(
          this.#pool,
          this.#binding,
          request,
          history,
          checkpoint,
        );
      if (!sink.session) throw new Error('Missing successor session');
      return { type: 'started', gameId: request.gameId, session: sink.session, runtime };
    } catch (error) {
      await runtime.dispose();
      if (sink.session) await sink.session.close();
      if (handingOff && current) await current.session.close();
      throw error;
    }
  }

  async messages(afterSequence = '0', limit = 100): Promise<readonly ChatMessage[]> {
    if (!/^\d+$/.test(afterSequence) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('Invalid chat page');
    const result = await this.#pool.query<{ message: ChatMessage }>(
      `SELECT jsonb_build_object('id', message_id, 'authorSessionId', author_session_id, 'authorSeatId', author_seat_id,
       'text', body, 'lobbyId', lobby_id, 'sequence', sequence::text, 'atMs', at_ms, 'context', context) AS message
       FROM penky_lobby_chat WHERE lobby_id = $1 AND sequence > $2::bigint ORDER BY sequence LIMIT $3`,
      [this.#binding.id, afterSequence, limit],
    );
    return result.rows.map((row) => row.message);
  }

  message(messageId: ChatInput['id']): Promise<ChatMessage | null> {
    return this.#lookupMessage(this.#pool, messageId);
  }

  async #lookupMessage(
    database: Pick<Pool, 'query'> | PoolClient,
    messageId: ChatInput['id'],
  ): Promise<ChatMessage | null> {
    const result = await database.query<{ message: ChatMessage }>(
      `SELECT jsonb_build_object('id', message_id, 'authorSessionId', author_session_id, 'authorSeatId', author_seat_id,
       'text', body, 'lobbyId', lobby_id, 'sequence', sequence::text, 'atMs', at_ms, 'context', context) AS message
       FROM penky_lobby_chat WHERE lobby_id = $1 AND message_id = $2`,
      [this.#binding.id, messageId],
    );
    return result.rows[0]?.message ?? null;
  }

  async #findMessage(
    database: Pick<Pool, 'query'> | PoolClient,
    input: ChatInput,
  ): Promise<ChatMessage | null> {
    const prior = await this.#lookupMessage(database, input.id);
    if (!prior) return null;
    const { id, authorSessionId, authorSeatId, text } = prior;
    if (!isDeepStrictEqual({ id, authorSessionId, authorSeatId, text }, input))
      throw new Error('Chat message ID reused');
    return prior;
  }

  async postChat(
    input: ChatInput,
    nowMs: number,
    runtime?: GameRuntime,
    options: ChatAdmissionOptions = {},
  ): Promise<ChatMessage> {
    const message = structuredClone(input);
    const origin = { ...options };
    if (
      !Number.isSafeInteger(nowMs) ||
      nowMs < 0 ||
      !message.text.length ||
      !message.text.isWellFormed() ||
      message.text.includes('\0')
    )
      throw new Error('Invalid chat input');
    const append = async (chatContext: ChatContext, atMs: number): Promise<ChatMessage> => {
      await admitChat(origin);
      const prior = await this.#findMessage(this.#pool, message);
      if (prior) return prior;
      const client = await this.#pool.connect();
      let broken = false;
      const onError = () => {
        broken = true;
      };
      client.on('error', onError);
      try {
        await client.query('BEGIN');
        const room = await client.query<{ current_game_id: string | null }>(
          'SELECT current_game_id FROM penky_lobbies WHERE lobby_id = $1 FOR UPDATE',
          [this.#binding.id],
        );
        const duplicate = await this.#findMessage(client, message);
        if (duplicate) {
          await client.query('COMMIT');
          return duplicate;
        }
        if (room.rows[0]?.current_game_id !== (chatContext.head?.gameId ?? null))
          throw new Error('Chat lobby/game context changed');
        if (chatContext.head) {
          const head = await client.query<{ branch_id: string; head_version: number }>(
            'SELECT branch_id, head_version FROM penky_game_heads WHERE game_id = $1',
            [chatContext.head.gameId],
          );
          if (
            head.rows[0]?.branch_id !== chatContext.head.branchId ||
            head.rows[0]?.head_version !== chatContext.head.version
          )
            throw new Error('Chat game head changed');
        }
        const inserted = await client.query<{ sequence: string }>(
          `INSERT INTO penky_lobby_chat(lobby_id, message_id, author_session_id, author_seat_id, body, at_ms, context)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING sequence::text`,
          [
            this.#binding.id,
            message.id,
            message.authorSessionId,
            message.authorSeatId,
            message.text,
            atMs,
            JSON.stringify(chatContext),
          ],
        );
        await client.query('COMMIT');
        return {
          ...message,
          lobbyId: this.#binding.id,
          sequence: inserted.rows[0]!.sequence,
          atMs,
          context: chatContext,
        };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.removeListener('error', onError);
        client.release(broken);
      }
    };
    return runtime
      ? runtime.observe((snapshot, atMs) => append(context(snapshot), atMs))
      : append({ head: null, scope: 'lobby', scopeNumber: null }, nowMs);
  }
}
