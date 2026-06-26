/**
 * VariantsRepository.
 */
import { Injectable } from '@nestjs/common';
import { and, eq, asc } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import {
  productVariants,
  type ProductVariant,
  type NewProductVariant,
} from '../../database/schema/product_variants';

@Injectable()
export class VariantsRepository {
  constructor(private readonly db: DatabaseService) {}

  async findByProductId(tenantId: string, productId: string): Promise<ProductVariant[]> {
    return this.db.db
      .select()
      .from(productVariants)
      .where(and(eq(productVariants.productId, productId), eq(productVariants.tenantId, tenantId)))
      .orderBy(asc(productVariants.position), asc(productVariants.createdAt));
  }

  async findById(tenantId: string, variantId: string): Promise<ProductVariant | null> {
    const rows = await this.db.db
      .select()
      .from(productVariants)
      .where(and(eq(productVariants.id, variantId), eq(productVariants.tenantId, tenantId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async skuExists(tenantId: string, sku: string, excludeId?: string): Promise<boolean> {
    const rows = await this.db.db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.sku, sku)))
      .limit(2);
    if (excludeId) {
      return rows.some((r) => r.id !== excludeId);
    }
    return rows.length > 0;
  }

  async insert(value: NewProductVariant): Promise<ProductVariant> {
    const rows = await this.db.db.insert(productVariants).values(value).returning();
    return rows[0]!;
  }

  async insertMany(values: NewProductVariant[]): Promise<ProductVariant[]> {
    if (values.length === 0) return [];
    return this.db.db.insert(productVariants).values(values).returning();
  }

  async update(
    tenantId: string,
    variantId: string,
    patch: Partial<NewProductVariant>,
  ): Promise<ProductVariant | null> {
    const rows = await this.db.db
      .update(productVariants)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(productVariants.id, variantId), eq(productVariants.tenantId, tenantId)))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Like {@link update} but ALSO scopes by productId (F4 defense-in-depth) — a
   * variant can only be mutated through its true parent product, never another
   * product's URL even within the same tenant.
   */
  async updateScoped(
    tenantId: string,
    productId: string,
    variantId: string,
    patch: Partial<NewProductVariant>,
  ): Promise<ProductVariant | null> {
    const rows = await this.db.db
      .update(productVariants)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(productVariants.id, variantId),
          eq(productVariants.tenantId, tenantId),
          eq(productVariants.productId, productId),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  async delete(tenantId: string, variantId: string): Promise<boolean> {
    const rows = await this.db.db
      .delete(productVariants)
      .where(and(eq(productVariants.id, variantId), eq(productVariants.tenantId, tenantId)))
      .returning({ id: productVariants.id });
    return rows.length > 0;
  }
}
