import { pgTable, uuid, text, integer, timestamp, jsonb, unique, index } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';

/**
 * Generic image records.
 *
 * NOT linked to products here — future versions add `product_images → images` via a
 * composite FK using the `UNIQUE(id, tenant_id)` declared on this table.
 *
 * `variants` jsonb shape:
 *   { "large": {"avif": "<key>","webp":"<key>","jpeg":"<key>"}, "medium":{...},
 *     "small":{...}, "thumbnail":{...} }
 *
 * Storage keys in `variants` are bare object keys (not URLs). Public URLs are
 * derived at read time via StorageService.getPublicUrl so the CDN root can
 * change without a data migration.
 */
export const images = pgTable(
  'images',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    originalKey: text('original_key').notNull(),
    format: text('format').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    variants: jsonb('variants').notNull(),
    altText: text('alt_text'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /** Allows future product_images to compose-FK via (id, tenant_id). */
    idTenantUq: unique('images_id_tenant_uq').on(t.id, t.tenantId),
    tenantIdx: index('images_tenant_idx').on(t.tenantId),
  }),
);

export type Image = typeof images.$inferSelect;
export type NewImage = typeof images.$inferInsert;
