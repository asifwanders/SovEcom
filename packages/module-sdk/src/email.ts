/**
 * the module `email:send` capability message DTO.
 *
 * A PURE type: the shape a module passes to `sdk.email.send(...)`. ALL enforcement — the
 * `email:send` permission gate, strict param validation (header-injection-safe recipient/subject),
 * the per-module rate limit, the audit record, and tenant scoping — lives in the CORE broker
 * (`apps/api/.../module-broker.ts` + `module-mail.port.ts`). Nothing here can weaken it.
 *
 * The module supplies its OWN subject + plaintext body; it gets NO access to core's transactional
 * templates and NO SMTP/transport credentials. Core routes the message through the existing
 * `MailService` as a module-originated email.
 *
 * TENANT SCOPING (v1): "tenant-scoped" here means the send is ATTRIBUTED to the module's tenant for
 * AUDIT and RATE-LIMIT purposes (both keyed by the worker's tenant + module identity, never module
 * input). It is NOT transport-level isolation — single-tenant v1 uses one shared mail transport.
 *
 * BOUNDS (mirrored exactly by the broker's Zod schema — the single source of truth is the broker;
 * these constants document the contract for authors and let the SDK package self-check):
 *   - `to`     — a single, syntactically-valid email, ≤ {@link EMAIL_TO_MAX} chars, NO CR/LF/comma/
 *                semicolon (header-injection guard — a module may never address multiple recipients
 *                or smuggle a header);
 *   - `subject`— ≤ {@link EMAIL_SUBJECT_MAX} chars, NO CR/LF (header-injection guard);
 *   - `text`   — required plaintext body, ≤ {@link EMAIL_TEXT_MAX} chars;
 *   - `html`   — OPTIONAL html body, ≤ {@link EMAIL_HTML_MAX} chars (escaping/CSP is whatever the
 *                core mail layer already applies — the module gains no new injection surface).
 * Unknown keys are REJECTED (`.strict()` in the broker) — a module cannot smuggle `from`, `to`
 * arrays, `cc`/`bcc`, `tenantId`, or transport options.
 */

/** Max length of the `to` recipient address. */
export const EMAIL_TO_MAX = 254;
/** Max length of the `subject` line. */
export const EMAIL_SUBJECT_MAX = 200;
/** Max length of the plaintext `text` body. */
export const EMAIL_TEXT_MAX = 50_000;
/** Max length of the optional `html` body. */
export const EMAIL_HTML_MAX = 100_000;

/** The message a module supplies to {@link EmailClient.send}. */
export interface ModuleEmailMessage {
  /** A single, syntactically-valid recipient email. No CR/LF/comma/semicolon. */
  readonly to: string;
  /** The subject line. No CR/LF. */
  readonly subject: string;
  /** Plain-text body (required). */
  readonly text: string;
  /** Optional HTML body. */
  readonly html?: string;
}

/**
 * The message a module supplies to {@link EmailClient.sendToCustomer}.
 *
 * PRIVACY-PRESERVING module→customer email: the module addresses a customer it holds only an
 * opaque `customerId` for — it supplies NO email address and NEVER receives one. Core resolves the
 * recipient by the (broker-context tenant, customerId) composite, honours marketing CONSENT
 * (`accepts_marketing`) and RGPD erasure (`deleted_at` / `anonymized_at`), and either sends or
 * SUPPRESSES the message. The module cannot tell WHY a send was suppressed (no consent/existence
 * oracle) — it only learns whether it was {@link ModuleEmailSendResult.queued}.
 *
 * `subject`/`text`/`html` carry the SAME header-injection rules + length bounds as
 * {@link ModuleEmailMessage} (validated in the core broker — the single source of truth). There is
 * NO `to` field by construction.
 */
export interface ModuleCustomerEmailMessage {
  /** The opaque customer id (a uuid). Core resolves the recipient; the module never sees it. */
  readonly customerId: string;
  /** The subject line. No CR/LF (header-injection guard). */
  readonly subject: string;
  /** Plain-text body (required). */
  readonly text: string;
  /** Optional HTML body. */
  readonly html?: string;
}

/**
 * The result of an attempted send — handed back to the module.
 *
 * - `{@link send}` always resolves `{ queued: true }` (the module supplied the address; on success
 *   the message is queued, else it rejects).
 * - `{@link sendToCustomer}` resolves `{ queued: true }` when core sent, or `{ queued: false }` when
 *   core SUPPRESSED it (recipient missing / erased / not marketing-consented). `queued:false` is a
 *   DELIBERATELY OPAQUE outcome — it leaks no reason, so the module gains no consent/existence
 *   oracle over the customer base.
 */
export interface ModuleEmailSendResult {
  readonly queued: boolean;
}
