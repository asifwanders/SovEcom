/**
 * Customer `token_version` session-kill gate (integration,
 * SECURITY-CRITICAL).
 *
 * End-to-end proof that bumping a customer's `token_version` in the DB invalidates
 * their OUTSTANDING access tokens:
 *   - a token minted at tv=0 works on `@CustomerAuthGuard` `/store/v1/customers/me`;
 *   - after `UPDATE customers SET token_version = token_version + 1`, that SAME
 *     token is REJECTED (401) on the mandatory route;
 *   - a FRESH login (post-bump) mints a tv=1 token that works again;
 *   - the OPTIONAL guard (cart routes) treats the stale-tv token as ANONYMOUS:
 *     a customer-owned cart reachable via a valid JWT becomes a 403 once the token
 *     is stale (the guard drops it to anonymous instead of throwing).
 */
import request from 'supertest';
import {
  bootCustomersApp,
  teardownCustomersApp,
  resetCustomersState,
  signupAndLogin,
  STORE,
  CustomersHarness,
} from './_customers-harness';

/** Bump a customer's token_version directly in the DB (the session-kill lever). */
async function bumpTokenVersion(h: CustomersHarness, customerId: string): Promise<void> {
  await h.client`
    update customers set token_version = token_version + 1 where id = ${customerId}
  `;
}

describe('Customer token_version session-kill gate (integration, SECURITY-CRITICAL)', () => {
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

  it('bumping token_version rejects a pre-bump access token (401) on the mandatory guard', async () => {
    const session = await signupAndLogin(h);

    // Pre-bump: the freshly minted tv=0 token works on the mandatory route.
    const before = await request(h.http())
      .get(STORE.me)
      .set('Authorization', `Bearer ${session.accessToken}`);
    expect(before.status).toBe(200);

    // Session-kill: bump the row's token_version (0 -> 1).
    await bumpTokenVersion(h, session.customerId);

    // The SAME token now carries a stale tv (0 ≠ 1) -> 401.
    const after = await request(h.http())
      .get(STORE.me)
      .set('Authorization', `Bearer ${session.accessToken}`);
    expect(after.status).toBe(401);
  });

  it('a FRESH login after the bump mints a working token (tv tracks the row)', async () => {
    const session = await signupAndLogin(h);
    await bumpTokenVersion(h, session.customerId);

    // Old token is dead.
    const stale = await request(h.http())
      .get(STORE.me)
      .set('Authorization', `Bearer ${session.accessToken}`);
    expect(stale.status).toBe(401);

    // Re-login: the new token is minted with the CURRENT token_version (1) and works.
    const relogin = await request(h.http())
      .post(STORE.login)
      .send({ email: session.email, password: session.password });
    expect(relogin.status).toBe(200);
    const fresh = await request(h.http())
      .get(STORE.me)
      .set('Authorization', `Bearer ${relogin.body.accessToken}`);
    expect(fresh.status).toBe(200);
    expect(fresh.body.email).toBe(session.email);
  });

  it('refresh after a bump: the pre-bump access token stays dead, the refreshed one works with the new tv', async () => {
    // A token_version bump kills OUTSTANDING access tokens, but the refresh family
    // is NOT revoked by the bump alone — refreshing mints a fresh access token
    // carrying the CURRENT tv. The future bump-caller (customer password change) must
    // pair the bump with refresh-family revocation (see reset.service.ts).
    const session = await signupAndLogin(h);
    await bumpTokenVersion(h, session.customerId); // tv 0 -> 1

    // Pre-bump access token is dead.
    const stale = await request(h.http())
      .get(STORE.me)
      .set('Authorization', `Bearer ${session.accessToken}`);
    expect(stale.status).toBe(401);

    // Refreshing (family still live) mints a NEW access token with the current tv (1).
    const refreshed = await request(h.http())
      .post(STORE.refresh)
      .set('Cookie', session.refreshCookie);
    expect(refreshed.status).toBe(200);
    const newAccess = refreshed.body.accessToken as string;
    const works = await request(h.http()).get(STORE.me).set('Authorization', `Bearer ${newAccess}`);
    expect(works.status).toBe(200);

    // The original pre-bump token is STILL dead — the refresh did not resurrect it.
    const stillDead = await request(h.http())
      .get(STORE.me)
      .set('Authorization', `Bearer ${session.accessToken}`);
    expect(stillDead.status).toBe(401);
  });

  it('the OPTIONAL guard treats a stale-tv token as anonymous on a cart route (403, never 401)', async () => {
    const session = await signupAndLogin(h);

    // Create a cart and associate the authenticated customer (so the cart is
    // owned by this customer and reachable via the customer JWT alone).
    const created = await request(h.http())
      .post('/store/v1/carts')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ currency: 'EUR' });
    expect(created.status).toBe(201);
    const cartId = created.body.cartId as string;
    const cartCookie = (created.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('sov_cart='),
    )!;
    const cartPair = cartCookie.split(';')[0]!;

    const associate = await request(h.http())
      .post(`/store/v1/carts/${cartId}/customer`)
      .set('Authorization', `Bearer ${session.accessToken}`)
      .set('Cookie', cartPair);
    expect(associate.status).toBe(200);

    // With a VALID JWT and NO cart cookie, the owning-customer path authorises.
    const okViaJwt = await request(h.http())
      .get(`/store/v1/carts/${cartId}`)
      .set('Authorization', `Bearer ${session.accessToken}`);
    expect(okViaJwt.status).toBe(200);

    // Session-kill: bump token_version. The optional guard now DROPS the stale token
    // to anonymous (no req.customer) — so with no cart cookie either, authorisation
    // fails as a 403 ("Access denied"), and crucially NEVER a 401 (the optional guard
    // does not reject on a bad token).
    await bumpTokenVersion(h, session.customerId);
    const anon = await request(h.http())
      .get(`/store/v1/carts/${cartId}`)
      .set('Authorization', `Bearer ${session.accessToken}`);
    expect(anon.status).toBe(403);
  });
});
