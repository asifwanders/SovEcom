/**
 * RefundService: the refund money terminus.
 *
 * `create` runs the WHOLE refund in ONE order-row-locked transaction so money, the credit note, and
 * the order-state change commit or roll back together:
 *   lock order → validate ≤ remaining → call the gateway (Stripe; manual = offline record-only) →
 *   write refund (+ line items) → bump refunded_amount → optional restock → issue credit note →
 *   drive → refunded / partially_refunded. Post-commit: render the credit-note PDF + emit events.
 *
 * Idempotency: the order FOR UPDATE lock serialises refunds; the Stripe idempotency key is the
 * caller-supplied `idempotencyKey`, which is REQUIRED for a gateway refund — stable across
 * retries → Stripe returns the SAME refund → no double charge. There is NO server-derived fallback
 * (a key embedding `refundedBefore` shifts once a prior refund commits, so a retry would mint a
 * SECOND real refund). A post-gateway `provider_refund_id` dedup (409) + the UNIQUE index + the
 * remaining re-check stop a double-record. A gateway failure throws → full rollback.
 */
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { uuidv7 } from 'uuidv7';
import { DatabaseService } from '../../database/database.service';
import { OrderRepository } from '../../orders/order.repository';
import { canTransition, type OrderStatus } from '../../orders/order-status';
import { OrderStatusChangedEvent } from '../../orders/events/order-status-changed.event';
import { InventoryService, type StockFlip } from '../../inventory/inventory.service';
import { ProductStockChangedEvent } from '../../catalog/events/product-stock-changed.event';
import { TenantSettingsService, type TaxMode } from '../../taxes/tenant-settings.service';
import { InvoiceService } from '../../invoices/invoice.service';
import { buildCreditNoteContent, type CreditNoteLineInput } from '../../invoices/invoice-snapshot';
import { AuditService } from '../../audit/audit.service';
import { PaymentRepository } from '../payment.repository';
import { RefundRepository } from './refund.repository';
import { RefundIssuedEvent } from './events/refund-issued.event';
import { PAYMENT_PROVIDER, type PaymentProvider } from '../providers/payment-provider.interface';
import type { Refund } from '../../database/schema/refunds';
import type { Invoice } from '../../database/schema/invoices';
import type { Order } from '../../database/schema/orders';
import type { OrderItem } from '../../database/schema/order_items';

type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

/** One refunded line in a line-level refund request. */
export interface RefundLineRequest {
  orderItemId: string;
  quantity: number;
  restock?: boolean;
}

/** A refund request — exactly one mode: line items, an arbitrary amount, or (neither) full. */
export interface RefundRequest {
  reason?: string | null;
  items?: RefundLineRequest[];
  amount?: number;
  /** Full-refund restock-all flag (line mode uses per-line `restock`). */
  restock?: boolean;
  /**
   * Stable idempotency key — REQUIRED for a gateway (Stripe) refund: retries reuse it → no
   * double refund. Optional in the type only because an `external` (webhook-reconciled) refund skips
   * the gateway entirely; a non-external gateway refund without one is rejected.
   */
  idempotencyKey?: string;
  actorUserId: string | null;
  /**
   * Internal — set by the `charge.refunded` webhook reconciling a GATEWAY-initiated (dashboard)
   * refund. Skips the gateway call (the refund already happened at Stripe) and
   * records it under the supplied `providerRefundId`. Always amount-mode, no restock.
   */
  external?: { providerRefundId: string; status?: string };
}

export interface RefundResult {
  refundId: string;
  amount: number;
  currency: string;
  status: Refund['status'];
  /** Null for a DEFERRED (pending async) refund — the credit note issues on confirmation. */
  creditNoteId: string | null;
  orderStatus: OrderStatus;
}

/** Map a provider refund status onto our coarse refund_status. */
function mapRefundStatus(status: string): Refund['status'] {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'failed' || status === 'canceled') return 'failed';
  return 'pending';
}

/**
 * The IRREVERSIBLE/fiscal side-effects of a refund, stashed on a PENDING async refund so the
 * confirming `refund.updated` succeeded event can REPLAY them exactly. Issuing a credit note
 * (a gapless, immutable fiscal document) and driving the order to refunded are deferred until
 * the money is CONFIRMED, because they cannot be cleanly undone if the bank later rejects it.
 */
