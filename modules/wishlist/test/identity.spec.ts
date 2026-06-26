/**
 * wishlist -- viewer-identity resolution unit tests (account vs guest vs none).
 *
 * resolveViewer returns only the viewer KIND. The raw id is read directly from
 * req.customer.id / req.guestId.id by handlers and passed to the appropriate
 * repository method (customer table vs guest table) -- no prefixed key is needed.
 */
import { describe, it, expect } from 'vitest';
import type { ModuleHttpRequest } from '@sovecom/module-sdk';
import { resolveViewer } from '../src/identity/viewer';

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
  it('a verified customer resolves to kind=customer', () => {
    const v = resolveViewer(req({ customer: { id: 'cust-1' } }));
    expect(v.kind).toBe('customer');
  });

  it('a verified customer ALWAYS wins over a supplied guestId', () => {
    const v = resolveViewer(req({ customer: { id: 'cust-1' }, guestId: { id: GUEST_ID } }));
    expect(v.kind).toBe('customer');
  });

  it('a core-derived guestId resolves to kind=guest', () => {
    const v = resolveViewer(req({ guestId: { id: GUEST_ID } }));
    expect(v.kind).toBe('guest');
  });

  it('no customer and no guestId -> kind=none', () => {
    expect(resolveViewer(req({}))).toEqual({ kind: 'none' });
  });

  it('empty customer id falls through to guestId', () => {
    const v = resolveViewer(req({ customer: { id: '' }, guestId: { id: GUEST_ID } }));
    expect(v.kind).toBe('guest');
  });

  it('empty customer id and no guestId -> kind=none', () => {
    expect(resolveViewer(req({ customer: { id: '' } }))).toEqual({ kind: 'none' });
  });

  it('empty guestId falls through to none', () => {
    expect(resolveViewer(req({ guestId: { id: '' } }))).toEqual({ kind: 'none' });
  });
});
