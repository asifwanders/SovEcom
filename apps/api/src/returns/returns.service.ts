/**
 * ReturnsService — request, approve, or reject returns.
 *
 * REQUEST is customer-driven on their own order (no IDOR — resolved via OrderService.findForCustomer).
 * APPROVE runs RefundService.create for the returned items (full withdrawal → full refund incl.
 * shipping; partial → line refund), restocking the goods, then marks the return `refunded`. The hard
 * no-over-refund guards live in the refund layer (order-locked remaining + per-line re-check),
 * so this layer's item validation is a soft pre-check.
 */
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { OrderService } from '../orders/orders.service';
import { OrderRepository } from '../orders/order.repository';
import { RefundService } from '../payments/refunds/refund.service';
import { ReturnRepository } from './return.repository';
import type { Return } from '../database/schema/returns';
import type { ReturnItem, ReturnStatus, ReturnType } from './return.types';
import type { OrderStatus } from '../orders/order-status';

/** Order states from which a return/refund is possible. */
const RETURNABLE_STATES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'paid',
  'fulfilled',
  'shipped',
  'delivered',
  'partially_refunded',
]);

/** The statutory cooling-off period (Consumer Rights Directive 2011/83/EU). */
const WITHDRAWAL_WINDOW_DAYS = 14;

export interface CreateReturnInput {
  type: ReturnType;
  items: ReturnItem[];
  reason?: string | null;
}

@Injectable()
export class ReturnsService {
  private readonly logger = new Logger(ReturnsService.name);

  constructor(
    private readonly orders: OrderService,
    private readonly orderRepo: OrderRepository,
    private readonly refunds: RefundService,
    private readonly repo: ReturnRepository,
  ) {}

  /**
   * Customer requests a return/withdrawal on THEIR order (no IDOR). Validates the order is
   * returnable + the items belong, computes the 14-day window flag, records a `requested` return.
   */
  async request(
    tenantId: string,
    customerId: string,
    orderId: string,
    input: CreateReturnInput,
  ): Promise<Return> {
    // Ownership + items via the no-IDOR own-order load (404 if not this customer's order).
    const { order, items } = await this.orders.findForCustomer(tenantId, customerId, orderId);

    if (!RETURNABLE_STATES.has(order.status as OrderStatus)) {
      throw new UnprocessableEntityException(
        `Order ${orderId} (${order.status}) is not eligible for a return`,
      );
    }

    // Soft validation: every requested line must belong to the order and not exceed its
    // not-yet-refunded quantity. The HARD guard is RefundService at approve time.
    //
    // AGGREGATE duplicate orderItemId lines (sum quantities) BEFORE the per-line
    // eligibility check, mirroring the `agg` Map in RefundService.computeRefund. Without this,
    // [{X,N},{X,N}] each passed independently while 2N exceeds the remaining quantity, persisting
    // a junk over-quantity `requested` return (the approve-time hard guard blocks the actual
    // over-refund, so no money loss — but this soft pre-check must stay consistent with it).
    const byId = new Map(items.map((i) => [i.id, i]));
    const aggregated = new Map<string, number>();
    for (const line of input.items) {
      aggregated.set(line.orderItemId, (aggregated.get(line.orderItemId) ?? 0) + line.quantity);
    }
    for (const [orderItemId, quantity] of aggregated) {
      const oi = byId.get(orderItemId);
      if (!oi) {
        throw new UnprocessableEntityException(`Order item ${orderItemId} is not on this order`);
      }
      if (quantity > oi.quantity - oi.refundedQuantity) {
        throw new UnprocessableEntityException(
          `Cannot return ${quantity} of item ${oi.id}: only ${
            oi.quantity - oi.refundedQuantity
          } remain`,
        );
      }
    }

    const withinWithdrawalWindow = await this.computeWindow(tenantId, orderId);

    return this.repo.insert({
      tenantId,
      orderId,
      customerId,
      type: input.type,
      status: 'requested',
      items: input.items,
      reason: input.reason ?? null,
      withinWithdrawalWindow,
      requestedAt: new Date(),
    });
  }

  /** The customer's own returns for one of their orders (no IDOR — authorises via the order). */
  async listForCustomerOrder(
    tenantId: string,
    customerId: string,
    orderId: string,
  ): Promise<Return[]> {
    await this.orders.findForCustomer(tenantId, customerId, orderId); // 404 if not theirs
    return this.repo.listForCustomerOrder(tenantId, customerId, orderId);
  }

