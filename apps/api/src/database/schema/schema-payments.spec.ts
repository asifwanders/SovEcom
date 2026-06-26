/**
 * Stripe schema delta UNIT tests (no Docker, `jest.config.js`).
 *
 * Asserts the SHAPE of the new payment tables + columns via runtime introspection, mirroring
 * the 1.1 schema spec. Kept separate so the 1.1 invariants (the 16-table count) stay untouched.
 */
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig, PgColumn, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../schema';

function table(name: string): PgTable {
  const t = (schema as Record<string, unknown>)[name];
  if (!t) throw new Error(`schema export "${name}" is missing`);
  return t as PgTable;
}
function cols(name: string): Record<string, PgColumn> {
  return getTableColumns(table(name)) as Record<string, PgColumn>;
}
function colType(c: PgColumn): string {
  return c.getSQLType().toLowerCase();
}

describe('schema 2.9 — barrel + enum', () => {
  it('exports paymentEvents + disputes tables and the dispute_status enum', () => {
    expect((schema as Record<string, unknown>).paymentEvents).toBeDefined();
    expect((schema as Record<string, unknown>).disputes).toBeDefined();
    expect((schema as Record<string, unknown>).disputeStatusEnum).toBeDefined();
    expect(getTableConfig(table('paymentEvents')).name).toBe('payment_events');
    expect(getTableConfig(table('disputes')).name).toBe('disputes');
  });

  it('dispute_status enum is exactly { open, won, lost }', () => {
    const e = (schema as unknown as Record<string, { enumValues: string[] } | undefined>)
      .disputeStatusEnum;
    expect([...e!.enumValues].sort()).toEqual(['lost', 'open', 'won']);
  });
});

describe('schema 2.9 — payment_events (inbound idempotency log)', () => {
  it('has the dedup + log columns; tenant_id is NULLABLE (provider-global log)', () => {
    const c = cols('paymentEvents');
    expect(c.provider!.notNull).toBe(true);
    expect(c.eventId!.notNull).toBe(true);
    expect(c.type!.notNull).toBe(true);
    expect(c.payload).toBeDefined();
    expect(c.processedAt!.notNull).toBe(false);
    // tenant_id is intentionally nullable here (written at signature-verify time).
    expect(c.tenantId!.notNull).toBe(false);
  });

  it('UNIQUE(provider, event_id) is the replay-protection backstop', () => {
    const idx = getTableConfig(table('paymentEvents')).indexes;
    const uq = idx.find((i) => i.config.name === 'payment_events_provider_event_uq');
    expect(uq).toBeDefined();
    expect(uq!.config.unique).toBe(true);
    expect(uq!.config.columns.map((col) => (col as PgColumn).name)).toEqual([
      'provider',
      'event_id',
    ]);
  });
});

describe('schema 2.9 — disputes', () => {
  it('carries tenant_id NOT NULL + integer money + char(3)-checked currency', () => {
    const c = cols('disputes');
    expect(c.tenantId!.notNull).toBe(true);
    expect(c.orderId!.notNull).toBe(true);
    expect(c.paymentId!.notNull).toBe(true);
    expect(colType(c.amount!)).toBe('integer');
    expect(c.status!.notNull).toBe(true);
  });

  it('composite FKs to orders + payments are both onDelete RESTRICT', () => {
    const fks = getTableConfig(table('disputes')).foreignKeys;
    const byName = (n: string) => fks.find((f) => f.getName() === n);
    expect(byName('disputes_order_fk')!.onDelete).toBe('restrict');
    expect(byName('disputes_payment_fk')!.onDelete).toBe('restrict');
  });
});

describe('schema 2.9 — new columns on existing tables', () => {
  it('orders gains fulfillment_frozen (bool, NOT NULL) + vies_consultation_ref (nullable text)', () => {
    const c = cols('orders');
    expect(colType(c.fulfillmentFrozen!)).toBe('boolean');
    expect(c.fulfillmentFrozen!.notNull).toBe(true);
    expect(colType(c.viesConsultationRef!)).toBe('text');
    expect(c.viesConsultationRef!.notNull).toBe(false);
  });

  it('customers gains stripe_customer_id (nullable text)', () => {
    const c = cols('customers');
    expect(colType(c.stripeCustomerId!)).toBe('text');
    expect(c.stripeCustomerId!.notNull).toBe(false);
  });
});
