/**
 * customer serializer UNIT tests.
 *
 * The store self-service view is an EXPLICIT allowlist (no row spread), so a new field only reaches a
 * response if it is named here. These tests pin the `pendingEmail` exposure added for the email-change
 * UI: it surfaces the proposed new address when a change is in flight, and is `null` otherwise. They
 * also guard the standing hard rule that secrets (`passwordHash`, `totpSecret`) NEVER leak into a view.
 */
import { toStoreCustomerView, toAdminCustomerView } from './customer.serializer';
import type { Customer } from '../database/schema/customers';

/** A minimal Customer row with every allowlisted field set; secrets present to prove they never leak. */
function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'cus_1',
    tenantId: 'tnt_1',
    email: 'alice@example.com',
    name: 'Alice',
    phone: null,
    isB2b: false,
    vatNumber: null,
    vatValidated: false,
    vatValidatedAt: null,
    taxExempt: false,
    acceptsMarketing: false,
    locale: null,
    pendingEmail: null,
    tokenVersion: 0,
    stripeCustomerId: null,
    passwordHash: 'SECRET-HASH',
    totpSecret: 'SECRET-TOTP',
    metadata: { vatValidationProof: 'internal' },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  } as unknown as Customer;
}

describe('toStoreCustomerView — pendingEmail exposure', () => {
  it('includes pendingEmail = null when no email change is in flight', () => {
    const view = toStoreCustomerView(makeCustomer({ pendingEmail: null }));
    expect(view).toHaveProperty('pendingEmail', null);
  });

  it('includes pendingEmail = the proposed address when a change is in flight', () => {
    const view = toStoreCustomerView(makeCustomer({ pendingEmail: 'new@example.com' }));
    expect(view.pendingEmail).toBe('new@example.com');
  });

  it('coerces an undefined column to null (never undefined in the response)', () => {
    const view = toStoreCustomerView(makeCustomer({ pendingEmail: undefined as unknown as null }));
    expect(view.pendingEmail).toBeNull();
  });

  it('never leaks secrets (passwordHash / totpSecret / raw metadata)', () => {
    const view = toStoreCustomerView(makeCustomer());
    expect(view).not.toHaveProperty('passwordHash');
    expect(view).not.toHaveProperty('totpSecret');
    expect(view).not.toHaveProperty('metadata');
  });
});

describe('toAdminCustomerView — inherits pendingEmail', () => {
  it('carries pendingEmail through from the store view', () => {
    const view = toAdminCustomerView(makeCustomer({ pendingEmail: 'new@example.com' }));
    expect(view.pendingEmail).toBe('new@example.com');
    // and still no secrets
    expect(view).not.toHaveProperty('passwordHash');
    expect(view).not.toHaveProperty('totpSecret');
  });
});
