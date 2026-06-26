/**
 * The mail transport seam. `MailService` holds ONE `MailTransport`
 * (or null when nothing is configured) and delegates `send` to it. Two implementations exist:
 * Brevo HTTP API and SMTP/nodemailer. Implementations MUST NEVER log the body, subject, or
 * any secret/API key.
 */

export interface OutgoingMail {
  from: string;
  to: string;
  subject: string;
  /** Plain-text body. */
  text: string;
  /** Optional HTML body. */
  html?: string;
}

export interface MailSendResult {
  /** Provider message id, when the transport returns one (traceability — no PII). */
  messageId?: string;
}

export interface MailTransport {
  /** Short transport name for diagnostics (`brevo` | `smtp`). Never includes secrets. */
  readonly name: string;
  send(mail: OutgoingMail): Promise<MailSendResult>;
}
