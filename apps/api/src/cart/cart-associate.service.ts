/**
 * CartAssociateService.
 *
 * The guest→customer association + merge — extracted from CartService (it grew past
 * the 500-line budget) and the highest-concurrency moment (login). All the data-loss /
 * cart-theft hardening lives here: Postgres is the SOLE arbiter of "one active cart
 * per customer" and a race loser never commits ownership to Redis nor captures a stranger's cart.
 */
import {
  Injectable,
  Logger,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CartRepository } from './cart.repository';
import { CartConflictException } from './cart-conflict.exception';
import { CartTotalsCalculator } from './totals/cart-totals.calculator';
import { authoriseCart } from './cart-authorise';
import { mergeCartItems } from './cart-merge.util';
import { recomputeCartTotals } from './cart-totals.helper';
import { InventoryService } from '../inventory/inventory.service';
import { DiscountsService } from '../discounts/discounts.service';
import { TaxesService } from '../taxes/taxes.service';
import { TenantSettingsService } from '../taxes/tenant-settings.service';
import { ShippingService } from '../shipping/shipping.service';
import type { CartState, CartLineItem } from './cart.types';
import type { AuthenticatedCustomer } from '../customers/auth/authenticated-customer';

/** True if the error is a Postgres unique-constraint violation (SQLSTATE 23505).
 *  Checks `.cause` too: drizzle wraps driver errors in a DrizzleQueryError whose
 *  `.cause` carries the real postgres-js error + `.code`. */
function isUniqueViolation(err: unknown): boolean {
  const codeOf = (e: unknown): string | undefined =>
    typeof e === 'object' && e !== null ? (e as { code?: string }).code : undefined;
  return codeOf(err) === '23505' || codeOf((err as { cause?: unknown })?.cause) === '23505';
}

@Injectable()
export class CartAssociateService {
  private readonly logger = new Logger(CartAssociateService.name);
  private readonly calculator = new CartTotalsCalculator();

  constructor(
    private readonly repo: CartRepository,
    private readonly inventory: InventoryService,
    private readonly discounts: DiscountsService,
    private readonly taxes: TaxesService,
    private readonly tenantSettings: TenantSettingsService,
    private readonly shipping: ShippingService,
  ) {}

