/**
 * notify-back-in-stock — the back-in-stock notification runner.
 *
 * EVENT-WIRING REALITY (documented honestly; see README "Restock wiring"):
 *   The module-event allowlist a module may subscribe to (core `module-events.ts`) has NO
 *   stock/inventory event — inventory lives in the transactional path modules can't touch — and the
 *   module read DTOs expose NO stock level. So a module CANNOT, today, observe a restock purely from
 *   its sandboxed capabilities (this is the SAME documented gap the wishlist price-drop digest hits).
 *
 *   Therefore the runner is a DIRECTLY-INVOKABLE path: the caller (a scheduled trigger, an admin
 *   job, or a test) supplies the variant ids it observed go back in stock. The module owns the rest:
 *   find every NOT-yet-notified subscription for each variant, reserve it (idempotency), compose a
 *   bounded "back in stock" message (product title via the gated `sdk.store.products`), and send via
 *   `sdk.email.send`. `src/events/subscriptions.ts` additionally subscribes to `product.updated` so
 *   the module is wired to *learn* a product changed; the restock detection itself stays in this
 *   triggered path until core exposes a stock signal (the wiring gap).
 *
 * IDEMPOTENCY: each subscription's `notified_at` is the anchor. Before sending, we `markNotified(id)`
 * — a NULL → now() UPDATE that returns the row only if THIS call flipped it. Only the call that
 * recorded the mark sends the email, so a re-run (a retry, a duplicate trigger) sends nothing
 * further. Marking BEFORE sending biases toward "no duplicate over no loss" (a failed send leaves the
 * sub marked and is not retried this run) — acceptable for a best-effort restock ping; a
 * delivery-critical path would mark only after a confirmed send.
 *
 * BATCH CAP: `settings.batchSize` bounds the TOTAL emails sent in one run across all variants, so a
 * large restock can never blow past the mail port's rate limit in a single pass.
 */
import type { EmailClient, StoreClient } from '@sovecom/module-sdk';
import type { NotifyRepository } from '../db/repository';
import type { NotifySettings } from '../settings';

export interface RunInput {
  /** The variant ids the caller observed go back in stock. */
  readonly restockedVariantIds: readonly string[];
}

export interface RunResult {
  /** Emails actually queued via `sdk.email.send`. */
  readonly sent: number;
  /** Subscriptions reserved but already claimed by a concurrent/previous run (idempotency no-op). */
  readonly skipped: number;
  /**
   * Subscriptions reserved (notified_at flipped) but whose `sdk.email.send` THREW. They are counted
   * here and the batch CONTINUES — one bad recipient never aborts the run. Consistent with the
   * "no duplicate over no loss" stance: the sub stays marked and is NOT retried this run.
   */
  readonly failed: number;
}

/** Hard ceiling on the rendered subject/body lengths (defence over the port's own bounds). */
const SUBJECT_MAX = 160;
const TEXT_MAX = 2000;

/** Substitute the literal `{product}` token in the subject template with the product title. */
export function renderSubject(template: string, productTitle: string): string {
  const subject = template.split('{product}').join(productTitle);
  return subject.length > SUBJECT_MAX ? subject.slice(0, SUBJECT_MAX) : subject;
}

/** Compose the bounded plaintext back-in-stock body for one subscription. */
export function renderText(productTitle: string): string {
  const text = [
    `Good news — ${productTitle} is back in stock.`,
    '',
    'Visit the store to grab it before it sells out again.',
    '',
    'You are receiving this because you asked to be notified when this item was available. ' +
      'No further emails will be sent for this item unless you subscribe again.',
  ].join('\n');
  return text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) : text;
}

/**
 * Resolve a product title for a variant id via the gated catalog read. Best-effort: a missing/failed
 * lookup degrades to a generic label so the email still goes out.
 *
 * KNOWN LIMITATION (see README "Title resolution"): the stored key is a product VARIANT id, but
 * `sdk.store.products.get` is keyed by PRODUCT id and the field-limited `ModuleProductDto` exposes no
 * variant→product mapping. So for most subscribers this lookup MISSES and falls back to the generic
 * title — it only resolves when the caller happened to subscribe a product id. A faithful title
 * needs a future SDK that resolves a variant id (or exposes the parent product on the variant). We
 * do NOT fake a title; the generic fallback is honest.
 */
async function resolveTitle(store: StoreClient, variantId: string): Promise<string> {
  try {
    const dto = await store.products.get(variantId);
    if (dto && typeof dto.title === 'string' && dto.title.length > 0) return dto.title;
  } catch {
    // fall through to the generic label
  }
  return 'an item on your wishlist';
}

/**
 * Run the back-in-stock notifications. Idempotent + batch-capped. For each restocked variant, find
 * every not-yet-notified subscription, reserve it, resolve the product title, and send ONE
 * back-in-stock email per subscription. Returns counts.
 */
export async function runBackInStockNotifications(
  input: RunInput,
  deps: {
    repo: NotifyRepository;
    store: StoreClient;
    email: EmailClient;
    settings: NotifySettings;
  },
): Promise<RunResult> {
  if (!deps.settings.enabled) return { sent: 0, skipped: 0, failed: 0 };

  const cap = deps.settings.batchSize;
  // De-dupe the input variant list (a caller may pass the same variant twice).
  const variantIds = [...new Set(input.restockedVariantIds.filter((v) => v.length > 0))];

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  // The batch cap bounds RESERVED subscriptions (a reserved sub consumed a slot whether its send
  // succeeded or threw), so accounting advances against attempts, not just successes — a run of
  // all-failures can't loop unbounded past the cap.
  let attempted = 0;

  for (const variantId of variantIds) {
    if (attempted >= cap) break; // per-run batch cap reached

    const remaining = cap - attempted;
    const pending = await deps.repo.pendingForVariant(variantId, remaining);
    if (pending.length === 0) continue;

    // Resolve the product title ONCE per variant (not per subscription).
    const title = await resolveTitle(deps.store, variantId);
    const subject = renderSubject(deps.settings.subjectTemplate, title);
    const text = renderText(title);

    for (const sub of pending) {
      if (attempted >= cap) break;

      // Reserve BEFORE sending — only the call that flips notified_at NULL → now() proceeds.
      const reserved = await deps.repo.markNotified(sub.id);
      if (!reserved) {
        skipped += 1; // already claimed by a concurrent/previous run (NOT a cap-consuming attempt)
        continue;
      }

      attempted += 1;
      try {
        await deps.email.send({ to: sub.customer_email, subject, text });
        sent += 1;
      } catch {
        // One bad recipient must never abort the whole batch. The sub stays reserved (marked) and
        // is not retried this run — "no duplicate over no loss". Count it and carry on.
        failed += 1;
      }
    }
  }

  return { sent, skipped, failed };
}
