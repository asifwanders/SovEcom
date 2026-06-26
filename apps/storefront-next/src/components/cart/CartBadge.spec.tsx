import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { renderWithIntl } from '@/test-intl';
import en from '../../../messages/en.json';

// Drive useCart().itemCount per test.
let itemCount = 0;
vi.mock('@/lib/cart-context', () => ({
  useCart: () => ({ itemCount }),
}));

// Drive + assert the drawer-open trigger (the cart icon opens the drawer, no longer a link).
const open = vi.fn();
let isOpen = false;
vi.mock('@/lib/cart-ui-context', () => ({
  useCartUi: () => ({ open, isOpen }),
}));

// Locale-aware Link → plain anchor so the page-link affordance is assertable.
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

import { CartBadge } from './CartBadge';

beforeEach(() => {
  itemCount = 0;
  isOpen = false;
  open.mockReset();
});

describe('CartBadge', () => {
  it('is a button that opens the cart drawer (no longer a link)', () => {
    itemCount = 2;
    renderWithIntl(<CartBadge />, 'en');
    const button = screen.getByRole('button', { name: /cart, 2 items/i });
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    // Not a link anymore — opening an in-page dialog is button semantics.
    expect(screen.queryByRole('link')).toBeNull();
    fireEvent.click(button);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('reflects the drawer open-state via aria-expanded (collapsed when closed, expanded when open)', () => {
    isOpen = false;
    const { unmount } = renderWithIntl(<CartBadge />, 'en');
    expect(screen.getByRole('button', { name: /cart/i })).toHaveAttribute('aria-expanded', 'false');
    unmount();
    // Re-render with the drawer open → aria-expanded flips to true.
    isOpen = true;
    renderWithIntl(<CartBadge />, 'en');
    expect(screen.getByRole('button', { name: /cart/i })).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows the item count and an accessible label including the count', () => {
    itemCount = 3;
    renderWithIntl(<CartBadge />, 'en');
    const button = screen.getByRole('button', { name: /cart, 3 items/i });
    expect(button).toBeInTheDocument();
    // The visible numeric badge.
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('singular vs plural in the accessible label', () => {
    itemCount = 1;
    renderWithIntl(<CartBadge />, 'en');
    expect(screen.getByRole('button', { name: /cart, 1 item$/i })).toBeInTheDocument();
  });

  it('empty cart: no numeric badge, accessible empty label', () => {
    itemCount = 0;
    renderWithIntl(<CartBadge />, 'en');
    // The accessible label still describes the (empty) cart.
    expect(screen.getByRole('button', { name: /cart/i })).toBeInTheDocument();
    // No count pill rendered at zero.
    expect(screen.queryByText('0')).toBeNull();
  });

  it('updates live as the cart changes (re-render reflects new itemCount)', () => {
    itemCount = 1;
    const { rerender } = renderWithIntl(<CartBadge />, 'en');
    expect(screen.getByText('1')).toBeInTheDocument();
    itemCount = 5;
    rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <CartBadge />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('localizes the accessible label in French', () => {
    itemCount = 2;
    renderWithIntl(<CartBadge />, 'fr');
    expect(screen.getByRole('button', { name: /panier, 2 articles/i })).toBeInTheDocument();
  });

  // ── Affordance chrome variant ────────────────────────────────────────────────────────────────────
  describe('affordance variant', () => {
    it('default (no affordance) is the drawer-opening BUTTON (parity)', () => {
      itemCount = 1;
      renderWithIntl(<CartBadge />, 'en');
      const button = screen.getByRole('button', { name: /cart, 1 item/i });
      expect(button).toHaveAttribute('aria-haspopup', 'dialog');
      expect(screen.queryByRole('link')).toBeNull();
    });

    it('affordance="drawer" is the drawer-opening button (explicit)', () => {
      itemCount = 2;
      renderWithIntl(<CartBadge affordance="drawer" />, 'en');
      const button = screen.getByRole('button', { name: /cart, 2 items/i });
      expect(button).toHaveAttribute('aria-haspopup', 'dialog');
      fireEvent.click(button);
      expect(open).toHaveBeenCalledTimes(1);
    });

    it('affordance="page-link" is a plain LINK to /cart (no drawer, no dialog aria)', () => {
      itemCount = 3;
      renderWithIntl(<CartBadge affordance="page-link" />, 'en');
      const link = screen.getByRole('link', { name: /cart, 3 items/i });
      expect(link).toHaveAttribute('href', '/cart');
      expect(link).not.toHaveAttribute('aria-haspopup');
      // No button affordance; clicking does NOT open the drawer.
      expect(screen.queryByRole('button')).toBeNull();
      fireEvent.click(link);
      expect(open).not.toHaveBeenCalled();
    });

    it('page-link still shows the count pill + count-bearing accessible name', () => {
      itemCount = 4;
      renderWithIntl(<CartBadge affordance="page-link" />, 'en');
      expect(screen.getByText('4')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /cart, 4 items/i })).toBeInTheDocument();
    });
  });
});
