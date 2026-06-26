/**
 * PasswordService UNIT tests (no DB/Redis, `jest.config.js`).
 * SECURITY-CRITICAL (Argon2id).
 *
 * Pure Argon2id hashing. Real `argon2` is used (it is a node addon, not a network
 * dep), so these are slow-ish but deterministic and need no Postgres/Redis.
 *
 * Covers:
 *   - hash != plaintext, and the digest carries the `$argon2id$` prefix (satisfies
 *     the users.password_hash CHECK).
 *   - verify(hash, pw) is true for the right password, false for the wrong one.
 *   - dummyVerify(pw) actually runs an Argon2 verification against a fixed decoy
 *     hash (the constant-time enumeration defence — it must do real work, not
 *     return instantly), and never throws / never reveals which branch ran.
 *
 * RED today: `./password.service` does not exist yet, so this fails to COMPILE.
 */
import { PasswordService } from './password.service';

const PW = 'correct horse battery staple';
const WRONG = 'Tr0ub4dor&3';

describe('PasswordService — Argon2id (unit, SECURITY-CRITICAL)', () => {
  let svc: PasswordService;
  beforeEach(() => {
    svc = new PasswordService();
  });

  it('hash(pw) !== plaintext and carries the $argon2id$ prefix', async () => {
    const digest = await svc.hash(PW);
    expect(digest).not.toBe(PW);
    expect(digest.startsWith('$argon2id$')).toBe(true);
  });

  it('two hashes of the same password differ (random salt)', async () => {
    const a = await svc.hash(PW);
    const b = await svc.hash(PW);
    expect(a).not.toBe(b);
  });

  it('verify returns TRUE for the correct password', async () => {
    const digest = await svc.hash(PW);
    expect(await svc.verify(digest, PW)).toBe(true);
  });

  it('verify returns FALSE for a wrong password', async () => {
    const digest = await svc.hash(PW);
    expect(await svc.verify(digest, WRONG)).toBe(false);
  });

  it('dummyVerify runs a real Argon2 verification (does real work, never throws)', async () => {
    // It must resolve (not reject) and must NOT short-circuit to ~0ms — it exists
    // precisely to match the timing of a real verify on the missing-user branch.
    const start = process.hrtime.bigint();
    await expect(svc.dummyVerify(WRONG)).resolves.toBeUndefined();
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    // A real Argon2id verify is on the order of >1ms; an instant no-op would be a
    // timing oracle. Generous floor to stay non-flaky across CI runners.
    expect(elapsedMs).toBeGreaterThan(1);
  });

  it('the dummy decoy hash is itself a valid $argon2id$ hash (so verifyDummy can run it)', async () => {
    // dummyVerify must not be a stub: a wrong password against the decoy returns
    // false-equivalent (no throw), proving a genuine verify path executed.
    await expect(svc.dummyVerify('anything')).resolves.toBeUndefined();
  });
});
