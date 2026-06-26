import { createTransport, type Transporter } from 'nodemailer';
import type { MailTransport, OutgoingMail, MailSendResult } from './mail-transport.interface';

/**
 * Sanitize an SMTP/nodemailer send error to a PII-free string.
 *
 * nodemailer embeds the SERVER RESPONSE verbatim in `err.message` — and on a rejected
 * recipient that response contains the recipient address (`550 5.1.1 <buyer@x>: User unknown`).
 * That string is persisted into `email_logs.error`, where a copy of the recipient would
 * survive the RGPD scrub of the `recipient` column. So we surface ONLY the structured,
 * address-free codes the error carries (`responseCode` / `code` / `command`), never the message.
 */
function sanitizeSmtpError(err: unknown): Error {
  const e = (err ?? {}) as { responseCode?: unknown; code?: unknown; command?: unknown };
  const parts: string[] = [];
  if (typeof e.responseCode === 'number') parts.push(String(e.responseCode));
  if (typeof e.code === 'string') parts.push(`(${e.code})`);
  if (typeof e.command === 'string') parts.push(`cmd ${e.command}`);
  return new Error(`SMTP error${parts.length ? ` ${parts.join(' ')}` : ''}`);
}

/**
 * SMTP transport (nodemailer). The original `MailService` behaviour, extracted. Reads
 * `SMTP_*` env; returns `null` when `SMTP_HOST` is absent so the caller can fall through
 * to no-op (dev/test). `user`/`pass` are optional (IP-allowlisted relays) but both must be
 * present together to enable auth. nodemailer's own logging is OFF (a message could contain
 * a reset URL / order PII). Send errors are sanitized to PII-free codes.
 */
export function createSmtpTransport(): MailTransport | null {
  const host = process.env.SMTP_HOST;
  if (!host) {
    return null;
  }
  const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  const transporter: Transporter = createTransport({
    host,
    port,
    secure: port === 465,
    auth: user && pass ? { user, pass } : undefined,
    logger: false,
    debug: false,
  });

  return {
    name: 'smtp',
    async send(mail: OutgoingMail): Promise<MailSendResult> {
      try {
        const info = await transporter.sendMail({
          from: mail.from,
          to: mail.to,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        });
        return { messageId: typeof info.messageId === 'string' ? info.messageId : undefined };
      } catch (err) {
        // Re-throw a PII-free error — nodemailer's message embeds the rejected recipient.
        throw sanitizeSmtpError(err);
      }
    },
  };
}
