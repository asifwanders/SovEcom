/**
 * i — ModuleMailPort unit tests (SECURITY-CRITICAL: this is the validation + rate-limit
 * + audit + tenant-scope chokepoint behind the broker's `email:send` permission gate).
 *
 * Pins: strict header-injection-safe validation (CR/LF/comma/semicolon in `to`, CR/LF in subject,
 * invalid email, over-length, extra keys), the per-module fixed-window rate limit (RATE_LIMITED,
 * not a throw), the audit record on send AND on every deny, tenant scoping (ctx, never input), and
 * that a send is queued via MailService with NO body in any log/audit and a distinct subject prefix.
 */
import {
  ModuleMailPort,
  FixedWindowRateLimiter,
  MODULE_MAIL_SUBJECT_PREFIX,
} from './module-mail.port';
import { RpcErrorCode } from './ipc-protocol';
import type { IMailService } from '../../mail/mail.service';
import type { AuditService, AuditEntry } from '../../audit/audit.service';

function fakeMail() {
  const sent: Array<{ to: string; subject: string; text: string; html?: string }> = [];
  const mail: IMailService = {
    send: jest.fn(async (opts) => {
      sent.push(opts);
      return { messageId: 'm1' };
    }),
    sendPasswordReset: jest.fn(),
    sendEmailChangeVerification: jest.fn(),
    sendEmailChangeNotice: jest.fn(),
    sendCustomerPasswordReset: jest.fn(),
  } as unknown as IMailService;
  return { mail, sent };
}

function fakeAudit(opts: { failOrThrow?: boolean } = {}) {
  const records: AuditEntry[] = [];
  const audit = {
    // best-effort deny-path audit
    record: jest.fn(async (e: AuditEntry) => {
      records.push(e);
    }),
    // fail-closed success-path audit; `failOrThrow` simulates a DB write failure.
    recordOrThrow: jest.fn(async (e: AuditEntry) => {
      if (opts.failOrThrow) throw new Error('audit_log write failed');
      records.push(e);
    }),
  } as unknown as AuditService;
  return { audit, records };
}

const CTX = { tenantId: 'tenant-A', moduleName: 'notify' };
const GOOD = { to: 'buyer@example.com', subject: 'Back in stock', text: 'Your item is available.' };

import type { CustomerEmailLookup, CustomerEmailResolution } from './module-mail.port';

function makePort(limit = 100, windowMs = 60_000, auditOpts: { failOrThrow?: boolean } = {}) {
  const { mail, sent } = fakeMail();
  const { audit, records } = fakeAudit(auditOpts);
  const port = new ModuleMailPort(mail, audit, new FixedWindowRateLimiter(limit, windowMs));
  return { port, sent, records };
}

/**
 * A fake customer-email lookup. Records the (tenantId, customerId) it is asked to resolve and
 * returns the scripted resolution — a sendable `{status:'ok', email, locale}` or a PII-free
 * `{status:'suppressed', reason}`.
 */
function fakeLookup(resolution: CustomerEmailResolution) {
  const calls: Array<{ tenantId: string; customerId: string }> = [];
  const lookup: CustomerEmailLookup = {
    resolveForModuleEmail: jest.fn(async (tenantId: string, customerId: string) => {
      calls.push({ tenantId, customerId });
      return resolution;
    }),
  };
  return { lookup, calls };
}

function makeCustomerPort(
  resolution: CustomerEmailResolution,
  limit = 100,
  windowMs = 60_000,
  auditOpts: { failOrThrow?: boolean } = {},
) {
  const { mail, sent } = fakeMail();
  const { audit, records } = fakeAudit(auditOpts);
  const { lookup, calls } = fakeLookup(resolution);
  const port = new ModuleMailPort(mail, audit, new FixedWindowRateLimiter(limit, windowMs), lookup);
  return { port, sent, records, calls };
}

const CUST_OK: CustomerEmailResolution = {
  status: 'ok',
  email: 'customer@example.com',
  locale: 'fr',
};
const GOOD_CUST = {
  customerId: '11111111-1111-7111-8111-111111111111',
  subject: 'Price drop on your wishlist',
  text: 'An item dropped in price.',
};

