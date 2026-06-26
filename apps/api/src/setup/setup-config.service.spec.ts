/**
 * SetupConfigService UNIT tests (no live SMTP/DB; `jest.config.js`).
 * SECURITY-CRITICAL.
 *
 * `nodemailer.createTransport` is mocked (mirrors smtp.transport.spec.ts) so the SMTP
 * test path is exercised WITHOUT a real server and WITHOUT touching the live
 * MailService singleton. The invariants pinned here:
 *   - smtp/test builds a THROWAWAY transport FROM THE SUBMITTED creds, invokes sendMail
 *     to the `to` address, and CLOSES the transport (always, success or failure);
 *   - an SMTP failure returns a SANITIZED `{ok:false, error}` — never the recipient,
 *     password, host, or server reply;
 *   - configureSmtp / configurePayments delegate to SetupSecretsService (encrypt at
 *     rest) and persist only NON-secret data (methods) into settings — no key echoed.
 */
const sendMail = jest.fn();
const close = jest.fn();
const createTransport = jest.fn(
  (_opts: Record<string, unknown>) => ({ sendMail, close }) as unknown,
);
jest.mock('nodemailer', () => ({ createTransport }));

// Mock the Stripe SDK so configurePayments' best-effort live validation never makes a
// real network call. `balance.retrieve` rejects with a non-auth error → 'unvalidated'.
const balanceRetrieve = jest.fn().mockRejectedValue(new Error('offline'));
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({ balance: { retrieve: balanceRetrieve } })),
);

import { SetupConfigService } from './setup-config.service';
import type { SetupSecretsService } from './setup-secrets.service';
import type { DatabaseService } from '../database/database.service';
import { TenantSettingsService } from '../taxes/tenant-settings.service';

const TENANT = '00000000-0000-7000-8000-0000000000aa';

/** A no-op TenantSettingsService stand-in for the tests that don't exercise the cache. */
function noopSettings(): TenantSettingsService {
  return { invalidate: () => {} } as unknown as TenantSettingsService;
}

function makeSecretsSpy(): {
  service: SetupSecretsService;
  putJson: jest.Mock;
} {
  const putJson = jest.fn().mockResolvedValue(undefined);
  return { service: { putJson } as unknown as SetupSecretsService, putJson };
}

/** A DatabaseService fake for the payments settings read-merge-write. */
function makePaymentsDb(captured: { settings?: unknown }): DatabaseService {
  return {
    db: {
      select: () => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([{ settings: {} }]) }) }),
      }),
      update: () => ({
        set: (v: { settings: unknown }) => {
          captured.settings = v.settings;
          return { where: () => Promise.resolve() };
        },
      }),
    },
  } as unknown as DatabaseService;
}

afterEach(() => {
  sendMail.mockReset();
  close.mockReset();
  createTransport.mockClear();
});

