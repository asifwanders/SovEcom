/**
 * WebhookDeliveryRepository. The `webhook_deliveries` outbox.
 *
 * `claimDue` is the heart of the worker: it locks due rows (`FOR UPDATE SKIP LOCKED`) and LEASES
 * them by pushing `next_retry_at` forward, so an overlapping run skips them and a crashed run's rows
 * are retried after the lease — no extra "processing" status, no double-deliver.
 */
import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import {
  webhookDeliveries,
  type WebhookDelivery,
  type NewWebhookDelivery,
} from '../database/schema/webhook_deliveries';
import type { DeliveryStatus } from './webhook.types';

export interface DeliveryListResult {
  data: WebhookDelivery[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DeliveryResultPatch {
  status: DeliveryStatus;
  attempts: number;
  responseCode: number | null;
  lastError: string | null;
  nextRetryAt: Date;
}

@Injectable()
export class WebhookDeliveryRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async insertMany(rows: NewWebhookDelivery[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(webhookDeliveries).values(rows);
  }

  /**
   * Cross-process drain serialization. Take a SESSION-level pg advisory lock on a
   * RESERVED connection (so lock + unlock share one socket) without holding a transaction
   * open across the drain's HTTP work. Non-blocking `pg_try_advisory_lock`: a second instance
   * whose drain overlaps simply gets `false` and skips, so a lease-expired-but-still-delivering
   * row is never re-claimed and double-delivered. Returns a release fn, or null if not acquired.
   *
   * The lock key mirrors categories.repository's per-tenant pattern (hashtextextended → bigint)
   * but is GLOBAL (one webhook drain at a time across the cluster).
   */
  async tryDrainLock(): Promise<(() => Promise<void>) | null> {
    const conn = await this.database.session.reserve();
    try {
      // Defensive: a pooled connection handed back by reserve() must start with NO session
      // advisory locks held by us. Clearing first makes the try-lock idempotent even if a
      // prior drain on the SAME physical connection failed to unlock (so a stale lock can
      // never wedge the cluster's webhook drain). Only locks held by THIS session are freed.
      await conn`SELECT pg_advisory_unlock_all()`;
      const rows = (await conn`
        SELECT pg_try_advisory_lock(hashtextextended('webhook:drain', 0)) AS locked
      `) as unknown as Array<{ locked: boolean }>;
      if (!rows[0]?.locked) {
        conn.release();
        return null;
      }
      return async () => {
        try {
          await conn`SELECT pg_advisory_unlock(hashtextextended('webhook:drain', 0))`;
        } finally {
          conn.release();
        }
      };
    } catch (err) {
      conn.release();
      throw err;
    }
  }

  /**
   * Claim up to `limit` due deliveries (`pending`/`failed` with `next_retry_at <= now()`), locking
   * + leasing them in one transaction. Returns the pre-lease rows for processing.
   */
  async claimDue(limit: number, leaseMs: number): Promise<WebhookDelivery[]> {
    return this.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            inArray(webhookDeliveries.status, ['pending', 'failed']),
            lte(webhookDeliveries.nextRetryAt, sql`now()`),
          ),
        )
        .orderBy(asc(webhookDeliveries.nextRetryAt))
        .limit(limit)
        .for('update', { skipLocked: true });

      if (due.length === 0) return [];
      const ids = due.map((d) => d.id);
      const lease = new Date(Date.now() + leaseMs);
      await tx
        .update(webhookDeliveries)
        .set({ nextRetryAt: lease, updatedAt: new Date() })
        .where(inArray(webhookDeliveries.id, ids));
      return due;
    });
  }

  /** Record the outcome of a delivery attempt. */
  async recordResult(id: string, patch: DeliveryResultPatch): Promise<void> {
    await this.db
      .update(webhookDeliveries)
      .set({
        status: patch.status,
        attempts: patch.attempts,
        responseCode: patch.responseCode,
        lastError: patch.lastError,
        nextRetryAt: patch.nextRetryAt,
        lastAttemptAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(webhookDeliveries.id, id));
  }

  async findById(tenantId: string, id: string): Promise<WebhookDelivery | null> {
    const [row] = await this.db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.tenantId, tenantId), eq(webhookDeliveries.id, id)))
      .limit(1);
    return row ?? null;
  }

  /** Admin delivery log: tenant-scoped, optional subscription/status filters, newest first. */
  async list(
    tenantId: string,
    opts: { subscriptionId?: string; status?: DeliveryStatus; page: number; pageSize: number },
  ): Promise<DeliveryListResult> {
    const filters = [eq(webhookDeliveries.tenantId, tenantId)];
    if (opts.subscriptionId)
      filters.push(eq(webhookDeliveries.subscriptionId, opts.subscriptionId));
    if (opts.status) filters.push(eq(webhookDeliveries.status, opts.status));
    const where = and(...filters);

    const [data, totalRows] = await Promise.all([
      this.db
        .select()
        .from(webhookDeliveries)
        .where(where)
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(opts.pageSize)
        .offset((opts.page - 1) * opts.pageSize),
      this.db.select({ value: count() }).from(webhookDeliveries).where(where),
    ]);
    return {
      data,
      total: Number(totalRows[0]?.value ?? 0),
      page: opts.page,
      pageSize: opts.pageSize,
    };
  }

  /**
   * Admin retry-from-failure: reset a `failed`/`exhausted` delivery to `pending`, due now. Status-
   * guarded (only those two states) + tenant-scoped. Returns true iff a row was reset.
   */
  async markForRetry(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .update(webhookDeliveries)
      .set({ status: 'pending', nextRetryAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(webhookDeliveries.tenantId, tenantId),
          eq(webhookDeliveries.id, id),
          inArray(webhookDeliveries.status, ['failed', 'exhausted']),
        ),
      )
      .returning({ id: webhookDeliveries.id });
    return rows.length === 1;
  }
}