interface DeferredRefundPayload {
  /** Credit-note lines (the tax-reversal breakdown) to issue on confirmation. */
  creditLines: CreditNoteLineInput[];
  /** Gross/net/tax of the refund (the credit-note totals). */
  gross: number;
  tax: number;
  /** What to restock once the refund is confirmed (bundle-aware in `restock()`). */
  restock: { variantId: string; quantity: number }[];
  /** The order status to drive to on confirmation, and whether that edge was legal at create time. */
  target: OrderStatus;
  fromStatus: OrderStatus;
  stateChanges: boolean;
  /** Per-line refunded-quantity bumps to BACK OUT if the refund fails (reserved at create). */
  lineItems: { orderItemId: string; quantity: number }[];
  /** Tax-mode context needed to rebuild the credit-note content snapshot. */
  taxMode: TaxMode;
  currency: string;
  taxInclusive: boolean;
  reverseCharge: boolean;
  correctsInvoiceNumber: string | null;
}

@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly orders: OrderRepository,
    private readonly payments: PaymentRepository,
    private readonly refunds: RefundRepository,
    private readonly invoices: InvoiceService,
    private readonly inventory: InventoryService,
    private readonly tenantSettings: TenantSettingsService,
    private readonly events: EventEmitter2,
    private readonly audit: AuditService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async create(tenantId: string, orderId: string, req: RefundRequest): Promise<RefundResult> {
    if (req.items && req.amount !== undefined) {
      throw new UnprocessableEntityException('Provide either line items or an amount, not both');
    }
    const { taxMode } = await this.tenantSettings.getTaxSettings(tenantId);
    const original = await this.resolveOriginalInvoice(tenantId, orderId);

    const result = await this.db.db.transaction(async (tx) => {
      // 1. Lock the order — serialises concurrent refunds.
      const order = await this.orders.findByIdForUpdate(tx, tenantId, orderId);
      if (!order) throw new NotFoundException(`Order ${orderId} not found`);

      const total = order.totalAmount;
      const refundedBefore = order.refundedAmount;
      const remaining = total - refundedBefore;
      if (remaining <= 0) {
        throw new UnprocessableEntityException('Order is already fully refunded');
      }

      // 2. Compute the refund + the credit-note lines (the tax-reversal math).
      const computed = await this.computeRefund(tx, tenantId, order, remaining, req);
      if (computed.gross <= 0) {
        throw new UnprocessableEntityException('Refund amount must be positive');
      }
      if (computed.gross > remaining) {
        throw new UnprocessableEntityException(
          `Refund ${computed.gross} exceeds the refundable remaining ${remaining}`,
        );
      }

      // 3. Determine + VALIDATE the target state BEFORE any money moves. An admin refund on a
      //    non-refundable order (completed/cancelled/refunded) is rejected here, before the gateway
      //    is called. For an EXTERNAL (dashboard) refund the money has already moved at Stripe, so
      //    we record it even if the state can't transition.
      const fromStatus = order.status as OrderStatus;
      const target: OrderStatus =
        refundedBefore + computed.gross >= total ? 'refunded' : 'partially_refunded';
      const stateChanges = canTransition(fromStatus, target);
      if (!stateChanges && !req.external) {
        throw new UnprocessableEntityException(
          `Order ${orderId} (${fromStatus}) cannot be refunded`,
        );
      }

      // 4. The captured payment to refund against.
      const payment = await this.payments.findSucceededPaymentForOrder(tenantId, orderId, tx);
      if (!payment) {
        throw new UnprocessableEntityException('No captured payment to refund');
      }

      // 5. Gateway. Stripe → idempotency-keyed refund (retry-safe); manual → offline record-only;
      //    external (webhook reconciliation) → skip the gateway, the refund already happened.
      const refundId = uuidv7();
      let providerRefundId: string | null = req.external?.providerRefundId ?? null;
      // External (dashboard) refund: trust the webhook-reported status — a SEPA dashboard refund
      // can also arrive `pending` and must DEFER its fiscal effects too. Absent a status, assume
      // succeeded (the legacy charge.refunded path only forwards succeeded refunds).
      let status: Refund['status'] = req.external?.status
        ? mapRefundStatus(req.external.status)
        : 'succeeded';
      if (status === 'failed') {
        // A brand-new refund reported failed: nothing to record (no money moved here).
        throw new ConflictException('Payment provider refund failed');
      }
      if (!req.external && payment.provider === 'stripe' && payment.providerPaymentId) {
        // A STABLE idempotency key is mandatory for a gateway refund. A server-derived fallback
        // that embeds `refundedBefore` SHIFTS once a prior refund commits, so a retry of the SAME
        // logical refund would mint a SECOND real Stripe refund. Requiring a caller-stable key
        // makes retries reuse it (Stripe returns the same refund → the dedup below + the
        // provider_refund_id UNIQUE stop a double record) while two intentionally-distinct refunds
        // carry distinct keys. The admin DTO requires it; internal callers pass a stable per-action
        // key. No silent fallback — refuse rather than risk a double refund.
        if (!req.idempotencyKey) {
          throw new UnprocessableEntityException(
            'A stable idempotencyKey is required to issue a gateway refund',
          );
        }
        const res = await this.provider.createRefund({
          paymentIntentId: payment.providerPaymentId,
          amount: computed.gross,
          currency: order.currency,
          // NEVER forward the free-text reason to Stripe (its `reason` is a strict enum);
          // the operator text lives in `refunds.reason`.
          idempotencyKey: req.idempotencyKey,
        });
        providerRefundId = res.id;
        status = mapRefundStatus(res.status);
        if (status === 'failed') {
          throw new ConflictException('Payment provider refused the refund');
        }
      }

      // 5b. Idempotent retry guard: if this exact gateway refund is already recorded (a client-key
      //     retry returned the same Stripe refund), refuse the duplicate — the first attempt's refund
      //     + credit note stand. The tx rolls back (no second money/record).
      if (providerRefundId) {
        const dup = await this.refunds.findByProviderRefundId(tenantId, providerRefundId, tx);
        if (dup) {
          throw new ConflictException('This refund was already recorded');
        }
      }

      // ASYNC (e.g. SEPA) refunds come back `pending`: the money has NOT moved yet and the bank may
      // still reject it. Issuing a credit note now (gapless, immutable fiscal doc) or driving the
      // order to refunded would be irreversible if it fails. So for a pending refund we RESERVE
      // refunded_amount + refunded_quantity (the over-refund guard still holds) and DEFER the fiscal
      // side-effects, stashing them to replay on the confirming succeeded event. A synchronous
      // (immediately-`succeeded`) refund applies everything inline, as before.
      const deferred = status === 'pending';

      // 6. Record the refund (+ line items).
      const refund = await this.refunds.insert(tx, {
        id: refundId,
        tenantId,
        orderId,
        paymentId: payment.id,
        providerRefundId,
        amount: computed.gross,
        currency: order.currency,
        taxAmount: computed.tax,
        reason: req.reason ?? null,
        restocked: !deferred && computed.restock.length > 0,
        status,
        deferredPayload: deferred
          ? ({
              creditLines: computed.creditLines,
              gross: computed.gross,
              tax: computed.tax,
              restock: computed.restock,
              target,
              fromStatus,
              stateChanges,
              lineItems: computed.lineItems.map((li) => ({
                orderItemId: li.orderItemId,
                quantity: li.quantity,
              })),
              taxMode,
              currency: order.currency,
              taxInclusive: order.taxInclusive,
              reverseCharge: order.reverseCharge,
              correctsInvoiceNumber: original?.invoiceNumber ?? null,
            } satisfies DeferredRefundPayload)
          : null,
        createdBy: req.actorUserId,
      });
      await this.refunds.insertLineItems(
        tx,
        computed.lineItems.map((li) => ({ tenantId, refundId, ...li })),
      );

      // 7. RESERVE refunded_amount + per-line refunded_quantity. Always done — even for a pending
      //    refund — so a concurrent/second refund can't over-refund the same money.
      await this.orders.incrementRefundedAmount(tx, tenantId, orderId, computed.gross);
      for (const li of computed.lineItems) {
        await this.orders.incrementRefundedQuantity(tx, tenantId, li.orderItemId, li.quantity);
      }

      // For a DEFERRED (pending) refund, stop here: no restock, no credit note, no state drive.
      if (deferred) {
        return {
          refundId: refund.id,
          amount: refund.amount,
          currency: refund.currency,
          status: refund.status,
          creditNoteId: null,
          orderStatus: fromStatus,
          fromStatus,
          stateChanged: false,
          stockFlips: [] as StockFlip[],
        };
      }

      // 7b. Restock (bundle-aware) — confirmed money only. Collect availability flips (0 → positive)
      // for POST-COMMIT product.stock_changed emission (observational, boolean-only).
      const stockFlips = await this.restock(tx, tenantId, computed.restock);

      // 8. Issue the credit note (gapless CN series, corrects the original; original untouched).
      const content = buildCreditNoteContent({
        taxMode,
        currency: order.currency,
        taxInclusive: order.taxInclusive,
        reverseCharge: order.reverseCharge,
        lines: computed.creditLines,
        shippingNet: 0,
        shippingTax: 0,
        shippingRate: 0,
        netAmount: computed.gross - computed.tax,
        taxAmount: computed.tax,
        totalAmount: computed.gross,
        correctsInvoiceNumber: original?.invoiceNumber ?? null,
      });
      const creditNote = await this.invoices.issueCreditNote(
        tx,
        tenantId,
        orderId,
        content,
        original,
      );

      // 9. Drive the order state (already locked in this tx) — but ONLY when the edge is legal.
      //    For an external refund on a terminal order, record-only (money + credit note) and
      //    leave the state, logging for reconciliation.
      let orderStatus = fromStatus;
      if (stateChanges) {
        await this.orders.updateStatus(tx, tenantId, orderId, target);
        await this.orders.insertStatusHistory(tx, {
          tenantId,
          orderId,
          fromStatus,
          toStatus: target,
          changedBy: req.actorUserId,
          note: `Refund issued (${computed.gross} ${order.currency})`,
        });
        orderStatus = target;
      } else {
        this.logger.error(
          `Refund recorded for ${fromStatus} order ${orderId} (no legal state change) — reconcile`,
        );
      }

      return {
        refundId: refund.id,
        amount: refund.amount,
        currency: refund.currency,
        status: refund.status,
        creditNoteId: creditNote.id as string | null,
        orderStatus,
        fromStatus,
        stateChanged: stateChanges,
        stockFlips,
      };
    });

    // Post-commit: render the credit-note PDF (best-effort) + emit events.
    if (result.creditNoteId) {
      await this.invoices.renderAndStoreById(tenantId, result.creditNoteId).catch((err) => {
        this.logger.error(`Credit-note PDF render failed for ${result.creditNoteId}`, err);
      });
    }
    // Restock made stock available again → observational product.stock_changed (post-commit).
    this.emitStockFlips(tenantId, result.stockFlips);
    if (result.stateChanged) {
      this.events.emit(
        OrderStatusChangedEvent.eventName(result.orderStatus),
        new OrderStatusChangedEvent(
          tenantId,
          orderId,
          result.fromStatus,
          result.orderStatus,
          req.actorUserId ?? null,
        ),
      );
    }
    // Only a CONFIRMED refund (credit note issued) is "issued"; a deferred pending refund fires
    // refund.issued later, on its confirming succeeded event.
    if (result.creditNoteId) {
      this.events.emit(
        RefundIssuedEvent.EVENT_NAME,
        new RefundIssuedEvent(
          tenantId,
          orderId,
          result.refundId,
          result.amount,
          result.currency,
          result.creditNoteId,
        ),
      );
    }

    return {
      refundId: result.refundId,
      amount: result.amount,
      currency: result.currency,
      status: result.status,
      creditNoteId: result.creditNoteId,
      orderStatus: result.orderStatus,
    };
  }

  /**
   * The ORIGINAL invoice the credit note must correct. A paid order should always have one (issued
   * on `order.paid`), but invoice issuance is a best-effort async listener that swallows errors,
   * so it can be missing — and a credit note minted without it carries EMPTY {} seller/buyer
   * snapshots (no fiscal identity) + no corrects-link, and is trigger-immutable. So when it is
   * absent we ISSUE IT FIRST (idempotently — `issueForOrder` no-ops if a concurrent issuer won),
   * giving the credit note real mandatory mentions + a corrects-link. If issuance itself fails
   * (e.g. the order is no longer `paid`), we log and return null; `issueCreditNote` then
   * RECONSTRUCTS the identity from the order rather than persisting an empty fiscal doc.
   */
  private async resolveOriginalInvoice(tenantId: string, orderId: string): Promise<Invoice | null> {
    const existing = await this.invoices.findOriginalInvoice(tenantId, orderId);
    if (existing) return existing;
    try {
      const { invoice } = await this.invoices.issueForOrder(tenantId, orderId);
      this.logger.warn(`Order ${orderId} had no invoice — issued ${invoice.invoiceNumber} for the credit note`); // prettier-ignore
      return invoice;
    } catch (err) {
      this.logger.error(
        `No original invoice for order ${orderId} and back-issue failed — credit note will reconstruct identity from the order`,
        err,
      );
      return null;
    }
  }

  /**
   * Reconcile a GATEWAY-initiated (Stripe-dashboard) refund from the `charge.refunded` webhook.
   * Idempotent on `provider_refund_id`: if we already recorded this refund (an admin-initiated one,
   * or a prior webhook), it's a no-op. Otherwise records it as an external, amount-mode refund
   * (proportional tax, no restock) + a credit note + order state. An amount-over-remaining
   * (already covered) is logged and skipped, not failed.
   */
  async reconcileGatewayRefund(
    tenantId: string,
    orderId: string,
    providerRefundId: string,
    amount: number,
    providerStatus?: string,
  ): Promise<void> {
    const existing = await this.refunds.findByProviderRefundId(tenantId, providerRefundId);
    if (existing) {
      // Already recorded (admin-initiated or a prior webhook) — reconcile its status from the event.
      // A PENDING async (SEPA) refund deferred its fiscal side-effects; the confirming event now
      // drives them:
      //   - succeeded → APPLY the deferred credit note + restock + order drive (exactly once);
      //   - failed/canceled → BACK OUT the reserved refunded_amount/quantity, mark it failed.
      if (providerStatus) {
        const mapped = mapRefundStatus(providerStatus);
        if (mapped === 'succeeded' && existing.status === 'pending') {
          await this.applyDeferredRefund(tenantId, existing.id);
        } else if (mapped === 'failed' && existing.status !== 'failed') {
          await this.backOutFailedRefund(tenantId, existing.id);
        } else if (mapped !== existing.status && mapped !== 'failed') {
          await this.refunds.updateStatus(tenantId, existing.id, mapped);
        }
      }
      return;
    }
    try {
      await this.create(tenantId, orderId, {
        amount,
        external: { providerRefundId, status: providerStatus },
        actorUserId: null,
      });
      // A gateway-initiated (Stripe-dashboard) refund mutates order state, issues a credit note,
      // restocks, emails and fires webhooks under actorUserId:null, but `create` writes NO
      // audit_log row (the payment_events dedup ledger is NOT a substitute — the audit query/export
      // API reads only audit_log). Record a system-actor entry so the gateway refund leaves a trail.
      await this.audit.record({
        tenantId,
        actorType: 'system',
        action: 'order.refunded.gateway',
        resourceType: 'order',
        resourceId: orderId,
        changes: { providerRefundId, amount, providerStatus },
      });
    } catch (err) {
      // Already covered (amount over remaining) / duplicate (concurrent record) → not money lost.
      if (err instanceof UnprocessableEntityException || err instanceof ConflictException) {
        this.logger.warn(`Gateway refund ${providerRefundId} not recorded: ${err.message}`);
        return;
      }
      // Soft-deleted/missing order (NotFound) — do NOT rethrow (a 500 makes Stripe retry forever,
      // a poison event). Surface LOUDLY for manual reconciliation instead.
      if (err instanceof NotFoundException) {
        this.logger.error(
          `Gateway refund ${providerRefundId}: order ${orderId} missing — reconcile`,
        );
        return;
      }
      throw err;
    }
  }

  /**
   * A PENDING async refund is now CONFIRMED succeeded: REPLAY the deferred fiscal side-effects
   * exactly once, in ONE order-locked transaction (issue the credit note, restock, drive the order
   * state), then mark the refund succeeded and clear the payload. Idempotent: if the payload is
   * already cleared (a duplicate succeeded event), it is a no-op.
   */
  private async applyDeferredRefund(tenantId: string, refundId: string): Promise<void> {
    const settled = await this.db.db.transaction(async (tx) => {
      const refund = await this.refunds.findById(tenantId, refundId, tx);
      if (!refund || refund.status !== 'pending' || refund.deferredPayload == null) {
        return null; // already settled / not deferred → idempotent no-op.
      }
      const p = refund.deferredPayload as unknown as DeferredRefundPayload;
      const orderId = refund.orderId;
      // Lock the order — the deferred effects mutate its state/stock alongside the credit note.
      const order = await this.orders.findByIdForUpdate(tx, tenantId, orderId);
      if (!order) {
        this.logger.error(`Deferred refund ${refundId}: order ${orderId} missing — reconcile`);
        return null;
      }

      // Restock (bundle-aware) the planned quantities. Collect flips for POST-COMMIT emission.
      const stockFlips = await this.restock(tx, tenantId, p.restock);

      // Issue the credit note (gapless CN series, corrects the original; original untouched).
      const original = await this.resolveOriginalInvoice(tenantId, orderId);
      const content = buildCreditNoteContent({
        taxMode: p.taxMode,
        currency: p.currency,
        taxInclusive: p.taxInclusive,
        reverseCharge: p.reverseCharge,
        lines: p.creditLines,
        shippingNet: 0,
        shippingTax: 0,
        shippingRate: 0,
        netAmount: p.gross - p.tax,
        taxAmount: p.tax,
        totalAmount: p.gross,
        correctsInvoiceNumber: original?.invoiceNumber ?? p.correctsInvoiceNumber ?? null,
      });
      const creditNote = await this.invoices.issueCreditNote(tx, tenantId, orderId, content, original); // prettier-ignore

      // Drive the order state — only when the edge is (still) legal (it was validated at create).
      const fromStatus = order.status as OrderStatus;
      let orderStatus = fromStatus;
      if (p.stateChanges && canTransition(fromStatus, p.target)) {
        await this.orders.updateStatus(tx, tenantId, orderId, p.target);
        await this.orders.insertStatusHistory(tx, {
          tenantId,
          orderId,
          fromStatus,
          toStatus: p.target,
          changedBy: null,
          note: `Async refund confirmed (${p.gross} ${p.currency})`,
        });
        orderStatus = p.target;
      }

      // Mark succeeded + record the restock flag + clear the payload (so a duplicate event no-ops).
      await this.refunds.settleDeferred(tx, tenantId, refundId, 'succeeded', p.restock.length > 0);
      return {
        orderId,
        creditNoteId: creditNote.id,
        fromStatus,
        orderStatus,
        amount: p.gross,
        currency: p.currency,
        stateChanged: orderStatus !== fromStatus,
        stockFlips,
      };
    });

    if (!settled) return;
    // Post-commit: render the credit-note PDF (best-effort) + emit events.
    await this.invoices.renderAndStoreById(tenantId, settled.creditNoteId).catch((err) => {
      this.logger.error(`Credit-note PDF render failed for ${settled.creditNoteId}`, err);
    });
    // Deferred restock made stock available again → observational product.stock_changed.
    this.emitStockFlips(tenantId, settled.stockFlips);
    if (settled.stateChanged) {
      this.events.emit(
        OrderStatusChangedEvent.eventName(settled.orderStatus),
        new OrderStatusChangedEvent(
          tenantId,
          settled.orderId,
          settled.fromStatus,
          settled.orderStatus,
          null,
        ),
      );
    }
    this.events.emit(
      RefundIssuedEvent.EVENT_NAME,
      new RefundIssuedEvent(
        tenantId,
        settled.orderId,
        refundId,
        settled.amount,
        settled.currency,
        settled.creditNoteId,
      ),
    );
  }

  /**
   * A PENDING async refund was REJECTED by the gateway: BACK OUT the optimistic reservation in
   * ONE order-locked transaction (decrement refunded_amount + per-line refunded_quantity, clamped
   * ≥ 0), mark the refund failed, and clear the payload. NO credit note was ever issued and the
   * order was never driven, so there is nothing fiscal to reverse. Idempotent: a refund already
   * `failed` (payload cleared) is a no-op.
   */
  private async backOutFailedRefund(tenantId: string, refundId: string): Promise<void> {
    await this.db.db.transaction(async (tx) => {
      const refund = await this.refunds.findById(tenantId, refundId, tx);
      if (!refund || refund.status === 'failed') return; // idempotent.
      // Only a DEFERRED (pending, never-applied) refund can be cleanly backed out here. A refund
      // that already applied its fiscal effects must NOT be silently reversed — surface it.
      if (refund.status !== 'pending' || refund.deferredPayload == null) {
        this.logger.error(
          `Refund ${refundId} reported failed but is ${refund.status} (already applied) — reconcile manually`,
        );
        return;
      }
      const p = refund.deferredPayload as unknown as DeferredRefundPayload;
      await this.orders.findByIdForUpdate(tx, tenantId, refund.orderId); // lock the order row.
      await this.orders.decrementRefundedAmount(tx, tenantId, refund.orderId, p.gross);
      for (const li of p.lineItems) {
        await this.orders.decrementRefundedQuantity(tx, tenantId, li.orderItemId, li.quantity);
      }
      await this.refunds.settleDeferred(tx, tenantId, refundId, 'failed');
      this.logger.warn(
        `Async refund ${refundId} failed at the gateway — reservation of ${p.gross} ${p.currency} backed out`,
      );
    });
  }

  /** Compute gross/net/tax + credit lines + restock plan for the chosen refund mode. */
  private async computeRefund(
    tx: Tx,
    tenantId: string,
    order: Order,
    remaining: number,
    req: RefundRequest,
  ): Promise<{
    gross: number;
    tax: number;
    creditLines: CreditNoteLineInput[];
    lineItems: { orderItemId: string; quantity: number; amount: number }[];
    restock: { variantId: string; quantity: number }[];
  }> {
    // ── LINE mode ──
    if (req.items && req.items.length > 0) {
      // Aggregate duplicate orderItemId entries in ONE request — sum quantities, and restock the
      // line if ANY of its entries asked to. Prevents bypassing the per-line guard.
      const agg = new Map<string, { quantity: number; restock: boolean }>();
      for (const reqLine of req.items) {
        if (!Number.isInteger(reqLine.quantity) || reqLine.quantity <= 0) {
          throw new UnprocessableEntityException('Refund line quantity must be a positive integer');
        }
        const cur = agg.get(reqLine.orderItemId) ?? { quantity: 0, restock: false };
        cur.quantity += reqLine.quantity;
        cur.restock = cur.restock || reqLine.restock === true;
        agg.set(reqLine.orderItemId, cur);
      }
      const itemRows = await this.orders.getOrderItemsByIds(tx, tenantId, order.id, [
        ...agg.keys(),
      ]);
      const byId = new Map(itemRows.map((r) => [r.id, r]));

      let gross = 0;
      let tax = 0;
      const creditLines: CreditNoteLineInput[] = [];
      const lineItems: { orderItemId: string; quantity: number; amount: number }[] = [];
      const restock: { variantId: string; quantity: number }[] = [];

      for (const [orderItemId, a] of agg) {
        const item = byId.get(orderItemId);
        if (!item) {
          throw new UnprocessableEntityException(`Order item ${orderItemId} is not on this order`);
        }
        const alreadyQty = await this.refunds.sumRefundedQtyForOrderItem(tx, tenantId, item.id);
        if (alreadyQty + a.quantity > item.quantity) {
          throw new UnprocessableEntityException(
            `Cannot refund ${a.quantity} of order item ${item.id}: only ${
              item.quantity - alreadyQty
            } remain`,
          );
        }
        // Cumulative-remainder rounding: the amount for units (alreadyQty, alreadyQty+q] is
        // cum(after) − cum(before), so Σ across all units == the line's exact gross/tax — no
        // independent-rounding drift that could over-refund the line or over-reverse its VAT.
        const { lineGross, lineTax } = this.lineRefundAmounts(item, alreadyQty, a.quantity);
        const lineNet = lineGross - lineTax;
        gross += lineGross;
        tax += lineTax;
        lineItems.push({ orderItemId: item.id, quantity: a.quantity, amount: lineGross });
        creditLines.push({
          description: item.variantTitle
            ? `${item.productTitle} — ${item.variantTitle}`
            : item.productTitle,
          sku: item.sku,
          quantity: a.quantity,
          netAmount: lineNet,
          taxRate: Number(item.taxRate),
          taxAmount: lineTax,
        });
        if (a.restock && item.variantId) {
          restock.push({ variantId: item.variantId, quantity: a.quantity });
        }
      }
      return { gross, tax, creditLines, lineItems, restock };
    }

    // ── PARTIAL-AMOUNT mode ──
    if (req.amount !== undefined) {
      if (!Number.isInteger(req.amount) || req.amount <= 0) {
        throw new UnprocessableEntityException('Refund amount must be a positive integer');
      }
      const gross = req.amount;
      // Proportional tax, CLAMPED so Σ reversed tax can never exceed the order's VAT.
      const alreadyTax = await this.refunds.sumRefundedTax(tx, tenantId, order.id);
      const rawTax =
        order.totalAmount > 0 ? Math.round((gross * order.taxAmount) / order.totalAmount) : 0;
      const tax = Math.max(0, Math.min(rawTax, order.taxAmount - alreadyTax));
      return {
        gross,
        tax,
        creditLines: [this.synthLine('Partial refund', gross, tax)],
        lineItems: [],
        restock: [],
      };
    }

    // ── FULL mode (refund the remaining) ──
    const gross = remaining;
    const alreadyTax = await this.refunds.sumRefundedTax(tx, tenantId, order.id);
    const tax = Math.max(0, Math.min(order.taxAmount - alreadyTax, gross));
    const restock: { variantId: string; quantity: number }[] = [];
    if (req.restock) {
      // Restock only the NOT-yet-refunded quantity per line — never double-restock units a prior
      // line refund already returned.
      const items = await this.orders.itemsForOrder(tenantId, order.id);
      for (const it of items) {
        if (!it.variantId) continue;
        const alreadyQ = await this.refunds.sumRefundedQtyForOrderItem(tx, tenantId, it.id);
        const remainingQ = it.quantity - alreadyQ;
        if (remainingQ > 0) restock.push({ variantId: it.variantId, quantity: remainingQ });
      }
    }
    return {
      gross,
      tax,
      creditLines: [this.synthLine('Order refund (full remaining)', gross, tax)],
      lineItems: [],
      restock,
    };
  }

  /**
   * Gross + tax to refund for units (`alreadyQty`, `alreadyQty + qty`] of an order item, via
   * CUMULATIVE-remainder rounding so Σ over all Q units == the line's exact paid gross/tax (no
   * over-refund / over-reversal). `line_total_amount` is the GROSS the customer paid for the line
   * in BOTH tax modes (order-snapshot.ts: net + (exclusive ? tax : 0), and inclusive net IS the
   * gross goods) — so grossPaid is `line_total_amount` UNCONDITIONALLY.
   */
  private lineRefundAmounts(
    item: OrderItem,
    alreadyQty: number,
    qty: number,
  ): { lineGross: number; lineTax: number } {
    const Q = item.quantity;
    const grossPaid = item.lineTotalAmount;
    const cumGross = (n: number) => Math.round((grossPaid * n) / Q);
    const cumTax = (n: number) => Math.round((item.taxAmount * n) / Q);
    return {
      lineGross: cumGross(alreadyQty + qty) - cumGross(alreadyQty),
      lineTax: cumTax(alreadyQty + qty) - cumTax(alreadyQty),
    };
  }

  /** A single synthetic credit-note line for amount-only / full refunds. */
  private synthLine(description: string, gross: number, tax: number): CreditNoteLineInput {
    const net = gross - tax;
    return {
      description,
      sku: '-',
      quantity: 1,
      netAmount: net,
      taxRate: net > 0 ? tax / net : 0,
      taxAmount: tax,
    };
  }

  /**
   * Restock the refunded quantities (bundle parent → its components), inside the refund tx.
   * Returns the availability flips (0 → positive) for POST-COMMIT `product.stock_changed` emission.
   * Restock is a pure increment, so any flip is back-IN-stock (available:true).
   */
  private async restock(
    tx: Tx,
    tenantId: string,
    toRestock: { variantId: string; quantity: number }[],
  ): Promise<StockFlip[]> {
    if (toRestock.length === 0) return [];
    const flips: StockFlip[] = [];
    const variantIds = toRestock.map((r) => r.variantId);
    const meta = await this.orders.loadVariantsForSnapshot(tx, tenantId, variantIds);
    const sorted = [...toRestock].sort((a, b) => (a.variantId < b.variantId ? -1 : 1));
    for (const r of sorted) {
      const m = meta.get(r.variantId);
      if (m?.isBundle) {
        const components = await this.orders.loadBundleComponents(tx, tenantId, m.productId);
        for (const c of [...components].sort((a, b) => (a.variantId < b.variantId ? -1 : 1))) {
          const flip = await this.inventory.restockInTx(
            tx,
            tenantId,
            c.variantId,
            c.quantity * r.quantity,
          );
          if (flip) flips.push(flip);
        }
      } else {
        const flip = await this.inventory.restockInTx(tx, tenantId, r.variantId, r.quantity);
        if (flip) flips.push(flip);
      }
    }
    return flips;
  }

  /**
   * Emit `product.stock_changed{available:true}` for each restock flip, POST-COMMIT only.
   * Boolean-only; observational. A subscribed back-in-stock notifier reacts to the transition.
   *
   * Best-effort: the whole fan-out is try/caught so a bus-dispatch error can NEVER turn an
   * already-committed refund into a 500 (the refund stands; the missed signal is logged).
   */
  private emitStockFlips(tenantId: string, flips: readonly StockFlip[]): void {
    try {
      for (const f of flips) {
        this.events.emit(
          ProductStockChangedEvent.EVENT,
          new ProductStockChangedEvent(tenantId, f.productId, f.variantId, f.available),
        );
      }
    } catch (err) {
      this.logger.error('product.stock_changed emit failed (refund already committed)', err);
    }
  }
}