  async associateCustomer(
    tenantId: string,
    cartId: string,
    cartToken: string | undefined,
    customer: AuthenticatedCustomer,
  ): Promise<CartState> {
    // B4: the JWT customer must belong to THIS storefront's tenant.
    if (customer.tenantId !== tenantId) {
      throw new ForbiddenException('Access denied');
    }
    const guestCart = await this.repo.findById(tenantId, cartId);
    authoriseCart(guestCart, cartId, cartToken, undefined); // cart-token holder
    const guest = guestCart!;
    // B5: a cart owned by ANOTHER customer can't be re-associated (ownership/PII theft).
    if (guest.customerId && guest.customerId !== customer.id) {
      throw new ForbiddenException('Access denied');
    }
    if (guest.customerId === customer.id) return guest; // idempotent re-associate

    // ── Claim the customer slot in POSTGRES FIRST (review B1) ───────────────────
    // The partial unique index `carts(tenant_id, customer_id) WHERE active` is the
    // SOLE arbiter; claiming there before any Redis write means a race loser never
    // commits ownership to Redis. Token/expiry decided up front so PG and Redis agree.
    const newToken = randomUUID();
    const newExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    let claimed = false;
    let customerHasOtherCart = false;
    try {
      claimed = await this.repo.claimCustomer(
        tenantId,
        cartId,
        customer.id,
        newToken,
        newExpiresAt,
      );
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // 23505: customer ALREADY has a different active cart → merge the guest into it.
      customerHasOtherCart = true;
    }

    if (claimed) {
      // We won adoption. Commit ownership to Redis ATOMICALLY (B2); the rotated token
      // kills the (possibly shared) guest cookie.
      return this.repo.mutate(tenantId, cartId, async (state) => {
        authoriseCart(state, cartId, cartToken, undefined);
        const cart = state!;
        if (cart.customerId === customer.id) return cart; // already owned (double-claim)
        cart.customerId = customer.id;
        cart.sessionToken = newToken;
        cart.expiresAt = newExpiresAt;
        // Recompute: ownership now sets the eligibility/tax context (b2b segment,
        // reverse-charge) — without this the cart keeps its guest-computed discount/tax
        // until the next mutation.
        //
        // The PG claim already committed (above); ownership MUST land in Redis too, so a
        // recompute fault can't split PG (claimed) from Redis (still guest). On failure we
        // commit ownership and let totals lag to the next mutation —
        // a recoverable, self-healing degradation, never a divergent owner.
        try {
          await recomputeCartTotals(
            tenantId,
            cart,
            this.discounts,
            this.taxes,
            this.tenantSettings,
            this.shipping,
            this.calculator,
          );
        } catch (err) {
          this.logger.warn(
            `Totals recompute failed on claim of cart ${cartId} by customer ${customer.id}; ` +
              `committing ownership with stale totals (next mutation will recompute): ${String(err)}`,
          );
        }
        return cart;
      });
    }

    if (!customerHasOtherCart) {
      // 0 rows, no unique violation → the ownership guard blocked it: this guest cart
      // is owned by ANOTHER customer (or vanished). NEVER merge it (stranger's PII) —
      // re-read to decide 403 vs retry.
      const fresh = await this.repo.findById(tenantId, cartId);
      if (fresh && fresh.customerId && fresh.customerId !== customer.id) {
        throw new ForbiddenException('Access denied'); // owned by another customer (B5)
      }
      if (fresh && fresh.customerId === customer.id) return fresh; // raced to ours
      throw new CartConflictException(cartId); // vanished — transient, retryable
    }

    // ── Customer already has another active cart → merge the guest into it ──
    // Resolve the winner from POSTGRES directly (never the Redis pointer — B1).
    const winnerId = await this.repo.findActiveCartIdByCustomer(tenantId, customer.id);
    if (!winnerId || winnerId === cartId) {
      throw new CartConflictException(cartId); // winning row vanished — transient
    }

    // Currency + liveness pre-check BEFORE touching either cart (NEW-3: a mismatch or
    // abandoned winner leaves both untouched).
    const winnerCheck = await this.repo.findById(tenantId, winnerId);
    if (!winnerCheck || winnerCheck.status !== 'active') {
      throw new CartConflictException(winnerId); // winner abandoned/gone → retryable
    }
    if (guest.currency !== winnerCheck.currency) {
      throw new UnprocessableEntityException(
        `Cannot merge carts: guest is ${guest.currency}, customer cart is ${winnerCheck.currency}`,
      );
    }

    // PG-ARBITRATE the guest abandon (round-3 TOCTOU): atomically abandon the guest in
    // Postgres ONLY if it is still active and unowned-or-mine. If a DIFFERENT customer
    // concurrently adopted it (shared guest cookie), this matches 0 rows → 403, so we
    // never capture+destroy a stranger's just-adopted cart.
    if (!(await this.repo.tryAbandonOwnGuestCart(tenantId, cartId, customer.id))) {
      const fresh = await this.repo.findById(tenantId, cartId);
      if (fresh && fresh.customerId && fresh.customerId !== customer.id) {
        throw new ForbiddenException('Access denied'); // adopted by another customer
      }
      throw new CartConflictException(cartId); // already abandoned / vanished — transient
    }

    // Capture the guest's items from Redis + mark its blob abandoned (PG already is).
    // The guard rejects a blob a stranger owns (defense in depth vs the PG/Redis lag).
    const captured = await this.repo.mutate(tenantId, cartId, async (state) => {
      if (!state) return [] as CartLineItem[];
      if (state.customerId && state.customerId !== customer.id) {
        throw new ForbiddenException('Access denied');
      }
      const items = [...state.items];
      await this.inventory.releaseForCart(tenantId, cartId);
      state.status = 'abandoned';
      state.items = [];
      return items;
    });

    // Merge captured items into the winner ATOMICALLY (B2), re-checking it's active
    // AND owned by THIS customer (defense in depth — never merge into a stranger's cart).
    const merged = await this.repo.mutate(tenantId, winnerId, async (winnerState) => {
      if (
        !winnerState ||
        winnerState.status !== 'active' ||
        winnerState.customerId !== customer.id
      ) {
        throw new CartConflictException(winnerId);
      }
      const winner = winnerState;
      const mergedItems = mergeCartItems(captured, winner.items, {});
      const opts = { clampToAvailable: true };
      const survivors: CartLineItem[] = [];
      for (const line of mergedItems) {
        const got = await this.inventory.reserve(tenantId, winnerId, line.variantId, line.quantity, opts); // prettier-ignore
        if (got > 0) survivors.push({ ...line, quantity: got });
      }
      winner.items = survivors;
      await recomputeCartTotals(
        tenantId,
        winner,
        this.discounts,
        this.taxes,
        this.tenantSettings,
        this.shipping,
        this.calculator,
      );
      return winner;
    });

    this.logger.debug(`merged guest cart ${cartId} into customer cart ${winnerId}`);
    return merged;
  }
}
