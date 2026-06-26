/**
 * Email-change SECURITY NOTICE.
 *
 * Sent to the customer's CURRENT/OLD address (NOT the new one), so the legitimate
 * owner is alerted to a change they may not have made:
 *   - `requested`: a change to {newEmail} was requested (alert mid-flight); and
 *   - `confirmed`: the account email WAS changed to {newEmail} (post-swap).
 * On the DIRECT mail path (IMailService), NOT the order-bound dispatch. FR/EN localized
 * via the shared catalog. Carries NO token/link — it is informational only.
 */
import { esc, wrapHtml, type RenderedEmail } from './_layout';
import { DEFAULT_LOCALE, type EmailLocale } from '../i18n/email-locale';
import { emailMessages } from '../i18n/messages';

export type EmailChangeNoticeKind = 'requested' | 'confirmed';

export interface EmailChangeNoticeInput {
  kind: EmailChangeNoticeKind;
  /** The proposed/new address (shown to the owner — they benefit from seeing it). */
  newEmail: string;
  /** Render locale; defaults to the default locale when omitted. */
  locale?: EmailLocale;
}

export function renderEmailChangeNotice(input: EmailChangeNoticeInput): RenderedEmail {
  const m = emailMessages(input.locale ?? DEFAULT_LOCALE).emailChangeNotice[input.kind];
  const subject = m.subject;
  const intro = m.intro(input.newEmail);

  const text = [intro, '', m.disclaimer].join('\n');

  const body =
    `<h1 style="font-size:20px;margin:0 0 8px;">${esc(m.heading)}</h1>` +
    `<p style="margin:0 0 16px;color:#3f3f46;">${esc(intro)}</p>` +
    `<p style="margin:0;color:#71717a;font-size:13px;">${esc(m.disclaimer)}</p>`;

  return { subject, text, html: wrapHtml(subject, body) };
}
