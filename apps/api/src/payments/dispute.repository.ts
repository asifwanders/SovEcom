/**
 * DisputeRepository: persist disputes, keyed by provider dispute id.
 *
 * `upsertByProviderDisputeId` is idempotent (`charge.dispute.*` events for the same dispute
 * update the one row). Tenant + order/payment links come from the resolved payment row, never
 * from untrusted event metadata.
 */
import { Injectable } from '@nestjs/common';
import { and, count, desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { disputes, type Dispute, type NewDispute } from '../database/schema/disputes';
import type { DisputeStatus } from './disputes/dispute.types';

export interface DisputeListResult {
  data: Dispute[];
  total: number;
  page: number;
  pageSize: number;
}

/** The transaction handle drizzle passes to a `.transaction(async (tx) => …)` callback. */
type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

/** Either the base db handle or an open transaction — both expose the query builder. */
type Db = DatabaseService['db'] | Tx;

@Injectable()
export class DisputeRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /** Load a dispute by id, tenant-scoped. */
  async findById(tenantId: string, id: string): Promise<Dispute | null> {
    const [row] = await this.db
      .select()
      .from(disputes)
      .where(and(eq(disputes.tenantId, tenantId), eq(disputes.id, id)))
      .limit(1);
    return row ?? null;
  }

  /** Admin list: tenant-scoped, optional status + order filters, offset-paginated (newest first). */
  async list(
    tenantId: string,
    opts: { status?: DisputeStatus; orderId?: string; page: number; pageSize: number },
  ): Promise<DisputeListResult> {
    const filters = [eq(disputes.tenantId, tenantId)];
    if (opts.status) filters.push(eq(disputes.status, opts.status));
    if (opts.orderId) filters.push(eq(disputes.orderId, opts.orderId));
    const where = and(...filters);

    const [data, totalRows] = await Promise.all([
      this.db
        .select()
        .from(disputes)
        .where(where)
        .orderBy(desc(disputes.createdAt))
        .limit(opts.pageSize)
        .offset((opts.page - 1) * opts.pageSize),
      this.db.select({ value: count() }).from(disputes).where(where),
    ]);
    return {
      data,
      total: Number(totalRows[0]?.value ?? 0),
      page: opts.page,
      pageSize: opts.pageSize,
    };
  }

  /**
   * Insert or update a dispute by its provider dispute id. Returns the persisted row. Accepts a
   * `db`/`tx` so the webhook handler can run the read+upsert+freeze in ONE order-locked tx.
   */
  async upsertByProviderDisputeId(values: NewDispute, db: Db = this.db): Promise<Dispute> {
    const [row] = await db
      .insert(disputes)
      .values(values)
      .onConflictDoUpdate({
        target: disputes.providerDisputeId,
        // PARTIAL unique index (where provider_dispute_id is not null) — repeat the predicate.
        targetWhere: sql`provider_dispute_id is not null`,
        set: {
          status: values.status,
          providerStatus: values.providerStatus,
          reason: values.reason,
          amount: values.amount,
          evidenceDueBy: values.evidenceDueBy,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row!;
  }

  /**
   * Read a dispute by provider dispute id, tenant-scoped. Accepts a `db`/`tx` so the existence
   * check can run under the same order-row lock as the upsert+freeze (closes the freeze TOCTOU).
   */
  async findByProviderDisputeId(
    tenantId: string,
    providerDisputeId: string,
    db: Db = this.db,
  ): Promise<Dispute | null> {
    const [row] = await db
      .select()
      .from(disputes)
      .where(
        and(eq(disputes.tenantId, tenantId), eq(disputes.providerDisputeId, providerDisputeId)),
      )
      .limit(1);
    return row ?? null;
  }
}
