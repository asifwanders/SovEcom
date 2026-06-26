/**
 * DiscountsRepository. Tenant-scoped data access.
 *
 * Loads candidate discounts for an evaluation (the ONE explicit code, if any, PLUS
 * every automatic null-code active discount), performs admin CRUD, and reads the
 * per-customer redemption counts from `discount_usages`. Every query is tenant-scoped.
 */
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DatabaseService } from '../database/database.service';
import { discounts, type Discount, type NewDiscount } from '../database/schema/discounts';
import { discountUsages } from '../database/schema/discount_usages';
import { productCategories } from '../database/schema/product_categories';
import { productVariants } from '../database/schema/product_variants';
import { customers } from '../database/schema/customers';

export interface DiscountUpdate {
  name?: string;
  code?: string | null;
  type?: 'percentage' | 'fixed';
  value?: number;
  currency?: string | null;
  minCartAmount?: number | null;
  appliesTo?: 'all' | 'products' | 'categories';
  targetIds?: string[] | null;
  customerSegment?: string | null;
  stackable?: boolean;
  usageLimitTotal?: number | null;
  usageLimitPerCustomer?: number | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  active?: boolean;
}

@Injectable()
export class DiscountsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  // ── Candidate loading (engine input) ─────────────────────────────────────────

  /**
   * Load the candidate discounts for an evaluation: every ACTIVE automatic
   * (null-code) discount, PLUS the single discount matching `code` (if provided).
   * Returned rows still go through the engine's full eligibility filter — this only
   * narrows the set we fetch from the DB. Tenant-scoped.
   */
  async loadCandidates(tenantId: string, code: string | null): Promise<Discount[]> {
    const where =
      code == null
        ? and(eq(discounts.tenantId, tenantId), eq(discounts.active, true), isNull(discounts.code))
        : and(
            eq(discounts.tenantId, tenantId),
            eq(discounts.active, true),
            // automatic (null code) OR the one explicit code
            sql`(${discounts.code} is null or ${discounts.code} = ${code})`,
          );
    return this.db.select().from(discounts).where(where);
  }

  /** Resolve a single discount by its code (tenant-scoped). Null if none. */
  async findByCode(tenantId: string, code: string): Promise<Discount | null> {
    const [row] = await this.db
      .select()
      .from(discounts)
      .where(and(eq(discounts.tenantId, tenantId), eq(discounts.code, code)))
      .limit(1);
    return row ?? null;
  }

  // ── Per-customer usage (read-only eligibility) ────────────────────────────

  /**
   * Redemption counts per discount id for a given customer (from discount_usages),
   * restricted to the supplied discount ids. Tenant-scoped. Returns a Map keyed by
   * discount id; absent ids mean zero usage.
   */
  /** `is_b2b` for the cart's OWNER (tenant-scoped) — drives the `b2b` segment from the
   * cart owner, not the request principal. */
  async customerIsB2b(tenantId: string, customerId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ isB2b: customers.isB2b })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.tenantId, tenantId)))
      .limit(1);
    return row?.isB2b ?? false;
  }

  async perCustomerUsage(
    tenantId: string,
    customerId: string,
    discountIds: string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (discountIds.length === 0) return out;
    const rows = await this.db
      .select({ discountId: discountUsages.discountId, count: sql<number>`count(*)::int` })
      .from(discountUsages)
      .where(
        and(
          eq(discountUsages.tenantId, tenantId),
          eq(discountUsages.customerId, customerId),
          inArray(discountUsages.discountId, discountIds),
        ),
      )
      .groupBy(discountUsages.discountId);
    for (const r of rows) out.set(r.discountId, r.count);
    return out;
  }

  /**
   * Per-GUEST redemption counts, keyed on the normalized (lowercased) buyer email,
   * for the supplied discount ids. Mirrors {@link perCustomerUsage} but for guests
   * (customer_id NULL) so a once-per-customer code cannot be re-redeemed indefinitely
   * by checking out as a guest. Tenant-scoped. Empty map when no email is known.
   */
  async perGuestUsage(
    tenantId: string,
    email: string,
    discountIds: string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (discountIds.length === 0) return out;
    const rows = await this.db
      .select({ discountId: discountUsages.discountId, count: sql<number>`count(*)::int` })
      .from(discountUsages)
      .where(
        and(
          eq(discountUsages.tenantId, tenantId),
          sql`lower(${discountUsages.email}) = ${email.toLowerCase()}`,
          inArray(discountUsages.discountId, discountIds),
        ),
      )
      .groupBy(discountUsages.discountId);
    for (const r of rows) out.set(r.discountId, r.count);
    return out;
  }

  // ── Category resolution (for the `categories` scope) ─────────────────────────

  /**
   * Map each product id (resolved from the cart's variant ids) to the set of
   * category ids it belongs to. Tenant-scoped. Used to build the engine snapshot's
   * `productCategories`. Returns BOTH the variant→product map and product→categories.
   */
  async resolveVariantProductsAndCategories(
    tenantId: string,
    variantIds: string[],
  ): Promise<{
    variantToProduct: Map<string, string>;
    productCategories: Map<string, Set<string>>;
  }> {
    const variantToProduct = new Map<string, string>();
    const productCats = new Map<string, Set<string>>();
    if (variantIds.length === 0) return { variantToProduct, productCategories: productCats };

    const variants = await this.db
      .select({ id: productVariants.id, productId: productVariants.productId })
      .from(productVariants)
      .where(and(eq(productVariants.tenantId, tenantId), inArray(productVariants.id, variantIds)));
    const productIds: string[] = [];
    for (const v of variants) {
      variantToProduct.set(v.id, v.productId);
      productIds.push(v.productId);
    }

    if (productIds.length > 0) {
      const cats = await this.db
        .select({
          productId: productCategories.productId,
          categoryId: productCategories.categoryId,
        })
        .from(productCategories)
        .where(
          and(
            eq(productCategories.tenantId, tenantId),
            inArray(productCategories.productId, productIds),
          ),
        );
      for (const row of cats) {
        let set = productCats.get(row.productId);
        if (!set) {
          set = new Set<string>();
          productCats.set(row.productId, set);
        }
        set.add(row.categoryId);
      }
    }

    return { variantToProduct, productCategories: productCats };
  }

  // ── CRUD (admin) ─────────────────────────────────────────────────────────────

  async create(tenantId: string, values: Omit<NewDiscount, 'id' | 'tenantId'>): Promise<Discount> {
    const [row] = await this.db
      .insert(discounts)
      .values({ id: uuidv7(), tenantId, ...values })
      .returning();
    return row!;
  }

  async findById(tenantId: string, id: string): Promise<Discount | null> {
    const [row] = await this.db
      .select()
      .from(discounts)
      .where(and(eq(discounts.tenantId, tenantId), eq(discounts.id, id)))
      .limit(1);
    return row ?? null;
  }

  async list(tenantId: string): Promise<Discount[]> {
    return this.db
      .select()
      .from(discounts)
      .where(eq(discounts.tenantId, tenantId))
      .orderBy(discounts.createdAt);
  }

  async update(tenantId: string, id: string, patch: DiscountUpdate): Promise<Discount | null> {
    const [row] = await this.db
      .update(discounts)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(discounts.tenantId, tenantId), eq(discounts.id, id)))
      .returning();
    return row ?? null;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(discounts)
      .where(and(eq(discounts.tenantId, tenantId), eq(discounts.id, id)))
      .returning({ id: discounts.id });
    return rows.length > 0;
  }

  /** True if this discount has ANY redemption rows (guards the RESTRICT-while-used delete). */
  async hasUsages(tenantId: string, id: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: discountUsages.id })
      .from(discountUsages)
      .where(and(eq(discountUsages.tenantId, tenantId), eq(discountUsages.discountId, id)))
      .limit(1);
    return row != null;
  }
}
