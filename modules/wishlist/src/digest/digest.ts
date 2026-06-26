/**
 * wishlist — the weekly price-drop email digest (opt-in).
 *
 * EVENT-WIRING REALITY (documented honestly; see README "Digest wiring"):
 *   The module-event allowlist a module may subscribe to (core `module-events.ts`) has NO
 *   `price.changed` / price-drop event — only product LIFECYCLE events, and `product.updated` is
 *   delivered with a minimal `{ productId }` payload (NO price, by design). The gated catalog read
 *   (`sdk.store.products`, `ModuleProductDto`) also exposes NO price, and `ModuleCustomerDto`
 *   exposes NO email. So a module CANNOT, today, observe a price drop or resolve a customer's email
 *   purely from its sandboxed capabilities.
 *
 *   Therefore the digest is built as a DIRECTLY-INVOKABLE path: the caller (a scheduled trigger,
 *   the admin, or a test) supplies the price-drop CANDIDATES it observed. The module owns the rest:
 *   match candidates against who wishlisted them, skip anyone already emailed for that drop
 *   (idempotency ledger), compose the message, and email each matched customer via
 *   `sdk.email.sendToCustomer({ customerId, … })` (follow-up B3). `src/events/subscriptions.ts`
 *   additionally subscribes to `product.updated` so the module is wired to *learn* a product
 *   changed; the price comparison itself stays in this triggered path until core exposes a
 *   price-drop signal (the wiring gap).
 *
 * RECIPIENT RESOLUTION + CONSENT (B3): the module addresses a customer by its opaque `customerId`
 * only. CORE resolves the email behind `sendToCustomer`, honours marketing CONSENT
 * (`accepts_marketing`) and RGPD erasure (deleted / anonymized), and either sends (`{queued:true}`)
 * or SUPPRESSES (`{queued:false}`). The module NEVER sees the email and cannot tell WHY a send was
 * suppressed (no consent/existence oracle). The old `CustomerEmailResolver` seam is GONE.
 *
 * IDEMPOTENCY: each run carries a stable `digestRunId`. Before sending, we `markDigested(...)` —
 * a no-op insert guarded by a UNIQUE constraint — to CLAIM the (customer, variant, run). Only the
 * call that recorded the claim attempts the email, so a re-run / duplicate tick sends nothing
 * further. A send that is queued or suppressed consumes the claim (so an opted-out customer is not
 * retried every run); a send that throws rolls back its claims only for definitely-not-delivered
 * codes (FORBIDDEN/PROTOCOL/RATE_LIMITED) so the next run retries — a HANDLER_ERROR (possibly
 * delivered) keeps the claim, biasing toward no-duplicate promotional sends.
 */
import { RpcErrorCode, type EmailClient } from '@sovecom/module-sdk';
import type { WishlistRepository } from '../db/repository';
import type { WishlistSettings } from '../settings';

/**
 * Error codes for which a thrown send is DEFINITELY-NOT-DELIVERED (and either transient or a
 * config error), so rolling back the idempotency claim is safe — the next run retries cleanly:
 *   - FORBIDDEN    — the grant is missing (no email left core);
 *   - PROTOCOL     — params were rejected (no email left core);
 *   - RATE_LIMITED — the module's budget was exhausted (no email left core).
 * A HANDLER_ERROR is possibly delivered (the port audits `module.email.sent` before the transport,
 * so a transport-class failure may already have queued the mail). For it and any non-RpcError or
 * unknown code, we keep the claim, biasing toward no-duplicate over a possible double send.
 */
const ROLLBACK_ERROR_CODES: ReadonlySet<string> = new Set([
  RpcErrorCode.FORBIDDEN,
  RpcErrorCode.PROTOCOL,
  RpcErrorCode.RATE_LIMITED,
]);

/** Read a thrown value's RPC error code, if it carries one (the broker surfaces `{ code }`). */
function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** One observed price drop the caller hands the digest. Money is integer minor units + currency. */
export interface PriceDropCandidate {
  readonly productVariantId: string;
  readonly title: string;
  readonly oldPriceMinor: number;
  readonly newPriceMinor: number;
  readonly currency: string;
}

export interface DigestInput {
  /** A stable id for this digest run — the idempotency key. */
  readonly digestRunId: string;
  /** The price drops observed since the last run. */
  readonly candidates: readonly PriceDropCandidate[];
}

export interface DigestResult {
  /** Emails CORE accepted for delivery via `sdk.email.sendToCustomer` (`{queued:true}`). */
  readonly sent: number;
  /**
   * Customers matched but not emailed: already digested this run, OR core SUPPRESSED the send
   * (`{queued:false}` — recipient missing/erased/not marketing-consented; the reason is opaque to
   * the module). Both states consume the run's idempotency claim so they are not retried each run.
   */
  readonly skipped: number;
}

/** Only positive, integer, strictly-decreasing prices are real drops worth emailing. */
function isRealDrop(c: PriceDropCandidate): boolean {
  return (
    Number.isInteger(c.oldPriceMinor) &&
    Number.isInteger(c.newPriceMinor) &&
    c.oldPriceMinor > 0 &&
    c.newPriceMinor >= 0 &&
    c.newPriceMinor < c.oldPriceMinor
  );
}

