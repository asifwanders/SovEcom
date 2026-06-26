/**
 * order confirmation email (`order.created`).
 */
import { formatMoney } from '../../common/money';
import {
  addressLines,
  esc,
  introHtml,
  wrapHtml,
  type AddressLike,
  type RenderedEmail,
} from './_layout';
import { DEFAULT_LOCALE, type EmailLocale } from '../i18n/email-locale';
import { emailMessages } from '../i18n/messages';

export interface OrderEmailLine {
  productTitle: string;
  sku: string;
  quantity: number;
  unitPriceAmount: number;
  lineTotalAmount: number;
}

export interface OrderConfirmationInput {
  orderNumber: string;
  currency: string;
  subtotalAmount: number;
  discountAmount: number;
  shippingAmount: number;
  taxAmount: number;
  totalAmount: number;
  items: OrderEmailLine[];
  shippingAddress?: AddressLike | null;
  /** Render locale; defaults to the default locale when omitted. */
  locale?: EmailLocale;
}

export function renderOrderConfirmation(input: OrderConfirmationInput): RenderedEmail {
  const c = input.currency;
  const m = emailMessages(input.locale ?? DEFAULT_LOCALE).orderConfirmation;
  const subject = m.subject(input.orderNumber);

  const textLines = [
    m.textThanks,
    ``,
    `${m.orderLabel} ${input.orderNumber}`,
    ``,
    `${m.textItems}`,
    ...input.items.map(
      (i) =>
        `  ${i.quantity} x ${i.productTitle} (${i.sku}) — ${formatMoney(i.lineTotalAmount, c)}`,
    ),
    ``,
    `${m.labelSubtotal}: ${formatMoney(input.subtotalAmount, c)}`,
    ...(input.discountAmount > 0
      ? [`${m.labelDiscount}: -${formatMoney(input.discountAmount, c)}`]
      : []),
    `${m.labelShipping}: ${formatMoney(input.shippingAmount, c)}`,
    `${m.labelTax}: ${formatMoney(input.taxAmount, c)}`,
    `${m.labelTotal}: ${formatMoney(input.totalAmount, c)}`,
  ];
  const addr = addressLines(input.shippingAddress);
  if (addr.length > 0) {
    textLines.push('', `${m.shipTo}:`, ...addr.map((l) => `  ${l}`));
  }
  const text = textLines.join('\n');

  const rows = input.items
    .map(
      (i) =>
        `<tr>` +
        `<td style="padding:8px 0;border-bottom:1px solid #e4e4e7;">` +
        `${esc(i.quantity)} &times; ${esc(i.productTitle)}` +
        `<br><span style="color:#71717a;font-size:12px;">${esc(i.sku)}</span></td>` +
        `<td align="right" style="padding:8px 0;border-bottom:1px solid #e4e4e7;white-space:nowrap;">` +
        `${esc(formatMoney(i.lineTotalAmount, c))}</td></tr>`,
    )
    .join('');

  const totalRow = (label: string, value: string, strong = false) =>
    `<tr><td style="padding:4px 0;${strong ? 'font-weight:700;' : 'color:#3f3f46;'}">${esc(label)}</td>` +
    `<td align="right" style="padding:4px 0;${strong ? 'font-weight:700;' : ''}white-space:nowrap;">${esc(value)}</td></tr>`;

  const addrHtml =
    addr.length > 0
      ? `<h3 style="font-size:14px;margin:24px 0 8px;">${esc(m.shipTo)}</h3>` +
        `<p style="margin:0;color:#3f3f46;line-height:1.5;">${addr.map(esc).join('<br>')}</p>`
      : '';

  const body =
    `<h1 style="font-size:20px;margin:0 0 8px;">${esc(m.heading)}</h1>` +
    `<p style="margin:0 0 24px;color:#3f3f46;">${introHtml(m.intro(input.orderNumber), input.orderNumber)}</p>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">` +
    totalRow(m.labelSubtotal, formatMoney(input.subtotalAmount, c)) +
    (input.discountAmount > 0
      ? totalRow(m.labelDiscount, `-${formatMoney(input.discountAmount, c)}`)
      : '') +
    totalRow(m.labelShipping, formatMoney(input.shippingAmount, c)) +
    totalRow(m.labelTax, formatMoney(input.taxAmount, c)) +
    totalRow(m.labelTotal, formatMoney(input.totalAmount, c), true) +
    `</table>` +
    addrHtml;

  return { subject, text, html: wrapHtml(subject, body) };
}
