'use client';

/**
 * Header cart trigger. A `'use client'` island reading `useCart.itemCount` for the live count.
 *
 * This is a BUTTON that calls `useCartUi().open()`. The full `/cart` page is still reachable via the
 * drawer's "View cart" link (and direct navigation). Design choice: a `<button>` (not a link) is the
 * correct semantic for "open an in-page dialog" — it gives SR users "button" + aria-haspopup="dialog"
 * rather than a misleading link affordance.
 *
 * a11y: the accessible name is the localized, pluralized "Cart, N items" (the count is in the NAME, so SR
 * users hear it without seeing the visual pill). The numeric pill is `aria-hidden` and omitted at zero.
 */
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useCart } from '@/lib/cart-context';
import { useCartUi } from '@/lib/cart-ui-context';
import { type CartAffordance, DEFAULT_CART_AFFORDANCE } from '@/lib/chrome-variants';

/** The shared cart glyph (decorative — the accessible name carries the meaning). */
function CartGlyph(): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
    >
      <circle cx="9" cy="21" r="1" />
      <circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
    </svg>
  );
}

/** The visible numeric count pill, omitted at zero (aria-hidden — the name carries the count). */
function CountPill({ itemCount }: { itemCount: number }): React.ReactElement | null {
  if (itemCount <= 0) return null;
  return (
    <span
      aria-hidden="true"
      className="absolute -top-1 -end-1 inline-flex min-w-[1.125rem] items-center justify-center rounded-full bg-primary px-1 text-xs font-semibold leading-tight text-primary-foreground"
    >
      {itemCount}
    </span>
  );
}

const TRIGGER_CLASS =
  'relative inline-flex items-center justify-center rounded-md p-2 text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * The header cart trigger. A BOUNDED `affordance` chrome variant:
 *   - `drawer` (default, unchanged): a BUTTON that opens the in-page cart drawer (`useCartUi().open`),
 *     with `aria-haspopup="dialog"` + `aria-expanded` reflecting the drawer state.
 *   - `page-link` (boutique): a plain locale-aware LINK to `/cart` — the boutique theme emphasises the
 *     full cart page rather than an overlay. Link semantics (no dialog aria).
 * Both render the same glyph, count pill, and count-bearing accessible name.
 */
export function CartBadge({
  affordance = DEFAULT_CART_AFFORDANCE,
}: {
  affordance?: CartAffordance;
} = {}): React.ReactElement {
  const t = useTranslations('cart');
  const { itemCount } = useCart();
  const { open, isOpen } = useCartUi();
  const label = t('openCart', { count: itemCount });

  // Boutique `page-link`: a plain link to the full cart page (no drawer, no dialog aria).
  if (affordance === 'page-link') {
    return (
      <Link href="/cart" aria-label={label} className={TRIGGER_CLASS}>
        <CartGlyph />
        <CountPill itemCount={itemCount} />
      </Link>
    );
  }

  // Default `drawer`: a button that opens the in-page cart drawer.
  return (
    <button
      type="button"
      onClick={open}
      aria-haspopup="dialog"
      aria-expanded={isOpen}
      aria-label={label}
      className={TRIGGER_CLASS}
    >
      <CartGlyph />
      <CountPill itemCount={itemCount} />
    </button>
  );
}
