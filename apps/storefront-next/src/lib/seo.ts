/**
 * SEO / JSON-LD building blocks.
 *
 * This module is the pure, testable core of the structured-data + per-route metadata work:
 *   - site-origin + absolute/localized URL helpers (canonical + hreflang alternates), and
 *   - typed JSON-LD builders (`schema-dts`) for Product/Offer/BreadcrumbList/Organization/WebSite.
 *
 * Money rule: a JSON-LD `price`/`lowPrice`/`highPrice` is a DECIMAL-MAJOR STRING (schema.org), derived
 * from integer MINOR units via the SAME currency-exponent logic as `formatPrice` — never a hardcoded
 * /100, never a float. No fetch and no React here — `StructuredData.tsx` renders the objects these
 * builders return, and the route `generateMetadata` functions consume the URL helpers.
 */
import type {
  WithContext,
  Product,
  Offer,
  AggregateOffer,
  BreadcrumbList,
  ListItem,
  ItemAvailability,
  Organization,
  WebSite,
} from 'schema-dts';
import { minorToMajor, currencyFractionDigits } from './api';
import { routing, type Locale } from '@/i18n/routing';
import type { ProductDetailView, ProductVariantView } from './catalog';
import type { BreadcrumbItem } from '@/components/Breadcrumbs';

/** Dev fallback origin — the storefront runs on :3001 (see package.json `dev`/`start`). */
const DEFAULT_SITE_ORIGIN = 'http://localhost:3001';

/**
 * Resolve the public site origin from the env (`NEXT_PUBLIC_SITE_URL`), trailing-slash-trimmed, so
 * canonical/OG/sitemap URLs are absolute. Falls back to the localhost dev origin when unset, so a
 * build with no env still produces (dev-correct) absolute URLs rather than crashing. The arg is
 * injectable for tests; production callers pass `process.env`.
 */
export function siteOrigin(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  const raw = env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!raw) return DEFAULT_SITE_ORIGIN;
  return raw.replace(/\/+$/, '');
}

