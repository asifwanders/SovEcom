/**
 * symmetric RPC peer over a {@link WorkerChannel}.
 *
 * Both core and the worker run an {@link RpcPeer}. A peer can `request(method, params)` and
 * `await` the correlated response, and can register inbound handlers with `handle(method, fn)`.
 * Correlation is by an opaque id; every request carries a timeout so a hung/hostile peer can
 * never wedge a pending promise forever. EVERY inbound frame is validated by `parseFrame`
 * before use — malformed frames are dropped, never trusted.
 *
 * The peer is transport-policy-free: it does not know which methods are "allowed". The core
 * side wires the broker as the handler set; the security checks live there.
 */
import {
  type RequestFrame,
  type ResponseFrame,
  RpcError,
  RpcErrorCode,
  parseFrame,
} from './ipc-protocol';
import type { WorkerChannel } from './worker-channel';

/** A handler for an inbound request. May be async. Throwing → a `handler_error` response. */
export type RpcHandler = (params: unknown) => Promise<unknown> | unknown;

export interface RpcPeerOptions {
  /** Per-request timeout (ms). Default 10s. */
  readonly requestTimeoutMs?: number;
  /** Inject id generation for deterministic tests; defaults to a counter + random suffix. */
  readonly genId?: () => string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: RpcError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RpcPeer {
  private readonly channel: WorkerChannel;
  private readonly handlers = new Map<string, RpcHandler>();
  private readonly pending = new Map<string, Pending>();
  private readonly requestTimeoutMs: number;
  private readonly genId: () => string;
  private seq = 0;
  private disposed = false;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(channel: WorkerChannel, options: RpcPeerOptions = {}) {
    this.channel = channel;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.genId = options.genId ?? (() => `${++this.seq}-${Math.floor(performance.now())}`);
    this.unsubscribers.push(this.channel.onMessage((raw) => this.onFrame(raw)));
    this.unsubscribers.push(this.channel.onClose(() => this.onClose()));
  }

  /** Register a handler for an inbound method. Last registration wins. */
  handle(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  /**
   * Send a request and resolve with the peer's result, or reject with an {@link RpcError}.
   * Rejects with TIMEOUT if no response arrives, CHANNEL_CLOSED if the peer goes away.
   */
  request(method: string, params: unknown): Promise<unknown> {
    if (this.disposed || !this.channel.open) {
      return Promise.reject(new RpcError(RpcErrorCode.CHANNEL_CLOSED, 'channel is closed'));
    }
    const id = this.genId();
    const frame: RequestFrame = { kind: 'req', id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(RpcErrorCode.TIMEOUT, `request "${method}" timed out`));
      }, this.requestTimeoutMs);
      // Don't let a pending request keep the event loop alive.
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      const sent = this.channel.send(frame);
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new RpcError(RpcErrorCode.CHANNEL_CLOSED, 'channel is closed'));
      }
    });
  }

  /** Tear down: reject all pending requests and unsubscribe. Does not close the channel. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubscribers) u();
    this.failAllPending(new RpcError(RpcErrorCode.CHANNEL_CLOSED, 'rpc peer disposed'));
  }

  private onClose(): void {
    this.failAllPending(new RpcError(RpcErrorCode.CHANNEL_CLOSED, 'channel closed'));
  }

  private failAllPending(err: RpcError): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private onFrame(raw: unknown): void {
    const frame = parseFrame(raw);
    if (frame === null) return; // hostile/malformed → drop silently
    if (frame.kind === 'res') {
      this.onResponse(frame);
    } else {
      // onRequest is self-contained (handler errors are caught + answered); the catch is a
      // belt-and-suspenders guard so a future refactor can't leak an unhandled rejection.
      void this.onRequest(frame).catch(() => {});
    }
  }

  private onResponse(frame: ResponseFrame): void {
    const p = this.pending.get(frame.id);
    if (!p) return; // unknown/late/duplicate correlation id → ignore
    this.pending.delete(frame.id);
    clearTimeout(p.timer);
    if (frame.ok) {
      p.resolve(frame.result);
    } else {
      const code = (frame.error?.code as RpcErrorCode) || RpcErrorCode.HANDLER_ERROR;
      p.reject(new RpcError(code, frame.error?.message ?? 'remote error'));
    }
  }

  private async onRequest(frame: RequestFrame): Promise<void> {
    const handler = this.handlers.get(frame.method);
    if (!handler) {
      this.respondError(frame.id, RpcErrorCode.UNKNOWN_METHOD, `no handler for "${frame.method}"`);
      return;
    }
    try {
      const result = await handler(frame.params);
      this.respondOk(frame.id, result);
    } catch (err) {
      // A handler may throw a typed RpcError (e.g. the broker's FORBIDDEN) — preserve its code.
      if (err instanceof RpcError) {
        this.respondError(frame.id, err.code, err.message);
      } else {
        const message = err instanceof Error ? err.message : 'handler failed';
        this.respondError(frame.id, RpcErrorCode.HANDLER_ERROR, message);
      }
    }
  }

  private respondOk(id: string, result: unknown): void {
    const frame: ResponseFrame = { kind: 'res', id, ok: true, result };
    this.channel.send(frame);
  }

  private respondError(id: string, code: RpcErrorCode, message: string): void {
    const frame: ResponseFrame = { kind: 'res', id, ok: false, error: { code, message } };
    this.channel.send(frame);
  }
}
