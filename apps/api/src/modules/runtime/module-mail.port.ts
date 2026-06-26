/**
 * Broker-mediated outbound EMAIL port.
 *
 * The ONLY sanctioned way a module sends mail. A module has NO SMTP credentials and NO access to
 * core's transactional templates; when it wants to send it asks the broker, which calls THIS port.
 * Enforcement here (the broker has already checked the `email:send` permission grant):
 *   1. **strict param validation** — `to` is a single syntactically-valid email; `to`/`subject`
 *      reject CR/LF/comma/semicolon (HEADER-INJECTION guard — no extra recipients, no smuggled
 *      headers); subject/body length-bounded; unknown keys rejected (no `from`/`cc`/`bcc`/tenant).
 *   2. **per-module rate limit** — a bounded fixed window per (tenant, module); over-limit returns
 *      a clean {@link RpcErrorCode.RATE_LIMITED} (NOT a throw that crashes the worker).
 *   3. **audit** — every send AND every denied attempt is recorded (who=module, to, subject, when)
 *      with NO body (no PII beyond the recipient — EU-privacy rule).
 *   4. **tenant-scoped** — attributed to the module's tenant (from the broker context, never input).
 *   5. **via core MailService only** — routed through the existing `IMailService.send`, sent as a
 *      module-originated email with a distinct subject prefix so it is never mistaken for a core
 *      transactional message and cannot inject into one.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { z } from 'zod';
import {
  EMAIL_SUBJECT_MAX,
  EMAIL_TEXT_MAX,
  EMAIL_HTML_MAX,
  EMAIL_TO_MAX,
  type ModuleEmailSendResult,
} from '@sovecom/module-sdk';

import { MAIL_SERVICE, type IMailService } from '../../mail/mail.service';
import { AuditService } from '../../audit/audit.service';
import { RpcError, RpcErrorCode } from './ipc-protocol';

/**
 * Per-module send cap over a fixed window. Configurable via env so an operator can tune it; the
 * defaults are deliberately modest (a digest/notify module sends a handful of mails, not a blast).
 * Read once at construction.
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const DEFAULT_EMAIL_RATE_LIMIT = 20;
export const DEFAULT_EMAIL_RATE_WINDOW_MS = 60_000;

/**
 * Reject any control char (CR/LF/NUL) AND the address-list separators comma/semicolon. This is the
 * header-injection / multi-recipient guard for `to`.
 */
const CONTROL_OR_SEPARATOR = /[\r\n\0,;]/;

/**
 * Subject header-injection guard (NIT-3): reject ALL C0 control chars (U+0000–U+001F), DEL +
 * the C1 block (U+007F–U+009F), and the Unicode line/paragraph separators U+2028/U+2029 — any of
 * which can split a header or smuggle one. A comma IS legal in a subject, so (unlike `to`) we do
 * not forbid separators here, only control/line characters.
 */
// eslint-disable-next-line no-control-regex
const SUBJECT_CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

// A conservative single-address email check. NOT RFC-5322-complete by design — we accept the
// common `local@domain.tld` shape and REFUSE anything exotic (display names, angle brackets,
// quoted locals, multiple addresses), which is exactly the safe subset for a module sender.
const SINGLE_EMAIL_RE = /^[^\s@,;"'<>()[\]\\]+@[^\s@,;"'<>()[\]\\]+\.[^\s@,;"'<>()[\]\\]+$/;

/**
 * Strip dangerous HTML from a MODULE-supplied `html` body.
 *
 * TRUST BOUNDARY: in v1 a module is admin-granted (trusted-admin install), so this is defence-in-
 * depth, NOT a full DOMPurify-grade sanitizer. The core MailService/transports do NO HTML
 * sanitization (Brevo/SMTP pass `html` through verbatim), and a granted module may supply up to
 * {@link EMAIL_HTML_MAX} bytes of arbitrary markup — a phishing/script vector if it reaches an
 * inbox unmodified. We therefore neutralise the high-risk constructs while preserving email-safe
 * markup (basic tags, inline styles, tables, `<a href=http(s)>`, `<img src=http(s)>`):
 *   - remove `<script>/<iframe>/<object>/<embed>/<form>` elements AND their contents;
 *   - strip every `on*=` inline event-handler attribute;
 *   - neutralise `javascript:` and non-image `data:` URIs in `href`/`src`/`action`/etc.
 * A tiny dedicated regex strip (no new dependency). A future release may swap in a full HTML
 * sanitizer; the trust model is documented here so that upgrade is a deliberate decision.
 */
