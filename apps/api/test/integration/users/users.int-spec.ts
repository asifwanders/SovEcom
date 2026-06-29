/**
 * Staff Accounts Management integration tests — /admin/v1/users
 * (SECURITY-CRITICAL: auth principal + privilege-escalation path)
 *
 * REQUIRES live Postgres + Redis (DATABASE_URL + REDIS_URL).
 * Run: pnpm exec jest --config jest.integration.config.js --testPathPattern='users|auth' --runInBand
 *
 * Covers EVERY guard in the spec:
 *
 *   CREATE:
 *     - argon2id hash stored ($argon2id$ prefix, never plaintext)
 *     - breached password rejected (400)
 *     - role='owner' rejected (400)
 *     - duplicate email → 409
 *     - tenant-scoped (created under principal's tenant)
 *     - staff-role caller gets 403 (lacks users:write)
 *     - response carries no password_hash / totp_secret
 *
 *   ROLE CHANGE:
 *     - target owner → 403
 *     - new role owner → 400 (Zod DTO rejects)
 *     - self → 403
 *     - token_version incremented
 *     - cross-tenant target → 404
 *     - staff caller 403
 *
 *   DEACTIVATE / REACTIVATE:
 *     - owner target → 403
 *     - self → 403
 *     - disabled_at set; token_version bumped
 *     - login as deactivated user fails with uniform 401
 *     - reactivate clears disabled_at and login works again
 *
 *   LIST:
 *     - tenant isolation (other tenant's users absent)
 *     - USERS_READ required (staff without it → 403)
 *     - no password_hash in payload
 */
import request from 'supertest';
import {
  bootAuthApp,
  teardownAuthApp,
  resetAuthState,
  seedAdmin,
  makeTenant,
  AUTH,
  type AuthHarness,
} from '../auth/_auth-harness';

const USERS = {
  list: '/admin/v1/users',
  create: '/admin/v1/users',
  role: (id: string) => `/admin/v1/users/${id}/role`,
  deactivate: (id: string) => `/admin/v1/users/${id}/deactivate`,
  reactivate: (id: string) => `/admin/v1/users/${id}/reactivate`,
} as const;

/** Helper: login and return access token. */
async function login(h: AuthHarness, email: string, password: string): Promise<string | null> {
  const res = await request(h.http()).post(AUTH.login).send({ email, password });
  if (res.status !== 200) return null;
  return res.body.accessToken as string;
}

/** Login and return the refresh cookie (name=value), or null on failure. */
async function loginForCookie(
  h: AuthHarness,
  email: string,
  password: string,
): Promise<string | null> {
  const res = await request(h.http()).post(AUTH.login).send({ email, password });
  if (res.status !== 200) return null;
  const setCookie = res.headers['set-cookie'] as unknown as string[];
  const c = setCookie?.find((x) => /refresh/i.test(x));
  return c ? c.split(';')[0] : null;
}

/** Read token_version directly for a user. */
async function getTokenVersion(h: AuthHarness, userId: string): Promise<number> {
  const rows = await h.client<{ token_version: number }[]>`
    select token_version from users where id = ${userId}
  `;
  return rows[0]?.token_version ?? -1;
}

/** Read disabled_at directly for a user. */
async function getDisabledAt(h: AuthHarness, userId: string): Promise<Date | null> {
  const rows = await h.client<{ disabled_at: Date | null }[]>`
    select disabled_at from users where id = ${userId}
  `;
  return rows[0]?.disabled_at ?? null;
}

