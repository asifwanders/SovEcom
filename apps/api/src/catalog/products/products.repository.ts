/**
 * ProductsRepository.
 *
 * All Drizzle queries. EVERY query filters tenant_id. No N+1 — products with
 * variants + images are loaded via batched secondary queries (not joined) to
 * avoid postgres-js column-name collision when both product_images and images
 * share id/tenant_id/variants/alt_text column names.
 */
import { Injectable } from '@nestjs/common';
import { and, eq, sql, desc, asc, lte, gte, gt, lt, or, inArray, exists } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { products, type Product, type NewProduct } from '../../database/schema/products';
import { productVariants, type ProductVariant } from '../../database/schema/product_variants';
import { productImages, type ProductImage } from '../../database/schema/product_images';
import { productCategories } from '../../database/schema/product_categories';
import { productTags } from '../../database/schema/product_tags';
import { categories, type Category } from '../../database/schema/categories';
import { tags, type Tag } from '../../database/schema/tags';
import { images, type Image } from '../../database/schema/images';

export interface ProductImageWithImageRow extends ProductImage {
  imageRow: Image | null;
}

export interface ProductWithDetails extends Product {
  variants: ProductVariant[];
  images: ProductImageWithImageRow[];
  /**
   * Assigned taxonomy. Populated by findById/findBySlug so the admin edit form
   * can pre-select them; without this the form loads empty sets and a save PUTs
   * `[]`, wiping the product's category/tag assignments (data loss).
   */
  categories: Category[];
  tags: Tag[];
}

export interface ProductListFilters {
  status?: 'draft' | 'published' | 'archived';
  category?: string;
  tag?: string;
  priceMin?: number;
  priceMax?: number;
  inStock?: boolean;
  sort?: 'created' | 'title' | 'price';
  order?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface ProductListResult {
  data: ProductWithDetails[];
  total: number;
  page: number;
  pageSize: number;
}

export interface StoreCursorFilter {
  cursor?: string;
  pageSize?: number;
}

@Injectable()
export class ProductsRepository {
  constructor(private readonly db: DatabaseService) {}

  // ── Load product images (batched, avoids join with duplicate column names) ──

  private async loadProductImages(
    tenantId: string,
    productIds: string[],
  ): Promise<Record<string, ProductImageWithImageRow[]>> {
    if (productIds.length === 0) return {};

    const pImgRows = await this.db.db
      .select()
      .from(productImages)
      .where(
        and(inArray(productImages.productId, productIds), eq(productImages.tenantId, tenantId)),
      )
      .orderBy(asc(productImages.position));

    if (pImgRows.length === 0) return {};

    // Load images table rows separately (avoids column-name collision in join).
    const imageIds = [...new Set(pImgRows.map((r) => r.imageId))];
    const imgRows =
      imageIds.length > 0
        ? await this.db.db
            .select()
            .from(images)
            .where(and(inArray(images.id, imageIds), eq(images.tenantId, tenantId)))
        : [];

    const imgById = imgRows.reduce<Record<string, Image>>((acc, img) => {
      acc[img.id] = img;
      return acc;
    }, {});

    return pImgRows.reduce<Record<string, ProductImageWithImageRow[]>>((acc, pi) => {
      (acc[pi.productId] ??= []).push({
        ...pi,
        imageRow: imgById[pi.imageId] ?? null,
      });
      return acc;
    }, {});
  }

  // ── Load assigned taxonomy (categories + tags) for a single product ──────────

  private async loadProductTaxonomy(
    tenantId: string,
    productId: string,
  ): Promise<{ categories: Category[]; tags: Tag[] }> {
    // Categories/tags are joined through their junction tables, tenant-scoped on
    // both sides. The admin edit form pre-selects from these (product.categories
    // / product.tags); returning them prevents the save-wipes-assignments bug.
    const [categoryRows, tagRows] = await Promise.all([
      this.db.db
        .select({ category: categories })
        .from(productCategories)
        .innerJoin(
          categories,
          and(
            eq(categories.id, productCategories.categoryId),
            eq(categories.tenantId, productCategories.tenantId),
          ),
        )
        .where(
          and(eq(productCategories.productId, productId), eq(productCategories.tenantId, tenantId)),
        )
        .orderBy(asc(categories.name)),
      this.db.db
        .select({ tag: tags })
        .from(productTags)
        .innerJoin(
          tags,
          and(eq(tags.id, productTags.tagId), eq(tags.tenantId, productTags.tenantId)),
        )
        .where(and(eq(productTags.productId, productId), eq(productTags.tenantId, tenantId)))
        .orderBy(asc(tags.name)),
    ]);

    return {
      categories: categoryRows.map((r) => r.category),
      tags: tagRows.map((r) => r.tag),
    };
  }

