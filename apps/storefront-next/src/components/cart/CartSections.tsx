'use client';

/**
 * Granular cart CLIENT sections — the `cart-body` composite decomposed
 * into four independently-placeable client sections so a theme (Boutique) can rearrange them.
 * Parity is the gate: the markup is VERBATIM from the pre-refactor `CartBodySection` — the same line-
 * items `<ul>`, the same discount + shipping blocks, and the same summary `<aside>`. The cart `columns`
 * layout (in `cart.json`) re-creates the exact `grid gap-8 lg:grid-cols-[1fr_20rem]` with the left
 * column wrapped in `flex flex-col gap-6`.
 *
 * Each reads `useCart()` / `useLocale()` / `useTranslations('cart')` directly (client sections have no
 * loader — they render from context). MONEY-CRITICAL: every figure comes from `cart.totals` via
 * `<CartTotals>` — these views do NO money arithmetic.
 */
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useCart } from '@/lib/cart-context';
import { buttonClasses } from '@/components/ui/Button';
import type { ClientSection, ClientSectionProps } from '@/lib/sections/renderClientSections';
import { CartLineItem } from './CartLineItem';
import { CartTotals } from './CartTotals';
import { DiscountForm } from './DiscountForm';
import { ShippingEstimator } from './ShippingEstimator';

// ── cart-line-items ──────────────────────────────────────────────────────────────────────────────

function CartLineItems(_props: ClientSectionProps): React.ReactElement {
  const t = useTranslations('cart');
  const locale = useLocale();
  const { cart } = useCart();
  const items = cart?.items ?? [];
  return (
    <ul className="divide-y divide-border" aria-label={t('page.itemsLabel')}>
      {items.map((line) => (
        <li key={line.id}>
          <CartLineItem line={line} locale={locale} />
        </li>
      ))}
    </ul>
  );
}

export const CartLineItemsSection: ClientSection = {
  type: 'cart-line-items',
  Component: CartLineItems,
};

// ── cart-discount ────────────────────────────────────────────────────────────────────────────────

function CartDiscount(_props: ClientSectionProps): React.ReactElement {
  return (
    <div className="border-t border-border pt-6">
      <DiscountForm />
    </div>
  );
}

export const CartDiscountSection: ClientSection = {
  type: 'cart-discount',
  Component: CartDiscount,
};

// ── cart-shipping ────────────────────────────────────────────────────────────────────────────────

function CartShipping(_props: ClientSectionProps): React.ReactElement {
  const locale = useLocale();
  return (
    <div className="border-t border-border pt-6">
      <ShippingEstimator locale={locale} />
    </div>
  );
}

export const CartShippingSection: ClientSection = {
  type: 'cart-shipping',
  Component: CartShipping,
};

// ── cart-summary ─────────────────────────────────────────────────────────────────────────────────

function CartSummary(_props: ClientSectionProps): React.ReactElement {
  const t = useTranslations('cart');
  const locale = useLocale();
  const { cart } = useCart();
  return (
    <aside className="flex h-fit flex-col gap-4 rounded-lg border border-border bg-card p-5">
      <h2 className="text-base font-semibold text-foreground">{t('page.summary')}</h2>
      {cart ? <CartTotals totals={cart.totals} variant="full" locale={locale} /> : null}
      {/* Locale-aware Link (next-intl) styled as a button — consistent with the other links. */}
      <Link href="/checkout" className={buttonClasses('primary', 'lg', 'w-full')}>
        {t('page.checkout')}
      </Link>
    </aside>
  );
}

export const CartSummarySection: ClientSection = {
  type: 'cart-summary',
  Component: CartSummary,
};
