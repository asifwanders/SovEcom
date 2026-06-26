/**
 * refund issued email (`refund.issued`).
 * FR/EN localized via the email catalog.
 *
 * Only the prose is localized — the amount/currency (formatMoney, integer-cents) and the
 * credit-note reference are identical in every locale.
 */
import { formatMoney } from '../../common/money';
import { esc, introHtml, wrapHtml, type RenderedEmail } from './_layout';
import { DEFAULT_LOCALE, type EmailLocale } from '../i18n/email-locale';
import { emailMessages } from '../i18n/messages';

export interface RefundIssuedInput {
  orderNumber: string;
  amount: number;
  currency: string;
  /** Display reference of the credit note (`series-number`), when one was issued. */
  creditNoteReference?: string | null;
  /** Render locale; defaults to the default locale when omitted. */
  locale?: EmailLocale;
}

export function renderRefundIssued(input: RefundIssuedInput): RenderedEmail {
  const m = emailMessages(input.locale ?? DEFAULT_LOCALE).refundIssued;
  const amountStr = formatMoney(input.amount, input.currency);
  const subject = m.subject(input.orderNumber);

  const textLines = [
    m.textIntro,
    ``,
    `${m.orderLabel} ${input.orderNumber}`,
    `${m.refundAmount}: ${amountStr}`,
  ];
  if (input.creditNoteReference) {
    textLines.push(`${m.creditNote}: ${input.creditNoteReference}`);
  }
  textLines.push('', m.disclaimer);
  const text = textLines.join('\n');

  const creditNoteHtml = input.creditNoteReference
    ? `<p style="margin:0 0 8px;color:#3f3f46;">${esc(m.creditNote)}: <strong>${esc(input.creditNoteReference)}</strong></p>`
    : '';

  const body =
    `<h1 style="font-size:20px;margin:0 0 8px;">${esc(m.heading)}</h1>` +
    `<p style="margin:0 0 8px;color:#3f3f46;">${introHtml(m.intro(input.orderNumber), input.orderNumber)}</p>` +
    `<p style="margin:0 0 8px;font-size:18px;font-weight:700;">${esc(amountStr)}</p>` +
    creditNoteHtml +
    `<p style="margin:16px 0 0;color:#71717a;font-size:13px;">${esc(m.disclaimer)}</p>`;

  return { subject, text, html: wrapHtml(subject, body) };
}
