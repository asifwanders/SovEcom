'use client';

/**
 * transactional add-to-cart affordance. MONEY-CRITICAL:
 * the FIRST real cart mutation from the storefront. The PDP was display-only through 3.6/3.7; this is
 * what makes it transactional.
 *
 * A `'use client'` button calling `useCart().addItem(variantId, quantity)` (the credentialed client-js
 * mechanism — NO Server Actions. It NEVER touches money: price is rendered upstream from
 * the server's minor-unit amount; this button only fires the mutation and reflects its promise.
 *
 * States:
 *   - idle      → labelled "Add to cart", enabled.
 *   - pending   → disabled + "Adding…" (also `aria-busy`); a second click can't double-submit.
 *   - success   → a brief `role="status"` "Added to cart" announcement; the button returns to idle.
 *   - error     → a `role="alert"` retry-able message; the button is re-enabled (the optimistic add
 *                 already rolled back in the cart context) so the user can retry.
 *   - unavailable → when `available` is false OR no variant is selected (`variantId == null`), the
 *                 button is DISABLED with an out-of-stock label and NEVER calls `addItem`.
 *
 * Quantity defaults to 1 (PDP shows no stepper at this tier; cart-page qty editing available elsewhere).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useCart } from '@/lib/cart-context';
import { Button } from '@/components/ui/Button';

type Status = 'idle' | 'pending' | 'success' | 'error';

/** How long the success "Added to cart" status stays before reverting to idle (ms). */
const SUCCESS_RESET_MS = 2000;

export function AddToCartButton({
  variantId,
  available,
  quantity = 1,
}: {
  /** The resolved variant to add, or null when no variant is selected yet. */
  variantId: string | null;
  /** Whether the selected variant is in stock / purchasable. */
  available: boolean;
  /** Quantity to add (defaults to 1 — no stepper at this tier). */
  quantity?: number;
}): React.ReactElement {
  const t = useTranslations('product');
  const { addItem } = useCart();
  const [status, setStatus] = useState<Status>('idle');

  // Guard async state updates after unmount (a slow add resolving on a torn-down PDP island).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Auto-clear the transient success status back to idle so the button is reusable.
  useEffect(() => {
    if (status !== 'success') return;
    const id = setTimeout(() => {
      if (mountedRef.current) setStatus('idle');
    }, SUCCESS_RESET_MS);
    return () => clearTimeout(id);
  }, [status]);

  // Disabled unless a real, in-stock variant is selected. Two distinct disabled CAUSES:
  //   - no variant chosen yet (variantId === null)        → "Select an option" (nothing is wrong)
  //   - a variant is chosen but it is unavailable (!available) → "Out of stock" (genuinely OOS)
  const selected = variantId !== null;
  const purchasable = selected && available;
  const pending = status === 'pending';

  async function onClick(): Promise<void> {
    if (!purchasable || pending || variantId === null) return; // never add when unavailable/in-flight
    setStatus('pending');
    try {
      await addItem(variantId, quantity);
      if (mountedRef.current) setStatus('success');
    } catch {
      // The cart context already rolled back any optimistic count; surface a retry-able error.
      if (mountedRef.current) setStatus('error');
    }
  }

  let label: string;
  if (!selected) label = t('selectOptionCta');
  else if (!available) label = t('outOfStockDisabled');
  else if (pending) label = t('adding');
  else label = t('addToCart');

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="primary"
        size="lg"
        onClick={onClick}
        disabled={!purchasable || pending}
        aria-disabled={!purchasable || pending}
        aria-busy={pending}
        className="w-full"
      >
        {label}
      </Button>

      {/* Live regions: success is polite (status), error is assertive (alert). Only one shows at a time. */}
      {status === 'success' ? (
        <p role="status" className="text-sm text-success">
          {t('added')}
        </p>
      ) : null}
      {status === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {t('addError')}
        </p>
      ) : null}
    </div>
  );
}