  /**
   * Admin approves a `requested` return → issues the 2.11 refund (+ credit note + restock) and marks
   * the return `refunded`. Full withdrawal (all lines, full qty, nothing refunded yet) → full refund
   * incl. shipping; otherwise a line refund of the requested items.
   */
  async approve(tenantId: string, returnId: string, actorUserId: string | null): Promise<Return> {
    const ret = await this.repo.findById(tenantId, returnId);
    if (!ret) throw new NotFoundException(`Return ${returnId} not found`);

    // ATOMIC CLAIM (Fable B1/B2): flip requested → approved as a compare-and-swap. A concurrent/
    // retried approve loses this CAS (false) and 409s BEFORE any refund — one return → one refund.
    const claimed = await this.repo.casStatus(tenantId, returnId, 'requested', {
      status: 'approved',
    });
    if (!claimed) {
      throw new ConflictException(`Return ${returnId} is not awaiting approval`);
    }

    const orderItems = await this.orderRepo.itemsForOrder(tenantId, ret.orderId);
    const returnItems = ret.items as ReturnItem[];
    const full = this.isFullReturn(orderItems, returnItems);

    let refund;
    try {
      // a STABLE per-return idempotency key: a retried approve (after the CAS already
      // flipped requested→approved) reuses it, so Stripe collapses retries into ONE refund. One
      // return → one logical refund → one key.
      const idempotencyKey = `return:${returnId}`;
      refund = full
        ? await this.refunds.create(tenantId, ret.orderId, {
            restock: true,
            reason: `Return ${returnId} (full withdrawal)`,
            idempotencyKey,
            actorUserId,
          })
        : await this.refunds.create(tenantId, ret.orderId, {
            items: returnItems.map((i) => ({
              orderItemId: i.orderItemId,
              quantity: i.quantity,
              restock: true,
            })),
            reason: `Return ${returnId}`,
            idempotencyKey,
            actorUserId,
          });
    } catch (err) {
      // The refund did NOT happen → revert the claim so the admin can retry once the cause is
      // fixed (e.g. order became refundable). Only reverts if still 'approved' (idempotent).
      await this.repo
        .casStatus(tenantId, returnId, 'approved', { status: 'requested' })
        .catch(() => {});
      throw err;
    }

    // Refund committed → finalise. If THIS write fails, the row stays 'approved' (NOT re-approvable
    // via the CAS), so the refund is never duplicated — a distinguishable state for reconciliation.
    await this.repo.casStatus(tenantId, returnId, 'approved', {
      status: 'refunded',
      refundId: refund.refundId,
      resolvedBy: actorUserId,
      setResolvedAt: true,
    });
    return (await this.repo.findById(tenantId, returnId))!;
  }

  /** Admin rejects a `requested` return with a reason (audited). CAS-guarded vs a concurrent approve. */
  async reject(
    tenantId: string,
    returnId: string,
    actorUserId: string | null,
    reason: string,
  ): Promise<Return> {
    const ret = await this.repo.findById(tenantId, returnId);
    if (!ret) throw new NotFoundException(`Return ${returnId} not found`);
    const rejected = await this.repo.casStatus(tenantId, returnId, 'requested', {
      status: 'rejected',
      reason,
      resolvedBy: actorUserId,
      setResolvedAt: true,
    });
    if (!rejected) {
      throw new ConflictException(`Return ${returnId} is no longer awaiting a decision`);
    }
    return (await this.repo.findById(tenantId, returnId))!;
  }

  listForAdmin(tenantId: string, opts: { status?: ReturnStatus; page: number; pageSize: number }) {
    return this.repo.listForAdmin(tenantId, opts);
  }

  /**
   * A return is "full" (→ full refund incl. shipping) iff nothing has been refunded yet AND it
   * covers EVERY order line at its full ordered quantity. Otherwise it's a partial line return.
   */
  private isFullReturn(
    orderItems: { id: string; quantity: number }[],
    returnItems: ReturnItem[],
  ): boolean {
    const wanted = new Map<string, number>();
    for (const r of returnItems)
      wanted.set(r.orderItemId, (wanted.get(r.orderItemId) ?? 0) + r.quantity);
    if (wanted.size !== orderItems.length) return false;
    for (const oi of orderItems) {
      if (wanted.get(oi.id) !== oi.quantity) return false;
    }
    return true;
  }

  /**
   * The 14-day withdrawal window flag: from the order's delivery timestamp. If the
   * order is not yet delivered, the window is OPEN (the right hasn't started expiring).
   */
  private async computeWindow(tenantId: string, orderId: string): Promise<boolean> {
    const deliveredAt = await this.orderRepo.getDeliveredAt(tenantId, orderId);
    if (!deliveredAt) return true; // not delivered yet → window not started → open
    const deadline = deliveredAt.getTime() + WITHDRAWAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    return Date.now() <= deadline;
  }
}
