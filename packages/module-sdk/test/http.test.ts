/**
 * i.5 — ModuleHttpRequest customer-principal contract (SDK side).
 *
 * The verified-customer-identity bridge adds an OPTIONAL `customer?: { readonly id: string }` to
 * the module HTTP request contract. These tests pin the additive, backward-compatible shape: a
 * request WITHOUT a customer is still valid (anonymous), and a request WITH one exposes the
 * verified id. The field is set ONLY by the core proxy from a verified JWT — there is no SDK-side
 * way to populate it, so this is a pure type/shape contract.
 */
import { describe, expect, it } from 'vitest';
import type { ModuleHttpRequest } from '../src/index.js';

describe('ModuleHttpRequest customer principal (contract)', () => {
  const base = {
    surface: 'store',
    method: 'GET',
    path: '/items',
    query: {},
    headers: {},
    tenantId: 't1',
  } as const satisfies ModuleHttpRequest;

  it('is backward-compatible: a request without `customer` is a valid ModuleHttpRequest (anonymous)', () => {
    const req: ModuleHttpRequest = base;
    expect(req.customer).toBeUndefined();
  });

  it('carries the verified customer id when present', () => {
    const req: ModuleHttpRequest = { ...base, customer: { id: 'cust-123' } };
    expect(req.customer?.id).toBe('cust-123');
  });

  it('treats `customer` as optional (anonymous calls omit it entirely)', () => {
    const anon: ModuleHttpRequest = { ...base, customer: undefined };
    expect('customer' in anon ? anon.customer : undefined).toBeUndefined();
  });

  it('the principal shape is just { id } — no token / tenant / email leak into the module', () => {
    const req: ModuleHttpRequest = { ...base, customer: { id: 'cust-xyz' } };
    expect(Object.keys(req.customer ?? {})).toEqual(['id']);
  });
});
