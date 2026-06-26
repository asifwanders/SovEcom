/**
 * ReturnRepository. Tenant-scoped access to `returns`.
 */
import { Injectable } from '@nestjs/common';
import { and, count, desc, eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { returns, type Return, type NewReturn } from '../database/schema/returns';
import type { ReturnStatus } from './return.types';

export interface ReturnListResult {
  data: Return[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class ReturnRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async insert(values: NewReturn): Promise<Return> {
    const [row] = await this.db.insert(returns).values(values).returning();
    return row!;
  }

  /** Load a return by id, tenant-scoped. */
  async findById(tenantId: string, id: string): Promise<Return | null> {
    const [row] = await this.db
      .select()
      .from(returns)
      .where(and(eq(returns.tenantId, tenantId), eq(returns.id, id)))
      .limit(1);
    return row ?? null;
  }

  /** A customer's returns for ONE of their orders (newest first). Tenant + customer scoped. */
  async listForCustomerOrder(
    tenantId: string,
    customerId: string,
    orderId: string,
  ): Promise<Return[]> {
    return this.db
      .select()
      .from(returns)
      .where(
        and(
          eq(returns.tenantId, tenantId),
          eq(returns.customerId, customerId),
          eq(returns.orderId, orderId),
        ),
      )
      .orderBy(desc(returns.createdAt));
  }

  /** Admin queue: tenant-scoped, optional status filter, offset-paginated (newest first). */
  async listForAdmin(
    tenantId: string,
    opts: { status?: ReturnStatus; page: number; pageSize: number },
  ): Promise<ReturnListResult> {
    const where = opts.status
      ? and(eq(returns.tenantId, tenantId), eq(returns.status, opts.status))
      : eq(returns.tenantId, tenantId);
    const [data, totalRows] = await Promise.all([
      this.db
        .select()
        .from(returns)
        .where(where)
        .orderBy(desc(returns.createdAt))
        .limit(opts.pageSize)
        .offset((opts.page - 1) * opts.pageSize),
      this.db.select({ value: count() }).from(returns).where(where),
    ]);
    return {
      data,
      total: Number(totalRows[0]?.value ?? 0),
      page: opts.page,
      pageSize: opts.pageSize,
    };
  }

  /**
   * Compare-and-swap the return status (Fable B1/B2 fix): atomically move `fromStatus → patch.status`
   * ONLY if the row is currently `fromStatus`. Returns true iff THIS call made the change. This is
   * the serialization point for approve/reject — a concurrent/retried approve loses the CAS (0 rows
   * → false → 409) and never reaches the refund, so one return request yields at most one refund.
   */
  async casStatus(
    tenantId: string,
    id: string,
    fromStatus: ReturnStatus,
    patch: {
      status: ReturnStatus;
      refundId?: string | null;
      reason?: string | null;
      resolvedBy?: string | null;
      setResolvedAt?: boolean;
    },
  ): Promise<boolean> {
    const set: Partial<typeof returns.$inferInsert> = { status: patch.status };
    if (patch.refundId !== undefined) set.refundId = patch.refundId;
    if (patch.reason !== undefined) set.reason = patch.reason;
    if (patch.resolvedBy !== undefined) set.resolvedBy = patch.resolvedBy;
    if (patch.setResolvedAt) set.resolvedAt = new Date();
    const rows = await this.db
      .update(returns)
      .set(set)
      .where(
        and(eq(returns.tenantId, tenantId), eq(returns.id, id), eq(returns.status, fromStatus)),
      )
      .returning({ id: returns.id });
    return rows.length === 1;
  }
}
