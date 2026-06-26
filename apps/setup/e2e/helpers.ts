/**
 * setup-wizard E2E helpers (scenario 1, fresh install).
 *
 * The one non-trivial helper is `readOtpFromMailhog`: the admin-account step emails a 6-digit OTP
 * that the API never logs or returns, so the spec reads it back from the mail sink the
 * SMTP step is pointed at. We poll MailHog's HTTP API for the latest message addressed to the owner
 * email and pull the code out of its body. Polling (not a single GET) because the SMTP send + MailHog
 * ingest is asynchronous relative to the `admin-account/start` HTTP response.
 */
import { expect, type APIRequestContext } from '@playwright/test';
import { MAILHOG_API_URL } from './fixtures';

interface MailhogMessage {
  Content: { Headers: Record<string, string[]>; Body: string };
}
interface MailhogList {
  total: number;
  items: MailhogMessage[];
}

/** Decode MailHog's quoted-printable body (soft line breaks + `=XX` hex) enough to find the OTP. */
function decodeQuotedPrintable(body: string): string {
  return body
    .replace(/=\r?\n/g, '') // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** True when any of a message's To headers contains `email` (case-insensitive). */
function isAddressedTo(msg: MailhogMessage, email: string): boolean {
  const to = msg.Content.Headers['To'] ?? [];
  return to.some((t) => t.toLowerCase().includes(email.toLowerCase()));
}

/**
 * Poll MailHog for the LATEST admin-account OTP emailed to `email`, returning the 6-digit code.
 * MailHog returns newest-first, so we scan in order and take the first matching, decoded body.
 */
export async function readOtpFromMailhog(
  request: APIRequestContext,
  email: string,
  { timeoutMs = 30_000, intervalMs = 1_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await request.get(`${MAILHOG_API_URL}/api/v2/messages`);
    if (res.ok()) {
      const list = (await res.json()) as MailhogList;
      lastSeen = list.total;
      for (const msg of list.items) {
        if (!isAddressedTo(msg, email)) continue;
        const body = decodeQuotedPrintable(msg.Content.Body);
        // Primary matches the exact template ("…verification code is: 123456"); the fallback is
        // scoped to a 6-digit run NEAR the word "code" (handles an HTML body where tags separate the
        // label from the digits) so it can't grab a stray 6-digit number elsewhere in the email.
        const m =
          body.match(/verification code is:\s*([0-9]{6})/i) ??
          body.match(/code[^0-9]{0,40}([0-9]{6})/i);
        if (m) return m[1];
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `No admin-account OTP email for ${email} arrived in MailHog within ${timeoutMs}ms ` +
          `(saw ${lastSeen} message(s) total at ${MAILHOG_API_URL}).`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Assert the live system reports installed=true via the always-reachable status endpoint. */
export async function expectInstalled(request: APIRequestContext, apiBase: string): Promise<void> {
  const res = await request.get(`${apiBase}/setup/v1/status`);
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { installed: boolean };
  expect(body.installed).toBe(true);
}
