/**
 * SetupInstallService UNIT tests (`jest.config.js`). SECURITY-CRITICAL
 *: the install precondition logic + idempotency.
 *
 * Fakes stand in for Postgres + TenantSettingsService. The invariants pinned here:
 *   - PRECONDITION: 422 (SetupPreconditionError) listing what is missing — admin and/or
 *     tax — when either is unconfigured; the `missing` array names exactly the gaps.
 *   - GREEN PATH: with admin_configured + a business country, complete() consumes the
 *     token (one tx) and flips installed=true → {installed:true}.
 *   - IDEMPOTENT: already-installed → {installed:true} WITHOUT consuming a token again.
 *
 * The full atomic consume-and-flip + concurrency is covered by the integration +
 * concurrency suites against real Postgres; here we assert the gate logic.
 */
import { SetupInstallService, SetupPreconditionError } from './setup-install.service';

const TENANT = '00000000-0000-7000-8000-0000000000aa';

interface State {
  installed: boolean;
  adminConfigured: boolean;
  businessCountry: string | null;
  tokenClaimable: boolean;
}

class FakeDatabase {
  consumeCalls = 0;
  flips = 0;

  constructor(private readonly s: State) {}

  db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: (): Promise<{ value: unknown }[]> => {
            // The service reads installed then admin_configured via two separate
            // select().where(eq(key,...)) calls. We disambiguate by call order using a
            // tiny queue set up per invocation below.
            const next = this.selectQueue.shift();
            return Promise.resolve(next === undefined ? [] : [{ value: next }]);
          },
        }),
      }),
    }),
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(this.tx),
  };

  // Order: complete() calls isInstalled(), then (if not installed) collectMissing →
  // isAdminConfigured(). We feed those reads here.
  selectQueue: unknown[] = [];

  private tx = {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: (): Promise<{ id: string }[]> => {
            this.consumeCalls += 1;
            return Promise.resolve(this.s.tokenClaimable ? [{ id: 'tok-1' }] : []);
          },
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: (): Promise<void> => {
          this.flips += 1;
          this.s.installed = true;
          return Promise.resolve();
        },
      }),
    }),
  };
}

function build(s: State): { svc: SetupInstallService; db: FakeDatabase } {
  const db = new FakeDatabase(s);
  const settings = {
    getTaxSettings: (): Promise<{ taxMode: string }> => Promise.resolve({ taxMode: 'none' }),
    getOnboardingProfile: (): Promise<{ businessCountry: string | null }> =>
      Promise.resolve({ businessCountry: s.businessCountry }),
  };
  const svc = new SetupInstallService(db as never, settings as never);
  return { svc, db };
}

/** Prime the two system_state reads complete() makes: installed, then admin_configured. */
function primeReads(db: FakeDatabase, s: State): void {
  db.selectQueue = [
    s.installed ? true : false, // isInstalled()
    s.adminConfigured ? true : false, // isAdminConfigured()
  ];
}

describe('SetupInstallService (unit, SECURITY-CRITICAL)', () => {
  it('422 listing BOTH gaps when neither admin nor tax is configured', async () => {
    const s: State = {
      installed: false,
      adminConfigured: false,
      businessCountry: null,
      tokenClaimable: true,
    };
    const { svc, db } = build(s);
    primeReads(db, s);
    await expect(svc.complete(TENANT, 'tok')).rejects.toMatchObject({
      missing: ['admin_account', 'tax_configuration'],
    });
    // No token consumed when preconditions fail.
    expect(db.consumeCalls).toBe(0);
    expect(db.flips).toBe(0);
  });

  it('422 listing ONLY tax when admin is done but tax is not', async () => {
    const s: State = {
      installed: false,
      adminConfigured: true,
      businessCountry: null,
      tokenClaimable: true,
    };
    const { svc, db } = build(s);
    primeReads(db, s);
    const err = await svc.complete(TENANT, 'tok').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SetupPreconditionError);
    expect((err as SetupPreconditionError).missing).toEqual(['tax_configuration']);
  });

  it('422 listing ONLY admin when tax is done but admin is not', async () => {
    const s: State = {
      installed: false,
      adminConfigured: false,
      businessCountry: 'FR',
      tokenClaimable: true,
    };
    const { svc, db } = build(s);
    primeReads(db, s);
    const err = await svc.complete(TENANT, 'tok').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SetupPreconditionError);
    expect((err as SetupPreconditionError).missing).toEqual(['admin_account']);
  });

  it('GREEN: admin + tax done → consumes the token (1 tx) + flips installed → {installed:true}', async () => {
    const s: State = {
      installed: false,
      adminConfigured: true,
      businessCountry: 'FR',
      tokenClaimable: true,
    };
    const { svc, db } = build(s);
    primeReads(db, s);
    await expect(svc.complete(TENANT, 'tok')).resolves.toEqual({ installed: true });
    expect(db.consumeCalls).toBe(1);
    expect(db.flips).toBe(1);
  });

  it('IDEMPOTENT: already installed → {installed:true} WITHOUT consuming a token', async () => {
    const s: State = {
      installed: true,
      adminConfigured: true,
      businessCountry: 'FR',
      tokenClaimable: true,
    };
    const { svc, db } = build(s);
    primeReads(db, s);
    await expect(svc.complete(TENANT, 'tok')).resolves.toEqual({ installed: true });
    expect(db.consumeCalls).toBe(0);
    expect(db.flips).toBe(0);
  });

  it('lost the token race (claim 0 rows) but installed now → {installed:true}', async () => {
    const s: State = {
      installed: false,
      adminConfigured: true,
      businessCountry: 'FR',
      tokenClaimable: false,
    };
    const { svc, db } = build(s);
    // First two reads: not installed, admin configured. Then after the lost claim the
    // service re-reads isInstalled() → true (the winner flipped it).
    db.selectQueue = [false, true, true];
    await expect(svc.complete(TENANT, 'tok')).resolves.toEqual({ installed: true });
    expect(db.consumeCalls).toBe(1);
    expect(db.flips).toBe(0); // we did NOT flip — the winner did.
  });
});
