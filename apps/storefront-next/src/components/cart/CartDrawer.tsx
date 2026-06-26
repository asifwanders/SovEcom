'use client';

/**
 * Slide-out cart drawer. An accessible modal dialog built BESPOKE (no Radix/headlessui, no new
 * runtime deps). The admin has a dialog for reference but storefront code never imports admin code.
 *
 * a11y (the strict accessibility gate): `role="dialog"` + `aria-modal="true"` + `aria-labelledby` the
 * heading; FOCUS TRAP (Tab/Shift+Tab cycle within the panel); Esc closes; clicking the backdrop closes;
 * focus moves INTO the panel on open and RETURNS to the trigger (the header cart icon) on close;
 * BODY SCROLL-LOCK while open. Renders nothing when closed.
 *
 * Content: line items (shared `CartLineItem`), a compact subtotal (server-authoritative), and two CTAs —
 * "View cart" → `/cart` (closes the drawer, then navigates) and "Checkout" → `/checkout`. Empty state
 * when the cart has no items.
 *
 * MONEY: no client math — the subtotal is the server's `cart.totals.subtotal` via `<CartTotals compact>`.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useCart } from '@/lib/cart-context';
import { useCartUi } from '@/lib/cart-ui-context';
import { buttonClasses } from '@/components/ui/Button';
import { CartLineItem } from './CartLineItem';
import { CartTotals } from './CartTotals';

/** Selector for the tabbable elements used by the focus trap. */
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

export function CartDrawer(): React.ReactElement | null {
  const t = useTranslations('cart');
  const locale = useLocale();
  const { isOpen, close } = useCartUi();
  const { cart } = useCart();

  const panelRef = useRef<HTMLDivElement>(null);
  const headingId = 'cart-drawer-heading';
  // The element focused before the drawer opened (the header cart icon), to restore on close.
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // On open: remember the trigger, move focus into the panel, lock body scroll. On close/unmount:
  // restore focus + scroll. Deliberately depends only on `isOpen` so it runs exactly on transitions.
  useEffect(() => {
    if (!isOpen) return;
    previouslyFocused.current = (document.activeElement as HTMLElement | null) ?? null;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    // Focus the panel itself (it is `tabIndex={-1}`) so the first Tab lands on the first control.
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      previouslyFocused.current?.focus?.();
    };
  }, [isOpen]);

  // Esc to close + Tab focus-trap, scoped to the open drawer.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === panel,
      );
      if (focusable.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [close],
  );

  if (!isOpen) return null;

  const items = cart?.items ?? [];
  const isEmpty = items.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop — click to close. Decorative; the dialog carries the semantics. */}
      <button
        type="button"
        aria-label={t('drawer.dismiss')}
        tabIndex={-1}
        onClick={close}
        className="absolute inset-0 cursor-default bg-foreground/40"
        data-testid="cart-drawer-backdrop"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="relative flex h-full w-full max-w-sm flex-col bg-card shadow-xl focus-visible:outline-none"
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 id={headingId} className="text-lg font-semibold text-foreground">
            {t('drawer.title')}
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label={t('drawer.close')}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4">
          {isEmpty ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <p className="text-sm text-muted-foreground">{t('drawer.empty')}</p>
              <Link
                href="/products"
                onClick={close}
                className="text-sm font-medium text-primary underline"
              >
                {t('drawer.continueShopping')}
              </Link>
            </div>
          ) : (
            <ul className="divide-y divide-border" aria-label={t('drawer.itemsLabel')}>
              {items.map((line) => (
                <li key={line.id}>
                  <CartLineItem line={line} locale={locale} />
                </li>
              ))}
            </ul>
          )}
        </div>

        {!isEmpty && cart ? (
          <footer className="flex flex-col gap-3 border-t border-border px-4 py-4">
            <CartTotals totals={cart.totals} variant="compact" locale={locale} />
            <div className="flex flex-col gap-2">
              {/* Locale-aware Link (next-intl) styled as a button — consistent with the other links
                  here; next-intl prefixes the active locale, so no hand-rolled `/${locale}` prefix. */}
              <Link href="/checkout" className={buttonClasses('primary', 'lg')}>
                {t('drawer.checkout')}
              </Link>
              <Link
                href="/cart"
                onClick={close}
                className="text-center text-sm font-medium text-foreground underline"
              >
                {t('drawer.viewCart')}
              </Link>
            </div>
          </footer>
        ) : null}
      </div>
    </div>
  );
}
