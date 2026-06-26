/**
 * `pages` (CMS-lite content) schema UNIT tests.
 *
 * Asserts the *shape* of the new Drizzle `pages` table + `page_status` enum via
 * runtime introspection (`getTableColumns` + `getTableConfig`), mirroring the
 * style of `schema.spec.ts`. No Docker / DB connection (jest.config.js).
 *
 * RED until `pages.ts` + the `page_status` enum
 * exist and are exported from the barrel.
 *
 * Note on `locale`: per the established schema idiom
 * (product_variants.ts / tax_rates.ts — "never char(2)"), fixed-width codes are
 * modelled as TEXT + a `char_length = 2` CHECK. These tests assert that idiom.
 */
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig, PgColumn, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../schema';

function table(name: string): PgTable {
  const t = (schema as Record<string, unknown>)[name];
  if (!t) throw new Error(`schema export "${name}" is missing`);
  return t as PgTable;
}

function colType(c: PgColumn): string {
  return c.getSQLType().toLowerCase();
}

describe('schema unit — pages barrel + enum', () => {
  it('exports the pages table + Page/NewPage inferred types', () => {
    expect((schema as Record<string, unknown>).pages).toBeDefined();
    expect(getTableConfig(table('pages')).name).toBe('pages');
    // type-only smoke: only compiles if the inferred types exist
    type _Page = schema.Page;
    type _NewPage = schema.NewPage;
    expect(true).toBe(true);
  });

  it('exports the page_status enum with values [draft, published]', () => {
    expect((schema as Record<string, unknown>).pageStatusEnum).toBeDefined();
    const values = (schema.pageStatusEnum as { enumValues: readonly string[] }).enumValues;
    expect([...values]).toEqual(['draft', 'published']);
  });
});

describe('schema unit — pages columns', () => {
  const cols = () => getTableColumns(table('pages')) as Record<string, PgColumn>;

  it('id is a uuid primary key', () => {
    const id = cols().id!;
    expect(id).toBeDefined();
    expect(colType(id)).toBe('uuid');
    expect(id.primary).toBe(true);
  });

  it('tenant_id is uuid NOT NULL', () => {
    const t = cols().tenantId!;
    expect(t).toBeDefined();
    expect(colType(t)).toBe('uuid');
    expect(t.notNull).toBe(true);
  });

  it('slug / title / body are TEXT NOT NULL', () => {
    for (const key of ['slug', 'title', 'body']) {
      const c = cols()[key]!;
      expect(c).toBeDefined();
      expect(colType(c)).toBe('text');
      expect(c.notNull).toBe(true);
    }
  });

  it("locale is TEXT NOT NULL DEFAULT 'fr' (CHAR(2) via char_length CHECK idiom)", () => {
    const locale = cols().locale!;
    expect(locale).toBeDefined();
    expect(colType(locale)).toBe('text');
    expect(locale.notNull).toBe(true);
    expect(locale.default).toBe('fr');
  });

  it("status is the page_status enum, NOT NULL DEFAULT 'draft'", () => {
    const status = cols().status!;
    expect(status).toBeDefined();
    expect(colType(status)).toBe('page_status');
    expect(status.notNull).toBe(true);
    expect(status.default).toBe('draft');
  });

  it('seo_title / seo_description are TEXT nullable', () => {
    for (const key of ['seoTitle', 'seoDescription']) {
      const c = cols()[key]!;
      expect(c).toBeDefined();
      expect(colType(c)).toBe('text');
      expect(c.notNull).toBe(false);
    }
  });

  it('created_at / updated_at are timestamptz NOT NULL', () => {
    for (const key of ['createdAt', 'updatedAt']) {
      const c = cols()[key]!;
      expect(c).toBeDefined();
      expect(colType(c)).toBe('timestamp with time zone');
      expect(c.notNull).toBe(true);
    }
  });
});

describe('schema unit — pages constraints/indexes', () => {
  it('has UNIQUE (tenant_id, slug, locale)', () => {
    const cfg = getTableConfig(table('pages'));
    const uq = cfg.uniqueConstraints.find((u) => {
      const names = u.columns.map((c) => c.name).sort();
      return (
        names.length === 3 &&
        names.includes('tenant_id') &&
        names.includes('slug') &&
        names.includes('locale')
      );
    });
    expect(uq).toBeDefined();
  });

  it('has a non-unique index (tenant_id, status)', () => {
    const cfg = getTableConfig(table('pages'));
    const idx = cfg.indexes.find((i) => {
      const names = (i.config.columns as { name: string }[]).map((c) => c.name).sort();
      return (
        !i.config.unique &&
        names.length === 2 &&
        names.includes('tenant_id') &&
        names.includes('status')
      );
    });
    expect(idx).toBeDefined();
  });

  it('has a char_length=2 CHECK on locale (idiom for CHAR(2))', () => {
    const cfg = getTableConfig(table('pages'));
    expect(cfg.checks.length).toBeGreaterThan(0);
    const localeChk = cfg.checks.find((c) => c.name.includes('locale'));
    expect(localeChk).toBeDefined();
  });

  it('NewPage insert requires tenantId (compile-time)', () => {
    // @ts-expect-error — tenantId is required, so an insert missing it must not type-check.
    const _bad: schema.NewPage = { slug: 's', title: 't', body: 'b' };
    expect(true).toBe(true);
  });
});