  // ── Single relational load ──────────────────────────────────────────────────

  async findById(tenantId: string, productId: string): Promise<ProductWithDetails | null> {
    const rows = await this.db.db
      .select()
      .from(products)
      .where(and(eq(products.id, productId), eq(products.tenantId, tenantId)))
      .limit(1);

    if (!rows[0]) return null;

    const variants = await this.db.db
      .select()
      .from(productVariants)
      .where(and(eq(productVariants.productId, productId), eq(productVariants.tenantId, tenantId)))
      .orderBy(asc(productVariants.position), asc(productVariants.createdAt));

    const [imagesByProduct, taxonomy] = await Promise.all([
      this.loadProductImages(tenantId, [productId]),
      this.loadProductTaxonomy(tenantId, productId),
    ]);

    return {
      ...rows[0],
      variants,
      images: imagesByProduct[productId] ?? [],
      categories: taxonomy.categories,
      tags: taxonomy.tags,
    };
  }

  async findBySlug(tenantId: string, slug: string): Promise<ProductWithDetails | null> {
    const rows = await this.db.db
      .select()
      .from(products)
      .where(and(eq(products.slug, slug), eq(products.tenantId, tenantId)))
      .limit(1);
    if (!rows[0]) return null;
    return this.findById(tenantId, rows[0].id);
  }

  // ── Admin list (offset pagination) ─────────────────────────────────────────

  async adminList(tenantId: string, filters: ProductListFilters): Promise<ProductListResult> {
    const page = filters.page ?? 1;
    const pageSize = filters.pageSize ?? 20;
    const offset = (page - 1) * pageSize;
    const dir = filters.order === 'asc' ? asc : desc;

    const conditions = [eq(products.tenantId, tenantId)];
    if (filters.status) conditions.push(eq(products.status, filters.status));

    if (filters.category) {
      const catId = filters.category;
      conditions.push(
        exists(
          this.db.db
            .select({ one: sql`1` })
            .from(productCategories)
            .where(
              and(
                eq(productCategories.productId, products.id),
                eq(productCategories.tenantId, tenantId),
                eq(productCategories.categoryId, catId),
              ),
            ),
        ),
      );
    }

    if (filters.tag) {
      const tagId = filters.tag;
      conditions.push(
        exists(
          this.db.db
            .select({ one: sql`1` })
            .from(productTags)
            .where(
              and(
                eq(productTags.productId, products.id),
                eq(productTags.tenantId, tenantId),
                eq(productTags.tagId, tagId),
              ),
            ),
        ),
      );
    }

    if (filters.priceMin !== undefined) {
      const minVal = filters.priceMin;
      conditions.push(
        exists(
          this.db.db
            .select({ one: sql`1` })
            .from(productVariants)
            .where(
              and(
                eq(productVariants.productId, products.id),
                eq(productVariants.tenantId, tenantId),
                gte(productVariants.priceAmount, minVal),
              ),
            ),
        ),
      );
    }
    if (filters.priceMax !== undefined) {
      const maxVal = filters.priceMax;
      conditions.push(
        exists(
          this.db.db
            .select({ one: sql`1` })
            .from(productVariants)
            .where(
              and(
                eq(productVariants.productId, products.id),
                eq(productVariants.tenantId, tenantId),
                lte(productVariants.priceAmount, maxVal),
              ),
            ),
        ),
      );
    }

    if (filters.inStock === true) {
      conditions.push(
        exists(
          this.db.db
            .select({ one: sql`1` })
            .from(productVariants)
            .where(
              and(
                eq(productVariants.productId, products.id),
                eq(productVariants.tenantId, tenantId),
                or(gt(productVariants.stockQuantity, 0), eq(productVariants.allowBackorder, true)),
              ),
            ),
        ),
      );
    }

    const whereClause = and(...conditions);

    // Sort. 'price' orders by the product's MIN variant price (cheapest first
    // when asc) via a correlated subquery; products with no variant sort last.
    let orderClause;
    if (filters.sort === 'title') {
      orderClause = dir(products.title);
    } else if (filters.sort === 'price') {
      const minPrice = sql`(
        select min(${productVariants.priceAmount})
        from ${productVariants}
        where ${productVariants.productId} = ${products.id}
          and ${productVariants.tenantId} = ${tenantId}
      )`;
      orderClause =
        filters.order === 'asc'
          ? sql`${minPrice} asc nulls last`
          : sql`${minPrice} desc nulls last`;
    } else {
      orderClause = dir(products.createdAt);
    }

    const [countResult, rows] = await Promise.all([
      this.db.db
        .select({ count: sql<number>`count(*)::int` })
        .from(products)
        .where(whereClause),
      this.db.db
        .select()
        .from(products)
        .where(whereClause)
        .orderBy(orderClause)
        .limit(pageSize)
        .offset(offset),
    ]);

    const total = countResult[0]?.count ?? 0;
    if (rows.length === 0) {
      return { data: [], total, page, pageSize };
    }

    const productIds = rows.map((r) => r.id);
    const [variantRows, imagesByProduct] = await Promise.all([
      this.db.db
        .select()
        .from(productVariants)
        .where(
          and(
            inArray(productVariants.productId, productIds),
            eq(productVariants.tenantId, tenantId),
          ),
        )
        .orderBy(asc(productVariants.position), asc(productVariants.createdAt)),
      this.loadProductImages(tenantId, productIds),
    ]);

    const variantsByProduct = variantRows.reduce<Record<string, ProductVariant[]>>((acc, v) => {
      (acc[v.productId] ??= []).push(v);
      return acc;
    }, {});

    const data = rows.map((p) => ({
      ...p,
      variants: variantsByProduct[p.id] ?? [],
      images: imagesByProduct[p.id] ?? [],
      // List/store rows don't carry per-product taxonomy (not needed by those
      // surfaces); empty sets keep them ProductWithDetails-shaped.
      categories: [],
      tags: [],
    }));

    return { data, total, page, pageSize };
  }

