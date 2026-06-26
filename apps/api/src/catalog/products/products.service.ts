/**
 * ProductsService (, SECURITY-CRITICAL for publish guard).
 *
 * Core business rules enforced here:
 *   1. Slug generation + collision retry (deterministic -2, -3 …).
 *   2. Default variant auto-creation when no variants supplied on create.
 *   3. PUBLISH GUARD: product with any non-free variant at price_amount=0 cannot
 *      be set to status='published'. A variant is "free" when options.free === true.
 *   4. Tenant isolation: EVERY DB call goes through the repository with tenantId.
 *   5. Audit every admin mutation.
 *   6. Events emitted inside the transaction for ordering.
 */
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { uuidv7 } from 'uuidv7';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { StorageService } from '../../storage/storage.service';
import { AuditService } from '../../audit/audit.service';
import { isUniqueViolation } from '../../common/pg-error.util';
import { productImages } from '../../database/schema/product_images';
import { images } from '../../database/schema/images';
import { orderItems } from '../../database/schema/order_items';
import { productVariants } from '../../database/schema/product_variants';
import { ProductsRepository, type ProductWithDetails } from './products.repository';
import { VariantsRepository } from '../variants/variants.repository';
import { ProductCreatedEvent } from '../events/product-created.event';
import { ProductUpdatedEvent } from '../events/product-updated.event';
import { ProductDeletedEvent } from '../events/product-deleted.event';
import type { CreateProductDto } from './dto/create-product.dto';
import type { VariantCreateInput } from './dto/create-product.dto';
import type { UpdateProductDto } from './dto/update-product.dto';
import type { ProductListFilters, ProductListResult } from './products.repository';
import type { StoreCursorFilter } from './products.repository';
import type {
  StoreProductDto,
  StoreProductListDto,
  StoreVariantDto,
  StoreImageDto,
} from './dto/store-product.dto';
import type { Product } from '../../database/schema/products';
import type { ProductVariant } from '../../database/schema/product_variants';

/**
 * Default currency for the auto-created variant. Validated at module load
 * so a malformed STORE_DEFAULT_CURRENCY fails fast at boot.
 */
function resolveDefaultCurrency(): string {
  const raw = (process.env.STORE_DEFAULT_CURRENCY ?? 'EUR').toUpperCase();
  if (!/^[A-Z]{3}$/.test(raw)) {
    throw new Error(
      `STORE_DEFAULT_CURRENCY must be a 3-letter ISO-4217 code (got "${process.env.STORE_DEFAULT_CURRENCY}")`,
    );
  }
  return raw;
}

const DEFAULT_CURRENCY = resolveDefaultCurrency();
const MAX_SLUG_RETRIES = 20;

/**
 * Slugify a title: lowercase, trim, replace non-alphanumeric runs with hyphens.
 *
 * A name made entirely of non-Latin script or symbols ("电脑", "!!!")
 * reduces to "" — an empty slug breaks URLs and the per-tenant UNIQUE(slug)
 * constraint. When the slug would be empty, fall back to a short uuid suffix
 * so every entity gets a usable, unique slug.
 */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? `c-${uuidv7().slice(-8)}` : slug;
}

/** Encode a cursor { createdAt, id } to opaque base64. */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id })).toString('base64');
}

/** Decode a cursor — returns null on any parse error. */
export function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as {
      createdAt: string;
      id: string;
    };
  } catch {
    return null;
  }
}

/**
 * Check if a variant is intentionally free (options.free === true).
 * This is stored in the variant's options jsonb field.
 */
function isVariantFree(variant: { options: unknown }): boolean {
  if (typeof variant.options === 'object' && variant.options !== null) {
    return (variant.options as Record<string, unknown>).free === true;
  }
  return false;
}

/**
 * Enforce the publish guard rule: no product may be published if ANY variant
 * has priceAmount=0 and is NOT flagged free.
 *
 * TODO: this read-check-write is TOCTOU under concurrent admin writes. A future
 * enhancement should take a `SELECT ... FOR UPDATE` on the product's variants
 * inside the publish transaction.
 */
