/**
 * Invoice snapshot builder (PURE, regime-branched).
 *
 * Turns an order + its line items + the tenant's tax settings (read AT ISSUANCE) into
 * the immutable JSONB snapshots persisted on the invoice row and rendered into the PDF.
 * Snapshotting the RENDERED content here (not re-deriving it from live tables) is what
 * makes an issued invoice immune to a later settings/order mutation.
 *
 * Two branches:
 *   - `none`   → a clean RECEIPT: net lines, totals, currency. No VAT lines; the seller
 *                snapshot carries name/address only (no SIREN/VAT required).
 *   - `eu_vat` → a VAT INVOICE: seller snapshot with SIREN/SIRET + VAT number, buyer
 *                snapshot from the order, per-rate tax breakdown, and — when the order is
 *                reverse-charge — an autoliquidation note + legal basis + the VIES ref.
 *
 * MONEY/LEGAL-CRITICAL — the rendered figures MUST RECONCILE to order.total_amount. The
 * invoice ITEMISES the order's snapshotted totals — line goods, the order DISCOUNT, the
 * SHIPPING line (net + its VAT), and a per-rate VAT recap whose every row satisfies
 * rate×base ≈ vat — in BOTH tax-exclusive and tax-inclusive modes:
 *
 *   exclusive (prices_include_tax=false): the order's subtotal/shipping are NET; VAT is added
 *     on top. net-subtotal − discount + shipping-net + Σ VAT == order.total_amount.
 *   inclusive (prices_include_tax=true, normal EU B2C): the order's subtotal/shipping are
 *     GROSS; the NET base is GROSS − the order's extracted VAT. The recap base is NET; the
 *     printed total == order.total_amount (VAT already inside, not re-added).
 *
 * The order-level SHIPPING VAT is `order.tax_amount − Σ order_items.tax_amount`:
 * shipping tax is kept order-level, NEVER smeared into a goods line. It gets its OWN recap
 * contribution at its own rate — never folded into a goods row in a way that breaks rate×base.
 *
 * The mandatory-mention strings and reverse-charge legal basis are sensible defaults,
 * NOT final vetted legal text. The structure (which fields appear, the regime branch)
 * is the spec; the exact French wording may be adjusted by counsel.
 */
import type { TaxMode } from '../taxes/tenant-settings.service';

/** A postal address as snapshotted on the invoice (mirrors the order address JSONB). */
export interface InvoiceAddress {
  name: string;
  company?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  postalCode: string;
  region?: string | null;
  country: string;
}

/** The seller (merchant) identity snapshot. VAT fields are null in `none` mode. */
export interface SellerSnapshot {
  name: string;
  address: InvoiceAddress | null;
  /** SIREN/SIRET — present (when configured) only for an eu_vat VAT invoice. */
  siren: string | null;
  /** The merchant's own VAT number — present only for an eu_vat VAT invoice. */
  vatNumber: string | null;
  /** Country of establishment (ISO alpha-2), or null. */
  country: string | null;
}

/** The buyer snapshot — from the order (billing address + B2B VAT number). */
export interface BuyerSnapshot {
  name: string | null;
  email: string;
  address: InvoiceAddress | null;
  /** The buyer's VAT number (B2B), or null. */
  vatNumber: string | null;
  isB2b: boolean;
}

/** One rendered invoice line (snapshotted from an order_item). */
export interface InvoiceLine {
  description: string;
  sku: string;
  quantity: number;
  /** Net unit price (minor units). */
  unitPriceAmount: number;
  /** Statutory tax rate as a fraction (e.g. 0.2 for 20%); 0 in `none`/reverse-charge. */
  taxRate: number;
  /** Net line total (minor units), EX-VAT in both inclusive and exclusive modes. */
  lineNetAmount: number;
  /** Tax on this line (minor units); 0 in `none`/reverse-charge. */
  lineTaxAmount: number;
}

/** The order's discount, itemised on the invoice (net of VAT in eu_vat mode). */
export interface InvoiceDiscount {
  /** Net discount amount (minor units, ≥ 0). The amount subtracted from the net subtotal. */
  netAmount: number;
}

