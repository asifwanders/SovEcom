'use client';

/**
 * Cart-page shipping ESTIMATOR. MONEY-CRITICAL: every rate amount is the SERVER's computed minor-unit cost
 * (`ShippingRateView.amount` from `ShippingService.availableRates`) rendered via `formatPrice` — NO
 * client money math, NO client tax/shipping calculation.
 *
 * This is an ESTIMATE, not the authoritative checkout shipping step.
 * The shopper enters a destination (country + postal code) → `useCart().estimateShipping(...)` sets a
 * minimal destination server-side and returns the available rates. Choosing a rate calls
 * `useCart().selectShippingRate(...)` so the server folds its cost into the authoritative `cart.totals`
 * (the totals panel then shows the grand total WITH shipping). Empty result → a clear "no rates" message.
 *
 * Kept deliberately minimal (no Google Places or address autocomplete at this tier): a
 * country select restricted to a small EU-first list + a free-text postal code. a11y: labelled fields,
 * `aria-busy` while estimating, results in a labelled list, errors via `role="alert"`.
 */
import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ShippingRateView } from '@/lib/cart-types';
import { useCart } from '@/lib/cart-context';
import { formatPrice } from '@/lib/api';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';

/** EU-first destination shortlist for the estimate (ISO-3166-1 alpha-2). Real address entry is elsewhere. */
const COUNTRIES = ['FR', 'DE', 'ES', 'IT', 'BE', 'NL', 'LU', 'IE', 'PT', 'AT'] as const;

export function ShippingEstimator({ locale }: { locale?: string }): React.ReactElement {
  const t = useTranslations('cart');
  const { estimateShipping, selectShippingRate, shippingRates, cart } = useCart();
  const baseId = useId();
  const countryId = `${baseId}-country`;
  const postalId = `${baseId}-postal`;

  const [country, setCountry] = useState<string>('FR');
  const [postalCode, setPostalCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [estimated, setEstimated] = useState(false);

  async function onEstimate(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending) return;
    if (postalCode.trim() === '') return;
    setError(null);
    setPending(true);
    try {
      await estimateShipping({ country, postalCode: postalCode.trim() });
      setEstimated(true);
    } catch {
      setError(t('shipping.error'));
    } finally {
      setPending(false);
    }
  }

  async function onChoose(rateId: string): Promise<void> {
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      await selectShippingRate(rateId);
    } catch {
      setError(t('shipping.error'));
    } finally {
      setPending(false);
    }
  }

  const selectedRateId = cart?.shippingRateId ?? null;

  return (
    <section aria-labelledby={`${baseId}-heading`} className="flex flex-col gap-3">
      <h3 id={`${baseId}-heading`} className="text-sm font-semibold text-foreground">
        {t('shipping.heading')}
      </h3>

      <form
        onSubmit={onEstimate}
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        aria-busy={pending}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={countryId} className="text-sm font-medium text-foreground">
            {t('shipping.country')}
          </label>
          <select
            id={countryId}
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            disabled={pending}
            className="flex h-10 rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            {COUNTRIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={postalId} className="text-sm font-medium text-foreground">
            {t('shipping.postalCode')}
          </label>
          <Input
            id={postalId}
            name="postalCode"
            value={postalCode}
            onChange={(e) => setPostalCode(e.target.value)}
            disabled={pending}
            autoComplete="postal-code"
          />
        </div>
        <Button type="submit" variant="secondary" size="md" disabled={pending} aria-busy={pending}>
          {t('shipping.estimate')}
        </Button>
      </form>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {estimated && shippingRates !== null ? (
        shippingRates.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="no-rates">
            {t('shipping.none')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label={t('shipping.ratesLabel')}>
            {shippingRates.map((rate: ShippingRateView) => {
              const selected = rate.id === selectedRateId;
              return (
                <li key={rate.id} className="flex items-center justify-between gap-3">
                  <span className="text-sm text-foreground">
                    {rate.name} — {formatPrice(rate.amount, rate.currency, locale)}
                  </span>
                  <Button
                    type="button"
                    variant={selected ? 'primary' : 'ghost'}
                    size="sm"
                    onClick={() => onChoose(rate.id)}
                    disabled={pending}
                    aria-pressed={selected}
                  >
                    {selected ? t('shipping.chosen') : t('shipping.choose')}
                  </Button>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </section>
  );
}
