import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import type { CartView } from '@/lib/cart-types';

// Locale-aware Link → plain anchor (mirror Header/CartBadge spec convention); preserve onClick.
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <a href={typeof href === 'string' ? href : '#'} onClick={onClick} {...rest}>
      {children}
    </a>
  ),
}));

// Drawer open-state.
let isOpen = false;
const close = vi.fn();
vi.mock('@/lib/cart-ui-context', () => ({
  useCartUi: () => ({ isOpen, close, open: vi.fn() }),
}));

// Cart data (line items + server-authoritative totals).
let cart: CartView | null = null;
vi.mock('@/lib/cart-context', () => ({
  useCart: () => ({
    cart,
    updateItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { CartDrawer } from './CartDrawer';

function makeCart(items: CartView['items']): CartView {
  const subtotal = 1999;
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
      subtotal,
      shipping: 0,
      discountTotal: 0,
      taxTotal: 0,
      grandTotal: subtotal,
      currency: 'EUR',
      reverseCharge: false,
    },
  };
}

const oneItem = makeCart([
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
]);

beforeEach(() => {
  isOpen = false;
  cart = oneItem;
  close.mockReset();
});

describe('CartDrawer', () => {
  it('renders nothing when closed', () => {
    isOpen = false;
    const { container } = renderWithIntl(<CartDrawer />, 'en');
    expect(container).toBeEmptyDOMElement();
  });

  it('is an accessible modal dialog when open (role=dialog, aria-modal, labelledby)', () => {
    isOpen = true;
    renderWithIntl(<CartDrawer />, 'en');
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // The heading is the accessible name.
    expect(dialog).toHaveAccessibleName(/your cart/i);
  });

  it('lists line items and the server subtotal (no client money math)', () => {
    isOpen = true;
    renderWithIntl(<CartDrawer />, 'en');
    expect(screen.getByTestId('cart-line-item')).toBeInTheDocument();
    // Compact totals show the server subtotal (€19.99) only.
    expect(screen.getByTestId('subtotal')).toHaveTextContent(/€19\.99/);
  });

  it('Esc closes the drawer', () => {
    isOpen = true;
    renderWithIntl(<CartDrawer />, 'en');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('clicking the backdrop closes the drawer', () => {
    isOpen = true;
    renderWithIntl(<CartDrawer />, 'en');
    fireEvent.click(screen.getByTestId('cart-drawer-backdrop'));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('the close button closes the drawer', () => {
    isOpen = true;
    renderWithIntl(<CartDrawer />, 'en');
    fireEvent.click(screen.getByRole('button', { name: /close cart/i }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('moves focus into the panel on open', () => {
    isOpen = true;
    renderWithIntl(<CartDrawer />, 'en');
    // The panel itself (tabIndex -1) receives focus on open.
    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('locks body scroll while open and restores it on close (unmount)', () => {
    isOpen = true;
    const { unmount } = renderWithIntl(<CartDrawer />, 'en');
    expect(document.body.style.overflow).toBe('hidden');
    // Unmount = the drawer closes → the open-effect cleanup restores the prior overflow.
    unmount();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('returns focus to the trigger when it closes', () => {
    // A real trigger element that holds focus BEFORE the drawer opens.
    const trigger = document.createElement('button');
    trigger.textContent = 'cart trigger';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(trigger).toHaveFocus();

    isOpen = true;
    const { unmount } = renderWithIntl(<CartDrawer />, 'en');
    // Focus moved into the panel on open.
    expect(screen.getByRole('dialog')).toHaveFocus();

    // Closing (unmount) runs the open-effect cleanup, which restores focus to the trigger.
    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it('traps focus within the panel on Tab / Shift+Tab — pulls focus back from OUTSIDE and wraps at the boundaries', () => {
    // jsdom has no layout engine, so `el.offsetParent` is ALWAYS null — which would empty the trap's
    // focusable set (it filters by `offsetParent !== null`) and make any assertion vacuous (a removed
    // handler would still "pass" because focus never moves natively). To exercise the REAL trap we make
    // connected elements report a non-null offsetParent for the duration of this test, so the handler
    // sees the panel's actual focusables (close button, CTAs, line-item controls) and can wrap them.
    const offsetParentSpy = vi
      .spyOn(HTMLElement.prototype, 'offsetParent', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.isConnected ? document.body : null;
      });

    try {
      isOpen = true;
      renderWithIntl(<CartDrawer />, 'en');
      const dialog = screen.getByRole('dialog');

      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);
      // Sanity: with offsetParent stubbed, the trap now sees real controls (not just the panel).
      expect(focusables.length).toBeGreaterThan(1);
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;

      // (a) Forward Tab from the LAST focusable wraps to the FIRST.
      last.focus();
      expect(last).toHaveFocus();
      fireEvent.keyDown(dialog, { key: 'Tab' });
      expect(first).toHaveFocus();

      // (b) Shift+Tab from the FIRST focusable wraps to the LAST.
      first.focus();
      expect(first).toHaveFocus();
      fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
      expect(last).toHaveFocus();

      // (c) Focus genuinely escaped OUTSIDE the dialog → a boundary Tab pulls it back inside. (This is
      //     the assertion that FAILS if the trap handler is removed: native keydown moves nothing, so
      //     without the handler focus would stay on `outside`.)
      const outside = document.createElement('button');
      outside.textContent = 'outside';
      document.body.appendChild(outside);
      outside.focus();
      expect(dialog.contains(document.activeElement)).toBe(false);
      // Put focus on the trailing boundary, then Tab — the handler must redirect into the panel.
      last.focus();
      fireEvent.keyDown(dialog, { key: 'Tab' });
      expect(dialog.contains(document.activeElement)).toBe(true);
      outside.remove();
    } finally {
      offsetParentSpy.mockRestore();
    }
  });

  it('the CTAs link to /cart (View cart) and /checkout (Checkout)', () => {
    isOpen = true;
    renderWithIntl(<CartDrawer />, 'en');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('link', { name: /view cart/i })).toHaveAttribute(
      'href',
      '/cart',
    );
    // Locale-aware Link → the mocked next-intl Link passes the unprefixed href through; next-intl adds
    // the active locale prefix at runtime (asserted as `/checkout`, consistent with the other links).
    expect(within(dialog).getByRole('link', { name: /checkout/i })).toHaveAttribute(
      'href',
      '/checkout',
    );
  });

  it('"View cart" closes the drawer before navigating', () => {
    isOpen = true;
    renderWithIntl(<CartDrawer />, 'en');
    fireEvent.click(screen.getByRole('link', { name: /view cart/i }));
    expect(close).toHaveBeenCalled();
  });

  it('shows the empty state when the cart has no items', () => {
    isOpen = true;
    cart = makeCart([]);
    renderWithIntl(<CartDrawer />, 'en');
    expect(screen.getByText(/your cart is empty/i)).toBeInTheDocument();
    // No checkout CTA on an empty cart.
    expect(screen.queryByRole('link', { name: /checkout/i })).toBeNull();
  });

  it('localizes the dialog title in French', () => {
    isOpen = true;
    renderWithIntl(<CartDrawer />, 'fr');
    expect(screen.getByRole('dialog')).toHaveAccessibleName(/votre panier/i);
  });
});
