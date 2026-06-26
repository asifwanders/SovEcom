/**
 * RGPD export + erase (pseudonymization) (SECURITY-CRITICAL).
 * Export ≠ erase; both self-service endpoints are STEP-UP-protected (current
 * password re-entry) and admin erase requires a confirmEmail echo. Erase
 * satisfies customer anonymization constraints, scrubs VAT, deletes addresses,
 * revokes all sessions, is irreversible, and a fresh signup with the original
 * email succeeds (partial unique index).
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  bootCustomersApp,
  teardownCustomersApp,
  resetCustomersState,
  signupAndLogin,
  seedAdmin,
  adminLogin,
  rawCustomer,
  countLiveRefresh,
  auditRows,
  uniqEmail,
  DEFAULT_TENANT_ID,
  ADMIN,
  STORE,
  CustomersHarness,
} from './_customers-harness';

const PW = 'correct horse battery staple';
const WRONG_PW = 'definitely not the password';
const ADDR = {
  type: 'shipping' as const,
  name: 'Alice',
  line1: '1 Rue de Test',
  city: 'Paris',
  postalCode: '75001',
  country: 'FR',
};

describe('RGPD export + erase (integration, SECURITY-CRITICAL)', () => {
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

  // ── Export (POST + step-up, ruling A) ───────────────────────────────────────

  it('export (with correct password) returns own profile + addresses, NO secrets', async () => {
    const c = await signupAndLogin(h);
    await request(h.http())
      .post(STORE.addresses)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send(ADDR);

    const exp = await request(h.http())
      .post(STORE.export)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ password: c.password });
    expect(exp.status).toBe(200);
    expect(exp.body.profile.email).toBe(c.email);
    expect(exp.body.addresses).toHaveLength(1);
    const serialized = JSON.stringify(exp.body);
    expect(serialized).not.toMatch(/passwordHash|password_hash|totpSecret|totp_secret/);
  });

  it('export with WRONG password → 401, nothing exported', async () => {
    const c = await signupAndLogin(h);
    const exp = await request(h.http())
      .post(STORE.export)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ password: WRONG_PW });
    expect(exp.status).toBe(401);
    expect(exp.body.profile).toBeUndefined();
  });

  it('export does not leak other customers data', async () => {
    const a = await signupAndLogin(h);
    const b = await signupAndLogin(h);
    const exp = await request(h.http())
      .post(STORE.export)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ password: a.password });
    expect(exp.body.profile.email).toBe(a.email);
    expect(JSON.stringify(exp.body)).not.toContain(b.email);
  });

  // ── Self erase (POST + step-up, ruling A) ────────────────────────────────────

  it('self erase with WRONG password → 401, customer is NOT erased', async () => {
    const c = await signupAndLogin(h);
    const erase = await request(h.http())
      .post(STORE.erase)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .set('Cookie', c.refreshCookie)
      .send({ password: WRONG_PW });
    expect(erase.status).toBe(401);
    const row = await rawCustomer(h, c.customerId);
    expect(row!.anonymized_at).toBeNull();
    expect(row!.email).toBe(c.email);
  });

  it('self erase (correct password): scrubs row+VAT (CHECK held), deletes addresses, revokes sessions, blocks login', async () => {
    // Sign up a B2B customer WITH a valid VAT so we can assert the VAT scrub (C).
    const email = uniqEmail();
    h.vies.queue({ status: 'valid', consultationRef: 'ref_erase_vat' });
    const signup = await request(h.http())
      .post(STORE.signup)
      .send({ email, password: PW, isB2b: true, vatNumber: 'FR12345678901' });
    expect(signup.status).toBe(201);
    const customerId = signup.body.id as string;
    const login = await request(h.http()).post(STORE.login).send({ email, password: PW });
    const accessToken = login.body.accessToken as string;
    const refreshCookie = (login.headers['set-cookie'] as unknown as string[]).find((x) =>
      x.startsWith('sov_customer_refresh='),
    )!;
    await request(h.http())
      .post(STORE.addresses)
      .set('Authorization', `Bearer ${accessToken}`)
      .send(ADDR);
    expect(await countLiveRefresh(h, customerId)).toBe(1);

    const erase = await request(h.http())
      .post(STORE.erase)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', refreshCookie)
      .send({ password: PW });
    expect(erase.status).toBe(204);

    // Row scrubbed in the exact shape the CHECK requires (the UPDATE succeeded).
    const row = await rawCustomer(h, customerId);
    expect(row!.anonymized_at).not.toBeNull();
    expect(row!.deleted_at).not.toBeNull();
    expect(String(row!.email)).toMatch(/^anonymized-.*@deleted\.local$/);
    expect(row!.name).toBeNull();
    expect(row!.phone).toBeNull();
    expect(row!.password_hash).toBeNull();
    expect(row!.totp_secret).toBeNull();
    expect(row!.totp_enabled).toBe(false);

    // Ruling C: VAT identity fully scrubbed from the pseudonymized stub.
    expect(row!.vat_number).toBeNull();
    expect(row!.vat_validated).toBe(false);
    expect(row!.vat_validated_at).toBeNull();
    const meta = row!.metadata as { vat?: unknown };
    expect(meta.vat).toBeUndefined();

    // Addresses deleted, all sessions revoked.
    const addrCount = await h.client<{ c: string }[]>`
      select count(*)::int as c from customer_addresses where customer_id = ${customerId}`;
    expect(Number(addrCount[0]!.c)).toBe(0);
    expect(await countLiveRefresh(h, customerId)).toBe(0);

    // Original PII is no longer queryable for that row.
    const byEmail = await h.client<Array<{ id: string }>>`
      select id from customers where email = ${email}`;
    expect(byEmail).toHaveLength(0);

    // The customer can no longer log in.
    const relogin = await request(h.http()).post(STORE.login).send({ email, password: PW });
    expect(relogin.status).toBe(401);

    // A fresh signup with the ORIGINAL email succeeds (partial unique index).
    const fresh = await request(h.http()).post(STORE.signup).send({ email, password: PW });
    expect(fresh.status).toBe(201);
    expect(fresh.body.id).not.toBe(customerId);
  });

  it('self erase nulls pending_email + PURGES all email_change_tokens', async () => {
    const c = await signupAndLogin(h, { password: PW });

    // Initiate a real change → one LIVE token + pending_email set on the row.
    const liveEmail = uniqEmail();
    await request(h.http())
      .post('/store/v1/customers/me/email/change')
      .set('Authorization', `Bearer ${c.accessToken}`)
      .send({ newEmail: liveEmail, currentPassword: PW })
      .expect(202);

    // Also seed a CONSUMED token row directly (a prior, already-confirmed change). Its
    // pending_email is THIRD-PARTY PII that the erase must PURGE too — this spec doesn't
    // enable the token sink, so we inject the consumed row via SQL rather than driving
    // /confirm. (SELECT-guard not needed: token_hash is unique + we generate a fresh id.)
    const consumedTarget = uniqEmail();
    await h.client`
      insert into email_change_tokens (id, tenant_id, customer_id, token_hash, pending_email, expires_at, consumed_at)
      values (${randomUUID()}, ${DEFAULT_TENANT_ID}, ${c.customerId}, ${randomUUID()},
        ${consumedTarget}, now() + interval '1 hour', now())`;

    const mid = await rawCustomer(h, c.customerId);
    expect(mid!.pending_email).toBe(liveEmail);
    const totalBefore = await h.client<{ n: string }[]>`
      select count(*)::int as n from email_change_tokens where customer_id = ${c.customerId}`;
    expect(Number(totalBefore[0]!.n)).toBe(2); // one live + one consumed

    // Self-erase.
    await request(h.http())
      .post(STORE.erase)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .set('Cookie', c.refreshCookie)
      .send({ password: PW })
      .expect(204);

    // pending_email is nulled (must not leak the in-flight target on the scrubbed stub).
    const row = await rawCustomer(h, c.customerId);
    expect(row!.pending_email).toBeNull();

    // F1/F12: ZERO email_change_token rows remain — the third-party pending_email PII is
    // GONE (consumed rows purged too, not merely flagged consumed).
    const totalAfter = await h.client<{ n: string }[]>`
      select count(*)::int as n from email_change_tokens where customer_id = ${c.customerId}`;
    expect(Number(totalAfter[0]!.n)).toBe(0);
  });

  it('erase scrubs order address snapshots + email_logs recipient', async () => {
    const email = uniqEmail();
    const signup = await request(h.http()).post(STORE.signup).send({ email, password: PW });
    const customerId = signup.body.id as string;
    const login = await request(h.http()).post(STORE.login).send({ email, password: PW });
    const accessToken = login.body.accessToken as string;
    const refreshCookie = (login.headers['set-cookie'] as unknown as string[]).find((x) =>
      x.startsWith('sov_customer_refresh='),
    )!;

    // Seed an order owned by this customer (PII in the address snapshot + order email) and a
    // logged email sent to them.
    const orderId = randomUUID();
    const emailLogId = randomUUID();
    const addr = JSON.stringify({
      name: 'Alice Jones',
      line1: '1 Rue de Test',
      city: 'Paris',
      postalCode: '75001',
      country: 'FR',
      phone: '+33123456789',
    });
    await h.client`
      insert into orders (id, tenant_id, customer_id, order_number, email, status, currency,
        subtotal_amount, total_amount, tax_amount, tax_inclusive, shipping_address, billing_address)
      values (${orderId}, ${DEFAULT_TENANT_ID}, ${customerId}, ${'SO-ERASE'}, ${email}, ${'paid'},
        ${'EUR'}, ${1000}, ${1000}, ${0}, ${false}, ${addr}::jsonb, ${addr}::jsonb)`;
    await h.client`
      insert into email_logs (id, tenant_id, order_id, recipient, type, subject, status, attempts)
      values (${emailLogId}, ${DEFAULT_TENANT_ID}, ${orderId}, ${email}, ${'order_confirmation'},
        ${'Order SO-ERASE confirmed'}, ${'sent'}, ${1})`;

    await request(h.http())
      .post(STORE.erase)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', refreshCookie)
      .send({ password: PW })
      .expect(204);

    // Order survives, but its address PII is scrubbed (country kept) and email anonymized.
    const [o] = await h.client<
      {
        email: string;
        shipping_address: Record<string, unknown>;
        billing_address: Record<string, unknown>;
      }[]
    >`select email, shipping_address, billing_address from orders where id = ${orderId}`;
    expect(o).toBeDefined();
    expect(String(o!.email)).toMatch(/^anonymized-.*@deleted\.local$/);
    expect(o!.shipping_address.country).toBe('FR');
    expect(o!.shipping_address.erased).toBe(true);
    expect(o!.shipping_address.name).toBeUndefined();
    expect(o!.shipping_address.line1).toBeUndefined();
    expect(o!.billing_address.country).toBe('FR'); // billing scrubbed the same way (country kept)
    expect(o!.billing_address.erased).toBe(true);
    expect(JSON.stringify(o!.shipping_address)).not.toContain('Alice');
    expect(JSON.stringify(o!.billing_address)).not.toContain('Alice');
    expect(JSON.stringify(o!)).not.toContain('+33123456789');

    // The transactional email's recipient is scrubbed.
    const [el] = await h.client<{ recipient: string }[]>`
      select recipient from email_logs where id = ${emailLogId}`;
    expect(String(el!.recipient)).toMatch(/^anonymized-.*@deleted\.local$/);
    expect(el!.recipient).not.toBe(email);
  });

  it('guest order (no customer_id): email_logs scrubbed by recipient, but the order snapshot is NOT (account-scoped)', async () => {
    const email = uniqEmail();
    const signup = await request(h.http()).post(STORE.signup).send({ email, password: PW });
    const customerId = signup.body.id as string;
    const login = await request(h.http()).post(STORE.login).send({ email, password: PW });
    const accessToken = login.body.accessToken as string;
    const refreshCookie = (login.headers['set-cookie'] as unknown as string[]).find((x) =>
      x.startsWith('sov_customer_refresh='),
    )!;

    // A GUEST order to the same email address (customer_id NULL — not linked to the account).
    const guestOrderId = randomUUID();
    const guestLogId = randomUUID();
    const addr = JSON.stringify({
      name: 'Bob Guest',
      line1: '9 Guest St',
      city: 'Lyon',
      postalCode: '69001',
      country: 'FR',
    });
    await h.client`
      insert into orders (id, tenant_id, customer_id, order_number, email, status, currency,
        subtotal_amount, total_amount, tax_amount, tax_inclusive, shipping_address, billing_address)
      values (${guestOrderId}, ${DEFAULT_TENANT_ID}, ${null}, ${'SO-GUEST'}, ${email}, ${'paid'},
        ${'EUR'}, ${1000}, ${1000}, ${0}, ${false}, ${addr}::jsonb, ${addr}::jsonb)`;
    await h.client`
      insert into email_logs (id, tenant_id, order_id, recipient, type, subject, status, attempts)
      values (${guestLogId}, ${DEFAULT_TENANT_ID}, ${guestOrderId}, ${email}, ${'order_confirmation'},
        ${'Order SO-GUEST confirmed'}, ${'sent'}, ${1})`;

    await request(h.http())
      .post(STORE.erase)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', refreshCookie)
      .send({ password: PW })
      .expect(204);

    // email_logs are scrubbed by recipient match (catches the guest email too).
    const [gl] = await h.client<{ recipient: string }[]>`
      select recipient from email_logs where id = ${guestLogId}`;
    expect(String(gl!.recipient)).toMatch(/^anonymized-.*@deleted\.local$/);

    // The GUEST order snapshot is intentionally NOT scrubbed — erasure is account-scoped, and a
    // guest checkout is not linked to the erased account. Pins the carve-out.
    const [go] = await h.client<{ email: string; shipping_address: Record<string, unknown> }[]>`
      select email, shipping_address from orders where id = ${guestOrderId}`;
    expect(go!.email).toBe(email); // untouched
    expect(go!.shipping_address.name).toBe('Bob Guest'); // untouched
    expect(String(customerId)).toMatch(/^[0-9a-f-]{36}$/); // (sanity: the erased account existed)
  });

  // ── Admin erase (DELETE + confirmEmail echo, ruling B) ───────────────────────

  it('admin erase with WRONG/MISSING confirmEmail → 400, no-op', async () => {
    const admin = await seedAdmin(h, { tenantId: DEFAULT_TENANT_ID, role: 'admin' });
    const token = await adminLogin(h, admin);
    const c = await signupAndLogin(h);

    // Missing confirmEmail → 400 (DTO/strict).
    const missing = await request(h.http())
      .delete(`${ADMIN.customers}/${c.customerId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(missing.status).toBe(400);

    // Wrong confirmEmail → 400 (server-side echo mismatch).
    const wrong = await request(h.http())
      .delete(`${ADMIN.customers}/${c.customerId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ confirmEmail: uniqEmail() });
    expect(wrong.status).toBe(400);

    // Customer untouched.
    const row = await rawCustomer(h, c.customerId);
    expect(row!.anonymized_at).toBeNull();
    expect(row!.email).toBe(c.email);
  });

  it('admin erase (matching confirmEmail): scrubs + writes a customer.erased audit row in-tx (actor=admin)', async () => {
    const admin = await seedAdmin(h, { tenantId: DEFAULT_TENANT_ID, role: 'admin' });
    const token = await adminLogin(h, admin);
    const c = await signupAndLogin(h);

    const del = await request(h.http())
      .delete(`${ADMIN.customers}/${c.customerId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ confirmEmail: c.email });
    expect(del.status).toBe(204);

    const row = await rawCustomer(h, c.customerId);
    expect(row!.anonymized_at).not.toBeNull();
    expect(String(row!.email)).toMatch(/^anonymized-.*@deleted\.local$/);
    expect(row!.vat_number).toBeNull();

    const audit = await auditRows(h, 'customer.erased');
    const adminErase = audit.find((r) => (r.changes as { via?: string })?.via === 'admin');
    expect(adminErase).toBeDefined();
    expect(adminErase!.actor_type).toBe('user');
    expect(adminErase!.actor_id).toBe(admin.id);
    expect(adminErase!.resource_id).toBe(c.customerId);
  });

  it('admin erase of an already-erased / unknown id → 404', async () => {
    const admin = await seedAdmin(h, { tenantId: DEFAULT_TENANT_ID, role: 'admin' });
    const token = await adminLogin(h, admin);
    const c = await signupAndLogin(h);

    const first = await request(h.http())
      .delete(`${ADMIN.customers}/${c.customerId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ confirmEmail: c.email });
    expect(first.status).toBe(204);
    // Second attempt: the row is anonymized → its email no longer matches → 404.
    const second = await request(h.http())
      .delete(`${ADMIN.customers}/${c.customerId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ confirmEmail: c.email });
    expect(second.status).toBe(404);
  });

  it('an erased customer access token can no longer reach /me (guard rejects anonymized)', async () => {
    const c = await signupAndLogin(h);
    await request(h.http())
      .post(STORE.erase)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .set('Cookie', c.refreshCookie)
      .send({ password: c.password });
    // Same still-unexpired access token, now pointing at an anonymized row.
    const me = await request(h.http())
      .get(STORE.me)
      .set('Authorization', `Bearer ${c.accessToken}`);
    expect(me.status).toBe(401);
  });
});