/** The order's shipping, itemised on the invoice as a NET line + its own VAT. */
export interface InvoiceShipping {
  /** Net shipping charge (minor units, ≥ 0), EX-VAT in both modes. */
  netAmount: number;
  /** VAT charged on shipping (minor units, ≥ 0); 0 in `none`/reverse-charge. */
  taxAmount: number;
  /** Statutory shipping VAT rate as a fraction; 0 when no shipping VAT. */
  taxRate: number;
}

/** A per-rate tax aggregate for the VAT-invoice breakdown table. */
export interface TaxBreakdownRow {
  /** The statutory rate as a fraction (e.g. 0.2). */
  rate: number;
  /** Net base the rate applies to (minor units). */
  baseAmount: number;
  /** Tax charged at this rate (minor units). */
  taxAmount: number;
}

/** The fully-rendered, immutable invoice content snapshot. */
export interface InvoiceContent {
  taxMode: TaxMode;
  /** A receipt (`none`) vs a VAT invoice (`eu_vat`) — drives the PDF title + sections. */
  documentKind: 'receipt' | 'vat_invoice';
  /** True when the order's stored prices are GROSS (VAT extracted) — drives the labels. */
  taxInclusive: boolean;
  currency: string;
  lines: InvoiceLine[];
  /** The NET goods subtotal (Σ line net, EX-VAT) in both modes. */
  subtotalAmount: number;
  /** The order's discount, itemised (net of VAT). */
  discount: InvoiceDiscount;
  /** The order's shipping, itemised (net + its own VAT). */
  shipping: InvoiceShipping;
  taxAmount: number;
  totalAmount: number;
  /** Empty for a receipt; per-rate rows for a VAT invoice. */
  taxBreakdown: TaxBreakdownRow[];
  reverseCharge: boolean;
  viesConsultationRef: string | null;
  /** Statutory/courtesy mentions to print at the foot of the document. */
  mentions: string[];
  /** True for a credit note: retitles the PDF + references the original. */
  isCreditNote?: boolean;
  /** The original invoice number this credit note corrects (credit notes only). */
  correctsInvoiceNumber?: string | null;
}

/** The order header fields the snapshot reads. */
export interface OrderForInvoice {
  email: string;
  currency: string;
  subtotalAmount: number;
  /** Order-level discount (minor units). */
  discountAmount: number;
  /** Order-level shipping charge (minor units; net for exclusive, gross for inclusive). */
  shippingAmount: number;
  taxAmount: number;
  totalAmount: number;
  /** True when the order's stored prices are GROSS (VAT extracted). */
  taxInclusive: boolean;
  isB2b: boolean;
  vatNumber: string | null;
  reverseCharge: boolean;
  billingAddress: unknown;
  viesConsultationRef?: string | null;
}

/** One order line the snapshot reads. */
export interface OrderItemForInvoice {
  productTitle: string;
  variantTitle: string | null;
  sku: string;
  quantity: number;
  unitPriceAmount: number;
  /** NUMERIC(5,4) string from order_items, e.g. "0.2000". */
  taxRate: string;
  taxAmount: number;
  lineTotalAmount: number;
}

/** The seller (tenant) identity read at issuance. */
export interface SellerIdentity {
  name: string;
  address: InvoiceAddress | null;
  /** Country of establishment (eu_vat origin), or null. */
  country: string | null;
  /** SIREN/SIRET, or null. */
  siren: string | null;
  /** Merchant VAT number, or null. */
  vatNumber: string | null;
}

/**
 * The reverse-charge / autoliquidation legal basis. DEFAULT WORDING — PENDING the French
 * accountant: the precise CGI / EU-directive citation must be confirmed before
 * this is treated as binding. We ship a defensible default rather than invent final text.
 */
export const REVERSE_CHARGE_MENTION =
  'Autoliquidation — VAT reverse charge. VAT to be accounted for by the recipient ' +
  '(EU intra-community supply, Art. 196 Directive 2006/112/EC / CGI art. 283-2).';

/**
 * A no-VAT (regime `none`) courtesy mention. A small merchant below the VAT threshold
 * may print e.g. "TVA non applicable, art. 293 B du CGI". This is a neutral placeholder.
 */
export const NO_VAT_MENTION =
  'Prices shown are final; no VAT is applied under the current tax regime.';

/* ───────────────────────── Credit notes ───────────────────────── */

