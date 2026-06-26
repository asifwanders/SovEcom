import { pgTable, uuid, text, timestamp, index, unique, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { pageStatusEnum } from './_enums';

/**
 * CMS-lite content pages. Editable legal + marketing copy
 * (terms, privacy, CGV, about, withdrawal info, blog-lite) a merchant can edit without
 * code; surfaced by the theme `(legal)/[slug]` + content routes. Locale-aware (FR/EN —
 * i18n: one row per `(tenant_id, slug, locale)`.
 *
 * `locale` is CHAR(2) modelled as TEXT + a `char_length = 2` CHECK — the
 * established schema idiom (text+CHECK, never char(2); see product_variants.ts / tax_rates.ts).
 * The DB column default stays 'fr' even though the app default locale is 'en'.
 *
 * Tenant-scoped: `tenant_id` is NOT NULL with a CASCADE FK → tenants,
 * mirroring `categories.ts`.
 */
export const pages = pgTable(
  'pages',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    locale: text('locale').notNull().default('fr'),
    status: pageStatusEnum('status').notNull().default('draft'),
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    slugLocaleUq: unique('pages_tenant_slug_locale_uq').on(t.tenantId, t.slug, t.locale),
    tenantStatusIdx: index('pages_tenant_status_idx').on(t.tenantId, t.status),
    localeChk: check('pages_locale_chk', sql`char_length(${t.locale}) = 2`),
  }),
);

export type Page = typeof pages.$inferSelect;
export type NewPage = typeof pages.$inferInsert;
