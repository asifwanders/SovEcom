'use client';

/**
 * Server-authoritative totals breakdown. MONEY-CRITICAL: every figure is a minor-unit value straight
 * off the server's `cart.totals`, rendered
 * via `formatPrice`. This component does ZERO arithmetic — it never sums, multiplies, or derives a
 * total; the server computes these values.
 *
 * `variant="full"` (cart page) shows the complete breakdown; `variant="compact"` (drawer) shows only the
 * subtotal (the full breakdown — esp. shipping/tax, which need a destination — lives on the cart page).
 * Discount and shipping rows are shown only when non-zero so an empty/early cart isn't cluttered.
 */
import { useTranslations } from 'next-intl';
import type { CartTotalsView } from '@/lib/cart-types';
import { formatPrice } from '@/lib/api';

function Row({
  label,
  value,
  emphasis = false,
  testId,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  testId?: string;
}): React.ReactElement {
  return (
    <div
      className={`flex items-center justify-between ${emphasis ? 'text-base font-semibold text-foreground' : 'text-sm text-muted-foreground'}`}
    >
      <span>{label}</span>
      <span className="tabular-nums" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

export function CartTotals({
  totals,
  variant = 'full',
  locale,
}: {
  totals: CartTotalsView;
  variant?: 'full' | 'compact';
  locale?: string;
}): React.ReactElement {
  const t = useTranslations('cart');
  const c = totals.currency;
  const price = (amountMinor: number): string => formatPrice(amountMinor, c, locale);

  if (variant === 'compact') {
    return (
      <div className="flex flex-col gap-1" data-testid="cart-totals">
        <Row
          label={t('totals.subtotal')}
          value={price(totals.subtotal)}
          emphasis
          testId="subtotal"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="cart-totals">
      <Row label={t('totals.subtotal')} value={price(totals.subtotal)} testId="subtotal" />
      {totals.discountTotal > 0 ? (
        <Row
          label={t('totals.discount')}
          value={`−${price(totals.discountTotal)}`}
          testId="discount"
        />
      ) : null}
      {totals.shipping > 0 ? (
        <Row label={t('totals.shipping')} value={price(totals.shipping)} testId="shipping" />
      ) : null}
      {totals.taxTotal > 0 ? (
        <Row label={t('totals.tax')} value={price(totals.taxTotal)} testId="tax" />
      ) : null}
      <div className="my-1 border-t border-border" />
      <Row
        label={t('totals.grandTotal')}
        value={price(totals.grandTotal)}
        emphasis
        testId="grand-total"
      />
    </div>
  );
}
