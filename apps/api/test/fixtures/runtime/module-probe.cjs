'use strict';
/**
 * module containment probe (NOT shipped; test-only).
 *
 * Stands in for a hostile/curious module running in a REAL fork. On boot it (1) tries to escape
 * the filesystem sandbox, (2) tries to reach core data through the broker both WITH and WITHOUT
 * permission, then reports the outcomes via a final `__report__` frame. The integration test
 * asserts the sandbox + broker contained it: fs escape blocked, granted read works, ungranted
 * read FORBIDDEN. Speaks the raw IPC frame protocol by hand (no TS import).
 */
const fs = require('fs');

let seq = 0;
const pending = new Map();

function brokerCall(method, params) {
  return new Promise((resolve) => {
    const id = `c${++seq}`;
    pending.set(id, resolve);
    process.send({ kind: 'req', id, method, params: params || {} });
  });
}

process.on('message', (frame) => {
  if (frame && frame.kind === 'res' && pending.has(frame.id)) {
    const resolve = pending.get(frame.id);
    pending.delete(frame.id);
    resolve(frame);
  }
});

async function main() {
  // 1) Filesystem escape attempt — read a file outside the sandbox. The Node Permission Model
  //    must block it (ERR_ACCESS_DENIED). 'READ_OK' would mean the sandbox failed.
  let fsEscape;
  try {
    fs.readFileSync('/etc/hosts', 'utf8');
    fsEscape = 'READ_OK';
  } catch (e) {
    fsEscape = e && e.code ? e.code : 'BLOCKED';
  }

  // 2) Granted read through the broker (the test grants read:products).
  const productsRes = await brokerCall('products.list', { limit: 5 });
  // 3) Ungranted read — must be FORBIDDEN by the broker (test does NOT grant read:orders).
  const ordersRes = await brokerCall('orders.list', { limit: 5 });
  // 4) Core-table write — refused categorically.
  const writeRes = await brokerCall('products.create', { title: 'x' });

  process.send({
    kind: 'res',
    id: '__report__',
    ok: true,
    result: {
      fsEscape,
      productsOk: productsRes.ok === true,
      productsCount: productsRes.ok ? (productsRes.result.items || []).length : null,
      ordersErrorCode: ordersRes.ok ? null : ordersRes.error && ordersRes.error.code,
      writeErrorCode: writeRes.ok ? null : writeRes.error && writeRes.error.code,
      hasDbUrl: 'DATABASE_URL' in process.env,
    },
  });
}

main().catch((e) => {
  process.send({ kind: 'res', id: '__report__', ok: false, error: { code: 'probe', message: String(e) } });
});
