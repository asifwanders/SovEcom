/**
 * Unit tests — the notify HTTP handlers against a MOCKED SDK. Covers the GUEST-friendly subscribe
 * happy path, email validation rejects (CR/LF/NUL/other C0/DEL control chars, comma/semicolon,
 * invalid, over-length), variant validation, idempotent re-subscribe (resets notified_at),
 * customer-id recording, unsubscribe, and the disabled-module 404.
 *
 * ALL control characters in test data are written as ESCAPE SEQUENCES ('\r', '\n', '\x00', …) so
 * this file stays clean UTF-8 text (git must not classify it binary — it is the file that asserts
 * the email-injection boundary, so it must be reviewable + CI-safe).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { ModuleHttpRequest } from '@sovecom/module-sdk';
import { handleRequest, type HandlerDeps } from '../src/api/handlers';
import { NotifyRepository } from '../src/db/repository';
import { resolveSettings } from '../src/settings';
import { FakeTables } from './_mock-sdk';

function req(partial: Partial<ModuleHttpRequest>): ModuleHttpRequest {
  return {
    surface: 'store',
    method: 'GET',
    path: '/subscriptions',
    query: {},
    headers: {},
    tenantId: 't1',
    ...partial,
  };
}

function deps(over: Partial<HandlerDeps> = {}): { deps: HandlerDeps; tables: FakeTables } {
  const tables = over.repo ? (undefined as never) : new FakeTables();
  const d: HandlerDeps = {
    repo: over.repo ?? new NotifyRepository(tables),
    settings: over.settings ?? resolveSettings({ enabled: true }),
  };
  return { deps: d, tables };
}

async function parse(resBody: string | undefined): Promise<unknown> {
  return resBody ? JSON.parse(resBody) : undefined;
}

function subscribeReq(body: unknown, customer?: { id: string }): ModuleHttpRequest {
  return req({
    method: 'POST',
    path: '/subscriptions',
    body: JSON.stringify(body),
    ...(customer ? { customer } : {}),
  });
}

describe('notify-back-in-stock handlers', () => {
  let tables: FakeTables;
  let d: HandlerDeps;

  beforeEach(() => {
    const built = deps();
    tables = built.tables;
    d = built.deps;
  });

  describe('subscribe (guest-friendly)', () => {
    it('subscribes a guest (no login) → 201, row stored email-keyed', async () => {
      const res = await handleRequest(
        subscribeReq({ variantId: 'v1', email: 'shopper@example.com' }),
        d,
      );
      expect(res.status).toBe(201);
      expect(await parse(res.body)).toEqual({ variantId: 'v1', email: 'shopper@example.com' });
      expect(tables.subscriptions).toHaveLength(1);
      expect(tables.subscriptions[0]).toMatchObject({
        customer_email: 'shopper@example.com',
        product_variant_id: 'v1',
        customer_id: null,
        notified_at: null,
      });
    });

    it('records the core-verified customer id when present (but email is the key)', async () => {
      await handleRequest(
        subscribeReq({ variantId: 'v1', email: 'shopper@example.com' }, { id: 'cust-a' }),
        d,
      );
      expect(tables.subscriptions[0]).toMatchObject({
        customer_email: 'shopper@example.com',
        customer_id: 'cust-a',
      });
    });

    it('trims + normalizes the email', async () => {
      const res = await handleRequest(
        subscribeReq({ variantId: 'v1', email: '  buyer@example.com  ' }),
        d,
      );
      expect(res.status).toBe(201);
      expect(tables.subscriptions[0]?.customer_email).toBe('buyer@example.com');
    });

    describe('email validation (rejects → 400, nothing stored)', () => {
      const bad: Array<[string, unknown]> = [
        ['missing', undefined],
        ['empty', ''],
        ['not a string', 123],
        ['no @', 'plainstring'],
        ['no domain dot', 'a@localhost'],
        ['CR injection', 'a@example.com\r'],
        ['LF injection', 'a@example.com\nBcc: evil@x.com'],
        ['CRLF injection', 'a@example.com\r\nBcc: evil@x.com'],
        ['NUL (\\x00)', 'a@exa\x00mple.com'],
        ['vertical tab (\\x0b)', 'a@exa\x0bmple.com'],
        ['unit separator (\\x1f)', 'a@exa\x1fmple.com'],
        ['DEL (\\x7f)', 'a@exa\x7fmple.com'],
        ['comma (multi-recipient)', 'a@example.com,b@example.com'],
        ['semicolon (multi-recipient)', 'a@example.com;b@example.com'],
        ['angle brackets', '<a@example.com>'],
        ['whitespace inside', 'a b@example.com'],
        ['over-length (>254)', 'a'.repeat(250) + '@example.com'],
      ];
      for (const [name, value] of bad) {
        it(`rejects ${name}`, async () => {
          const res = await handleRequest(subscribeReq({ variantId: 'v1', email: value }), d);
          expect(res.status).toBe(400);
          expect(await parse(res.body)).toEqual({ error: 'invalid_email' });
          expect(tables.subscriptions).toHaveLength(0);
        });
      }
    });

    describe('variant validation (rejects → 400)', () => {
      it('rejects a missing variantId', async () => {
        const res = await handleRequest(subscribeReq({ email: 'a@example.com' }), d);
        expect(res.status).toBe(400);
        expect(await parse(res.body)).toEqual({ error: 'invalid_variant_id' });
      });
      it('rejects a blank variantId', async () => {
        const res = await handleRequest(
          subscribeReq({ variantId: '   ', email: 'a@example.com' }),
          d,
        );
        expect(res.status).toBe(400);
      });
      it('rejects an over-long variantId (>64)', async () => {
        const res = await handleRequest(
          subscribeReq({ variantId: 'v'.repeat(65), email: 'a@example.com' }),
          d,
        );
        expect(res.status).toBe(400);
      });
      it('a bad body (not JSON) → 400', async () => {
        const res = await handleRequest(
          req({ method: 'POST', path: '/subscriptions', body: 'not-json' }),
          d,
        );
        expect(res.status).toBe(400);
      });
    });

    it('is idempotent — re-subscribing the same (email, variant) does NOT duplicate', async () => {
      const sub = () => handleRequest(subscribeReq({ variantId: 'v1', email: 'a@example.com' }), d);
      expect((await sub()).status).toBe(201);
      expect((await sub()).status).toBe(201);
      expect(tables.subscriptions).toHaveLength(1);
    });

    it('re-subscribing RESETS notified_at to NULL (re-eligible for the next restock)', async () => {
      await handleRequest(subscribeReq({ variantId: 'v1', email: 'a@example.com' }), d);
      // Simulate the runner having notified this subscription.
      tables.subscriptions[0]!.notified_at = new Date().toISOString();
      // Re-subscribe.
      await handleRequest(subscribeReq({ variantId: 'v1', email: 'a@example.com' }), d);
      expect(tables.subscriptions).toHaveLength(1);
      expect(tables.subscriptions[0]?.notified_at).toBeNull();
    });
  });

  describe('unsubscribe', () => {
    it("removes the subscriber's subscription → 204 (bodyless)", async () => {
      await handleRequest(subscribeReq({ variantId: 'v1', email: 'a@example.com' }), d);
      const res = await handleRequest(
        req({
          method: 'DELETE',
          path: '/subscriptions/v1',
          body: JSON.stringify({ email: 'a@example.com' }),
        }),
        d,
      );
      expect(res.status).toBe(204);
      expect(res.body).toBeUndefined();
      expect(res.headers).toBeUndefined();
      expect(tables.subscriptions).toHaveLength(0);
    });

    it('unsubscribing a non-existent subscription → 404', async () => {
      const res = await handleRequest(
        req({
          method: 'DELETE',
          path: '/subscriptions/v1',
          body: JSON.stringify({ email: 'nobody@example.com' }),
        }),
        d,
      );
      expect(res.status).toBe(404);
    });

    it('unsubscribe with an invalid email → 400', async () => {
      const res = await handleRequest(
        req({
          method: 'DELETE',
          path: '/subscriptions/v1',
          body: JSON.stringify({ email: 'a@example.com\r' }),
        }),
        d,
      );
      expect(res.status).toBe(400);
    });

    it('a malformed percent-escape in the path → 404 (no URIError / 500)', async () => {
      const res = await handleRequest(
        req({
          method: 'DELETE',
          path: '/subscriptions/%zz',
          body: JSON.stringify({ email: 'a@example.com' }),
        }),
        d,
      );
      expect(res.status).toBe(404);
    });
  });

  describe('disabled module', () => {
    it('returns 404 for every route when settings.enabled is false', async () => {
      const built = deps({ settings: resolveSettings({ enabled: false }) });
      d = built.deps;
      const res = await handleRequest(subscribeReq({ variantId: 'v1', email: 'a@example.com' }), d);
      expect(res.status).toBe(404);
    });
  });

  describe('unknown routes', () => {
    it('unmatched method/path → 404', async () => {
      const res = await handleRequest(req({ method: 'PUT', path: '/whatever' }), d);
      expect(res.status).toBe(404);
    });
    it('GET /subscriptions (no list endpoint) → 404', async () => {
      const res = await handleRequest(req({ method: 'GET', path: '/subscriptions' }), d);
      expect(res.status).toBe(404);
    });
  });
});