describe('SetupConfigService.testSmtp (unit, SECURITY-CRITICAL)', () => {
  const svc = new SetupConfigService(
    {} as unknown as DatabaseService,
    {} as unknown as SetupSecretsService,
    noopSettings(),
  );

  const creds = {
    host: 'mail.internal',
    port: 587,
    secure: false,
    user: 'smtp-user',
    pass: 'smtp-pass',
    from: 'store@example.com',
    to: 'owner@example.com',
  };

  it('builds a throwaway transport from the submitted creds and sends to `to`', async () => {
    sendMail.mockResolvedValue({ messageId: '<ok@mail>' });
    const res = await svc.testSmtp(creds);

    expect(res).toEqual({ ok: true });
    // throwaway transport built from EXACTLY the submitted creds (host/port/secure/auth)
    expect(createTransport).toHaveBeenCalledTimes(1);
    const opts = createTransport.mock.calls[0]![0];
    expect(opts.host).toBe('mail.internal');
    expect(opts.port).toBe(587);
    expect(opts.secure).toBe(false);
    expect(opts.auth).toEqual({ user: 'smtp-user', pass: 'smtp-pass' });
    expect(opts.logger).toBe(false);
    // sent to the provided recipient
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect((sendMail.mock.calls[0]![0] as { to: string }).to).toBe('owner@example.com');
    // transport closed
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('omits auth when user/pass are not both present', async () => {
    sendMail.mockResolvedValue({});
    await svc.testSmtp({ ...creds, user: undefined, pass: undefined });
    const opts = createTransport.mock.calls[0]![0];
    expect(opts.auth).toBeUndefined();
  });

  it('on failure returns a SANITIZED error — no recipient, password, host, or reply', async () => {
    const err = Object.assign(
      new Error('550 5.1.1 <owner@example.com>: Recipient rejected — auth smtp-pass'),
      { responseCode: 550, code: 'EENVELOPE', command: 'RCPT TO' },
    );
    sendMail.mockRejectedValue(err);

    const res = await svc.testSmtp(creds);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('550');
    expect(res.error).not.toContain('owner@example.com');
    expect(res.error).not.toContain('smtp-pass');
    expect(res.error).not.toContain('mail.internal');
    expect(res.error).not.toMatch(/@/);
    // transport still closed on the error path
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('SetupConfigService.configureSmtp (unit)', () => {
  it('encrypts the credential blob via SetupSecretsService (kind smtp), nothing plaintext', async () => {
    const { service, putJson } = makeSecretsSpy();
    const svc = new SetupConfigService({} as unknown as DatabaseService, service, noopSettings());
    await svc.configureSmtp(TENANT, {
      host: 'h',
      port: 25,
      secure: false,
      user: 'u',
      pass: 'p',
      from: 'f@x.test',
    });
    expect(putJson).toHaveBeenCalledWith(TENANT, 'smtp', expect.objectContaining({ host: 'h' }));
  });
});

describe('SetupConfigService.configurePayments (unit, SECURITY-CRITICAL)', () => {
  it('persists methods into settings.payments and encrypts the Stripe blob (no key in settings)', async () => {
    const captured: { settings?: unknown } = {};
    const { service, putJson } = makeSecretsSpy();
    const svc = new SetupConfigService(makePaymentsDb(captured), service, noopSettings());

    await svc.configurePayments(TENANT, {
      methods: ['stripe', 'manual'],
      stripe: { secretKey: 'sk_live_SECRET', publishableKey: 'pk_live_PUB' },
    });

    // methods persisted (non-secret) into settings
    expect(captured.settings).toEqual(
      expect.objectContaining({ payments: { methods: ['stripe', 'manual'] } }),
    );
    // the secret key NEVER lands in plaintext settings
    expect(JSON.stringify(captured.settings)).not.toContain('sk_live_SECRET');
    // the Stripe blob is encrypted at rest under kind 'stripe'
    expect(putJson).toHaveBeenCalledWith(
      TENANT,
      'stripe',
      expect.objectContaining({ secretKey: 'sk_live_SECRET' }),
    );
  });

  it('skips the Stripe blob when no stripe creds are supplied', async () => {
    const captured: { settings?: unknown } = {};
    const { service, putJson } = makeSecretsSpy();
    const svc = new SetupConfigService(makePaymentsDb(captured), service, noopSettings());
    await svc.configurePayments(TENANT, { methods: ['manual'] });
    expect(putJson).not.toHaveBeenCalled();
  });
});

/**
 * Regression test: configurePayments must be CACHE-COHERENT with TenantSettingsService.
 * configurePayments writes settings.payments.methods straight to the DB; if it does not
 * invalidate TenantSettingsService's in-process cache, a later tax/onboarding update
 * (which read-merge-writes FROM that stale cache) silently DROPS settings.payments.methods.
 * This pins that the methods SURVIVE the subsequent update.
 */
describe('SetupConfigService.configurePayments cache coherence', () => {
  /** A DatabaseService fake backed by a single shared `settings` object (one tenant row). */
  function makeSharedDb(store: { settings: Record<string, unknown> }): DatabaseService {
    return {
      db: {
        select: () => ({
          from: () => ({
            where: () => ({ limit: () => Promise.resolve([{ settings: store.settings }]) }),
          }),
        }),
        update: () => ({
          set: (v: { settings: Record<string, unknown> }) => {
            store.settings = v.settings;
            return { where: () => Promise.resolve() };
          },
        }),
      },
    } as unknown as DatabaseService;
  }

  it('payments.methods survives a later onboarding-profile update (no stale-cache wipe)', async () => {
    const store = { settings: {} as Record<string, unknown> };
    const db = makeSharedDb(store);
    const settings = new TenantSettingsService(db);
    const { service: secrets } = makeSecretsSpy();
    const svc = new SetupConfigService(db, secrets, settings);

    // Prime the TenantSettingsService cache with the (empty) current settings, mirroring
    // a real flow where a tax read happens before the payments step.
    await settings.getOnboardingProfile(TENANT);

    // Payments step persists methods directly to the DB.
    await svc.configurePayments(TENANT, { methods: ['stripe', 'manual'] });

    // A later onboarding/tax update goes through TenantSettingsService (read-merge-write
    // from its cache). Before the fix this read a STALE cache and wiped payments.methods.
    await settings.updateOnboardingProfile(TENANT, { defaultCurrency: 'eur' });

    expect((store.settings as { payments?: { methods?: string[] } }).payments?.methods).toEqual([
      'stripe',
      'manual',
    ]);
    expect(store.settings.default_currency).toBe('EUR');
  });
});
