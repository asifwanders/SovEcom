/**
 * RefundRepository. Tenant-scoped access to `refunds` + `refund_line_items`.
 * Mutations take an explicit `tx` so a refund records atomically with the credit note + order state.
 */
import { Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { refunds, type Refund, type NewRefund } from '../../database/schema/refunds';
import { refundLineItems, type NewRefundLineItem } from '../../database/schema/refund_line_items';

type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];
type Db = DatabaseService['db'] | Tx;

@Injectable()
export class RefundRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async insert(tx: Tx, values: NewRefund): Promise<Refund> {
    const [row] = await tx.insert(refunds).values(values).returning();
    return row!;
  }

  async insertLineItems(tx: Tx, values: NewRefundLineItem[]): Promise<void> {
    if (values.length === 0) return;
    await tx.insert(refundLineItems).values(values);
  }

  /** Load a refund by id, tenant-scoped. */
  async findById(tenantId: string, id: string, db: Db = this.db): Promise<Refund | null> {
    const [row] = await db
      .select()
      .from(refunds)
      .where(and(eq(refunds.tenantId, tenantId), eq(refunds.id, id)))
      .limit(1);
    return row ?? null;
  }

  /** Look up a refund by its provider refund id (idempotency for dashboard-vs-admin). Tenant-scoped. */
  async findByProviderRefundId(
    tenantId: string,
    providerRefundId: string,
    db: Db = this.db,
  ): Promise<Refund | null> {
    const [row] = await db
      .select()
      .from(refunds)
      .where(and(eq(refunds.tenantId, tenantId), eq(refunds.providerRefundId, providerRefundId)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Σ tax already reversed for an order — counts every NON-FAILED refund (`pending` SEPA refunds
   * included), matching what `orders.refunded_amount` tracks. Using only `succeeded` would let a
   * full refund re-reverse a pending refund's VAT → Σ reversed tax > order.tax.
   */
  async sumRefundedTax(tx: Tx, tenantId: string, orderId: string): Promise<number> {
    const [row] = await tx
      .select({ sum: sql<number>`coalesce(sum(${refunds.taxAmount}), 0)::int` })
      .from(refunds)
      .where(
        and(
          eq(refunds.tenantId, tenantId),
          eq(refunds.orderId, orderId),
          ne(refunds.status, 'failed'),
        ),
      );
    return Number(row?.sum ?? 0);
  }

  /** Σ quantity already refunded for one order_item (prevents over-refunding a line). Tenant-scoped. */
  async sumRefundedQtyForOrderItem(tx: Tx, tenantId: string, orderItemId: string): Promise<number> {
    const [row] = await tx
      .select({ sum: sql<number>`coalesce(sum(${refundLineItems.quantity}), 0)::int` })
      .from(refundLineItems)
      .where(
        and(eq(refundLineItems.tenantId, tenantId), eq(refundLineItems.orderItemId, orderItemId)),
      );
    return Number(row?.sum ?? 0);
  }

  /** Flip a refund's status (webhook confirmation). Tenant-scoped. */
  async updateStatus(
    tenantId: string,
    id: string,
    status: Refund['status'],
    db: Db = this.db,
  ): Promise<void> {
    await db
      .update(refunds)
      .set({ status })
      .where(and(eq(refunds.id, id), eq(refunds.tenantId, tenantId)));
  }

  /**
   * Settle a DEFERRED (pending async) refund: set the final status and CLEAR the deferred payload
   * (its side-effects have now been applied or backed out). Done inside the order-locked tx so the
   * settle commits atomically with the credit note / back-out. Tenant-scoped.
   */
  async settleDeferred(
    tx: Tx,
    tenantId: string,
    id: string,
    status: Refund['status'],
    restocked?: boolean,
  ): Promise<void> {
    await tx
      .update(refunds)
      .set({ status, deferredPayload: null, ...(restocked !== undefined ? { restocked } : {}) })
      .where(and(eq(refunds.id, id), eq(refunds.tenantId, tenantId)));
  }
}
