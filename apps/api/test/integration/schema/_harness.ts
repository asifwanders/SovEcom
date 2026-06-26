/**
 * Shared connection / migrate idiom for the schema integration tests,
 * modelled on `test/integration/database.int-spec.ts`.
 *
 * Each I1–I7 spec opens a single (`max: 1`) postgres client, runs the Drizzle
 * migrator against `src/database/migrations`, and exercises raw SQL + the typed
 * `db` against a real Postgres (DATABASE_URL — docker-compose.dev locally / CI
 * service container). RED today: importing `../../../src/database/schema`
 * pulls in tables that do not exist yet, so these fail to compile / migrate.
 */
import postgres from 'postgres';
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { uuidv7 } from 'uuidv7';
import * as schema from '../../../src/database/schema';

export const MIGRATIONS = 'src/database/migrations';

export type Sql = ReturnType<typeof postgres>;
export type Db = PostgresJsDatabase<typeof schema>;
export { schema };

export function connect(): { client: Sql; db: Db } {
  const url = process.env.DATABASE_URL as string;
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });
  return { client, db };
}

export async function migrateUp(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS });
}

/** New time-sortable id for fixtures. */
export const newId = (): string => uuidv7();

/**
 * Wipe all 1.1 core data between tests without dropping the schema.
 * `audit_log.tenant_id` is RESTRICT, so audit rows must be truncated alongside
 * tenants in one statement. CASCADE clears the dependent catalog/identity rows.
 */
export async function truncateAll(client: Sql): Promise<void> {
  await client.unsafe(`
    TRUNCATE TABLE
      refund_line_items, refunds, payments, discount_usages, discounts,
      returns, invoices, invoice_counters, order_status_history, order_items, orders,
      inventory_reservations, cart_items, carts,
      shipping_rates, shipping_zones, tax_rates,
      audit_log, refresh_tokens, password_reset_tokens, bundle_items, product_tags,
      product_categories, product_images, product_variants, products, categories, tags,
      customer_addresses, customers, users, setup_tokens, system_state, tenants
    RESTART IDENTITY CASCADE
  `);
}

/** Insert a bare tenant directly via SQL (avoids depending on insert helpers). */
export async function makeTenant(client: Sql, slug: string): Promise<string> {
  const id = newId();
  await client`
    insert into tenants (id, name, slug) values (${id}, ${slug}, ${slug})
  `;
  return id;
}
