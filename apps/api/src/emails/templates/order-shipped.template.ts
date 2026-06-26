/**
 * order shipped email (`order.shipped`).
 * FR/EN localized via the email catalog.
 */
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

export interface OrderShippedInput {
  orderNumber: string;
  shippingAddress?: AddressLike | null;
  /** Render locale; defaults to the default locale when omitted. */
  locale?: EmailLocale;
}

export function renderOrderShipped(input: OrderShippedInput): RenderedEmail {
  const m = emailMessages(input.locale ?? DEFAULT_LOCALE).orderShipped;
  const subject = m.subject(input.orderNumber);
  const addr = addressLines(input.shippingAddress);

  const textLines = [m.textGoodNews, ``, `${m.orderLabel} ${input.orderNumber}`];
  if (addr.length > 0) {
    textLines.push('', `${m.shipTo}:`, ...addr.map((l) => `  ${l}`));
  }
  const text = textLines.join('\n');

  const addrHtml =
    addr.length > 0
      ? `<h3 style="font-size:14px;margin:24px 0 8px;">${esc(m.shipTo)}</h3>` +
        `<p style="margin:0;color:#3f3f46;line-height:1.5;">${addr.map(esc).join('<br>')}</p>`
      : '';

  const body =
    `<h1 style="font-size:20px;margin:0 0 8px;">${esc(m.heading)}</h1>` +
    `<p style="margin:0 0 16px;color:#3f3f46;">${introHtml(m.intro(input.orderNumber), input.orderNumber)}</p>` +
    addrHtml;

  return { subject, text, html: wrapHtml(subject, body) };
}
