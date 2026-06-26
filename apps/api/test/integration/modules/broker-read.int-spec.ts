/**
 * BrokerReadAdapter integration (privacy + tenant + soft-delete).
 *
 * The adapter is the single place module-visible core data is selected. Against a REAL DB this
 * proves the security-relevant properties end-to-end:
 *   - `read:customers` is FIELD-LIMITED — even with email/phone/VAT in the row, the DTO carries
 *     none of it;
 *   - every read is tenant-scoped (tenant B's data is invisible to tenant A);
 *   - soft-deleted customers/orders are excluded.
 */
import { eq } from 'drizzle-orm';

import {
  bootAuthApp,
  teardownAuthApp,
  resetAuthState,
  seedAdmin,
  AuthHarness,
} from '../auth/_auth-harness';
import { customers } from '../../../src/database/schema/customers';
import { BrokerReadAdapter } from '../../../src/modules/runtime/broker-read.adapter';

describe('BrokerReadAdapter (integration)', () => {
  let h: AuthHarness;
  let adapter: BrokerReadAdapter;

  beforeAll(async () => {
    h = await bootAuthApp();
    adapter = h.app.get(BrokerReadAdapter);
  });
  afterAll(async () => {
    await teardownAuthApp(h);
  });
  beforeEach(async () => {
    await resetAuthState(h);
    await h.db.delete(customers);
  });

  it('customers.list is FIELD-LIMITED (no email/phone/VAT) and tenant-scoped', async () => {
    const a = await seedAdmin(h, { role: 'admin' });
    const b = await seedAdmin(h, { role: 'admin' });

    await h.db.insert(customers).values([
      {
        tenantId: a.tenantId,
        email: 'alice@example.com',
        name: 'Alice',
        phone: '+33123456789',
        vatNumber: 'FR12345678901',
      },
      {
        tenantId: b.tenantId,
        email: 'bob@other.com',
        name: 'Bob',
      },
    ]);

    const res = await adapter.customers.list(a.tenantId, { limit: 50 });

    // tenant scoping: only tenant A's customer.
    expect(res.items).toHaveLength(1);
    const dto = res.items[0]!;
    expect(dto.displayName).toBe('Alice');
    // field-limited: NO PII keys, and none of the PII values leaked anywhere in the DTO.
    expect(Object.keys(dto).sort()).toEqual(['createdAt', 'displayName', 'id', 'locale']);
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain('alice@example.com');
    expect(serialized).not.toContain('+33123456789');
    expect(serialized).not.toContain('FR12345678901');
  });

  it('excludes soft-deleted customers', async () => {
    const a = await seedAdmin(h, { role: 'admin' });
    await h.db.insert(customers).values([
      { tenantId: a.tenantId, email: 'live@example.com', name: 'Live' },
      { tenantId: a.tenantId, email: 'gone@example.com', name: 'Gone', deletedAt: new Date() },
    ]);

    const res = await adapter.customers.list(a.tenantId, { limit: 50 });
    expect(res.items.map((c) => c.displayName)).toEqual(['Live']);

    // get on the soft-deleted row returns null.
    const [goneRow] = await h.db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.email, 'gone@example.com'));
    expect(await adapter.customers.get(a.tenantId, goneRow!.id)).toBeNull();
  });
});
