/**
 * recently-viewed — the data-access layer over `sdk.tables`.
 *
 * EVERY statement here is PARAMETERIZED — viewer keys and product ids arrive as bound params
 * ($1, $2, …), never string-concatenated into SQL. The module runs under its own low-privilege DB
 * role (the executor pins search_path to the module schema), so unqualified table names resolve to
 * the module's OWN table and a statement that reached for a core table would be refused by PG.
 *
 * `viewer_key` is ALWAYS a bound parameter sourced from the resolved viewer identity (the
 * core-verified `req.customer.id` for a logged-in shopper, else the core-verified `req.guestId.id`
 * from the signed sov_guest cookie) — see api/handlers.ts + identity/. Scoping every read/write by
 * `viewer_key` is what makes one viewer unable to see another's history.
 *
 * IMPORTANT (runtime contract): `sdk.tables.exec` reports a row in `rows` only for the rows a
 * statement RETURNED, not the number it affected. The recently-viewed writes/reads do not depend on
 * a returned-row count for correctness — `recordView` upserts and RETURNS the row it wrote, and the
 * read is a plain SELECT — but the convention is kept for clarity.
 */
import type { TablesClient } from '@sovecom/module-sdk';
import { TABLE } from './schema';

/** A stored recently-viewed row. */
export interface ViewRow {
  readonly id: string;
  readonly viewer_key: string;
  readonly product_id: string;
  readonly viewed_at: string;
}

/** Generate a row id. `crypto.randomUUID` is available in the Node worker runtime. */
function newId(): string {
  return crypto.randomUUID();
}

/**
 * Maximum recently-viewed rows kept per viewer. After upserting a view, any rows beyond this
 * cap (oldest by viewed_at) are pruned in the same operation. This bounds table growth even
 * when anonymous bots rotate through many product IDs after receiving a guest cookie.
 */
const MAX_ROWS_PER_VIEWER = 100;

export class RecentlyViewedRepository {
  constructor(private readonly tables: TablesClient) {}

  /**
   * Record (or refresh) a view of `productId` by `viewerKey`. Dedupe + bump: the
   * UNIQUE(viewer_key, product_id) constraint + `ON CONFLICT … DO UPDATE SET viewed_at = now()`
   * means a re-view of the same product never creates a second row — it just moves the existing row
   * to the top of the newest-first read. Returns the upserted row (always present via RETURNING).
   *
   * ROW CAP: after the upsert, rows beyond MAX_ROWS_PER_VIEWER (oldest first) are deleted in
   * the same db round-trip, preventing unbounded table growth from rotating guest bots.
   */
  async recordView(viewerKey: string, productId: string): Promise<ViewRow> {
    const { rows } = await this.tables.exec(
      `INSERT INTO ${TABLE} (id, viewer_key, product_id, viewed_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (viewer_key, product_id)
         DO UPDATE SET viewed_at = now()
       RETURNING id, viewer_key, product_id, viewed_at`,
      [newId(), viewerKey, productId],
    );
    const row = rows[0] as ViewRow | undefined;
    if (!row) {
      // An upsert with RETURNING always yields the row; this guards the type without a non-null !.
      throw new Error('recently-viewed: row vanished immediately after upsert');
    }

    // Prune oldest rows beyond cap, keyed strictly on this viewer.
    await this.tables.exec(
      `DELETE FROM ${TABLE}
       WHERE viewer_key = $1
         AND id NOT IN (
           SELECT id FROM ${TABLE}
            WHERE viewer_key = $1
            ORDER BY viewed_at DESC, id DESC
            LIMIT $2
         )`,
      [viewerKey, MAX_ROWS_PER_VIEWER],
    );

    return row;
  }

  /**
   * The viewer's most-recently-viewed products, newest first, bounded by `limit`. Optionally drops a
   * single `excludeProductId` (e.g. the product the shopper is currently looking at). Scoped to ONE
   * `viewerKey`, so it only ever returns the caller's own history.
   *
   * `limit` is taken pre-clamped from settings (the handler resolves it from `maxItems`). We fetch up
   * to `limit` rows directly in SQL. Category-based exclusion is applied AFTER this read (in the
   * handler) because the module read surface does not expose a product's category — see README
   * "Category exclusion (runtime gap)". To still return up to `limit` items after that post-filter,
   * the handler may pass an OVER-FETCH limit here; this method honours whatever bound it is given.
   */
  async recent(viewerKey: string, limit: number, excludeProductId?: string): Promise<ViewRow[]> {
    if (excludeProductId !== undefined) {
      const { rows } = await this.tables.query<ViewRow>(
        `SELECT id, viewer_key, product_id, viewed_at
           FROM ${TABLE}
          WHERE viewer_key = $1 AND product_id <> $2
          ORDER BY viewed_at DESC, id DESC
          LIMIT $3`,
        [viewerKey, excludeProductId, limit],
      );
      return rows;
    }
    const { rows } = await this.tables.query<ViewRow>(
      `SELECT id, viewer_key, product_id, viewed_at
         FROM ${TABLE}
        WHERE viewer_key = $1
        ORDER BY viewed_at DESC, id DESC
        LIMIT $2`,
      [viewerKey, limit],
    );
    return rows;
  }

  /**
   * Migrate a guest's recently-viewed history to a customer id (idempotent, dedupe-safe).
   *
   * Called after a guest logs in. For each guest row (identified by `guest:<guestId>`):
   *   1. Upsert the row into the customer key space (`cust:<customerId>`). `ON CONFLICT DO UPDATE`
   *      keeps the LATEST viewed_at of the two rows so the newest-first order is preserved.
   *   2. Delete the guest row.
   *
   * Each pair is individually idempotent — a retry after partial failure is safe. The
   * UNIQUE(viewer_key, product_id) constraint prevents duplicates regardless of race conditions.
   * Returns the number of distinct products successfully merged.
   */
  async mergeGuestToCustomer(guestId: string, customerId: string): Promise<number> {
    const guestKey = `guest:${guestId}`;
    const customerKey = `cust:${customerId}`;

    // Fetch all guest rows for this guest viewer key. Cap at 200 to bound the work.
    const { rows: guestRows } = await this.tables.query<ViewRow>(
      `SELECT id, viewer_key, product_id, viewed_at
         FROM ${TABLE}
        WHERE viewer_key = $1
        ORDER BY viewed_at DESC, id DESC
        LIMIT $2`,
      [guestKey, 200],
    );
    if (guestRows.length === 0) return 0;

    let merged = 0;
    for (const row of guestRows) {
      // Upsert into the customer key space. On conflict keep the LATEST viewed_at.
      await this.tables.exec(
        `INSERT INTO ${TABLE} (id, viewer_key, product_id, viewed_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (viewer_key, product_id)
           DO UPDATE SET viewed_at = GREATEST(${TABLE}.viewed_at, EXCLUDED.viewed_at)`,
        [newId(), customerKey, row.product_id, row.viewed_at],
      );
      // Delete the guest row (idempotent — safe to repeat).
      await this.tables.exec(
        `DELETE FROM ${TABLE} WHERE viewer_key = $1 AND product_id = $2 RETURNING id`,
        [guestKey, row.product_id],
      );
      merged++;
    }
    return merged;
  }
}
