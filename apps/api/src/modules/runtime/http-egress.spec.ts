/**
 * http:outbound egress security tests (Threat Model §6).
 * Pins: https-only, default-deny host allowlist, SSRF literal-IP block, method allowlist — and
 * one mediated happy path against a local server (dev/test escape hatch for http + private).
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { RpcErrorCode } from './ipc-protocol';
import { assertEgressAllowed, NodeHttpEgress } from './http-egress';

const ALLOW = new Set(['api.example.com']);

describe('assertEgressAllowed', () => {
  it('rejects non-https URLs', () => {
    expect(() => assertEgressAllowed('http://api.example.com/x', ALLOW)).toThrow(/https/);
  });

  it('rejects a host NOT in the allowlist (default-deny)', () => {
    expect(() => assertEgressAllowed('https://evil.example.net/x', ALLOW)).toThrow(/allowlist/);
    expect(() => assertEgressAllowed('https://api.example.com/x', new Set())).toThrow(/allowlist/);
  });

  it('rejects a blocked literal IP even if "allowlisted" (SSRF / metadata endpoint)', () => {
    const allow = new Set(['169.254.169.254', '127.0.0.1', '10.0.0.5']);
    expect(() => assertEgressAllowed('https://169.254.169.254/latest/meta-data', allow)).toThrow(
      /blocked address/,
    );
    expect(() => assertEgressAllowed('https://127.0.0.1/x', allow)).toThrow(/blocked address/);
    expect(() => assertEgressAllowed('https://10.0.0.5/x', allow)).toThrow(/blocked address/);
  });

  it('accepts an allowlisted https public host', () => {
    expect(() => assertEgressAllowed('https://api.example.com/x', ALLOW)).not.toThrow();
  });

  it('throws a FORBIDDEN RpcError (so the module sees a denied call)', () => {
    try {
      assertEgressAllowed('http://api.example.com', ALLOW);
      fail('expected throw');
    } catch (e) {
      expect(e).toMatchObject({ code: RpcErrorCode.FORBIDDEN });
    }
  });
});

describe('NodeHttpEgress (mediated request)', () => {
  let server: http.Server;
  let port: number;
  const OLD = { ...process.env };

  beforeAll((done) => {
    process.env.MODULE_EGRESS_ALLOW_INSECURE = 'true'; // dev/test: permit http to the local server
    process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS = 'true'; // dev/test: permit 127.0.0.1 (safeLookup)
    server = http.createServer((req, res) => {
      if (req.url === '/big') {
        res.writeHead(200);
        res.end('x'.repeat(2 * 1024 * 1024)); // exceeds the 1 MiB response cap
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello-module');
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      done();
    });
  });

  afterAll((done) => {
    process.env.MODULE_EGRESS_ALLOW_INSECURE = OLD.MODULE_EGRESS_ALLOW_INSECURE;
    process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS = OLD.WEBHOOK_ALLOW_PRIVATE_HOSTS;
    server.close(() => done());
  });

  it('fetches an allowlisted host and returns status + body', async () => {
    const egress = new NodeHttpEgress();
    const res = await egress.fetch({ url: `http://127.0.0.1:${port}/` }, new Set(['127.0.0.1']));
    expect(res.status).toBe(200);
    expect(res.body).toBe('hello-module');
  });

  it('rejects a method outside the allowlist', async () => {
    const egress = new NodeHttpEgress();
    await expect(
      egress.fetch({ url: `http://127.0.0.1:${port}/`, method: 'TRACE' }, new Set(['127.0.0.1'])),
    ).rejects.toMatchObject({ code: RpcErrorCode.FORBIDDEN });
  });

  it('aborts a response that exceeds the size cap', async () => {
    const egress = new NodeHttpEgress();
    await expect(
      egress.fetch({ url: `http://127.0.0.1:${port}/big` }, new Set(['127.0.0.1'])),
    ).rejects.toMatchObject({ code: RpcErrorCode.FORBIDDEN });
  });
});
