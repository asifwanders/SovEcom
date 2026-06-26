/**
 * recently-viewed — viewer-identity resolution unit tests (account vs guest vs none).
 *
 * The module now uses the core-derived `req.guestId` (set from the signed sov_guest httpOnly
 * cookie) — NOT a client-supplied x-rv-guest header or ?guest= query param. The resolved `key`
 * is NAMESPACE-PREFIXED by kind (`cust:` / `guest:`) so the customer and guest key spaces are
 * disjoint: a guest id can never collide with a customer's id.
 */
import { describe, it, expect } from 'vitest';
import type { ModuleHttpRequest } from '@sovecom/module-sdk';
import { resolveViewer, CUSTOMER_KEY_PREFIX, GUEST_KEY_PREFIX } from '../src/identity/viewer';

function req(partial: Partial<ModuleHttpRequest>): ModuleHttpRequest {
  return {
    surface: 'store',
    tenantId: 't1',
    method: 'GET',
    path: '/recent',
    query: {},
    headers: {},
    ...partial,
  };
}

describe('recently-viewed identity — resolveViewer', () => {
  it('a verified customer resolves to a cust:-prefixed key', () => {
    const v = resolveViewer(req({ customer: { id: 'cust-1' } }));
    expect(v).toEqual({ kind: 'customer', key: `${CUSTOMER_KEY_PREFIX}cust-1` });
  });

  it('a verified customer ALWAYS wins over a supplied guestId', () => {
    const v = resolveViewer(req({ customer: { id: 'cust-1' }, guestId: { id: 'guest-uuid-abc' } }));
    expect(v).toEqual({ kind: 'customer', key: `${CUSTOMER_KEY_PREFIX}cust-1` });
  });

  it('a core-derived guestId resolves to a guest:-prefixed key', () => {
    const v = resolveViewer(req({ guestId: { id: 'guest-uuid-abc' } }));
    expect(v).toEqual({ kind: 'guest', key: `${GUEST_KEY_PREFIX}guest-uuid-abc` });
  });

  it('no customer and no guestId → none', () => {
    expect(resolveViewer(req({}))).toEqual({ kind: 'none' });
  });

  it('an empty customer id is treated as anonymous (falls through to guestId)', () => {
    const v = resolveViewer(req({ customer: { id: '' }, guestId: { id: 'g-id' } }));
    expect(v).toEqual({ kind: 'guest', key: `${GUEST_KEY_PREFIX}g-id` });
  });

  it('an empty guestId is treated as absent (falls through to none)', () => {
    expect(resolveViewer(req({ guestId: { id: '' } }))).toEqual({ kind: 'none' });
  });

  it('namespace isolation: a guestId EQUAL to a customer id yields a DIFFERENT key', () => {
    // The attack: a guest cookie id happens to match a customer's UUID.
    const sharedId = 'abcdef01-2345-6789-abcd-ef0123456789';
    const asCustomer = resolveViewer(req({ customer: { id: sharedId } }));
    const asGuest = resolveViewer(req({ guestId: { id: sharedId } }));
    expect(asCustomer.kind).toBe('customer');
    expect(asGuest.kind).toBe('guest');
    // Same raw id, but the namespaced keys can NEVER be equal → no cross-read.
    expect((asCustomer as { key: string }).key).not.toBe((asGuest as { key: string }).key);
    expect((asCustomer as { key: string }).key).toBe(`${CUSTOMER_KEY_PREFIX}${sharedId}`);
    expect((asGuest as { key: string }).key).toBe(`${GUEST_KEY_PREFIX}${sharedId}`);
  });

  it('x-rv-guest header is IGNORED (the old client-supplied scheme is removed)', () => {
    // A client that still sends the old header should be treated as anonymous (no guestId cookie).
    const v = resolveViewer(req({ headers: { 'x-rv-guest': 'a'.repeat(32) } }));
    expect(v).toEqual({ kind: 'none' });
  });

  it('?guest= query param is IGNORED (the old client-supplied scheme is removed)', () => {
    const v = resolveViewer(req({ query: { guest: 'a'.repeat(32) } }));
    expect(v).toEqual({ kind: 'none' });
  });
});
