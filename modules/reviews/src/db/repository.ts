/**
 * reviews — the data-access layer over `sdk.tables`.
 *
 * EVERY statement here is PARAMETERIZED — customer ids, product ids, ratings and bodies arrive as
 * bound params ($1, $2, …), never string-concatenated into SQL. The module runs under its own
 * low-privilege DB role (the executor pins search_path to the module schema), so unqualified table
 * names resolve to the module's OWN table and a statement that reached for a core table would be
 * refused by PG.
 *
 * `customer_id` is ALWAYS a bound parameter sourced from the core-verified `req.customer.id` (never
 * client input) — see api/handlers.ts. The PUBLIC read returns ONLY 'approved' rows; moderation
 * (pending/approved/rejected) is enforced in SQL, not in app code that could be bypassed.
 *
 * IMPORTANT (runtime contract): `sdk.tables.exec` reports a row in `rows` only for the rows a
 * statement RETURNED, not the number it affected. So any INSERT/UPDATE whose "did it change a row?"
 * result we care about uses `RETURNING id` and we count the returned rows (a plain UPDATE /
 * `INSERT … ON CONFLICT DO NOTHING` returns 0 rows even when it changed data).
 */
import type { TablesClient } from '@sovecom/module-sdk';
import { REVIEWS_TABLE } from './schema';

/** Default page size for the admin moderation queue. */
export const DEFAULT_QUEUE_LIMIT = 200;
/** Hard ceiling on a single moderation-queue page. */
export const MAX_QUEUE_LIMIT = 500;

/** The moderation lifecycle of a review. */
export type ReviewStatus = 'pending' | 'approved' | 'rejected';

/** A stored review row. */
export interface ReviewRow {
  readonly id: string;
  readonly customer_id: string;
  readonly product_id: string;
  readonly rating: number;
  readonly body: string;
  readonly status: ReviewStatus;
  readonly created_at: string;
}

/** A public-facing review (no customer id — the read surface must not leak who wrote it). */
export interface PublicReview {
  readonly id: string;
  readonly rating: number;
  readonly body: string;
  readonly createdAt: string;
}

/** Aggregate stats for a product, computed from APPROVED reviews only. */
export interface ReviewSummary {
  readonly count: number;
  /** Mean rating over approved reviews, rounded to 2 decimals; null when there are none. */
  readonly average: number | null;
}

/** Generate a row id. `crypto.randomUUID` is available in the Node worker runtime. */
function newId(): string {
  return crypto.randomUUID();
}

/** Coerce a SQL COUNT/AVG that may arrive as a string into a number. */
function toNumber(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0);
}

/** Floor + clamp an (untrusted) integer to [min, max], falling back when it is not finite. */
function clampInt(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  const n = Math.floor(v);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export class ReviewsRepository {
  constructor(private readonly tables: TablesClient) {}

  /**
   * Insert a review for (customer, product). Returns the created row, or `null` when the customer
   * already reviewed this product (UNIQUE(customer_id, product_id) → ON CONFLICT DO NOTHING → no
   * RETURNING row). Callers map the null to a 409 already_reviewed.
   */
  async create(
    customerId: string,
    productId: string,
    rating: number,
    body: string,
    status: ReviewStatus,
  ): Promise<ReviewRow | null> {
    const { rows } = await this.tables.exec(
      `INSERT INTO ${REVIEWS_TABLE} (id, customer_id, product_id, rating, body, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (customer_id, product_id) DO NOTHING
       RETURNING id, customer_id, product_id, rating, body, status, created_at`,
      [newId(), customerId, productId, rating, body, status],
    );
    return (rows[0] as ReviewRow | undefined) ?? null;
  }

  /**
   * Public read: APPROVED reviews for a product PLUS their aggregate, in ONE statement.
   *
   * The review rows and the `{ count, average }` are read from the SAME snapshot via a window
   * aggregate (`COUNT(*) OVER ()`, `AVG(rating) OVER ()`) over the approved set — so a concurrent
   * approval landing between two separate queries can never yield a count/average that disagrees
   * with the returned rows. (The aggregate columns repeat on every row; we read them off the first.)
   */
  async approvedWithSummary(
    productId: string,
  ): Promise<{ reviews: PublicReview[]; summary: ReviewSummary }> {
    const { rows } = await this.tables.query<{
      id: string;
      rating: number | string;
      body: string;
      created_at: string;
      total_count: number | string;
      avg_rating: number | string | null;
    }>(
      `SELECT id, rating, body, created_at,
              COUNT(*) OVER ()::int       AS total_count,
              AVG(rating) OVER ()::float8 AS avg_rating
         FROM ${REVIEWS_TABLE}
        WHERE product_id = $1 AND status = 'approved'
        ORDER BY created_at DESC, id DESC`,
      [productId],
    );

    const reviews: PublicReview[] = rows.map((r) => ({
      id: r.id,
      rating: toNumber(r.rating),
      body: r.body,
      createdAt: r.created_at,
    }));

    // With zero approved rows the query returns no rows at all → count 0, average null.
    const count = rows.length;
    const rawAvg = rows[0]?.avg_rating;
    const average =
      count > 0 && rawAvg !== null && rawAvg !== undefined
        ? Math.round(toNumber(rawAvg) * 100) / 100
        : null;

    return { reviews, summary: { count, average } };
  }

  /**
   * Admin moderation queue: PENDING reviews, oldest first (FIFO moderation), BOUNDED.
   *
   * `limit` caps the page (clamped to [1, MAX_QUEUE_LIMIT]) so a large/spam queue can never return
   * an unbounded result set; `offset` (clamped to >= 0) pages through. Keyset pagination is overkill
   * for a moderation backlog an admin works down, so a simple bounded offset page is used.
   */
  async listPending(limit = DEFAULT_QUEUE_LIMIT, offset = 0): Promise<ReviewRow[]> {
    const safeLimit = clampInt(limit, 1, MAX_QUEUE_LIMIT, DEFAULT_QUEUE_LIMIT);
    const safeOffset = clampInt(offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const { rows } = await this.tables.query<ReviewRow>(
      `SELECT id, customer_id, product_id, rating, body, status, created_at
         FROM ${REVIEWS_TABLE}
        WHERE status = 'pending'
        ORDER BY created_at ASC, id ASC
        LIMIT $1 OFFSET $2`,
      [safeLimit, safeOffset],
    );
    return rows;
  }

  /**
   * Set a review's status. Idempotent: re-approving an already-approved review (or re-rejecting a
   * rejected one) is a no-op that still reports success. Returns true when a row with `id` exists,
   * false when there is no such review (→ 404). Uses RETURNING id so the returned-row count reflects
   * whether the row exists, independent of whether the status value actually changed.
   */
  async setStatus(id: string, status: ReviewStatus): Promise<boolean> {
    const { rows } = await this.tables.exec(
      `UPDATE ${REVIEWS_TABLE} SET status = $2 WHERE id = $1 RETURNING id`,
      [id, status],
    );
    return rows.length > 0;
  }
}
