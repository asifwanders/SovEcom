import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import type { CartView } from '@/lib/cart-types';

/**
 * i — the granular cart CLIENT sections (the `cart-body` composite decomposed
 * into `cart-line-items` / `cart-discount` / `cart-shipping` / `cart-summary`). Each reads `useCart()`
 * and reproduces the pre-refactor body markup VERBATIM. Parity is the gate.
 */

// Locale-aware Link → plain anchor.
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

// Child islands with their own specs — stub so these specs stay focused on the section markup.
vi.mock('./DiscountForm', () => ({ DiscountForm: () => <div data-testid="discount-form" /> }));
vi.mock('./ShippingEstimator', () => ({
  ShippingEstimator: () => <div data-testid="shipping-estimator" />,
}));

let cart: CartView | null = null;
const refresh = vi.fn<() => Promise<void>>();
const updateItem = vi.fn().mockResolvedValue(undefined);
const removeItem = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/cart-context', () => ({
  useCart: () => ({ cart, refresh, updateItem, removeItem }),
}));

import {
  CartLineItemsSection,
  CartDiscountSection,
  CartShippingSection,
  CartSummarySection,
} from './CartSections';

function lineItem(over: Partial<CartView['items'][number]> = {}): CartView['items'][number] {
  return {
    id: 'li-1',
    variantId: 'v1',
    quantity: 2,
    unitPriceAmount: 1999,
    currency: 'EUR',
    productTitle: 'Blue Tee',
    variantTitle: 'Medium',
    options: { Size: 'M' },
    sku: 'TEE-M',
    productSlug: 'blue-tee',
    ...over,
  };
}

function makeCart(items: CartView['items'], over: Partial<CartView['totals']> = {}): CartView {
  return {
    id: 'cart-1',
    customerId: null,
    currency: 'EUR',
    status: 'active',
    guestEmail: null,
    items,
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
      reverseCharge: false,
      ...over,
    },
  };
}

beforeEach(() => {
  cart = makeCart([lineItem()]);
  refresh.mockReset();
  refresh.mockResolvedValue();
  updateItem.mockClear();
  removeItem.mockClear();
});

describe('CartLineItemsSection', () => {
  it('renders the line-items <ul> with the verbatim parity classes + a labelled list', () => {
    const { container } = renderWithIntl(<CartLineItemsSection.Component settings={{}} />, 'en');
    const ul = container.querySelector('ul.divide-y.divide-border');
    expect(ul).not.toBeNull();
    expect(ul!.getAttribute('aria-label')).toBeTruthy();
    expect(screen.getByTestId('cart-line-item')).toBeInTheDocument();
  });
});

describe('CartDiscountSection', () => {
  it('renders the discount form inside the verbatim border-t block', () => {
    const { container } = renderWithIntl(<CartDiscountSection.Component settings={{}} />, 'en');
    const block = container.querySelector('div.border-t.border-border.pt-6');
    expect(block).not.toBeNull();
    expect(block!.querySelector('[data-testid="discount-form"]')).not.toBeNull();
  });
});

describe('CartShippingSection', () => {
  it('renders the shipping estimator inside the verbatim border-t block', () => {
    const { container } = renderWithIntl(<CartShippingSection.Component settings={{}} />, 'en');
    const block = container.querySelector('div.border-t.border-border.pt-6');
    expect(block).not.toBeNull();
    expect(block!.querySelector('[data-testid="shipping-estimator"]')).not.toBeNull();
  });
});

describe('CartSummarySection', () => {
  it('renders the summary aside with the verbatim classes, totals, and checkout CTA', () => {
    cart = makeCart([lineItem()], {
      subtotal: 3998,
      shipping: 499,
      discountTotal: 200,
      taxTotal: 760,
      grandTotal: 5057,
    });
    const { container } = renderWithIntl(<CartSummarySection.Component settings={{}} />, 'en');
    expect(
      container.querySelector(
        'aside.flex.h-fit.flex-col.gap-4.rounded-lg.border.border-border.bg-card.p-5',
      ),
    ).not.toBeNull();
    // Server-authoritative totals (no client math).
    expect(screen.getByTestId('subtotal')).toHaveTextContent(/€39\.98/);
    expect(screen.getByTestId('discount')).toHaveTextContent(/€2\.00/);
    expect(screen.getByTestId('shipping')).toHaveTextContent(/€4\.99/);
    expect(screen.getByTestId('tax')).toHaveTextContent(/€7\.60/);
    expect(screen.getByTestId('grand-total')).toHaveTextContent(/€50\.57/);
    expect(screen.getByRole('link', { name: /checkout/i })).toHaveAttribute('href', '/checkout');
  });

  it('localizes the summary heading in French', () => {
    renderWithIntl(<CartSummarySection.Component settings={{}} />, 'fr');
    expect(screen.getByText(/récapitulatif/i)).toBeInTheDocument();
  });
});
