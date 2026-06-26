/**
 * recently-viewed — viewer-identity resolution unit tests (account vs guest vs none).
 *
 * The resolved `key` is NAMESPACE-PREFIXED by kind (`cust:` / `guest:`) so the customer and guest
 * key spaces are disjoint — a guest token can never collide with a customer's id.
 */
import { describe, it, expect } from 'vitest';
import type { ModuleHttpRequest } from '@sovecom/module-sdk';
import {
  resolveViewer,
  MIN_GUEST_TOKEN_LEN,
  MAX_GUEST_TOKEN_LEN,
  CUSTOMER_KEY_PREFIX,
  GUEST_KEY_PREFIX,
} from '../src/identity/viewer';

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

const GOOD_TOKEN = 'g'.repeat(MIN_GUEST_TOKEN_LEN);

describe('recently-viewed identity — resolveViewer', () => {
  it('a verified customer resolves to a cust:-prefixed key', () => {
    const v = resolveViewer(req({ customer: { id: 'cust-1' } }));
    expect(v).toEqual({ kind: 'customer', key: `${CUSTOMER_KEY_PREFIX}cust-1` });
  });

  it('a verified customer ALWAYS wins over a supplied guest token', () => {
    const v = resolveViewer(req({ customer: { id: 'cust-1' }, query: { guest: GOOD_TOKEN } }));
    expect(v).toEqual({ kind: 'customer', key: `${CUSTOMER_KEY_PREFIX}cust-1` });
  });

  it('a high-entropy guest token (header) resolves to a guest:-prefixed key', () => {
    const v = resolveViewer(req({ headers: { 'x-rv-guest': GOOD_TOKEN } }));
    expect(v).toEqual({ kind: 'guest', key: `${GUEST_KEY_PREFIX}${GOOD_TOKEN}` });
  });

  it('a high-entropy guest token (query) resolves to a guest:-prefixed key', () => {
    const v = resolveViewer(req({ query: { guest: GOOD_TOKEN } }));
    expect(v).toEqual({ kind: 'guest', key: `${GUEST_KEY_PREFIX}${GOOD_TOKEN}` });
  });

  it('the header takes precedence over the query for the guest token', () => {
    const headerToken = 'h'.repeat(MIN_GUEST_TOKEN_LEN);
    const v = resolveViewer(
      req({ headers: { 'x-rv-guest': headerToken }, query: { guest: GOOD_TOKEN } }),
    );
    expect(v).toEqual({ kind: 'guest', key: `${GUEST_KEY_PREFIX}${headerToken}` });
  });

  it('namespace isolation: a guest token EQUAL to a customer id yields a DIFFERENT key', () => {
    // The attack: a guest supplies a known customer's id as their token (≥16 chars → length-OK).
    const victimId = 'abcdef0123456789'; // 16 chars, would pass the floor
    const asCustomer = resolveViewer(req({ customer: { id: victimId } }));
    const asGuest = resolveViewer(req({ query: { guest: victimId } }));
    expect(asCustomer.kind).toBe('customer');
    expect(asGuest.kind).toBe('guest');
    // Same input string, but the namespaced keys can NEVER be equal → no cross-read.
    expect((asCustomer as { key: string }).key).not.toBe((asGuest as { key: string }).key);
    expect((asCustomer as { key: string }).key).toBe(`${CUSTOMER_KEY_PREFIX}${victimId}`);
    expect((asGuest as { key: string }).key).toBe(`${GUEST_KEY_PREFIX}${victimId}`);
  });

  it('no customer and no token → none', () => {
    expect(resolveViewer(req({}))).toEqual({ kind: 'none' });
  });

  it('a short / empty guest token is REJECTED (never shared by a guessable id)', () => {
    expect(resolveViewer(req({ query: { guest: '' } }))).toEqual({ kind: 'none' });
    expect(resolveViewer(req({ query: { guest: 'short' } }))).toEqual({ kind: 'none' });
    expect(resolveViewer(req({ query: { guest: 'g'.repeat(MIN_GUEST_TOKEN_LEN - 1) } }))).toEqual({
      kind: 'none',
    });
  });

  it('an over-long guest token is rejected', () => {
    expect(resolveViewer(req({ query: { guest: 'g'.repeat(MAX_GUEST_TOKEN_LEN + 1) } }))).toEqual({
      kind: 'none',
    });
  });

  it('a guest token bearing a control char is REJECTED (would crash a bound SQL param)', () => {
    // \x00 (NUL) embedded in an otherwise valid-length token. Escapes only — no raw control bytes.
    const withNul = 'gggggggg\x00ggggggg'; // 16 chars incl. the NUL
    expect(resolveViewer(req({ query: { guest: withNul } }))).toEqual({ kind: 'none' });
    const withCtrl = 'gggggggg\x1fggggggg';
    expect(resolveViewer(req({ headers: { 'x-rv-guest': withCtrl } }))).toEqual({ kind: 'none' });
    const withDel = 'gggggggg\x7fggggggg';
    expect(resolveViewer(req({ query: { guest: withDel } }))).toEqual({ kind: 'none' });
  });

  it('an empty customer id is treated as anonymous (falls through to token / none)', () => {
    expect(resolveViewer(req({ customer: { id: '' } }))).toEqual({ kind: 'none' });
    expect(resolveViewer(req({ customer: { id: '' }, query: { guest: GOOD_TOKEN } }))).toEqual({
      kind: 'guest',
      key: `${GUEST_KEY_PREFIX}${GOOD_TOKEN}`,
    });
  });
});
