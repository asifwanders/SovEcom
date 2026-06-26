/**
 * notify-back-in-stock — the data-access layer over `sdk.tables`.
 *
 * EVERY statement here is PARAMETERIZED — emails and variant ids arrive as bound params ($1, $2, …),
 * never string-concatenated into SQL. The module runs under its own low-privilege DB role (the
 * executor pins search_path to the module schema), so the unqualified, double-quoted table name
 * resolves to the module's OWN table and a statement that reached for a core table would be refused
 * by PG.
 *
 * The subscription is EMAIL-keyed: the endpoint is guest-friendly, so the key is the
 * subscriber-supplied `customer_email`, not a customer id. A verified customer id is recorded when
 * present but never used as the key.
 *
 * IMPORTANT (runtime contract): `sdk.tables.exec` reports `rowCount` as the number of rows the
 * statement RETURNED, not the number it affected. So any INSERT/UPDATE/DELETE whose "did it change a
 * row?" result we care about MUST use `RETURNING id` and we count the returned rows.
 */
import type { TablesClient } from '@sovecom/module-sdk';
import { TABLE } from './schema';

/** A stored subscription row. */
export interface SubscriptionRow {
  readonly id: string;
  readonly customer_email: string;
  readonly product_variant_id: string;
  readonly customer_id: string | null;
  readonly created_at: string;
  readonly notified_at: string | null;
}

/** Generate a row id. `crypto.randomUUID` is available in the Node worker runtime. */
function newId(): string {
  return crypto.randomUUID();
}

export class NotifyRepository {
  constructor(private readonly tables: TablesClient) {}

  /**
   * Subscribe `email` to a restock notification for `productVariantId`. Idempotent on the
   * UNIQUE(customer_email, product_variant_id) key:
   *   - first subscribe inserts a fresh row (`notified_at` NULL);
   *   - a RE-subscribe (same email + variant) does NOT duplicate; instead it RESETS `notified_at`
   *     to NULL (and refreshes the recorded customer_id) so a returning shopper who was already
   *     notified once becomes eligible to be notified again on the NEXT restock.
   * `customerId` is the optional core-verified principal (recorded, never the key).
   */
  async subscribe(
    email: string,
    productVariantId: string,
    customerId: string | null,
  ): Promise<void> {
    await this.tables.exec(
      `INSERT INTO ${TABLE} (id, customer_email, product_variant_id, customer_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (customer_email, product_variant_id)
       DO UPDATE SET notified_at = NULL, customer_id = EXCLUDED.customer_id`,
      [newId(), email, productVariantId, customerId],
    );
  }

  /** Remove a subscription. Returns true if a row was deleted. */
  async unsubscribe(email: string, productVariantId: string): Promise<boolean> {
    const { rows } = await this.tables.exec(
      `DELETE FROM ${TABLE}
         WHERE customer_email = $1 AND product_variant_id = $2 RETURNING id`,
      [email, productVariantId],
    );
    return rows.length > 0;
  }

  /**
   * Pending (not-yet-notified) subscriptions for `productVariantId`, oldest first. The restock
   * runner uses these — only `notified_at IS NULL` rows are eligible. `limit` bounds the result so
   * a single run can respect the per-run batch cap.
   */
  async pendingForVariant(productVariantId: string, limit: number): Promise<SubscriptionRow[]> {
    const { rows } = await this.tables.query<SubscriptionRow>(
      `SELECT id, customer_email, product_variant_id, customer_id, created_at, notified_at
         FROM ${TABLE}
        WHERE product_variant_id = $1 AND notified_at IS NULL
        ORDER BY created_at ASC, id ASC
        LIMIT $2`,
      [productVariantId, limit],
    );
    return rows;
  }

  /**
   * CLAIM a subscription as notified by stamping `notified_at = now()` ONLY while it is still NULL.
   * Recorded BEFORE the email is sent, so it is a reservation against double-sending, not a record
   * that a send succeeded. Idempotent: `RETURNING id` yields a row only when THIS call flipped a
   * NULL → timestamp (0 rows if another run already claimed it). Callers gate the actual email on a
   * `true` return so a re-run / retry never double-sends.
   */
  async markNotified(id: string): Promise<boolean> {
    const { rows } = await this.tables.exec(
      `UPDATE ${TABLE} SET notified_at = now()
         WHERE id = $1 AND notified_at IS NULL RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }
}
