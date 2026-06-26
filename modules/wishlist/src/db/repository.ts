/**
 * wishlist -- the data-access layer over `sdk.tables`.
 *
 * EVERY statement here is PARAMETERIZED -- customer ids, guest ids, and variant ids arrive as
 * bound params ($1, $2, ...), never string-concatenated into SQL. The module runs under its own
 * low-privilege DB role (the executor pins search_path to the module schema), so unqualified table
 * names resolve to the module's OWN tables and a statement that reached for a core table would be
 * refused by PG.
 *
 * `customer_id` and `guest_id` are ALWAYS bound parameters sourced from the core-verified
 * `req.customer.id` or `req.guestId.id` (never client input) -- see api/handlers.ts. Scoping
 * every read/write/delete by the appropriate id is what makes one viewer unable to see or
 * mutate another's items.
 *
 * IMPORTANT (runtime contract): `sdk.tables.exec` reports `rowCount` as the number of rows the
 * statement RETURNED, not the number it affected. So any INSERT/DELETE whose "did it change a row?"
 * result we care about MUST use `RETURNING id` and we count the returned rows.
 */
import type { TablesClient } from '@sovecom/module-sdk';
import { ITEMS_TABLE, GUEST_ITEMS_TABLE, DIGEST_LOG_TABLE } from './schema';

/** A stored customer wishlist row. */
export interface WishlistRow {
  readonly id: string;
  readonly customer_id: string;
  readonly product_variant_id: string;
  readonly created_at: string;
}

/** A stored guest wishlist row. */
export interface GuestWishlistRow {
  readonly id: string;
  readonly guest_id: string;
  readonly product_variant_id: string;
  readonly created_at: string;
}

/** Generate a row id. `crypto.randomUUID` is available in the Node worker runtime. */
function newId(): string {
  return crypto.randomUUID();
}

export class WishlistRepository {
  constructor(private readonly tables: TablesClient) {}

  // ── Customer (logged-in) operations ─────────────────────────────────────────

  /** Count a customer's current items -- used to enforce the per-customer cap before inserting. */
  async countForCustomer(customerId: string): Promise<number> {
    const { rows } = await this.tables.query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count FROM ${ITEMS_TABLE} WHERE customer_id = $1`,
      [customerId],
    );
    const c = rows[0]?.count;
    return typeof c === 'number' ? c : Number(c ?? 0);
  }

  /** True if this customer already has this variant wishlisted (so "add" is idempotent). */
  async has(customerId: string, productVariantId: string): Promise<boolean> {
    const { rows } = await this.tables.query<{ id: string }>(
      `SELECT id FROM ${ITEMS_TABLE} WHERE customer_id = $1 AND product_variant_id = $2 LIMIT 1`,
      [customerId, productVariantId],
    );
    return rows.length > 0;
  }

  /**
   * Insert an item for this customer. Idempotent: the UNIQUE(customer_id, product_variant_id)
   * constraint + `ON CONFLICT DO NOTHING` means a repeat add is a no-op (returns the existing row).
   * Returns the row (existing or new).
   */
  async add(customerId: string, productVariantId: string): Promise<WishlistRow> {
    await this.tables.exec(
      `INSERT INTO ${ITEMS_TABLE} (id, customer_id, product_variant_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (customer_id, product_variant_id) DO NOTHING`,
      [newId(), customerId, productVariantId],
    );
    const { rows } = await this.tables.query<WishlistRow>(
      `SELECT id, customer_id, product_variant_id, created_at
         FROM ${ITEMS_TABLE} WHERE customer_id = $1 AND product_variant_id = $2 LIMIT 1`,
      [customerId, productVariantId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error('wishlist: row vanished immediately after insert');
    }
    return row;
  }

  /** Remove an item for this customer. Returns true if a row was deleted. */
  async remove(customerId: string, productVariantId: string): Promise<boolean> {
    const { rows } = await this.tables.exec(
      `DELETE FROM ${ITEMS_TABLE} WHERE customer_id = $1 AND product_variant_id = $2 RETURNING id`,
      [customerId, productVariantId],
    );
    return rows.length > 0;
  }

  /** List a customer's items, newest first. */
  async list(customerId: string): Promise<WishlistRow[]> {
    const { rows } = await this.tables.query<WishlistRow>(
      `SELECT id, customer_id, product_variant_id, created_at
         FROM ${ITEMS_TABLE} WHERE customer_id = $1 ORDER BY created_at DESC, id DESC`,
      [customerId],
    );
    return rows;
  }

  /** Every (customer_id, product_variant_id) wishlisting one of `variantIds` -- for the digest. */
  async customersWatching(variantIds: readonly string[]): Promise<WishlistRow[]> {
    if (variantIds.length === 0) return [];
    const placeholders = variantIds.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await this.tables.query<WishlistRow>(
      `SELECT id, customer_id, product_variant_id, created_at
         FROM ${ITEMS_TABLE} WHERE product_variant_id IN (${placeholders})`,
      [...variantIds],
    );
    return rows;
  }

  // ── Guest (anonymous) operations ─────────────────────────────────────────────

  /** Count a guest's current items -- used to enforce the per-guest cap before inserting. */
  async countForGuest(guestId: string): Promise<number> {
    const { rows } = await this.tables.query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count FROM ${GUEST_ITEMS_TABLE} WHERE guest_id = $1`,
      [guestId],
    );
    const c = rows[0]?.count;
    return typeof c === 'number' ? c : Number(c ?? 0);
  }

