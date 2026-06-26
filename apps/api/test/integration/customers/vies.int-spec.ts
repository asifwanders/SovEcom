/**
 * VIES VAT validation (mocked, no network).
 * valid → vat_validated + durable consultationRef proof; invalid/unreachable →
 * vat_validated=false; signup NEVER blocked on the outcome; the mock was used.
 */
import request from 'supertest';
import {
  bootCustomersApp,
  teardownCustomersApp,
  resetCustomersState,
  setTenantTaxMode,
  rawCustomer,
  uniqEmail,
  STORE,
  CustomersHarness,
} from './_customers-harness';

const PW = 'correct horse battery staple';

describe('VIES VAT validation (integration, mocked)', () => {
  let h: CustomersHarness;
  beforeAll(async () => {
    h = await bootCustomersApp();
  });
  afterAll(async () => {
    await teardownCustomersApp(h);
  });
  beforeEach(async () => {
    await resetCustomersState(h);
    // VIES is an EU-VAT concept — it only runs under tax_mode='eu_vat'.
    // These tests exercise that path, so opt the tenant in. (The non-EU `none` default
    // — which SKIPS VIES — is asserted by the dedicated test below.)
    await setTenantTaxMode(h, 'eu_vat');
  });

  it('valid VAT → vat_validated=true + consultationRef persisted in metadata', async () => {
    h.vies.queue({ status: 'valid', consultationRef: 'WAPIAAAAX_ref_123', companyName: 'ACME' });
    const res = await request(h.http())
      .post(STORE.signup)
      .send({ email: uniqEmail(), password: PW, isB2b: true, vatNumber: 'FR12345678901' });
    expect(res.status).toBe(201);
    expect(res.body.vatValidated).toBe(true);
    expect(h.vies.calls).toBe(1); // mock used, no real network

    const row = await rawCustomer(h, res.body.id);
    expect(row!.vat_validated).toBe(true);
    expect(row!.vat_validated_at).not.toBeNull();
    const meta = row!.metadata as { vat?: { status: string; consultationRef?: string } };
    expect(meta.vat?.status).toBe('valid');
    expect(meta.vat?.consultationRef).toBe('WAPIAAAAX_ref_123');
    // The metadata internal must NOT leak into the response body.
    expect(res.body).not.toHaveProperty('metadata');
  });

  it('tax_mode=none (non-EU merchant) → VIES is SKIPPED: number stored, vat_validated=false, no proof, no call', async () => {
    // A Pakistan/US store on the `none` regime: a supplied tax ID must NOT trigger an
    // EU VIES call nor get mislabelled "invalid".
    await setTenantTaxMode(h, 'none');
    h.vies.queue({ status: 'valid', consultationRef: 'should_not_be_used' });
    const res = await request(h.http())
      .post(STORE.signup)
      .send({ email: uniqEmail(), password: PW, isB2b: true, vatNumber: 'PK1234567' });
    expect(res.status).toBe(201);
    expect(res.body.vatValidated).toBe(false);
    expect(h.vies.calls).toBe(0); // NO EU SOAP call for a non-EU regime

    const row = await rawCustomer(h, res.body.id);
    expect(row!.vat_number).toBe('PK1234567'); // number is still stored as-is
    expect(row!.vat_validated).toBe(false);
    expect(row!.vat_validated_at).toBeNull();
    const meta = row!.metadata as { vat?: unknown };
    expect(meta.vat).toBeUndefined(); // no VIES proof persisted
  });

  it('invalid VAT → vat_validated=false + metadata status invalid; signup still 201', async () => {
    h.vies.queue({ status: 'invalid' });
    const res = await request(h.http())
      .post(STORE.signup)
      .send({ email: uniqEmail(), password: PW, isB2b: true, vatNumber: 'FR00000000000' });
    expect(res.status).toBe(201);
    expect(res.body.vatValidated).toBe(false);
    const row = await rawCustomer(h, res.body.id);
    expect(row!.vat_validated).toBe(false);
    const meta = row!.metadata as { vat?: { status: string } };
    expect(meta.vat?.status).toBe('invalid');
  });

  it('unreachable VIES → vat_validated=false (tax-safe) AND signup STILL succeeds (non-blocking)', async () => {
    h.vies.queue({ status: 'unreachable' });
    const res = await request(h.http())
      .post(STORE.signup)
      .send({ email: uniqEmail(), password: PW, isB2b: true, vatNumber: 'DE999999999' });
    expect(res.status).toBe(201);
    expect(res.body.vatValidated).toBe(false);
    const row = await rawCustomer(h, res.body.id);
    const meta = row!.metadata as { vat?: { status: string } };
    expect(meta.vat?.status).toBe('unreachable');
  });

  it('a VAT change on update re-runs VIES', async () => {
    // Signup without VAT → no VIES call.
    const email = uniqEmail();
    const signup = await request(h.http()).post(STORE.signup).send({ email, password: PW });
    expect(signup.status).toBe(201);
    expect(h.vies.calls).toBe(0);

    const login = await request(h.http()).post(STORE.login).send({ email, password: PW });
    const token = login.body.accessToken as string;

    h.vies.queue({ status: 'valid', consultationRef: 'ref_on_update' });
    const patch = await request(h.http())
      .patch(STORE.me)
      .set('Authorization', `Bearer ${token}`)
      .send({ vatNumber: 'FR12345678901' });
    expect(patch.status).toBe(200);
    expect(patch.body.vatValidated).toBe(true);
    expect(h.vies.calls).toBe(1);
  });

  it('F4: a cache hit does NOT fabricate another customer consultationRef', async () => {
    const VAT = 'FR12345678901';

    // Customer 1: LIVE valid → persists the REAL per-consultation ref.
    h.vies.queue({ status: 'valid', consultationRef: 'LIVE_REF_for_customer_1' });
    const c1 = await request(h.http())
      .post(STORE.signup)
      .send({ email: uniqEmail(), password: PW, isB2b: true, vatNumber: VAT });
    expect(c1.status).toBe(201);
    expect(h.vies.calls).toBe(1);
    const m1 = (await rawCustomer(h, c1.body.id))!.metadata as {
      vat?: { status: string; consultationRef?: string; cached?: boolean };
    };
    expect(m1.vat?.status).toBe('valid');
    expect(m1.vat?.consultationRef).toBe('LIVE_REF_for_customer_1');
    expect(m1.vat?.cached).toBeUndefined();

    // Customer 2: SAME VAT → served from the 24h positive cache (no live call).
    const c2 = await request(h.http())
      .post(STORE.signup)
      .send({ email: uniqEmail(), password: PW, isB2b: true, vatNumber: VAT });
    expect(c2.status).toBe(201);
    expect(c2.body.vatValidated).toBe(true);
    // The mock was NOT called a second time — the cache served customer 2.
    expect(h.vies.calls).toBe(1);

    const m2 = (await rawCustomer(h, c2.body.id))!.metadata as {
      vat?: { status: string; consultationRef?: string; cached?: boolean };
    };
    expect(m2.vat?.status).toBe('valid');
    // Crucially: customer 2 must NOT carry customer 1's consultation evidence.
    expect(m2.vat?.consultationRef).toBeUndefined();
    expect(m2.vat?.cached).toBe(true);
  });
});
