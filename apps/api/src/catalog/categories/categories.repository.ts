/**
 * CategoriesRepository.
 *
 * All Drizzle queries. EVERY query filters tenant_id (tenant isolation).
 * Tree queries use Postgres recursive CTEs.
 */
import { Injectable } from '@nestjs/common';
import { and, eq, sql, asc, inArray } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { categories, type Category, type NewCategory } from '../../database/schema/categories';
import { productCategories } from '../../database/schema/product_categories';
import { products } from '../../database/schema/products';

/** A category row WITHOUT the `embedding` vector (see {@link CATEGORY_COLUMNS}). */
export type CategoryRow = Omit<Category, 'embedding'>;

export interface CategoryWithCount extends CategoryRow {
  productCount: number;
}

export interface CategoryAncestorRow {
  id: string;
  parentId: string | null;
}

/**
 * The transaction handle drizzle passes to `db.transaction(async (tx) => …)`.
 * Repository methods that must run inside a caller's transaction take this so
 * the advisory lock + cycle-check + update share one tx (F2, Fable).
 */
export type DbTx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

/**
 * Explicit column projection that OMITS the `embedding` vector (Fable nit:
 * payload bloat — 1536 floats per row — and not needed by any admin/store
 * response). All admin reads use this instead of `select()`.
 */
const CATEGORY_COLUMNS = {
  id: categories.id,
  tenantId: categories.tenantId,
  parentId: categories.parentId,
  name: categories.name,
  slug: categories.slug,
  description: categories.description,
  seoTitle: categories.seoTitle,
  seoDescription: categories.seoDescription,
  position: categories.position,
  createdAt: categories.createdAt,
  updatedAt: categories.updatedAt,
} as const;

