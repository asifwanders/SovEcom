/**
 * ForkedWorkerChannel REAL-fork integration test.
 *
 * Forks the committed `sandbox-probe.cjs` fixture as a real OS process and proves the isolation
 * guarantees that can only be verified end-to-end:
 *   - the env is SCRUBBED (no DATABASE_URL/REDIS_URL; only the explicit identity var we passed);
 *   - the Node Permission Model is ENGAGED (process.permission active; write outside denied);
 *   - the RPC transport round-trips over real IPC;
 *   - a worker crash closes the channel (crash isolation foundation).
 *
 * Runs in the unit suite (no DB) but spawns a real `node` child — kept fast + always torn down.
 */
import * as path from 'path';

import { RpcErrorCode } from './ipc-protocol';
import { RpcPeer } from './rpc';
import { ForkedWorkerChannel, buildExecArgv } from './forked-worker-channel';

const FIXTURE = path.resolve(__dirname, '../../../test/fixtures/runtime/sandbox-probe.cjs');
const FIXTURE_DIR = path.dirname(FIXTURE);

describe('buildExecArgv', () => {
  it('engages --permission with scoped fs grants and a heap cap, and NO escape flags', () => {
    const argv = buildExecArgv({
      entry: FIXTURE,
      allowFsRead: ['/code'],
      allowFsWrite: ['/data'],
      maxOldSpaceMb: 128,
    });
    expect(argv).toContain('--permission');
    expect(argv).toContain('--allow-fs-read=/code');
    expect(argv).toContain('--allow-fs-write=/data');
    expect(argv).toContain('--max-old-space-size=128');
    // The dangerous capabilities are NEVER granted.
    expect(argv.join(' ')).not.toMatch(/allow-child-process|allow-worker|allow-addons/);
  });
});

describe('ForkedWorkerChannel (real fork)', () => {
  let channel: ForkedWorkerChannel;
  let peer: RpcPeer;

  function spawnProbe(): void {
    channel = new ForkedWorkerChannel({
      entry: FIXTURE,
      allowFsRead: [FIXTURE_DIR],
      allowFsWrite: [], // probe writes nothing; proves write-deny outside too
      env: { SOVECOM_PROBE: '1' }, // the ONLY env var — scrubbed of all else
      maxOldSpaceMb: 128,
    });
    peer = new RpcPeer(channel, { requestTimeoutMs: 8000 });
  }

  afterEach(async () => {
    peer?.dispose();
    channel?.close();
    // give the child a tick to exit so jest doesn't flag an open handle
    await new Promise((r) => setTimeout(r, 50));
  });

  it('round-trips a ping over real IPC', async () => {
    spawnProbe();
    await expect(peer.request('ping', null)).resolves.toBe('pong');
  });

  it('reports a scrubbed env (no DB/Redis creds; only the explicit identity var)', async () => {
    spawnProbe();
    const report = (await peer.request('sandbox-report', null)) as {
      hasDbUrl: boolean;
      hasRedisUrl: boolean;
      sawProbeVar: boolean;
      envKeys: string[];
    };
    expect(report.hasDbUrl).toBe(false);
    expect(report.hasRedisUrl).toBe(false);
    expect(report.sawProbeVar).toBe(true);
    // No secret-ish keys leaked in.
    expect(report.envKeys.join(',')).not.toMatch(/SECRET|KEY|PASSWORD|TOKEN|DATABASE|REDIS|MEILI/i);
  });

  it('engages the Node Permission Model (active; write outside denied)', async () => {
    spawnProbe();
    const report = (await peer.request('sandbox-report', null)) as {
      permissionActive: boolean;
      canWriteOutside: boolean;
    };
    expect(report.permissionActive).toBe(true);
    expect(report.canWriteOutside).toBe(false);
  });

  it('isolates a worker crash: the channel closes and pending calls reject', async () => {
    spawnProbe();
    await peer.request('ping', null); // ensure it's up
    const closed = new Promise<void>((resolve) => channel.onClose(() => resolve()));
    // Fire the crash; its (never-arriving) response must reject, and the channel must close.
    const crashCall = peer.request('crash', null).catch((e) => e);
    await closed;
    const err = await crashCall;
    expect(err).toMatchObject({ code: RpcErrorCode.CHANNEL_CLOSED });
    expect(channel.open).toBe(false);
  });
});
