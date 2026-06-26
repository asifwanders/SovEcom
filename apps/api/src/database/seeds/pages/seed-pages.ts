/**
 * Seeds the default EU legal/content `pages`
 * (FR + EN) for a tenant.
 *
 * WHAT: a fixed set of TEMPLATE pages (privacy, terms/CGV, cookies, legal
 * notice/mentions légales, right-of-withdrawal + the EU model form), each in BOTH
 * `en` and `fr`, `status='published'` so the storefront footer links resolve and
 * the AC "published pages render" is demonstrable. Every body carries a prominent
 * counsel notice + `[BRACKETED]` placeholders (Prime Directive #7) — no binding
 * legal prose is invented; the EU model withdrawal form (Annex I(B), Dir.
 * 2011/83/EU) is the one standardized statutory instrument reproduced.
 *
 * IDEMPOTENT: every insert uses `ON CONFLICT (tenant_id, slug, locale) DO NOTHING`
 * (the `pages_tenant_slug_locale_uq` UNIQUE), so re-running never errors and never
 * duplicates. Returns the number of rows actually inserted.
 *
 * NON-BLOCKING: callers in a provisioning/setup path MUST treat a thrown error as
 * non-fatal (log + continue) — seeding default content must never block tenant
 * creation. This function does not swallow errors itself so tests can assert on
 * them; the install seed (`seed.ts`) wraps the call in try/catch.
 *
 * Goes through the Drizzle insert API on the `pages` schema (so the `id`
 * uuidv7 `$defaultFn` applies) and is tenant-scoped: every row carries the passed
 * `tenantId`. It does NOT use the Nest `PagesService` because the install seed is a
 * standalone script with no Nest DI container; the insert path + uniqueness
 * guarantees match what the service relies on.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { pages } from '../../schema/pages';
import { EN_PAGES } from './en';
import { FR_PAGES } from './fr';
import { SEED_PAGE_SLUGS } from './types';

/** Minimal db surface this seeder needs — satisfied by the app + harness Drizzle db. */
type SeedDb = Pick<PostgresJsDatabase<Record<string, unknown>>, 'insert'>;

/**
 * Idempotently seed the default FR+EN legal/content pages for `tenantId`.
 * Returns the count of rows inserted on this run (0 on a repeat run).
 */
export async function seedDefaultPages(db: SeedDb, tenantId: string): Promise<number> {
  const rows = SEED_PAGE_SLUGS.flatMap((slug) => {
    const en = EN_PAGES[slug];
    const fr = FR_PAGES[slug];
    return [
      {
        tenantId,
        slug,
        locale: 'en',
        title: en.title,
        body: en.body,
        status: 'published' as const,
        seoTitle: en.seoTitle ?? null,
        seoDescription: en.seoDescription ?? null,
      },
      {
        tenantId,
        slug,
        locale: 'fr',
        title: fr.title,
        body: fr.body,
        status: 'published' as const,
        seoTitle: fr.seoTitle ?? null,
        seoDescription: fr.seoDescription ?? null,
      },
    ];
  });

  const inserted = await db
    .insert(pages)
    .values(rows)
    // On a re-run the (tenant, slug, locale) UNIQUE collides — skip, never error.
    .onConflictDoNothing({ target: [pages.tenantId, pages.slug, pages.locale] })
    .returning({ id: pages.id });

  return inserted.length;
}