  // ── Store cursor pagination ─────────────────────────────────────────────────

  async storeList(
    tenantId: string,
    filters: StoreCursorFilter,
  ): Promise<{ data: ProductWithDetails[]; nextCursor: string | null }> {
    const pageSize = Math.min(filters.pageSize ?? 20, 100);

    const conditions = [eq(products.tenantId, tenantId), eq(products.status, 'published')];

    if (filters.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(filters.cursor, 'base64').toString('utf8')) as {
          createdAt: string;
          id: string;
        };
        const cursorDate = new Date(decoded.createdAt);
        conditions.push(
          or(
            lt(products.createdAt, cursorDate),
            and(eq(products.createdAt, cursorDate), lt(products.id, decoded.id)),
          )!,
        );
      } catch {
        // Ignore malformed cursor — treat as first page.
      }
    }

    const rows = await this.db.db
      .select()
      .from(products)
      .where(and(...conditions))
      .orderBy(desc(products.createdAt), desc(products.id))
      .limit(pageSize + 1);

    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

    if (pageRows.length === 0) {
      return { data: [], nextCursor: null };
    }

    const productIds = pageRows.map((r) => r.id);
    const [variantRows, imagesByProduct] = await Promise.all([
      this.db.db
        .select()
        .from(productVariants)
        .where(
          and(
            inArray(productVariants.productId, productIds),
            eq(productVariants.tenantId, tenantId),
          ),
        )
        .orderBy(asc(productVariants.position), asc(productVariants.createdAt)),
      this.loadProductImages(tenantId, productIds),
    ]);

    const variantsByProduct = variantRows.reduce<Record<string, ProductVariant[]>>((acc, v) => {
      (acc[v.productId] ??= []).push(v);
      return acc;
    }, {});

    const data = pageRows.map((p) => ({
      ...p,
      variants: variantsByProduct[p.id] ?? [],
      images: imagesByProduct[p.id] ?? [],
      // List/store rows don't carry per-product taxonomy (not needed by those
      // surfaces); empty sets keep them ProductWithDetails-shaped.
      categories: [],
      tags: [],
    }));

    let nextCursor: string | null = null;
    if (hasMore) {
      const last = pageRows[pageRows.length - 1]!;
      nextCursor = Buffer.from(
        JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id }),
      ).toString('base64');
    }

    return { data, nextCursor };
  }

  // ── Mutations ───────────────────────────────────────────────────────────────

  async insert(value: NewProduct): Promise<Product> {
    const rows = await this.db.db.insert(products).values(value).returning();
    return rows[0]!;
  }

  async update(
    tenantId: string,
    productId: string,
    patch: Partial<NewProduct>,
  ): Promise<Product | null> {
    const rows = await this.db.db
      .update(products)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(products.id, productId), eq(products.tenantId, tenantId)))
      .returning();
    return rows[0] ?? null;
  }

  async hardDelete(tenantId: string, productId: string): Promise<boolean> {
    const rows = await this.db.db
      .delete(products)
      .where(and(eq(products.id, productId), eq(products.tenantId, tenantId)))
      .returning({ id: products.id });
    return rows.length > 0;
  }

  // ── Slug helpers ─────────────────────────────────────────────────────────────

  async slugExists(tenantId: string, slug: string): Promise<boolean> {
    const rows = await this.db.db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.slug, slug)))
      .limit(1);
    return rows.length > 0;
  }
}
