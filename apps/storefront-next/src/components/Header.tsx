/**
 * Storefront header. Server component (RSC): fetches the category tree server-side (`fetchCategoryTree()`)
 * and passes it as props into the client `CategoryNav`. Nav labels are localized via the `header`
 * namespace and links use next-intl's locale-aware `Link`. The header carries the logo, CategoryNav,
 * and flat navigation links.
 *
 * RTL-ready: no hard-coded left/right; flex gap and logical spacing only.
 */
import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { fetchCategoryTree } from '@/lib/catalog';
import {
  type HeaderLayout,
  type CartAffordance,
  DEFAULT_HEADER_LAYOUT,
  DEFAULT_CART_AFFORDANCE,
} from '@/lib/chrome-variants';
import { CategoryNav } from './CategoryNav';
import { SearchBar } from './SearchBar';
import { CartBadge } from './cart/CartBadge';
import { AccountLink } from './account/AccountLink';

/**
 * The header chrome. Accepts chrome-variant props that the layout resolves from the active theme's
 * effective settings: `headerLayout` (`simple` flat nav vs `mega` multi-column dropdown) and
 * `cartAffordance` (`drawer` vs `page-link`). Both default to the standard behaviour.
 */
export async function Header({
  logoUrl,
  headerLayout = DEFAULT_HEADER_LAYOUT,
  cartAffordance = DEFAULT_CART_AFFORDANCE,
}: {
  logoUrl?: string;
  headerLayout?: HeaderLayout;
  cartAffordance?: CartAffordance;
}) {
  const t = await getTranslations('header');
  const locale = await getLocale();
  // Server-fetch the tree once; pass it into the client CategoryNav as props (no client fetch).
  const categories = await fetchCategoryTree();

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-card/80 backdrop-blur">
      <div className="mx-auto max-w-6xl px-4 h-14 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CategoryNav categories={categories} layout={headerLayout} />
          <Link
            href="/"
            className="flex items-center gap-2 text-xl font-bold text-primary tracking-tight"
          >
            {logoUrl ? (
              // Plain <img>: the logo is a tenant-supplied absolute URL (not a build-time asset) and
              // next/image is configured `unoptimized`, so there is nothing for it to optimise.
              <img
                src={logoUrl}
                alt={t('brand')}
                width={112}
                height={28}
                className="h-7 w-auto"
                loading="lazy"
                decoding="async"
              />
            ) : null}
            {t('brand')}
          </Link>
        </div>
        {/* Instant-search island (client) — sits between the logo cluster and the right nav. */}
        <div className="hidden flex-1 justify-center px-4 sm:flex">
          <SearchBar locale={locale} />
        </div>
        <nav className="flex items-center gap-4 text-sm font-medium sm:gap-6">
          {/* Mobile responsive layout: on narrow viewports, PRODUCTS and CATEGORIES are hidden to prevent
              overflow and overlap. Both remain reachable via the CategoryNav drawer, which lists the
              full catalog tree. SEARCH stays visible at all widths since it is the only mobile search
              entry point and the inline SearchBar is hidden on mobile. CartBadge is always visible so
              the cart is one tap away. Hidden links stay in the DOM for screen reader users. */}
          <Link
            href="/products"
            className="hidden text-foreground transition-colors hover:text-primary sm:inline-flex"
          >
            {t('products')}
          </Link>
          <Link
            href="/category"
            className="hidden text-foreground transition-colors hover:text-primary sm:inline-flex"
          >
            {t('categories')}
          </Link>
          <Link href="/search" className="text-foreground transition-colors hover:text-primary">
            {t('search')}
          </Link>
          {/* Account affordance — client island; links to the account area when signed in, else to
              sign-in. Renders nothing until the session resolves. */}
          <AccountLink />
          {/* Cart badge — client island; displays live item-count. The `affordance` prop selects the
              drawer (default) vs a page-link to /cart. Always visible, even on mobile, for reliable
              access. */}
          <CartBadge affordance={cartAffordance} />
        </nav>
      </div>
    </header>
  );
}
