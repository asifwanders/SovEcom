/**
 * `(auth)` route-group layout. A centered, narrow shell for
 * the checkout-critical auth pages (login/register). RSC + locale-aware (no client logic here — the
 * forms are the client islands). Logical CSS (`mx-auto`, no left/right) keeps it RTL-ready.
 */
import type { ReactNode } from 'react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-md px-4 py-12">{children}</div>;
}
