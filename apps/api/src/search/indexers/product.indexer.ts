/**
 * ProductIndexer.
 *
 * Subscribes to product.created / product.updated / product.deleted and keeps
 * the per-tenant Meilisearch `${tenantId}_products` index in sync.
 *
 * PUBLISHED-ONLY rule: only status='published' products live in the index.
 *   - product.created / product.updated → fetch full product; if published, upsert;
 *     if draft/archived, DELETE from index (covers unpublish/archive).
 *   - product.deleted → delete from index unconditionally.
 *
 * FAILURE HANDLING: on any Meilisearch error, LOG loudly and do NOT re-throw out
 * of the event handler (monitorable; reindex script recovers drift). A durable
 * outbox/retry is deferred — see TODO below.
 *
 * TENANT ISOLATION: every index op targets `${tenantId}_products` — structurally
 * impossible to touch another tenant's index.
 *
 * TODO: replace fire-and-forget with a transactional outbox so a
 * Meilisearch outage during an event does not silently skip indexing. The
 * reindex script is the recovery path in v1.
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Task } from 'meilisearch';
import { SearchService } from '../search.service';
import { DatabaseService } from '../../database/database.service';
import { StorageService } from '../../storage/storage.service';
import { TenantSettingsService } from '../../taxes/tenant-settings.service';
import { ProductCreatedEvent } from '../../catalog/events/product-created.event';
import { ProductUpdatedEvent } from '../../catalog/events/product-updated.event';
import { ProductDeletedEvent } from '../../catalog/events/product-deleted.event';
import { products } from '../../database/schema/products';
import { productVariants } from '../../database/schema/product_variants';
import { productImages } from '../../database/schema/product_images';
import { images } from '../../database/schema/images';
import { productCategories } from '../../database/schema/product_categories';
import { productTags } from '../../database/schema/product_tags';
import { categories } from '../../database/schema/categories';
import { tags } from '../../database/schema/tags';

/** The Meilisearch document shape for a product. */
export interface ProductSearchDoc {
  id: string;
  tenantId: string;
  title: string;
  description: string | null;
  slug: string;
  categorySlugs: string[];
  categoryNames: string[];
  tagSlugs: string[];
  tagNames: string[];
  variantSkus: string[];
  /** Minimum variant price in integer cents. null when no variants. */
  priceAmount: number | null;
  currency: string;
  /** True if any variant has stockQuantity > 0 or allowBackorder = true. */
  availability: boolean;
  thumbnailUrl: string;
  /** Unix epoch seconds — used for sort by newest. */
  createdAt: number;
}

/** Meilisearch index settings applied on ensureIndex. */
const PRODUCT_INDEX_SETTINGS = {
  searchableAttributes: ['title', 'description', 'categoryNames', 'tagNames', 'variantSkus'],
  filterableAttributes: [
    'categorySlugs',
    'tagSlugs',
    'priceAmount',
    'currency',
    'availability',
    'tenantId',
  ] as string[],
  sortableAttributes: ['priceAmount', 'createdAt'] as string[],
  // Restrict what raw index reads can return. `tenantId` (isolation metadata)
  // and `variantSkus` (internal codes) stay searchable/filterable but are NOT
  // displayed, so even a direct Meilisearch query cannot exfiltrate them.
  // The query-side allowlist (search-result.dto) is the primary guard; this is
  // defense-in-depth at the index level.
  displayedAttributes: [
    'id',
    'title',
    'description',
    'slug',
    'categorySlugs',
    'categoryNames',
    'tagSlugs',
    'tagNames',
    'priceAmount',
    'currency',
    'availability',
    'thumbnailUrl',
    'createdAt',
  ] as string[],
};

/** Error raised when a Meilisearch task resolves in a non-`succeeded` state. */
class MeiliTaskError extends Error {
  constructor(
    public readonly op: string,
    public readonly taskStatus: string,
    public readonly code: string,
    message: string,
  ) {
    super(`meilisearch ${op} task ${taskStatus} (code=${code}): ${message}`);
    this.name = 'MeiliTaskError';
  }
}

@Injectable()
export class ProductIndexer {
  private readonly logger = new Logger(ProductIndexer.name);

  /** Track which tenant indexes have already had ensureIndex run this process lifetime. */
  private readonly ensuredTenants = new Set<string>();

  constructor(
    private readonly search: SearchService,
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly settings: TenantSettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    // No-op at startup: index creation is lazy (ensureIndex runs on first write or
    // query). A startup pre-warm is deferred — add it here when the default-tenant
    // concept is stable enough to avoid circular startup issues.
  }