  /** True if this guest already has this variant wishlisted. */
  async guestHas(guestId: string, productVariantId: string): Promise<boolean> {
    const { rows } = await this.tables.query<{ id: string }>(
      `SELECT id FROM ${GUEST_ITEMS_TABLE} WHERE guest_id = $1 AND product_variant_id = $2 LIMIT 1`,
      [guestId, productVariantId],
    );
    return rows.length > 0;
  }

  /**
   * Insert an item for this guest. Idempotent via UNIQUE(guest_id, product_variant_id).
   * Returns the row (existing or new).
   */
  async guestAdd(guestId: string, productVariantId: string): Promise<GuestWishlistRow> {
    await this.tables.exec(
      `INSERT INTO ${GUEST_ITEMS_TABLE} (id, guest_id, product_variant_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (guest_id, product_variant_id) DO NOTHING`,
      [newId(), guestId, productVariantId],
    );
    const { rows } = await this.tables.query<GuestWishlistRow>(
      `SELECT id, guest_id, product_variant_id, created_at
         FROM ${GUEST_ITEMS_TABLE} WHERE guest_id = $1 AND product_variant_id = $2 LIMIT 1`,
      [guestId, productVariantId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error('wishlist: guest row vanished immediately after insert');
    }
    return row;
  }

  /** Remove an item for this guest. Returns true if a row was deleted. */
  async guestRemove(guestId: string, productVariantId: string): Promise<boolean> {
    const { rows } = await this.tables.exec(
      `DELETE FROM ${GUEST_ITEMS_TABLE}
        WHERE guest_id = $1 AND product_variant_id = $2 RETURNING id`,
      [guestId, productVariantId],
    );
    return rows.length > 0;
  }

  /** List a guest's items, newest first. */
  async guestList(guestId: string): Promise<GuestWishlistRow[]> {
    const { rows } = await this.tables.query<GuestWishlistRow>(
      `SELECT id, guest_id, product_variant_id, created_at
         FROM ${GUEST_ITEMS_TABLE} WHERE guest_id = $1 ORDER BY created_at DESC, id DESC`,
      [guestId],
    );
    return rows;
  }

  // ── Merge-on-login ───────────────────────────────────────────────────────────

  /**
   * Migrate a guest's wishlist items to a customer id (idempotent, dedupe-safe).
   *
   * This is called after a guest logs in / registers. For each guest item:
   *   1. Upsert into the customer items table (UNIQUE constraint silently dedupes duplicates).
   *   2. Delete the guest item.
   *
   * This runs as multiple statements (not a single transaction at the SQL level), but each
   * upsert+delete pair is individually idempotent -- a retry after partial failure is safe.
   * The UNIQUE constraint on (customer_id, product_variant_id) prevents duplicates regardless
   * of race conditions.
   *
   * Returns the number of distinct variants successfully merged.
   */
  async mergeGuestToCustomer(guestId: string, customerId: string): Promise<number> {
    // Fetch all guest items first.
    const guestRows = await this.guestList(guestId);
    if (guestRows.length === 0) return 0;

    let merged = 0;
    for (const row of guestRows) {
      // Upsert into customer table (idempotent -- UNIQUE constraint handles duplicates).
      await this.tables.exec(
        `INSERT INTO ${ITEMS_TABLE} (id, customer_id, product_variant_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (customer_id, product_variant_id) DO NOTHING`,
        [newId(), customerId, row.product_variant_id],
      );
      // Delete the guest row (idempotent -- DELETE is safe to repeat).
      await this.guestRemove(guestId, row.product_variant_id);
      merged++;
    }
    return merged;
  }

  // ── Digest (customer-only) operations ────────────────────────────────────────

  /**
   * CLAIM (customer, variant) for digest run `digestRunId`. Idempotent via
   * UNIQUE(customer_id, product_variant_id, digest_run_id). Returns true if THIS call recorded
   * the claim, false if already claimed.
   */
  async markDigested(
    customerId: string,
    productVariantId: string,
    digestRunId: string,
  ): Promise<boolean> {
    const { rows } = await this.tables.exec(
      `INSERT INTO ${DIGEST_LOG_TABLE} (id, customer_id, product_variant_id, digest_run_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (customer_id, product_variant_id, digest_run_id) DO NOTHING
       RETURNING id`,
      [newId(), customerId, productVariantId, digestRunId],
    );
    return rows.length > 0;
  }

  /**
   * ROLL BACK a claim recorded by {@link markDigested}. Used when a send THROWS so the
   * (customer, variant, run) is NOT consumed and the next run retries. Returns true if a
   * claim row was actually removed.
   */
  async unmarkDigested(
    customerId: string,
    productVariantId: string,
    digestRunId: string,
  ): Promise<boolean> {
    const { rows } = await this.tables.exec(
      `DELETE FROM ${DIGEST_LOG_TABLE}
        WHERE customer_id = $1 AND product_variant_id = $2 AND digest_run_id = $3
        RETURNING id`,
      [customerId, productVariantId, digestRunId],
    );
    return rows.length > 0;
  }
}
