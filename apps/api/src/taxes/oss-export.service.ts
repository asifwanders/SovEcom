/**
 * OSS CSV export.
 *
 * Produces the EU One-Stop-Shop declaration data: per cross-border B2C sale within a date
 * window, for an `eu_vat` tenant that is OVER the €10k threshold / opted in. Lives in
 * TaxesModule (OSS is a tax concern) and queries the `orders` / `order_items` tables
 * DIRECTLY via DatabaseService — it does NOT import OrdersModule, so there is no
 * Orders↔Taxes module cycle.
 *
 * OSS scope (what an exported order IS):
 *   - the order is NOT cancelled (a cancelled sale is not declarable) and not soft-deleted,
 *   - the buyer is B2C (`is_b2b = false` — B2B intra-EU is reverse-charge, not OSS),
 *   - the DESTINATION (shipping address country) differs from the merchant's origin,
 *   - BOTH origin and destination are EU-27 (cross-border *intra-EU* distance sale),
 *   - `placed_at` is within `[from, to]`.
 *
 * POSTURE GATE: the export only declares OSS sales — cross-border B2C charged DESTINATION
 * VAT, which only happens when the tenant is `above_or_opted_in`. A `below_threshold`
 * tenant charges ORIGIN VAT on the same sales and declares them in the DOMESTIC return,
 * NOT OSS, so it gets the header-only CSV (same as the non-eu_vat case).
 *
 * SHIPPING VAT: for EU distance sales the ancillary cost (shipping) follows the goods
 * and IS part of the OSS-declarable consideration. `order_items` carries only the goods
 * (items) tax; shipping VAT is order-level. So per exported order we emit, in addition to
 * the goods rows, a SHIPPING row whenever shipping VAT > 0. `line_type` distinguishes
 * 'goods' vs 'shipping' so per-destination aggregation stays correct and Σ(exported VAT)
 * == order.tax_amount. For a non-`eu_vat` / non-EU-origin / below-threshold tenant the
 * result is EMPTY — the caller still returns a valid CSV with just the header row. Money
 * is integer minor units.
 */
import { Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { orders } from '../database/schema/orders';
import { orderItems } from '../database/schema/order_items';
import { refunds } from '../database/schema/refunds';
import { TenantSettingsService } from './tenant-settings.service';
import { EU_MEMBER_STATES, isEuCountry } from './engine/eu-vat-rules';

/** One flattened cross-border-B2C tax line for the OSS export (integer minor units). */
export interface OssExportRow {
  orderNumber: string;
  placedAt: Date | null;
  destinationCountry: string;
  /**
   * What the row's consideration is: 'goods' (an order_items line), 'shipping' (the order-level
   * ancillary cost), or 'refund' (a NEGATIVE correction for a refund issued in the period).
   * Σ(goods + shipping − refund) VAT == net VAT collected for the destination.
   */
  lineType: 'goods' | 'shipping' | 'refund';
  net: number;
  vatRate: string;
  vatAmount: number;
  currency: string;
}

/** The CSV column order (stable — declared once so header + rows can't drift). */
const CSV_COLUMNS = [
  'order_number',
  'placed_at',
  'destination_country',
  'line_type',
  'net',
  'vat_rate',
  'vat_amount',
  'currency',
] as const;

@Injectable()
export class OssExportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly settings: TenantSettingsService,
  ) {}

  /**
   * Build the OSS export CSV (text/csv body) for `[from, to]`. Returns the header row
   * only for a non-eu_vat / non-EU-origin tenant (no cross-border B2C data to report).
   */
  async buildCsv(tenantId: string, from: Date, to: Date): Promise<string> {
    const rows = await this.collectRows(tenantId, from, to);
    return this.toCsv(rows);
  }

  /** The raw cross-border B2C rows (exposed for unit/integration assertions). */
  async collectRows(tenantId: string, from: Date, to: Date): Promise<OssExportRow[]> {
    const tax = await this.settings.getTaxSettings(tenantId);
    const origin = tax.euVatRegistration.originCountry;
    // OSS is meaningful only for an eu_vat tenant established in the EU.
    if (tax.taxMode !== 'eu_vat' || !isEuCountry(origin)) return [];
    // POSTURE GATE: only an `above_or_opted_in` tenant charges DESTINATION VAT on
    // cross-border B2C sales — those are the OSS-declarable sales. A `below_threshold`
    // tenant charges ORIGIN VAT and declares the same sales in its DOMESTIC return, so it
    // must NOT appear in the OSS export → header-only CSV (same as the non-eu_vat case).
    //
    // NOTE: this is the tenant's CURRENT posture (point-in-time). A mid-period posture
    // change is not per-order snapshotted; that's acceptable — posture changes are rare
    // and the merchant reviews the CSV before filing (the export is a convenience aid).
    if (tax.ossPosture !== 'above_or_opted_in') return [];

    const originUpper = origin!.toUpperCase();
    // Cross-border destinations = EU-27 minus the origin country.
    const destinations = [...EU_MEMBER_STATES].filter((c) => c !== originUpper);
    if (destinations.length === 0) return [];

    // Destination country read out of the shipping-address JSONB snapshot, upper-cased.
    const destExpr = sql<string>`upper(${orders.shippingAddress} ->> 'country')`;
    const result = await this.db.db
      .select({
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        placedAt: orders.placedAt,
        destinationCountry: destExpr,
        // Order-level fields for the shipping row.
        orderTaxAmount: orders.taxAmount,
        shippingAmount: orders.shippingAmount,
        taxInclusive: orders.taxInclusive,
        lineTotalAmount: orderItems.lineTotalAmount,
        itemTaxAmount: orderItems.taxAmount,
        vatRate: orderItems.taxRate,
        currency: orders.currency,
      })
      .from(orderItems)
      .innerJoin(
        orders,
        and(eq(orderItems.orderId, orders.id), eq(orderItems.tenantId, orders.tenantId)),
      )
      .where(
        and(
          eq(orders.tenantId, tenantId),
          isNull(orders.deletedAt),
          ne(orders.status, 'cancelled'),
          eq(orders.isB2b, false),
          gte(orders.placedAt, from),
          lte(orders.placedAt, to),
          inArray(destExpr, destinations),
        ),
      )
      .orderBy(orders.placedAt, orders.orderNumber);

    // Group by order so each order's goods rows are immediately followed by its single
    // shipping row (deterministic: orders in [placed_at, order_number] order from the SQL,
    // goods rows in their join order within an order, then the shipping row).
    interface OrderGroup {
      goods: OssExportRow[];
      orderTaxAmount: number;
      shippingAmount: number;
      taxInclusive: boolean;
      destinationCountry: string;
      goodsRate: string;
      currency: string;
      goodsTaxSum: number;
    }
    const groups = new Map<string, OrderGroup>();
    const orderSequence: string[] = [];

    for (const r of result) {
      // Goods row stays EXACTLY as before (correct post-B3): net = line total − its VAT.
      const goodsRow: OssExportRow = {
        orderNumber: r.orderNumber,
        placedAt: r.placedAt,
        destinationCountry: r.destinationCountry,
        lineType: 'goods',
        net: r.lineTotalAmount - r.itemTaxAmount,
        vatRate: r.vatRate,
        vatAmount: r.itemTaxAmount,
        currency: r.currency,
      };
      const group = groups.get(r.orderId);
      if (group) {
        group.goods.push(goodsRow);
        group.goodsTaxSum += r.itemTaxAmount;
      } else {
        orderSequence.push(r.orderId);
        groups.set(r.orderId, {
          goods: [goodsRow],
          orderTaxAmount: r.orderTaxAmount,
          shippingAmount: r.shippingAmount,
          taxInclusive: r.taxInclusive,
          destinationCountry: r.destinationCountry,
          // The destination statutory rate carried by the goods lines (all identical
          // post-B3). Used as the shipping rate — shipping follows the goods rate.
          goodsRate: r.vatRate,
          currency: r.currency,
          goodsTaxSum: r.itemTaxAmount,
        });
      }
    }

    const rows: OssExportRow[] = [];
    for (const orderId of orderSequence) {
      const g = groups.get(orderId)!;
      rows.push(...g.goods);
      // shippingVat = order total tax − Σ goods item tax (clamp ≥ 0). This is the
      // order-level shipping VAT after the B3 fix (goods lines carry only items tax).
      const shippingVat = Math.max(0, g.orderTaxAmount - g.goodsTaxSum);
      if (shippingVat <= 0) continue; // free / untaxed shipping → no shipping row.
      // shippingNet: tax-inclusive shipping_amount already contains its VAT; tax-exclusive
      // shipping_amount IS the net (VAT charged on top).
      const shippingNet = g.taxInclusive ? g.shippingAmount - shippingVat : g.shippingAmount;
      const head = g.goods[0]!;
      rows.push({
        orderNumber: head.orderNumber,
        placedAt: head.placedAt,
        destinationCountry: g.destinationCountry,
        lineType: 'shipping',
        net: shippingNet,
        // Shipping follows the goods' destination statutory rate (single rate post-B3).
        vatRate: g.goodsRate,
        vatAmount: shippingVat,
        currency: g.currency,
      });
    }

    // ── Refund corrections: succeeded refunds ISSUED in [from, to] for OSS-scope
    // orders → NEGATIVE rows, so Σ exported VAT reconciles to collected-minus-refunded for the
    // period. Attributed to the order's destination; rate is the refund's effective ratio (a
    // label — the negative VAT amount is the authoritative figure). Refunds of an order sold in a
    // PRIOR period still correct the period they were issued in (standard credit-note treatment).
    const refundResult = await this.db.db
      .select({
        orderNumber: orders.orderNumber,
        placedAt: orders.placedAt,
        destinationCountry: destExpr,
        refundAmount: refunds.amount,
        refundTax: refunds.taxAmount,
        currency: refunds.currency,
      })
      .from(refunds)
      .innerJoin(orders, and(eq(refunds.orderId, orders.id), eq(refunds.tenantId, orders.tenantId)))
      .where(
        and(
          eq(orders.tenantId, tenantId),
          isNull(orders.deletedAt),
          // Symmetry with the sales query — a cancelled order's sale was never exported, so its
          // refund must not emit a stray negative row (Fable N4).
          ne(orders.status, 'cancelled'),
          eq(orders.isB2b, false),
          // Non-failed refunds (pending SEPA included) — matches refunded_amount (Fable B6c).
          ne(refunds.status, 'failed'),
          gte(refunds.createdAt, from),
          lte(refunds.createdAt, to),
          inArray(destExpr, destinations),
        ),
      )
      .orderBy(refunds.createdAt);

    for (const r of refundResult) {
      const net = r.refundAmount - r.refundTax;
      rows.push({
        orderNumber: r.orderNumber,
        placedAt: r.placedAt,
        destinationCountry: r.destinationCountry,
        lineType: 'refund',
        net: -net,
        vatRate: net > 0 ? (r.refundTax / net).toFixed(4) : '0.0000',
        vatAmount: -r.refundTax,
        currency: r.currency,
      });
    }

    return rows;
  }

  /** Render rows as RFC-4180-ish CSV with the fixed header. Always emits the header. */
  private toCsv(rows: OssExportRow[]): string {
    const lines = [CSV_COLUMNS.join(',')];
    for (const r of rows) {
      lines.push(
        [
          csvField(r.orderNumber),
          csvField(r.placedAt ? r.placedAt.toISOString() : ''),
          csvField(r.destinationCountry),
          csvField(r.lineType),
          String(r.net),
          csvField(r.vatRate),
          String(r.vatAmount),
          csvField(r.currency),
        ].join(','),
      );
    }
    // Trailing newline so the file ends cleanly (POSIX text-file convention).
    return lines.join('\n') + '\n';
  }
}

/** Quote a CSV field iff it contains a comma, quote, or newline (RFC 4180). */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
