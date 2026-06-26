import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import type { ThemeTemplate } from '@sovecom/theme-sdk';
import { renderWithIntl } from '@/test-intl';
import type { CartView } from '@/lib/cart-types';

// Locale-aware Link → plain anchor for testing.
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

// Child islands with their own specs — stub so this spec stays focused on the page composition.
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

import { CartPageView } from './CartPageView';

/** A cart line carrying the add-time display-identity snapshot. */
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
});

describe('CartPageView', () => {
  it('refreshes the authoritative cart once on mount', () => {
    renderWithIntl(<CartPageView />, 'en');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('renders the non-empty body via the granular cart sections through the columns layout', () => {
    const { container } = renderWithIntl(<CartPageView />, 'en');
    // The body comes from the `columns` client layout placing the granular cart sections; the DOM
    // is identical to the prior inline body (verbatim grid + left column wrapper + same children).
    const grid = container.querySelector('div.grid.gap-8.lg\\:grid-cols-\\[1fr_20rem\\]');
    expect(grid).not.toBeNull();
    // Left column wrapped in the verbatim `flex flex-col gap-6`; summary aside bare on the right.
    const leftCol = container.querySelector('div.flex.flex-col.gap-6')!;
    expect(leftCol).not.toBeNull();
    expect(leftCol.querySelector('ul.divide-y.divide-border')).not.toBeNull();
    expect(
      container.querySelector(
        'aside.flex.h-fit.flex-col.gap-4.rounded-lg.border.border-border.bg-card.p-5',
      ),
    ).not.toBeNull();
    expect(screen.getByTestId('cart-line-item')).toBeInTheDocument();
    expect(screen.getByTestId('discount-form')).toBeInTheDocument();
    expect(screen.getByTestId('shipping-estimator')).toBeInTheDocument();
    // Locale-aware Link → the mocked next-intl Link passes the unprefixed href through (next-intl adds
    // the locale prefix at runtime), consistent with the other links on the page.
    expect(screen.getByRole('link', { name: /checkout/i })).toHaveAttribute('href', '/checkout');
  });

  it('renders the full server-authoritative totals breakdown (no client math)', () => {
    cart = makeCart([lineItem()], {
      subtotal: 3998,
      shipping: 499,
      discountTotal: 200,
      taxTotal: 760,
      grandTotal: 5057,
    });
    renderWithIntl(<CartPageView />, 'en');
    expect(screen.getByTestId('subtotal')).toHaveTextContent(/€39\.98/);
    expect(screen.getByTestId('discount')).toHaveTextContent(/€2\.00/);
    expect(screen.getByTestId('shipping')).toHaveTextContent(/€4\.99/);
    expect(screen.getByTestId('tax')).toHaveTextContent(/€7\.60/);
    // The grand total is the SERVER value (5057), never re-derived client-side.
    expect(screen.getByTestId('grand-total')).toHaveTextContent(/€50\.57/);
  });

  it('shows the empty-cart state with a continue-shopping link when there are no items', () => {
    cart = makeCart([]);
    renderWithIntl(<CartPageView />, 'en');
    expect(screen.getByTestId('cart-empty')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /continue shopping/i })).toHaveAttribute(
      'href',
      '/products',
    );
    // No totals / checkout on an empty cart.
    expect(screen.queryByTestId('grand-total')).toBeNull();
  });

  it('localizes the summary heading in French', () => {
    renderWithIntl(<CartPageView />, 'fr');
    expect(screen.getByText(/récapitulatif/i)).toBeInTheDocument();
  });

  // ── Active-theme cart template ────────────────────────────────────────────────────────────────
  describe('active-theme cart template', () => {
    it('no themeName → the DEFAULT cart template renders (parity)', () => {
      const { container } = renderWithIntl(<CartPageView />, 'en');
      expect(
        container.querySelector('div.grid.gap-8.lg\\:grid-cols-\\[1fr_20rem\\]'),
      ).not.toBeNull();
      expect(screen.getByTestId('cart-line-item')).toBeInTheDocument();
    });

    it('themeName="boutique" → the BOUTIQUE cart template renders', () => {
      const { container } = renderWithIntl(<CartPageView themeName="boutique" />, 'en');
      // The boutique cart template resolves + renders the granular cart sections (same columns grid).
      expect(
        container.querySelector('div.grid.gap-8.lg\\:grid-cols-\\[1fr_20rem\\]'),
      ).not.toBeNull();
      expect(screen.getByTestId('cart-line-item')).toBeInTheDocument();
      expect(screen.getByTestId('discount-form')).toBeInTheDocument();
    });

    it('an unknown themeName falls back to the default cart template (defensive)', () => {
      const { container } = renderWithIntl(<CartPageView themeName="does-not-exist" />, 'en');
      expect(
        container.querySelector('div.grid.gap-8.lg\\:grid-cols-\\[1fr_20rem\\]'),
      ).not.toBeNull();
    });
  });

  // ── Wire cart template ────────────────────────────────────────────────────────────────────────
  describe('wire cart template', () => {
    it('renders the WIRE cart template when provided (overrides the bundled set)', () => {
      // A wire `cart` template with a DISTINCT container class — proves it wins over the bundled
      // default (which uses `grid gap-8 lg:grid-cols-[1fr_20rem]`).
      const cartTemplate = {
        page: 'cart' as const,
        sections: [
          {
            type: 'columns',
            settings: {
              containerClass: 'wire-cart-grid',
              leftClass: 'flex flex-col gap-6',
              rightClass: '',
            },
            regions: {
              left: [
                { type: 'cart-line-items' },
                { type: 'cart-discount' },
                { type: 'cart-shipping' },
              ],
              right: [{ type: 'cart-summary' }],
            },
          },
        ],
      };
      const { container } = renderWithIntl(
        <CartPageView themeName="default" cartTemplate={cartTemplate} />,
        'en',
      );
      // The wire template's container class is present; the bundled default's is NOT.
      expect(container.querySelector('div.wire-cart-grid')).not.toBeNull();
      expect(container.querySelector('div.grid.gap-8.lg\\:grid-cols-\\[1fr_20rem\\]')).toBeNull();
      // The granular cart sections still render through the wire template.
      expect(screen.getByTestId('cart-line-item')).toBeInTheDocument();
      expect(screen.getByTestId('discount-form')).toBeInTheDocument();
    });

    it('no cartTemplate → the bundled cart template renders (parity)', () => {
      const { container } = renderWithIntl(<CartPageView themeName="default" />, 'en');
      expect(
        container.querySelector('div.grid.gap-8.lg\\:grid-cols-\\[1fr_20rem\\]'),
      ).not.toBeNull();
      expect(screen.getByTestId('cart-line-item')).toBeInTheDocument();
    });

    it('keeps the empty-state branch even when a wire cart template is provided', () => {
      cart = makeCart([]);
      const cartTemplate = {
        page: 'cart' as const,
        sections: [{ type: 'cart-line-items' }],
      };
      renderWithIntl(<CartPageView themeName="default" cartTemplate={cartTemplate} />, 'en');
      // The empty-state short-circuits BEFORE the template renders — unchanged behaviour.
      expect(screen.getByTestId('cart-empty')).toBeInTheDocument();
      expect(screen.queryByTestId('cart-line-item')).toBeNull();
    });

    it('falls back to the bundled cart when the wire cartTemplate is invalid (re-validated, no throw)', () => {
      // A structurally invalid wire template (bad `page`) must fail the client re-validation and fall
      // back to the bundled default, never throws.
      const invalid = {
        page: 'NOT_A_PAGE',
        sections: [{ type: 'cart-line-items' }],
      } as unknown as ThemeTemplate;
      const { container } = renderWithIntl(
        <CartPageView themeName="default" cartTemplate={invalid} />,
        'en',
      );
      // Bundled default container rendered (the invalid wire template was dropped).
      expect(
        container.querySelector('div.grid.gap-8.lg\\:grid-cols-\\[1fr_20rem\\]'),
      ).not.toBeNull();
      expect(screen.getByTestId('cart-line-item')).toBeInTheDocument();
    });

    it('skips an unknown section type in a wire cart template, rendering the known ones', () => {
      // A wire cart template naming a section type this storefront build lacks must skip it gracefully,
      // still rendering the known cart sections.
      const cartTemplate = {
        page: 'cart' as const,
        sections: [
          { type: 'cart-line-items' },
          { type: 'section-this-build-lacks' },
          { type: 'cart-summary' },
        ],
      };
      renderWithIntl(<CartPageView themeName="default" cartTemplate={cartTemplate} />, 'en');
      // The two known sections render; the unknown one contributed nothing (no throw).
      expect(screen.getByTestId('cart-line-item')).toBeInTheDocument();
      expect(screen.getByTestId('grand-total')).toBeInTheDocument();
    });
  });
});
