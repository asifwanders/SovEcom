/**
 * CartService.
 *
 * All cart mutations live here. Enforces server-authoritative totals: computed
 * fresh on every mutation, never trusted from the client. All writes go to
 * Redis immediately; CartFlushService drains to Postgres asynchronously.
 *
 * Security decisions:
 *  - Cart token is the session_token UUID stored on carts.session_token.
 *  - Every cart access validates the token OR verifies the owning customer JWT.
 *  - Reject mismatches with 403/404 — do NOT leak existence.
 *  - Totals recomputed server-side on every mutation.
 */
import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
  Logger,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { CartRepository } from './cart.repository';
import { CartAssociateService } from './cart-associate.service';
import { authoriseCart } from './cart-authorise';
import { CartTotalsCalculator } from './totals/cart-totals.calculator';
import { recomputeCartTotals } from './cart-totals.helper';
import { DatabaseService } from '../database/database.service';
import { InventoryService } from '../inventory/inventory.service';
import { DiscountsService } from '../discounts/discounts.service';
import { TaxesService } from '../taxes/taxes.service';
import { TenantSettingsService } from '../taxes/tenant-settings.service';
import { ShippingService } from '../shipping/shipping.service';
import { productVariants } from '../database/schema/product_variants';
import { products } from '../database/schema/products';
import type { CartState, CartLineItem, CartAddress } from './cart.types';
import type { AuthenticatedCustomer } from '../customers/auth/authenticated-customer';

/** Max distinct line items per cart — bounds blob size and abuse. */
const MAX_CART_ITEMS = 100;

@Injectable()
export class CartService {
  private readonly logger = new Logger(CartService.name);
  private readonly calculator = new CartTotalsCalculator();

  constructor(
    private readonly repo: CartRepository,
    private readonly db: DatabaseService,
    private readonly inventory: InventoryService,
    private readonly discounts: DiscountsService,
    private readonly taxes: TaxesService,
    private readonly tenantSettings: TenantSettingsService,
    private readonly shipping: ShippingService,
    private readonly associate: CartAssociateService,
  ) {}

  // ── Create ───────────────────────────────────────────────────────────────────

  async create(tenantId: string, currency = 'EUR'): Promise<CartState> {
    const state = this.repo.buildNewState(tenantId, currency, /* isGuest */ true);
    await this.repo.save(state);
    // persist the empty cart so inventory_reservations can FK to it.
    await this.repo.persist(state);
    this.logger.debug(`cart created: ${state.id} tenant=${tenantId}`);
    return state;
  }

  // ── Read ─────────────────────────────────────────────────────────────────────

  /**
   * Load a cart, validating that the caller is authorised.
   * A caller may present either the cart token cookie OR a customer JWT.
   */
  async findByIdAuthorised(
    tenantId: string,
    cartId: string,
    cartToken: string | undefined,
    customer: AuthenticatedCustomer | undefined,
  ): Promise<CartState> {
    const state = await this.repo.findById(tenantId, cartId);
    authoriseCart(state, cartId, cartToken, customer);
    return state!;
  }

  /**
   * The shipping rates AVAILABLE for this cart's current destination.
   * Authorised like a cart read; no shipping address yet → empty list.
   */
  async getShippingRates(
    tenantId: string,
    cartId: string,
    cartToken: string | undefined,
    customer: AuthenticatedCustomer | undefined,
  ) {
    const state = await this.repo.findById(tenantId, cartId);
    authoriseCart(state, cartId, cartToken, customer);
    return this.shipping.availableRates(tenantId, state!);
  }

