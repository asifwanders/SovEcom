/**
 * TaxonomyAssignmentService.
 *
 * Handles product↔category and product↔tag assignment (replace-set semantics).
 * Requires PRODUCTS_WRITE permission (mutates product).
 *
 * Cross-tenant guard: every supplied id is validated against the tenant before
 * touching junction tables.
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { and, eq, inArray } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { categories } from '../database/schema/categories';
import { tags } from '../database/schema/tags';
import { products } from '../database/schema/products';
import { productCategories } from '../database/schema/product_categories';
import { productTags } from '../database/schema/product_tags';
import { ProductUpdatedEvent } from './events/product-updated.event';

@Injectable()
export class TaxonomyAssignmentService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  // ── Product ↔ Categories ───────────────────────────────────────────────────

  /**
   * Replace the full category set for a product (replace-set semantics).
   * All supplied categoryIds must belong to the same tenant.
   */
  async assignCategories(
    tenantId: string,
    actorId: string,
    productId: string,
    categoryIdsInput: string[],
    ip?: string,
    userAgent?: string,
  ): Promise<void> {
    // F4 (Fable): defense-in-depth dedupe (the DTO transform already does this,
    // but the service must be safe when called directly). [X, X] would otherwise
    // violate the junction PK → raw 23505 → 500.
    const categoryIds = Array.from(new Set(categoryIdsInput));

    // Verify product belongs to tenant.
    const productRow = await this.db.db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.id, productId), eq(products.tenantId, tenantId)))
      .limit(1);
    if (!productRow[0]) throw new NotFoundException(`Product ${productId} not found`);

    // Validate every categoryId belongs to this tenant (cross-tenant guard).
    if (categoryIds.length > 0) {
      const validRows = await this.db.db
        .select({ id: categories.id })
        .from(categories)
        .where(and(inArray(categories.id, categoryIds), eq(categories.tenantId, tenantId)));
      const validIds = new Set(validRows.map((r) => r.id));
      const invalid = categoryIds.filter((id) => !validIds.has(id));
      if (invalid.length > 0) {
        throw new BadRequestException(
          `Category ids not found in this tenant: ${invalid.join(', ')}`,
        );
      }
    }

    // Transactional replace.
    await this.db.db.transaction(async (tx) => {
      // Delete existing.
      await tx
        .delete(productCategories)
        .where(
          and(eq(productCategories.productId, productId), eq(productCategories.tenantId, tenantId)),
        );
      // Insert new set.
      if (categoryIds.length > 0) {
        await tx
          .insert(productCategories)
          .values(categoryIds.map((categoryId) => ({ tenantId, productId, categoryId })));
      }
    });

    // a category change alters the product's search facets
    // (categorySlugs/categoryNames). Emit product.updated so the search indexer
    // re-indexes the product; otherwise the storefront facet goes stale until an
    // unrelated update fires. Mirrors variants.service.ts.
    this.events.emit(
      ProductUpdatedEvent.EVENT,
      new ProductUpdatedEvent(tenantId, productId, { categoriesAssigned: categoryIds }),
    );

    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId,
      action: 'product.categories.assigned',
      resourceType: 'product',
      resourceId: productId,
      ip,
      userAgent,
      changes: { categoryIds },
    });
  }

  // ── Product ↔ Tags ─────────────────────────────────────────────────────────

  /**
   * Replace the full tag set for a product (replace-set semantics).
   */
  async assignTags(
    tenantId: string,
    actorId: string,
    productId: string,
    tagIdsInput: string[],
    ip?: string,
    userAgent?: string,
  ): Promise<void> {
    // F4 (Fable): defense-in-depth dedupe (see assignCategories).
    const tagIds = Array.from(new Set(tagIdsInput));

    // Verify product belongs to tenant.
    const productRow = await this.db.db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.id, productId), eq(products.tenantId, tenantId)))
      .limit(1);
    if (!productRow[0]) throw new NotFoundException(`Product ${productId} not found`);

    // Validate every tagId belongs to this tenant.
    if (tagIds.length > 0) {
      const validRows = await this.db.db
        .select({ id: tags.id })
        .from(tags)
        .where(and(inArray(tags.id, tagIds), eq(tags.tenantId, tenantId)));
      const validIds = new Set(validRows.map((r) => r.id));
      const invalid = tagIds.filter((id) => !validIds.has(id));
      if (invalid.length > 0) {
        throw new BadRequestException(`Tag ids not found in this tenant: ${invalid.join(', ')}`);
      }
    }

    // Transactional replace.
    await this.db.db.transaction(async (tx) => {
      await tx
        .delete(productTags)
        .where(and(eq(productTags.productId, productId), eq(productTags.tenantId, tenantId)));
      if (tagIds.length > 0) {
        await tx
          .insert(productTags)
          .values(tagIds.map((tagId) => ({ tenantId, productId, tagId })));
      }
    });

    // a tag change alters the product's search facets
    // (tagSlugs/tagNames) — re-index via product.updated (see assignCategories).
    this.events.emit(
      ProductUpdatedEvent.EVENT,
      new ProductUpdatedEvent(tenantId, productId, { tagsAssigned: tagIds }),
    );

    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId,
      action: 'product.tags.assigned',
      resourceType: 'product',
      resourceId: productId,
      ip,
      userAgent,
      changes: { tagIds },
    });
  }
}
