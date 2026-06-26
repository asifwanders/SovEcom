'use client';

/**
 * Cart page body wrapper. The client island for `/cart`: the cart is per-session client state (
 * Client-side only, no SSR), so the RSC route is a thin localized shell and this renders the
 * live cart from `useCart()`.
 *
 * The NON-EMPTY body lives in the `columns` CLIENT layout placing the granular cart sections
 * (`cart-line-items`, `cart-discount`, `cart-shipping` on the left; `cart-summary` on the right),
 * composed here via the cart template (`renderClientSections` over `cartSectionRegistry`) — net DOM is
 * identical to the prior inline body. THIS wrapper keeps the two page-level concerns: the refresh-on-mount
 * effect and the empty-state branch (verbatim). MONEY-CRITICAL figures all come from `cart.totals` inside
 * the sections — this wrapper does no money arithmetic.
 *
 * On first mount it calls `useCart().refresh()` once so a deep-link or reload re-reads the authoritative
 * cart (the context starts empty on a fresh client; the httpOnly `sov_cart` cookie identifies it).
 */
import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { parseTemplate, type ThemeTemplate } from '@sovecom/theme-sdk';
import { Link } from '@/i18n/navigation';
import { useCart } from '@/lib/cart-context';
import { renderClientSections } from '@/lib/sections/renderClientSections';
import { cartSectionRegistry } from '@/lib/sections/cart-registry';
import { resolveTemplateSet } from '@/themes';

/**
 * DEFENSIVELY re-validate a wire `cart` template at render (defense in depth). The server
 * already validated it in `fetchActiveTheme`, but `renderClientSections` does NO parsing — so,
 * re-parse here through theme-sdk's pure SYNC `parseTemplate` and return `undefined` on ANY failure, so
 * a malformed wire cart template falls back to the bundled set instead of reaching the client renderer.
 */
function revalidateCartTemplate(template: ThemeTemplate | undefined): ThemeTemplate | undefined {
  if (!template) return undefined;
  try {
    return parseTemplate(JSON.stringify(template));
  } catch {
    return undefined;
  }
}

/**
 * @param themeName The ACTIVE theme name, resolved in the RSC cart shell (`cart/page.tsx`) via the
 * shared `resolveActiveThemeName` and passed down — so the cart body honours the active theme's `cart`
 * template (default → default cart; boutique → boutique cart.json). Absent → the default set.
 * @param cartTemplate The active theme's WIRE-delivered `cart` template — already defensively
 * validated in `fetchActiveTheme` (a trusted `ThemeTemplate`, a plain serializable object safe to pass
 * RSC→client). When present it WINS over the bundled `resolveTemplateSet(name).cart`; absent → the
 * bundled cart template. Unknown section types are skipped by the renderer.
 */
export function CartPageView({
  themeName,
  cartTemplate,
}: { themeName?: string; cartTemplate?: ThemeTemplate } = {}): React.ReactElement {
  const t = useTranslations('cart');
  const { cart, refresh } = useCart();

  // Re-read the authoritative cart once on mount (a reload/deep-link starts with empty context state).
  const refreshedRef = useRef(false);
  useEffect(() => {
    if (refreshedRef.current) return;
    refreshedRef.current = true;
    void refresh().catch(() => {
      // A failed refresh just leaves the empty state; the user can retry by re-adding/navigating.
    });
  }, [refresh]);

  const items = cart?.items ?? [];

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center" data-testid="cart-empty">
        <p className="text-base text-muted-foreground">{t('page.empty')}</p>
        <Link href="/products" className="text-sm font-medium text-primary underline">
          {t('page.continueShopping')}
        </Link>
      </div>
    );
  }

  // Compose the non-empty body from the ACTIVE theme's `cart` template (the `columns` layout + the
  // granular cart sections). Precedence: the WIRE-delivered `cartTemplate` — RE-VALIDATED
  // here (defense in depth, ) — wins; else the bundled `resolveTemplateSet(name).
  // cart`. `themeName` comes from the RSC shell (resolved via the shared `resolveActiveThemeName`);
  // `resolveTemplateSet` falls back to the always-present `default` set for an absent/unknown name, so
  // the default theme (no wire template) renders identical DOM  . Unknown types are skipped.
  const template = revalidateCartTemplate(cartTemplate) ?? resolveTemplateSet(themeName).cart;
  return <>{template ? renderClientSections({ template, registry: cartSectionRegistry }) : null}</>;
}