export function assertPublishGuard(
  variants: Array<{ priceAmount: number; options: unknown }>,
): void {
  const blocker = variants.find((v) => v.priceAmount === 0 && !isVariantFree(v));
  if (blocker) {
    throw new UnprocessableEntityException(
      'Cannot publish product: one or more variants have a price of 0. ' +
        'Set a price ≥ 1 cent, or mark the variant as free (options.free = true).',
    );
  }
}

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly products: ProductsRepository,
    private readonly variants: VariantsRepository,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  // ── Slug generation ──────────────────────────────────────────────────────────

  async generateUniqueSlug(tenantId: string, base: string): Promise<string> {
    const baseSlug = slugify(base);
    if (!(await this.products.slugExists(tenantId, baseSlug))) {
      return baseSlug;
    }
    for (let i = 2; i <= MAX_SLUG_RETRIES; i++) {
      const candidate = `${baseSlug}-${i}`;
      if (!(await this.products.slugExists(tenantId, candidate))) {
        return candidate;
      }
    }
    // Fallback: append a short unique suffix.
    const fallback = `${baseSlug}-${uuidv7().slice(-8)}`;
    return fallback;
  }

  // ── Create ───────────────────────────────────────────────────────────────────

  async create(
    tenantId: string,
    actorId: string,
    dto: CreateProductDto,
    ip?: string,
    userAgent?: string,
  ): Promise<ProductWithDetails> {
    const slug = dto.slug
      ? await this.generateUniqueSlug(tenantId, dto.slug)
      : await this.generateUniqueSlug(tenantId, dto.title);

    const productId = uuidv7();

    // Prepare variants.
    let variantInputs: VariantCreateInput[];
    if (!dto.variants || dto.variants.length === 0) {
      // Auto-create default variant.
      variantInputs = [
        {
          sku: `${slug}-default`,
          title: 'Default',
          options: {},
          priceAmount: 0,
          currency: DEFAULT_CURRENCY,
          stockQuantity: 0,
          allowBackorder: false,
          position: 0,
        },
      ];
    } else {
      variantInputs = dto.variants as VariantCreateInput[];
    }

    // Publish guard: validate BEFORE inserting.
    if (dto.status === 'published') {
      assertPublishGuard(variantInputs);
    }

    // Build variant rows with uniquified SKUs.
    const variantRows = await this._buildVariantRows(tenantId, productId, variantInputs);

    // Run in transaction. Slug/SKU collide → retry the bump once on 23505.
    let result;
    try {
      result = await this._insertProductTx(productId, tenantId, dto, slug, variantRows);
    } catch (err) {
      if (isUniqueViolation(err)) {
        // A concurrent create grabbed our slug (or a generated SKU) between the
        // existence check and the insert. Regenerate and retry exactly once.
        const retrySlug = await this.generateUniqueSlug(tenantId, dto.slug ?? dto.title);
        const retryRows = await this._buildVariantRows(tenantId, productId, variantInputs);
        result = await this._insertProductTx(productId, tenantId, dto, retrySlug, retryRows);
      } else {
        throw err;
      }
    }

    // Emit AFTER commit so a rolled-back tx can't fire a phantom product.created.
    this.events.emit(
      ProductCreatedEvent.EVENT,
      new ProductCreatedEvent(tenantId, productId, result.product.title, result.product.status),
    );

    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId,
      action: 'product.created',
      resourceType: 'product',
      resourceId: productId,
      ip,
      userAgent,
      changes: { title: dto.title, slug, status: dto.status },
    });

    return {
      ...result.product,
      variants: result.variants,
      images: [],
      // A just-created product has no taxonomy assignments yet.
      categories: [],
      tags: [],
    };
  }

  // ── List (admin) ─────────────────────────────────────────────────────────────

  async adminList(tenantId: string, filters: ProductListFilters): Promise<ProductListResult> {
    return this.products.adminList(tenantId, filters);
  }

  // ── Get by ID (admin) ────────────────────────────────────────────────────────

  async adminFindById(tenantId: string, productId: string): Promise<ProductWithDetails> {
    const product = await this.products.findById(tenantId, productId);
    if (!product) throw new NotFoundException(`Product ${productId} not found`);
    return product;
  }

  // ── Update / PATCH ───────────────────────────────────────────────────────────

  async update(
    tenantId: string,
    actorId: string,
    productId: string,
    dto: UpdateProductDto,
    ip?: string,
    userAgent?: string,
  ): Promise<ProductWithDetails> {
    const existing = await this.products.findById(tenantId, productId);
    if (!existing) throw new NotFoundException(`Product ${productId} not found`);

    // If status is changing to 'published', run publish guard.
    if (dto.status === 'published' && existing.status !== 'published') {
      assertPublishGuard(existing.variants);
    }

    // Slug change.
    let newSlug: string | undefined;
    if (dto.slug && dto.slug !== existing.slug) {
      newSlug = await this.generateUniqueSlug(tenantId, dto.slug);
    }

    const changes: Record<string, unknown> = {};
    if (dto.title !== undefined) changes['title'] = dto.title;
    if (dto.status !== undefined) changes['status'] = dto.status;
    if (newSlug) changes['slug'] = newSlug;

    const updated = await this.products.update(tenantId, productId, {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      ...(dto.seoTitle !== undefined ? { seoTitle: dto.seoTitle } : {}),
      ...(dto.seoDescription !== undefined ? { seoDescription: dto.seoDescription } : {}),
      ...(dto.isBundle !== undefined ? { isBundle: dto.isBundle } : {}),
      ...(newSlug ? { slug: newSlug } : {}),
    });

    if (!updated) throw new NotFoundException(`Product ${productId} not found`);

    this.events.emit(
      ProductUpdatedEvent.EVENT,
      new ProductUpdatedEvent(tenantId, productId, changes),
    );

    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId,
      action: 'product.updated',
      resourceType: 'product',
      resourceId: productId,
      ip,
      userAgent,
      changes,
    });

    return this.adminFindById(tenantId, productId);
  }

  // ── Delete (HARD) ────────────────────────────────────────────────────────────

  async delete(
    tenantId: string,
    actorId: string,
    productId: string,
    ip?: string,
    userAgent?: string,
  ): Promise<void> {
    const existing = await this.products.findById(tenantId, productId);
    if (!existing) throw new NotFoundException(`Product ${productId} not found`);

    // ORDER-HISTORY GUARD: once a product has been sold, its variant ids
    // live on `order_items` snapshot lines. That FK is ON DELETE SET NULL (NOT restrict —
    // fiscal lines must survive), so a hard-delete would SILENTLY orphan those lines
    // rather than fail. Pre-check EXISTS and reject with a clean 409 instead.
    await this.assertNotSold(tenantId, productId);

    const deleted = await this.products.hardDelete(tenantId, productId);
    if (!deleted) throw new NotFoundException(`Product ${productId} not found`);

    this.events.emit(ProductDeletedEvent.EVENT, new ProductDeletedEvent(tenantId, productId));

    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId,
      action: 'product.deleted',
      resourceType: 'product',
      resourceId: productId,
      ip,
      userAgent,
      changes: { title: existing.title },
    });
  }

  /**
   * Reject (409) hard-deleting a product any of whose variants is referenced by an
   * `order_items` row in this tenant (the product has been sold). Tenant-scoped EXISTS;
   * the `order_items_variant_idx` makes it a single index probe.
   */
  private async assertNotSold(tenantId: string, productId: string): Promise<void> {
    const rows = await this.db.db
      .select({ one: sql<number>`1` })
      .from(orderItems)
      .innerJoin(
        productVariants,
        and(
          eq(orderItems.variantId, productVariants.id),
          eq(orderItems.tenantId, productVariants.tenantId),
        ),
      )
      .where(and(eq(orderItems.tenantId, tenantId), eq(productVariants.productId, productId)))
      .limit(1);
    if (rows.length > 0) {
      throw new ConflictException(
        'product has orders — cannot delete (it appears on order history)',
      );
    }
  }

  // ── Image attach ─────────────────────────────────────────────────────────────

  async attachImage(
    tenantId: string,
    actorId: string,
    productId: string,
    imageId: string,
    position: number,
    ip?: string,
    userAgent?: string,
  ): Promise<void> {
    const product = await this.products.findById(tenantId, productId);
    if (!product) throw new NotFoundException(`Product ${productId} not found`);

    // Verify image belongs to this tenant.
    const imgRows = await this.db.db
      .select({ id: images.id })
      .from(images)
      .where(and(eq(images.id, imageId), eq(images.tenantId, tenantId)))
      .limit(1);
    if (!imgRows[0]) throw new NotFoundException(`Image ${imageId} not found`);

    // Dedupe re-attaches: a UNIQUE(product_id, image_id) backs this, but we
    // check first to return a clean 409 instead of a raw constraint violation.
    const existing = await this.db.db
      .select({ id: productImages.id })
      .from(productImages)
      .where(
        and(
          eq(productImages.productId, productId),
          eq(productImages.tenantId, tenantId),
          eq(productImages.imageId, imageId),
        ),
      )
      .limit(1);
    if (existing[0]) {
      throw new ConflictException(`Image ${imageId} is already attached to product ${productId}`);
    }

    try {
      await this.db.db.insert(productImages).values({
        tenantId,
        productId,
        imageId,
        position,
      });
    } catch (err) {
      // Concurrent attach lost the race on UNIQUE(product_id, image_id).
      if (isUniqueViolation(err)) {
        throw new ConflictException(`Image ${imageId} is already attached to product ${productId}`);
      }
      throw err;
    }

    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId,
      action: 'product.image.attached',
      resourceType: 'product',
      resourceId: productId,
      ip,
      userAgent,
      changes: { imageId, position },
    });
  }

  async detachImage(
    tenantId: string,
    actorId: string,
    productId: string,
    imageId: string,
    ip?: string,
    userAgent?: string,
  ): Promise<void> {
    const product = await this.products.findById(tenantId, productId);
    if (!product) throw new NotFoundException(`Product ${productId} not found`);

    const rows = await this.db.db
      .delete(productImages)
      .where(
        and(
          eq(productImages.productId, productId),
          eq(productImages.tenantId, tenantId),
          eq(productImages.imageId, imageId),
        ),
      )
      .returning({ id: productImages.id });

    if (!rows[0])
      throw new NotFoundException(`Image ${imageId} not attached to product ${productId}`);

    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId,
      action: 'product.image.detached',
      resourceType: 'product',
      resourceId: productId,
      ip,
      userAgent,
      changes: { imageId },
    });
  }

  async reorderImages(
    tenantId: string,
    actorId: string,
    productId: string,
    order: string[],
    ip?: string,
    userAgent?: string,
  ): Promise<void> {
    const product = await this.products.findById(tenantId, productId);
    if (!product) throw new NotFoundException(`Product ${productId} not found`);

    // F4-style scope check: every imageId in the payload must already be attached
    // to THIS product (not another product's image via a wrong URL).
    const attached = new Set(product.images.map((img) => img.imageId));
    for (const imageId of order) {
      if (!attached.has(imageId)) {
        throw new NotFoundException(`Image ${imageId} is not attached to product ${productId}`);
      }
    }

    let pos = 0;
    for (const imageId of order) {
      await this.db.db
        .update(productImages)
        .set({ position: pos })
        .where(
          and(
            eq(productImages.productId, productId),
            eq(productImages.tenantId, tenantId),
            eq(productImages.imageId, imageId),
          ),
        );
      pos++;
    }

    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId,
      action: 'product.image.reordered',
      resourceType: 'product',
      resourceId: productId,
      ip,
      userAgent,
      changes: { order },
    });
  }

  // ── Store endpoints ──────────────────────────────────────────────────────────

  async storeList(tenantId: string, filters: StoreCursorFilter): Promise<StoreProductListDto> {
    const { data, nextCursor } = await this.products.storeList(tenantId, filters);
    return {
      data: data.map((p) => this._toStoreDto(p)),
      nextCursor,
    };
  }

  async storeFindBySlug(tenantId: string, slug: string): Promise<StoreProductDto> {
    const product = await this.products.findBySlug(tenantId, slug);
    if (!product || product.status !== 'published') {
      throw new NotFoundException(`Product not found`);
    }
    return this._toStoreDto(product);
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /** Insert the product + its variants in one transaction (no event emit here). */
  private async _insertProductTx(
    productId: string,
    tenantId: string,
    dto: CreateProductDto,
    slug: string,
    variantRows: Awaited<ReturnType<ProductsService['_buildVariantRows']>>,
  ): Promise<{ product: Product; variants: ProductVariant[] }> {
    return this.db.db.transaction(async (_tx) => {
      const product = await this.products.insert({
        id: productId,
        tenantId,
        title: dto.title,
        slug,
        description: dto.description ?? null,
        status: dto.status ?? 'draft',
        seoTitle: dto.seoTitle ?? null,
        seoDescription: dto.seoDescription ?? null,
        isBundle: dto.isBundle ?? false,
      });
      const insertedVariants = await this.variants.insertMany(variantRows);
      return { product, variants: insertedVariants };
    });
  }

  private async _buildVariantRows(
    tenantId: string,
    productId: string,
    inputs: VariantCreateInput[],
  ) {
    const rows = [];
    let i = 0;
    for (const v of inputs) {
      let sku = v.sku ?? `${productId.slice(-8)}-${i}`;
      // Uniquify SKU if collision.
      if (await this.variants.skuExists(tenantId, sku)) {
        sku = `${sku}-${uuidv7().slice(-6)}`;
      }
      rows.push({
        id: uuidv7(),
        tenantId,
        productId,
        sku,
        title: v.title ?? null,
        options: v.options ?? {},
        priceAmount: v.priceAmount,
        currency: v.currency.toUpperCase(),
        compareAtAmount: v.compareAtAmount ?? null,
        stockQuantity: v.stockQuantity ?? 0,
        allowBackorder: v.allowBackorder ?? false,
        weightGrams: v.weightGrams ?? null,
        lengthMm: v.lengthMm ?? null,
        widthMm: v.widthMm ?? null,
        heightMm: v.heightMm ?? null,
        position: v.position ?? i,
      });
      i++;
    }
    return rows;
  }

  private _toStoreDto(product: ProductWithDetails): StoreProductDto {
    const storeVariants: StoreVariantDto[] = product.variants.map((v) => ({
      id: v.id,
      title: v.title,
      options: v.options as Record<string, unknown>,
      priceAmount: v.priceAmount,
      currency: v.currency,
      compareAtAmount: v.compareAtAmount,
      availability: v.stockQuantity > 0 || v.allowBackorder,
      position: v.position,
    }));

    const storeImages: StoreImageDto[] = product.images.map((img) => {
      let thumbnailUrl = '';
      if (img.imageRow) {
        const variantsMap = img.imageRow.variants as Record<string, Record<string, string>>;
        const thumbKey = variantsMap?.thumbnail?.webp ?? variantsMap?.thumbnail?.jpeg ?? '';
        thumbnailUrl = thumbKey ? this.storage.getPublicUrl(thumbKey) : '';
      }
      return {
        thumbnailUrl,
        altText: img.altText,
        position: img.position,
      };
    });

    return {
      id: product.id,
      slug: product.slug,
      title: product.title,
      description: product.description,
      status: 'published',
      seoTitle: product.seoTitle,
      seoDescription: product.seoDescription,
      variants: storeVariants,
      images: storeImages,
      createdAt: product.createdAt.toISOString(),
      updatedAt: product.updatedAt.toISOString(),
    };
  }
}
