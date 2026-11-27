import type { ServerMessage } from '../protocol/contracts.ts';

type Packet = {
  work: (emit: (message: ServerMessage) => void) => void | Promise<void>;
  bytes: number;
  generation?: number | undefined;
  done: () => void;
};
/** Exactly one acknowledged emission in flight bounds underlying socket buffers.
 * Prepared work runs only when the wire slot is free. It can authorize/project
 * at emission time without awaiting the network inside a server queue.
 */
export class AcknowledgedOutbound {
  readonly #send: (message: ServerMessage) => Promise<void>;
  readonly #fail: () => void;
  readonly #prepare: (work: () => Promise<void>) => Promise<void>;
  readonly #limits: { messages: number; bytes: number };
  #queue: Packet[] = [];
  #bytes = 0;
  #active = false;
  #closed = false;
  #generation: number | null = null;
  #pending: Promise<void> = Promise.resolve();
  constructor(
    send: (message: ServerMessage) => Promise<void>,
    fail: () => void,
    limits = { messages: 32, bytes: 262144 },
    prepare: (work: () => Promise<void>) => Promise<void> = (work) => work(),
  ) {
    this.#prepare = prepare;
    this.#send = send;
    this.#fail = fail;
    this.#limits = limits;
  }
  enqueue(message: ServerMessage, generation?: number): void {
    void this.prepare(
      (emit) => emit(message),
      Buffer.byteLength(JSON.stringify(message)) + 128,
      generation,
    );
  }
  prepare(work: Packet['work'], bytes: number, generation?: number): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#generation === null && generation !== undefined) this.#generation = generation;
    if (
      this.#queue.length + Number(this.#active) >= this.#limits.messages ||
      this.#bytes + bytes > this.#limits.bytes
    ) {
      this.close();
      this.#fail();
      return Promise.resolve();
    }
    let done!: () => void;
    const completion = new Promise<void>((resolve) => {
      done = resolve;
    });
    this.#bytes += bytes;
    this.#queue.push({ work, bytes, generation, done });
    if (!this.#active) this.#pending = this.#pump();
    return completion;
  }
  invalidate(generation = (this.#generation ?? 0) + 1): void {
    this.#generation = generation;
    this.#queue = this.#queue.filter((packet) => {
      if (packet.generation === undefined) return true;
      this.#bytes -= packet.bytes;
      packet.done();
      return false;
    });
  }
  finish(message: ServerMessage): Promise<void> {
    for (const packet of this.#queue) {
      this.#bytes -= packet.bytes;
      packet.done();
    }
    this.#queue = [];
    const sent = this.prepare(
      (emit) => emit(message),
      Buffer.byteLength(JSON.stringify(message)) + 128,
    );
    return sent.finally(() => this.close());
  }
  close(): void {
    this.#closed = true;
    for (const packet of this.#queue) {
      this.#bytes -= packet.bytes;
      packet.done();
    }
    this.#queue = [];
  }
  drained(): Promise<void> {
    return this.#pending;
  }
  async #pump(): Promise<void> {
    this.#active = true;
    try {
      while (!this.#closed && this.#queue.length) {
        const packet = this.#queue.shift()!;
        let receipt: Promise<void> | null = null;
        try {
          await this.#prepare(async () => {
            await packet.work((message) => {
              if (
                this.#closed ||
                (packet.generation !== undefined && packet.generation !== this.#generation)
              )
                return;
              if (receipt || Buffer.byteLength(JSON.stringify(message)) + 128 > packet.bytes)
                throw new Error('Outbound bound exceeded');
              receipt = this.#send(message);
              void receipt.catch(() => {});
            });
          });
          if (receipt) await receipt;
        } finally {
          this.#bytes -= packet.bytes;
          packet.done();
        }
      }
    } catch {
      const notify = !this.#closed;
      this.close();
      if (notify) this.#fail();
    } finally {
      this.#active = false;
    }
  }
}