@Injectable()
export class CategoriesRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Resolve the query executor: the caller's transaction handle when supplied,
   * otherwise the base connection. Lets the same repository methods run inside
   * the re-parent transaction (F2) without duplicating queries.
   */
  private exec(tx?: DbTx): DbTx {
    return tx ?? (this.db.db as unknown as DbTx);
  }

  // ── Single ─────────────────────────────────────────────────────────────────

  async findById(tenantId: string, id: string, tx?: DbTx): Promise<CategoryRow | null> {
    const rows = await this.exec(tx)
      .select(CATEGORY_COLUMNS)
      .from(categories)
      .where(and(eq(categories.id, id), eq(categories.tenantId, tenantId)))
      .limit(1);
    return rows[0] ?? null;
  }

  // ── List (flat) ─────────────────────────────────────────────────────────────

  async findAll(tenantId: string): Promise<CategoryRow[]> {
    return this.db.db
      .select(CATEGORY_COLUMNS)
      .from(categories)
      .where(eq(categories.tenantId, tenantId))
      .orderBy(asc(categories.position), asc(categories.name));
  }

  // ── Recursive CTE: full subtree (id + parentId) for depth/cycle checks ───

  /**
   * Defensive recursion cap for the subtree/ancestor CTEs.
   *
   * F1 (Fable BLOCKER): a cap at `< 6` truncated rows so the depth/cycle guards
   * computed on PARTIAL data — a re-parent could push descendants past depth 5,
   * and `subtree()` would not even return the descendant that proves a cycle.
   * The cap exists ONLY to stop a runaway query if a real cycle were ever
   * written; set it well above MAX_CATEGORY_DEPTH (5) so the guards always see
   * the complete tree under any legal shape.
   */
  private static readonly RECURSION_CAP = 32;

  /**
   * Returns the full subtree rooted at `rootId` (including `rootId` itself)
   * as a flat list of { id, parentId, depth } where depth is RELATIVE to the
   * root (root = 1). Capped defensively at {@link RECURSION_CAP}.
   */
  async subtree(
    tenantId: string,
    rootId: string,
    tx?: DbTx,
  ): Promise<Array<CategoryAncestorRow & { depth: number }>> {
    const rows = await this.exec(tx).execute(sql`
      WITH RECURSIVE subtree AS (
        SELECT id, parent_id, 1 AS depth
        FROM categories
        WHERE id = ${rootId} AND tenant_id = ${tenantId}
        UNION ALL
        SELECT c.id, c.parent_id, s.depth + 1
        FROM categories c
        INNER JOIN subtree s ON c.parent_id = s.id
        WHERE c.tenant_id = ${tenantId} AND s.depth < ${CategoriesRepository.RECURSION_CAP}
      )
      SELECT id, parent_id AS "parentId", depth FROM subtree
    `);
    return rows as unknown as Array<CategoryAncestorRow & { depth: number }>;
  }

  /**
   * Walks the ancestor chain upward from `nodeId` and returns each ancestor.
   * Used for depth calculation. Capped defensively at {@link RECURSION_CAP}.
   */
  async ancestors(tenantId: string, nodeId: string, tx?: DbTx): Promise<CategoryAncestorRow[]> {
    const rows = await this.exec(tx).execute(sql`
      WITH RECURSIVE ancestor_chain AS (
        SELECT id, parent_id, 1 AS depth
        FROM categories
        WHERE id = ${nodeId} AND tenant_id = ${tenantId}
        UNION ALL
        SELECT c.id, c.parent_id, a.depth + 1
        FROM categories c
        INNER JOIN ancestor_chain a ON c.id = a.parent_id
        WHERE c.tenant_id = ${tenantId} AND a.depth < ${CategoriesRepository.RECURSION_CAP}
      )
      SELECT id, parent_id AS "parentId" FROM ancestor_chain
    `);
    return rows as unknown as CategoryAncestorRow[];
  }

  // ── Tree (recursive CTE, ordered by position then name) ──────────────────

  async tree(tenantId: string): Promise<CategoryAncestorRow[]> {
    // F1 (Fable): cap raised from `< 5` to RECURSION_CAP so the public tree never
    // silently drops nodes that exist in the flat list (the depth guard already
    // keeps legal trees at ≤ 5; this cap is purely a runaway-cycle backstop).
    const rows = await this.db.db.execute(sql`
      WITH RECURSIVE tree AS (
        SELECT id, parent_id, name, slug, position, 1 AS depth
        FROM categories
        WHERE tenant_id = ${tenantId} AND parent_id IS NULL
        UNION ALL
        SELECT c.id, c.parent_id, c.name, c.slug, c.position, t.depth + 1
        FROM categories c
        INNER JOIN tree t ON c.parent_id = t.id
        WHERE c.tenant_id = ${tenantId} AND t.depth < ${CategoriesRepository.RECURSION_CAP}
      )
      SELECT id, parent_id AS "parentId", name, slug, position, depth
      FROM tree
      ORDER BY position ASC, name ASC
    `);
    return rows as unknown as Array<
      CategoryAncestorRow & { name: string; slug: string; position: number; depth: number }
    >;
  }

  // ── Product counts (per category, tenant-scoped) ──────────────────────────

  /**
   * STORE-facing product counts: counts ONLY `status='published'` products via an
   * INNER JOIN on products. The public store category surface must match the published-only
   * product listings.
   */
  async publishedProductCounts(
    tenantId: string,
    categoryIds: string[],
  ): Promise<Record<string, number>> {
    if (categoryIds.length === 0) return {};
    const rows = await this.db.db
      .select({
        categoryId: productCategories.categoryId,
        count: sql<number>`count(*)::int`,
      })
      .from(productCategories)
      .innerJoin(
        products,
        and(
          eq(products.id, productCategories.productId),
          eq(products.tenantId, productCategories.tenantId),
        ),
      )
      .where(
        and(
          eq(productCategories.tenantId, tenantId),
          inArray(productCategories.categoryId, categoryIds),
          eq(products.status, 'published'),
        ),
      )
      .groupBy(productCategories.categoryId);
    return rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.categoryId] = r.count;
      return acc;
    }, {});
  }

  // ── Slug helpers ───────────────────────────────────────────────────────────

  async slugExists(tenantId: string, slug: string, excludeId?: string): Promise<boolean> {
    const conditions = [eq(categories.tenantId, tenantId), eq(categories.slug, slug)];
    const rows = await this.db.db
      .select({ id: categories.id })
      .from(categories)
      .where(and(...conditions))
      .limit(1);
    if (rows.length === 0) return false;
    if (excludeId && rows[0]!.id === excludeId) return false;
    return true;
  }

  async findBySlug(tenantId: string, slug: string): Promise<CategoryRow | null> {
    const rows = await this.db.db
      .select(CATEGORY_COLUMNS)
      .from(categories)
      .where(and(eq(categories.tenantId, tenantId), eq(categories.slug, slug)))
      .limit(1);
    return rows[0] ?? null;
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  async insert(value: NewCategory): Promise<CategoryRow> {
    const rows = await this.db.db.insert(categories).values(value).returning(CATEGORY_COLUMNS);
    return rows[0]!;
  }

  async update(
    tenantId: string,
    id: string,
    patch: Partial<NewCategory>,
    tx?: DbTx,
  ): Promise<CategoryRow | null> {
    const rows = await this.exec(tx)
      .update(categories)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(categories.id, id), eq(categories.tenantId, tenantId)))
      .returning(CATEGORY_COLUMNS);
    return rows[0] ?? null;
  }

  /**
   * Atomic delete-if-no-children (F2, Fable).
   *
   * `countChildren` then `hardDelete` as two statements is a TOCTOU: a child
   * inserted between them is silently destroyed by the parent's ON DELETE
   * CASCADE. This is a SINGLE conditional statement — it deletes only when no
   * child exists at execution time, so a concurrent child-insert either lands
   * first (delete affects 0 rows → caller returns 409) or after (FK forbids it).
   *
   * Returns `true` if the row was deleted, `false` otherwise (caller then
   * distinguishes 404-missing from 409-has-children by re-checking existence).
   */
  async deleteIfNoChildren(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.db.db.execute(sql`
      DELETE FROM categories
      WHERE id = ${id} AND tenant_id = ${tenantId}
        AND NOT EXISTS (
          SELECT 1 FROM categories
          WHERE parent_id = ${id} AND tenant_id = ${tenantId}
        )
      RETURNING id
    `);
    return (rows as unknown as unknown[]).length > 0;
  }

  /**
   * Take a per-tenant transaction-scoped pg advisory lock (F2, Fable). Two
   * concurrent re-parent PATCHes in the same tenant serialize on this lock so
   * they cannot both pass `assertNoCycle` on stale snapshots and commit a cycle.
   * The lock auto-releases at COMMIT/ROLLBACK. Must be called inside a tx.
   *
   * The key is derived from the tenant UUID via hashtextextended so it fits the
   * single-bigint `pg_advisory_xact_lock(bigint)` form and is stable per tenant.
   */
  async lockTenant(tx: DbTx, tenantId: string): Promise<void> {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`category:${tenantId}`}, 0))
    `);
  }
}
