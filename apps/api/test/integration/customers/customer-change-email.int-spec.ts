/**
 * Authenticated customer CHANGE-EMAIL (verify-before-switch)
 * (integration, AUTH/CREDENTIAL/PII-CRITICAL).
 *
 * Two endpoints:
 *   - INITIATE `POST /store/v1/customers/me/email/change` (CustomerAuthGuard, step-up)
 *     `{ newEmail, currentPassword }` → 202. Proves the password, then (free target
 *     only) stashes a single-use token + sets `customers.pending_email` + emails the
 *     verify link to the NEW address. The EMAIL itself is NOT switched yet.
 *   - CONFIRM `POST /store/v1/customers/me/email/confirm` (PUBLIC, token-auth)
 *     `{ token }` → 200. Atomically consumes the token and swaps `email`.
 *
 * The contract (no oracle anywhere):
 *   - wrong currentPassword → uniform 401, nothing stashed;
 *   - step-up rate-limited 5/60s, fails CLOSED (6th → 401);
 *   - newEmail === current → 400 (only reachable after the password is verified);
 *   - newEmail already taken by ANOTHER active customer → 202 but NO token / NO mail /
 *     NO pending_email (silent no-op — the partial-unique index is the real guard, and
 *     a uniform 202 is not an account-existence oracle);
 *   - confirm with invalid / expired / already-consumed token → 400 (single-use);
 *   - a NEW initiate invalidates the prior token (old link → 400 on confirm);
 *   - confirm unique-violation race (target taken between initiate+confirm) → 409,
 *     token consumed;
 *   - confirm does NOT revoke the session (no token_version bump): an access token
 *     minted before confirm still works after;
 *   - RGPD self-erase nulls pending_email + consumes outstanding tokens.
 *
 * The verification token plaintext is only emailed + (NODE_ENV=test only) mirrored to
 * Redis via the EMAIL_CHANGE_TOKEN_SINK seam so this harness can drive /confirm.
 */
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import {
  bootCustomersApp,
  teardownCustomersApp,
  resetCustomersState,
  signupAndLogin,
  rawCustomer,
  auditRows,
  uniqEmail,
  DEFAULT_TENANT_ID,
  STORE,
  STORE_ORIGIN,
  CustomersHarness,
} from './_customers-harness';

const PW = 'correct horse battery staple';
const WRONG_PW = 'definitely not the password';
const INITIATE = '/store/v1/customers/me/email/change';
const CONFIRM = '/store/v1/customers/me/email/confirm';