/** One credited line on a credit note (already-computed money from RefundService). */
export interface CreditNoteLineInput {
  description: string;
  sku: string;
  quantity: number;
  /** Net amount credited for this line (ex-VAT), ≥ 0. */
  netAmount: number;
  /** Statutory rate (fraction); 0 in `none` / reverse-charge. */
  taxRate: number;
  /** VAT reversed for this line, ≥ 0. */
  taxAmount: number;
}

/** The fully-computed refund figures a credit note formats (RefundService owns the math). */
export interface CreditNoteInput {
  taxMode: TaxMode;
  currency: string;
  taxInclusive: boolean;
  reverseCharge: boolean;
  /** Credited goods lines (may be a single synthetic "Refund" line for an amount-only refund). */
  lines: CreditNoteLineInput[];
  shippingNet: number;
  shippingTax: number;
  shippingRate: number;
  /** Σ line net + shipping net. */
  netAmount: number;
  /** Σ line tax + shipping tax. */
  taxAmount: number;
  /** netAmount + taxAmount (the gross credited). */
  totalAmount: number;
  correctsInvoiceNumber: string | null;
}

/** A credit-note mention. */
export const CREDIT_NOTE_MENTION =
  'Credit note (avoir) — corrects the referenced invoice; the original invoice is unchanged.';

/**
 * Build the immutable CREDIT-NOTE content snapshot from RefundService's computed figures. Unlike
 * {@link buildInvoiceContent} (which reconciles to an order total), a credit note reconciles to the
 * REFUND total: `Σ line net + shipping net + VAT == totalAmount`. Amounts are POSITIVE (the credited
 * value, the French *avoir* convention); the document is retitled CREDIT NOTE and references the
 * original. VAT presentation mirrors the order's regime.
 */
export function buildCreditNoteContent(input: CreditNoteInput): InvoiceContent {
  const isVat = input.taxMode === 'eu_vat';
  const lines: InvoiceLine[] = input.lines.map((l) => ({
    description: l.description,
    sku: l.sku,
    quantity: l.quantity,
    unitPriceAmount: l.quantity > 0 ? Math.round(l.netAmount / l.quantity) : l.netAmount,
    taxRate: l.taxRate,
    lineNetAmount: l.netAmount,
    lineTaxAmount: l.taxAmount,
  }));
  const goodsNet = lines.reduce((s, l) => s + l.lineNetAmount, 0);

  const shipping: InvoiceShipping = {
    netAmount: input.shippingNet,
    taxAmount: input.shippingTax,
    taxRate: input.shippingRate,
  };

  const mentions: string[] = [CREDIT_NOTE_MENTION];
  let taxBreakdown: TaxBreakdownRow[] = [];
  if (isVat) {
    if (input.reverseCharge) {
      taxBreakdown = [{ rate: 0, baseAmount: goodsNet + shipping.netAmount, taxAmount: 0 }];
      mentions.push(REVERSE_CHARGE_MENTION);
    } else {
      taxBreakdown = aggregateByRate(lines, shipping, false, goodsNet);
    }
  } else {
    mentions.push(NO_VAT_MENTION);
  }

  const content: InvoiceContent = {
    taxMode: input.taxMode,
    documentKind: isVat ? 'vat_invoice' : 'receipt',
    taxInclusive: input.taxInclusive,
    currency: input.currency,
    lines,
    subtotalAmount: goodsNet,
    discount: { netAmount: 0 },
    shipping,
    taxAmount: input.taxAmount,
    totalAmount: input.totalAmount,
    taxBreakdown,
    reverseCharge: input.reverseCharge,
    viesConsultationRef: null,
    mentions,
    isCreditNote: true,
    correctsInvoiceNumber: input.correctsInvoiceNumber,
  };

  assertCreditNoteReconciles(content);
  return content;
}