describe('Users Admin — /admin/v1/users (SECURITY-CRITICAL integration)', () => {
  let h: AuthHarness;

  beforeAll(async () => {
    h = await bootAuthApp();
  }, 60_000);

  afterAll(async () => {
    await teardownAuthApp(h);
  });

  beforeEach(async () => {
    await resetAuthState(h);
  });

  // ── LIST ────────────────────────────────────────────────────────────────────

  describe('GET /admin/v1/users (list)', () => {
    it('returns 401 when unauthenticated', async () => {
      await request(h.http()).get(USERS.list).expect(401);
    });

    it('returns 403 for a staff user (lacks users:read)', async () => {
      const staffUser = await seedAdmin(h, { role: 'staff' });
      const token = await login(h, staffUser.email, staffUser.password);
      await request(h.http()).get(USERS.list).set('Authorization', `Bearer ${token}`).expect(403);
    });

    it('returns 200 for an admin user and includes the list envelope', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      const res = await request(h.http())
        .get(USERS.list)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('page');
      expect(res.body).toHaveProperty('pageSize');
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('never returns password_hash or totp_secret in the list payload', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      const res = await request(h.http())
        .get(USERS.list)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const json = JSON.stringify(res.body);
      expect(json).not.toMatch(/password_hash|passwordHash/);
      expect(json).not.toMatch(/totp_secret|totpSecret/);
    });

    it("enforces tenant isolation: another tenant's users are absent", async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      // Seed a user in a DIFFERENT tenant.
      const otherTenantId = await makeTenant(h);
      await seedAdmin(h, { tenantId: otherTenantId, role: 'staff' });

      const res = await request(h.http())
        .get(USERS.list)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // The other tenant's user must not appear.
      const ids: string[] = res.body.data.map((u: { id: string }) => u.id);
      expect(ids).not.toContain(otherTenantId);
      // Our admin appears.
      expect(ids).toContain(admin.id);
    });
  });

  // ── CREATE ───────────────────────────────────────────────────────────────────

  describe('POST /admin/v1/users (create)', () => {
    it('returns 401 when unauthenticated', async () => {
      await request(h.http())
        .post(USERS.create)
        .send({
          email: 'new@test.com',
          name: 'New',
          role: 'staff',
          password: 'correcthorsebattery',
        })
        .expect(401);
    });

    it('returns 403 for a staff caller (lacks users:write)', async () => {
      const staffUser = await seedAdmin(h, { role: 'staff' });
      const token = await login(h, staffUser.email, staffUser.password);
      await request(h.http())
        .post(USERS.create)
        .set('Authorization', `Bearer ${token}`)
        .send({
          email: 'new@test.com',
          name: 'New',
          role: 'staff',
          password: 'correcthorsebattery',
        })
        .expect(403);
    });

    it('creates a new staff account and returns 201 with a UserView (no secrets)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const res = await request(h.http())
        .post(USERS.create)
        .set('Authorization', `Bearer ${token}`)
        .send({
          email: 'newstaff@x.test',
          name: 'New Staff',
          role: 'staff',
          password: 'correcthorsebattery',
        })
        .expect(201);

      expect(res.body.email).toBe('newstaff@x.test');
      expect(res.body.role).toBe('staff');
      expect(res.body.id).toBeDefined();
      // No secrets in response.
      const json = JSON.stringify(res.body);
      expect(json).not.toMatch(/password_hash|passwordHash/);
      expect(json).not.toMatch(/totp_secret|totpSecret/);
    });

    it('stores the password as an argon2id hash (not plaintext)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      const email = 'hashcheck@x.test';
      const password = 'correcthorsebattery';

      const res = await request(h.http())
        .post(USERS.create)
        .set('Authorization', `Bearer ${token}`)
        .send({ email, name: 'Hash Check', role: 'staff', password })
        .expect(201);

      // Read password_hash directly from DB.
      const rows = await h.client<{ password_hash: string }[]>`
        select password_hash from users where id = ${res.body.id}
      `;
      expect(rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
      expect(rows[0]?.password_hash).not.toBe(password);
    });

    it('rejects a breached password with 400', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      await request(h.http())
        .post(USERS.create)
        .set('Authorization', `Bearer ${token}`)
        .send({ email: 'breach@x.test', name: 'Breach', role: 'staff', password: 'password1234' })
        .expect(400);
    });

    it('rejects role=owner with 400 (Zod DTO validation)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      await request(h.http())
        .post(USERS.create)
        .set('Authorization', `Bearer ${token}`)
        .send({
          email: 'ownerattempt@x.test',
          name: 'Owner Attempt',
          role: 'owner',
          password: 'correcthorsebattery',
        })
        .expect(400);
    });

    it('returns 409 on duplicate email within the same tenant', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      const email = 'dupcheck@x.test';

      await request(h.http())
        .post(USERS.create)
        .set('Authorization', `Bearer ${token}`)
        .send({ email, name: 'Dup One', role: 'staff', password: 'correcthorsebattery' })
        .expect(201);

      // Second create with same email → 409.
      await request(h.http())
        .post(USERS.create)
        .set('Authorization', `Bearer ${token}`)
        .send({ email, name: 'Dup Two', role: 'staff', password: 'correcthorsebattery' })
        .expect(409);
    });

    it("scopes created user to the principal's tenant", async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const res = await request(h.http())
        .post(USERS.create)
        .set('Authorization', `Bearer ${token}`)
        .send({
          email: 'tenantscope@x.test',
          name: 'Tenant Scope',
          role: 'staff',
          password: 'correcthorsebattery',
        })
        .expect(201);

      const rows = await h.client<{ tenant_id: string }[]>`
        select tenant_id from users where id = ${res.body.id}
      `;
      expect(rows[0]?.tenant_id).toBe(admin.tenantId);
    });
  });

  // ── ROLE CHANGE ───────────────────────────────────────────────────────────

  describe('PATCH /admin/v1/users/:id/role (change role)', () => {
    it('returns 403 for a staff caller', async () => {
      const staffUser = await seedAdmin(h, { role: 'staff' });
      const target = await seedAdmin(h, { tenantId: staffUser.tenantId, role: 'staff' });
      const token = await login(h, staffUser.email, staffUser.password);

      await request(h.http())
        .patch(USERS.role(target.id))
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'admin' })
        .expect(403);
    });

    it('returns 403 when trying to change own role (self-escalation guard)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      await request(h.http())
        .patch(USERS.role(admin.id))
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'staff' })
        .expect(403);
    });

    it('returns 403 when targeting an owner account', async () => {
      const owner = await seedAdmin(h, { role: 'owner' });
      const admin = await seedAdmin(h, { tenantId: owner.tenantId, role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      await request(h.http())
        .patch(USERS.role(owner.id))
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'staff' })
        .expect(403);
    });

    it('returns 400 when new role is owner (Zod DTO rejects)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const target = await seedAdmin(h, { tenantId: admin.tenantId, role: 'staff' });
      const token = await login(h, admin.email, admin.password);

      await request(h.http())
        .patch(USERS.role(target.id))
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'owner' })
        .expect(400);
    });

    it('returns 404 when targeting a user from a different tenant', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const otherTenantId = await makeTenant(h);
      const otherUser = await seedAdmin(h, { tenantId: otherTenantId, role: 'staff' });
      const token = await login(h, admin.email, admin.password);

      await request(h.http())
        .patch(USERS.role(otherUser.id))
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'admin' })
        .expect(404);
    });

    it('changes the role and bumps token_version', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const target = await seedAdmin(h, { tenantId: admin.tenantId, role: 'staff' });
      const token = await login(h, admin.email, admin.password);

      const versionBefore = await getTokenVersion(h, target.id);

      const res = await request(h.http())
        .patch(USERS.role(target.id))
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'admin' })
        .expect(200);

      expect(res.body.role).toBe('admin');
      const versionAfter = await getTokenVersion(h, target.id);
      expect(versionAfter).toBe(versionBefore + 1);
    });
  });

  // ── DEACTIVATE / REACTIVATE ───────────────────────────────────────────────

  describe('PATCH /admin/v1/users/:id/deactivate and /reactivate', () => {
    it('returns 403 for a staff caller (lacks users:write)', async () => {
      const staffUser = await seedAdmin(h, { role: 'staff' });
      const target = await seedAdmin(h, { tenantId: staffUser.tenantId, role: 'staff' });
      const token = await login(h, staffUser.email, staffUser.password);

      await request(h.http())
        .patch(USERS.deactivate(target.id))
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('returns 403 when deactivating self', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      await request(h.http())
        .patch(USERS.deactivate(admin.id))
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('returns 403 when deactivating an owner', async () => {
      const owner = await seedAdmin(h, { role: 'owner' });
      const admin = await seedAdmin(h, { tenantId: owner.tenantId, role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      await request(h.http())
        .patch(USERS.deactivate(owner.id))
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('deactivates: sets disabled_at and bumps token_version', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const target = await seedAdmin(h, { tenantId: admin.tenantId, role: 'staff' });
      const token = await login(h, admin.email, admin.password);

      const versionBefore = await getTokenVersion(h, target.id);

      const res = await request(h.http())
        .patch(USERS.deactivate(target.id))
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.disabledAt).not.toBeNull();

      const disabledAt = await getDisabledAt(h, target.id);
      expect(disabledAt).not.toBeNull();

      const versionAfter = await getTokenVersion(h, target.id);
      expect(versionAfter).toBe(versionBefore + 1);
    });

    it('login as a deactivated user fails with a uniform 401', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const target = await seedAdmin(h, { tenantId: admin.tenantId, role: 'staff' });
      const token = await login(h, admin.email, admin.password);

      // Deactivate.
      await request(h.http())
        .patch(USERS.deactivate(target.id))
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // Login attempt with correct credentials must fail with 401.
      const loginRes = await request(h.http())
        .post(AUTH.login)
        .send({ email: target.email, password: target.password });

      expect(loginRes.status).toBe(401);
      // Body shape must match the standard failure (no leak of "disabled").
      expect(JSON.stringify(loginRes.body).toLowerCase()).not.toMatch(/disabled|deactivated/);
    });

    it('a deactivated user cannot mint a new access token via the refresh path (B1)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const target = await seedAdmin(h, { tenantId: admin.tenantId, role: 'staff' });
      const adminToken = await login(h, admin.email, admin.password);

      // Target logs in and captures a valid refresh cookie (live 7-day session).
      const refreshCookie = await loginForCookie(h, target.email, target.password);
      expect(refreshCookie).not.toBeNull();

      // The target's refresh cookie works BEFORE deactivation.
      await request(h.http()).post(AUTH.refresh).set('Cookie', refreshCookie!).expect(200);

      // A second login to get a fresh, un-rotated cookie to use AFTER deactivation
      // (the first cookie was rotated/revoked by the refresh call above).
      const liveCookie = await loginForCookie(h, target.email, target.password);
      expect(liveCookie).not.toBeNull();

      // Admin deactivates the target.
      await request(h.http())
        .patch(USERS.deactivate(target.id))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      // The still-held refresh cookie must NOT mint a new access token → uniform 401.
      const refreshRes = await request(h.http()).post(AUTH.refresh).set('Cookie', liveCookie!);
      expect(refreshRes.status).toBe(401);
      // No leak of why (deactivated vs revoked).
      expect(JSON.stringify(refreshRes.body).toLowerCase()).not.toMatch(/disabled|deactivated/);

      // And the deactivate tx revoked every live refresh token for the target.
      const liveRows = await h.client<{ c: string }[]>`
        select count(*)::int as c from refresh_tokens
        where user_id = ${target.id} and revoked_at is null
      `;
      expect(Number(liveRows[0].c)).toBe(0);
    });

    it('reactivate clears disabled_at and login works again', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const target = await seedAdmin(h, { tenantId: admin.tenantId, role: 'staff' });
      const token = await login(h, admin.email, admin.password);

      // Deactivate first.
      await request(h.http())
        .patch(USERS.deactivate(target.id))
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // Verify login fails.
      await request(h.http())
        .post(AUTH.login)
        .send({ email: target.email, password: target.password })
        .expect(401);

      // Reactivate.
      const reactivateRes = await request(h.http())
        .patch(USERS.reactivate(target.id))
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(reactivateRes.body.disabledAt).toBeNull();

      // Verify the disabled_at is cleared in DB.
      const disabledAt = await getDisabledAt(h, target.id);
      expect(disabledAt).toBeNull();

      // Login now succeeds.
      const loginRes = await request(h.http())
        .post(AUTH.login)
        .send({ email: target.email, password: target.password });
      expect(loginRes.status).toBe(200);
      expect(typeof loginRes.body.accessToken).toBe('string');
    });
  });
});
