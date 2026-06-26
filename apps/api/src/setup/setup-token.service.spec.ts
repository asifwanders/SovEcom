/**
 * SetupTokenService unit tests (SECURITY-CRITICAL).
 *
 * Unit scope = the pure, DB-independent guarantees:
 *   - token SHAPE: base64url, >=32 bytes (256-bit) entropy, distinct per call;
 *   - HASH-AT-REST: only the SHA-256 hash is persisted, never the plaintext;
 *   - verify/consume INPUT GUARDS short-circuit empty/non-string tokens WITHOUT
 *     touching the DB (no hash, no query).
 *
 * The SQL-level guarantees (verify accepts live / rejects expired+used+unknown,
 * consume is atomic single-use under a race) are proven against REAL Postgres in
 * `test/integration/setup/*` and `test/concurrency/setup-consume-race.test.ts`,
 * where they actually mean something — a JS re-implementation of Drizzle's WHERE
 * semantics would test the mock, not the service.
 */
import { createHash } from 'node:crypto';
import { SetupTokenService } from './setup-token.service';
import type { DatabaseService } from '../database/database.service';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Captures the `insert().values(...)` payload so we can assert what is persisted. */
function captureDb(captured: Array<{ tokenHash: string; expiresAt: Date }>): DatabaseService {
  const db = {
    insert: () => ({
      values: async (v: { tokenHash: string; expiresAt: Date }) => {
        captured.push(v);
      },
    }),
    // Should NOT be reached by the input-guard tests; throw if it is.
    select: () => {
      throw new Error('select() must not run for an empty/non-string token');
    },
    update: () => {
      throw new Error('update() must not run for an empty/non-string token');
    },
  };
  return { db } as unknown as DatabaseService;
}

describe('SetupTokenService (unit, SECURITY-CRITICAL)', () => {
  let captured: Array<{ tokenHash: string; expiresAt: Date }>;
  let service: SetupTokenService;

  beforeEach(() => {
    captured = [];
    service = new SetupTokenService(captureDb(captured));
  });

  it('generateToken returns a base64url token with >=32 bytes (256-bit) entropy', async () => {
    const token = await service.generateToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url charset, no padding
    const decoded = Buffer.from(token, 'base64url');
    expect(decoded.length).toBeGreaterThanOrEqual(32);
  });

  it('persists ONLY the SHA-256 hash (never the plaintext) with a ~24h expiry', async () => {
    const before = Date.now();
    const token = await service.generateToken();
    const after = Date.now();

    expect(captured).toHaveLength(1);
    const row = captured[0]!;
    expect(row.tokenHash).toBe(sha256(token));
    expect(row.tokenHash).not.toBe(token);
    expect(JSON.stringify(row)).not.toContain(token);

    // 24h TTL within the call window.
    const ttl = row.expiresAt.getTime();
    expect(ttl).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000 - 5);
    expect(ttl).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000 + 5);
  });

  it('generates distinct, high-entropy tokens across calls', async () => {
    const a = await service.generateToken();
    const b = await service.generateToken();
    expect(a).not.toBe(b);
    expect(captured[0]!.tokenHash).not.toBe(captured[1]!.tokenHash);
  });

  it('verifyToken short-circuits empty / non-string input without hitting the DB', async () => {
    expect(await service.verifyToken('')).toEqual({ valid: false, expiresAt: null });
    // @ts-expect-error — exercising the runtime non-string guard.
    expect(await service.verifyToken(undefined)).toEqual({ valid: false, expiresAt: null });
    // @ts-expect-error — exercising the runtime non-string guard.
    expect(await service.verifyToken(null)).toEqual({ valid: false, expiresAt: null });
  });

  it('consumeToken short-circuits empty / non-string input without hitting the DB', async () => {
    expect(await service.consumeToken('')).toBe(false);
    // @ts-expect-error — exercising the runtime non-string guard.
    expect(await service.consumeToken(undefined)).toBe(false);
  });
});