/** Credit-note money guard: net + shipping-net + VAT == total; tax parts sum; integer/non-negative. */
function assertCreditNoteReconciles(content: InvoiceContent): void {
  const reconstructed = content.subtotalAmount + content.shipping.netAmount + content.taxAmount;
  if (reconstructed !== content.totalAmount) {
    throw new Error(
      `credit note reconcile failed: net ${content.subtotalAmount} + shipping ${content.shipping.netAmount} ` +
        `+ VAT ${content.taxAmount} = ${reconstructed} ≠ total ${content.totalAmount}`,
    );
  }
  const goodsTax = content.lines.reduce((s, l) => s + l.lineTaxAmount, 0);
  if (goodsTax + content.shipping.taxAmount !== content.taxAmount) {
    throw new Error(
      `credit note tax reconcile failed: goods ${goodsTax} + shipping ${content.shipping.taxAmount} ≠ ${content.taxAmount}`,
    );
  }
  for (const v of [
    content.subtotalAmount,
    content.shipping.netAmount,
    content.shipping.taxAmount,
    content.taxAmount,
    content.totalAmount,
  ]) {
    if (v < 0 || !Number.isInteger(v)) {
      throw new Error(`credit note money invariant failed: non-integer/negative ${v}`);
    }
  }
}

/** A line's display description = product title + variant title (when present). */
function lineDescription(item: OrderItemForInvoice): string {
  return item.variantTitle ? `${item.productTitle} — ${item.variantTitle}` : item.productTitle;
}

/**
 * Build the immutable invoice content snapshot for an order under a tax mode.
 *
 * @param mode    the tenant tax mode read AT ISSUANCE (snapshotted; later changes do not apply).
 * @param order   the order header.
 * @param items    the order line items.
 * @param _seller  the tenant business identity (kept for signature symmetry; the seller
 *                 SNAPSHOT is assembled by InvoiceService — the content branch needs only
 *                 the tax mode + order + items).
 * @throws Error  when the rendered figures do not reconcile to order.total_amount (a hard
 *   money-integrity guard — surfaced as a 500 rather than shipping a non-reconciling invoice).
 */
export function buildInvoiceContent(
  mode: TaxMode,
  order: OrderForInvoice,
  items: OrderItemForInvoice[],
  _seller: SellerIdentity,
): InvoiceContent {
  const isVat = mode === 'eu_vat';
  const charges = isVat && !order.reverseCharge;

  // ── Per-line: net (EX-VAT) goods + the line's items-tax share. ──
  // order_items.line_total_amount is net+tax (exclusive) or net (inclusive); in BOTH cases
  // the line NET ex-VAT = line_total_amount − line_tax_amount. We snapshot NET so the
  // recap base is net in inclusive mode too: never present gross as the net base.
  const lines: InvoiceLine[] = items.map((item) => {
    const lineTax = charges ? item.taxAmount : 0;
    const lineNet = item.lineTotalAmount - lineTax;
    return {
      description: lineDescription(item),
      sku: item.sku,
      quantity: item.quantity,
      // Unit price net = lineNet / quantity is not always integer; keep the stored unit price
      // (it is the catalog unit price; the authoritative reconciled figure is lineNetAmount).
      unitPriceAmount: item.unitPriceAmount,
      taxRate: charges ? Number(item.taxRate) : 0,
      lineNetAmount: lineNet,
      lineTaxAmount: lineTax,
    };
  });

  // Σ line net is AFTER discount + EX-VAT (buildSnapshot apportions the discount into each
  // line's net before tax). Σ line tax is the items-tax (goods only; shipping tax is order-level).
  const goodsNetAfterDiscount = lines.reduce((s, l) => s + l.lineNetAmount, 0);
  const goodsTax = lines.reduce((s, l) => s + l.lineTaxAmount, 0);
  const goodsRate = lines.find((l) => l.taxRate > 0)?.taxRate ?? 0;

  // ── Shipping: net line + its OWN order-level VAT (post-2.8 B3). ──
  // Shipping VAT = order.tax_amount − Σ goods-line tax (the order-level remainder). The net
  // shipping charge is gross−shippingTax (inclusive) or the stored amount (exclusive).
  const orderTax = charges ? order.taxAmount : 0;
  const shippingTax = Math.max(0, orderTax - goodsTax);
  const shippingGross = Math.max(0, order.shippingAmount);
  const shippingNet = order.taxInclusive ? shippingGross - shippingTax : shippingGross;
  // The statutory shipping rate: the goods rate in v1 (single destination rate); fall back to
  // a derived rate only to label the row (never used for arithmetic — the VAT is the order's).
  const shippingRate = shippingTax > 0 ? deriveRate(lines, shippingNet, shippingTax) : 0;

  const shipping: InvoiceShipping = {
    netAmount: shippingNet,
    taxAmount: shippingTax,
    taxRate: shippingRate,
  };

  // ── Discount: itemised NET of VAT. ──
  // order.discountAmount is NET in exclusive mode (discount applied to net goods) and GROSS in
  // inclusive mode (applied to gross prices) — in inclusive we EXTRACT its VAT at the goods rate
  // so the printed discount line is net, like the subtotal. The pre-discount net subtotal is
  // then `Σ line net (after discount) + net discount`, so Subtotal − Discount == the line nets.
  const discountGross = Math.max(0, order.discountAmount);
  const discountNet =
    charges && order.taxInclusive && goodsRate > 0
      ? Math.round(discountGross / (1 + goodsRate))
      : discountGross;
  const discount: InvoiceDiscount = { netAmount: discountNet };

  // The subtotal printed is the NET goods BEFORE discount, so the discount line reconciles:
  // Subtotal(net, pre-discount) − Discount(net) == Σ line net (after discount).
  const subtotalNetPreDiscount = goodsNetAfterDiscount + discountNet;

  const mentions: string[] = [];
  let taxBreakdown: TaxBreakdownRow[] = [];

  if (isVat) {
    taxBreakdown = aggregateByRate(lines, shipping, order.reverseCharge, goodsNetAfterDiscount);
    if (order.reverseCharge) {
      mentions.push(REVERSE_CHARGE_MENTION);
    }
  } else {
    mentions.push(NO_VAT_MENTION);
  }

  const totalTax = charges ? goodsTax + shippingTax : 0;

  const content: InvoiceContent = {
    taxMode: mode,
    documentKind: isVat ? 'vat_invoice' : 'receipt',
    taxInclusive: order.taxInclusive,
    currency: order.currency,
    lines,
    subtotalAmount: subtotalNetPreDiscount,
    discount,
    shipping,
    taxAmount: totalTax,
    totalAmount: order.totalAmount,
    taxBreakdown,
    reverseCharge: order.reverseCharge,
    viesConsultationRef: order.viesConsultationRef ?? null,
    mentions,
  };

  assertReconciles(content, order);
  return content;
}

