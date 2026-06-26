/**
 * DiscountsService. Orchestrates engine + repository.
 *
 * Responsibilities:
 *  - evaluateForCart(): async, DB-backed — loads candidates + usage + categories,
 *    builds the pure engine snapshot, returns the discountTotal + applied list the
 *    cart bakes into its totals.
 *  - validateCodeForCart(): the store apply-by-code gate — 422 (with a reason) when
 *    a code is unknown or, applied to THIS cart, would discount nothing (ineligible).
 *  - Admin CRUD with a service-layer "RESTRICT-while-used" delete guard.
 *
 * All money is integer minor units. Every repo call is tenant-scoped.
 */
import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
  ConflictException,
} from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { orders } from '../database/schema/orders';
import { DiscountsRepository, type DiscountUpdate } from './discounts.repository';
import {
  DiscountEngine,
  type CandidateDiscount,
  type DiscountCartSnapshot,
  type DiscountEvalContext,
  type DiscountEvalResult,
} from './discount-engine';
import type { Discount } from '../database/schema/discounts';
import type { CartState } from '../cart/cart.types';
import type { CreateDiscountDto, UpdateDiscountDto } from './dto/discount.dto';

@Injectable()
export class DiscountsService {
  private readonly engine = new DiscountEngine();

  constructor(
    private readonly repo: DiscountsRepository,
    private readonly db: DatabaseService,
  ) {}

  // ── Cart evaluation (the cart calls this on every recompute) ─────────────────

  /**
   * Evaluate all discounts that apply to a cart: the cart's single explicit
   * `discountCode` (if any) plus every active automatic discount. Returns the
   * computed total + the ordered applied list. Never throws on an ineligible code —
   * it simply contributes nothing (the store apply endpoint validates separately).
   */
  async evaluateForCart(
    tenantId: string,
    cart: CartState,
    discountCode: string | null,
  ): Promise<DiscountEvalResult> {
    // Empty cart → nothing to discount, skip the DB entirely.
    if (cart.items.length === 0) return { applied: [], discountTotal: 0 };

    const candidateRows = await this.repo.loadCandidates(tenantId, discountCode);
    if (candidateRows.length === 0) return { applied: [], discountTotal: 0 };

    const snapshot = await this.buildSnapshot(tenantId, cart);
    const candidates = candidateRows.map(toCandidate);
    const context = await this.buildEvalContext(tenantId, cart, candidates);

    return this.engine.evaluate({ cart: snapshot, candidates, context });
  }

  /**
   * Build the customer/usage eligibility context from the cart OWNER (`cart.customerId`),
   * NOT the request principal — so totals are identical whether the cart is mutated via the
   * cart cookie or a customer JWT. A guest cart has no context.
   */
  private async buildEvalContext(
    tenantId: string,
    cart: CartState,
    candidates: CandidateDiscount[],
  ): Promise<DiscountEvalContext> {
    let isB2b = false;
    let perCustomerUsage = new Map<string, number>();
    // `null` = guest (the engine maps it to "neither first_time nor returning").
    let customerHasPriorOrder: boolean | null = null;
    if (cart.customerId) {
      isB2b = await this.repo.customerIsB2b(tenantId, cart.customerId);
      perCustomerUsage = await this.repo.perCustomerUsage(
        tenantId,
        cart.customerId,
        candidates.map((c) => c.id),
      );
      customerHasPriorOrder = await this.customerHasPriorOrder(tenantId, cart.customerId);
    } else if (cart.guestEmail) {
      // Guest cart: enforce the per-customer usage limit by NORMALIZED guest email so a
      // once-per-customer code can't be re-redeemed by checking out repeatedly as a guest.
      perCustomerUsage = await this.repo.perGuestUsage(
        tenantId,
        cart.guestEmail,
        candidates.map((c) => c.id),
      );
    }
    return { isB2b, perCustomerUsage, customerHasPriorOrder };
  }

