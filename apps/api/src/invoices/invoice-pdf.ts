/**
 * invoice PDF renderer (pdfkit, pure-JS, no Chromium).
 *
 * Renders the IMMUTABLE invoice snapshot (never the live tables) into a PDF/A-ish A4
 * document. Two layouts off the same snapshot:
 *   - receipt   (`none`)   → net lines + totals, no VAT column/breakdown.
 *   - vat_invoice (`eu_vat`) → adds a VAT column, the per-rate breakdown, seller VAT/SIREN,
 *     buyer VAT, and the reverse-charge / mandatory mentions in the footer.
 *
 * Factur-X PDF/A-3 + embedded XML is DEFERRED — this is a human-readable PDF.
 * The legal wording in `content.mentions` is a DEFAULT pending the accountant (see
 * invoice-snapshot.ts) — this renderer only typesets whatever the snapshot carries.
 */
import PDFDocument from 'pdfkit';
import { formatMoney } from '../common/money';
import type { BuyerSnapshot, InvoiceContent, SellerSnapshot } from './invoice-snapshot';

/** The header fields printed at the top of the document. */
export interface InvoicePdfHeader {
  invoiceNumber: string;
  series: string;
  issuedAt: Date;
  orderNumber: string;
}

/** Minor-units-aware money formatting — shared with the email templates. */
const money = formatMoney;

function ratePct(rate: number): string {
  return `${(rate * 100).toFixed(rate * 100 === Math.floor(rate * 100) ? 0 : 2)}%`;
}

function addressLines(
  addr: {
    name?: string;
    company?: string | null;
    line1: string;
    line2?: string | null;
    city: string;
    postalCode: string;
    region?: string | null;
    country: string;
  } | null,
): string[] {
  if (!addr) return [];
  const out: string[] = [];
  if (addr.name) out.push(addr.name);
  if (addr.company) out.push(addr.company);
  out.push(addr.line1);
  if (addr.line2) out.push(addr.line2);
  out.push(`${addr.postalCode} ${addr.city}${addr.region ? `, ${addr.region}` : ''}`);
  out.push(addr.country);
  return out;
}

/**
 * Render the invoice to a PDF Buffer. Resolves once pdfkit has flushed every chunk, so the
 * returned Buffer is the complete, valid `%PDF…%%EOF` document (used for the storage write
 * and for on-demand streaming).
 */
export function renderInvoicePdf(
  header: InvoicePdfHeader,
  content: InvoiceContent,
  seller: SellerSnapshot,
  buyer: BuyerSnapshot,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      // compress:false leaves the content streams as plain text in the PDF bytes. A legal
      // invoice's mandatory mentions (e.g. the autoliquidation note) must be inspectable —
      // both for downstream verification/QA and so the rendered statutory wording can be
      // grep-asserted; the size cost is negligible for a one-page invoice.
      const doc = new PDFDocument({ size: 'A4', margin: 50, compress: false });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const isVat = content.documentKind === 'vat_invoice';
      const isCreditNote = content.isCreditNote === true;

      // ── Title ──
      const title = isCreditNote ? 'CREDIT NOTE' : isVat ? 'INVOICE' : 'RECEIPT';
      doc.fontSize(20).text(title, { align: 'right' });
      doc
        .fontSize(10)
        .text(`No. ${header.series}-${header.invoiceNumber}`, { align: 'right' })
        .text(`Date: ${header.issuedAt.toISOString().slice(0, 10)}`, { align: 'right' })
        .text(`Order: ${header.orderNumber}`, { align: 'right' });
      if (isCreditNote && content.correctsInvoiceNumber) {
        doc.text(`Corrects invoice: ${content.correctsInvoiceNumber}`, { align: 'right' });
      }
      doc.moveDown();

      // ── Seller ──
      doc.fontSize(12).text(seller.name);
      doc.fontSize(9);
      for (const l of addressLines(seller.address)) doc.text(l);
      if (seller.siren) doc.text(`SIREN/SIRET: ${seller.siren}`);
      if (seller.vatNumber) doc.text(`VAT: ${seller.vatNumber}`);
      doc.moveDown();

      // ── Buyer ──
      doc.fontSize(10).text('Bill to:');
      doc.fontSize(9);
      if (buyer.name) doc.text(buyer.name);
      for (const l of addressLines(buyer.address)) doc.text(l);
      doc.text(buyer.email);
      if (buyer.vatNumber) doc.text(`VAT: ${buyer.vatNumber}`);
      doc.moveDown();

      // ── Line items ──
      doc.fontSize(10).text('Items', { underline: true });
      doc.fontSize(9).moveDown(0.3);
      for (const line of content.lines) {
        const left = `${line.quantity} × ${line.description} (${line.sku})`;
        const right = isVat
          ? `${money(line.lineNetAmount, content.currency)}  (VAT ${ratePct(line.taxRate)}: ${money(line.lineTaxAmount, content.currency)})`
          : money(line.lineNetAmount, content.currency);
        doc.text(`${left}  —  ${right}`);
      }
      doc.moveDown();

      // ── Totals (itemised so Subtotal − Discount + Shipping + VAT == Total reconciles) ──
      doc.fontSize(10);
      // `subtotalAmount` is the NET goods subtotal in both modes (VAT extracted in inclusive).
      const subtotalLabel = isVat ? 'Subtotal (net)' : 'Subtotal';
      doc.text(`${subtotalLabel}: ${money(content.subtotalAmount, content.currency)}`, {
        align: 'right',
      });
      if (content.discount.netAmount > 0) {
        doc.text(`Discount: -${money(content.discount.netAmount, content.currency)}`, {
          align: 'right',
        });
      }
      if (content.shipping.netAmount > 0 || content.shipping.taxAmount > 0) {
        const shipNet = money(content.shipping.netAmount, content.currency);
        const shipLine =
          isVat && content.shipping.taxAmount > 0
            ? `Shipping (net): ${shipNet}  (VAT ${ratePct(content.shipping.taxRate)}: ${money(content.shipping.taxAmount, content.currency)})`
            : `Shipping: ${shipNet}`;
        doc.text(shipLine, { align: 'right' });
      }
      if (isVat) {
        doc.text(`VAT total: ${money(content.taxAmount, content.currency)}`, { align: 'right' });
      }
      doc.fontSize(12).text(`Total: ${money(content.totalAmount, content.currency)}`, {
        align: 'right',
      });
      doc.moveDown();

      // ── VAT breakdown (VAT invoice only) ──
      if (isVat && content.taxBreakdown.length > 0) {
        doc.fontSize(10).text('VAT breakdown', { underline: true });
        doc.fontSize(9).moveDown(0.3);
        for (const row of content.taxBreakdown) {
          doc.text(
            `${ratePct(row.rate)} on ${money(row.baseAmount, content.currency)} → ${money(row.taxAmount, content.currency)}`,
          );
        }
        doc.moveDown();
      }

      // ── VIES + mandatory mentions ──
      if (content.viesConsultationRef) {
        doc.fontSize(8).text(`VIES consultation ref: ${content.viesConsultationRef}`);
      }
      if (content.mentions.length > 0) {
        doc.moveDown(0.5).fontSize(8);
        for (const m of content.mentions) doc.text(m);
      }

      doc.end();
    } catch (err) {
      reject(err as Error);
    }
  });
}
