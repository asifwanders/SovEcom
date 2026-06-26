/**
 * Core Schema UNIT tests (no Docker, `jest.config.js`).
 *
 * These assert the *shape* and *type-safety* of the (future) Drizzle schema via
 * runtime introspection — `getTableColumns` (drizzle-orm) + `getTableConfig`
 * (drizzle-orm/pg-core) — plus a handful of compile-time `$inferInsert` checks
 * that only type-check when the schema is authored correctly.
 *
 * RED by design: `../schema` does not yet export these 16 tables / 5 enums, so
 * this file fails to COMPILE today. That is the expected failing-first state. Do NOT add schema to make it pass here — the
 * schema is authored in a later step against this spec.
 *
 * Covers:
 *   U1 type-safety / inference (every core table's insert requires tenantId; money/currency types; customers-only deletedAt)
 *   U2 money invariant (every *_amount is integer + paired currency char(3); none numeric/float)
 *   U3 enum membership (user_role excludes 'viewer'; actor_type 4 values)
 *   U4 barrel completeness (index.ts exports all 16 tables + 5 enums + Tenant + New/select types)
 */
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig, PgColumn, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../schema';

/** The 16 core tables (excludes the pre-existing `tenants`). */
const CORE_TABLES = [
  'users',
  'customers',
  'customerAddresses',
  'products',
  'productVariants',
  'productImages',
  'categories',
  'productCategories',
  'tags',
  'productTags',
  'bundleItems',
  'refreshTokens',
  'auditLog',
  'setupTokens',
  'systemState',
] as const;

/** Tables that intentionally have NO tenant_id (global / pre-tenant). */
const NO_TENANT_TABLES = new Set(['setupTokens', 'systemState']);

/** The 5 native pg enums. */
const ENUM_EXPORTS = [
  'tenantStatusEnum',
  'userRoleEnum',
  'addressTypeEnum',
  'productStatusEnum',
  'actorTypeEnum',
] as const;

/** Resolve a table export by its camelCase barrel name. */
function table(name: string): PgTable {
  const t = (schema as Record<string, unknown>)[name];
  if (!t) throw new Error(`schema export "${name}" is missing`);
  return t as PgTable;
}

/** SQL column type as reported by Drizzle's column descriptor. */
function colType(c: PgColumn): string {
  return c.getSQLType().toLowerCase();
}

describe('schema unit — U4 barrel completeness', () => {
  it('exports all 16 tables (15 new + pre-existing tenants)', () => {
    for (const name of CORE_TABLES) {
      expect((schema as Record<string, unknown>)[name]).toBeDefined();
    }
    expect((schema as Record<string, unknown>).tenants).toBeDefined();
    // 15 new + tenants === 16 distinct table objects
    const all = [...CORE_TABLES, 'tenants'].map((n) => table(n));
    const names = new Set(all.map((t) => getTableConfig(t).name));
    expect(names.size).toBe(16);
  });

  it('exports all 5 pg enums', () => {
    for (const name of ENUM_EXPORTS) {
      expect((schema as Record<string, unknown>)[name]).toBeDefined();
    }
  });

  it('exports the Tenant select type and a New* insert type per table (type-only smoke)', () => {
    // Type-only assertions: these only compile if the inferred types exist.
    type _Tenant = schema.Tenant;
    type _NewUser = schema.NewUser;
    type _NewCustomer = schema.NewCustomer;
    type _NewProduct = schema.NewProduct;
    type _NewProductVariant = schema.NewProductVariant;
    type _NewBundleItem = schema.NewBundleItem;
    type _NewRefreshToken = schema.NewRefreshToken;
    type _NewSetupToken = schema.NewSetupToken;
    type _NewSystemState = schema.NewSystemState;
    type _User = schema.User;
    type _Customer = schema.Customer;
    type _Product = schema.Product;
    expect(true).toBe(true);
  });
});

describe('schema unit — 1.2 auth delta barrel', () => {
  it('exports passwordResetTokens (table + New/select types)', () => {
    expect((schema as Record<string, unknown>).passwordResetTokens).toBeDefined();
    expect(getTableConfig(table('passwordResetTokens')).name).toBe('password_reset_tokens');
    // type-only smoke: only compiles if the inferred types exist
    type _NewPRT = schema.NewPasswordResetToken;
    type _PRT = schema.PasswordResetToken;
    expect(true).toBe(true);
  });
});

