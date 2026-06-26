/**
 * E2E helpers for the customer credential flows (change-password,
 * change-email + confirm, forgot/reset). Companion to `helpers.ts` / `fixtures.ts`.
 *
 * DESIGN — self-contained, per-test throwaway customers (no shared-state drift):
 * the account `account.spec.ts` suite (tests 1–9) depends on the SHARED `e2e-account` seed
 * customer, so these credential tests must NEVER mutate it. Instead each credential test
 * REGISTERS a fresh, disposable customer via the API at test start (`registerThrowawayCustomer`),
 * captures its `id` (the Redis token-sink key is per-customer), and operates entirely on that
 * throwaway. The unique-email-per-test shape means reruns never collide.
 *
 * THE TOKEN SINKS: the C5/C3 services (`customer-reset.service.ts` / `customer-email.service.ts`)
 * mirror the PLAINTEXT single-use token to Redis ONLY when `NODE_ENV==='test'` AND the matching
 * sink flag is set (`RESET_TOKEN_SINK==='1'` → key `test:last-customer-reset-token:<id>` /
 * `EMAIL_CHANGE_TOKEN_SINK==='1'` → key `test:last-email-change-token:<id>`). This is test-infra
 * only — production can never expose the plaintext this way. We read the sink directly from Redis
 * (the SAME mechanism the integration harness uses, `h.redis.get(...)`) to drive the confirm/reset
 * link without scraping a real inbox.
 *
 * `skipIfNoSink` mirrors the existing `loginOrSkip` resilience philosophy: pointed at a non-test
 * stack (e.g. the prod VPS domain, where the sink flags are unset) the sink-dependent tests
 * `test.skip` with a clear reason instead of failing.
 */
import { test, type APIRequestContext } from '@playwright/test';
import Redis from 'ioredis';

/** The API base the storefront talks to (CI sets `NEXT_PUBLIC_API_BASE_URL`; default the local API). */
export function apiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000';
}

/** The Redis URL the API + sinks use (CI sets `REDIS_URL`; default the local dev container). */
function redisUrl(): string {
  return process.env.REDIS_URL ?? 'redis://localhost:6379';
}

/**
 * True only when BOTH token sinks are active (i.e. the API runs with `NODE_ENV=test` and both sink
 * flags set — the CI `storefront-e2e` job, or a local test-mode stack). Pointed at a prod-mode
 * stack (the VPS domain) the flags are unset, so the sink-dependent tests skip instead of failing.
 * We require BOTH flags (not just one) so a local run that sets only one would SKIP cleanly rather
 * than fail test B with a confusing null-token error (the reset flow keys off RESET_TOKEN_SINK, the
 * email-change flow off EMAIL_CHANGE_TOKEN_SINK — both must be on for the suite to exercise fully).
 */
export function sinksEnabled(): boolean {
  return process.env.RESET_TOKEN_SINK === '1' && process.env.EMAIL_CHANGE_TOKEN_SINK === '1';
}

/**
 * Guard for the sink-dependent tests. When the sinks are NOT enabled (non-test stack / VPS domain)
 * `test.skip` with a clear reason so the suite stays green. Mirrors `loginOrSkip`'s empty-stack
 * posture. Call as the FIRST line of a sink-dependent test.
 */
export function skipIfNoSink(): void {
  test.skip(
    !sinksEnabled(),
    'Token sinks disabled (set NODE_ENV=test + RESET_TOKEN_SINK=1 + EMAIL_CHANGE_TOKEN_SINK=1) — ' +
      'credential token-read flows not exercised on this stack.',
  );
}

/** A registered throwaway customer: its login credentials + the id that keys the Redis token sink. */
export interface ThrowawayCustomer {
  email: string;
  password: string;
  id: string;
}

/**
 * A fixed, strong password that passes the min-12 + breached-denylist policy for ALL throwaways.
 * Includes a symbol (like NEW_PASSWORD / RESET_PASSWORD) as policy insurance: if the password policy
 * ever adds a symbol-class requirement, a symbol-less value would 500 EVERY throwaway registration and
 * redden the whole suite at registration. The symbol pre-empts that.
 */
export const THROWAWAY_PASSWORD = 'E2e-Cred-Pass-2026!';

/** A short, unique-per-call token for throwaway emails (timestamp + random — collision-free across reruns). */
function uniqueSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Register a fresh, disposable customer via the PUBLIC store register endpoint and return its
 * login credentials + `id`. The id keys the per-customer Redis token sink, so each test reads
 * ONLY its own token. Throws if the register does not return 201 (a misconfigured API stack — fail
 * loudly so the test reports the real cause rather than a downstream timeout).
 *
 * Uses Playwright's `request` (APIRequestContext) against the API base directly — independent of
 * the browser session, so it works before any login.
 */
export async function registerThrowawayCustomer(
  request: APIRequestContext,
  opts: { emailPrefix: string },
): Promise<ThrowawayCustomer> {
  const email = `${opts.emailPrefix}-${uniqueSuffix()}@test.local`;
  const res = await request.post(`${apiBaseUrl()}/store/v1/customers`, {
    data: {
      email,
      password: THROWAWAY_PASSWORD,
      isB2b: false,
      acceptsMarketing: false,
    },
  });
  if (res.status() !== 201) {
    const body = await res.text().catch(() => '<unreadable body>');
    throw new Error(
      `registerThrowawayCustomer: expected 201 from POST /store/v1/customers, got ${res.status()} — ${body}`,
    );
  }
  const view = (await res.json()) as { id?: string };
  if (typeof view.id !== 'string' || view.id === '') {
    throw new Error('registerThrowawayCustomer: register response had no `id`');
  }
  return { email, password: THROWAWAY_PASSWORD, id: view.id };
}

/**
 * Poll a Redis key (the sink write is fire-and-forget-adjacent — it lands just after the 2xx
 * response) and return its value, or null if absent after the poll window (25×200ms ≈ 5s — generous
 * so a momentarily-slow sink write doesn't read null prematurely). Opens a dedicated connection and
 * ALWAYS closes it (the connection is test-infra, not a leak). `lazyConnect` keeps the constructor
 * from connecting until the first command, so a quit on an unused client is clean.
 *
 * The `get` is wrapped in try/catch INSIDE the loop so a single transient Redis blip (a dropped
 * connection, a momentary timeout) doesn't abort the whole poll — we just keep polling. A real
 * "token never arrived" still resolves to null after the window, and the caller asserts truthiness
 * with a clear message.
 */
async function readSink(key: string): Promise<string | null> {
  const redis = new Redis(redisUrl(), { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    for (let i = 0; i < 25; i += 1) {
      try {
        const value = await redis.get(key);
        if (value !== null) return value;
      } catch {
        // Transient Redis error — swallow and keep polling; a persistent failure still times out to null.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  } finally {
    // `quit` rejects if never connected; swallow so a missing-token path still cleans up.
    await redis.quit().catch(() => undefined);
  }
}

/** Read the test-only plaintext password-reset token mirrored to Redis (`forgot` → this key). */
export function readResetTokenSink(customerId: string): Promise<string | null> {
  return readSink(`test:last-customer-reset-token:${customerId}`);
}

/** Read the test-only plaintext email-change token mirrored to Redis (`email/change` → this key). */
export function readEmailChangeTokenSink(customerId: string): Promise<string | null> {
  return readSink(`test:last-email-change-token:${customerId}`);
}
