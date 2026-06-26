/**
 * Customer refresh rotation, reuse-detection, logout
 * (SECURITY-CRITICAL).
 */
import request from 'supertest';
import {
  bootCustomersApp,
  teardownCustomersApp,
  resetCustomersState,
  signupAndLogin,
  extractRefreshCookie,
  countLiveRefresh,
  STORE,
  STORE_ORIGIN,
  CustomersHarness,
} from './_customers-harness';

describe('Customer refresh / reuse / logout (integration, SECURITY-CRITICAL)', () => {
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

  it('rotates the refresh token (new cookie, fresh access token)', async () => {
    const c = await signupAndLogin(h);
    const res = await request(h.http()).post(STORE.refresh).set('Cookie', c.refreshCookie);
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    const rotated = extractRefreshCookie(res);
    expect(rotated).not.toBe('');
    expect(rotated).not.toBe(c.refreshCookie);
  });

  it('replaying a ROTATED token revokes the whole family (reuse-detection)', async () => {
    const c = await signupAndLogin(h);
    // First rotation succeeds and supersedes the original cookie.
    const first = await request(h.http()).post(STORE.refresh).set('Cookie', c.refreshCookie);
    expect(first.status).toBe(200);
    const rotated = extractRefreshCookie(first);

    // Replay the ORIGINAL (now-revoked) token → reuse → 401 + family revoked.
    const replay = await request(h.http()).post(STORE.refresh).set('Cookie', c.refreshCookie);
    expect(replay.status).toBe(401);

    // The rotated (sibling) token is now also dead — whole family revoked.
    const afterReuse = await request(h.http()).post(STORE.refresh).set('Cookie', rotated);
    expect(afterReuse.status).toBe(401);
    expect(await countLiveRefresh(h, c.customerId)).toBe(0);
  });

  it('refresh with no cookie → 401', async () => {
    const res = await request(h.http()).post(STORE.refresh);
    expect(res.status).toBe(401);
  });

  it('logout revokes the family and clears the cookie', async () => {
    const c = await signupAndLogin(h);
    expect(await countLiveRefresh(h, c.customerId)).toBe(1);
    const res = await request(h.http()).post(STORE.logout).set('Cookie', c.refreshCookie);
    expect(res.status).toBe(204);
    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
    expect((setCookie ?? []).some((x) => x.startsWith('sov_customer_refresh='))).toBe(true);
    expect(await countLiveRefresh(h, c.customerId)).toBe(0);

    // The cookie can no longer be refreshed.
    const after = await request(h.http()).post(STORE.refresh).set('Cookie', c.refreshCookie);
    expect(after.status).toBe(401);
  });

  // ── F6: CSRF / Origin allowlist deny-paths ───────────────────────────────────

  it('a MATCHING Origin is accepted on refresh (STORE_ORIGIN pinned)', async () => {
    const c = await signupAndLogin(h);
    const res = await request(h.http())
      .post(STORE.refresh)
      .set('Origin', STORE_ORIGIN)
      .set('Cookie', c.refreshCookie);
    expect(res.status).toBe(200);
  });

  it('a FOREIGN Origin on refresh → 403 (cookie never touched)', async () => {
    const c = await signupAndLogin(h);
    const res = await request(h.http())
      .post(STORE.refresh)
      .set('Origin', 'https://evil.example')
      .set('Cookie', c.refreshCookie);
    expect(res.status).toBe(403);
    // The family must be untouched by a rejected cross-origin attempt.
    expect(await countLiveRefresh(h, c.customerId)).toBe(1);
  });

  it('a cross-site Sec-Fetch-Site on refresh → 403', async () => {
    const c = await signupAndLogin(h);
    const res = await request(h.http())
      .post(STORE.refresh)
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Cookie', c.refreshCookie);
    expect(res.status).toBe(403);
  });

  it('a foreign Origin on logout → 403', async () => {
    const c = await signupAndLogin(h);
    const res = await request(h.http())
      .post(STORE.logout)
      .set('Origin', 'https://evil.example')
      .set('Cookie', c.refreshCookie);
    expect(res.status).toBe(403);
    expect(await countLiveRefresh(h, c.customerId)).toBe(1);
  });
});