export function sanitizeModuleHtml(html: string): string {
  let out = html;
  // 1. Drop dangerous elements with their full content (open→close, case-insensitive, multiline).
  out = out.replace(/<(script|iframe|object|embed|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  // 2. Drop any stray/self-closing or unclosed dangerous tags that survived step 1.
  out = out.replace(/<\/?(script|iframe|object|embed|form)\b[^>]*>/gi, '');
  // 3. Strip inline event-handler attributes (on…="…" / on…='…' / on…=bare).
  out = out.replace(/\son[a-z0-9_-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // 4. Neutralise javascript: and non-image data: URIs anywhere in an attribute value. We blank
  //    the scheme to a harmless `about:blank` so the surrounding markup stays well-formed.
  out = out.replace(
    /(=\s*["']?\s*)(?:javascript:|vbscript:|data:(?!image\/))[^"'>\s]*/gi,
    '$1about:blank',
  );
  return out;
}

/** Shared subject/text/html fields for any module-supplied message (header-injection-safe). */
const subjectField = z
  .string()
  .min(1)
  .max(EMAIL_SUBJECT_MAX)
  .refine((v) => !SUBJECT_CONTROL.test(v), 'subject must not contain control characters');
const textField = z.string().min(1).max(EMAIL_TEXT_MAX);
const htmlField = z.string().max(EMAIL_HTML_MAX).optional();

/** Strict schema for the module-supplied message. Unknown keys are REJECTED. */
export const moduleEmailSchema = z
  .object({
    to: z
      .string()
      .min(3)
      .max(EMAIL_TO_MAX)
      .refine((v) => !CONTROL_OR_SEPARATOR.test(v), 'to must be a single address (no CR/LF/,/;)')
      .refine((v) => SINGLE_EMAIL_RE.test(v), 'to must be a syntactically valid email'),
    subject: subjectField,
    text: textField,
    html: htmlField,
  })
  .strict();

export type ModuleEmailInput = z.infer<typeof moduleEmailSchema>;

/**
 * Strict schema for `sendToCustomer` (B3). The module supplies a `customerId` (a uuid) — NEVER an
 * address — plus the same header-injection-safe subject/body/html as `send`. `.strict()` REJECTS
 * every unknown key, so a module cannot smuggle `to`/`from`/`cc`/`bcc`/`tenantId` (the tenant comes
 * from the broker context, the recipient from core's resolution). `customerId` is validated as a
 * uuid so a malformed id is rejected before any DB touch.
 */
export const moduleCustomerEmailSchema = z
  .object({
    customerId: z.string().uuid(),
    subject: subjectField,
    text: textField,
    html: htmlField,
  })
  .strict();

export type ModuleCustomerEmailInput = z.infer<typeof moduleCustomerEmailSchema>;

/**
 * The outcome of resolving a customer for a module→customer email (B3). Deliberately a DISCRIMINATED
 * union so the resolved EMAIL is present ONLY on the sendable `ok` branch — the `suppressed` branch
 * carries a PII-free reason and NO address, so a suppressed send can never leak an email into an
 * audit record or back to the worker.
 */
export type CustomerEmailResolution =
  | { status: 'ok'; email: string; locale: string | null }
  | {
      status: 'suppressed';
      reason: 'missing' | 'deleted' | 'anonymized' | 'not_consented';
    };

/**
 * Narrow port that resolves a customer to a sendable recipient (or a PII-free suppression reason)
 * for `sendToCustomer` (B3). Tenant-scoped by the broker context (never module input). The ONLY
 * place the customer's email is read for module mail; the resolution keeps the address inside core.
 */
export interface CustomerEmailLookup {
  resolveForModuleEmail(tenantId: string, customerId: string): Promise<CustomerEmailResolution>;
}

/** DI token so Nest injects the concrete (DB-backed) lookup without a class import cycle. */
export const CUSTOMER_EMAIL_LOOKUP = Symbol('CUSTOMER_EMAIL_LOOKUP');

/**
 * A fixed-window per-key counter. Pure + synchronous; no external store.
 *
 * Phase-4 NOTE: this is an IN-PROCESS limiter (no Redis), so the cap is per core instance, not
 * cluster-wide; and a fixed window permits up to a 2× burst across the window boundary. Both are
 * acceptable for v1's single-process / trusted-admin module model and are flagged here for the
 * Phase-4 multi-tenant Cloud (move to a shared/sliding limiter).
 *
 * Memory (NIT-4): expired keys are EVICTED on access, and a lightweight periodic full sweep
 * (every {@link SWEEP_EVERY} consume calls) prunes keys for modules that have gone quiet, so the
 * map cannot grow unboundedly with the count of distinct (tenant, module) pairs seen.
 */
const SWEEP_EVERY = 1024;

export class FixedWindowRateLimiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>();
  private sinceSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns true if the call is ALLOWED (and records it); false if the key is over the cap. */
  tryConsume(key: string): boolean {
    const t = this.now();
    if (++this.sinceSweep >= SWEEP_EVERY) {
      this.sinceSweep = 0;
      this.sweep(t);
    }
    const entry = this.hits.get(key);
    if (!entry || t - entry.windowStart >= this.windowMs) {
      // No live window (or the prior one expired → evict-by-overwrite) → start a fresh one.
      this.hits.set(key, { count: 1, windowStart: t });
      return true;
    }
    if (entry.count >= this.limit) return false;
    entry.count += 1;
    return true;
  }

  /** Drop every key whose window has fully expired — bounds the map for quiet modules. */
  private sweep(t: number): void {
    for (const [key, entry] of this.hits) {
      if (t - entry.windowStart >= this.windowMs) this.hits.delete(key);
    }
  }
}

/**
 * The identity the broker hands the port for one send: the worker's tenant + module name (from the
 * broker context, NEVER the module's request) used for scoping, the rate-limit key, and audit.
 */
export interface ModuleMailContext {
  readonly tenantId: string;
  readonly moduleName: string;
}

/** Subject prefix marking a module-originated mail — never confusable with a core transactional one. */
export const MODULE_MAIL_SUBJECT_PREFIX = '[module]';

/**
 * The port the broker depends on for `email.send`. Validates, rate-limits, audits, then queues via
 * core's MailService. Throws {@link RpcError} (FORBIDDEN/PROTOCOL/RATE_LIMITED) on refusal — never
 * an untyped error.
 */
@Injectable()
export class ModuleMailPort {
  private readonly logger = new Logger(ModuleMailPort.name);
  private readonly limiter: FixedWindowRateLimiter;

  constructor(
    @Inject(MAIL_SERVICE) private readonly mail: IMailService,
    private readonly audit: AuditService,
    // Tests pass a deterministic limiter; in the running app this is absent and we build the
    // env-configured default. `@Optional()` so Nest does not try to resolve it as a provider.
    @Optional() limiter?: FixedWindowRateLimiter,
    // The customer-email resolver for `sendToCustomer` (B3). `@Optional()` + token-injected so the
    // legacy `send`-only construction (and `send`-only unit tests) need not supply it; when absent,
    // `sendToCustomer` fails CLOSED (never silently sends without consent/erasure resolution).
    @Optional()
    @Inject(CUSTOMER_EMAIL_LOOKUP)
    private readonly customerLookup?: CustomerEmailLookup,
  ) {
    this.limiter =
      limiter ??
      new FixedWindowRateLimiter(
        envInt('MODULE_EMAIL_RATE_LIMIT', DEFAULT_EMAIL_RATE_LIMIT),
        envInt('MODULE_EMAIL_RATE_WINDOW_MS', DEFAULT_EMAIL_RATE_WINDOW_MS),
      );
  }

  async send(ctx: ModuleMailContext, params: unknown): Promise<ModuleEmailSendResult> {
    // 1. strict validation (header-injection-safe). A reject is audited as a denied attempt.
    const parsed = moduleEmailSchema.safeParse(params ?? {});
    if (!parsed.success) {
      await this.audit.record({
        tenantId: ctx.tenantId,
        actorType: 'system',
        action: 'module.email.denied',
        resourceType: 'module',
        changes: { module: ctx.moduleName, reason: 'invalid_params' },
      });
      throw new RpcError(
        RpcErrorCode.PROTOCOL,
        `invalid params for email.send: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }

    // 2. per-module rate limit (keyed by tenant + module). Over-limit → a clean RATE_LIMITED.
    const key = `${ctx.tenantId}:${ctx.moduleName}`;
    if (!this.limiter.tryConsume(key)) {
      await this.audit.record({
        tenantId: ctx.tenantId,
        actorType: 'system',
        action: 'module.email.denied',
        resourceType: 'module',
        changes: {
          module: ctx.moduleName,
          to: parsed.data.to,
          // NIT-5: include subject for symmetry with the `sent` record.
          subject: `${MODULE_MAIL_SUBJECT_PREFIX} ${parsed.data.subject}`,
          reason: 'rate_limited',
        },
      });
      throw new RpcError(
        RpcErrorCode.RATE_LIMITED,
        'email send rate limit exceeded for this module — back off and retry later',
      );
    }

    const { to, subject, text, html } = parsed.data;
    // 5. distinct subject prefix so a module mail can never be mistaken for / injected into a core
    //    transactional template. The module supplies its OWN subject + body — no core template.
    const prefixedSubject = `${MODULE_MAIL_SUBJECT_PREFIX} ${subject}`;
    // Sanitize module-supplied HTML (the core mail layer does NOT — defence-in-depth, see
    // sanitizeModuleHtml). The module gains no script/iframe/event-handler injection surface.
    const safeHtml = html === undefined ? undefined : sanitizeModuleHtml(html);

    // 3. audit the send FAIL-CLOSED, BEFORE the transport (SHOULD-FIX): every send MUST have its
    //    audit row on this security path. `recordOrThrow` PROPAGATES a write failure, so an
    //    un-auditable send is REFUSED (the transport is never reached) rather than sent silently.
    //    NO body in the record (no PII beyond the recipient).
    try {
      await this.audit.recordOrThrow({
        tenantId: ctx.tenantId,
        actorType: 'system',
        action: 'module.email.sent',
        resourceType: 'module',
        changes: { module: ctx.moduleName, to, subject: prefixedSubject },
      });
    } catch {
      this.logger.error(`module ${ctx.moduleName} email REFUSED: audit write failed (fail-closed)`);
      throw new RpcError(
        RpcErrorCode.HANDLER_ERROR,
        'email send refused: the send could not be audited',
      );
    }

    // 4 + via core MailService only, tenant-scoped by the worker's identity. The mail layer applies
    //    whatever escaping it already does; the module gains no new injection surface.
    try {
      await this.mail.send({ to, subject: prefixedSubject, text, html: safeHtml });
    } catch {
      // Surface a typed, PII-free failure — never leak the transport's recipient-bearing message.
      this.logger.warn(`module ${ctx.moduleName} email send failed via MailService`);
      throw new RpcError(RpcErrorCode.HANDLER_ERROR, 'email send failed at the transport');
    }

    return { queued: true };
  }

  /**
   * `sendToCustomer` (B3) — PRIVACY-PRESERVING module→customer email. The module names a customer
   * by `customerId` ONLY (it supplies no address, never receives one). Core resolves the recipient
   * by the COMPOSITE `(ctx.tenantId, customerId)` — tenant from the broker context, NEVER input —
   * and honours marketing CONSENT + RGPD erasure before sending.
   *
   * Flow (mirrors `send` for validation/rate-limit/audit/transport, with consent-gated resolution):
   *   1. strict-validate (uuid customerId + the same header-injection-safe subject/body; no `to`).
   *      Invalid → audited `module.email.denied` + PROTOCOL.
   *   2. consume the SAME per-(tenant, module) rate-limit bucket as `send`.
   *   3. resolve the customer (tenant-scoped). SUPPRESS — return `{ queued: false }`, send NOTHING —
   *      when the row is missing / soft-deleted / anonymized / `accepts_marketing = false` (the
   *      price-drop digest is PROMOTIONAL, so RGPD requires marketing consent). Audit a
   *      `module.email.suppressed` record with `{ module, customerId, reason }` — NO email, NO body.
   *      The RESULT carries no reason, so the module gains no consent/existence oracle.
   *   4. on a sendable resolution: fail-closed audit `module.email.sent`
   *      `{ module, customerId, to: resolvedEmail }` BEFORE transport, then queue via MailService
   *      (the resolved `locale` is passed through `send`'s options — MailService's `send` ignores any
   *      it does not use). The resolved email is NEVER returned to the worker — only `{ queued }`.
   */
  async sendToCustomer(ctx: ModuleMailContext, params: unknown): Promise<ModuleEmailSendResult> {
    // 1. strict validation (header-injection-safe; uuid customerId; no smuggled `to`/from/tenantId).
    const parsed = moduleCustomerEmailSchema.safeParse(params ?? {});
    if (!parsed.success) {
      await this.audit.record({
        tenantId: ctx.tenantId,
        actorType: 'system',
        action: 'module.email.denied',
        resourceType: 'module',
        changes: { module: ctx.moduleName, reason: 'invalid_params' },
      });
      throw new RpcError(
        RpcErrorCode.PROTOCOL,
        `invalid params for email.sendToCustomer: ${parsed.error.issues
          .map((i) => i.message)
          .join('; ')}`,
      );
    }

    // 2. SAME per-(tenant, module) rate-limit bucket as `send` (one email budget for the module).
    const key = `${ctx.tenantId}:${ctx.moduleName}`;
    if (!this.limiter.tryConsume(key)) {
      await this.audit.record({
        tenantId: ctx.tenantId,
        actorType: 'system',
        action: 'module.email.denied',
        resourceType: 'module',
        changes: {
          module: ctx.moduleName,
          customerId: parsed.data.customerId,
          subject: `${MODULE_MAIL_SUBJECT_PREFIX} ${parsed.data.subject}`,
          reason: 'rate_limited',
        },
      });
      throw new RpcError(
        RpcErrorCode.RATE_LIMITED,
        'email send rate limit exceeded for this module — back off and retry later',
      );
    }

    // Fail CLOSED if no resolver is wired — never send a module→customer email without the
    // consent/erasure-aware resolution path (a misconfiguration must not bypass RGPD gating).
    if (!this.customerLookup) {
      this.logger.error(
        `module ${ctx.moduleName} sendToCustomer REFUSED: no customer-email resolver configured`,
      );
      throw new RpcError(
        RpcErrorCode.HANDLER_ERROR,
        'email send refused: customer resolution is unavailable',
      );
    }

    const { customerId, subject, text, html } = parsed.data;

    // 3. resolve the customer tenant-scoped by ctx (a customerId from another tenant resolves to
    //    nothing → 'missing' → suppressed). The resolver returns an email ONLY on the sendable
    //    branch; a suppressed branch carries a PII-free reason and NO address. A raw resolver
    //    failure (e.g. a DB connection drop) is wrapped in a typed, PII-free HANDLER_ERROR — its raw
    //    `.message` must never reach the worker over RPC (N-resolver review).
    let resolution: CustomerEmailResolution;
    try {
      resolution = await this.customerLookup.resolveForModuleEmail(ctx.tenantId, customerId);
    } catch {
      this.logger.error(`module ${ctx.moduleName} sendToCustomer: customer resolution failed`);
      throw new RpcError(
        RpcErrorCode.HANDLER_ERROR,
        'email send refused: customer resolution failed',
      );
    }
    if (resolution.status === 'suppressed') {
      // Audit the suppression WITH the reason — but NO email, NO body. Best-effort (`record`):
      // a missing suppression-audit must not turn a privacy-preserving no-send into an error.
      await this.audit.record({
        tenantId: ctx.tenantId,
        actorType: 'system',
        action: 'module.email.suppressed',
        resourceType: 'module',
        changes: { module: ctx.moduleName, customerId, reason: resolution.reason },
      });
      // The module learns ONLY queued:false — no reason, no consent/existence oracle.
      return { queued: false };
    }

    const prefixedSubject = `${MODULE_MAIL_SUBJECT_PREFIX} ${subject}`;
    const safeHtml = html === undefined ? undefined : sanitizeModuleHtml(html);

    // 4. fail-closed audit BEFORE transport. The record carries the resolved recipient (mirroring
    //    `send`) + the customerId, but NEVER the body.
    try {
      await this.audit.recordOrThrow({
        tenantId: ctx.tenantId,
        actorType: 'system',
        action: 'module.email.sent',
        resourceType: 'module',
        changes: { module: ctx.moduleName, customerId, to: resolution.email },
      });
    } catch {
      this.logger.error(`module ${ctx.moduleName} email REFUSED: audit write failed (fail-closed)`);
      throw new RpcError(
        RpcErrorCode.HANDLER_ERROR,
        'email send refused: the send could not be audited',
      );
    }

    try {
      // Queue via core's MailService (the SAME path as `send`). The resolved `locale` is passed
      // through; MailService.send ignores any option it does not consume (it has no `locale` param
      // today — the FR/EN template choice lives in the typed transactional senders, not raw `send`).
      await this.mail.send({
        to: resolution.email,
        subject: prefixedSubject,
        text,
        html: safeHtml,
      });
    } catch {
      this.logger.warn(`module ${ctx.moduleName} email send failed via MailService`);
      throw new RpcError(RpcErrorCode.HANDLER_ERROR, 'email send failed at the transport');
    }

    // Return ONLY { queued } — the resolved email never crosses back to the worker.
    return { queued: true };
  }
}
