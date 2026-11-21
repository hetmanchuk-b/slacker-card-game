export type ClaimEvidence =
  | Readonly<{ type: 'spoken'; key: string }>
  | Readonly<{ type: 'chat'; messageId: string }>
  | Readonly<{ type: 'action'; commandId: string }>;
import type { Vote } from './game-stream.ts';
import { chatText } from './lobby-chat.ts';
import { GameStream, object, exact, head, remainingTime } from './game-stream.ts';
import type { GameSnapshot, Draw, Transfer, PlayObservation, Peek } from './game-stream.ts';
const penaltyScope = (view: GameSnapshot | null) =>
  view?.penalty
    ? JSON.stringify([view.head.gameId, view.head.branchId, view.penalty.timer.id])
    : null;
import { PUBLIC_REJECTIONS } from '../protocol/contracts.ts';
import { LobbyChat } from './lobby-chat.ts';
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
  actionIds: readonly string[];
  claimStatus: 'none' | 'pending' | 'accepted' | 'rejected' | 'uncertain';
  withdrawalStatus: 'none' | 'pending' | 'accepted' | 'rejected' | 'uncertain';
  replacementRejection: string | null;
  replacementStatus: 'none' | 'pending' | 'accepted' | 'rejected' | 'uncertain';
  voteStatus: 'none' | 'pending' | 'accepted' | 'rejected' | 'uncertain';
  chat: LobbyChat['current'];
  view: GameSnapshot | null;
  draw: Draw | null;
  drawStatus: 'none' | 'pending' | 'played' | 'violation' | 'rejected' | 'uncertain';
  penaltyStatus: 'none' | 'pending' | 'accepted' | 'rejected' | 'uncertain';
  moveStatus: 'none' | 'pending' | 'played' | 'violation' | 'rejected' | 'uncertain';
  playObservations: readonly PlayObservation[];
  peek: Peek | null;
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
  #pending:
    | 'connect'
    | 'resync'
    | 'start'
    | 'draw'
    | 'penalty'
    | 'move'
    | 'chat'
    | 'claim'
    | 'withdrawal'
    | 'replacement'
    | 'vote'
    | null = null;
  readonly #chat: LobbyChat;
  #pendingReplacementVoteId: string | null = null;
  #pendingWithdrawalTarget: string | null = null;
  #observedWithdrawalTarget: string | null = null;
  #pendingVoteId: string | null = null;
  #observedVoteId: string | null = null;
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
    actionIds: [],
    claimStatus: 'none',
    withdrawalStatus: 'none',
    replacementStatus: 'none',
    replacementRejection: null,
    voteStatus: 'none',
    status: 'disconnected',
    chat: { page: [], lastPost: null, cursor: '0', empty: false, retry: false, status: 'idle' },
    view: null,
    draw: null,
    drawStatus: 'none',
    penaltyStatus: 'none',
    moveStatus: 'none',
    playObservations: [],
    peek: null,
    selectedCardId: null,
    transfers: [],
    assigned: false,
    retry: false,
    note: 'none',
  };
  constructor(dependencies: Dependencies) {
    this.#deps = dependencies;
    this.#chat = new LobbyChat(dependencies.lobbyId, dependencies.seatId, dependencies.requestId);
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
    this.current = {
      ...this.current,
      ...next,
      chat: this.#chat.current,
      actionIds: this.#stream.actionIds,
      playObservations: this.#stream.playObservations,
      peek: this.#stream.peek,
    };
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
    if (this.#chat.pending) this.#chat.interrupt();
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
    const moveUncertain = this.#pending === 'move';
    const claimUncertain = this.#pending === 'claim';
    const withdrawalUncertain = this.#pending === 'withdrawal';
    const replacementUncertain = this.#pending === 'replacement';
    const voteUncertain = this.#pending === 'vote';
    const uncertain =
      replacementUncertain ||
      drawUncertain ||
      penaltyUncertain ||
      moveUncertain ||
      claimUncertain ||
      withdrawalUncertain ||
      voteUncertain;
    this.#finish();
    this.#drop();
    this.#publish({
      status: uncertain ? 'uncertain' : status,
      note,
      view: null,
      draw: null,
      transfers: [],
      selectedCardId: null,
      ...(claimUncertain ? { claimStatus: 'uncertain' } : {}),
      ...(withdrawalUncertain ? { withdrawalStatus: 'uncertain' } : {}),
      ...(replacementUncertain ? { replacementStatus: 'uncertain' as const } : {}),
      ...(voteUncertain ? { voteStatus: 'uncertain' } : {}),
      ...(drawUncertain ? { drawStatus: 'uncertain' } : {}),
      ...(penaltyUncertain ? { penaltyStatus: 'uncertain' } : {}),
      ...(moveUncertain ? { moveStatus: 'uncertain' } : {}),
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
  #chatAvailable() {
    return (
      !this.#pending &&
      !!this.#socket?.connected &&
      ['attached', 'observing'].includes(this.current.status)
    );
  }
  #sendChat(message: object | null) {
    if (!message) return;
    this.#pending = 'chat';
    this.#deadline();
    this.#publish();
    this.#socket!.send(message);
  }
  postChat(text: string) {
    if (this.#chatAvailable()) this.#sendChat(this.#chat.post(text));
  }
  retryChat() {
    if (this.#chatAvailable()) this.#sendChat(this.#chat.retry());
  }
  readChat(first = false) {
    if (this.#chatAvailable()) this.#sendChat(this.#chat.read(first));
  }
  submitClaim(accusedId: string, reason: string, evidence: ClaimEvidence) {
    const view = this.current.view;
    if (
      this.#pending ||
      !this.#socket?.connected ||
      this.current.status !== 'observing' ||
      !view?.state ||
      view.paused ||
      view.state.phase === 'finished' ||
      !view.state.players.some((p) => p.id === this.#deps.seatId && p.status === 'active') ||
      accusedId === this.#deps.seatId ||
      !view.state.players.some((p) => p.id === accusedId && p.status === 'active') ||
      !chatText(reason)
    )
      return;
    const ref =
      evidence.type === 'spoken'
        ? evidence.key
        : evidence.type === 'chat'
          ? evidence.messageId
          : evidence.commandId;
    if (!text(ref) || ref.length > 256 || !ref.trim()) return;
    if (
      evidence.type === 'chat' &&
      ![
        ...this.current.chat.page,
        ...(this.current.chat.lastPost ? [this.current.chat.lastPost] : []),
      ].some((row) => row.id === ref)
    )
      return;
    if (evidence.type === 'action' && !this.current.actionIds.includes(ref)) return;
    const safeEvidence =
      evidence.type === 'spoken'
        ? { type: 'spoken', key: ref }
        : evidence.type === 'chat'
          ? { type: 'chat', messageId: ref }
          : { type: 'action', commandId: ref };
    this.#commandRequest = this.#deps.requestId();
    this.#pending = 'claim';
    this.#deadline();
    this.#publish({ claimStatus: 'pending' });
    this.#socket.send({
      protocolVersion: 1,
      requestId: this.#commandRequest,
      intent: {
        type: 'submit-claim',
        gameId: view.head.gameId,
        branchId: view.head.branchId,
        accusedId,
        reason,
        evidence: safeEvidence,
      },
    });
  }
  proposeBot(absentSeatId: string, gameId: string, branchId: string) {
    const v = this.current.view;
    if (
      !v ||
      v.replacementVote ||
      !v.connections.some(
        (c) => c.seatId === absentSeatId && !c.connected && c.controller === 'human',
      ) ||
      !v.state?.players.some((p) => p.id === absentSeatId && p.status === 'active')
    )
      return;
    this.#replacementCommand({ type: 'propose-bot', absentSeatId }, gameId, branchId);
  }
  voteReplacement(procedureId: string, vote: Vote, gameId: string, branchId: string) {
    const r = this.current.view?.replacementVote;
    if (
      !r ||
      r.timer.id !== procedureId ||
      r.ownVote !== null ||
      !r.eligibleSeatIds.includes(this.#deps.seatId) ||
      !['yes', 'no', 'abstain'].includes(vote) ||
      remainingTime(r.timer, this.#deps.now?.() ?? performance.now()) <= 0
    )
      return;
    this.#replacementCommand(
      { type: 'replacement-vote', procedureId, vote },
      gameId,
      branchId,
      procedureId,
    );
  }
  #replacementCommand(
    intent: object,
    gameId: string,
    branchId: string,
    procedureId: string | null = null,
  ) {
    const v = this.current.view;
    if (
      this.#pending ||
      !this.#socket?.connected ||
      this.current.status !== 'observing' ||
      !v ||
      v.head.gameId !== gameId ||
      v.head.branchId !== branchId ||
      !v.state?.players.some((p) => p.id === this.#deps.seatId && p.status === 'active') ||
      !v.connections.some(
        (c) => c.seatId === this.#deps.seatId && c.connected && c.controller === 'human',
      )
    )
      return;
    this.#commandRequest = this.#deps.requestId();
    this.#pendingReplacementVoteId = procedureId;
    this.#pending = 'replacement';
    this.#deadline();
    this.#publish({ replacementStatus: 'pending', replacementRejection: null });
    this.#socket.send({
      protocolVersion: 1,
      requestId: this.#commandRequest,
      intent: { ...intent, gameId, branchId },
    });
  }
  requestWithdrawal(claimId: string, gameId: string, branchId: string) {
    const view = this.current.view;
    if (
      !view?.ballot ||
      view.withdrawal ||
      view.ballot.claim.id !== claimId ||
      view.ballot.claim.claimantId !== this.#deps.seatId ||
      view.ballot.timer.paused ||
      remainingTime(view.ballot.timer, this.#deps.now?.() ?? performance.now()) <= 0
    )
      return;
    this.#withdrawalCommand({ type: 'request-withdrawal', claimId }, claimId, gameId, branchId);
  }
  answerWithdrawal(procedureId: string, approve: boolean, gameId: string, branchId: string) {
    const w = this.current.view?.withdrawal;
    if (
      !w ||
      w.timer.id !== procedureId ||
      w.timer.paused ||
      typeof approve !== 'boolean' ||
      remainingTime(w.timer, this.#deps.now?.() ?? performance.now()) <= 0 ||
      w.ownApproval !== null ||
      !w.eligibleSeatIds.includes(this.#deps.seatId)
    )
      return;
    this.#withdrawalCommand(
      { type: 'withdrawal-response', procedureId, approve },
      procedureId,
      gameId,
      branchId,
    );
  }
  #withdrawalCommand(intent: object, target: string, gameId: string, branchId: string) {
    const view = this.current.view;
    if (
      this.#pending ||
      !this.#socket?.connected ||
      this.current.status !== 'observing' ||
      !view ||
      view.paused ||
      view.head.gameId !== gameId ||
      view.head.branchId !== branchId
    )
      return;
    this.#commandRequest = this.#deps.requestId();
    this.#pendingWithdrawalTarget = target;
    this.#pending = 'withdrawal';
    this.#deadline();
    this.#publish({ withdrawalStatus: 'pending' });
    this.#socket.send({
      protocolVersion: 1,
      requestId: this.#commandRequest,
      intent: { ...intent, gameId, branchId },
    });
  }
  castVote(procedureId: string, vote: Vote, gameId: string, branchId: string) {
    const view = this.current.view;
    const b = view?.ballot;
    if (
      this.#pending ||
      !this.#socket?.connected ||
      this.current.status !== 'observing' ||
      !view ||
      view.paused ||
      view.head.gameId !== gameId ||
      view.head.branchId !== branchId ||
      !b ||
      b.timer.id !== procedureId ||
      b.timer.paused ||
      remainingTime(b.timer, this.#deps.now?.() ?? performance.now()) <= 0 ||
      b.ownVote !== null ||
      !b.eligibleSeatIds.includes(this.#deps.seatId) ||
      !['yes', 'no', 'abstain'].includes(vote)
    )
      return;
    this.#commandRequest = this.#deps.requestId();
    this.#pendingVoteId = procedureId;
    this.#pending = 'vote';
    this.#deadline();
    this.#publish({ voteStatus: 'pending' });
    this.#socket.send({
      protocolVersion: 1,
      requestId: this.#commandRequest,
      intent: {
        type: 'cast-vote',
        gameId: view.head.gameId,
        branchId: view.head.branchId,
        procedureId,
        vote,
      },
    });
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
  playCard(cardId: string) {
    this.#move('play-card', cardId);
  }
  takeBottom() {
    this.#move('take-bottom');
  }
  openStump(cardId: string) {
    this.#move('open-stump', cardId);
  }
  dismissPeek() {
    this.#stream.dismissPeek();
    this.#publish();
  }
  #move(type: 'play-card' | 'take-bottom' | 'open-stump', cardId?: string) {
    const view = this.current.view;
    if (
      this.#pending ||
      !this.#socket?.connected ||
      this.current.status !== 'observing' ||
      !view?.state ||
      view.paused ||
      view.hasProcedure ||
      !view.state.players.some((p) => p.id === this.#deps.seatId && p.status === 'active') ||
      view.state.phase === 'finished'
    )
      return;
    if (view.state.phase !== 'round' && view.state.phase !== 'between-rounds') return;
    if (type === 'play-card' && !view.state.own.hand.some((c) => c.id === cardId)) return;
    if (type === 'open-stump' && !view.state.own.stumps.includes(cardId!)) return;
    // No turn, beat, opening-right or table-count inference. The server decides.
    this.#commandRequest = this.#deps.requestId();
    this.#pending = 'move';
    this.#deadline();
    this.#publish({ moveStatus: 'pending' });
    this.#socket.send({
      protocolVersion: 1,
      requestId: this.#commandRequest,
      intent: {
        type,
        gameId: view.head.gameId,
        branchId: view.head.branchId,
        ...(type === 'take-bottom' ? {} : { cardId }),
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
      if (
        (message.code === 'unavailable' || message.code === 'unauthorized') &&
        this.#pending === 'resync'
      ) {
        this.#finish();
        this.#publish({
          status: 'attached',
          note:
            message.code === 'unauthorized'
              ? 'unauthorized'
              : this.#storageBlocked
                ? 'storage-unavailable'
                : 'unavailable',
          view: null,
        });
      } else
        this.#fail(
          message.code === 'unauthorized' ? 'unauthorized' : 'unavailable',
          this.#pending === 'start' ? 'uncertain' : 'failed',
        );
      return;
    }
    if (message.type === 'chat-page') {
      if (this.#pending !== 'chat') return;
      const result = this.#chat.receive(message);
      if (result === 'ignored') return;
      if (result === 'invalid') {
        this.#fail('invalid-message');
        return;
      }
      this.#finish();
      this.#publish();
      return;
    }
    if (message.type === 'command-ack') {
      if (
        (this.#pending !== 'draw' &&
          this.#pending !== 'penalty' &&
          this.#pending !== 'move' &&
          this.#pending !== 'claim' &&
          this.#pending !== 'vote' &&
          this.#pending !== 'withdrawal' &&
          this.#pending !== 'replacement') ||
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
          kind === 'replacement'
            ? { replacementStatus: 'accepted', replacementRejection: null }
            : kind === 'withdrawal'
              ? { withdrawalStatus: 'accepted' }
              : kind === 'claim'
                ? { claimStatus: 'accepted' }
                : kind === 'vote'
                  ? { voteStatus: 'accepted' }
                  : kind === 'penalty'
                    ? { penaltyStatus: 'accepted' }
                    : kind === 'move'
                      ? { moveStatus: r.outcome === 'violation' ? 'violation' : 'played' }
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
          kind === 'replacement'
            ? { replacementStatus: 'rejected', replacementRejection: r.code }
            : kind === 'withdrawal'
              ? { withdrawalStatus: 'rejected' }
              : kind === 'claim'
                ? { claimStatus: 'rejected' }
                : kind === 'vote'
                  ? { voteStatus: 'rejected' }
                  : kind === 'penalty'
                    ? { penaltyStatus: 'rejected', selectedCardId: null }
                    : kind === 'move'
                      ? { moveStatus: 'rejected' }
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
      if (
        this.#pending === 'draw' ||
        this.#pending === 'penalty' ||
        this.#pending === 'move' ||
        this.#pending === 'claim' ||
        this.#pending === 'vote' ||
        this.#pending === 'withdrawal' ||
        this.#pending === 'replacement'
      )
        this.#finish();
      this.#publish({
        replacementStatus: 'none',
        replacementRejection: null,
        claimStatus: 'none',
        withdrawalStatus: 'none',
        voteStatus: 'none',
        drawStatus: 'none',
        draw: null,
        moveStatus: 'none',
        penaltyStatus: 'none',
        selectedCardId: null,
        transfers: [],
      });
    }
    this.#armReveal();
    if (result === 'state') {
      if (
        this.#pending === 'replacement' &&
        this.#pendingReplacementVoteId &&
        this.#stream.snapshot?.replacementVote?.timer.id !== this.#pendingReplacementVoteId
      ) {
        this.#finish();
        this.#publish({ replacementStatus: 'none', replacementRejection: null });
      }
      const target =
        this.#stream.snapshot?.withdrawal?.timer.id ??
        this.#stream.snapshot?.ballot?.claim.id ??
        null;
      if (target !== this.#observedWithdrawalTarget) {
        this.#observedWithdrawalTarget = target;
        if (this.#pending === 'withdrawal' && this.#pendingWithdrawalTarget !== target)
          this.#finish();
        this.#publish({ withdrawalStatus: 'none' });
      }
      const voteId = this.#stream.snapshot?.ballot?.timer.id ?? null;
      if (voteId !== this.#observedVoteId) {
        this.#observedVoteId = voteId;
        if (this.#pending === 'vote' && this.#pendingVoteId !== voteId) this.#finish();
        this.#publish({ voteStatus: 'none' });
      }
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
