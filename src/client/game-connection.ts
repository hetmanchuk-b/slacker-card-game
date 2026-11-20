import { GameStream, object, exact, head, remainingTime } from './game-stream.ts';
import type { GameSnapshot, Draw, Transfer } from './game-stream.ts';
const penaltyScope = (view: GameSnapshot | null) =>
  view?.penalty
    ? JSON.stringify([view.head.gameId, view.head.branchId, view.penalty.timer.id])
    : null;
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
  penaltyStatus: 'none' | 'pending' | 'accepted' | 'rejected' | 'uncertain';
  selectedCardId: string | null;
  transfers: readonly Transfer[];
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
  #pending: 'connect' | 'resync' | 'start' | 'draw' | 'penalty' | null = null;
  #commandRequest: string | null = null;
  #pendingPenaltyScope: string | null = null;
  #selectionScope: string | null = null;
  #observedPenaltyScope: string | null = null;
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
    penaltyStatus: 'none',
    selectedCardId: null,
    transfers: [],
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
    const view = this.current.view;
    if (
      this.current.selectedCardId !== null &&
      (this.#selectionScope !== penaltyScope(view) ||
        !this.#canRespond() ||
        !view?.state ||
        view.state.own.hand.length < 2 ||
        !view.state.own.hand.some((c) => c.id === this.current.selectedCardId))
    ) {
      this.current = { ...this.current, selectedCardId: null };
      this.#selectionScope = null;
    }
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
    this.#pendingPenaltyScope = null;
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
    const drawUncertain = this.#pending === 'draw';
    const penaltyUncertain = this.#pending === 'penalty';
    const uncertain = drawUncertain || penaltyUncertain;
    this.#finish();
    this.#drop();
    this.#publish({
      status: uncertain ? 'uncertain' : status,
      note,
      view: null,
      draw: null,
      transfers: [],
      selectedCardId: null,
      ...(drawUncertain ? { drawStatus: 'uncertain' } : {}),
      ...(penaltyUncertain ? { penaltyStatus: 'uncertain' } : {}),
    });
  }
  close() {
    this.#finish();
    this.#drop();
    this.#publish({
      status: 'disconnected',
      view: null,
      draw: null,
      transfers: [],
      selectedCardId: null,
      penaltyStatus: 'none',
    });
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
      transfers: [],
      selectedCardId: null,
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
      view.state.phase !== 'dealing' ||
      view.hasProcedure
    )
      return;
    // No next-recipient/turn or local legality gate. Each click is a new intent.
    this.#commandRequest = this.#deps.requestId();
    this.#pending = 'draw';
    this.#deadline();
    this.#publish({ drawStatus: 'pending' });
    this.#socket.send({
      protocolVersion: 1,
      requestId: this.#commandRequest,
      intent: {
        type: 'draw-card',
        gameId: view.head.gameId,
        branchId: view.head.branchId,
      },
    });
  }
  #canRespond() {
    const view = this.current.view;
    const p = view?.penalty;
    return !!(
      this.#socket?.connected &&
      this.current.status === 'observing' &&
      view?.state &&
      !view.paused &&
      p &&
      !p.timer.paused &&
      remainingTime(p.timer, this.#deps.now?.() ?? performance.now()) > 0 &&
      p.eligibleSeatIds.includes(this.#deps.seatId) &&
      p.ownResponse === null
    );
  }
  selectPenaltyCard(cardId: string | null) {
    if (this.#pending || !this.#canRespond()) return;
    const hand = this.current.view!.state!.own.hand;
    if (cardId !== null && (hand.length < 2 || !hand.some((c) => c.id === cardId))) return;
    this.#selectionScope = penaltyScope(this.current.view);
    this.#publish({ selectedCardId: cardId });
  }
  respondToPenalty(cardId: string | null) {
    if (this.#pending || !this.#canRespond()) return;
    const view = this.current.view!;
    if (
      cardId !== null &&
      (view.state!.own.hand.length < 2 || !view.state!.own.hand.some((c) => c.id === cardId))
    )
      return;
    this.#commandRequest = this.#deps.requestId();
    this.#pendingPenaltyScope = penaltyScope(view);
    this.#pending = 'penalty';
    this.#deadline();
    this.#publish({ penaltyStatus: 'pending' });
    this.#socket!.send({
      protocolVersion: 1,
      requestId: this.#commandRequest,
      intent: {
        type: 'penalty-response',
        gameId: view.head.gameId,
        branchId: view.head.branchId,
        procedureId: view.penalty!.timer.id,
        cardId,
      },
    });
  }
  #armReveal() {
    this.#cancelReveal?.();
    this.#cancelReveal = null;
    const view = this.#stream.snapshot;
    const now = this.#deps.now?.() ?? performance.now();
    const deadlines = [view?.reveal?.expiresAt, view?.penalty?.timer.expiresAt].filter(
      (d): d is number => typeof d === 'number' && d > now,
    );
    if (!deadlines.length) return;
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
      Math.max(0, Math.min(...deadlines) - now),
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
      if (
        (this.#pending !== 'draw' && this.#pending !== 'penalty') ||
        message.requestId !== this.#commandRequest
      )
        return;
      const kind = this.#pending;
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
        this.#publish(
          kind === 'penalty'
            ? { penaltyStatus: 'accepted' }
            : { drawStatus: r.outcome === 'violation' ? 'violation' : 'played' },
        );
      } else if (
        exact(r, ['type', 'code', 'head']) &&
        r.type === 'rejected' &&
        typeof r.code === 'string' &&
        PUBLIC_REJECTIONS.some((code) => code === r.code)
      ) {
        this.#finish();
        this.#publish(
          kind === 'penalty'
            ? { penaltyStatus: 'rejected', selectedCardId: null }
            : { drawStatus: 'rejected' },
        );
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
      if (this.#pending === 'draw' || this.#pending === 'penalty') this.#finish();
      this.#publish({
        drawStatus: 'none',
        draw: null,
        penaltyStatus: 'none',
        selectedCardId: null,
        transfers: [],
      });
    }
    this.#armReveal();
    if (result === 'state') {
      const scope = penaltyScope(this.#stream.snapshot);
      if (scope !== this.#observedPenaltyScope) {
        this.#observedPenaltyScope = scope;
        this.#publish({ penaltyStatus: 'none', selectedCardId: null });
      }
      if (
        this.#pending === 'penalty' &&
        this.#pendingPenaltyScope !== penaltyScope(this.#stream.snapshot)
      ) {
        this.#finish();
        this.#publish({ penaltyStatus: 'none', selectedCardId: null });
      }
      if (this.#pending === 'resync') this.#finish();
      this.#publish({
        status: this.#pending === 'start' ? 'starting' : 'observing',
        assigned: true,
        view: this.#stream.snapshot,
        draw: this.#stream.draw,
        transfers: this.#stream.transfers,
        note: this.current.note === 'storage-unavailable' ? 'storage-unavailable' : 'none',
      });
    } else
      this.#publish({
        view: this.#stream.snapshot,
        draw: this.#stream.draw,
        transfers: this.#stream.transfers,
      });
  }
}
