/**
 * PagesRepository.
 *
 * All Drizzle queries for the CMS-lite `pages` table. EVERY query filters
 * `tenant_id` (tenant isolation, mirrors CategoriesRepository). The store read
 * keys on the `(tenant_id, slug, locale)` UNIQUE and additionally filters
 * `status='published'`; admin CRUD keys by id, tenant-scoped. List supports
 * optional locale + status filters.
 */
import { Injectable } from '@nestjs/common';
import { and, eq, asc, type SQL } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { pages, type Page, type NewPage } from '../../database/schema/pages';

/** A `pages` row as returned to admin reads (the table has no large columns to omit). */
export type PageRow = Page;

/** Allowed list filters for the admin listing endpoint. */
export interface PageListFilter {
  locale?: 'fr' | 'en';
  status?: 'draft' | 'published';
}

@Injectable()
export class PagesRepository {
  constructor(private readonly db: DatabaseService) {}

  // ── Store read: published row for (tenant, slug, locale) ───────────────────

  /**
   * The public store lookup. Returns ONLY a `status='published'` row matching
   * `(tenant_id, slug, locale)` exactly — no default-locale fallback (
   *8). A draft / unknown / wrong-locale row resolves to null → 404.
   */
  async findPublishedBySlugLocale(
    tenantId: string,
    slug: string,
    locale: string,
  ): Promise<PageRow | null> {
    const rows = await this.db.db
      .select()
      .from(pages)
      .where(
        and(
          eq(pages.tenantId, tenantId),
          eq(pages.slug, slug),
          eq(pages.locale, locale),
          eq(pages.status, 'published'),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  // ── Admin reads ────────────────────────────────────────────────────────────

  async findById(tenantId: string, id: string): Promise<PageRow | null> {
    const rows = await this.db.db
      .select()
      .from(pages)
      .where(and(eq(pages.id, id), eq(pages.tenantId, tenantId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async findAll(tenantId: string, filter: PageListFilter = {}): Promise<PageRow[]> {
    const conditions: SQL[] = [eq(pages.tenantId, tenantId)];
    if (filter.locale) conditions.push(eq(pages.locale, filter.locale));
    if (filter.status) conditions.push(eq(pages.status, filter.status));
    return this.db.db
      .select()
      .from(pages)
      .where(and(...conditions))
      .orderBy(asc(pages.slug), asc(pages.locale));
  }

  // ── Mutations (id is app-generated uuidv7 via $defaultFn on the schema) ─────

  async insert(value: NewPage): Promise<PageRow> {
    const rows = await this.db.db.insert(pages).values(value).returning();
    return rows[0]!;
  }

  async update(tenantId: string, id: string, patch: Partial<NewPage>): Promise<PageRow | null> {
    const rows = await this.db.db
      .update(pages)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(pages.id, id), eq(pages.tenantId, tenantId)))
      .returning();
    return rows[0] ?? null;
  }

  /** Hard-delete a page by id (tenant-scoped). Returns true if a row was removed. */
  async delete(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.db.db
      .delete(pages)
      .where(and(eq(pages.id, id), eq(pages.tenantId, tenantId)))
      .returning({ id: pages.id });
    return rows.length > 0;
  }
}
