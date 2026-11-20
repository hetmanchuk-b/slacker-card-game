import { GameStream, object, exact, head } from './game-stream.ts';
import type { GameSnapshot, Draw } from './game-stream.ts';
import { PUBLIC_REJECTIONS } from '../protocol/contracts.ts';
import { validLobbyLocator as text } from './lobby-membership.ts';
export type GameSocket = {
  readonly connected: boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  connect: () => void;
  disconnect: () => void;
  /** Adapter must use volatile delivery, never Socket.IO's offline send buffer. */
  send: (message: object) => void;
};
type Start = Readonly<{
  protocolVersion: 1;
  requestId: string;
  intent: Readonly<{ type: 'start-match'; lobbyId: string; expected: null }>;
}>;
export type ConnectionState = Readonly<{
  status:
    | 'disconnected'
    | 'connecting'
    | 'attaching'
    | 'starting'
    | 'attached'
    | 'observing'
    | 'uncertain'
    | 'failed';
  view: GameSnapshot | null;
  draw: Draw | null;
  drawStatus: 'none' | 'pending' | 'played' | 'violation' | 'rejected' | 'uncertain';
  assigned: boolean;
  retry: boolean;
  note:
    | 'none'
    | 'unavailable'
    | 'unauthorized'
    | 'invalid-message'
    | 'storage-unavailable'
    | 'start-rejected';
}>;
type Dependencies = Readonly<{
  lobbyId: string;
  seatId: string;
  isOwner: boolean;
  factory: () => GameSocket;
  requestId: () => string;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  schedule?: (timeout: () => void) => () => void;
  onBusy?: (busy: boolean) => void;
  now?: () => number;
  scheduleReveal?: (callback: () => void, delay: number) => () => void;
}>;
export class GameConnection {
  readonly #deps: Dependencies;
  readonly #key: string;
  #socket: GameSocket | null = null;
  #generation = 0;
  #stream: GameStream;
  #pending: 'connect' | 'resync' | 'start' | 'draw' | null = null;
  #drawRequest: string | null = null;
  #cancelReveal: (() => void) | null = null;
  #cancel: (() => void) | null = null;
  #listener: ((state: ConnectionState) => void) | null = null;
  #start: Start | null = null;
  #busy = false;
  #storageBlocked = false;
  current: ConnectionState = {
    status: 'disconnected',
    view: null,
    draw: null,
    drawStatus: 'none',
    assigned: false,
    retry: false,
    note: 'none',
  };
  constructor(dependencies: Dependencies) {
    this.#deps = dependencies;
    this.#key = `penky.first-start.v1.${dependencies.lobbyId}`;
    this.#stream = new GameStream(dependencies.seatId, dependencies.now);
    try {
      const saved = dependencies.storage.getItem(this.#key);
      if (saved !== null) {
        const value: unknown = JSON.parse(saved);
        if (
          !object(value) ||
          Object.keys(value).length !== 3 ||
          value.version !== 1 ||
          value.expected !== null ||
          !text(value.requestId) ||
          value.requestId.length > 128
        )
          throw Error();
        this.#start = this.#makeStart(value.requestId);
        this.current = { ...this.current, retry: true };
      }
    } catch {
      this.#storageBlocked = true;
      this.current = { ...this.current, note: 'storage-unavailable' };
    }
  }
  subscribe(listener: (state: ConnectionState) => void): () => void {
    this.#listener = listener;
    listener(this.current);
    return () => {
      this.#listener = null;
    };
  }
  #publish(next: Partial<ConnectionState> = {}) {
    this.current = { ...this.current, ...next };
    const busy = this.#pending !== null;
    if (busy !== this.#busy) {
      this.#busy = busy;
      this.#deps.onBusy?.(busy);
    }
    this.#listener?.(this.current);
  }
  #deadline() {
    this.#cancel?.();
    const schedule =
      this.#deps.schedule ??
      ((timeout: () => void) => {
        const timer = setTimeout(timeout, 15000);
        return () => clearTimeout(timer);
      });
    this.#cancel = schedule(() => this.#fail('unavailable', 'uncertain'));
  }
  #finish() {
    this.#cancel?.();
    this.#cancel = null;
    this.#pending = null;
  }
  #drop() {
    this.#generation++;
    const socket = this.#socket;
    this.#socket = null;
    socket?.disconnect();
    this.#cancelReveal?.();
    this.#cancelReveal = null;
    this.#stream = new GameStream(this.#deps.seatId, this.#deps.now);
  }
  #fail(note: ConnectionState['note'], status: ConnectionState['status'] = 'failed') {
    const uncertain = this.#pending === 'draw';
    this.#finish();
    this.#drop();
    this.#publish({
      status: uncertain ? 'uncertain' : status,
      note,
      view: null,
      draw: null,
      ...(uncertain ? { drawStatus: 'uncertain' } : {}),
    });
  }
  close() {
    this.#finish();
    this.#drop();
    this.#publish({ status: 'disconnected', view: null, draw: null });
  }
  connect() {
    if (this.#pending) return;
    this.#open();
  }
  #open() {
    this.#finish();
    this.#drop();
    const generation = this.#generation;
    const socket = this.#deps.factory();
    this.#socket = socket;
    const live = () => generation === this.#generation && socket === this.#socket;
    // Install before connect; receipt is transport credit, not animation completion.
    socket.on('server-message', (message, receipt, acknowledge) => {
      if (typeof receipt !== 'string' || !text(receipt) || typeof acknowledge !== 'function') {
        if (live()) this.#fail('invalid-message');
        return;
      }
      try {
        acknowledge(receipt);
      } catch {
        if (live()) this.#fail('invalid-message');
        return;
      }
      if (live()) this.#receive(message);
    });
    socket.on('connect', () => {
      if (!live()) return;
      this.#pending = 'resync';
      this.#deadline();
      this.#publish({ status: 'attaching' });
      if (socket.connected)
        socket.send({
          protocolVersion: 1,
          requestId: this.#deps.requestId(),
          intent: { type: 'resync', lobbyId: this.#deps.lobbyId },
        });
    });
    socket.on('disconnect', () => {
      if (live())
        this.#fail('unavailable', this.#pending === 'start' ? 'uncertain' : 'disconnected');
    });
    socket.on('connect_error', () => {
      if (live()) this.#fail('unavailable');
    });
    this.#pending = 'connect';
    this.#deadline();
    this.#publish({
      status: 'connecting',
      view: null,
      draw: null,
      note: this.current.note === 'storage-unavailable' ? 'storage-unavailable' : 'none',
    });
    socket.connect();
  }
  #makeStart(requestId: string): Start {
    return {
      protocolVersion: 1,
      requestId,
      intent: { type: 'start-match', lobbyId: this.#deps.lobbyId, expected: null },
    };
  }
  startFirst() {
    if (
      !this.#deps.isOwner ||
      this.#pending ||
      !this.#socket?.connected ||
      !['attached', 'observing'].includes(this.current.status) ||
      (this.current.assigned && !this.#start) ||
      this.#storageBlocked
    )
      return;
    if (!this.#start) {
      try {
        const id = this.#deps.requestId();
        if (!text(id) || id.length > 128) throw Error();
        this.#deps.storage.setItem(
          this.#key,
          JSON.stringify({ version: 1, requestId: id, expected: null }),
        );
        this.#start = this.#makeStart(id);
      } catch {
        this.#storageBlocked = true;
        this.#publish({ note: 'storage-unavailable' });
        return;
      }
    }
    this.#pending = 'start';
    this.#deadline();
    this.#publish({ status: 'starting', retry: true, note: 'none' });
    this.#socket.send(this.#start);
  }
  drawCard() {
    const view = this.current.view;
    if (
      this.#pending ||
      !this.#socket?.connected ||
      this.current.status !== 'observing' ||
      !view?.state ||
      view.paused ||
      view.state.phase !== 'dealing'
    )
      return;
    // No next-recipient/turn or local legality gate. Each click is a new intent.
    this.#drawRequest = this.#deps.requestId();
    this.#pending = 'draw';
    this.#deadline();
    this.#publish({ drawStatus: 'pending' });
    this.#socket.send({
      protocolVersion: 1,
      requestId: this.#drawRequest,
      intent: {
        type: 'draw-card',
        gameId: view.head.gameId,
        branchId: view.head.branchId,
      },
    });
  }
  #armReveal() {
    this.#cancelReveal?.();
    this.#cancelReveal = null;
    const reveal = this.#stream.snapshot?.reveal;
    if (!reveal) return;
    const schedule =
      this.#deps.scheduleReveal ??
      ((callback: () => void, delay: number) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      });
    this.#cancelReveal = schedule(
      () => {
        this.#stream.expireReveal();
        this.#publish({ view: this.#stream.snapshot });
        this.#armReveal();
      },
      Math.max(0, reveal.expiresAt - (this.#deps.now?.() ?? performance.now())),
    );
  }
  #receive(message: unknown) {
    if (!object(message) || message.protocolVersion !== 1) {
      this.#fail('invalid-message');
      return;
    }
    if (message.type === 'error') {
      if (message.code === 'unavailable' && this.#pending === 'resync') {
        this.#finish();
        this.#publish({
          status: 'attached',
          note: this.#storageBlocked ? 'storage-unavailable' : 'unavailable',
          view: null,
        });
      } else
        this.#fail(
          message.code === 'unauthorized' ? 'unauthorized' : 'unavailable',
          this.#pending === 'start' ? 'uncertain' : 'failed',
        );
      return;
    }
    if (message.type === 'command-ack') {
      if (this.#pending !== 'draw' || message.requestId !== this.#drawRequest) return;
      const r = message.result;
      if (!object(r) || !head(r.head)) {
        this.#fail('invalid-message');
        return;
      }
      if (
        exact(r, ['type', 'outcome', 'head', 'duplicate']) &&
        r.type === 'accepted' &&
        (r.outcome === 'played' || r.outcome === 'violation' || r.outcome === 'control') &&
        typeof r.duplicate === 'boolean'
      ) {
        this.#finish();
        this.#publish({ drawStatus: r.outcome === 'violation' ? 'violation' : 'played' });
      } else if (
        exact(r, ['type', 'code', 'head']) &&
        r.type === 'rejected' &&
        typeof r.code === 'string' &&
        PUBLIC_REJECTIONS.some((code) => code === r.code)
      ) {
        this.#finish();
        this.#publish({ drawStatus: 'rejected' });
      } else this.#fail('invalid-message');
      return;
    }
    if (message.type === 'match-start-ack') {
      if (this.#pending !== 'start' || message.requestId !== this.#start?.requestId) return;
      if (!object(message.result)) {
        this.#fail('invalid-message', 'uncertain');
        return;
      }
      if (
        message.result.type === 'started' &&
        text(message.result.gameId) &&
        typeof message.result.duplicate === 'boolean'
      ) {
        // Never apply ack identity/head as state. A new physical connection fences
        // old, uncorrelated in-flight packets and explicitly requests state only.
        this.#open();
      } else if (message.result.type === 'rejected') {
        this.#finish();
        this.#publish({
          status: this.current.view ? 'observing' : 'attached',
          note: 'start-rejected',
        });
      } else this.#fail('invalid-message', 'uncertain');
      return;
    }
    const result = this.#stream.receive(message);
    if (result === 'invalid') {
      this.#fail('invalid-message');
      return;
    }
    if (result === 'ignored') return;
    if (this.#stream.reset) {
      if (this.#pending === 'draw') this.#finish();
      this.#publish({ drawStatus: 'none', draw: null });
    }
    this.#armReveal();
    if (result === 'state') {
      if (this.#pending === 'resync') this.#finish();
      this.#publish({
        status: this.#pending === 'start' ? 'starting' : 'observing',
        assigned: true,
        view: this.#stream.snapshot,
        draw: this.#stream.draw,
        note: this.current.note === 'storage-unavailable' ? 'storage-unavailable' : 'none',
      });
    } else this.#publish({ view: this.#stream.snapshot, draw: this.#stream.draw });
  }
}