/**
 * Derive a display rate for the shipping row from its net base + VAT. Prefer a goods rate that
 * matches (v1 has one destination rate) so the row reads cleanly; else compute net→vat. Used
 * ONLY to LABEL the shipping recap row — the VAT figure itself is the order's authoritative
 * order-level shipping tax, never recomputed from this rate.
 */
function deriveRate(lines: InvoiceLine[], shippingNet: number, shippingTax: number): number {
  const goodsRate = lines.find((l) => l.taxRate > 0)?.taxRate;
  if (
    goodsRate &&
    shippingNet > 0 &&
    Math.abs(Math.round(shippingNet * goodsRate) - shippingTax) <= 1
  ) {
    return goodsRate;
  }
  if (shippingNet > 0) return shippingTax / shippingNet;
  return goodsRate ?? 0;
}

/**
 * Aggregate the per-rate VAT breakdown for a VAT invoice. Reverse-charge → a single 0% row at
 * the goods+shipping net base (autoliquidation: VAT due by the recipient, none charged here).
 * Otherwise: group goods lines by their statutory rate, then add the SHIPPING contribution as
 * its OWN correctly-rated row (merged into a goods row of the SAME rate, where rate×base≈vat
 * still holds; else its own row). The shipping VAT is NEVER folded into a different-rate goods
 * row (the old bug: 20% on base 1000 → tax 300 broke rate×base).
 */
function aggregateByRate(
  lines: InvoiceLine[],
  shipping: InvoiceShipping,
  reverseCharge: boolean,
  goodsNet: number,
): TaxBreakdownRow[] {
  if (reverseCharge) {
    return [{ rate: 0, baseAmount: goodsNet + shipping.netAmount, taxAmount: 0 }];
  }

  const byRate = new Map<number, { base: number; tax: number }>();
  for (const l of lines) {
    const cur = byRate.get(l.taxRate) ?? { base: 0, tax: 0 };
    cur.base += l.lineNetAmount;
    cur.tax += l.lineTaxAmount;
    byRate.set(l.taxRate, cur);
  }

  // Shipping is its OWN contribution at its OWN rate. Merge into the goods row of the SAME
  // rate (rate×base still holds for the merged row); otherwise it gets its own row.
  if (shipping.taxAmount > 0 || shipping.netAmount > 0) {
    const cur = byRate.get(shipping.taxRate) ?? { base: 0, tax: 0 };
    cur.base += shipping.netAmount;
    cur.tax += shipping.taxAmount;
    byRate.set(shipping.taxRate, cur);
  }

  return [...byRate.entries()]
    .filter(([, v]) => v.base > 0 || v.tax > 0)
    .sort(([a], [b]) => a - b)
    .map(([rate, v]) => ({ rate, baseAmount: v.base, taxAmount: v.tax }));
}

