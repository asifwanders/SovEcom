import type { MailTransport, OutgoingMail, MailSendResult } from './mail-transport.interface';

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

/** Parse a `From` header into Brevo's `{ email, name? }` sender shape. */
function parseSender(from: string): { email: string; name?: string } {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  if (match) {
    const name = match[1]?.trim();
    return name ? { email: match[2]!.trim(), name } : { email: match[2]!.trim() };
  }
  return { email: from.trim() };
}

/**
 * Brevo transactional HTTP API transport. Chosen over SMTP when
 * `BREVO_API_KEY` is set (the doc's "API-based, more reliable than SMTP"). Returns `null` when
 * unconfigured so the caller falls through to SMTP / no-op.
 *
 * PRIVACY: we add NO open/click tracking params — operators must disable
 * account-level tracking (3.16 deliverability guide). The API key is NEVER logged. On error we
 * surface ONLY the HTTP status + Brevo's short `code` slug — never the response message/body
 * (which can echo the recipient address). Uses the Node global `fetch` (Node LTS ≥ 18).
 */
export function createBrevoTransport(): MailTransport | null {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    return null;
  }

  return {
    name: 'brevo',
    async send(mail: OutgoingMail): Promise<MailSendResult> {
      const res = await fetch(BREVO_ENDPOINT, {
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          sender: parseSender(mail.from),
          to: [{ email: mail.to }],
          subject: mail.subject,
          textContent: mail.text,
          htmlContent: mail.html,
        }),
      });

      if (!res.ok) {
        // Surface status + Brevo error CODE only (a slug like `invalid_parameter`); never the
        // message/body (it can contain the recipient address — PII).
        let code = '';
        try {
          const body: unknown = await res.json();
          if (body && typeof body === 'object' && 'code' in body) {
            code = String((body as { code: unknown }).code);
          }
        } catch {
          // non-JSON error body — ignore (do NOT echo raw text, may contain PII)
        }
        throw new Error(`Brevo API error ${res.status}${code ? ` (${code})` : ''}`);
      }

      let messageId: string | undefined;
      try {
        const body: unknown = await res.json();
        if (body && typeof body === 'object' && 'messageId' in body) {
          const id = (body as { messageId: unknown }).messageId;
          messageId = typeof id === 'string' ? id : undefined;
        }
      } catch {
        // success with no/blank body — fine, no message id
      }
      return { messageId };
    },
  };
}
