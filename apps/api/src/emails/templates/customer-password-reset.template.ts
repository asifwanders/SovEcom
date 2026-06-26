/**
 * Customer UNAUTH password-reset email.
 *
 * Sent to the customer's CURRENT address; clicking the single-use link opens the
 * storefront reset page (`?token=…`). This is a SECURITY email on the DIRECT mail
 * path (IMailService), NOT the order-bound EmailNotificationService/`email_type` enum
 * (security-sensitive mail is intentionally excluded there). FR/EN localized via the
 * shared email catalog. The reset URL carries a single-use token and must NEVER be logged.
 *
 * DISTINCT from the admin `sendPasswordReset` (EN-only, admin URL) — the customer flow
 * is localized and points at the storefront.
 */
import { esc, wrapHtml, type RenderedEmail } from './_layout';
import { DEFAULT_LOCALE, type EmailLocale } from '../i18n/email-locale';
import { emailMessages } from '../i18n/messages';

export interface CustomerPasswordResetInput {
  /** The single-use reset link (storefront reset page with `?token=…`). */
  resetUrl: string;
  /** Render locale; defaults to the default locale when omitted. */
  locale?: EmailLocale;
}

export function renderCustomerPasswordReset(input: CustomerPasswordResetInput): RenderedEmail {
  const m = emailMessages(input.locale ?? DEFAULT_LOCALE).customerPasswordReset;
  const subject = m.subject;

  const text = [m.intro, '', `${m.action}:`, input.resetUrl, '', m.disclaimer].join('\n');

  const body =
    `<h1 style="font-size:20px;margin:0 0 8px;">${esc(m.heading)}</h1>` +
    `<p style="margin:0 0 16px;color:#3f3f46;">${esc(m.intro)}</p>` +
    `<p style="margin:0 0 16px;"><a href="${esc(input.resetUrl)}">${esc(m.action)}</a></p>` +
    `<p style="margin:0;color:#71717a;font-size:13px;">${esc(m.disclaimer)}</p>`;

  return { subject, text, html: wrapHtml(subject, body) };
}
