import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  index,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { customers } from './customers';
import { addressTypeEnum } from './_enums';

/**
 * Customer shipping / billing addresses.
 *
 * `customer_id` is a COMPOSITE FK `(customer_id, tenant_id) -> customers(id, tenant_id)`
 * so an address can never straddle tenants. `country` is TEXT (ISO 3166-1)
 * with a `char_length = 2` CHECK (text+CHECK, not char(2) — see product_variants).
 * CASCADE on the customer FK; `tenant_id` CASCADE to tenants.
 */
export const customerAddresses = pgTable(
  'customer_addresses',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').notNull(),
    type: addressTypeEnum('type').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    name: text('name').notNull(),
    company: text('company'),
    line1: text('line1').notNull(),
    line2: text('line2'),
    city: text('city').notNull(),
    postalCode: text('postal_code').notNull(),
    region: text('region'),
    country: text('country').notNull(),
    phone: text('phone'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    customerFk: foreignKey({
      columns: [t.customerId, t.tenantId],
      foreignColumns: [customers.id, customers.tenantId],
      name: 'customer_addresses_customer_fk',
    }).onDelete('cascade'),
    customerIdx: index('customer_addresses_customer_idx').on(t.customerId),
    tenantIdx: index('customer_addresses_tenant_idx').on(t.tenantId),
    countryChk: check('customer_addresses_country_chk', sql`char_length(${t.country}) = 2`),
  }),
);

export type CustomerAddress = typeof customerAddresses.$inferSelect;
export type NewCustomerAddress = typeof customerAddresses.$inferInsert;
