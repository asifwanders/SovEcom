import { Injectable, Logger } from '@nestjs/common';
import type { MailTransport, MailSendResult } from './transports/mail-transport.interface';
import { createBrevoTransport } from './transports/brevo.transport';
import { createSmtpTransport } from './transports/smtp.transport';
import type { EmailLocale } from '../emails/i18n/email-locale';
import { renderEmailChangeVerification } from '../emails/templates/email-change-verification.template';
import {
  renderEmailChangeNotice,
  type EmailChangeNoticeKind,
} from '../emails/templates/email-change-notice.template';
import { renderCustomerPasswordReset } from '../emails/templates/customer-password-reset.template';

/** DI token for {@link IMailService} so tests can inject a mock transport. */
export const MAIL_SERVICE = Symbol('MAIL_SERVICE');

export interface SendMailOptions {
  to: string;
  subject: string;
  /** Plain-text body. */
  text: string;
  /** Optional HTML body. */
  html?: string;
}

/**
 * Mail seam.
 *
 * `send` resolves to a {@link MailSendResult} (the provider message id when available) so
 * the email-log can record it. Implementations MUST NEVER log the body, subject, recipient,
 * or any secret/API key. The interface + {@link MAIL_SERVICE} token make it trivially
 * mockable in tests.
 */
export interface IMailService {
  send(opts: SendMailOptions): Promise<MailSendResult>;
  sendPasswordReset(to: string, resetUrl: string): Promise<void>;
  /**
   * Verify-before-switch email change. Sent to the NEW (pending) address;
   * `verifyUrl` carries a single-use token (NEVER logged). The `locale` picks the
   * FR/EN catalog (resolved from `customers.locale` by the caller).
   */
  sendEmailChangeVerification(
    toNewEmail: string,
    verifyUrl: string,
    locale: EmailLocale,
  ): Promise<void>;
  /**
   * Email-change SECURITY NOTICE to the customer's CURRENT/OLD address.
   * `kind='requested'` alerts mid-flight; `kind='confirmed'` (post-swap) tells the
   * previous owner the change went through. Carries no token/link — informational only.
   */
  sendEmailChangeNotice(
    toCurrentEmail: string,
    kind: EmailChangeNoticeKind,
    newEmail: string,
    locale: EmailLocale,
  ): Promise<void>;
  /**
   * Customer UNAUTH password reset. Sent to the customer's CURRENT address;
   * `resetUrl` carries a single-use token (NEVER logged) pointing at the storefront
   * reset page. The `locale` picks the FR/EN catalog (resolved from `customers.locale`
   * by the caller). DISTINCT from the admin EN-only `sendPasswordReset` (different URL
   * + localized).
   */
  sendCustomerPasswordReset(to: string, resetUrl: string, locale: EmailLocale): Promise<void>;
}

@Injectable()
export class MailService implements IMailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transport: MailTransport | null;
  private readonly from: string;

  constructor() {
    this.from = process.env.MAIL_FROM ?? 'no-reply@sovecom.local';
    // Prefer the Brevo HTTP API when configured (more reliable), else SMTP, else
    // no-op so the app boots in dev/test without mail (mirrors the STRIPE_CLIENT null seam).
    this.transport = createBrevoTransport() ?? createSmtpTransport();

    if (!this.transport) {
      this.logger.warn(
        'mail disabled — no BREVO_API_KEY or SMTP_HOST configured; emails will not be sent',
      );
    } else {
      this.logger.log(`mail transport: ${this.transport.name}`);
    }
  }

  async send(opts: SendMailOptions): Promise<MailSendResult> {
    if (!this.transport) {
      // Disabled: log NOTHING that could identify the recipient or leak content.
      this.logger.log('mail disabled — skipping send to <redacted recipient>');
      return {};
    }
    return this.transport.send({
      from: this.from,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
  }

  async sendPasswordReset(to: string, resetUrl: string): Promise<void> {
    // The reset URL carries the single-use token — it must never be logged.
    await this.send({
      to,
      subject: 'Reset your SovEcom password',
      text:
        `A password reset was requested for your account.\n\n` +
        `Open the link below to choose a new password. It expires in 1 hour.\n\n` +
        `${resetUrl}\n\n` +
        `If you did not request this, you can safely ignore this email.`,
      html:
        `<p>A password reset was requested for your account.</p>` +
        `<p>Click the button below to choose a new password. It expires in 1 hour.</p>` +
        `<p><a href="${resetUrl}">Reset password</a></p>` +
        `<p>If you did not request this, you can safely ignore this email.</p>`,
    });
  }

  async sendEmailChangeVerification(
    toNewEmail: string,
    verifyUrl: string,
    locale: EmailLocale,
  ): Promise<void> {
    // The verify URL carries the single-use token — it must never be logged.
    const { subject, text, html } = renderEmailChangeVerification({ verifyUrl, locale });
    await this.send({ to: toNewEmail, subject, text, html });
  }

  async sendEmailChangeNotice(
    toCurrentEmail: string,
    kind: EmailChangeNoticeKind,
    newEmail: string,
    locale: EmailLocale,
  ): Promise<void> {
    const { subject, text, html } = renderEmailChangeNotice({ kind, newEmail, locale });
    await this.send({ to: toCurrentEmail, subject, text, html });
  }

  async sendCustomerPasswordReset(
    to: string,
    resetUrl: string,
    locale: EmailLocale,
  ): Promise<void> {
    // The reset URL carries the single-use token — it must never be logged.
    const { subject, text, html } = renderCustomerPasswordReset({ resetUrl, locale });
    await this.send({ to, subject, text, html });
  }
}