  // ── Task-status guard ────────────────────────────────────────────────────────

  /**
   * meilisearch v0.58 `waitTask()` resolves even when the task
   * FAILED (`status==='failed'`) — it does NOT throw. So a failed addDocuments /
   * updateSettings / deleteDocument / deleteIndex would otherwise produce no log
   * and silent index drift. This converts a non-`succeeded` terminal task into a
   * throw so the caller's catch can log loudly. `index_not_found` on a delete now
   * arrives here as a failed task (not a thrown string) — callers treat that as a
   * benign no-op.
   */
  private assertTaskOk(task: Task, op: string): void {
    if (task.status !== 'succeeded') {
      const code = task.error?.code ?? 'unknown';
      const message = task.error?.message ?? 'no error message';
      throw new MeiliTaskError(op, task.status, code, message);
    }
  }

  // ── ensureIndex ──────────────────────────────────────────────────────────────

  /**
   * Idempotent: create the index if it doesn't exist and apply settings.
   *
   * Memoised per-process per-tenant so normal create/update cycles are cheap.
   * CAVEAT (v1, acceptable): if the index is dropped externally (e.g. a manual
   * Meilisearch wipe) while this process is running, the memo prevents settings
   * from being re-applied until a restart or a `reindexTenant` (which clears the
   * memo). The reindex script is the recovery path.
   */
  async ensureIndex(tenantId: string): Promise<void> {
    if (this.ensuredTenants.has(tenantId)) return;

    const client = await this.search.getClient();
    const indexName = this.search.productsIndex(tenantId);

    try {
      // createIndex is idempotent (returns existing task if the index exists).
      const createTask = await client.createIndex(indexName, { primaryKey: 'id' }).waitTask();
      // An "index already exists" create resolves as a failed task — that is a
      // benign no-op (the index is present), so only treat OTHER failures as real.
      if (createTask.status !== 'succeeded' && createTask.error?.code !== 'index_already_exists') {
        this.assertTaskOk(createTask, 'createIndex');
      }
      const settingsTask = await client
        .index(indexName)
        .updateSettings(PRODUCT_INDEX_SETTINGS)
        .waitTask();
      this.assertTaskOk(settingsTask, 'updateSettings');
      this.ensuredTenants.add(tenantId);
    } catch (err) {
      this.logger.error(
        `[search] ensureIndex failed — tenantId=${tenantId} index=${indexName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw err; // re-throw from ensureIndex so caller can decide; event handlers swallow
    }
  }

  // ── Event handlers ───────────────────────────────────────────────────────────

  @OnEvent(ProductCreatedEvent.EVENT)
  async onProductCreated(event: ProductCreatedEvent): Promise<void> {
    await this._handleUpsert(event.tenantId, event.productId, 'product.created');
  }

  @OnEvent(ProductUpdatedEvent.EVENT)
  async onProductUpdated(event: ProductUpdatedEvent): Promise<void> {
    await this._handleUpsert(event.tenantId, event.productId, 'product.updated');
  }

  @OnEvent(ProductDeletedEvent.EVENT)
  async onProductDeleted(event: ProductDeletedEvent): Promise<void> {
    await this._handleDelete(event.tenantId, event.productId, 'product.deleted');
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private async _handleUpsert(tenantId: string, productId: string, action: string): Promise<void> {
    try {
      await this.ensureIndex(tenantId);

      const product = await this._loadProduct(tenantId, productId);
      if (!product) {
        // Product deleted between event emit and handler — treat as delete.
        await this._handleDelete(tenantId, productId, action);
        return;
      }

      if (product.status !== 'published') {
        // Draft or archived → must NOT be in the index.
        await this._deleteFromIndex(tenantId, productId, action);
        return;
      }

      const doc = await this._buildDoc(tenantId, productId, product);
      const client = await this.search.getClient();
      const task = await client
        .index(this.search.productsIndex(tenantId))
        .addDocuments([doc])
        .waitTask();
      this.assertTaskOk(task, 'addDocuments');
    } catch (err) {
      // LOG loudly, do NOT re-throw.
      this.logger.error(
        `[search] upsert failed — action=${action} productId=${productId} tenantId=${tenantId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async _handleDelete(tenantId: string, productId: string, action: string): Promise<void> {
    try {
      await this._deleteFromIndex(tenantId, productId, action);
    } catch (err) {
      this.logger.error(
        `[search] delete failed — action=${action} productId=${productId} tenantId=${tenantId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async _deleteFromIndex(
    tenantId: string,
    productId: string,
    action: string,
  ): Promise<void> {
    void action; // used by caller for log context only
    const client = await this.search.getClient();
    const task = await client
      .index(this.search.productsIndex(tenantId))
      .deleteDocument(productId)
      .waitTask();

    // A delete against a non-existent index resolves as a failed task with code
    // `index_not_found` — there is nothing to delete, so treat it as a benign
    // no-op. Any OTHER non-succeeded status is a real failure → throw so the
    // caller logs it (F3).
    if (task.status === 'succeeded') return;
    if (task.error?.code === 'index_not_found') return;
    this.assertTaskOk(task, 'deleteDocument');
  }

  // ── Document builder ─────────────────────────────────────────────────────────

  /**
   * Load the raw product row (status + basic fields only).
   */
  private async _loadProduct(
    tenantId: string,
    productId: string,
  ): Promise<{
    id: string;
    tenantId: string;
    title: string;
    description: string | null;
    slug: string;
    status: string;
    createdAt: Date;
  } | null> {
    const rows = await this.db.db
      .select({
        id: products.id,
        tenantId: products.tenantId,
        title: products.title,
        description: products.description,
        slug: products.slug,
        status: products.status,
        createdAt: products.createdAt,
      })
      .from(products)
      .where(and(eq(products.id, productId), eq(products.tenantId, tenantId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Build the full search document for a PUBLISHED product.
   * Requires the product record as a pre-fetched guard.
   */
  async _buildDoc(
    tenantId: string,
    productId: string,
    product: {
      id: string;
      tenantId: string;
      title: string;
      description: string | null;
      slug: string;
      status: string;
      createdAt: Date;
    },
  ): Promise<ProductSearchDoc> {
    // ── Variants ──
    // ORDER BY position so the "first variant" is DETERMINISTIC: it decides the
    // canonical currency fallback and must not depend on row arrival order.
    const variantRows = await this.db.db
      .select({
        sku: productVariants.sku,
        priceAmount: productVariants.priceAmount,
        currency: productVariants.currency,
        stockQuantity: productVariants.stockQuantity,
        allowBackorder: productVariants.allowBackorder,
      })
      .from(productVariants)
      .where(and(eq(productVariants.productId, productId), eq(productVariants.tenantId, tenantId)))
      .orderBy(asc(productVariants.position));

    const variantSkus = variantRows.map((v) => v.sku);

    // priceAmount + currency must be CONSISTENT and never mix currencies. Pick a
    // single CANONICAL currency — the store's default currency when set, else the first-
    // by-position variant's currency — then take the MIN price ONLY within that currency.
    // A naive Math.min across mixed currencies would compare incomparable integers (e.g.
    // a ¥300 against a €20,00) and drive a wrong price filter/sort. Single-currency stores
    // (the v1 norm) are unaffected: every variant shares the one currency.
    const { defaultCurrency } = await this.settings.getOnboardingProfile(tenantId);
    const canonicalCurrency = defaultCurrency ?? variantRows[0]?.currency ?? 'EUR';
    const sameCurrencyVariants = variantRows.filter((v) => v.currency === canonicalCurrency);
    const pricesInCurrency = sameCurrencyVariants.map((v) => v.priceAmount).filter((p) => p > 0);
    const priceAmount =
      pricesInCurrency.length > 0
        ? Math.min(...pricesInCurrency)
        : (sameCurrencyVariants[0]?.priceAmount ?? null);
    const currency = canonicalCurrency;
    const availability = variantRows.some((v) => v.stockQuantity > 0 || v.allowBackorder);

    // ── Categories ──
    const catJoinRows = await this.db.db
      .select({
        categoryId: productCategories.categoryId,
      })
      .from(productCategories)
      .where(
        and(eq(productCategories.productId, productId), eq(productCategories.tenantId, tenantId)),
      );

    let categorySlugs: string[] = [];
    let categoryNames: string[] = [];
    if (catJoinRows.length > 0) {
      const catIds = catJoinRows.map((r) => r.categoryId);
      const catRows = await this.db.db
        .select({ slug: categories.slug, name: categories.name })
        .from(categories)
        .where(and(inArray(categories.id, catIds), eq(categories.tenantId, tenantId)));
      categorySlugs = catRows.map((r) => r.slug);
      categoryNames = catRows.map((r) => r.name);
    }

    // ── Tags ──
    const tagJoinRows = await this.db.db
      .select({ tagId: productTags.tagId })
      .from(productTags)
      .where(and(eq(productTags.productId, productId), eq(productTags.tenantId, tenantId)));

    let tagSlugs: string[] = [];
    let tagNames: string[] = [];
    if (tagJoinRows.length > 0) {
      const tagIds = tagJoinRows.map((r) => r.tagId);
      const tagRows = await this.db.db
        .select({ slug: tags.slug, name: tags.name })
        .from(tags)
        .where(and(inArray(tags.id, tagIds), eq(tags.tenantId, tenantId)));
      tagSlugs = tagRows.map((r) => r.slug);
      tagNames = tagRows.map((r) => r.name);
    }

    // ── Thumbnail ──
    let thumbnailUrl = '';
    const pImgRows = await this.db.db
      .select({ imageId: productImages.imageId })
      .from(productImages)
      .where(and(eq(productImages.productId, productId), eq(productImages.tenantId, tenantId)))
      .limit(1);

    if (pImgRows[0]) {
      const imgRows = await this.db.db
        .select({ variants: images.variants })
        .from(images)
        .where(and(eq(images.id, pImgRows[0].imageId), eq(images.tenantId, tenantId)))
        .limit(1);
      if (imgRows[0]) {
        const variantsMap = imgRows[0].variants as Record<string, Record<string, string>>;
        const thumbKey = variantsMap?.thumbnail?.webp ?? variantsMap?.thumbnail?.jpeg ?? '';
        if (thumbKey) {
          try {
            thumbnailUrl = this.storage.getPublicUrl(thumbKey);
          } catch {
            thumbnailUrl = '';
          }
        }
      }
    }

    return {
      id: product.id,
      tenantId: product.tenantId,
      title: product.title,
      description: product.description,
      slug: product.slug,
      categorySlugs,
      categoryNames,
      tagSlugs,
      tagNames,
      variantSkus,
      priceAmount,
      currency,
      availability,
      thumbnailUrl,
      createdAt: Math.floor(product.createdAt.getTime() / 1000),
    };
  }

  // ── Bulk reindex helper (used by the reindex script) ─────────────────────────

  /**
   * Fetch all published products for a tenant and bulk-upsert them into the index.
   * Drops and recreates the index first (idempotent full rebuild).
   *
   * NOTE: tenant-delete index drop is intentionally NOT wired to a tenant-delete
   * event yet — it should be added when the tenant lifecycle API is built.
   * Call `dropTenantIndex(tenantId)` manually if needed.
   */
  async reindexTenant(tenantId: string): Promise<{ indexed: number }> {
    const client = await this.search.getClient();
    const indexName = this.search.productsIndex(tenantId);

    // Drop + recreate so drift from deleted docs is cleared. A delete of a
    // non-existent index resolves as a failed `index_not_found` task — benign.
    const dropTask = await client.deleteIndex(indexName).waitTask();
    if (dropTask.status !== 'succeeded' && dropTask.error?.code !== 'index_not_found') {
      this.assertTaskOk(dropTask, 'deleteIndex');
    }
    this.ensuredTenants.delete(tenantId);
    await this.ensureIndex(tenantId);

    // Load ALL published products.
    const publishedRows = await this.db.db
      .select({
        id: products.id,
        tenantId: products.tenantId,
        title: products.title,
        description: products.description,
        slug: products.slug,
        status: products.status,
        createdAt: products.createdAt,
      })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.status, 'published')));

    if (publishedRows.length === 0) return { indexed: 0 };

    const docs: ProductSearchDoc[] = [];
    for (const p of publishedRows) {
      const doc = await this._buildDoc(tenantId, p.id, p);
      docs.push(doc);
    }

    const task = await client.index(indexName).addDocuments(docs).waitTask();
    this.assertTaskOk(task, 'addDocuments(reindex)');
    return { indexed: docs.length };
  }

  /**
   * Drop a tenant's products index entirely. Useful for tenant delete / cleanup.
   *
   * NOTE: This method is not yet wired to a tenant-delete event. See the TODO in
   * the class-level comment above.
   */
  async dropTenantIndex(tenantId: string): Promise<void> {
    const client = await this.search.getClient();
    const indexName = this.search.productsIndex(tenantId);
    const task = await client.deleteIndex(indexName).waitTask();
    if (task.status !== 'succeeded' && task.error?.code !== 'index_not_found') {
      this.assertTaskOk(task, 'deleteIndex');
    }
    this.ensuredTenants.delete(tenantId);
  }
}