  async addItem(
    tenantId: string,
    cartId: string,
    cartToken: string | undefined,
    customer: AuthenticatedCustomer | undefined,
    variantId: string,
    quantity: number,
  ): Promise<CartState> {
    // Look up the variant once OUTSIDE the loop (immutable price/currency, so a retry
    // need not re-query it). Authorise + mutate run INSIDE mutate() on fresh state.
    const variant = await this.requirePublishedVariant(tenantId, variantId);

    return this.repo.mutate(
      tenantId,
      cartId,
      async (state) => {
        authoriseCart(state, cartId, cartToken, customer);
        const cart = state;

        // Enforce single currency
        if (cart.currency !== variant.currency) {
          throw new UnprocessableEntityException(
            `Cannot mix currencies: cart is ${cart.currency}, variant is ${variant.currency}`,
          );
        }

        const now = new Date();
        const existingIdx = cart.items.findIndex((i) => i.variantId === variantId);
        if (existingIdx >= 0) {
          // Merge quantity — reserve the RESULTING total (availability across ALL carts,
          // 409 on over-ask), not just the delta.
          const resultingQty = cart.items[existingIdx]!.quantity + quantity;
          await this.inventory.reserve(tenantId, cartId, variantId, resultingQty);
          cart.items[existingIdx]!.quantity = resultingQty;
          cart.items[existingIdx]!.updatedAt = now;
        } else {
          if (cart.items.length >= MAX_CART_ITEMS) {
            throw new UnprocessableEntityException(
              `Cart cannot hold more than ${MAX_CART_ITEMS} distinct items`,
            );
          }
          await this.inventory.reserve(tenantId, cartId, variantId, quantity);
          const newItem: CartLineItem = {
            id: uuidv7(),
            variantId,
            quantity,
            unitPriceAmount: variant.priceAmount,
            currency: variant.currency,
            // Display-identity snapshot at add-time — stable against a later
            // rename/unpublish/delete, exactly like the price snapshot above.
            productTitle: variant.productTitle,
            variantTitle: variant.variantTitle,
            options: variant.options,
            sku: variant.sku,
            productSlug: variant.productSlug,
            createdAt: now,
            updatedAt: now,
          };
          cart.items.push(newItem);
        }

        await this.recomputeTotals(tenantId, cart);
        return cart;
      },
      this.reservationCompensator(tenantId, cartId),
    );
  }

  async updateItem(
    tenantId: string,
    cartId: string,
    itemId: string,
    cartToken: string | undefined,
    customer: AuthenticatedCustomer | undefined,
    quantity: number,
  ): Promise<CartState> {
    return this.repo.mutate(
      tenantId,
      cartId,
      async (state) => {
        authoriseCart(state, cartId, cartToken, customer);
        const cart = state;

        const idx = cart.items.findIndex((i) => i.id === itemId);
        if (idx < 0) {
          throw new NotFoundException(`Item ${itemId} not found in cart ${cartId}`);
        }
        // Re-reserve for the new quantity (B2 +): reserve row-locks the
        // variant, enforces availability across all carts (409 on over-ask), and is
        // idempotent on the absolute qty → safe to replay on an optimistic retry.
        await this.inventory.reserve(tenantId, cartId, cart.items[idx]!.variantId, quantity);
        cart.items[idx]!.quantity = quantity;
        cart.items[idx]!.updatedAt = new Date();
        await this.recomputeTotals(tenantId, cart);
        return cart;
      },
      this.reservationCompensator(tenantId, cartId),
    );
  }

  async removeItem(
    tenantId: string,
    cartId: string,
    itemId: string,
    cartToken: string | undefined,
    customer: AuthenticatedCustomer | undefined,
  ): Promise<CartState> {
    return this.repo.mutate(
      tenantId,
      cartId,
      async (state) => {
        authoriseCart(state, cartId, cartToken, customer);
        const cart = state;

        const removed = cart.items.find((i) => i.id === itemId);
        cart.items = cart.items.filter((i) => i.id !== itemId);
        // Release the variant's reservation back to availability; idempotent.
        if (removed) {
          await this.inventory.release(tenantId, cartId, removed.variantId);
        }
        await this.recomputeTotals(tenantId, cart);
        return cart;
      },
      this.reservationCompensator(tenantId, cartId),
    );
  }