describe('ModuleMailPort', () => {
  it('queues a valid message via MailService, scoped to ctx tenant, with the [module] prefix', async () => {
    const { port, sent } = makePort();
    const res = await port.send(CTX, GOOD);
    expect(res).toEqual({ queued: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('buyer@example.com');
    expect(sent[0]!.subject.startsWith(MODULE_MAIL_SUBJECT_PREFIX)).toBe(true);
    expect(sent[0]!.text).toBe(GOOD.text);
  });

  it('audits the SEND with module/to/subject — and NO body (no PII beyond recipient)', async () => {
    const { port, records } = makePort();
    await port.send(CTX, GOOD);
    const sent = records.find((r) => r.action === 'module.email.sent');
    expect(sent).toBeDefined();
    expect(sent!.tenantId).toBe('tenant-A');
    expect(sent!.actorType).toBe('system');
    expect(sent!.changes).toMatchObject({ module: 'notify', to: 'buyer@example.com' });
    // The body must NEVER appear in the audit record.
    expect(JSON.stringify(sent!.changes)).not.toContain(GOOD.text);
  });

  // ── header-injection guard ────────────────────────────────────────────────────
  it.each([
    ['CRLF in to', { ...GOOD, to: 'buyer@example.com\r\nBcc: evil@x.com' }],
    ['newline in to', { ...GOOD, to: 'buyer@example.com\nfoo' }],
    ['comma (extra recipient) in to', { ...GOOD, to: 'buyer@example.com,evil@x.com' }],
    ['semicolon in to', { ...GOOD, to: 'buyer@example.com;evil@x.com' }],
    ['CRLF in subject', { ...GOOD, subject: 'Hi\r\nBcc: evil@x.com' }],
    ['newline in subject', { ...GOOD, subject: 'Hi\nthere' }],
    ['not an email', { ...GOOD, to: 'not-an-email' }],
    ['missing @', { ...GOOD, to: 'buyerexample.com' }],
  ])('rejects %s with PROTOCOL and never sends', async (_label, msg) => {
    const { port, sent } = makePort();
    await expect(port.send(CTX, msg)).rejects.toMatchObject({ code: RpcErrorCode.PROTOCOL });
    expect(sent).toHaveLength(0);
  });

  it('rejects an over-length subject (PROTOCOL)', async () => {
    const { port, sent } = makePort();
    await expect(port.send(CTX, { ...GOOD, subject: 'x'.repeat(5000) })).rejects.toMatchObject({
      code: RpcErrorCode.PROTOCOL,
    });
    expect(sent).toHaveLength(0);
  });

  it('rejects an over-length body (PROTOCOL)', async () => {
    const { port, sent } = makePort();
    await expect(port.send(CTX, { ...GOOD, text: 'x'.repeat(60_000) })).rejects.toMatchObject({
      code: RpcErrorCode.PROTOCOL,
    });
    expect(sent).toHaveLength(0);
  });

  it('rejects EXTRA keys — no from/cc/bcc/tenantId smuggling (PROTOCOL)', async () => {
    const { port, sent } = makePort();
    for (const extra of [
      { from: 'spoof@core.local' },
      { cc: 'evil@x.com' },
      { bcc: 'evil@x.com' },
      { tenantId: 'tenant-EVIL' },
    ]) {
      await expect(port.send(CTX, { ...GOOD, ...extra })).rejects.toMatchObject({
        code: RpcErrorCode.PROTOCOL,
      });
    }
    expect(sent).toHaveLength(0);
  });

  it('audits a DENIED (invalid-params) attempt', async () => {
    const { port, records } = makePort();
    await expect(port.send(CTX, { ...GOOD, to: 'nope' })).rejects.toBeDefined();
    const denied = records.find((r) => r.action === 'module.email.denied');
    expect(denied).toBeDefined();
    expect(denied!.changes).toMatchObject({ module: 'notify', reason: 'invalid_params' });
  });

  // ── per-module rate limit ──────────────────────────────────────────────────────
  it('returns RATE_LIMITED after N sends in the window (not a throw), and audits the deny', async () => {
    const { port, sent, records } = makePort(2, 60_000);
    await port.send(CTX, GOOD);
    await port.send(CTX, GOOD);
    await expect(port.send(CTX, GOOD)).rejects.toMatchObject({
      code: RpcErrorCode.RATE_LIMITED,
    });
    expect(sent).toHaveLength(2); // the 3rd never reached the transport
    const denied = records.find((r) => r.action === 'module.email.denied');
    // NIT-5: the rate-limited deny carries to AND subject, symmetric with the `sent` record.
    expect(denied!.changes).toMatchObject({
      reason: 'rate_limited',
      to: GOOD.to,
      subject: `[module] ${GOOD.subject}`,
    });
  });

  it('the rate limit is PER MODULE — a different module is unaffected', async () => {
    const { port, sent } = makePort(1, 60_000);
    await port.send({ tenantId: 'tenant-A', moduleName: 'notify' }, GOOD);
    await expect(
      port.send({ tenantId: 'tenant-A', moduleName: 'notify' }, GOOD),
    ).rejects.toMatchObject({ code: RpcErrorCode.RATE_LIMITED });
    // a different module on the same tenant still has its own budget
    await expect(port.send({ tenantId: 'tenant-A', moduleName: 'digest' }, GOOD)).resolves.toEqual({
      queued: true,
    });
    expect(sent).toHaveLength(2);
  });

  it('a transport failure becomes a typed PII-free HANDLER_ERROR (no recipient leak)', async () => {
    const { audit } = fakeAudit();
    const mail = {
      send: jest.fn(async () => {
        throw new Error('550 5.1.1 <buyer@example.com>: User unknown');
      }),
    } as unknown as IMailService;
    const port = new ModuleMailPort(mail, audit, new FixedWindowRateLimiter(10, 1000));
    // NIT-6: capture the SAME single call's rejection and assert BOTH the code and the PII-free
    // message on it, so the assertion is not preceded by a separate rate-limit-consuming call.
    let err: { code?: string; message?: string } | undefined;
    try {
      await port.send(CTX, GOOD);
    } catch (e) {
      err = e as { code?: string; message?: string };
    }
    expect(err).toBeDefined();
    expect(err!.code).toBe(RpcErrorCode.HANDLER_ERROR);
    expect(err!.message).not.toMatch(/buyer@example.com/);
  });

  // ── fail-closed audit (SHOULD-FIX) ──────────────────────────────────────────────
  it('audit write failure on a SEND → throws and the email is NOT sent (fail-closed)', async () => {
    const { port, sent } = makePort(100, 60_000, { failOrThrow: true });
    await expect(port.send(CTX, GOOD)).rejects.toMatchObject({
      code: RpcErrorCode.HANDLER_ERROR,
    });
    // The crucial guarantee: no un-audited send ever reaches the transport.
    expect(sent).toHaveLength(0);
  });

  // ── HTML sanitization (SHOULD-FIX, GLM) ─────────────────────────────────────────
  it('strips script/iframe/onerror/javascript: from module-supplied html before queueing', async () => {
    const { port, sent } = makePort();
    const html =
      '<p>Hi</p>' +
      '<script>steal()</script>' +
      '<iframe src="https://evil.test"></iframe>' +
      '<img src="x" onerror="alert(1)">' +
      '<a href="javascript:alert(2)">click</a>' +
      '<a href="https://ok.test">ok</a>';
    await port.send(CTX, { ...GOOD, html });
    const out = sent[0]!.html!;
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/<iframe/i);
    expect(out).not.toMatch(/onerror/i);
    expect(out).not.toMatch(/javascript:/i);
    // …but email-safe markup survives.
    expect(out).toContain('<p>Hi</p>');
    expect(out).toContain('https://ok.test');
  });

  // ── NIT-3: subject control-char sweep ───────────────────────────────────────────
  it.each([
    ['tab (C0)', 'Hi\tthere'],
    ['DEL (C1 boundary)', 'Hi\u007Fthere'],
    ['C1 control', 'Hi\u0085there'],
    ['U+2028 line separator', 'Hi\u2028there'],
    ['U+2029 paragraph separator', 'Hi\u2029there'],
  ])('rejects a subject with %s (PROTOCOL)', async (_label, subject) => {
    const { port, sent } = makePort();
    await expect(port.send(CTX, { ...GOOD, subject })).rejects.toMatchObject({
      code: RpcErrorCode.PROTOCOL,
    });
    expect(sent).toHaveLength(0);
  });
});

describe('ModuleMailPort.sendToCustomer (B3 — privacy-preserving module→customer email)', () => {
  it('resolves the customer by (ctx.tenant, customerId) and SENDS to the resolved email', async () => {
    const { port, sent, calls } = makeCustomerPort(CUST_OK);
    const res = await port.sendToCustomer(CTX, GOOD_CUST);
    expect(res).toEqual({ queued: true });
    // tenant comes from CTX, never from the module's params.
    expect(calls).toEqual([{ tenantId: 'tenant-A', customerId: GOOD_CUST.customerId }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('customer@example.com');
    expect(sent[0]!.subject.startsWith(MODULE_MAIL_SUBJECT_PREFIX)).toBe(true);
    expect(sent[0]!.text).toBe(GOOD_CUST.text);
  });

  it('the resolved email NEVER crosses back to the caller — only { queued } is returned', async () => {
    const { port } = makeCustomerPort(CUST_OK);
    const res = await port.sendToCustomer(CTX, GOOD_CUST);
    expect(Object.keys(res)).toEqual(['queued']);
    expect(JSON.stringify(res)).not.toContain('customer@example.com');
  });

  it('audits module.email.sent with module/customerId/to — and NO body (PII-minimal)', async () => {
    const { port, records } = makeCustomerPort(CUST_OK);
    await port.sendToCustomer(CTX, GOOD_CUST);
    const sentRec = records.find((r) => r.action === 'module.email.sent');
    expect(sentRec).toBeDefined();
    expect(sentRec!.tenantId).toBe('tenant-A');
    expect(sentRec!.actorType).toBe('system');
    expect(sentRec!.changes).toMatchObject({
      module: 'notify',
      customerId: GOOD_CUST.customerId,
      to: 'customer@example.com',
    });
    expect(JSON.stringify(sentRec!.changes)).not.toContain(GOOD_CUST.text);
  });

  // ── suppression matrix: missing / deleted / anonymized / not-consented ──────────
  it.each<[string, 'missing' | 'deleted' | 'anonymized' | 'not_consented']>([
    ['missing', 'missing'],
    ['soft-deleted', 'deleted'],
    ['anonymized', 'anonymized'],
    ['not marketing-consented', 'not_consented'],
  ])('SUPPRESSES (queued:false, sends nothing) when the customer is %s', async (_label, reason) => {
    const { port, sent, records } = makeCustomerPort({ status: 'suppressed', reason });
    const res = await port.sendToCustomer(CTX, GOOD_CUST);
    expect(res).toEqual({ queued: false });
    expect(sent).toHaveLength(0);
    const suppressed = records.find((r) => r.action === 'module.email.suppressed');
    expect(suppressed).toBeDefined();
    expect(suppressed!.changes).toMatchObject({
      module: 'notify',
      customerId: GOOD_CUST.customerId,
      reason,
    });
    const dump = JSON.stringify(suppressed!.changes);
    expect(dump).not.toContain('@'); // no email leaked into the audit
    expect(dump).not.toContain(GOOD_CUST.text); // no body
    expect(records.find((r) => r.action === 'module.email.sent')).toBeUndefined();
  });

  it('the suppressed RESULT is opaque — queued:false carries NO reason (no consent/existence oracle)', async () => {
    const { port } = makeCustomerPort({ status: 'suppressed', reason: 'not_consented' });
    const res = await port.sendToCustomer(CTX, GOOD_CUST);
    expect(Object.keys(res)).toEqual(['queued']);
    expect(res.queued).toBe(false);
  });

  // ── strict param validation (header-injection-safe; no smuggled `to`) ───────────
  it.each([
    ['CRLF in subject', { ...GOOD_CUST, subject: 'Hi\r\nBcc: evil@x.com' }],
    ['tab (C0) in subject', { ...GOOD_CUST, subject: 'Hi\tthere' }],
    ['U+2028 in subject', { ...GOOD_CUST, subject: 'Hi\u2028there' }],
    ['empty subject', { ...GOOD_CUST, subject: '' }],
    ['empty text', { ...GOOD_CUST, text: '' }],
    ['non-uuid customerId', { ...GOOD_CUST, customerId: 'not-a-uuid' }],
    ['over-length subject', { ...GOOD_CUST, subject: 'x'.repeat(5000) }],
    ['over-length text', { ...GOOD_CUST, text: 'x'.repeat(60_000) }],
  ])('rejects %s with PROTOCOL and never resolves/sends', async (_label, msg) => {
    const { port, sent, calls } = makeCustomerPort(CUST_OK);
    await expect(port.sendToCustomer(CTX, msg)).rejects.toMatchObject({
      code: RpcErrorCode.PROTOCOL,
    });
    expect(sent).toHaveLength(0);
    expect(calls).toHaveLength(0); // never touched the DB for invalid params
  });

  it('rejects EXTRA / smuggled keys — no `to`/from/cc/bcc/tenantId (PROTOCOL)', async () => {
    const { port, sent } = makeCustomerPort(CUST_OK);
    for (const extra of [
      { to: 'evil@x.com' },
      { from: 'spoof@core.local' },
      { cc: 'evil@x.com' },
      { bcc: 'evil@x.com' },
      { tenantId: 'tenant-EVIL' },
    ]) {
      await expect(port.sendToCustomer(CTX, { ...GOOD_CUST, ...extra })).rejects.toMatchObject({
        code: RpcErrorCode.PROTOCOL,
      });
    }
    expect(sent).toHaveLength(0);
  });

  it('audits a DENIED (invalid-params) attempt with NO email/body', async () => {
    const { port, records } = makeCustomerPort(CUST_OK);
    await expect(
      port.sendToCustomer(CTX, { ...GOOD_CUST, customerId: 'nope' }),
    ).rejects.toBeDefined();
    const denied = records.find((r) => r.action === 'module.email.denied');
    expect(denied).toBeDefined();
    expect(denied!.changes).toMatchObject({ module: 'notify', reason: 'invalid_params' });
  });

  // ── shared rate-limit bucket with send ──────────────────────────────────────────
  it('shares the SAME per-(tenant,module) rate-limit bucket as send', async () => {
    const { mail } = fakeMail();
    const { audit } = fakeAudit();
    const { lookup } = fakeLookup(CUST_OK);
    const port = new ModuleMailPort(mail, audit, new FixedWindowRateLimiter(1, 60_000), lookup);
    await port.send(CTX, GOOD);
    await expect(port.sendToCustomer(CTX, GOOD_CUST)).rejects.toMatchObject({
      code: RpcErrorCode.RATE_LIMITED,
    });
  });

  it('returns RATE_LIMITED after N sendToCustomer calls, and never resolves the (N+1)th', async () => {
    const { port, sent, calls } = makeCustomerPort(CUST_OK, 2, 60_000);
    await port.sendToCustomer(CTX, GOOD_CUST);
    await port.sendToCustomer(CTX, GOOD_CUST);
    await expect(port.sendToCustomer(CTX, GOOD_CUST)).rejects.toMatchObject({
      code: RpcErrorCode.RATE_LIMITED,
    });
    expect(sent).toHaveLength(2);
    expect(calls).toHaveLength(2); // the rate-limited 3rd never reached the DB resolver
  });

  // ── fail-closed audit on the sent path ──────────────────────────────────────────
  it('audit write failure on a SEND → throws HANDLER_ERROR and nothing reaches the transport', async () => {
    const { port, sent } = makeCustomerPort(CUST_OK, 100, 60_000, { failOrThrow: true });
    await expect(port.sendToCustomer(CTX, GOOD_CUST)).rejects.toMatchObject({
      code: RpcErrorCode.HANDLER_ERROR,
    });
    expect(sent).toHaveLength(0);
  });

  it('sanitizes module-supplied html before queueing (script/iframe/onerror/javascript:)', async () => {
    const { port, sent } = makeCustomerPort(CUST_OK);
    const html =
      '<p>Hi</p><script>steal()</script><img src="x" onerror="alert(1)">' +
      '<a href="javascript:alert(2)">x</a><a href="https://ok.test">ok</a>';
    await port.sendToCustomer(CTX, { ...GOOD_CUST, html });
    const out = sent[0]!.html!;
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/onerror/i);
    expect(out).not.toMatch(/javascript:/i);
    expect(out).toContain('<p>Hi</p>');
    expect(out).toContain('https://ok.test');
  });

  it('a transport failure becomes a typed PII-free HANDLER_ERROR (no recipient leak)', async () => {
    const { audit } = fakeAudit();
    const { lookup } = fakeLookup(CUST_OK);
    const mail = {
      send: jest.fn(async () => {
        throw new Error('550 5.1.1 <customer@example.com>: User unknown');
      }),
    } as unknown as IMailService;
    const port = new ModuleMailPort(mail, audit, new FixedWindowRateLimiter(10, 1000), lookup);
    let err: { code?: string; message?: string } | undefined;
    try {
      await port.sendToCustomer(CTX, GOOD_CUST);
    } catch (e) {
      err = e as { code?: string; message?: string };
    }
    expect(err).toBeDefined();
    expect(err!.code).toBe(RpcErrorCode.HANDLER_ERROR);
    expect(err!.message).not.toMatch(/customer@example.com/);
  });

  it('without a configured lookup, sendToCustomer fails safe (HANDLER_ERROR, no send)', async () => {
    const { mail, sent } = fakeMail();
    const { audit } = fakeAudit();
    const port = new ModuleMailPort(mail, audit, new FixedWindowRateLimiter(100, 60_000));
    await expect(port.sendToCustomer(CTX, GOOD_CUST)).rejects.toMatchObject({
      code: RpcErrorCode.HANDLER_ERROR,
    });
    expect(sent).toHaveLength(0);
  });

  it('a raw resolver failure becomes a GENERIC HANDLER_ERROR (no raw message leaks to the worker)', async () => {
    const { mail, sent } = fakeMail();
    const { audit } = fakeAudit();
    const lookup: CustomerEmailLookup = {
      resolveForModuleEmail: jest.fn(async () => {
        // A non-RpcError DB-class failure carrying an internal/PII-bearing message.
        throw new Error('connection terminated: host=db-internal-7 password=hunter2');
      }),
    };
    const port = new ModuleMailPort(mail, audit, new FixedWindowRateLimiter(10, 60_000), lookup);
    let err: { code?: string; message?: string } | undefined;
    try {
      await port.sendToCustomer(CTX, GOOD_CUST);
    } catch (e) {
      err = e as { code?: string; message?: string };
    }
    expect(err).toBeDefined();
    expect(err!.code).toBe(RpcErrorCode.HANDLER_ERROR);
    // The raw resolver message (host/password) must NOT survive onto the typed error.
    expect(err!.message).toBe('email send refused: customer resolution failed');
    expect(err!.message).not.toMatch(/db-internal|hunter2|password/);
    expect(sent).toHaveLength(0);
  });
});

describe('FixedWindowRateLimiter', () => {
  it('allows up to the limit then refuses, and resets after the window', () => {
    let now = 1000;
    const rl = new FixedWindowRateLimiter(2, 100, () => now);
    expect(rl.tryConsume('k')).toBe(true);
    expect(rl.tryConsume('k')).toBe(true);
    expect(rl.tryConsume('k')).toBe(false);
    now += 100; // window rolls over
    expect(rl.tryConsume('k')).toBe(true);
  });

  it('keys are independent', () => {
    const rl = new FixedWindowRateLimiter(1, 1000);
    expect(rl.tryConsume('a')).toBe(true);
    expect(rl.tryConsume('a')).toBe(false);
    expect(rl.tryConsume('b')).toBe(true);
  });
});