/**
 * Format integer minor units as a major-unit string (e.g. 1999 → "19.99 EUR").
 *
 * ASSUMPTION (EUR-first): hardcodes a 2-decimal minor→major ratio (÷100), which holds for EUR/USD/
 * GBP and most currencies but NOT for zero-decimal ones (JPY, KRW — no minor unit) or 3-decimal
 * ones (BHD, KWD). A fork serving those should swap this for currency-aware formatting (e.g.
 * `Intl.NumberFormat(locale, { style: 'currency', currency })` with the right minor-unit exponent).
 */
function formatMoney(minor: number, currency: string): string {
  const major = (minor / 100).toFixed(2);
  return `${major} ${currency}`;
}

/** Compose the plaintext digest body for one customer's set of dropped items. */
export function buildDigestEmail(drops: readonly PriceDropCandidate[]): {
  subject: string;
  text: string;
} {
  const lines = drops.map(
    (d) =>
      `• ${d.title}: ${formatMoney(d.oldPriceMinor, d.currency)} → ${formatMoney(
        d.newPriceMinor,
        d.currency,
      )}`,
  );
  const subject =
    drops.length === 1
      ? `Price drop on an item in your wishlist`
      : `Price drops on ${drops.length} items in your wishlist`;
  const text = [
    `Good news — ${drops.length === 1 ? 'an item' : 'some items'} in your wishlist dropped in price:`,
    '',
    ...lines,
    '',
    'Visit the store to grab them before the price changes again.',
  ].join('\n');
  return { subject, text };
}

/**
 * Run the price-drop digest. Idempotent + opt-in. For each real drop, find every customer
 * wishlisting that variant, gather their not-yet-notified drops, and email ONE consolidated message
 * per customer via `sdk.email.sendToCustomer` (B3) — core resolves the recipient and honours
 * marketing consent + erasure. The per-(customer, variant, run) ledger guarantees no duplicate sends
 * across re-runs.
 *
 * `settings.weeklyDigest` must be on (the feature is opt-in at the module level); each customer's
 * own marketing consent is then honoured by CORE inside `sendToCustomer` (the module never reads it).
 *
 * CLAIM/ROLLBACK: we CLAIM each (customer, variant, run) with `markDigested` before the send. A send
 * that returns (queued OR suppressed) consumes the claim. A send that THROWS rolls the claims back
 * (`unmarkDigested`) ONLY for definitely-not-delivered codes (FORBIDDEN/PROTOCOL/RATE_LIMITED) so the
 * next run retries; a HANDLER_ERROR (possibly delivered) keeps the claim — bias to no-duplicate.
 */
export async function runPriceDropDigest(
  input: DigestInput,
  deps: { repo: WishlistRepository; email: EmailClient; settings: WishlistSettings },
): Promise<DigestResult> {
  if (!deps.settings.enabled || !deps.settings.weeklyDigest) {
    return { sent: 0, skipped: 0 };
  }

  const drops = input.candidates.filter(isRealDrop);
  if (drops.length === 0) return { sent: 0, skipped: 0 };

  const dropByVariant = new Map<string, PriceDropCandidate>();
  for (const d of drops) dropByVariant.set(d.productVariantId, d);

  // Who is watching any dropped variant?
  const watchers = await deps.repo.customersWatching([...dropByVariant.keys()]);

  // Group watched drops per customer.
  const perCustomer = new Map<string, PriceDropCandidate[]>();
  for (const w of watchers) {
    const drop = dropByVariant.get(w.product_variant_id);
    if (!drop) continue;
    const list = perCustomer.get(w.customer_id) ?? [];
    list.push(drop);
    perCustomer.set(w.customer_id, list);
  }

  let sent = 0;
  let skipped = 0;

  for (const [customerId, customerDrops] of perCustomer) {
    // CLAIM each (customer, variant) for THIS run first — idempotency before any email. Only the
    // freshly-claimed drops are emailed; an already-claimed one (re-run/redelivery) is skipped.
    const fresh: PriceDropCandidate[] = [];
    for (const d of customerDrops) {
      const recorded = await deps.repo.markDigested(
        customerId,
        d.productVariantId,
        input.digestRunId,
      );
      if (recorded) fresh.push(d);
    }
    if (fresh.length === 0) {
      skipped += 1; // everything already digested in this run
      continue;
    }

    const { subject, text } = buildDigestEmail(fresh);
    let result: { queued: boolean };
    try {
      // Core resolves the recipient by (tenant, customerId), honours marketing consent + erasure,
      // and either queues or suppresses. The module supplies NO address and never sees one.
      result = await deps.email.sendToCustomer({ customerId, subject, text });
    } catch (err) {
      // S1: roll the claim back ONLY for definitely-not-delivered codes (FORBIDDEN/PROTOCOL/
      // RATE_LIMITED), so the next run retries. A HANDLER_ERROR is POSSIBLY-DELIVERED (the port
      // audits `module.email.sent` before the transport) — and any non-RpcError / unknown code is
      // treated the same — so we KEEP the claim, biasing to no-duplicate promotional send.
      if (ROLLBACK_ERROR_CODES.has(errorCode(err) ?? '')) {
        for (const d of fresh) {
          // N3: guard each rollback independently — one failing unmark must not strand the rest.
          try {
            await deps.repo.unmarkDigested(customerId, d.productVariantId, input.digestRunId);
          } catch {
            // Best-effort: the claim simply stays (a missed retry, never a double-send). Continue.
          }
        }
      }
      throw err;
    }

    if (result.queued) {
      sent += 1;
    } else {
      // Suppressed by core (no consent / erased / missing). The claim STAYS consumed so an
      // opted-out customer is not re-attempted every run; the reason is opaque to the module.
      skipped += 1;
    }
  }

  return { sent, skipped };
}
