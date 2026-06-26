import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  jsonb,
  vector,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { productStatusEnum } from './_enums';

/**
 * Catalog products — HARD delete (soft-hide is `status='archived'`).
 *
 * `embedding` is a nullable `vector(1536)` for AI-readiness (the ANN index is
 * deferred until populated). A GIN trigram index on `title` powers fuzzy lookup.
 * Parent of variants / images / junctions / bundle_items, so it declares
 * `UNIQUE(id, tenant_id)` to anchor every composite child FK.
 */
export const products = pgTable(
  'products',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    status: productStatusEnum('status').notNull().default('draft'),
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    isBundle: boolean('is_bundle').notNull().default(false),
    embedding: vector('embedding', { dimensions: 1536 }),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idTenantUq: unique('products_id_tenant_uq').on(t.id, t.tenantId),
    slugUq: unique('products_tenant_slug_uq').on(t.tenantId, t.slug),
    statusIdx: index('products_tenant_status_idx').on(t.tenantId, t.status),
    titleTrgmIdx: index('products_title_trgm_idx').using('gin', sql`${t.title} gin_trgm_ops`),
  }),
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
