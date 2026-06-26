/**
 * InvoiceService: legal invoice issuance + delivery.
 *
 * MONEY/LEGAL-CRITICAL. Triggered by `order.paid` (the listener). Responsibilities:
 *
 *  1. ISSUE (idempotent, gapless, immutable) — `issueForOrder`:
 *     - at most ONE non-credit-note invoice per order (pre-check + partial unique index);
 *     - in ONE tx: allocate the gapless number under the counter row lock, build the
 *       regime-branched snapshots, insert the invoice (storage_key null); commit;
 *     - a rolled-back tx consumes NO number (gapless) and creates no row.
 *  2. RENDER (post-commit, best-effort) — render the PDF from the SNAPSHOT, store it, and
 *     attach the storage_key (the one mutation the immutability trigger permits). A render/
 *     store failure leaves storage_key null — the invoice is still validly issued; downloads
 *     render on demand from the snapshot.
 *  3. DELIVER — `getInvoicePdfForOrder`: stream the stored PDF, or render on demand from the
 *     snapshot when storage_key is null.
 *
 * The number FORMAT is a sensible default (zero-padded, year-prefixed) and the SERIES is a
 * single continuous `STD` per tenant. The exact legal series/format may be refined per
 * jurisdiction requirements.
 */
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';
import { TenantSettingsService } from '../taxes/tenant-settings.service';
import { tenants } from '../database/schema/_tenants';
import { eq } from 'drizzle-orm';
import type { Invoice } from '../database/schema/invoices';
import type { Order } from '../database/schema/orders';
import type { OrderItem } from '../database/schema/order_items';
import { InvoiceRepository } from './invoice.repository';
import {
  buildInvoiceContent,
  type BuyerSnapshot,
  type InvoiceAddress,
  type InvoiceContent,
  type OrderForInvoice,
  type OrderItemForInvoice,
  type SellerIdentity,
  type SellerSnapshot,
} from './invoice-snapshot';
import { renderInvoicePdf, type InvoicePdfHeader } from './invoice-pdf';

/** The single default series for v1. */
export const DEFAULT_SERIES = 'STD';

/** The credit-note series: its own gapless `invoice_counters` row. */
export const CREDIT_NOTE_SERIES = 'CN';

/** The transaction handle drizzle passes to `.transaction(async (tx) => …)`. */
type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

