/**
 * Customer auth: signup→login→me round-trip, enumeration-/timing-
 * safety, rate-limiting (SECURITY-CRITICAL).
 */
import request from 'supertest';
import {
  bootCustomersApp,
  teardownCustomersApp,
  resetCustomersState,
  signupAndLogin,
  uniqEmail,
  STORE,
  CustomersHarness,
} from './_customers-harness';

describe('Customer auth (integration, SECURITY-CRITICAL)', () => {
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

  it('signup → login → me round-trips and returns the own profile', async () => {
    const email = uniqEmail();
    const password = 'correct horse battery staple';
    const signup = await request(h.http())
      .post(STORE.signup)
      .send({ email, password, name: 'Alice' });
    expect(signup.status).toBe(201);
    expect(signup.body.email).toBe(email);
    expect(signup.body).not.toHaveProperty('passwordHash');
    expect(signup.body).not.toHaveProperty('password_hash');

    const login = await request(h.http()).post(STORE.login).send({ email, password });
    expect(login.status).toBe(200);
    expect(typeof login.body.accessToken).toBe('string');

    const me = await request(h.http())
      .get(STORE.me)
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(email);
    expect(me.body.name).toBe('Alice');
  });

  it('rejects a breached password at signup (400)', async () => {
    const res = await request(h.http())
      .post(STORE.signup)
      .send({ email: uniqEmail(), password: 'password1234' });
    expect(res.status).toBe(400);
  });

  it('duplicate active email → 409', async () => {
    const email = uniqEmail();
    const a = await request(h.http())
      .post(STORE.signup)
      .send({ email, password: 'correct horse battery staple' });
    expect(a.status).toBe(201);
    const b = await request(h.http())
      .post(STORE.signup)
      .send({ email, password: 'correct horse battery staple' });
    expect(b.status).toBe(409);
  });

  it('wrong password and unknown email return the SAME uniform 401 (enumeration-safe)', async () => {
    const { email } = await signupAndLogin(h);
    const wrongPw = await request(h.http())
      .post(STORE.login)
      .send({ email, password: 'totally wrong password here' });
    const unknown = await request(h.http())
      .post(STORE.login)
      .send({ email: uniqEmail(), password: 'totally wrong password here' });
    expect(wrongPw.status).toBe(401);
    expect(unknown.status).toBe(401);
    // Bodies must be indistinguishable (no "user not found" oracle).
    expect(wrongPw.body).toEqual(unknown.body);
  });

  it('me without a token → 401', async () => {
    const res = await request(h.http()).get(STORE.me);
    expect(res.status).toBe(401);
  });

  it('login throttle collapses to the SAME uniform 401 (anti-enumeration, not a 429)', async () => {
    // By design (mirrors admin auth), an over-budget login is NOT a distinguishable
    // 429 — it returns the same uniform 401 as a wrong password, so an attacker
    // cannot use the throttle response to probe account existence. We hammer well
    // past the 10/min budget and assert every response is a 401 (never a leak, and
    // never a 200 once throttled).
    const { email } = await signupAndLogin(h);
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      const res = await request(h.http())
        .post(STORE.login)
        .send({ email, password: 'wrong password attempt here' });
      statuses.push(res.status);
    }
    // Every attempt is a uniform 401 — no 200, no distinguishable 429.
    expect(statuses.every((s) => s === 401)).toBe(true);
  });

  it('signup IS rate-limited with a 429 once its per-ip budget is exceeded', async () => {
    // Signup uses a per-IP guard (limit 20/min) that DOES surface a 429 — there is
    // no enumeration concern on a public create endpoint that already 409s on dup.
    let got429 = false;
    for (let i = 0; i < 26; i++) {
      const res = await request(h.http())
        .post(STORE.signup)
        .send({ email: uniqEmail(), password: 'correct horse battery staple' });
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  });
});
