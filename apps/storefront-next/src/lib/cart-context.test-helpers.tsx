/**
 * shared fixtures/helpers for the cart-context spec files (split out under the <500-line
 * rule). Pure (no `vi.mock` here): each spec file owns its own `request` mock of `./browser-client`;
 * these helpers only build the server-cart fixture + a `Probe` that renders context state for assertions.
 */
import React from 'react';
import { useCart } from './cart-context';

/** A server cart serialization matching the API `CartController.serialize` shape. */
export function serverCart(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'cart-1',
    customerId: null,
    currency: 'EUR',
    status: 'active',
    guestEmail: null,
    items: [
      {
        id: 'li-1',
        variantId: 'v1',
        quantity: 1,
        unitPriceAmount: 1999,
        currency: 'EUR',
        productTitle: 'Blue Tee',
        variantTitle: 'Medium',
        options: { Size: 'M' },
        sku: 'TEE-M',
        productSlug: 'blue-tee',
      },
    ],
    shippingAddress: null,
    billingAddress: null,
    shippingRateId: null,
    discountCode: null,
    totals: {
      subtotal: 1999,
      shipping: 0,
      discountTotal: 0,
      taxTotal: 0,
      grandTotal: 1999,
      currency: 'EUR',
    },
    ...over,
  };
}

/** Renders the context surface used across the mutation + shipping specs as `data-testid` probes. */
export function Probe() {
  const {
    cart,
    itemCount,
    addItem,
    updateItem,
    removeItem,
    applyDiscount,
    removeDiscount,
    shippingRates,
    estimateShipping,
    loadShippingRates,
    selectShippingRate,
  } = useCart();
  /** Quantity of a given line, for asserting per-line outcomes under concurrency. */
  const qtyOf = (id: string) => cart?.items.find((li) => li.id === id)?.quantity ?? '';
  return (
    <div>
      <span data-testid="count">{itemCount}</span>
      <span data-testid="grand">{cart?.totals.grandTotal ?? ''}</span>
      <span data-testid="shippingTotal">{cart?.totals.shipping ?? ''}</span>
      <span data-testid="shippingRateId">{cart?.shippingRateId ?? ''}</span>
      <span data-testid="rateCount">{shippingRates?.length ?? ''}</span>
      <span data-testid="rateNames">{(shippingRates ?? []).map((r) => r.name).join(',')}</span>
      <span data-testid="discountTotal">{cart?.totals.discountTotal ?? ''}</span>
      <span data-testid="discountCode">{cart?.discountCode ?? ''}</span>
      <span data-testid="qty-li-1">{qtyOf('li-1')}</span>
      <span data-testid="qty-li-2">{qtyOf('li-2')}</span>
      {/* Consumers catch rejections to surface a toast; here we swallow so an expected rollback
          rejection doesn't bubble as an unhandled rejection in the test harness. */}
      <button onClick={() => void addItem('v1', 1).catch(() => {})}>add</button>
      <button onClick={() => void updateItem('li-1', 5).catch(() => {})}>update</button>
      <button onClick={() => void removeItem('li-1').catch(() => {})}>remove</button>
      <button onClick={() => void applyDiscount('SAVE10').catch(() => {})}>apply</button>
      <button onClick={() => void removeDiscount('SAVE10').catch(() => {})}>removeDiscount</button>
      <button
        onClick={() =>
          void estimateShipping({ country: 'FR', postalCode: '75001' }).catch(() => {})
        }
      >
        estimate
      </button>
      <button onClick={() => void loadShippingRates().catch(() => {})}>loadRates</button>
      <button onClick={() => void selectShippingRate('rate-1').catch(() => {})}>selectRate</button>
    </div>
  );
}
