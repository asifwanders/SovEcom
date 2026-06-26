/**
 * UNAUTH customer forgot-password + reset (integration,
 * AUTH/CREDENTIAL-CRITICAL).
 *
 * Two PUBLIC endpoints:
 *   - FORGOT `POST /store/v1/customers/forgot` `{ email }` → 202 ALWAYS (anti-enumeration
 *     / timing parity). For an ACTIVE customer it stashes a single-use token + sends the
 *     (localized) reset mail; for an unknown email it does nothing — but answers the SAME
 *     202 with NO token row. Rate-limited per destination-email (3/hr) + per source-IP
 *     (30/hr); over-cap → 429.
 *   - RESET `POST /store/v1/customers/reset` `{ token, newPassword }` → 204. Atomically
 *     consumes the single-use token, sets the new Argon2id hash, BUMPS token_version, and
 *     revokes ALL refresh families (logout everywhere — NO fresh family, the caller is
 *     unauthenticated). invalid/expired/used token or weak/breached password → 400.
 *
 * The contract:
 *   - forgot known email → 202 + token in the test sink + a token row;
 *   - forgot UNKNOWN email → 202 + NO token row (no account-existence oracle);
 *   - per-email cap → 429 after 3; per-IP cap → 429 after 30;
 *   - reset with the sink token → 204 + passwordHash changed + token consumed + tv bumped
 *     + a pre-existing refresh family revoked (refresh now 401s);
 *   - reset breached password → 400; reset invalid/expired/used token → 400;
 *   - reset is single-use (a second reset with the same token → 400);
 *   - after reset: login with the NEW password → 200, with the OLD password → 401.
 *
 * The reset token plaintext is only emailed + (NODE_ENV=test only) mirrored to Redis via
 * the SAME RESET_TOKEN_SINK seam the admin uses (the key prefix differs) so this harness
 * can drive /reset.
 */
import request from 'supertest';
import {
  bootCustomersApp,
  teardownCustomersApp,
  resetCustomersState,
  signupAndLogin,
  rawCustomer,
  countLiveRefresh,
  auditRows,
  uniqEmail,
  extractRefreshCookie,
  STORE,
  CustomersHarness,
} from './_customers-harness';

const PW = 'correct horse battery staple';
const NEW_PW = 'a brand new strong passphrase';
const FORGOT = '/store/v1/customers/forgot';
const RESET = '/store/v1/customers/reset';

/** Read the test-only plaintext customer reset token mirrored to Redis. */
async function lastResetToken(h: CustomersHarness, customerId: string): Promise<string | null> {
  return h.redis.get(`test:last-customer-reset-token:${customerId}`);
}

/** Count token rows for a customer in customer_password_reset_tokens. */
async function resetTokenCount(h: CustomersHarness, customerId: string): Promise<number> {
  const rows = await h.client<{ n: string }[]>`
    select count(*)::int as n from customer_password_reset_tokens where customer_id = ${customerId}`;
  return Number(rows[0]!.n);
}

