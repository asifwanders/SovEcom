/**
 * CartRepository.
 *
 * Redis is the source of truth during a session. On read: try Redis first, fall
 * back to Postgres. On every write: update Redis + SADD the cartId to the dirty
 * set. The CartFlushService drains the dirty set to Postgres every ~5 s.
 *
 * Redis key : sovecom:t:{tenantId}:cart:{cartId}   → JSON CartState
 * Dirty set : sovecom:t:{tenantId}:cart:dirty      → SET of cartIds
 * Redis TTL : 8 days (guest carts expire after 7 days; the TTL adds a 1-day buffer)
 */
import { Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { ChainableCommander } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import { RedisService, keys } from '../redis/redis.service';
import { DatabaseService } from '../database/database.service';
import { carts } from '../database/schema/carts';
import { cartItems } from '../database/schema/cart_items';
import { customers } from '../database/schema/customers';
import { productVariants } from '../database/schema/product_variants';
import { CartConflictException } from './cart-conflict.exception';
import { CartWatchPool } from './cart-watch-pool';
import { REDIS_TTL_SECONDS, assertExecOk, revive, sleep } from './cart-serialization';
import type { CartState, CartLineItem } from './cart.types';

// Re-exported for CartFlushRepository, which imports it from this module.
export { reviveCartState } from './cart-serialization';

/**
 * Bound on the optimistic WATCH/retry loop before throwing 409.
 *
 * Optimistic writers on the SAME cart key serialise one-at-a-time (each loser
 * re-reads and re-applies), so a burst of K genuinely-simultaneous mutations to
 * one cart needs up to ~K attempts for the last writer to win. A real cart is
 * driven by a single client, so contention is normally 1; this bound is sized so
 * even an adversarial burst (the S4 race test fires 10+ at once) converges with
 * headroom rather than spuriously 409ing. The 409 is reserved for genuine
 * livelock (a writer that NEVER stops touching the key).
 */
const MAX_MUTATE_RETRIES = 50;

/** Max randomised backoff between optimistic retries (ms) — de-synchronises a
 *  lock-stepped burst so writers stop colliding on the same EXEC window. */
const RETRY_BACKOFF_MAX_MS = 8;

@Injectable()
export class CartRepository {
  private readonly logger = new Logger(CartRepository.name);

  constructor(
    private readonly redis: RedisService,
    private readonly db: DatabaseService,
    private readonly watchPool: CartWatchPool,
  ) {}

  // ── Read ────────────────────────────────────────────────────────────────────

  async findById(tenantId: string, cartId: string): Promise<CartState | null> {
    // 1. Try Redis
    const redisKey = keys.cart(tenantId, cartId);
    const raw = await this.redis.client.get(redisKey);
    if (raw) {
      try {
        return revive(JSON.parse(raw) as unknown);
      } catch {
        // Corrupt blob — fall through to Postgres
      }
    }

    // 2. Fall back to Postgres
    const [row] = await this.db.db
      .select()
      .from(carts)
      .where(and(eq(carts.id, cartId), eq(carts.tenantId, tenantId)))
      .limit(1);
    if (!row) return null;

    const itemRows = await this.db.db
      .select()
      .from(cartItems)
      .where(and(eq(cartItems.cartId, cartId), eq(cartItems.tenantId, tenantId)));

    const state = this.rowsToState(row, itemRows);
    // Re-populate Redis from Postgres
    await this.redis.client.setex(redisKey, REDIS_TTL_SECONDS, JSON.stringify(state));
    return state;
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  async save(state: CartState): Promise<void> {
    const multi = this.redis.client.multi();
    this.queueSave(multi, state);
    assertExecOk(await multi.exec());
  }

  /**
   * Queue the cart's writes (SETEX blob, SADD dirty) onto an existing MULTI pipeline,
   * bumping `updatedAt`. Shared by `save()` and the optimistic `mutate()` loop so both
   * persist identical state. (The customer→cart lookup is now a direct Postgres query
   * — `findActiveCartIdByCustomer` — so no Redis customer pointer is maintained.)
   */
  private queueSave(multi: ChainableCommander, state: CartState): void {
    state.updatedAt = new Date();
    multi.setex(keys.cart(state.tenantId, state.id), REDIS_TTL_SECONDS, JSON.stringify(state));
    multi.sadd(keys.cartDirty(state.tenantId), state.id);
  }

  /**
   * Atomic read-modify-write of a cart via Redis optimistic concurrency (
   * fixes the S4 last-write-wins loss). WATCH the cart key → GET+revive (falls
   * back to Postgres like findById) → run `mutator(state)` (authorises + mutates +
   * reserves) → MULTI/EXEC the same writes `save()` does; on a null EXEC (concurrent
   * write touched the key) re-run, bounded by MAX_MUTATE_RETRIES then 409. Replay is
   * SAFE: `inventory.reserve()` is idempotent on the absolute qty and totals recompute
   * from state each attempt. The dedicated WATCH/EXEC connection comes from a bounded
   * pool (CartWatchPool) and is returned (not closed) in the finally.
   */
  async mutate<T>(
    tenantId: string,
    cartId: string,
    mutator: (state: CartState | null) => Promise<T> | T,
    compensate?: (lastReadState: CartState) => Promise<void>,
  ): Promise<T> {
    const redisKey = keys.cart(tenantId, cartId);
    // A DEDICATED pooled connection so WATCH/EXEC share one socket with no interleaving;
    // each concurrent mutate() gets its own, reset + returned (not closed) on completion.
    const { conn, transient } = await this.watchPool.acquire();
    // The last committed cart blob we READ (pre-mutation). On terminal-conflict the
    // compensation callback uses it to reconcile PG reservations to the authoritative
    // state our reserve may have diverged from.
    let lastReadState: CartState | null = null;
    try {
      for (let attempt = 0; attempt < MAX_MUTATE_RETRIES; attempt++) {
        await conn.watch(redisKey);

        // Read the freshest state on this watched connection.
        let state: CartState | null = null;
        const raw = await conn.get(redisKey);
        if (raw) {
          try {
            state = revive(JSON.parse(raw) as unknown);
          } catch {
            state = null; // corrupt blob → treat as absent, fall through to PG
          }
        }
        if (!state) {
          // Not in Redis — fall back to Postgres (and re-warm Redis). findById may
          // SETEX the key, which would invalidate THIS watch; so unwatch first,
          // load, then loop to re-watch the now-warm key.
          await conn.unwatch();
          state = await this.findById(tenantId, cartId);
          if (!state) {
            // Genuinely absent everywhere: let the mutator decide (authorise → 403/404).
            return await mutator(null);
          }
          continue; // re-watch the warmed key on the next iteration
        }

        // Snapshot the PRE-mutation (authoritative, committed) blob before the mutator
        // mutates `state` in place — the compensation path reconciles PG reservations
        // to THIS last-read state on budget exhaustion.
        lastReadState = structuredClone(state);

        // Run the mutation against the watched snapshot. The mutator does NOT touch
        // the watched cart key on this connection; any Redis reads it makes use the
        // shared client (they don't interfere with this connection's WATCH).
        const result = await mutator(state);

        const multi = conn.multi();
        this.queueSave(multi, state);
        const execResult = await multi.exec();
        if (execResult !== null) {
          assertExecOk(execResult); // a queued-command failure must not read as success (S-3)
          return result; // EXEC committed — no concurrent write touched the key
        }
        // EXEC aborted (watched key changed mid-flight). Retry from a fresh read.
        // NOTE: side effects the mutator already applied to Postgres
        // (inventory.reserve) are idempotent, so replaying is safe. A short
        // randomised backoff de-synchronises a lock-stepped burst.
        await sleep(Math.random() * RETRY_BACKOFF_MAX_MS);
      }
      // Budget exhausted (genuine livelock). Our last reserve() committed an absolute qty
      // to PG against `lastReadState`, but that blob was NEVER committed back to Redis →
      // the PG hold can diverge from the authoritative cart (orphan reservation). Reconcile
      // PG to the last-read state before surfacing the 409. Compensation must not
      // mask the conflict, so its own failure is swallowed (it self-logs).
      if (compensate && lastReadState) {
        try {
          await compensate(lastReadState);
        } catch (err) {
          this.logger.warn(
            `cart ${cartId}: reservation compensation failed on terminal conflict: ${
              err instanceof Error ? err.message : 'unknown error'
            }`,
          );
        }
      }
      throw new CartConflictException(cartId);
    } finally {
      // Reset (UNWATCH) and return the connection to the pool — never disconnect
      // it per call. Transient-overflow connections are quit() gracefully inside.
      await this.watchPool.release(conn, transient);
    }
  }

  // ── Create ──────────────────────────────────────────────────────────────────

  buildNewState(
    tenantId: string,
    currency: string,
    isGuest: boolean,
    customerId?: string,
  ): CartState {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (isGuest ? 7 : 30) * 24 * 60 * 60 * 1000);
    return {
      id: uuidv7(), // time-ordered id (index locality)
      tenantId,
      customerId: customerId ?? null,
      // Bearer cart token: full-entropy UUIDv4 (NOT uuidv7, which leaks mint time
      // and has fewer random bits)
      sessionToken: randomUUID(),
      currency,
      status: 'active',
      guestEmail: null,
      items: [],
      shippingAddress: null,
      billingAddress: null,
      shippingRateId: null,
      shippingAmount: 0,
      discountCode: null,
      totals: { subtotal: 0, shipping: 0, discountTotal: 0, taxTotal: 0, grandTotal: 0, currency },
      expiresAt,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Synchronously persist the cart row (+ items) to Postgres.
   *
   * `inventory_reservations.cart_id` is a hard FK to
   * `carts(id, tenant_id)`, but carts are Redis-authoritative and flushed async.
   * CartService.create() calls this so the FK target exists before any
   * reservation is taken. Reuses the same idempotent upsert as the flush worker.
   */
  async persist(state: CartState): Promise<void> {
    await this.upsertToPostgres(state);
  }

  /**
   * Claim a customer for a cart in Postgres — the SOLE arbiter of "one active cart per
   * customer". Updating `customer_id` on an active cart trips the
   * partial unique index, raising 23505 if the customer already has another active cart.
   * Runs BEFORE any Redis ownership write, so a race loser never poisons Redis. Does NOT
   * touch items (Redis stays source of truth). Returns false (0 rows) when the row is
   * gone or owned by another customer (the guard below) → caller 403s/conflicts.
   */
  async claimCustomer(
    tenantId: string,
    cartId: string,
    customerId: string,
    sessionToken: string,
    expiresAt: Date,
  ): Promise<boolean> {
    // Ownership guard (round-3 backlog): only claim a row that is UNOWNED
    // or already this customer's. A row owned by a DIFFERENT customer matches 0 rows
    // (the caller then 403s) — this closes the cross-customer claim-overwrite window
    // where two logged-in customers race to associate one shared guest cookie.
    const updated = await this.db.db
      .update(carts)
      .set({ customerId, sessionToken, expiresAt, updatedAt: new Date() })
      .where(
        and(
          eq(carts.id, cartId),
          eq(carts.tenantId, tenantId),
          eq(carts.status, 'active'),
          or(isNull(carts.customerId), eq(carts.customerId, customerId)),
        ),
      )
      .returning({ id: carts.id });
    return updated.length > 0;
  }

  /**
   * Atomically abandon a guest cart in Postgres IFF still active and unowned-or-mine —
   * the PG-arbitrated merge gate (round-3 TOCTOU): mirrors claimCustomer's guard so a
   * customer can't capture+abandon a cart ANOTHER customer concurrently adopted.
   * Returns false (0 rows) when owned by a different customer / not active → caller 403s.
   */
  async tryAbandonOwnGuestCart(
    tenantId: string,
    cartId: string,
    customerId: string,
  ): Promise<boolean> {
    const updated = await this.db.db
      .update(carts)
      .set({ status: 'abandoned', updatedAt: new Date() })
      .where(
        and(
          eq(carts.id, cartId),
          eq(carts.tenantId, tenantId),
          eq(carts.status, 'active'),
          or(isNull(carts.customerId), eq(carts.customerId, customerId)),
        ),
      )
      .returning({ id: carts.id });
    return updated.length > 0;
  }

  /**
   * The id of the customer's current active cart, read DIRECTLY from Postgres (the
   * unique index just arbitrated the winner; never the Redis pointer —).
   */
  async findActiveCartIdByCustomer(tenantId: string, customerId: string): Promise<string | null> {
    const [row] = await this.db.db
      .select({ id: carts.id })
      .from(carts)
      .where(
        and(
          eq(carts.tenantId, tenantId),
          eq(carts.customerId, customerId),
          eq(carts.status, 'active'),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }

  // ── Postgres write path (shared by persist() + CartFlushRepository) ──────────

  /**
   * Upsert the full cart state to Postgres in a transaction. The single
   * idempotent write path used by both the synchronous `persist()` (create /
   * associate) and the async dirty-set flush (CartFlushRepository).
   */
  async upsertToPostgres(state: CartState): Promise<void> {
    await this.db.db.transaction(async (tx) => {
      // Self-heal a dangling customer FK: an RGPD-erased customer
      // CASCADE-removes their PG cart row while the Redis blob keeps `customerId` —
      // re-inserting it would FK-violate forever. If the customer no longer resolves
      // to a live row in this tenant, null it so the flush self-heals (degrades to guest).
      let customerId = state.customerId ?? null;
      if (customerId) {
        const [live] = await tx
          .select({ id: customers.id })
          .from(customers)
          .where(and(eq(customers.id, customerId), eq(customers.tenantId, state.tenantId)))
          .limit(1);
        if (!live) {
          this.logger.warn(
            `cart ${state.id}: customer ${customerId} no longer exists in tenant ${state.tenantId}; nulling customer_id on flush`,
          );
          customerId = null;
        }
      }

      // Upsert the cart row
      await tx
        .insert(carts)
        .values({
          id: state.id,
          tenantId: state.tenantId,
          customerId: customerId ?? undefined,
          sessionToken: state.sessionToken,
          currency: state.currency,
          status: state.status,
          expiresAt: state.expiresAt,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
        })
        .onConflictDoUpdate({
          target: carts.id,
          set: {
            // Only touch customer_id when the Redis blob ASSERTS a customer (or the
            // RGPD self-heal nulled a present one). For a guest blob (state.customerId
            // null) we OMIT it (undefined) — otherwise a flush landing in the window
            // between claimCustomer() and the adopt-mutate would NULL the just-claimed
            // customer_id and re-open the B1 flush-poison (review NEW-1).
            customerId: state.customerId == null ? undefined : customerId,
            currency: state.currency,
            status: state.status,
            expiresAt: state.expiresAt,
            updatedAt: state.updatedAt,
          },
        });

      // Drop line items whose variant has since been deleted: re-inserting them
      // would violate cart_items_variant_fk and permanently poison the flush.
      // Cart items are transient pre-checkout data (cart_items.variant_id is
      // ON DELETE CASCADE), so silently dropping a dead line is correct.
      const variantIds = state.items.map((i) => i.variantId);
      let liveItems = state.items;
      if (variantIds.length > 0) {
        const existing = await tx
          .select({ id: productVariants.id })
          .from(productVariants)
          .where(
            and(
              eq(productVariants.tenantId, state.tenantId),
              inArray(productVariants.id, variantIds),
            ),
          );
        const liveIds = new Set(existing.map((r) => r.id));
        liveItems = state.items.filter((i) => liveIds.has(i.variantId));
      }

      // Clean upsert of items: delete the cart's rows, then re-insert the live set.
      await tx
        .delete(cartItems)
        .where(and(eq(cartItems.cartId, state.id), eq(cartItems.tenantId, state.tenantId)));

      if (liveItems.length > 0) {
        await tx.insert(cartItems).values(
          liveItems.map((item) => ({
            id: item.id,
            tenantId: state.tenantId,
            cartId: state.id,
            variantId: item.variantId,
            quantity: item.quantity,
            unitPriceAmount: item.unitPriceAmount,
            currency: item.currency,
            // Display-identity snapshot — persisted so a cart rehydrated from
            // Postgres after Redis TTL keeps the human-readable line identity. Columns are nullable
            // (additive migration); legacy rows / a missing snapshot degrade gracefully on read.
            productTitle: item.productTitle,
            variantTitle: item.variantTitle,
            options: item.options,
            sku: item.sku,
            productSlug: item.productSlug,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          })),
        );
      }
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private rowsToState(
    row: typeof carts.$inferSelect,
    itemRows: (typeof cartItems.$inferSelect)[],
  ): CartState {
    const items: CartLineItem[] = itemRows.map((i) => ({
      id: i.id,
      variantId: i.variantId,
      quantity: i.quantity,
      unitPriceAmount: i.unitPriceAmount,
      currency: i.currency,
      // Display-identity snapshot. Columns are nullable (additive migration),
      // so a row written before this change rehydrates with empty-string/`{}` defaults rather than
      // null — the storefront view-type is non-null and falls back to the variant id if title is blank.
      productTitle: i.productTitle ?? '',
      variantTitle: i.variantTitle ?? null,
      options: (i.options ?? {}) as Record<string, unknown>,
      sku: i.sku ?? '',
      productSlug: i.productSlug ?? '',
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
    }));

    const subtotal = items.reduce((s, i) => s + i.unitPriceAmount * i.quantity, 0);
    return {
      id: row.id,
      tenantId: row.tenantId,
      customerId: row.customerId ?? null,
      sessionToken: row.sessionToken ?? '',
      currency: row.currency,
      status: row.status,
      guestEmail: null,
      items,
      shippingAddress: null,
      billingAddress: null,
      shippingRateId: null,
      // NOTE: the 2.1 carts table has no address/email/shipping/discount columns, so a
      // Postgres-only recovery (Redis evicted) loses shipping selection, addresses,
      // guestEmail and the applied discount code — the storefront must re-collect them
      // at checkout. Tracked for the 2.8 checkout persistence work (follow-up).
      shippingAmount: 0,
      discountCode: null,
      totals: {
        subtotal,
        shipping: 0,
        discountTotal: 0,
        taxTotal: 0,
        grandTotal: subtotal,
        currency: row.currency,
      },
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
