/**
 * Authenticated customer CHANGE-PASSWORD (integration,
 * AUTH/CREDENTIAL-CRITICAL).
 *
 * `POST /store/v1/customers/me/password` (CustomerAuthGuard) `{ currentPassword,
 * newPassword }` → `{ accessToken }` + a rotated refresh cookie. The contract:
 *   - wrong currentPassword → uniform 401 (no oracle, equal Argon2 work);
 *   - the step-up gate is rate-limited 5/60s and fails CLOSED (6th → 401);
 *   - a weak / breached newPassword → 4xx, password UNCHANGED;
 *   - success: the OLD password no longer logs in, the NEW one does, and the
 *     RETURNED access token works on the mandatory guard;
 *   - SESSION-KILL-BUT-KEEP-CURRENT: a pre-change access token (stale tv) → 401,
 *     a SECOND pre-existing refresh family → revoked (refresh → 401), but the
 *     RETURNED access token + its rotated refresh cookie still work;
 *   - a `customer.password_changed` audit row is written; no plaintext anywhere.
 */
import request from 'supertest';
import { AuditService } from '../../../src/audit/audit.service';
import {
  bootCustomersApp,
  teardownCustomersApp,
  resetCustomersState,
  signupAndLogin,
  extractRefreshCookie,
  countLiveRefresh,
  auditRows,
  rawCustomer,
  STORE,
  CustomersHarness,
} from './_customers-harness';

const PW = 'correct horse battery staple';
const NEW_PW = 'a brand new strong passphrase!!';
const WRONG_PW = 'definitely not the password';
const CHANGE_PW = '/store/v1/customers/me/password';