/**
 * Reconciliation guard. The rendered figures MUST sum to order.total_amount in BOTH modes,
 * the per-rate recap must total the order tax, and each recap row must satisfy rate×base ≈ vat
 * (±1 minor unit for rounding). A failure throws — the issuance aborts (its tx rolls back,
 * the number is NOT consumed) rather than persisting a non-reconciling fiscal document.
 *
 *   net subtotal − discount + shipping-net + total VAT == order.total_amount
 *
 * holds in BOTH modes because in inclusive mode the VAT is already inside subtotal/shipping
 * GROSS = NET + VAT, so (net + VAT) reconstructs the gross the order total was built from.
 */
function assertReconciles(content: InvoiceContent, order: OrderForInvoice): void {
  const reconstructed =
    content.subtotalAmount -
    content.discount.netAmount +
    content.shipping.netAmount +
    content.taxAmount;
  if (reconstructed !== order.totalAmount) {
    throw new Error(
      `invoice reconcile failed: net ${content.subtotalAmount} − discount ${content.discount.netAmount} ` +
        `+ shipping-net ${content.shipping.netAmount} + VAT ${content.taxAmount} = ${reconstructed} ` +
        `≠ order.total ${order.totalAmount} (taxInclusive=${order.taxInclusive})`,
    );
  }

  // Per-line tax sums to goods tax; goods tax + shipping tax == content tax.
  const goodsTax = content.lines.reduce((s, l) => s + l.lineTaxAmount, 0);
  if (goodsTax + content.shipping.taxAmount !== content.taxAmount) {
    throw new Error(
      `invoice tax reconcile failed: goods ${goodsTax} + shipping ${content.shipping.taxAmount} ≠ ${content.taxAmount}`,
    );
  }

  // The per-rate recap totals the order VAT, and each charging row satisfies rate×base ≈ vat.
  if (content.taxBreakdown.length > 0) {
    const recapTax = content.taxBreakdown.reduce((s, r) => s + r.taxAmount, 0);
    if (recapTax !== content.taxAmount) {
      throw new Error(`invoice recap tax ${recapTax} ≠ content tax ${content.taxAmount}`);
    }
    // A recap row aggregates many per-line VATs (each independently rounded) + possibly the
    // shipping VAT. Σ round(net_i × rate) can drift from round(Σnet × rate) by up to the
    // number of independently-rounded contributors, so the rate×base tolerance scales with
    // that count (never less than 1). The row VAT itself is the order's authoritative figure.
    for (const row of content.taxBreakdown) {
      if (row.rate <= 0) continue; // a 0% (reverse-charge) row carries no VAT by definition.
      const contributors =
        content.lines.filter((l) => l.taxRate === row.rate).length +
        (content.shipping.taxRate === row.rate && content.shipping.taxAmount > 0 ? 1 : 0);
      const tolerance = Math.max(1, contributors);
      const expected = Math.round(row.baseAmount * row.rate);
      if (Math.abs(expected - row.taxAmount) > tolerance) {
        throw new Error(
          `invoice recap row rate×base mismatch: ${row.rate}×${row.baseAmount}=${expected} ≠ vat ${row.taxAmount} (tol ${tolerance})`,
        );
      }
    }
  }

  // No negative or non-integer money escapes onto a fiscal document.
  for (const v of [
    content.subtotalAmount,
    content.discount.netAmount,
    content.shipping.netAmount,
    content.shipping.taxAmount,
    content.taxAmount,
    content.totalAmount,
  ]) {
    if (v < 0 || !Number.isInteger(v)) {
      throw new Error(`invoice money invariant failed: non-integer/negative ${v}`);
    }
  }
}
