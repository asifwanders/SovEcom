/**
 * recently-viewed — the data-access layer over `sdk.tables`.
 *
 * EVERY statement here is PARAMETERIZED — viewer keys and product ids arrive as bound params
 * ($1, $2, …), never string-concatenated into SQL. The module runs under its own low-privilege DB
 * role (the executor pins search_path to the module schema), so unqualified table names resolve to
 * the module's OWN table and a statement that reached for a core table would be refused by PG.
 *
 * `viewer_key` is ALWAYS a bound parameter sourced from the resolved viewer identity (the
 * core-verified `req.customer.id` for a logged-in shopper, else a high-entropy storefront guest
 * token) — see api/handlers.ts + identity/. Scoping every read/write by `viewer_key` is what makes
 * one viewer unable to see another's history.
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

export class RecentlyViewedRepository {
  constructor(private readonly tables: TablesClient) {}

  /**
   * Record (or refresh) a view of `productId` by `viewerKey`. Dedupe + bump: the
   * UNIQUE(viewer_key, product_id) constraint + `ON CONFLICT … DO UPDATE SET viewed_at = now()`
   * means a re-view of the same product never creates a second row — it just moves the existing row
   * to the top of the newest-first read. Returns the upserted row (always present via RETURNING).
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
}
