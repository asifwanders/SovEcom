/**
 * wishlist -- viewer-identity resolution unit tests (account vs guest vs none).
 *
 * The resolved key is NAMESPACE-PREFIXED by kind (`cust:` / `guest:`) so the customer and
 * guest key spaces are disjoint -- a guest id can never collide with a customer's id.
 */
import { describe, it, expect } from 'vitest';
import type { ModuleHttpRequest } from '@sovecom/module-sdk';
import { resolveViewer, CUSTOMER_KEY_PREFIX, GUEST_KEY_PREFIX } from '../src/identity/viewer';

function req(partial: Partial<ModuleHttpRequest>): ModuleHttpRequest {
  return {
    surface: 'store',
    tenantId: 't1',
    method: 'GET',
    path: '/items',
    query: {},
    headers: {},
    ...partial,
  };
}

const GUEST_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

describe('wishlist identity -- resolveViewer', () => {
  it('a verified customer resolves to a cust:-prefixed key', () => {
    const v = resolveViewer(req({ customer: { id: 'cust-1' } }));
    expect(v).toEqual({ kind: 'customer', key: `${CUSTOMER_KEY_PREFIX}cust-1` });
  });

  it('a verified customer ALWAYS wins over a supplied guestId', () => {
    const v = resolveViewer(req({ customer: { id: 'cust-1' }, guestId: { id: GUEST_ID } }));
    expect(v).toEqual({ kind: 'customer', key: `${CUSTOMER_KEY_PREFIX}cust-1` });
  });

  it('a core-derived guestId resolves to a guest:-prefixed key', () => {
    const v = resolveViewer(req({ guestId: { id: GUEST_ID } }));
    expect(v).toEqual({ kind: 'guest', key: `${GUEST_KEY_PREFIX}${GUEST_ID}` });
  });

  it('namespace isolation: same id value yields different keys for customer vs guest', () => {
    const sameId = 'abcdef0123456789';
    const asCustomer = resolveViewer(req({ customer: { id: sameId } }));
    const asGuest = resolveViewer(req({ guestId: { id: sameId } }));
    expect(asCustomer.kind).toBe('customer');
    expect(asGuest.kind).toBe('guest');
    expect((asCustomer as { key: string }).key).not.toBe((asGuest as { key: string }).key);
    expect((asCustomer as { key: string }).key).toBe(`${CUSTOMER_KEY_PREFIX}${sameId}`);
    expect((asGuest as { key: string }).key).toBe(`${GUEST_KEY_PREFIX}${sameId}`);
  });

  it('no customer and no guestId -> none', () => {
    expect(resolveViewer(req({}))).toEqual({ kind: 'none' });
  });

  it('empty customer id falls through to guestId', () => {
    const v = resolveViewer(req({ customer: { id: '' }, guestId: { id: GUEST_ID } }));
    expect(v).toEqual({ kind: 'guest', key: `${GUEST_KEY_PREFIX}${GUEST_ID}` });
  });

  it('empty customer id and no guestId -> none', () => {
    expect(resolveViewer(req({ customer: { id: '' } }))).toEqual({ kind: 'none' });
  });

  it('empty guestId falls through to none', () => {
    expect(resolveViewer(req({ guestId: { id: '' } }))).toEqual({ kind: 'none' });
  });
});
