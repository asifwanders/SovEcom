'use client';

/**
 * cart-DRAWER open-state context. A small, client-only UI context kept separate from the cart data layer.
 *
 * Design choice: the drawer open/closed flag is a TINY, client-only UI context kept SEPARATE from the
 * money-critical `cart-context`. Rationale — the cart context is the server-authoritative data layer
 * (StrictMode-safe refs, serialized mutations, no client money math); a transient "is the panel open"
 * boolean has nothing to do with cart data and must never risk that surface. Splitting it keeps the
 * cart context untouched, lets the header trigger (`CartBadge`) and the panel (`CartDrawer`) share one
 * flag, and is trivially testable in isolation.
 *
 * The provider mounts inside `StorefrontProviders` (under the cart/auth providers) so any client island
 * — the header badge and the drawer — can open/close it. It holds nothing but a boolean.
 */
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

export interface CartUiContextValue {
  /** Whether the cart drawer is open. */
  isOpen: boolean;
  /** Open the cart drawer (header cart icon). */
  open: () => void;
  /** Close the cart drawer (Esc, backdrop, close button, "View cart" navigation). */
  close: () => void;
}

const CartUiContext = createContext<CartUiContextValue | null>(null);

export function CartUiProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const value = useMemo<CartUiContextValue>(() => ({ isOpen, open, close }), [isOpen, open, close]);
  return <CartUiContext.Provider value={value}>{children}</CartUiContext.Provider>;
}

/** Consume the cart-UI (drawer) context. Throws if used outside `<CartUiProvider>` (a wiring bug). */
export function useCartUi(): CartUiContextValue {
  const ctx = useContext(CartUiContext);
  if (ctx === null) {
    throw new Error('useCartUi must be used within a <CartUiProvider>');
  }
  return ctx;
}