/** The result of an issuance attempt. */
export interface IssueResult {
  invoice: Invoice;
  /** False when an invoice already existed (idempotent no-op). */
  created: boolean;
}

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly repo: InvoiceRepository,
    private readonly storage: StorageService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  /**
   * Issue the legal invoice for a paid order, then render its PDF (post-commit).
   * IDEMPOTENT: a re-emitted/retried `order.paid` returns the existing invoice without
   * issuing a second one or consuming a second number.
   */
  async issueForOrder(tenantId: string, orderId: string): Promise<IssueResult> {
    // Cheap pre-check (the partial unique index is the race-proof backstop).
    const existing = await this.repo.findInvoiceForOrder(this.db.db, tenantId, orderId);
    if (existing) {
      return { invoice: existing, created: false };
    }

    const order = await this.repo.loadOrder(this.db.db, tenantId, orderId);
    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }
    // Gate on the TRUE invariant (money captured), not a strict `=== 'paid'`
    // whitelist. `order.paid` is emitted post-commit async; a paid order can legally
    // transition to fulfilled/shipped/delivered/completed/refunded/partially_refunded
    // before this one-shot listener runs. A strict `=== 'paid'` check would then refuse
    // and the event is lost → a paid order with no invoice. Refuse ONLY a pre-payment
    // status (money not captured); allow paid + every post-paid status.
    const PRE_PAYMENT_STATUSES = new Set(['pending_payment']);
    if (PRE_PAYMENT_STATUSES.has(order.status)) {
      throw new ConflictException(
        `Order ${orderId} payment is not captured (status=${order.status}); refusing to issue an invoice`,
      );
    }
    const items = await this.repo.loadOrderItems(this.db.db, tenantId, orderId);

    // Snapshot the tax mode + seller identity AT ISSUANCE (later changes never apply).
    const { taxMode } = await this.tenantSettings.getTaxSettings(tenantId);
    const seller = await this.loadSellerIdentity(tenantId, taxMode);

    // Reverse-charge invoices must carry the legally-relevant VIES consultation reference.
    // The order schema has no VIES column (orders.ts: vat_number + reverse_charge only), so
    // the ref is sourced AT ISSUANCE from the customer's immutable VIES evidence
    // (customers.metadata.vat.consultationRef). A guest order (no customerId) or a
    // non-reverse-charge order → null. NOTE: snapshotting this ref onto the order at
    // creation time would be ideal (so the invoice stays a pure order snapshot);
    // doing so is a follow-up — we do NOT change the order schema / createFromCart here.
    const viesConsultationRef = await this.resolveViesConsultationRef(tenantId, order);

    const content = buildInvoiceContent(
      taxMode,
      this.toOrderForInvoice(order, viesConsultationRef),
      items.map((i) => this.toItemForInvoice(i)),
      seller,
    );
    const sellerSnapshot = this.toSellerSnapshot(seller, taxMode);
    const buyerSnapshot = this.toBuyerSnapshot(order);

    let invoice: Invoice;
    let created: boolean;
    try {
      const result = await this.db.db.transaction(async (tx) => {
        // Re-check inside the tx (a concurrent issuer may have committed since the pre-check).
        const inTx = await this.repo.findInvoiceForOrder(tx, tenantId, orderId);
        if (inTx) return { row: inTx, fresh: false };

        const number = await this.repo.allocateGaplessNumber(tx, tenantId, DEFAULT_SERIES);
        const issuedAt = new Date();
        const row = await this.repo.insertInvoice(tx, {
          tenantId,
          orderId,
          type: 'invoice',
          series: DEFAULT_SERIES,
          invoiceNumber: this.formatNumber(number, issuedAt),
          issuedAt,
          sellerSnapshot,
          buyerSnapshot,
          currency: order.currency,
          subtotalAmount: content.subtotalAmount,
          taxBreakdown: content as unknown as Record<string, unknown>,
          taxAmount: content.taxAmount,
          totalAmount: content.totalAmount,
          reverseCharge: content.reverseCharge,
          viesConsultationRef: content.viesConsultationRef,
          storageKey: null,
        });
        return { row, fresh: true };
      });
      invoice = result.row;
      created = result.fresh;
    } catch (err) {
      // A concurrent issuer won the partial-unique-index race → return their invoice.
      const raced = await this.repo.findInvoiceForOrder(this.db.db, tenantId, orderId);
      if (raced) return { invoice: raced, created: false };
      throw err;
    }

    // Render + store the PDF post-commit (best-effort; a failure leaves storage_key null).
    if (created && invoice.storageKey === null) {
      await this.renderAndStore(tenantId, invoice, content, sellerSnapshot, buyerSnapshot, order);
    }

    return { invoice, created };
  }

  /**
   * Issue a CREDIT NOTE inside the caller's refund transaction. Allocates
   * a gapless number in the SEPARATE `CN` series, links `corrects_invoice_id` → the order's original
   * invoice (whose seller/buyer snapshots it copies), and persists the reversed `content` snapshot.
   * The ORIGINAL invoice is never touched. storage_key is null here; render the PDF
   * post-commit via {@link renderAndStoreById}. Returns the credit-note row.
   */
  async issueCreditNote(
    tx: Tx,
    tenantId: string,
    orderId: string,
    content: InvoiceContent,
    original: Invoice | null,
  ): Promise<Invoice> {
    // the credit note's mandatory seller/buyer mentions normally COPY the original invoice.
    // When the order has NO original (back-issue failed; the caller passed null), do NOT persist an
    // empty {} fiscal doc — RECONSTRUCT the seller identity from the tenant + the buyer identity from
    // the order, using the SAME helpers `issueForOrder` uses. `corrects_invoice_id` is null in this
    // (rare) case, which is surfaced loudly upstream for manual reconciliation.
    const { seller, buyer } = await this.resolveCreditNoteParties(tenantId, orderId, original);
    const number = await this.repo.allocateGaplessNumber(tx, tenantId, CREDIT_NOTE_SERIES);
    const issuedAt = new Date();
    return this.repo.insertInvoice(tx, {
      tenantId,
      orderId,
      type: 'credit_note',
      series: CREDIT_NOTE_SERIES,
      invoiceNumber: this.formatNumber(number, issuedAt),
      issuedAt,
      sellerSnapshot: seller as unknown as Record<string, unknown>,
      buyerSnapshot: buyer as unknown as Record<string, unknown>,
      currency: content.currency,
      subtotalAmount: content.subtotalAmount,
      taxBreakdown: content as unknown as Record<string, unknown>,
      taxAmount: content.taxAmount,
      totalAmount: content.totalAmount,
      reverseCharge: content.reverseCharge,
      viesConsultationRef: original?.viesConsultationRef ?? null,
      correctsInvoiceId: original?.id ?? null,
      storageKey: null,
    });
  }

  /**
   * the seller/buyer snapshots for a credit note. Prefer COPYING the original invoice's
   * (so the corrective document matches the document it corrects). When the order has no original
   * invoice, RECONSTRUCT them from live identity rather than minting empty {} snapshots: the seller
   * from the tenant business identity (snapshotted at issue, eu_vat-aware) and the buyer from the
   * order — exactly as `issueForOrder` builds them.
   */
  private async resolveCreditNoteParties(
    tenantId: string,
    orderId: string,
    original: Invoice | null,
  ): Promise<{ seller: SellerSnapshot; buyer: BuyerSnapshot }> {
    if (original) {
      return {
        seller: original.sellerSnapshot as unknown as SellerSnapshot,
        buyer: original.buyerSnapshot as unknown as BuyerSnapshot,
      };
    }
    const order = await this.repo.loadOrder(this.db.db, tenantId, orderId);
    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found; cannot build credit-note identity`);
    }
    const { taxMode } = await this.tenantSettings.getTaxSettings(tenantId);
    const seller = await this.loadSellerIdentity(tenantId, taxMode);
    return { seller: this.toSellerSnapshot(seller, taxMode), buyer: this.toBuyerSnapshot(order) };
  }

  /** The order's original (non-credit-note) invoice, or null. Used by the refund flow. */
  async findOriginalInvoice(tenantId: string, orderId: string): Promise<Invoice | null> {
    return this.repo.findInvoiceForOrder(this.db.db, tenantId, orderId);
  }

  /** Load any invoice/credit-note by id, tenant-scoped. */
  async findById(tenantId: string, invoiceId: string): Promise<Invoice | null> {
    return this.repo.findById(tenantId, invoiceId);
  }

  /**
   * Render + store the PDF for ANY invoice/credit-note by id (post-commit, best-effort). Reused by
   * the refund flow to render a freshly-issued credit note and by reconciliation. No-op if already
   * stored. Mirrors the issue-time render (the immutability trigger permits the one storage_key set).
   */
  async renderAndStoreById(tenantId: string, invoiceId: string): Promise<void> {
    const invoice = await this.repo.findById(tenantId, invoiceId);
    if (!invoice || invoice.storageKey) return;
    const order = await this.repo.loadOrder(this.db.db, tenantId, invoice.orderId);
    const content = invoice.taxBreakdown as unknown as InvoiceContent;
    const seller = invoice.sellerSnapshot as unknown as SellerSnapshot;
    const buyer = invoice.buyerSnapshot as unknown as BuyerSnapshot;
    await this.renderAndStore(tenantId, invoice, content, seller, buyer, order);
  }

  /**
   * Get the invoice PDF bytes for an order (download). Streams the stored object, or renders
   * on demand from the snapshot when storage_key is null (a prior render/store failure).
   * @throws NotFoundException when no invoice exists for the order in this tenant.
   */
  async getInvoicePdfForOrder(
    tenantId: string,
    orderId: string,
  ): Promise<{ filename: string; bytes: Buffer }> {
    const invoice = await this.repo.findInvoiceForOrder(this.db.db, tenantId, orderId);
    if (!invoice) {
      throw new NotFoundException(`No invoice for order ${orderId}`);
    }
    const filename = `invoice-${invoice.series}-${invoice.invoiceNumber}.pdf`;

    if (invoice.storageKey) {
      try {
        const bytes = await this.storage.download(invoice.storageKey);
        return { filename, bytes };
      } catch (err) {
        this.logger.warn(`Stored invoice PDF unreadable (${invoice.id}); rendering on demand`, err);
      }
    }
    const order = await this.repo.loadOrder(this.db.db, tenantId, orderId);
    const bytes = await this.renderFromSnapshot(invoice, order);
    return { filename, bytes };
  }

  /**
   * Re-issue (re-render + store) the PDF for an invoice whose render previously FAILED
   * (`storage_key` IS NULL) — a reconciliation path. It NEVER
   * re-allocates a number or re-issues the fiscal document; it only renders from the persisted
   * snapshot and attaches the PDF (the one mutation the immutability trigger permits). Idempotent:
   * an already-stored invoice returns `reissued:false`.
   *
   * @throws NotFoundException when no invoice exists for the order in this tenant.
   */
  async reissuePdfForOrder(
    tenantId: string,
    orderId: string,
  ): Promise<{ invoice: Invoice; reissued: boolean }> {
    const invoice = await this.repo.findInvoiceForOrder(this.db.db, tenantId, orderId);
    if (!invoice) {
      throw new NotFoundException(`No invoice for order ${orderId}`);
    }
    if (invoice.storageKey) {
      // Already rendered — nothing to reconcile.
      return { invoice, reissued: false };
    }
    const order = await this.repo.loadOrder(this.db.db, tenantId, orderId);
    const content = invoice.taxBreakdown as unknown as InvoiceContent;
    const seller = invoice.sellerSnapshot as unknown as SellerSnapshot;
    const buyer = invoice.buyerSnapshot as unknown as BuyerSnapshot;
    await this.renderAndStore(tenantId, invoice, content, seller, buyer, order);
    // renderAndStore sets invoice.storageKey on success (best-effort otherwise).
    return { invoice, reissued: invoice.storageKey !== null };
  }

  // ── internals ──────────────────────────────────────────────────────────────────

  /**
   * Render the PDF from the snapshot, write it to storage, and attach the storage_key.
   * Best-effort: any failure is logged and swallowed (the invoice is already validly issued;
   * downloads render on demand). The storage write happens OUTSIDE the issuing tx.
   */
  private async renderAndStore(
    tenantId: string,
    invoice: Invoice,
    content: InvoiceContent,
    seller: SellerSnapshot,
    buyer: BuyerSnapshot,
    order: Order | null,
  ): Promise<void> {
    try {
      const bytes = await renderInvoicePdf(this.pdfHeader(invoice, order), content, seller, buyer);
      // The invoice_number contains a '-' (e.g. 2026-000001) which is allowed in a key
      // segment, but the series-number filename must satisfy assertSafeKey's [A-Za-z0-9._-].
      const filename = `${invoice.series}-${invoice.invoiceNumber}.pdf`;
      const uploaded = await this.storage.upload(
        { tenantId, resourceType: 'invoices', resourceId: invoice.id, filename },
        bytes,
        'application/pdf',
      );
      const attached = await this.repo.attachStorageKey(tenantId, invoice.id, uploaded.key);
      if (attached) invoice.storageKey = uploaded.key;
    } catch (err) {
      this.logger.error(`Invoice PDF render/store failed for ${invoice.id} (left unstored)`, err);
    }
  }

  /** Render a PDF from a persisted invoice's snapshot (download fallback path). */
  private async renderFromSnapshot(invoice: Invoice, order: Order | null): Promise<Buffer> {
    const content = invoice.taxBreakdown as unknown as InvoiceContent;
    const seller = invoice.sellerSnapshot as unknown as SellerSnapshot;
    const buyer = invoice.buyerSnapshot as unknown as BuyerSnapshot;
    return renderInvoicePdf(this.pdfHeader(invoice, order), content, seller, buyer);
  }

  private pdfHeader(invoice: Invoice, order: Order | null): InvoicePdfHeader {
    return {
      invoiceNumber: invoice.invoiceNumber,
      series: invoice.series,
      issuedAt: invoice.issuedAt,
      orderNumber: order?.orderNumber ?? '',
    };
  }

  /**
   * Number format: `YYYY-NNNNNN` (year of issuance + zero-padded sequence). The sequence is
   * the gapless per-(tenant,series) counter value. This is a sensible default format.
   */
  private formatNumber(value: bigint, issuedAt: Date): string {
    const year = issuedAt.getUTCFullYear();
    return `${year}-${value.toString().padStart(6, '0')}`;
  }

  /** Load the tenant business identity from `tenants.settings` (for the seller snapshot). */
  private async loadSellerIdentity(tenantId: string, taxMode: string): Promise<SellerIdentity> {
    const [row] = await this.db.db
      .select({ name: tenants.name, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const settings = isRecord(row?.settings) ? row!.settings : {};
    const identity = isRecord(settings.business_identity) ? settings.business_identity : {};
    const reg = isRecord(settings.eu_vat_registration) ? settings.eu_vat_registration : {};

    const address = coerceAddress(identity.address);
    const siren = typeof identity.siren === 'string' ? identity.siren : null;
    const originCountry = typeof reg.origin_country === 'string' ? reg.origin_country : null;
    const vatNumber = typeof reg.vat_number === 'string' ? reg.vat_number : null;

    return {
      name: typeof identity.name === 'string' ? identity.name : (row?.name ?? 'Merchant'),
      address,
      // VAT/SIREN only meaningful (and only printed) in eu_vat mode.
      country: taxMode === 'eu_vat' ? originCountry : null,
      siren: taxMode === 'eu_vat' ? siren : null,
      vatNumber: taxMode === 'eu_vat' ? vatNumber : null,
    };
  }

  /**
   * The VIES consultation reference to print on a reverse-charge invoice. Only meaningful when
   * the order is reverse-charge.
   *
   * PRIMARY source: the ref snapshotted onto the ORDER at creation (`orders.vies_consultation_ref`)
   * — a pure order snapshot, stable against later customer mutations. FALLBACK (orders created
   * before the snapshot column existed → null): re-derive
   * from the customer's current VIES proof, guarded by the order's VAT number so a
   * since-re-validated number never prints a wrong ref. A guest / non-reverse-charge order → null.
   */
  private async resolveViesConsultationRef(tenantId: string, order: Order): Promise<string | null> {
    if (!order.reverseCharge) return null;
    if (order.viesConsultationRef) return order.viesConsultationRef;
    if (!order.customerId) return null;
    return this.repo.loadCustomerViesRef(this.db.db, tenantId, order.customerId, order.vatNumber);
  }

  private toOrderForInvoice(order: Order, viesConsultationRef: string | null): OrderForInvoice {
    return {
      email: order.email,
      currency: order.currency,
      subtotalAmount: order.subtotalAmount,
      discountAmount: order.discountAmount,
      shippingAmount: order.shippingAmount,
      taxAmount: order.taxAmount,
      totalAmount: order.totalAmount,
      taxInclusive: order.taxInclusive,
      isB2b: order.isB2b,
      vatNumber: order.vatNumber,
      reverseCharge: order.reverseCharge,
      billingAddress: order.billingAddress,
      viesConsultationRef,
    };
  }

  private toItemForInvoice(item: OrderItem): OrderItemForInvoice {
    return {
      productTitle: item.productTitle,
      variantTitle: item.variantTitle,
      sku: item.sku,
      quantity: item.quantity,
      unitPriceAmount: item.unitPriceAmount,
      taxRate: item.taxRate,
      taxAmount: item.taxAmount,
      lineTotalAmount: item.lineTotalAmount,
    };
  }

  private toSellerSnapshot(seller: SellerIdentity, taxMode: string): SellerSnapshot {
    return {
      name: seller.name,
      address: seller.address,
      siren: taxMode === 'eu_vat' ? seller.siren : null,
      vatNumber: taxMode === 'eu_vat' ? seller.vatNumber : null,
      country: seller.country,
    };
  }

  private toBuyerSnapshot(order: Order): BuyerSnapshot {
    const addr = coerceAddress(order.billingAddress);
    return {
      name: addr?.name ?? null,
      email: order.email,
      address: addr,
      vatNumber: order.vatNumber,
      isB2b: order.isB2b,
    };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function coerceAddress(raw: unknown): InvoiceAddress | null {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.line1 !== 'string' ||
    typeof raw.city !== 'string' ||
    typeof raw.country !== 'string'
  ) {
    return null;
  }
  return {
    name: typeof raw.name === 'string' ? raw.name : '',
    company: typeof raw.company === 'string' ? raw.company : null,
    line1: raw.line1,
    line2: typeof raw.line2 === 'string' ? raw.line2 : null,
    city: raw.city,
    postalCode: typeof raw.postalCode === 'string' ? raw.postalCode : '',
    region: typeof raw.region === 'string' ? raw.region : null,
    country: raw.country,
  };
}
