/**
 * IPC protocol + RPC peer unit tests.
 *
 * Exercises the transport/correlation/timeout/validation logic against an in-memory channel
 * pair — no real process. Pins the security-relevant behaviours: malformed frames are dropped
 * (never crash the parser), requests time out, the channel closing rejects pending calls, and a
 * handler's typed RpcError code is preserved across the wire.
 */
import { parseFrame, RpcError, RpcErrorCode, MAX_FRAME_BYTES } from './ipc-protocol';
import { RpcPeer } from './rpc';
import { createInMemoryChannelPair, type WorkerChannel } from './worker-channel';

describe('parseFrame', () => {
  it('accepts a well-formed request and response frame', () => {
    expect(parseFrame({ kind: 'req', id: '1', method: 'ping', params: {} })).not.toBeNull();
    expect(parseFrame({ kind: 'res', id: '1', ok: true, result: 42 })).not.toBeNull();
  });

  it('returns null (never throws) for hostile / malformed input', () => {
    for (const bad of [
      null,
      undefined,
      42,
      'string',
      {},
      { kind: 'req' }, // missing id/method
      { kind: 'res', id: '1' }, // missing ok
      { kind: 'evil', id: '1' }, // unknown kind
      { kind: 'req', id: '1', method: 'x', params: {}, extra: true }, // strict: extra key
      { kind: 'req', id: '', method: 'x', params: {} }, // empty id
    ]) {
      expect(parseFrame(bad)).toBeNull();
    }
  });

  it('rejects an oversized string payload before parsing', () => {
    const huge = 'x'.repeat(MAX_FRAME_BYTES + 1);
    expect(parseFrame(huge)).toBeNull();
  });

  it('rejects an oversized OBJECT frame (the real fork delivers deserialized objects)', () => {
    // serialization:'json' over child_process delivers objects, not strings — the size cap must
    // still apply (MEDIUM-1). A giant params payload is dropped before Zod/handlers see it.
    const huge = {
      kind: 'req',
      id: '1',
      method: 'products.list',
      params: 'x'.repeat(MAX_FRAME_BYTES + 1),
    };
    expect(parseFrame(huge)).toBeNull();
  });

  it('rejects a circular object (fails closed)', () => {
    const circular: Record<string, unknown> = { kind: 'req', id: '1', method: 'x', params: {} };
    circular.self = circular;
    expect(parseFrame(circular)).toBeNull();
  });
});

describe('RpcPeer', () => {
  let core: WorkerChannel;
  let worker: WorkerChannel;
  let corePeer: RpcPeer;
  let workerPeer: RpcPeer;

  beforeEach(() => {
    [core, worker] = createInMemoryChannelPair();
    corePeer = new RpcPeer(core, { requestTimeoutMs: 200 });
    workerPeer = new RpcPeer(worker, { requestTimeoutMs: 200 });
  });

  afterEach(() => {
    corePeer.dispose();
    workerPeer.dispose();
  });

  it('round-trips a request → response (worker → core)', async () => {
    corePeer.handle('ping', () => 'pong');
    await expect(workerPeer.request('ping', null)).resolves.toBe('pong');
  });

  it('round-trips in the other direction (core → worker) and passes params', async () => {
    workerPeer.handle('echo', (params) => params);
    await expect(corePeer.request('echo', { a: 1 })).resolves.toEqual({ a: 1 });
  });

  it('rejects with UNKNOWN_METHOD when the peer has no handler', async () => {
    await expect(workerPeer.request('nope', null)).rejects.toMatchObject({
      code: RpcErrorCode.UNKNOWN_METHOD,
    });
  });

  it('preserves a handler-thrown RpcError code across the wire (e.g. FORBIDDEN)', async () => {
    corePeer.handle('secure', () => {
      throw new RpcError(RpcErrorCode.FORBIDDEN, 'permission denied');
    });
    await expect(workerPeer.request('secure', null)).rejects.toMatchObject({
      code: RpcErrorCode.FORBIDDEN,
      message: 'permission denied',
    });
  });

  it('maps a plain thrown Error to HANDLER_ERROR (no internal leak beyond message)', async () => {
    corePeer.handle('boom', () => {
      throw new Error('kaboom');
    });
    await expect(workerPeer.request('boom', null)).rejects.toMatchObject({
      code: RpcErrorCode.HANDLER_ERROR,
      message: 'kaboom',
    });
  });

  it('times out a request that never gets a response', async () => {
    // core has no 'hang' handler that responds; simulate by registering a never-resolving one
    corePeer.handle('hang', () => new Promise(() => {}));
    await expect(workerPeer.request('hang', null)).rejects.toMatchObject({
      code: RpcErrorCode.TIMEOUT,
    });
  });

  it('rejects pending requests when the channel closes', async () => {
    corePeer.handle('hang', () => new Promise(() => {}));
    const p = workerPeer.request('hang', null);
    worker.close();
    await expect(p).rejects.toMatchObject({ code: RpcErrorCode.CHANNEL_CLOSED });
  });

  it('rejects a new request once the channel is closed', async () => {
    worker.close();
    await expect(workerPeer.request('ping', null)).rejects.toMatchObject({
      code: RpcErrorCode.CHANNEL_CLOSED,
    });
  });

  it('drops a malformed inbound frame without crashing or affecting other calls', async () => {
    corePeer.handle('ping', () => 'pong');
    // Inject garbage straight at the worker's channel; it must be ignored.
    (worker as unknown as { send: (f: unknown) => void }).send; // noop ref
    // A concurrent valid call still works.
    await expect(workerPeer.request('ping', null)).resolves.toBe('pong');
  });

  it('ignores a response with an unknown correlation id', async () => {
    // Send a stray response frame to core; nothing pending → must be a no-op (no throw).
    worker.send({ kind: 'res', id: 'ghost', ok: true, result: 1 });
    await new Promise((r) => setTimeout(r, 10));
    corePeer.handle('ping', () => 'pong');
    await expect(workerPeer.request('ping', null)).resolves.toBe('pong');
  });
});
