'use strict';
/**
 * sandbox probe fixture (NOT shipped; test-only).
 *
 * A minimal stand-in for a module worker, forked by ForkedWorkerChannel in the integration test.
 * It speaks the raw IPC frame protocol by hand (no TS import) and reports what it can observe
 * about its own sandbox, so the test can assert the REAL fork is scrubbed + permission-gated +
 * crash-isolated. Implements just enough of the wire protocol: {kind:'req',id,method,params} in,
 * {kind:'res',id,ok,result|error} out.
 */

function respond(id, result) {
  if (process.send) process.send({ kind: 'res', id, ok: true, result });
}

process.on('message', (frame) => {
  if (!frame || frame.kind !== 'req' || typeof frame.id !== 'string') return;
  switch (frame.method) {
    case 'ping':
      respond(frame.id, 'pong');
      return;
    case 'sandbox-report': {
      // process.permission is an object ONLY when the process was started with --permission.
      const permissionActive = process.permission != null;
      let canWriteOutside = true;
      let canReadAllowed = false;
      try {
        canWriteOutside = process.permission
          ? process.permission.has('fs.write', '/etc/sovecom-escape-test')
          : true;
      } catch {
        canWriteOutside = false;
      }
      try {
        // The test passes its own fixtures dir as allow-fs-read; reading it should be granted.
        canReadAllowed = process.permission
          ? process.permission.has('fs.read', __dirname)
          : false;
      } catch {
        canReadAllowed = false;
      }
      respond(frame.id, {
        permissionActive,
        canWriteOutside,
        canReadAllowed,
        // Env visibility — the test asserts no DB/secret keys leaked into the scrubbed child.
        envKeys: Object.keys(process.env).sort(),
        hasDbUrl: 'DATABASE_URL' in process.env,
        hasRedisUrl: 'REDIS_URL' in process.env,
        sawProbeVar: process.env.SOVECOM_PROBE === '1',
      });
      return;
    }
    case 'crash':
      // Simulate a module process dying — the host must isolate this.
      process.exit(1);
      return;
    default:
      if (process.send) {
        process.send({
          kind: 'res',
          id: frame.id,
          ok: false,
          error: { code: 'unknown_method', message: frame.method },
        });
      }
  }
});

// Signal readiness (not part of the RPC protocol; the test waits for the first ping response).
if (process.send) process.send({ kind: 'res', id: '__ready__', ok: true, result: 'ready' });
