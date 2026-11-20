import { exact, head, object } from './game-stream.ts';
import { validLobbyLocator as reference } from './lobby-membership.ts';
export const chatText = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 4096 &&
  v.isWellFormed() &&
  !v.includes('\0');
const sequence = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9]\d{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n;
export type ChatRow = Readonly<{
  id: string;
  lobbyId: string;
  authorSeatId: string | null;
  text: string;
  sequence: string;
  atMs: number;
  context: Readonly<{
    head: Readonly<{ gameId: string; branchId: string; version: number }> | null;
    scope: string;
    scopeNumber: number | null;
  }>;
}>;
function row(raw: unknown, lobbyId: string): ChatRow | null {
  if (
    !exact(raw, ['id', 'lobbyId', 'authorSeatId', 'text', 'sequence', 'atMs', 'context']) ||
    !reference(raw.id) ||
    raw.lobbyId !== lobbyId ||
    (raw.authorSeatId !== null && !reference(raw.authorSeatId)) ||
    !chatText(raw.text) ||
    !sequence(raw.sequence) ||
    raw.sequence === '0' ||
    !Number.isSafeInteger(raw.atMs) ||
    Number(raw.atMs) < 0 ||
    !exact(raw.context, ['head', 'scope', 'scopeNumber'])
  )
    return null;
  const c = raw.context;
  if (
    (c.head !== null && !head(c.head)) ||
    typeof c.scope !== 'string' ||
    !['lobby', 'dealing', 'between-rounds', 'round'].includes(c.scope)
  )
    return null;
  if (
    c.scope === 'lobby'
      ? c.scopeNumber !== null
      : c.head === null ||
        !Number.isSafeInteger(c.scopeNumber) ||
        Number(c.scopeNumber) < (c.scope === 'dealing' ? 0 : 1)
  )
    return null;
  return {
    id: raw.id,
    lobbyId,
    authorSeatId: raw.authorSeatId as string | null,
    text: raw.text,
    sequence: raw.sequence,
    atMs: Number(raw.atMs),
    context: {
      head: c.head === null ? null : { ...(c.head as NonNullable<ChatRow['context']['head']>) },
      scope: c.scope,
      scopeNumber: c.scopeNumber as number | null,
    },
  };
}
export class LobbyChat {
  readonly #lobby: string;
  readonly #seat: string;
  readonly #id: () => string;
  #original: { messageId: string; text: string } | null = null;
  #pending: { requestId: string; kind: 'post' | 'read'; after: string } | null = null;
  current: Readonly<{
    page: readonly ChatRow[];
    lastPost: ChatRow | null;
    cursor: string;
    empty: boolean;
    retry: boolean;
    status: 'idle' | 'pending' | 'confirmed' | 'uncertain' | 'invalid';
  }> = { page: [], lastPost: null, cursor: '0', empty: false, retry: false, status: 'idle' };
  constructor(lobbyId: string, seatId: string, id: () => string) {
    this.#lobby = lobbyId;
    this.#seat = seatId;
    this.#id = id;
  }
  get pending() {
    return this.#pending !== null;
  }
  get originalText() {
    return this.#original?.text ?? null;
  }
  post(text: string) {
    if (this.#pending || this.#original || !chatText(text)) return null;
    this.#original = { messageId: this.#id(), text };
    return this.retry();
  }
  retry() {
    if (this.#pending || !this.#original) return null;
    const requestId = this.#id();
    this.#pending = { requestId, kind: 'post', after: '0' };
    this.current = { ...this.current, status: 'pending', retry: true };
    return {
      protocolVersion: 1,
      requestId,
      intent: { type: 'post-chat', lobbyId: this.#lobby, ...this.#original },
    };
  }
  read(first = false) {
    if (this.#pending) return null;
    const requestId = this.#id(),
      after = first ? '0' : this.current.cursor;
    this.#pending = { requestId, kind: 'read', after };
    this.current = { ...this.current, status: 'pending' };
    return {
      protocolVersion: 1,
      requestId,
      intent: { type: 'chat-history', lobbyId: this.#lobby, afterSequence: after, limit: 100 },
    };
  }
  interrupt() {
    this.#pending = null;
    this.current = { ...this.current, status: 'uncertain', retry: this.#original !== null };
  }
  receive(raw: unknown): 'accepted' | 'ignored' | 'invalid' {
    if (!object(raw) || raw.requestId !== this.#pending?.requestId) return 'ignored';
    const pending = this.#pending!;
    const invalid = () => {
      this.interrupt();
      this.current = { ...this.current, status: 'invalid' };
      return 'invalid' as const;
    };
    if (
      !exact(raw, ['protocolVersion', 'type', 'requestId', 'messages']) ||
      raw.protocolVersion !== 1 ||
      raw.type !== 'chat-page' ||
      !Array.isArray(raw.messages) ||
      raw.messages.length > 100
    )
      return invalid();
    const rows = raw.messages.map((value) => row(value, this.#lobby));
    if (rows.some((value) => value === null)) return invalid();
    const messages = rows as ChatRow[];
    if (pending.kind === 'post') {
      const value = messages[0];
      if (
        messages.length !== 1 ||
        !value ||
        value.id !== this.#original?.messageId ||
        value.text !== this.#original.text ||
        value.authorSeatId !== this.#seat
      )
        return invalid();
      this.#original = null;
      this.current = { ...this.current, lastPost: value, retry: false, status: 'confirmed' };
    } else {
      let last = BigInt(pending.after);
      const ids = new Set<string>();
      for (const value of messages) {
        if (BigInt(value.sequence) <= last || ids.has(value.id)) return invalid();
        last = BigInt(value.sequence);
        ids.add(value.id);
      }
      this.current = {
        ...this.current,
        page: messages,
        cursor: messages.at(-1)?.sequence ?? pending.after,
        empty: messages.length === 0,
        status: 'confirmed',
      };
    }
    this.#pending = null;
    return 'accepted';
  }
}
