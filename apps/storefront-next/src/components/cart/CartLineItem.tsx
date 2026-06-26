'use client';

/**
 * A single cart line row. Shared by BOTH the CartDrawer and the CartPage (DRY). MONEY-CRITICAL: it
 * renders the server's minor-unit `unitPriceAmount` via `formatPrice` and does NO money arithmetic.
 *
 * Display identity: the API snapshots the product/variant title, options, sku and slug onto each line
 * at add-time, so this row renders the human-readable PRODUCT TITLE (linked to its PDP via
 * `productSlug`) plus a variant/options summary — NEVER the raw variant UUID.
 *
 * Per-line total: the cart API exposes NO per-line total field. Money rules forbid client-side money
 * math, so this row displays the UNIT PRICE and the QUANTITY SEPARATELY (e.g. "€19.99 × 2") rather
 * than multiplying unit × qty in the browser. The authoritative cart SUBTOTAL/GRAND TOTAL (which DO
 * reflect qty) come from `cart.totals` and are rendered by the drawer/page.
 *
 * Quantity controls call `useCart().updateItem(itemId, qty)`; remove calls `useCart().removeItem(itemId)`.
 * Both are async; while one is in flight the row's controls are disabled (no double-submit / no negative
 * qty). The minimum quantity is 1 — decrementing at 1 is a no-op (remove is the explicit affordance).
 *
 * a11y: the stepper buttons + remove have explicit, item-named accessible labels; the quantity is an
 * `aria-live` value so a SR hears the change; controls disable (not hide) while pending.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import type { CartLineView } from '@/lib/cart-types';
import { useCart } from '@/lib/cart-context';
import { formatPrice } from '@/lib/api';

/**
 * Summarise a variant's option map for display, e.g. `{ Size: 'M', Color: 'Blue' }` → "Size: M / Color: Blue".
 * Only string/number/boolean option values are shown (a nested/object value is skipped — the snapshot
 * stores whatever the catalog held, and we never want to render `[object Object]`). Returns null when
 * there is nothing presentable, so the caller can omit the row entirely.
 */
function optionsSummary(options: Record<string, unknown>): string | null {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}: ${value}`);
    }
  }
  return parts.length > 0 ? parts.join(' / ') : null;
}

export function CartLineItem({
  line,
  locale,
}: {
  line: CartLineView;
  /** Active locale for `formatPrice` number formatting (e.g. "fr" → "19,99 €"). */
  locale?: string;
}): React.ReactElement {
  const t = useTranslations('cart');
  const { updateItem, removeItem } = useCart();
  const [pending, setPending] = useState(false);

  async function run(task: () => Promise<void>): Promise<void> {
    if (pending) return;
    setPending(true);
    try {
      await task();
    } catch {
      // The cart context owns optimistic rollback; the row just re-enables so the user can retry.
    } finally {
      setPending(false);
    }
  }

  const onIncrement = (): Promise<void> => run(() => updateItem(line.id, line.quantity + 1));
  const onDecrement = (): Promise<void> =>
    line.quantity <= 1 ? Promise.resolve() : run(() => updateItem(line.id, line.quantity - 1));
  const onRemove = (): Promise<void> => run(() => removeItem(line.id));

  const unitPrice = formatPrice(line.unitPriceAmount, line.currency, locale);
  // Prefer an explicit variant title; otherwise summarise the options (e.g. "Size: M / Color: Blue").
  const variantLine = line.variantTitle ?? optionsSummary(line.options);
  // Defensive fallback: a legacy line with no snapshotted title (additive migration, pre-2b row) shows
  // the variant id rather than an empty label, so the row is never blank.
  const title = line.productTitle.trim() !== '' ? line.productTitle : line.variantId;

  return (
    <div className="flex items-start justify-between gap-4 py-3" data-testid="cart-line-item">
      <div className="flex flex-col gap-1">
        {/* Product title snapshotted at add-time, linked to its PDP. */}
        {line.productSlug ? (
          <Link
            href={`/product/${line.productSlug}`}
            className="text-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="line-title"
          >
            {title}
          </Link>
        ) : (
          <span className="text-sm font-medium text-foreground" data-testid="line-title">
            {title}
          </span>
        )}
        {variantLine ? (
          <span className="text-xs text-muted-foreground" data-testid="line-variant">
            {variantLine}
          </span>
        ) : null}
        {/* Unit price × qty shown SEPARATELY — no client money math (see file header). */}
        <span className="text-sm text-foreground">
          {t('unitTimesQty', { price: unitPrice, qty: line.quantity })}
        </span>
      </div>

      <div className="flex flex-col items-end gap-2">
        <div className="inline-flex items-center gap-2" role="group" aria-label={t('quantityFor')}>
          <button
            type="button"
            onClick={onDecrement}
            disabled={pending || line.quantity <= 1}
            aria-label={t('decrease')}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-input text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span aria-hidden="true">−</span>
          </button>
          <span
            className="min-w-[2ch] text-center text-sm tabular-nums"
            aria-live="polite"
            data-testid="line-qty"
          >
            {line.quantity}
          </span>
          <button
            type="button"
            onClick={onIncrement}
            disabled={pending}
            aria-label={t('increase')}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-input text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span aria-hidden="true">+</span>
          </button>
        </div>
        <button
          type="button"
          onClick={onRemove}
          disabled={pending}
          aria-label={t('removeItem')}
          className="text-xs text-muted-foreground underline transition-colors hover:text-destructive disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('remove')}
        </button>
      </div>
    </div>
  );
}