/** Poll `auditRows` until at least `min` rows for `action` exist (fire-and-forget audits). */
async function waitForAuditRows(
  h: CustomersHarness,
  action: string,
  min: number,
): Promise<Array<Record<string, unknown>>> {
  for (let i = 0; i < 40; i += 1) {
    const rows = await auditRows(h, action);
    if (rows.length >= min) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
  return auditRows(h, action);
}

describe('Customer forgot/reset password (unauth, integration, AUTH-CRITICAL)', () => {
  let h: CustomersHarness;
  beforeAll(async () => {
    process.env.RESET_TOKEN_SINK = '1';
    h = await bootCustomersApp();
  });
  afterAll(async () => {
    delete process.env.RESET_TOKEN_SINK;
    await teardownCustomersApp(h);
  });
  beforeEach(async () => {
    await resetCustomersState(h);
  });

  // ── FORGOT: anti-enumeration ─────────────────────────────────────────────────

  it('forgot known email → 202, mints a token (sink + a row)', async () => {
    const c = await signupAndLogin(h, { password: PW });
    const res = await request(h.http()).post(FORGOT).send({ email: c.email });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'accepted' });

    const token = await lastResetToken(h, c.customerId);
    expect(typeof token).toBe('string');
    expect(await resetTokenCount(h, c.customerId)).toBe(1);
  });

  it('forgot UNKNOWN email → 202 but NO token row (no account-existence oracle)', async () => {
    const res = await request(h.http()).post(FORGOT).send({ email: uniqEmail() });
    // Uniform 202 — identical to the known path, so no existence oracle.
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'accepted' });

    // No token row anywhere.
    const total = await h.client<{ n: string }[]>`
      select count(*)::int as n from customer_password_reset_tokens`;
    expect(Number(total[0]!.n)).toBe(0);
  });

  it('forgot rejects a malformed email (Zod) → 400', async () => {
    const res = await request(h.http()).post(FORGOT).send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  // ── FORGOT: rate-limit caps ──────────────────────────────────────────────────

  it('per-destination-email cap: the 4th forgot to the same email → 429', async () => {
    const c = await signupAndLogin(h, { password: PW });
    for (let i = 0; i < 3; i += 1) {
      const ok = await request(h.http()).post(FORGOT).send({ email: c.email });
      expect(ok.status).toBe(202);
    }
    const capped = await request(h.http()).post(FORGOT).send({ email: c.email });
    expect(capped.status).toBe(429);
  });

  it('per-source-IP cap: the 31st forgot from one IP (distinct emails) → 429', async () => {
    // 30 distinct unknown emails are allowed (each existence-independent); the 31st caps.
    for (let i = 0; i < 30; i += 1) {
      const ok = await request(h.http()).post(FORGOT).send({ email: uniqEmail() });
      expect(ok.status).toBe(202);
    }
    const capped = await request(h.http()).post(FORGOT).send({ email: uniqEmail() });
    expect(capped.status).toBe(429);
  });

  // ── RESET: happy path + session kill ─────────────────────────────────────────

  it('reset with the sink token → 204; password changed; token consumed; tv bumped; ALL sessions revoked', async () => {
    const c = await signupAndLogin(h, { password: PW });
    const before = await rawCustomer(h, c.customerId);
    const tvBefore = before!.token_version as number;
    const hashBefore = before!.password_hash as string;

    // The signed-in session has a live refresh family.
    expect(await countLiveRefresh(h, c.customerId)).toBeGreaterThanOrEqual(1);

    await request(h.http()).post(FORGOT).send({ email: c.email }).expect(202);
    const token = await lastResetToken(h, c.customerId);

    const res = await request(h.http()).post(RESET).send({ token, newPassword: NEW_PW });
    expect(res.status).toBe(204);

    const after = await rawCustomer(h, c.customerId);
    // Password hash rotated, token_version bumped.
    expect(after!.password_hash).not.toBe(hashBefore);
    expect(after!.token_version as number).toBe(tvBefore + 1);

    // Token consumed (single-use).
    const consumed = await h.client<{ consumed_at: string | null }[]>`
      select consumed_at from customer_password_reset_tokens where customer_id = ${c.customerId}`;
    expect(consumed[0]!.consumed_at).not.toBeNull();

    // ALL refresh families revoked (logout everywhere) — NO fresh family minted.
    expect(await countLiveRefresh(h, c.customerId)).toBe(0);

    // The pre-reset refresh cookie no longer rotates → 401.
    const refreshAttempt = await request(h.http())
      .post(STORE.refresh)
      .set('Cookie', c.refreshCookie)
      .set('Origin', 'https://store.test');
    expect(refreshAttempt.status).toBe(401);

    // Login with the NEW password works; the OLD password fails.
    const newLogin = await request(h.http())
      .post(STORE.login)
      .send({ email: c.email, password: NEW_PW });
    expect(newLogin.status).toBe(200);
    const oldLogin = await request(h.http())
      .post(STORE.login)
      .send({ email: c.email, password: PW });
    expect(oldLogin.status).toBe(401);
  });

  it('a reset-then-fresh-login chain logs the customer back in cleanly', async () => {
    const c = await signupAndLogin(h, { password: PW });
    await request(h.http()).post(FORGOT).send({ email: c.email }).expect(202);
    const token = await lastResetToken(h, c.customerId);
    await request(h.http()).post(RESET).send({ token, newPassword: NEW_PW }).expect(204);

    const login = await request(h.http())
      .post(STORE.login)
      .send({ email: c.email, password: NEW_PW });
    expect(login.status).toBe(200);
    // The fresh login mints a NEW live refresh family.
    expect(extractRefreshCookie(login)).not.toBe('');
    expect(await countLiveRefresh(h, c.customerId)).toBe(1);
  });

  // ── RESET: rejection paths ───────────────────────────────────────────────────

  it('reset with a breached/weak password → 400, nothing changed', async () => {
    const c = await signupAndLogin(h, { password: PW });
    await request(h.http()).post(FORGOT).send({ email: c.email }).expect(202);
    const token = await lastResetToken(h, c.customerId);

    // `password1234` is 12+ chars (passes the DTO) but is on the breached denylist.
    const res = await request(h.http()).post(RESET).send({ token, newPassword: 'password1234' });
    expect(res.status).toBe(400);

    // The token was NOT consumed (pre-check rejected before consume) and the password
    // is unchanged — the OLD password still logs in.
    const consumed = await h.client<{ consumed_at: string | null }[]>`
      select consumed_at from customer_password_reset_tokens where customer_id = ${c.customerId}`;
    expect(consumed[0]!.consumed_at).toBeNull();
    const oldLogin = await request(h.http())
      .post(STORE.login)
      .send({ email: c.email, password: PW });
    expect(oldLogin.status).toBe(200);
  });

  it('reset with a malformed token (Zod 43-char base64url) → 400', async () => {
    const res = await request(h.http())
      .post(RESET)
      .send({ token: 'not-a-real-token', newPassword: NEW_PW });
    expect(res.status).toBe(400);
  });

  it('reset with a well-formed but unknown token → 400', async () => {
    // 43-char base64url shape that matches no row.
    const res = await request(h.http())
      .post(RESET)
      .send({ token: 'A'.repeat(43), newPassword: NEW_PW });
    expect(res.status).toBe(400);
  });

  it('reset with an EXPIRED token → 400', async () => {
    const c = await signupAndLogin(h, { password: PW });
    await request(h.http()).post(FORGOT).send({ email: c.email }).expect(202);
    const token = await lastResetToken(h, c.customerId);

    // Force the stored token row to be expired.
    await h.client`
      update customer_password_reset_tokens set expires_at = now() - interval '1 minute'
      where customer_id = ${c.customerId}`;

    const res = await request(h.http()).post(RESET).send({ token, newPassword: NEW_PW });
    expect(res.status).toBe(400);
    // Unchanged — old password still works.
    const oldLogin = await request(h.http())
      .post(STORE.login)
      .send({ email: c.email, password: PW });
    expect(oldLogin.status).toBe(200);
  });

  it('reset is single-use: a second reset with the same token → 400', async () => {
    const c = await signupAndLogin(h, { password: PW });
    await request(h.http()).post(FORGOT).send({ email: c.email }).expect(202);
    const token = await lastResetToken(h, c.customerId);

    const first = await request(h.http()).post(RESET).send({ token, newPassword: NEW_PW });
    expect(first.status).toBe(204);
    const second = await request(h.http())
      .post(RESET)
      .send({ token, newPassword: 'yet another strong passphrase' });
    expect(second.status).toBe(400);
  });

  // ── Concurrent double-reset (F11): the conditional-UPDATE single-use lock ─────

  it('two concurrent resets with the SAME token: exactly one 204, one 400', async () => {
    const c = await signupAndLogin(h, { password: PW });
    await request(h.http()).post(FORGOT).send({ email: c.email }).expect(202);
    const token = await lastResetToken(h, c.customerId);

    const [a, b] = await Promise.all([
      request(h.http()).post(RESET).send({ token, newPassword: NEW_PW }),
      request(h.http()).post(RESET).send({ token, newPassword: NEW_PW }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([204, 400]);
  });

  // ── Audit ────────────────────────────────────────────────────────────────────

  it('forgot+reset write audit rows (requested + reset) with no plaintext email', async () => {
    const c = await signupAndLogin(h, { password: PW });
    await request(h.http()).post(FORGOT).send({ email: c.email }).expect(202);
    const token = await lastResetToken(h, c.customerId);
    await request(h.http()).post(RESET).send({ token, newPassword: NEW_PW }).expect(204);

    const requested = await waitForAuditRows(h, 'customer.password_reset_requested', 1);
    expect(requested.length).toBeGreaterThanOrEqual(1);
    const reset = await waitForAuditRows(h, 'customer.password_reset', 1);
    expect(reset.length).toBe(1);

    // No plaintext email or password in either row (salted hash only).
    const serialized = JSON.stringify([...requested, ...reset]);
    expect(serialized).not.toContain(c.email);
    expect(serialized).not.toContain(NEW_PW);
    expect(serialized).not.toContain(PW);
  });

  it('forgot UNKNOWN email still writes a requested audit row (anonymous actor; round-trip parity)', async () => {
    const unknown = uniqEmail();
    await request(h.http()).post(FORGOT).send({ email: unknown }).expect(202);
    const rows = await waitForAuditRows(h, 'customer.password_reset_requested', 1);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // Anonymous actor on the unknown branch.
    expect(rows.some((r) => r.actor_type === 'anonymous')).toBe(true);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(unknown);
  });

  // ── Cross-table isolation sanity ─────────────────────────────────────────────

  it('an erased customer cannot reset (the active-only consume update rolls back → 400)', async () => {
    const c = await signupAndLogin(h, { password: PW });
    await request(h.http()).post(FORGOT).send({ email: c.email }).expect(202);
    const token = await lastResetToken(h, c.customerId);

    // Soft-delete the customer directly (the consume UPDATE filters deleted_at IS NULL,
    // so this is enough to make the active-only update match no row → F5 rollback).
    await h.client`
      update customers set deleted_at = now()
      where id = ${c.customerId}`;

    const res = await request(h.http()).post(RESET).send({ token, newPassword: NEW_PW });
    expect(res.status).toBe(400);
    // The consume rolled back (F5): the token is NOT marked consumed.
    const consumed = await h.client<{ consumed_at: string | null }[]>`
      select consumed_at from customer_password_reset_tokens where customer_id = ${c.customerId}`;
    expect(consumed[0]!.consumed_at).toBeNull();
  });
});