  /**
   * Order-history signal for the `first_time`/`returning` segments.
   * Tenant-scoped COUNT of the cart owner's NON-cancelled orders, queried directly
   * against the orders table (DatabaseService) so Discounts does NOT import OrdersModule
   * — that would create an Orders↔Discounts dependency cycle. Returns true ⇔ ≥1 prior
   * non-cancelled order. A cancelled order does not count as a prior purchase.
   */
  async customerHasPriorOrder(tenantId: string, customerId: string): Promise<boolean> {
    const [row] = await this.db.db
      .select({ exists: sql<boolean>`true` })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.customerId, customerId),
          ne(orders.status, 'cancelled'),
        ),
      )
      .limit(1);
    return row != null;
  }

  /**
   * Validate a code against a cart for the store apply endpoint. Throws 422 when the code is
   * unknown OR, applied to THIS cart, would discount nothing (ineligible); returns silently when
   * the code is valid AND contributes a non-zero saving.
   *
   * the unknown and ineligible cases throw the SAME opaque message. Two distinguishable
   * 422s ("not valid" when the code misses vs "not eligible" when it exists) were a coupon-
   * enumeration oracle: an attacker could probe which codes EXIST. Collapsing them makes a
   * valid-but-ineligible code indistinguishable from an unknown one.
   */
  async validateCodeForCart(tenantId: string, cart: CartState, code: string): Promise<void> {
    const reject = () =>
      new UnprocessableEntityException('Discount code is not valid for this cart');
    const row = await this.repo.findByCode(tenantId, code);
    if (!row) {
      throw reject();
    }
    // Judge the code's eligibility on its OWN PRE-clamp contribution, evaluating ONLY this
    // candidate — never the automatic discounts. The combined evaluateForCart
    // clamps each applied amount to the headroom left after other discounts; when active
    // automatic discounts already zero the cart the code clamps to 0 and would be wrongly
    // rejected as "ineligible". Running just `row` through the engine isolates the code's
    // own eligibility/saving — the actual money math + grandTotal still come from
    // evaluateForCart(), unchanged.
    if (cart.items.length === 0) {
      throw reject();
    }
    const snapshot = await this.buildSnapshot(tenantId, cart);
    const candidate = toCandidate(row);
    const context = await this.buildEvalContext(tenantId, cart, [candidate]);
    const result = this.engine.evaluate({ cart: snapshot, candidates: [candidate], context });
    const applied = result.applied.find((a) => a.discountId === row.id && a.amount > 0);
    if (!applied) {
      throw reject();
    }
  }

  // ── Snapshot builder ─────────────────────────────────────────────────────────

  private async buildSnapshot(tenantId: string, cart: CartState): Promise<DiscountCartSnapshot> {
    const variantIds = cart.items.map((i) => i.variantId);
    const { variantToProduct, productCategories } =
      await this.repo.resolveVariantProductsAndCategories(tenantId, variantIds);

    const items = cart.items.map((i) => ({
      // A variant whose product vanished resolves to its own id — it can never match
      // a real product/category target, so it only contributes to the `all` subtotal.
      productId: variantToProduct.get(i.variantId) ?? i.variantId,
      unitPriceAmount: i.unitPriceAmount,
      quantity: i.quantity,
    }));
    const subtotal = items.reduce((s, i) => s + i.unitPriceAmount * i.quantity, 0);

    return { currency: cart.currency, subtotal, items, productCategories };
  }

  // ── Admin CRUD ────────────────────────────────────────────────────────────────

  async create(tenantId: string, dto: CreateDiscountDto): Promise<Discount> {
    return this.repo.create(tenantId, {
      name: dto.name,
      code: dto.code ?? null,
      type: dto.type,
      value: dto.value,
      currency: dto.currency ?? null,
      minCartAmount: dto.minCartAmount ?? null,
      appliesTo: dto.appliesTo,
      targetIds: dto.targetIds ?? null,
      customerSegment: dto.customerSegment ?? null,
      stackable: dto.stackable,
      usageLimitTotal: dto.usageLimitTotal ?? null,
      usageLimitPerCustomer: dto.usageLimitPerCustomer ?? null,
      startsAt: dto.startsAt ?? null,
      endsAt: dto.endsAt ?? null,
      active: dto.active,
    });
  }

  async list(tenantId: string): Promise<Discount[]> {
    return this.repo.list(tenantId);
  }

  async findById(tenantId: string, id: string): Promise<Discount> {
    const row = await this.repo.findById(tenantId, id);
    if (!row) throw new NotFoundException(`Discount ${id} not found`);
    return row;
  }

  async update(tenantId: string, id: string, dto: UpdateDiscountDto): Promise<Discount> {
    const existing = await this.findById(tenantId, id); // 404 if absent
    // PATCH semantics: validate the MERGED row against the same invariants the create
    // schema enforces (the partial UpdateDiscountSchema can't — fields are optional).
    const type = dto.type ?? existing.type;
    const value = dto.value ?? existing.value;
    const currency = dto.currency !== undefined ? dto.currency : existing.currency;
    const appliesTo = dto.appliesTo ?? existing.appliesTo;
    const targetIds = dto.targetIds !== undefined ? dto.targetIds : existing.targetIds;
    if (type === 'percentage' && value > 10000) {
      throw new UnprocessableEntityException('percentage value must be ≤ 10000 (100.00%)');
    }
    if (type === 'fixed' && currency == null) {
      throw new UnprocessableEntityException('currency is required for a fixed-amount discount');
    }
    if (appliesTo !== 'all' && (!Array.isArray(targetIds) || targetIds.length === 0)) {
      throw new UnprocessableEntityException(
        'targetIds is required and non-empty for products/categories scope',
      );
    }
    const patch: DiscountUpdate = { ...dto };
    const row = await this.repo.update(tenantId, id, patch);
    if (!row) throw new NotFoundException(`Discount ${id} not found`);
    return row;
  }

  /**
   * Delete a discount. RESTRICT-while-used (discount_usages.ts TODO): refuse to
   * delete a discount that has redemption history (the DB CASCADE would erase the
   * legal record) — the admin must deactivate it instead. Unused drafts delete cleanly.
   */
  async delete(tenantId: string, id: string): Promise<void> {
    await this.findById(tenantId, id); // 404 if absent
    if (await this.repo.hasUsages(tenantId, id)) {
      throw new ConflictException(
        'Discount has redemption history and cannot be deleted; deactivate it instead',
      );
    }
    await this.repo.delete(tenantId, id);
  }
}

/** Normalise a DB row to the engine's CandidateDiscount (jsonb targetIds → string[]). */
function toCandidate(row: Discount): CandidateDiscount {
  const raw = row.targetIds;
  const targetIds = Array.isArray(raw) ? (raw.filter((x) => typeof x === 'string') as string[]) : null; // prettier-ignore
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    value: row.value,
    currency: row.currency,
    minCartAmount: row.minCartAmount,
    appliesTo: row.appliesTo,
    targetIds,
    customerSegment: row.customerSegment,
    stackable: row.stackable,
    usageLimitTotal: row.usageLimitTotal,
    usageLimitPerCustomer: row.usageLimitPerCustomer,
    usedCount: row.usedCount,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    active: row.active,
  };
}
