/**
 * SetupSecretsService UNIT tests (no DB; `jest.config.js`).
 * SECURITY-CRITICAL (AEAD at rest, AAD = tenantId).
 *
 * A real {@link AeadService} (raw-key seam) does the crypto; the DatabaseService is a
 * lightweight fake whose insert/select capture what would hit `tenant_secrets`. The
 * invariants pinned here:
 *   - ROUND-TRIP: getSecret(putSecret(pt)) === pt (and JSON variant).
 *   - CIPHERTEXT ONLY: the stored blob never contains the plaintext bytes.
 *   - WRONG AAD: a row encrypted for tenant A cannot be decrypted under tenant B
 *     (the GCM/AAD bind makes decrypt THROW — cross-tenant replay fails closed).
 *   - upsert overwrites the same (tenant, kind) slot rather than accumulating.
 */
import { AeadService } from '../auth/crypto/aead.service';
import { SetupSecretsService } from './setup-secrets.service';

const KEY = Buffer.alloc(32, 11);
const TENANT_A = '00000000-0000-7000-8000-0000000000aa';
const TENANT_B = '00000000-0000-7000-8000-0000000000bb';

/** A row as it would live in `tenant_secrets`. */
interface Row {
  tenantId: string;
  kind: string;
  ciphertext: string;
}

/**
 * Build the service over a minimal in-memory stand-in for `DatabaseService.db`. The
 * service builds its drizzle predicate via `and(eq(...),eq(...))` (opaque to a fake),
 * so we capture the (tenantId, kind) positionally from the public-method arguments and
 * the fake reads the matching slot. Keyed by `${tenantId}:${kind}` (the unique slot).
 */
function makeService(store: Map<string, Row>): SetupSecretsService {
  const aead = new AeadService(KEY);
  // Capture tenantId/kind out-of-band: the service passes them positionally, so we
  // stash the last (tenantId, kind) seen by patching the public methods is overkill —
  // instead the fake's `where` is fed the real predicate; we model it by closure.
  let lastTenant = '';
  let lastKind = '';
  const db = {
    insert: () => ({
      values: (v: { tenantId: string; kind: string; ciphertext: string }) => {
        lastTenant = v.tenantId;
        lastKind = v.kind;
        return {
          onConflictDoUpdate: ({ set }: { set: { ciphertext: string } }) => {
            store.set(`${v.tenantId}:${v.kind}`, {
              tenantId: v.tenantId,
              kind: v.kind,
              ciphertext: set.ciphertext,
            });
            return Promise.resolve();
          },
        };
      },
    }),
    select: (cols: Record<string, unknown>) => ({
      from: () => ({
        // The service calls .where(and(eq(tenantId,...),eq(kind,...))). Our eq/and are
        // the real drizzle ones (opaque), so we can't read them — but the service reads
        // by the SAME (tenantId, kind) it was called with. We expose a setter the
        // public wrappers below populate.
        where: () => ({
          limit: () => {
            const row = store.get(`${lastTenant}:${lastKind}`);
            if (!row) return Promise.resolve([]);
            if ('id' in cols) return Promise.resolve([{ id: 'x' }]);
            return Promise.resolve([{ ciphertext: row.ciphertext }]);
          },
        }),
      }),
    }),
  };
  const svc = new SetupSecretsService({ db } as never, aead);
  // Wrap getSecret/hasSecret so lastTenant/lastKind are set before the query runs.
  const origGet = svc.getSecret.bind(svc);
  svc.getSecret = (t: string, k: string) => {
    lastTenant = t;
    lastKind = k;
    return origGet(t, k);
  };
  const origHas = svc.hasSecret.bind(svc);
  svc.hasSecret = (t: string, k: string) => {
    lastTenant = t;
    lastKind = k;
    return origHas(t, k);
  };
  return svc;
}

describe('SetupSecretsService (unit, SECURITY-CRITICAL)', () => {
  let store: Map<string, Row>;
  let svc: SetupSecretsService;

  beforeEach(() => {
    store = new Map();
    svc = makeService(store);
  });

  it('round-trips a plaintext secret through encrypt → store → decrypt', async () => {
    await svc.putSecret(TENANT_A, 'smtp', 'super-secret-pass');
    expect(await svc.getSecret(TENANT_A, 'smtp')).toBe('super-secret-pass');
  });

  it('round-trips a JSON credential blob', async () => {
    const creds = { host: 'mail.example.com', port: 587, pass: 'p@ss' };
    await svc.putJson(TENANT_A, 'smtp', creds);
    expect(await svc.getJson(TENANT_A, 'smtp')).toEqual(creds);
  });

  it('stores ONLY ciphertext — the plaintext never appears in the stored blob', async () => {
    await svc.putSecret(TENANT_A, 'stripe', 'sk_live_PLAINTEXT_KEY');
    const row = store.get(`${TENANT_A}:stripe`)!;
    expect(row.ciphertext).not.toContain('sk_live_PLAINTEXT_KEY');
    expect(row.ciphertext).not.toBe('sk_live_PLAINTEXT_KEY');
  });

  it('binds ciphertext to the tenant via AAD — wrong tenant cannot decrypt (fails closed)', async () => {
    await svc.putSecret(TENANT_A, 'smtp', 'tenant-a-secret');
    // Copy A's ciphertext into B's slot (a cross-tenant replay).
    const aRow = store.get(`${TENANT_A}:smtp`)!;
    store.set(`${TENANT_B}:smtp`, {
      tenantId: TENANT_B,
      kind: 'smtp',
      ciphertext: aRow.ciphertext,
    });
    await expect(svc.getSecret(TENANT_B, 'smtp')).rejects.toThrow();
  });

  it('getSecret returns null when no row exists', async () => {
    expect(await svc.getSecret(TENANT_A, 'absent')).toBeNull();
  });

  it('hasSecret reflects presence', async () => {
    expect(await svc.hasSecret(TENANT_A, 'smtp')).toBe(false);
    await svc.putSecret(TENANT_A, 'smtp', 'x');
    expect(await svc.hasSecret(TENANT_A, 'smtp')).toBe(true);
  });

  it('upsert overwrites the same (tenant, kind) slot rather than accumulating', async () => {
    await svc.putSecret(TENANT_A, 'smtp', 'first');
    await svc.putSecret(TENANT_A, 'smtp', 'second');
    expect(store.size).toBe(1);
    expect(await svc.getSecret(TENANT_A, 'smtp')).toBe('second');
  });
});