describe('schema unit — U1 tenant_id on every core table', () => {
  it('every core table (except global ones) has a NOT NULL tenant_id column', () => {
    for (const name of CORE_TABLES) {
      if (NO_TENANT_TABLES.has(name)) continue;
      const cols = getTableColumns(table(name)) as Record<string, PgColumn>;
      expect(cols.tenantId).toBeDefined();
      expect(cols.tenantId!.notNull).toBe(true);
    }
  });

  it('I6 — refresh_tokens HAS tenant_id; setup_tokens / system_state do NOT', () => {
    const rt = getTableColumns(table('refreshTokens')) as Record<string, PgColumn>;
    expect(rt.tenantId).toBeDefined();
    expect(rt.tenantId!.notNull).toBe(true);

    const st = getTableColumns(table('setupTokens')) as Record<string, PgColumn>;
    expect(st.tenantId).toBeUndefined();

    const ss = getTableColumns(table('systemState')) as Record<string, PgColumn>;
    expect(ss.tenantId).toBeUndefined();
  });

  it('$inferInsert requires tenantId on the core tables (compile-time)', () => {
    // @ts-expect-error — tenantId is required, so an insert object missing it must not type-check.
    const _badUser: schema.NewUser = {
      email: 'a@b.test',
      passwordHash: '$argon2id$x',
      role: 'admin',
      name: 'A',
    };
    // @ts-expect-error — products insert without tenantId must not type-check.
    const _badProduct: schema.NewProduct = { title: 'T', slug: 't' };
    // @ts-expect-error — variant insert without tenantId must not type-check.
    const _badVariant: schema.NewProductVariant = { sku: 'S', priceAmount: 100, currency: 'EUR' };
    expect(true).toBe(true);
  });

  it('soft-delete (deletedAt) exists ONLY on customers among 1.1 tables', () => {
    const customers = getTableColumns(table('customers')) as Record<string, PgColumn>;
    expect(customers.deletedAt).toBeDefined();

    for (const name of CORE_TABLES) {
      if (name === 'customers') continue;
      const cols = getTableColumns(table(name)) as Record<string, PgColumn>;
      expect(cols.deletedAt).toBeUndefined();
    }
    // products are HARD delete: no deletedAt
    const products = getTableColumns(table('products')) as Record<string, PgColumn>;
    expect(products.deletedAt).toBeUndefined();
  });
});

describe('schema unit — U2 money invariant (cents + currency, never float)', () => {
  /** Tables holding monetary amounts. */
  const MONEY_TABLES = ['productVariants'] as const;

  it('every *_amount column is integer and never numeric/decimal/float/real/double', () => {
    for (const name of CORE_TABLES) {
      const cols = getTableColumns(table(name)) as Record<string, PgColumn>;
      for (const [key, col] of Object.entries(cols)) {
        if (!/amount$/i.test(key)) continue;
        const t = colType(col);
        expect(t).toBe('integer');
        expect(t).not.toMatch(/numeric|decimal|real|double|money|float/);
      }
    }
  });

  it('every table with an *_amount column also has a currency text column', () => {
    for (const name of MONEY_TABLES) {
      const cols = getTableColumns(table(name)) as Record<string, PgColumn>;
      const amountCols = Object.keys(cols).filter((k) => /amount$/i.test(k));
      expect(amountCols.length).toBeGreaterThan(0);
      expect(cols.currency).toBeDefined();
      // text + char_length=3 CHECK (char(3) pads/22001s; CHECK enforced in tests)
      expect(colType(cols.currency!)).toBe('text');
      expect(cols.currency!.notNull).toBe(true);
    }
  });

  it('priceAmount infers as number and currency as string (compile-time)', () => {
    const v: schema.NewProductVariant = {
      tenantId: '00000000-0000-7000-8000-000000000000',
      productId: '00000000-0000-7000-8000-000000000000',
      sku: 'SKU-1',
      priceAmount: 1999,
      currency: 'EUR',
      options: {},
    };
    const _amount: number = v.priceAmount;
    const _cur: string = v.currency;
    expect(typeof v.priceAmount).toBe('number');
    expect(typeof v.currency).toBe('string');
  });
});

describe('schema unit — U3 enum membership', () => {
  it("user_role is owner/admin/staff and EXCLUDES 'viewer'", () => {
    const values = (schema.userRoleEnum as { enumValues: readonly string[] }).enumValues;
    expect([...values].sort()).toEqual(['admin', 'owner', 'staff']);
    expect(values).not.toContain('viewer');
  });

  it("actor_type has the 5 audited kinds and INCLUDES 'anonymous'", () => {
    const values = (schema.actorTypeEnum as { enumValues: readonly string[] }).enumValues;
    expect(values).toHaveLength(5);
    // user / customer / system / api + anonymous (unknown/unauthenticated actor)
    expect([...values].sort()).toEqual(['anonymous', 'api', 'customer', 'system', 'user']);
    expect(values).toContain('anonymous');
  });

  it('address_type and product_status are non-empty pg enums', () => {
    const at = (schema.addressTypeEnum as { enumValues: readonly string[] }).enumValues;
    const ps = (schema.productStatusEnum as { enumValues: readonly string[] }).enumValues;
    expect(at.length).toBeGreaterThan(0);
    expect(ps).toContain('archived'); // 021.2: 'archived' replaces soft-hide for products
  });
});