  async setShippingAddress(
    tenantId: string,
    cartId: string,
    cartToken: string | undefined,
    customer: AuthenticatedCustomer | undefined,
    address: CartAddress,
  ): Promise<CartState> {
    return this.repo.mutate(tenantId, cartId, async (state) => {
      authoriseCart(state, cartId, cartToken, customer);
      state.shippingAddress = address;
      await this.recomputeTotals(tenantId, state);
      return state;
    });
  }

  async setBillingAddress(
    tenantId: string,
    cartId: string,
    cartToken: string | undefined,
    customer: AuthenticatedCustomer | undefined,
    address: CartAddress,
  ): Promise<CartState> {
    return this.repo.mutate(tenantId, cartId, (state) => {
      authoriseCart(state, cartId, cartToken, customer);
      state.billingAddress = address;
      return state;
    });
  }

  async setShippingMethod(
    tenantId: string,
    cartId: string,
    cartToken: string | undefined,
    customer: AuthenticatedCustomer | undefined,
    shippingRateId: string,
  ): Promise<CartState> {
    return this.repo.mutate(tenantId, cartId, async (state) => {
      authoriseCart(state, cartId, cartToken, customer);
      const cart = state;

      // The rate must be AVAILABLE for the cart's CURRENT destination — i.e. its zone
      // includes the shipping country, its currency matches the cart, and (for a weight
      // band) the cart weight falls in range. This also closes the
      // cross-currency hole and rejects a rate from another tenant/zone.
      const available = await this.shipping.availableRates(tenantId, cart);
      if (!available.some((r) => r.id === shippingRateId)) {
        throw new UnprocessableEntityException(
          `Shipping rate ${shippingRateId} is not available for this cart`,
        );
      }

      // Select it; recompute then derives the authoritative cost (free_over / weight band).
      cart.shippingRateId = shippingRateId;
      await this.recomputeTotals(tenantId, cart);
      return cart;
    });
  }

  async setGuestEmail(
    tenantId: string,
    cartId: string,
    cartToken: string | undefined,
    customer: AuthenticatedCustomer | undefined,
    email: string,
  ): Promise<CartState> {
    return this.repo.mutate(tenantId, cartId, (state) => {
      authoriseCart(state, cartId, cartToken, customer);
      state.guestEmail = email;
      return state;
    });
  }

  // ── Discounts (apply / remove by code + 0036.5) ────────────────────

  /**
   * Apply a discount code to the cart. Validates the code against the CURRENT cart
   * (unknown / ineligible → 422 with a reason), sets the cart's single `discountCode`,
   * and recomputes totals (the engine applies it + all automatic discounts). Routed
   * through mutate() so the validate→set→recompute is atomic with concurrent edits.
   */
  async applyDiscount(
    tenantId: string,
    cartId: string,
    cartToken: string | undefined,
    customer: AuthenticatedCustomer | undefined,
    code: string,
  ): Promise<CartState> {
    return this.repo.mutate(tenantId, cartId, async (state) => {
      authoriseCart(state, cartId, cartToken, customer);
      const cart = state;
      // Validate against the live cart on THIS attempt — throws 422 if not eligible.
      await this.discounts.validateCodeForCart(tenantId, cart, code);
      cart.discountCode = code;
      await this.recomputeTotals(tenantId, cart);
      return cart;
    });
  }

  /**
   * Remove the explicit discount code from the cart and recompute (automatic discounts
   * still apply). Idempotent — removing a code that is not the cart's active code (or
   * when none is set) simply clears nothing and recomputes. Atomic via mutate().
   */
  async removeDiscount(
    tenantId: string,
    cartId: string,
    cartToken: string | undefined,
    customer: AuthenticatedCustomer | undefined,
    code: string,
  ): Promise<CartState> {
    return this.repo.mutate(tenantId, cartId, async (state) => {
      authoriseCart(state, cartId, cartToken, customer);
      const cart = state;
      if (cart.discountCode === code) {
        cart.discountCode = null;
      }
      await this.recomputeTotals(tenantId, cart);
      return cart;
    });
  }

  // ── Customer association + merge (delegated to CartAssociateService) ─────────

