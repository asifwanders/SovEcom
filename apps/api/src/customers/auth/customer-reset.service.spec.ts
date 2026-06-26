/**
 *C5 — CustomerResetService unit tests (AUTH/CREDENTIAL-CRITICAL).
 *
 * Focused on the anti-enumeration invariants that are hard to drive deterministically in
 * the integration harness:
 *   - Item 1: the UNKNOWN-email branch does a dummy token lookup (shape-matching the
 *     known-branch INSERT) and still returns void (the controller answers 202);
 *   - F2: a composite-FK violation (SQLSTATE 23503) on the known-branch INSERT — a
 *     concurrent RGPD-erase racing the token write — is downgraded to the SAME silent
 *     no-op (no throw, no mail), preserving the uniform-202 invariant + not leaking
 *     existence.
 */
import { CustomerResetService } from './customer-reset.service';
import type { DatabaseService } from '../../database/database.service';
import type { RedisService } from '../../redis/redis.service';
import type { AuditService } from '../../audit/audit.service';
import type { PasswordService } from '../../auth/services/password.service';
import type { RateLimitService } from '../../auth/services/rate-limit.service';
import type { IMailService } from '../../mail/mail.service';

const TENANT = '01900000-0000-7000-8000-000000000000';

/** A select-chain that resolves to `rows` for `.limit()`. */
function selectChain(rows: unknown[]) {
  return {
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  };
}

function build(opts: {
  customerRow?: { id: string; email: string; locale: string | null };
  insertImpl?: () => Promise<unknown>;
}) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const mail = { sendCustomerPasswordReset: jest.fn().mockResolvedValue(undefined) };
  const rateLimit = { check: jest.fn().mockResolvedValue({ allowed: true }) };
  const redis = { client: { set: jest.fn().mockResolvedValue('OK') } };
  const passwords = {};

  // First .select() → customer lookup; any later .select() → dummy token lookup (no row).
  let selectCalls = 0;
  const selectRows = () => {
    selectCalls += 1;
    return selectCalls === 1 ? (opts.customerRow ? [opts.customerRow] : []) : [];
  };

  const db = {
    select: jest.fn(() => selectChain(selectRows())),
    insert: jest.fn(() => ({
      values: opts.insertImpl ?? (() => Promise.resolve(undefined)),
    })),
  };

  const svc = new CustomerResetService(
    { db } as unknown as DatabaseService,
    passwords as unknown as PasswordService,
    rateLimit as unknown as RateLimitService,
    audit as unknown as AuditService,
    redis as unknown as RedisService,
    mail as unknown as IMailService,
  );
  return { svc, audit, mail, rateLimit, db, getSelectCalls: () => selectCalls };
}

describe('CustomerResetService.forgot — anti-enumeration', () => {
  const ctx = { ip: '1.2.3.4', userAgent: 'jest' };

  it('UNKNOWN email: does a dummy token lookup, audits anonymous, sends no mail, returns void', async () => {
    const { svc, audit, mail, getSelectCalls } = build({ customerRow: undefined });
    await expect(svc.forgot(TENANT, 'nobody@x.test', ctx)).resolves.toBeUndefined();

    // TWO selects: the customer lookup (no row) + the dummy token lookup (shape-match).
    expect(getSelectCalls()).toBe(2);
    expect(mail.sendCustomerPasswordReset).not.toHaveBeenCalled();
    // Audit fired as the anonymous actor (round-trip parity). Fire-and-forget → flush.
    await new Promise((r) => setImmediate(r));
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'anonymous',
        action: 'customer.password_reset_requested',
      }),
    );
  });

  it('KNOWN email: inserts a token, sends mail, audits customer', async () => {
    const insertValues = jest.fn().mockResolvedValue(undefined);
    const { svc, audit, mail } = build({
      customerRow: { id: 'cust-1', email: 'a@x.test', locale: null },
      insertImpl: insertValues,
    });
    await expect(svc.forgot(TENANT, 'a@x.test', ctx)).resolves.toBeUndefined();
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(mail.sendCustomerPasswordReset).toHaveBeenCalledTimes(1);
    await new Promise((r) => setImmediate(r));
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: 'customer', actorId: 'cust-1' }),
    );
  });

  it('F2: a 23503 FK violation on the known-branch INSERT → silent no-op (no throw, no mail)', async () => {
    // The customer was erased between the SELECT and the INSERT — the composite FK fires.
    const fkError = Object.assign(new Error('insert violates foreign key'), { code: '23503' });
    const { svc, audit, mail } = build({
      customerRow: { id: 'cust-1', email: 'a@x.test', locale: null },
      insertImpl: () => Promise.reject(fkError),
    });

    // Must NOT throw — the uniform-202 invariant holds even on the erase race.
    await expect(svc.forgot(TENANT, 'a@x.test', ctx)).resolves.toBeUndefined();
    // No mail (no token persisted), and the audit is the ANONYMOUS no-op shape.
    expect(mail.sendCustomerPasswordReset).not.toHaveBeenCalled();
    await new Promise((r) => setImmediate(r));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'anonymous' }));
  });

  it('a NON-FK error on the INSERT still propagates (not swallowed)', async () => {
    const boom = Object.assign(new Error('connection reset'), { code: '08006' });
    const { svc, mail } = build({
      customerRow: { id: 'cust-1', email: 'a@x.test', locale: null },
      insertImpl: () => Promise.reject(boom),
    });
    await expect(svc.forgot(TENANT, 'a@x.test', ctx)).rejects.toThrow('connection reset');
    expect(mail.sendCustomerPasswordReset).not.toHaveBeenCalled();
  });

  it('F3: in production a missing STORE_ORIGIN fails CLOSED (throws building the reset URL)', async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevOrigin = process.env.STORE_ORIGIN;
    process.env.NODE_ENV = 'production';
    delete process.env.STORE_ORIGIN;
    // Provide the prod-required AUDIT_EMAIL_SALT so the audit-hash guard isn't what trips.
    const prevSalt = process.env.AUDIT_EMAIL_SALT;
    process.env.AUDIT_EMAIL_SALT = 'a-sufficiently-long-salt';
    try {
      const { svc, mail } = build({
        customerRow: { id: 'cust-1', email: 'a@x.test', locale: null },
        insertImpl: () => Promise.resolve(undefined),
      });
      await expect(svc.forgot(TENANT, 'a@x.test', ctx)).rejects.toThrow(/STORE_ORIGIN must be set/);
      // The dead-link mail is never dispatched (fail-closed before mail).
      expect(mail.sendCustomerPasswordReset).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevOrigin === undefined) delete process.env.STORE_ORIGIN;
      else process.env.STORE_ORIGIN = prevOrigin;
      if (prevSalt === undefined) delete process.env.AUDIT_EMAIL_SALT;
      else process.env.AUDIT_EMAIL_SALT = prevSalt;
    }
  });
});
