'use client';

/**
 * client providers wrapper.
 *
 * Nests the transactional-storefront client contexts so the auth pages (this chunk) and the later
 * cart/checkout chunks (C–F) can consume them: `AuthProvider` → `CartProvider`. The cart needs a LIVE
 * access-token getter so a logged-in customer's Bearer rides on cart mutations — but `getAccessToken`
 * is only available from inside the auth context. `CartBridge` reads `useAuth()` (so it sits UNDER
 * `AuthProvider`) and hands the STABLE `getAccessToken` getter to `CartProvider`. The getter is stable
 * across renders (a `useCallback` over a ref in auth-context), so the cart's one-time client build sees
 * tokens minted by a later silent refresh without re-instantiating.
 *
 * This is a CLIENT boundary (`'use client'`) that simply renders `children` — the existing RSC catalog
 * pages remain server components and stream through unchanged (a client component can wrap server
 * children; the children are passed as already-rendered React nodes, not re-rendered on the client).
 */
import React from 'react';
import { AuthProvider, useAuth } from './auth-context';
import { CartProvider } from './cart-context';
import { CartUiProvider } from './cart-ui-context';
import { CartDrawer } from '@/components/cart/CartDrawer';

function CartBridge({ children }: { children: React.ReactNode }): React.ReactElement {
  const { getAccessToken } = useAuth();
  return <CartProvider getAccessToken={getAccessToken}>{children}</CartProvider>;
}

export function StorefrontProviders({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <AuthProvider>
      <CartBridge>
        {/* CartUiProvider holds the drawer open-state. The drawer is mounted ONCE here so any
            page's header trigger opens the same panel; it renders nothing until opened. */}
        <CartUiProvider>
          {children}
          <CartDrawer />
        </CartUiProvider>
      </CartBridge>
    </AuthProvider>
  );
}
