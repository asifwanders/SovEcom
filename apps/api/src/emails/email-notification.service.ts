/**
 * EmailNotificationService: send a composed email with inline
 * retry, then record ONE `email_logs` row with the final outcome. Also drives admin resend.
 *
 * Listeners call {@link dispatch} (compose → send). The send loop tries up to {@link MAX_ATTEMPTS}
 * times with exponential backoff; whatever the result, exactly one log row is written (`sent` with
 * the provider message id, or `failed` with the transport error message — never any PII/secret).
 */
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { MAIL_SERVICE, type IMailService } from '../mail/mail.service';
import { EmailLogRepository } from './email-log.repository';
import { EmailComposer, type ComposeExtra, type ComposedEmail } from './email-composer.service';
import type { EmailLog } from '../database/schema/email_logs';
import type { EmailStatus, EmailType } from './email.types';

const MAX_ATTEMPTS = 3;

@Injectable()
export class EmailNotificationService {
  private readonly logger = new Logger(EmailNotificationService.name);
  private readonly retryBaseMs: number;

  constructor(
    @Inject(MAIL_SERVICE) private readonly mail: IMailService,
    private readonly logs: EmailLogRepository,
    private readonly composer: EmailComposer,
  ) {
    const raw = Number(process.env.EMAIL_RETRY_BASE_MS);
    this.retryBaseMs = Number.isFinite(raw) && raw >= 0 ? raw : 200;
  }

  /** Compose `type` for the order then send + log. Best-effort: a missing source row just no-ops. */
  async dispatch(
    tenantId: string,
    type: EmailType,
    orderId: string,
    referenceId: string | null,
    extra?: ComposeExtra,
  ): Promise<EmailLog | null> {
    const composed = await this.composer.compose(tenantId, type, orderId, referenceId, extra);
    if (!composed) return null;
    return this.send(tenantId, composed);
  }

  /**
   * Admin resend: re-render from the original log's `order_id`+`type`+`reference_id` (no stored
   * body) and send again, writing a fresh log row. Tenant-scoped (no cross-tenant IDOR).
   */
  async resend(tenantId: string, logId: string): Promise<EmailLog> {
    const original = await this.logs.findById(tenantId, logId);
    if (!original) throw new NotFoundException(`Email log ${logId} not found`);
    if (!original.orderId) {
      throw new UnprocessableEntityException('This email cannot be resent (no source order)');
    }
    const composed = await this.composer.compose(
      tenantId,
      original.type,
      original.orderId,
      original.referenceId,
    );
    if (!composed) {
      throw new UnprocessableEntityException('Source data for this email is no longer available');
    }
    return this.send(tenantId, composed);
  }

  /** Send with retry, then persist the outcome as one `email_logs` row. */
  private async send(tenantId: string, composed: ComposedEmail): Promise<EmailLog> {
    let attempts = 0;
    let status: EmailStatus = 'failed';
    let messageId: string | undefined;
    let lastError: unknown;

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      attempts++;
      try {
        const res = await this.mail.send({
          to: composed.recipient,
          subject: composed.rendered.subject,
          text: composed.rendered.text,
          html: composed.rendered.html,
        });
        messageId = res.messageId;
        status = 'sent';
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        if (i < MAX_ATTEMPTS - 1 && this.retryBaseMs > 0) {
          await this.sleep(this.retryBaseMs * 2 ** i);
        }
      }
    }

    if (status === 'failed') {
      // Log the type + attempt count ONLY — never the recipient/subject/body.
      this.logger.warn(`email ${composed.type} failed after ${attempts} attempt(s)`);
    }

    return this.logs.insert({
      tenantId,
      orderId: composed.orderId,
      referenceId: composed.referenceId,
      recipient: composed.recipient,
      type: composed.type,
      subject: composed.rendered.subject,
      status,
      attempts,
      error: status === 'failed' ? this.errorMessage(lastError) : null,
      providerMessageId: messageId ?? null,
      sentAt: status === 'sent' ? new Date() : null,
    });
  }

  /**
   * A short, PII-free error string for the log. Transports already sanitize (Fable BLOCKER-1), but
   * we ALSO scrub any email address here as belt-and-braces — a recipient copied into `error` would
   * otherwise survive the planned RGPD scrub of the `recipient` column. Capped at 500.
   */
  private errorMessage(err: unknown): string {
    const raw = err instanceof Error ? err.message : 'unknown send error';
    const scrubbed = raw.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
    return scrubbed.length > 500 ? scrubbed.slice(0, 500) : scrubbed;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
