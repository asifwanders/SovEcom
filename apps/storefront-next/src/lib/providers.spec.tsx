import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

/**
 * providers-wrapper wiring. We mock the two real providers so we can assert the
 * NESTING (AuthProvider outside CartProvider) and that the cart receives the LIVE `getAccessToken`
 * getter sourced from the auth context.
 */
const stableGetter = () => 'tok-from-auth';

vi.mock('./auth-context', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="auth-provider">{children}</div>
  ),
  // The bridge reads useAuth() → returns the stable getter we then assert lands on the cart.
  useAuth: () => ({ getAccessToken: stableGetter }),
}));

const cartGetAccessToken = vi.fn();
vi.mock('./cart-context', () => ({
  CartProvider: ({
    children,
    getAccessToken,
  }: {
    children: React.ReactNode;
    getAccessToken?: () => string | null;
  }) => {
    cartGetAccessToken(getAccessToken);
    return <div data-testid="cart-provider">{children}</div>;
  },
}));

// providers also mount the drawer open-state provider + the drawer itself. Mock both so this
// spec stays focused on the auth→cart nesting + the getAccessToken seam (the drawer has its own specs).
vi.mock('./cart-ui-context', () => ({
  CartUiProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="cart-ui-provider">{children}</div>
  ),
}));
vi.mock('@/components/cart/CartDrawer', () => ({
  CartDrawer: () => <div data-testid="cart-drawer" />,
}));

import { StorefrontProviders } from './providers';

beforeEach(() => {
  cartGetAccessToken.mockReset();
});

describe('StorefrontProviders', () => {
  it('renders its children (a client boundary wrapping RSC children)', () => {
    render(
      <StorefrontProviders>
        <span data-testid="child">hi</span>
      </StorefrontProviders>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('nests AuthProvider OUTSIDE CartProvider', () => {
    render(
      <StorefrontProviders>
        <span>hi</span>
      </StorefrontProviders>,
    );
    const auth = screen.getByTestId('auth-provider');
    const cart = screen.getByTestId('cart-provider');
    expect(auth).toContainElement(cart);
  });

  it('passes the auth `getAccessToken` getter into CartProvider', () => {
    render(
      <StorefrontProviders>
        <span>hi</span>
      </StorefrontProviders>,
    );
    expect(cartGetAccessToken).toHaveBeenCalledWith(stableGetter);
    // And the getter actually resolves the auth token (the live seam).
    const passed = cartGetAccessToken.mock.calls[0]![0] as () => string;
    expect(passed()).toBe('tok-from-auth');
  });
});