/** Read the test-only plaintext email-change token mirrored to Redis. */
async function lastEmailChangeToken(
  h: CustomersHarness,
  customerId: string,
): Promise<string | null> {
  return h.redis.get(`test:last-email-change-token:${customerId}`);
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

/** Seed an extra ACTIVE customer directly (SELECT-guard, partial unique index). */
async function seedActiveCustomer(h: CustomersHarness, email: string): Promise<string> {
  const id = uuidv7();
  const existing = await h.client<{ id: string }[]>`
    select id from customers
    where tenant_id = ${DEFAULT_TENANT_ID} and email = ${email}
      and deleted_at is null and anonymized_at is null
    limit 1`;
  if (existing[0]) return existing[0].id;
  await h.client`
    insert into customers (id, tenant_id, email, password_hash, name)
    values (${id}, ${DEFAULT_TENANT_ID}, ${email}, ${null}, ${'Seeded'})`;
  return id;
}

describe('Customer change-email (verify-before-switch, integration, AUTH/PII-CRITICAL)', () => {
  let h: CustomersHarness;
  beforeAll(async () => {
    process.env.EMAIL_CHANGE_TOKEN_SINK = '1';
    h = await bootCustomersApp();
  });
  afterAll(async () => {
    delete process.env.EMAIL_CHANGE_TOKEN_SINK;
    await teardownCustomersApp(h);
  });
  beforeEach(async () => {
    await resetCustomersState(h);
  });

  // ── Rejection paths (INITIATE) ───────────────────────────────────────────────

  it('wrong currentPassword → uniform 401, no token, no pending_email', async () => {
    const c = await signupAndLogin(h, { password: PW });
    const res = await request(h.http())
      .post(INITIATE)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ newEmail: uniqEmail(), currentPassword: WRONG_PW });
    expect(res.status).toBe(401);

    expect(await lastEmailChangeToken(h, c.customerId)).toBeNull();
    const row = await rawCustomer(h, c.customerId);
    expect(row!.pending_email).toBeNull();
    expect(row!.email).toBe(c.email);
  });

  it('rate-limits the step-up: the 6th attempt is 401 even with the correct password', async () => {
    const c = await signupAndLogin(h, { password: PW });
    for (let i = 0; i < 6; i += 1) {
      const res = await request(h.http())
        .post(INITIATE)
        .set('Authorization', `Bearer ${c.accessToken}`)
        .send({ newEmail: uniqEmail(), currentPassword: WRONG_PW });
      expect(res.status).toBe(401);
    }
    const blocked = await request(h.http())
      .post(INITIATE)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ newEmail: uniqEmail(), currentPassword: PW });
    expect(blocked.status).toBe(401);
    const row = await rawCustomer(h, c.customerId);
    expect(row!.pending_email).toBeNull();
  });

  it('rejects an unauthenticated initiate (CustomerAuthGuard) → 401', async () => {
    const res = await request(h.http())
      .post(INITIATE)
      .send({ newEmail: uniqEmail(), currentPassword: PW });
    expect(res.status).toBe(401);
  });

  it('newEmail === current (case-insensitive) → 400, no token, email unchanged', async () => {
    const c = await signupAndLogin(h, { password: PW });
    const res = await request(h.http())
      .post(INITIATE)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ newEmail: c.email.toUpperCase(), currentPassword: PW });
    expect(res.status).toBe(400);
    expect(await lastEmailChangeToken(h, c.customerId)).toBeNull();
    const row = await rawCustomer(h, c.customerId);
    expect(row!.pending_email).toBeNull();
  });

  it('rejects a malformed newEmail (Zod) → 400', async () => {
    const c = await signupAndLogin(h, { password: PW });
    const res = await request(h.http())
      .post(INITIATE)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ newEmail: 'not-an-email', currentPassword: PW });
    expect(res.status).toBe(400);
  });

  // ── No account-existence oracle: target already taken ────────────────────────

  it('newEmail already taken by another active customer → 202 but NO token, NO pending_email (no oracle)', async () => {
    const c = await signupAndLogin(h, { password: PW });
    const taken = uniqEmail();
    await seedActiveCustomer(h, taken);

    const res = await request(h.http())
      .post(INITIATE)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ newEmail: taken, currentPassword: PW });
    // Uniform 202 — identical to the happy path, so no existence oracle.
    expect(res.status).toBe(202);

    // …but nothing was stashed and no mail can be sent.
    expect(await lastEmailChangeToken(h, c.customerId)).toBeNull();
    const row = await rawCustomer(h, c.customerId);
    expect(row!.pending_email).toBeNull();
    expect(row!.email).toBe(c.email);
    const tokenCount = await h.client<{ n: string }[]>`
      select count(*)::int as n from email_change_tokens where customer_id = ${c.customerId}`;
    expect(Number(tokenCount[0]!.n)).toBe(0);
  });

  // ── Happy path: initiate → confirm → swap ────────────────────────────────────

  it('happy path: initiate 202 sets pending_email + token; confirm 200 swaps email and clears pending', async () => {
    const c = await signupAndLogin(h, { password: PW });
    const newEmail = uniqEmail();

    const init = await request(h.http())
      .post(INITIATE)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ newEmail, currentPassword: PW });
    expect(init.status).toBe(202);

    // Pending mirror is set; the live email is NOT switched yet.
    const mid = await rawCustomer(h, c.customerId);
    expect(mid!.pending_email).toBe(newEmail);
    expect(mid!.email).toBe(c.email);

    const token = await lastEmailChangeToken(h, c.customerId);
    expect(typeof token).toBe('string');

    const confirm = await request(h.http()).post(CONFIRM).send({ token });
    expect(confirm.status).toBe(200);

    const after = await rawCustomer(h, c.customerId);
    expect(after!.email).toBe(newEmail);
    expect(after!.pending_email).toBeNull();

    // The token row is consumed (single-use).
    const consumed = await h.client<{ consumed_at: string | null }[]>`
      select consumed_at from email_change_tokens where customer_id = ${c.customerId}`;
    expect(consumed[0]!.consumed_at).not.toBeNull();

    // The customer can now log in with the NEW email (not the old one).
    const newLogin = await request(h.http())
      .post(STORE.login)
      .send({ email: newEmail, password: PW });
    expect(newLogin.status).toBe(200);
    const oldLogin = await request(h.http())
      .post(STORE.login)
      .send({ email: c.email, password: PW });
    expect(oldLogin.status).toBe(401);
  });

  // ── Confirm rejection / single-use ───────────────────────────────────────────

  it('confirm with an invalid token → 400, email unchanged', async () => {
    const c = await signupAndLogin(h, { password: PW });
    const res = await request(h.http()).post(CONFIRM).send({ token: 'not-a-real-token' });
    expect(res.status).toBe(400);
    const row = await rawCustomer(h, c.customerId);
    expect(row!.email).toBe(c.email);
  });

  it('confirm is single-use: a second confirm with the same token → 400', async () => {
    const c = await signupAndLogin(h, { password: PW });
    const newEmail = uniqEmail();
    await request(h.http())
      .post(INITIATE)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ newEmail, currentPassword: PW })
      .expect(202);
    const token = await lastEmailChangeToken(h, c.customerId);

    const first = await request(h.http()).post(CONFIRM).send({ token });
    expect(first.status).toBe(200);
    const second = await request(h.http()).post(CONFIRM).send({ token });
    expect(second.status).toBe(400);
  });

  it('confirm with an EXPIRED token → 400', async () => {
    const c = await signupAndLogin(h, { password: PW });
    const newEmail = uniqEmail();
    await request(h.http())
      .post(INITIATE)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ newEmail, currentPassword: PW })
      .expect(202);
    const token = await lastEmailChangeToken(h, c.customerId);

    // Force the stored token row to be expired.
    await h.client`
      update email_change_tokens set expires_at = now() - interval '1 minute'
      where customer_id = ${c.customerId}`;

    const res = await request(h.http()).post(CONFIRM).send({ token });
    expect(res.status).toBe(400);
    const row = await rawCustomer(h, c.customerId);
    expect(row!.email).toBe(c.email);
  });

  it('a NEW initiate invalidates the PRIOR token (old link → 400 on confirm)', async () => {
    const c = await signupAndLogin(h, { password: PW });

    const firstEmail = uniqEmail();
    await request(h.http())
      .post(INITIATE)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ newEmail: firstEmail, currentPassword: PW })
      .expect(202);
    const oldToken = await lastEmailChangeToken(h, c.customerId);

    // Second initiate to a DIFFERENT address — must invalidate the first token.
    const secondEmail = uniqEmail();
    await request(h.http())
      .post(INITIATE)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ newEmail: secondEmail, currentPassword: PW })
      .expect(202);
    const newToken = await lastEmailChangeToken(h, c.customerId);
    expect(newToken).not.toBe(oldToken);

    // The OLD link no longer works.
    const stale = await request(h.http()).post(CONFIRM).send({ token: oldToken });
    expect(stale.status).toBe(400);

    // The NEW link works and swaps to the second address.
    const ok = await request(h.http()).post(CONFIRM).send({ token: newToken });
    expect(ok.status).toBe(200);
    const row = await rawCustomer(h, c.customerId);
    expect(row!.email).toBe(secondEmail);
  });

  // ── Confirm unique-violation race ────────────────────────────────────────────

  it('confirm unique-violation race (target taken between initiate+confirm) → 409, token consumed', async () => {
    const c = await signupAndLogin(h, { password: PW });
    const newEmail = uniqEmail();

    await request(h.http())
      .post(INITIATE)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ newEmail, currentPassword: PW })
      .expect(202);
    const token = await lastEmailChangeToken(h, c.customerId);

    // Someone else takes the pending email AFTER initiate but BEFORE confirm.
    await seedActiveCustomer(h, newEmail);

    const res = await request(h.http()).post(CONFIRM).send({ token });
    expect(res.status).toBe(409);

    // The original email is untouched, but the token is consumed (can't be retried).
    const row = await rawCustomer(h, c.customerId);
    expect(row!.email).toBe(c.email);
    const consumed = await h.client<{ consumed_at: string | null }[]>`
      select consumed_at from email_change_tokens where customer_id = ${c.customerId}`;
    expect(consumed[0]!.consumed_at).not.toBeNull();

    // A retry with the same (now consumed) token → 400.
    const retry = await request(h.http()).post(CONFIRM).send({ token });
    expect(retry.status).toBe(400);
  });

  // ── Session is NOT revoked by confirm ────────────────────────────────────────

  it('confirm does NOT revoke the session: an access token minted before confirm still works after', async () => {
    const c = await signupAndLogin(h, { password: PW });
    const newEmail = uniqEmail();

    await request(h.http())
      .post(INITIATE)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ newEmail, currentPassword: PW })
      .expect(202);
    const token = await lastEmailChangeToken(h, c.customerId);

    const before = await rawCustomer(h, c.customerId);
    const tvBefore = before!.token_version;

    await request(h.http()).post(CONFIRM).send({ token }).expect(200);

    // token_version is unchanged (no session-kill).
    const after = await rawCustomer(h, c.customerId);
    expect(after!.token_version).toBe(tvBefore);

    // The PRE-confirm access token still reaches /me and reflects the NEW email
    // (the guard re-reads the row, so there is no stale email claim in the JWT).
    const me = await request(h.http())
      .get(STORE.me)
      .set('Authorization', `Bearer ${c.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(newEmail);
  });

  // ── Audit ────────────────────────────────────────────────────────────────────

  it('writes email_change_requested + email_change_confirmed audit rows with no plaintext email', async () => {
    const c = await signupAndLogin(h, { password: PW });
    const newEmail = uniqEmail();

    await request(h.http())
      .post(INITIATE)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ newEmail, currentPassword: PW })
      .expect(202);
    const token = await lastEmailChangeToken(h, c.customerId);
    await request(h.http()).post(CONFIRM).send({ token }).expect(200);

    // Audits are fire-and-forget (post-commit, F4) so they may land just after the
    // response — poll briefly for each.
    const requested = await waitForAuditRows(h, 'customer.email_change_requested', 1);
    expect(requested.length).toBe(1);
    const confirmed = await waitForAuditRows(h, 'customer.email_change_confirmed', 1);
    expect(confirmed.length).toBe(1);

    // The NEW email is never stored in plaintext in either row (salted hash only).
    const serialized = JSON.stringify([...requested, ...confirmed]);
    expect(serialized).not.toContain(newEmail);
    expect(serialized).not.toContain(PW);
  });

  // ── Same-Origin CSRF posture on the public confirm is irrelevant (no cookie) ──
  // The confirm endpoint carries no session/cookie — the token IS the credential —
  // so it has no Origin/CSRF gate. A foreign Origin must still confirm (it's public).
  it('confirm is public: a foreign Origin still confirms (token is the credential)', async () => {
    const c = await signupAndLogin(h, { password: PW });
    const newEmail = uniqEmail();
    await request(h.http())
      .post(INITIATE)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ newEmail, currentPassword: PW })
      .expect(202);
    const token = await lastEmailChangeToken(h, c.customerId);

    const res = await request(h.http())
      .post(CONFIRM)
      .set('Origin', 'https://evil.example')
      .send({ token });
    expect(res.status).toBe(200);
    // STORE_ORIGIN is pinned by the harness (sanity reference, unused here).
    expect(STORE_ORIGIN).toBe('https://store.test');
  });

  // ── Concurrent double-confirm (F11): the conditional-UPDATE single-use lock ──────

  it('two concurrent confirms with the SAME token: exactly one 200 (swap), one 400', async () => {
    const c = await signupAndLogin(h, { password: PW });
    const newEmail = uniqEmail();
    await request(h.http())
      .post(INITIATE)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ newEmail, currentPassword: PW })
      .expect(202);
    const token = await lastEmailChangeToken(h, c.customerId);

    // Fire both confirms at once — the atomic `UPDATE … WHERE consumed_at IS NULL`
    // is the single-use lock, so exactly one must win.
    const [a, b] = await Promise.all([
      request(h.http()).post(CONFIRM).send({ token }),
      request(h.http()).post(CONFIRM).send({ token }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);

    // The swap happened exactly once.
    const row = await rawCustomer(h, c.customerId);
    expect(row!.email).toBe(newEmail);
    expect(row!.pending_email).toBeNull();
  });

  // ── DB-level case-insensitive active-email uniqueness ──

  it('functional lower(email) unique index: a case-variant active email raises a unique violation', async () => {
    const base = uniqEmail(); // already lower-case
    await seedActiveCustomer(h, base);

    // Inserting a SECOND active customer whose email differs only in case must violate
    // customers_tenant_email_active_uq (now ON (tenant_id, lower(email))).
    const variant = base.toUpperCase();
    await expect(
      h.client`
        insert into customers (id, tenant_id, email, password_hash, name)
        values (${uuidv7()}, ${DEFAULT_TENANT_ID}, ${variant}, ${null}, ${'Variant'})`,
    ).rejects.toMatchObject({ code: '23505' });

    // Sanity: a deleted/anonymized row does NOT block (partial WHERE) — soft-delete the
    // original then the case-variant insert succeeds.
    const orig = await h.client<{ id: string }[]>`
      select id from customers where tenant_id = ${DEFAULT_TENANT_ID} and email = ${base} limit 1`;
    await h.client`update customers set deleted_at = now() where id = ${orig[0]!.id}`;
    await h.client`
      insert into customers (id, tenant_id, email, password_hash, name)
      values (${uuidv7()}, ${DEFAULT_TENANT_ID}, ${variant}, ${null}, ${'Variant2'})`;
    const live = await h.client<{ n: string }[]>`
      select count(*)::int as n from customers
      where tenant_id = ${DEFAULT_TENANT_ID} and lower(email) = ${base} and deleted_at is null and anonymized_at is null`;
    expect(Number(live[0]!.n)).toBe(1);
  });
});
