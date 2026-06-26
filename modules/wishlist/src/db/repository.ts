/**
 * wishlist — the data-access layer over `sdk.tables`.
 *
 * EVERY statement here is PARAMETERIZED — customer ids and variant ids arrive as bound params
 * ($1, $2, …), never string-concatenated into SQL. The module runs under its own low-privilege DB
 * role (the executor pins search_path to the module schema), so unqualified table names resolve to
 * the module's OWN tables and a statement that reached for a core table would be refused by PG.
 *
 * `customer_id` is ALWAYS a bound parameter sourced from the core-verified `req.customer.id` (never
 * client input) — see api/handlers.ts. Scoping every read/write/delete by `customer_id` is what
 * makes one customer unable to see or mutate another's items.
 *
 * IMPORTANT (runtime contract): `sdk.tables.exec` reports `rowCount` as the number of rows the
 * statement RETURNED, not the number it affected. So any INSERT/DELETE whose "did it change a row?"
 * result we care about MUST use `RETURNING id` and we count the returned rows. (A plain
 * `DELETE`/`INSERT … ON CONFLICT DO NOTHING` returns 0 rows even when it changed data.)
 */
import type { TablesClient } from '@sovecom/module-sdk';
import { ITEMS_TABLE, DIGEST_LOG_TABLE } from './schema';

/** A stored wishlist row. */
export interface WishlistRow {
  readonly id: string;
  readonly customer_id: string;
  readonly product_variant_id: string;
  readonly created_at: string;
}

/** Generate a row id. `crypto.randomUUID` is available in the Node worker runtime. */
function newId(): string {
  return crypto.randomUUID();
}

export class WishlistRepository {
  constructor(private readonly tables: TablesClient) {}

  /** Count a customer's current items — used to enforce the per-customer cap before inserting. */
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
    // The row must exist after the insert/conflict; this satisfies the type without a non-null !.
    const row = rows[0];
    if (!row) {
      throw new Error('wishlist: row vanished immediately after insert');
    }
    return row;
  }

  /** Remove an item for this customer. Returns true if a row was deleted. */
  async remove(customerId: string, productVariantId: string): Promise<boolean> {
    // RETURNING id so the executor's returned-row count reflects whether a row was actually deleted.
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

  /** Every (customer_id, product_variant_id) wishlisting one of `variantIds` — for the digest. */
  async customersWatching(variantIds: readonly string[]): Promise<WishlistRow[]> {
    if (variantIds.length === 0) return [];
    // Build a parameterized IN-list ($1, $2, …). Values are still bound, never interpolated.
    const placeholders = variantIds.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await this.tables.query<WishlistRow>(
      `SELECT id, customer_id, product_variant_id, created_at
         FROM ${ITEMS_TABLE} WHERE product_variant_id IN (${placeholders})`,
      [...variantIds],
    );
    return rows;
  }

  /**
   * CLAIM (customer, variant) for digest run `digestRunId` — recorded BEFORE the email is sent, so
   * it is a reservation against double-sending, not a record that a send succeeded. Idempotent via
   * UNIQUE(customer_id, product_variant_id, digest_run_id): returns true if THIS call recorded the
   * claim (it had not been claimed in this run before), false if it was already claimed. Callers
   * gate the actual email on a `true` return so a re-run / retry never double-sends.
   */
  async markDigested(
    customerId: string,
    productVariantId: string,
    digestRunId: string,
  ): Promise<boolean> {
    // RETURNING id so the returned-row count is 1 only when THIS call inserted the mark (0 on a
    // conflict, i.e. it was already logged) — that is the idempotency signal.
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
   * ROLL BACK a claim recorded by {@link markDigested} (B3). Used when a send THROWS (an RpcError,
   * not a suppression) so the (customer, variant, run) is NOT consumed and the next run retries.
   * Returns true if a claim row was actually removed. Parameterized; RETURNING id so the executor's
   * returned-row count reflects the delete.
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
