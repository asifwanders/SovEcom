/**
 * the transport abstraction under the RPC peer.
 *
 * {@link WorkerChannel} is a tiny duplex message port: `send` a frame, subscribe to inbound
 * frames + a `close` event. Production uses {@link ForkedWorkerChannel} (a real `child_process`
 * fork); unit tests use {@link createInMemoryChannelPair} so the RPC + broker logic can be
 * exercised without spawning a process. Keeping the transport behind an interface is what makes
 * the security-critical broker fully unit-testable.
 */
import { EventEmitter } from 'events';

export interface WorkerChannel {
  /** Send a structured frame to the peer. Returns false if the channel is already closed. */
  send(frame: unknown): boolean;
  /** Subscribe to inbound frames. Returns an unsubscribe fn. */
  onMessage(listener: (frame: unknown) => void): () => void;
  /** Subscribe to the channel closing (peer exit / disconnect). Returns an unsubscribe fn. */
  onClose(listener: () => void): () => void;
  /** Tear the channel down (and the underlying process, for a forked channel). */
  close(): void;
  /** Whether the channel is still open. */
  readonly open: boolean;
}

/**
 * An in-memory {@link WorkerChannel} backed by an EventEmitter, for unit tests. Frames are
 * delivered asynchronously (next microtask) to mirror real IPC ordering — a handler can never
 * observe a frame synchronously within `send`.
 */
class InMemoryChannel implements WorkerChannel {
  private readonly inbound = new EventEmitter();
  private peer!: InMemoryChannel;
  private closed = false;

  link(peer: InMemoryChannel): void {
    this.peer = peer;
  }

  get open(): boolean {
    return !this.closed;
  }

  send(frame: unknown): boolean {
    if (this.closed || this.peer.closed) return false;
    // Structured-clone-ish: detach from the sender's reference so a test mutating the object
    // after send can't change what the peer sees (mirrors process IPC serialization).
    const cloned: unknown = JSON.parse(JSON.stringify(frame));
    queueMicrotask(() => {
      if (!this.peer.closed) this.peer.inbound.emit('frame', cloned);
    });
    return true;
  }

  onMessage(listener: (frame: unknown) => void): () => void {
    this.inbound.on('frame', listener);
    return () => this.inbound.off('frame', listener);
  }

  onClose(listener: () => void): () => void {
    this.inbound.on('close', listener);
    return () => this.inbound.off('close', listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.inbound.emit('close');
    // Let the peer observe the close too.
    if (this.peer && !this.peer.closed) {
      this.peer.closed = true;
      this.peer.inbound.emit('close');
    }
  }
}

/** Create a linked pair of in-memory channels (e.g. `[core, worker]`). */
export function createInMemoryChannelPair(): [WorkerChannel, WorkerChannel] {
  const a = new InMemoryChannel();
  const b = new InMemoryChannel();
  a.link(b);
  b.link(a);
  return [a, b];
}
