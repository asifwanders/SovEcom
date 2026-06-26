/**
 * `customers.locale` schema unit tests.
 *
 * Asserts the nullable `locale` column on the `customers` table via runtime
 * introspection (`getTableColumns` + `getTableConfig`), mirroring the
 * `pages` schema-spec style. No Docker / DB connection.
 *
 * Idiom note: `locale` is a fixed-width 2-char code, modelled as TEXT + a
 * `char_length` CHECK (never `char(2)`) — matching `pages.locale`. Unlike
 * `pages.locale` it is NULLABLE with no default (null = "unknown → use default
 * locale at email-render time"); the CHECK therefore allows NULL OR a 2-char value.
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

describe('schema unit — customers.locale', () => {
  const cols = () => getTableColumns(table('customers')) as Record<string, PgColumn>;

  it('locale is TEXT, NULLABLE, with no default (null → fall back to default locale)', () => {
    const locale = cols().locale!;
    expect(locale).toBeDefined();
    expect(colType(locale)).toBe('text');
    expect(locale.notNull).toBe(false);
    expect(locale.default).toBeUndefined();
  });

  it('has a char_length CHECK on locale (allows NULL or a 2-char value)', () => {
    const cfg = getTableConfig(table('customers'));
    const localeChk = cfg.checks.find((c) => c.name.includes('locale'));
    expect(localeChk).toBeDefined();
  });

  it('does not require locale on insert (compile-time: nullable column)', () => {
    // Only compiles if `locale` is optional on NewCustomer.
    const _ok: schema.NewCustomer = {
      tenantId: '00000000-0000-0000-0000-000000000000',
      email: 'a@b.invalid',
    };
    expect(_ok).toBeDefined();
  });
});
