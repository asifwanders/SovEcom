'use client';

/**
 * checkout step 3: shipping method (shipping method selection with rates). MONEY-CRITICAL: every
 * rate amount is the SERVER's computed minor-unit cost (`ShippingRateView.amount`) rendered via
 * `formatPrice` — NO client money math; totals recompute SERVER-side on selection.
 *
 * The REAL shipping address is already on the cart (step 2), so on mount we fetch the available rates
 * for the real destination via the READ-ONLY `useCart().loadShippingRates()` — a plain GET of the
 * rates for the cart's CURRENT stored address. We deliberately do NOT use `estimateShipping` here:
 * that re-POSTs a placeholder ("—") address, which would OVERWRITE the real address the customer
 * just entered and clamp the flow back to the address step. Choosing a rate calls `selectShippingRate`,
 * folding its cost into the authoritative totals.
 *
 * a11y: a radiogroup of rates (keyboard-operable), `aria-busy` while loading, `role="alert"` errors,
 * "Continue" enabled only once a rate is chosen.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useCart } from '@/lib/cart-context';
import { formatPrice } from '@/lib/api';
import { Button } from '@/components/ui/Button';

/** The stored shipping-address shape on the cart (server `CartAddress` subset we read for re-querying). */
interface StoredAddress {
  country?: string;
  postalCode?: string;
}

export function CheckoutShipping({
  onDone,
  locale,
}: {
  onDone: () => void;
  locale?: string;
}): React.ReactElement {
  const t = useTranslations('checkout');
  const { cart, shippingRates, loadShippingRates, selectShippingRate } = useCart();
  const groupId = useId();

  const [loading, setLoading] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const ship = cart?.shippingAddress as StoredAddress | null;

  // Fetch rates once for the cart's REAL destination (set in step 2). MUST be the READ-ONLY
  // `loadShippingRates` (a GET that reads the cart's stored address), NOT `estimateShipping` — the
  // latter re-POSTs a placeholder ("—") address, which would OVERWRITE the real address the customer
  // just entered and clamp the flow back to the address step (`canReachStep` rejects placeholder
  // addresses). Server-authoritative; no client cost math.
  useEffect(() => {
    if (loadedRef.current) return;
    if (!ship || !ship.country || !ship.postalCode) return;
    loadedRef.current = true;
    setLoading(true);
    void loadShippingRates()
      .catch(() => setError(t('shipping.error')))
      .finally(() => setLoading(false));
  }, [ship, loadShippingRates, t]);

  async function onChoose(rateId: string): Promise<void> {
    if (choosing) return;
    setError(null);
    setChoosing(true);
    try {
      await selectShippingRate(rateId);
    } catch {
      setError(t('shipping.error'));
    } finally {
      setChoosing(false);
    }
  }

  const selectedRateId = cart?.shippingRateId ?? null;
  const rates = shippingRates ?? [];

  return (
    <div className="flex flex-col gap-5" aria-busy={loading || choosing}>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground" data-testid="shipping-loading">
          {t('shipping.loading')}
        </p>
      ) : rates.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="shipping-none">
          {t('shipping.none')}
        </p>
      ) : (
        <div
          role="radiogroup"
          aria-label={t('shipping.ratesLabel')}
          className="flex flex-col gap-2"
        >
          {rates.map((rate) => {
            const id = `${groupId}-${rate.id}`;
            const selected = rate.id === selectedRateId;
            return (
              <label
                key={rate.id}
                htmlFor={id}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-input px-3 py-2 text-sm has-[:checked]:border-primary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
              >
                <span className="flex items-center gap-2">
                  <input
                    id={id}
                    type="radio"
                    name={`${groupId}-rate`}
                    value={rate.id}
                    checked={selected}
                    disabled={choosing}
                    onChange={() => void onChoose(rate.id)}
                    className="h-4 w-4"
                  />
                  <span className="text-foreground">{rate.name}</span>
                </span>
                <span className="tabular-nums text-foreground">
                  {formatPrice(rate.amount, rate.currency, locale)}
                </span>
              </label>
            );
          })}
        </div>
      )}

      <Button
        type="button"
        variant="primary"
        size="md"
        disabled={selectedRateId === null || choosing || loading}
        aria-disabled={selectedRateId === null || choosing || loading}
        onClick={() => onDone()}
      >
        {t('continue')}
      </Button>
    </div>
  );
}