describe('Customer change-password (integration, AUTH/CREDENTIAL-CRITICAL)', () => {
  let h: CustomersHarness;
  beforeAll(async () => {
    h = await bootCustomersApp();
  });
  afterAll(async () => {
    await teardownCustomersApp(h);
  });
  beforeEach(async () => {
    await resetCustomersState(h);
  });

  // ── Rejection paths ──────────────────────────────────────────────────────────

  it('wrong currentPassword → uniform 401, password unchanged', async () => {
    const c = await signupAndLogin(h, { password: PW });
    const before = await rawCustomer(h, c.customerId);

    const res = await request(h.http())
      .post(CHANGE_PW)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ currentPassword: WRONG_PW, newPassword: NEW_PW });
    expect(res.status).toBe(401);
    expect(res.body.accessToken).toBeUndefined();

    // The hash is untouched and the OLD password still logs in.
    const after = await rawCustomer(h, c.customerId);
    expect(after!.password_hash).toBe(before!.password_hash);
    const login = await request(h.http()).post(STORE.login).send({ email: c.email, password: PW });
    expect(login.status).toBe(200);
  });

  it('rate-limits the step-up: the 6th wrong attempt is still 401 (fail-closed)', async () => {
    const c = await signupAndLogin(h, { password: PW });
    for (let i = 0; i < 6; i += 1) {
      const res = await request(h.http())
        .post(CHANGE_PW)
        .set('Authorization', `Bearer ${c.accessToken}`)
        .send({ currentPassword: WRONG_PW, newPassword: NEW_PW });
      expect(res.status).toBe(401);
    }
    // After the budget is burned, even the CORRECT password is throttled to 401.
    const blocked = await request(h.http())
      .post(CHANGE_PW)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ currentPassword: PW, newPassword: NEW_PW });
    expect(blocked.status).toBe(401);
    // The password was never changed: the original still logs in.
    const login = await request(h.http()).post(STORE.login).send({ email: c.email, password: PW });
    expect(login.status).toBe(200);
  });

  it('weak / breached newPassword → 4xx, password unchanged', async () => {
    const c = await signupAndLogin(h, { password: PW });
    const before = await rawCustomer(h, c.customerId);

    // Breached denylist entry that is 12+ chars (passes the Zod length policy).
    const res = await request(h.http())
      .post(CHANGE_PW)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ currentPassword: PW, newPassword: 'password1234' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.accessToken).toBeUndefined();

    const after = await rawCustomer(h, c.customerId);
    expect(after!.password_hash).toBe(before!.password_hash);
    const login = await request(h.http()).post(STORE.login).send({ email: c.email, password: PW });
    expect(login.status).toBe(200);
  });

  it('too-short newPassword → 400 (Zod), password unchanged', async () => {
    const c = await signupAndLogin(h, { password: PW });
    const res = await request(h.http())
      .post(CHANGE_PW)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ currentPassword: PW, newPassword: 'short' });
    expect(res.status).toBe(400);
    const login = await request(h.http()).post(STORE.login).send({ email: c.email, password: PW });
    expect(login.status).toBe(200);
  });

  it('rejects an unauthenticated request (CustomerAuthGuard) → 401', async () => {
    const res = await request(h.http())
      .post(CHANGE_PW)
      .send({ currentPassword: PW, newPassword: NEW_PW });
    expect(res.status).toBe(401);
  });

  // ── Success: credentials rotate ──────────────────────────────────────────────

  it('success: old password stops working, new password logs in, returned token works', async () => {
    const c = await signupAndLogin(h, { password: PW });

    const res = await request(h.http())
      .post(CHANGE_PW)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ currentPassword: PW, newPassword: NEW_PW });
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');

    // The returned access token works on the mandatory guard.
    const me = await request(h.http())
      .get(STORE.me)
      .set('Authorization', `Bearer ${res.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(c.email);

    // The OLD password no longer logs in; the NEW one does.
    const oldLogin = await request(h.http())
      .post(STORE.login)
      .send({ email: c.email, password: PW });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(h.http())
      .post(STORE.login)
      .send({ email: c.email, password: NEW_PW });
    expect(newLogin.status).toBe(200);
  });

  // ── Session-kill-but-keep-current ────────────────────────────────────────────

  it('kills OTHER sessions but keeps the current one: stale access token + 2nd family die, returned token + cookie survive', async () => {
    // Session A — the session that will perform the change.
    const a = await signupAndLogin(h, { password: PW });
    // Session B — a SECOND pre-existing session (separate refresh family) for the
    // SAME customer (e.g. another device). It must be killed by the change.
    const loginB = await request(h.http()).post(STORE.login).send({ email: a.email, password: PW });
    expect(loginB.status).toBe(200);
    const bAccess = loginB.body.accessToken as string;
    const bRefreshCookie = extractRefreshCookie(loginB);

    // Two live refresh families before the change.
    expect(await countLiveRefresh(h, a.customerId)).toBe(2);

    // Pre-change: session A's access token works.
    const aBefore = await request(h.http())
      .get(STORE.me)
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(aBefore.status).toBe(200);

    // Perform the change with session A.
    const res = await request(h.http())
      .post(CHANGE_PW)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ currentPassword: PW, newPassword: NEW_PW });
    expect(res.status).toBe(200);
    const returnedAccess = res.body.accessToken as string;
    const returnedRefreshCookie = extractRefreshCookie(res);
    expect(returnedRefreshCookie).toMatch(/^sov_customer_refresh=/);

    // (1) Session A's PRE-change access token is now stale (tv bumped) → 401.
    const aStale = await request(h.http())
      .get(STORE.me)
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(aStale.status).toBe(401);

    // (2) Session B's access token is also stale (same tv bump) → 401.
    const bStale = await request(h.http()).get(STORE.me).set('Authorization', `Bearer ${bAccess}`);
    expect(bStale.status).toBe(401);

    // (3) Session B's refresh family was revoked → refresh → 401, cookie cleared.
    const bRefresh = await request(h.http())
      .post(STORE.refresh)
      .set('Origin', 'https://store.test')
      .set('Cookie', bRefreshCookie);
    expect(bRefresh.status).toBe(401);

    // (4) The session-A pre-change refresh family is also revoked (logout-everywhere).
    const aOldRefresh = await request(h.http())
      .post(STORE.refresh)
      .set('Origin', 'https://store.test')
      .set('Cookie', a.refreshCookie);
    expect(aOldRefresh.status).toBe(401);

    // (5) BUT the CURRENT session survived: the returned access token works,
    //     and the rotated refresh cookie can mint a fresh access token.
    const current = await request(h.http())
      .get(STORE.me)
      .set('Authorization', `Bearer ${returnedAccess}`);
    expect(current.status).toBe(200);

    const rotated = await request(h.http())
      .post(STORE.refresh)
      .set('Origin', 'https://store.test')
      .set('Cookie', returnedRefreshCookie);
    expect(rotated.status).toBe(200);
    const refreshedAccess = rotated.body.accessToken as string;
    const refreshedMe = await request(h.http())
      .get(STORE.me)
      .set('Authorization', `Bearer ${refreshedAccess}`);
    expect(refreshedMe.status).toBe(200);

    // Exactly ONE live refresh family remains — the current rotated one (the old
    // current family was revoked and replaced; the rotate above replaced it again).
    expect(await countLiveRefresh(h, a.customerId)).toBe(1);
  });

  // ── Audit ────────────────────────────────────────────────────────────────────

  it('writes a customer.password_changed audit row with no plaintext password', async () => {
    const c = await signupAndLogin(h, { password: PW });
    const res = await request(h.http())
      .post(CHANGE_PW)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ currentPassword: PW, newPassword: NEW_PW });
    expect(res.status).toBe(200);

    const rows = await auditRows(h, 'customer.password_changed');
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.actor_type).toBe('customer');
    expect(row.actor_id).toBe(c.customerId);
    expect(row.resource_id).toBe(c.customerId);
    // No plaintext password (current or new) is stored anywhere in the row.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(PW);
    expect(serialized).not.toContain(NEW_PW);
  });

  // ── Durability over audit ──

  it('audit write failure does NOT fail the request: still 200 with a working token, change committed', async () => {
    const c = await signupAndLogin(h, { password: PW });

    // Force the post-commit audit write to throw. The credential change is already
    // durably committed (tx) before this runs, so the request must still succeed —
    // a forced 500/logout for a durably-applied credential change is the bug.
    const audit = h.app.get(AuditService, { strict: false });
    const spy = jest
      .spyOn(audit, 'record')
      .mockRejectedValueOnce(new Error('simulated audit_log outage'));

    try {
      const res = await request(h.http())
        .post(CHANGE_PW)
        .set('Authorization', `Bearer ${c.accessToken}`)
        .send({ currentPassword: PW, newPassword: NEW_PW });
      expect(res.status).toBe(200);
      expect(typeof res.body.accessToken).toBe('string');

      // The returned token works (the rotated current session is alive).
      const me = await request(h.http())
        .get(STORE.me)
        .set('Authorization', `Bearer ${res.body.accessToken}`);
      expect(me.status).toBe(200);
    } finally {
      spy.mockRestore();
    }

    // The change was really applied: the NEW password logs in, the OLD one does not.
    const newLogin = await request(h.http())
      .post(STORE.login)
      .send({ email: c.email, password: NEW_PW });
    expect(newLogin.status).toBe(200);
    const oldLogin = await request(h.http())
      .post(STORE.login)
      .send({ email: c.email, password: PW });
    expect(oldLogin.status).toBe(401);
  });
});