/** Join an origin and a (possibly slash-less) root-relative path into one absolute URL. */
export function absoluteUrl(origin: string, path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${origin}${p}`;
}

/**
 * Build the locale-prefixed root-relative path for `localePrefix: 'always'` (every public URL is
 * `/{locale}/...`). The bare home path collapses to just `/{locale}` (no trailing slash) so the
 * canonical home URL matches what the middleware serves.
 */
export function localizedPath(locale: string, path: string): string {
  const trimmed = path.replace(/^\/+/, '');
  return trimmed === '' || trimmed === '/' ? `/${locale}` : `/${locale}/${trimmed}`;
}

/**
 * Absolute alternate URLs for every supported locale, keyed by locale code — feeds
 * `alternates.languages` (hreflang). The same logical `path` resolves per-locale.
 */
export function localePathAlternates(origin: string, path: string): Record<Locale, string> {
  const out = {} as Record<Locale, string>;
  for (const locale of routing.locales) {
    out[locale] = absoluteUrl(origin, localizedPath(locale, path));
  }
  return out;
}

/**
 * Format an integer MINOR-unit amount as the DECIMAL-MAJOR STRING schema.org wants for a price,
 * exponent-correct per currency (EUR 1999→"19.99", JPY 1000→"1000", KWD 1234→"1.234"). Reuses the
 * `minorToMajor` currency math — never hardcodes /100. Trailing zeros are preserved via `toFixed`.
 */
export function jsonLdPriceString(amountMinor: number, currency: string): string {
  const major = minorToMajor(amountMinor, currency);
  // Take the exponent straight from the currency's Intl minor-unit scale (the same source
  // `formatPrice` uses) so it is correct even at zero — JPY 0→"0", KWD 0→"0.000", EUR 0→"0.00".
  return major.toFixed(currencyFractionDigits(currency));
}

/** Map a coarse availability boolean to the schema.org ItemAvailability URL. */
export function schemaAvailability(available: boolean): ItemAvailability {
  return available ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock';
}

/**
 * Build a `BreadcrumbList` from the SAME `{ label, href }[]` trail the `Breadcrumbs` component renders.
 * Positions are 1-based; each `item` is the absolute, locale-prefixed URL of the crumb. The caller
 * passes the trail INCLUDING the Home root (the component prepends it for display).
 */
export function buildBreadcrumbJsonLd(
  origin: string,
  locale: string,
  trail: BreadcrumbItem[],
): WithContext<BreadcrumbList> {
  const itemListElement: ListItem[] = trail.map((crumb, idx) => ({
    '@type': 'ListItem',
    position: idx + 1,
    name: crumb.label,
    item: absoluteUrl(origin, localizedPath(locale, crumb.href)),
  }));
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement,
  };
}

/** Lowest- and highest-priced variant + an "any in stock" flag, in ONE pass. Requires ≥1 variant. */
function priceSpan(variants: [ProductVariantView, ...ProductVariantView[]]): {
  low: ProductVariantView;
  high: ProductVariantView;
  anyAvailable: boolean;
} {
  let low = variants[0];
  let high = variants[0];
  let anyAvailable = false;
  for (const v of variants) {
    if (v.priceAmount < low.priceAmount) low = v;
    if (v.priceAmount > high.priceAmount) high = v;
    if (v.availability) anyAvailable = true;
  }
  return { low, high, anyAvailable };
}

/**
 * Build the `Product` (+ `Offer`/`AggregateOffer`) JSON-LD for a PDP. `priceCurrency` is the
 * product's OWN per-variant currency (never a filter default). A single variant emits a plain
 * `Offer`; multiple variants emit an `AggregateOffer` with low/high price + offerCount. When prices
 * span a range but all share one currency we still use `AggregateOffer`; mixed currencies are
 * collapsed to the lowest variant's currency (catalog products are single-currency in practice).
 * A product with no variants emits NO offers (nothing priceable).
 */
export function buildProductJsonLd(product: ProductDetailView, url: string): WithContext<Product> {
  const image = product.images.map((img) => img.thumbnailUrl).filter((u): u is string => !!u);

  const ld: WithContext<Product> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.title,
    ...(product.description ? { description: product.description } : {}),
    ...(image.length > 0 ? { image } : {}),
  };

  const variants = product.variants;
  if (variants.length === 0) return ld;
  // Safe: length checked above — narrow to a non-empty tuple for `priceSpan`.
  const nonEmpty = variants as [ProductVariantView, ...ProductVariantView[]];

  const { low, high, anyAvailable } = priceSpan(nonEmpty);
  const availability = schemaAvailability(anyAvailable);

  if (variants.length === 1) {
    const offer: Offer = {
      '@type': 'Offer',
      url,
      price: jsonLdPriceString(low.priceAmount, low.currency),
      priceCurrency: low.currency,
      availability,
    };
    ld.offers = offer;
    return ld;
  }

  const aggregate: AggregateOffer = {
    '@type': 'AggregateOffer',
    url,
    // An AggregateOffer declares ONE priceCurrency — format both bounds in it so low/high are internally consistent.
    priceCurrency: low.currency,
    lowPrice: jsonLdPriceString(low.priceAmount, low.currency),
    highPrice: jsonLdPriceString(high.priceAmount, low.currency),
    offerCount: variants.length,
    availability,
  };
  ld.offers = aggregate;
  return ld;
}

/** Resolve a logo URL (absolute or root-relative) against the origin, or omit when absent. */
function resolveLogo(origin: string, logoUrl: string | undefined): string | undefined {
  if (!logoUrl) return undefined;
  if (/^https?:\/\//i.test(logoUrl)) return logoUrl;
  return absoluteUrl(origin, logoUrl);
}

/** Site-wide `Organization` JSON-LD (brand name, site url, absolute logo when present). */
export function buildOrganizationJsonLd(
  origin: string,
  name: string,
  logoUrl: string | undefined,
): WithContext<Organization> {
  const logo = resolveLogo(origin, logoUrl);
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name,
    url: origin,
    ...(logo ? { logo } : {}),
  };
}

/** Site-wide `WebSite` JSON-LD (brand name + site url). */
export function buildWebSiteJsonLd(origin: string, name: string): WithContext<WebSite> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name,
    url: origin,
  };
}