  associateCustomer(
    tenantId: string,
    cartId: string,
    cartToken: string | undefined,
    customer: AuthenticatedCustomer,
  ): Promise<CartState> {
    return this.associate.associateCustomer(tenantId, cartId, cartToken, customer);
  }

  // ── Abandon ──────────────────────────────────────────────────────────────────

  async abandon(
    tenantId: string,
    cartId: string,
    cartToken: string | undefined,
    customer: AuthenticatedCustomer | undefined,
  ): Promise<void> {
    await this.repo.mutate(tenantId, cartId, async (state) => {
      authoriseCart(state, cartId, cartToken, customer);
      const cart = state;
      cart.status = 'abandoned';
      cart.items = [];
      cart.totals = {
        subtotal: 0,
        shipping: 0,
        discountTotal: 0,
        taxTotal: 0,
        grandTotal: 0,
        currency: cart.currency,
      };
      // Release ALL reservations back to availability; idempotent on replay.
      await this.inventory.releaseForCart(tenantId, cartId);
      return cart;
    });
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Compensation callback for mutate. On a terminal optimistic conflict — after a
   * reserve() committed to PG but the Redis blob never did — reconcile PG reservations to the
   * authoritative LAST-READ cart state, so no orphan hold counts against other carts until TTL.
   * Reconciling re-reserves (clamped) to the last-read items and releases the rest; clamping
   * keeps it no-oversell-safe.
   */
  private reservationCompensator(
    tenantId: string,
    cartId: string,
  ): (lastReadState: CartState) => Promise<void> {
    return (lastReadState: CartState) =>
      this.inventory.reconcileCartReservations(
        tenantId,
        cartId,
        lastReadState.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
      );
  }

  /**
   * Recompute totals; shipping comes from `cart.shippingAmount`, never re-zeroed.
   *
   * the discount total is computed by the DB-backed DiscountEngine (the
   * cart's single explicit `discountCode` + all active automatic discounts) and passed
   * INTO the pure calculator. `customer` (when present) drives segment/usage eligibility.
   * Called inside every async mutator, so it stays atomic with the mutation.
   */
  private recomputeTotals(tenantId: string, cart: CartState): Promise<void> {
    return recomputeCartTotals(
      tenantId,
      cart,
      this.discounts,
      this.taxes,
      this.tenantSettings,
      this.shipping,
      this.calculator,
    );
  }

  /**
   * Resolve a variant's price/currency, asserting its product is published in this
   * tenant. Stock enforcement lives in InventoryService.reserve.
   */
  private async requirePublishedVariant(
    tenantId: string,
    variantId: string,
  ): Promise<{
    priceAmount: number;
    currency: string;
    productTitle: string;
    variantTitle: string | null;
    options: Record<string, unknown>;
    sku: string;
    productSlug: string;
  }> {
    const [row] = await this.db.db
      .select({
        priceAmount: productVariants.priceAmount,
        currency: productVariants.currency,
        productStatus: products.status,
        // Display-identity columns snapshotted onto the cart line at add-time.
        productTitle: products.title,
        productSlug: products.slug,
        variantTitle: productVariants.title,
        options: productVariants.options,
        sku: productVariants.sku,
      })
      .from(productVariants)
      .innerJoin(
        products,
        and(
          eq(productVariants.productId, products.id),
          eq(productVariants.tenantId, products.tenantId),
        ),
      )
      .where(and(eq(productVariants.id, variantId), eq(productVariants.tenantId, tenantId)))
      .limit(1);

    if (!row || row.productStatus !== 'published') {
      throw new NotFoundException(`Variant ${variantId} not found or product not published`);
    }

    return {
      priceAmount: row.priceAmount,
      currency: row.currency,
      productTitle: row.productTitle,
      variantTitle: row.variantTitle,
      // `options` is jsonb (NOT NULL in the schema); normalise to an object for the snapshot contract.
      options: (row.options ?? {}) as Record<string, unknown>,
      sku: row.sku,
      productSlug: row.productSlug,
    };
  }
}
