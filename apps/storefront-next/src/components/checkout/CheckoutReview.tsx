'use client';

/**
 * checkout step 4: review (order summary before final submit). MONEY-CRITICAL: every figure is the
 * SERVER's authoritative `cart.totals` rendered via `<CartTotals>` / `formatPrice` — this view
 * does NO money/tax arithmetic.
 *
 * Shows: the line items (with snapshotted names), the server totals breakdown (incl. shipping + the
 * reverse-charge state via `<CheckoutVat>`), the chosen shipping + billing addresses, the selected
 * shipping method, and the B2B VAT/reverse-charge block. The CTA is "Proceed to payment" — it calls
 * `onProceed`, which the flow wires to advance to the Stripe Payment Element step (`CheckoutPayment`).
 * The review is GUARDED upstream: the flow won't render it without email + a real address + a
 * chosen shipping rate (see `canReachStep`).
 */
import { useTranslations } from 'next-intl';
import { useCart } from '@/lib/cart-context';
import { formatPrice } from '@/lib/api';
import { CartTotals } from '@/components/cart/CartTotals';
import { CheckoutVat } from './CheckoutVat';

/** The stored address shape on the cart (server `CartAddress`). Read-only here. */
interface StoredAddress {
  name: string;
  company?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  postalCode: string;
  region?: string | null;
  country: string;
}

/** Render a stored address as a few accessible lines. */
function AddressBlock({
  heading,
  address,
}: {
  heading: string;
  address: StoredAddress | null;
}): React.ReactElement | null {
  if (!address) return null;
  return (
    <div className="flex flex-col gap-0.5 text-sm text-foreground">
      <span className="font-semibold">{heading}</span>
      <span>{address.name}</span>
      {address.company ? <span>{address.company}</span> : null}
      <span>{address.line1}</span>
      {address.line2 ? <span>{address.line2}</span> : null}
      <span>
        {address.postalCode} {address.city}
        {address.region ? `, ${address.region}` : ''}
      </span>
      <span>{address.country}</span>
    </div>
  );
}

export function CheckoutReview({
  onProceed,
  locale,
}: {
  onProceed: () => void;
  locale?: string;
}): React.ReactElement {
  const t = useTranslations('checkout');
  const tCart = useTranslations('cart');
  const { cart, shippingRates } = useCart();

  if (!cart) {
    return <p className="text-sm text-muted-foreground">{t('review.empty')}</p>;
  }

  const ship = cart.shippingAddress as StoredAddress | null;
  const bill = (cart.billingAddress as StoredAddress | null) ?? ship;
  const chosenRate = (shippingRates ?? []).find((r) => r.id === cart.shippingRateId) ?? null;

  return (
    <div className="flex flex-col gap-6" data-testid="checkout-review">
      <section aria-label={t('review.itemsLabel')} className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-foreground">{t('review.heading')}</h2>
        <ul className="divide-y divide-border">
          {cart.items.map((line) => (
            <li
              key={line.id}
              className="flex items-start justify-between gap-4 py-2"
              data-testid="review-line"
            >
              <div className="flex flex-col">
                {/* Chunk-D snapshotted product name — never the raw variant UUID. */}
                <span
                  className="text-sm font-medium text-foreground"
                  data-testid="review-line-name"
                >
                  {line.productTitle.trim() !== '' ? line.productTitle : line.variantId}
                </span>
                {line.variantTitle ? (
                  <span className="text-xs text-muted-foreground">{line.variantTitle}</span>
                ) : null}
              </div>
              <span className="text-sm text-foreground">
                {tCart('unitTimesQty', {
                  price: formatPrice(line.unitPriceAmount, line.currency, locale),
                  qty: line.quantity,
                })}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid gap-6 sm:grid-cols-2">
        <AddressBlock heading={t('review.shippingTo')} address={ship} />
        <AddressBlock heading={t('review.billingTo')} address={bill} />
      </div>

      {chosenRate ? (
        <p className="text-sm text-foreground" data-testid="review-method">
          {/* The colon (with the FR non-breaking space) lives in the i18n message, not hardcoded here. */}
          <span className="font-semibold">{t('review.method')}</span> {chosenRate.name} —{' '}
          {formatPrice(chosenRate.amount, chosenRate.currency, locale)}
        </p>
      ) : null}

      {/* B2B VAT entry + reverse-charge display (renders nothing for guests / non-B2B). */}
      <CheckoutVat />

      <div className="rounded-lg border border-border bg-card p-5">
        <h3 className="mb-3 text-base font-semibold text-foreground">{t('review.summary')}</h3>
        <CartTotals totals={cart.totals} variant="full" locale={locale} />
      </div>

      {/* Advances to the Stripe Payment Element step (`CheckoutPayment`). The order is created AT
          that step, not here. */}
      <button
        type="button"
        onClick={onProceed}
        disabled={cart.items.length === 0}
        className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        data-testid="proceed-to-payment"
      >
        {t('review.proceedToPayment')}
      </button>
    </div>
  );
}
