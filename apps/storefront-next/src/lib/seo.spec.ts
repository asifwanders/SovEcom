/**
 * SEO / JSON-LD pure-builder tests.
 *
 * These are the testable core of the structured-data + metadata work: pure functions that take
 * catalog view-types + a resolved site origin and return typed JSON-LD objects / absolute URLs.
 * No fetch, no React — just shape + money-exponent + URL correctness.
 */
import { describe, it, expect } from 'vitest';
import {
  siteOrigin,
  absoluteUrl,
  localizedPath,
  localePathAlternates,
  jsonLdPriceString,
  schemaAvailability,
  buildBreadcrumbJsonLd,
  buildProductJsonLd,
  buildOrganizationJsonLd,
  buildWebSiteJsonLd,
} from './seo';
import type { ProductDetailView } from './catalog';

/**
 * `schema-dts` types each property as a deep discriminated union, so a built JSON-LD object can't be
 * indexed by a plain key in TS. The builders are typed at construction; here we read them back as a
 * plain record for assertion (the runtime value is exactly what was built).
 */
const obj = (x: unknown): Record<string, unknown> => x as Record<string, unknown>;

describe('siteOrigin', () => {
  it('reads NEXT_PUBLIC_SITE_URL and strips a trailing slash', () => {
    expect(siteOrigin({ NEXT_PUBLIC_SITE_URL: 'https://shop.example/' })).toBe(
      'https://shop.example',
    );
  });

  it('falls back to the localhost dev origin when unset', () => {
    expect(siteOrigin({})).toBe('http://localhost:3001');
  });
});

describe('absoluteUrl', () => {
  it('joins the origin and a root-relative path without doubling the slash', () => {
    expect(absoluteUrl('https://shop.example', '/en/products')).toBe(
      'https://shop.example/en/products',
    );
  });

  it('normalizes a path missing its leading slash', () => {
    expect(absoluteUrl('https://shop.example', 'en/products')).toBe(
      'https://shop.example/en/products',
    );
  });
});

describe('localizedPath', () => {
  it('prefixes the locale (localePrefix=always) and normalizes the path', () => {
    expect(localizedPath('en', '/products')).toBe('/en/products');
    expect(localizedPath('fr', 'products')).toBe('/fr/products');
  });

  it('maps the bare home path to just the locale root', () => {
    expect(localizedPath('en', '/')).toBe('/en');
    expect(localizedPath('fr', '')).toBe('/fr');
  });
});

describe('localePathAlternates', () => {
  it('returns an absolute URL per locale keyed by locale code', () => {
    const alt = localePathAlternates('https://shop.example', '/products');
    expect(alt).toEqual({
      en: 'https://shop.example/en/products',
      fr: 'https://shop.example/fr/products',
    });
  });
});

describe('jsonLdPriceString (money = exponent-correct decimal-major STRING)', () => {
  it('EUR 1999 minor → "19.99"', () => {
    expect(jsonLdPriceString(1999, 'EUR')).toBe('19.99');
  });

  it('JPY 1000 minor → "1000" (zero-decimal currency, never /100)', () => {
    expect(jsonLdPriceString(1000, 'JPY')).toBe('1000');
  });

  it('KWD 1234 minor → "1.234" (three-decimal currency)', () => {
    expect(jsonLdPriceString(1234, 'KWD')).toBe('1.234');
  });

  it('keeps trailing-zero cents (EUR 2000 → "20.00")', () => {
    expect(jsonLdPriceString(2000, 'EUR')).toBe('20.00');
  });

  it('formats a zero price with the currency exponent (free products are valid: priceAmount >= 0)', () => {
    // Exponent comes from the currency, not inferred from the amount — so zero is correct per currency.
    expect(jsonLdPriceString(0, 'EUR')).toBe('0.00');
    expect(jsonLdPriceString(0, 'JPY')).toBe('0');
    expect(jsonLdPriceString(0, 'KWD')).toBe('0.000');
  });
});

describe('schemaAvailability', () => {
  it('maps true → InStock and false → OutOfStock schema.org URLs', () => {
    expect(schemaAvailability(true)).toBe('https://schema.org/InStock');
    expect(schemaAvailability(false)).toBe('https://schema.org/OutOfStock');
  });
});

describe('buildBreadcrumbJsonLd', () => {
  it('emits a BreadcrumbList with 1-based positions and absolute item URLs', () => {
    const ld = obj(
      buildBreadcrumbJsonLd('https://shop.example', 'en', [
        { label: 'Home', href: '/' },
        { label: 'Apparel', href: '/category/apparel' },
        { label: 'Tee', href: '/product/tee' },
      ]),
    );
    expect(ld['@context']).toBe('https://schema.org');
    expect(ld['@type']).toBe('BreadcrumbList');
    const items = ld.itemListElement as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      '@type': 'ListItem',
      position: 1,
      name: 'Home',
      item: 'https://shop.example/en',
    });
    expect(items[1]).toMatchObject({
      position: 2,
      name: 'Apparel',
      item: 'https://shop.example/en/category/apparel',
    });
    expect(items[2]).toMatchObject({ position: 3, name: 'Tee' });
  });
});

const baseProduct: ProductDetailView = {
  id: 'p1',
  slug: 'tee',
  title: 'Cotton Tee',
  description: 'A soft cotton tee.',
  variants: [
    {
      id: 'v1',
      title: 'S',
      options: { size: 'S' },
      priceAmount: 1999,
      currency: 'EUR',
      availability: true,
    },
    {
      id: 'v2',
      title: 'L',
      options: { size: 'L' },
      priceAmount: 2499,
      currency: 'EUR',
      availability: false,
    },
  ],
  images: [
    { thumbnailUrl: 'https://cdn.example/tee-1.jpg', altText: 'front' },
    { thumbnailUrl: 'https://cdn.example/tee-2.jpg', altText: 'back' },
  ],
};

describe('buildProductJsonLd', () => {
  it('emits Product with name/description/image[] and an AggregateOffer for a price range', () => {
    const url = 'https://shop.example/en/product/tee';
    const ld = obj(buildProductJsonLd(baseProduct, url));
    expect(ld['@context']).toBe('https://schema.org');
    expect(ld['@type']).toBe('Product');
    expect(ld.name).toBe('Cotton Tee');
    expect(ld.description).toBe('A soft cotton tee.');
    expect(ld.image).toEqual(['https://cdn.example/tee-1.jpg', 'https://cdn.example/tee-2.jpg']);

    const offers = obj(ld.offers);
    expect(offers['@type']).toBe('AggregateOffer');
    expect(offers.priceCurrency).toBe('EUR');
    expect(offers.lowPrice).toBe('19.99');
    expect(offers.highPrice).toBe('24.99');
    expect(offers.offerCount).toBe(2);
    expect(offers.url).toBe(url);
    // Some variant is in stock → aggregate availability is InStock.
    expect(offers.availability).toBe('https://schema.org/InStock');
  });

  it('emits a single Offer (not AggregateOffer) when there is exactly one variant', () => {
    const single: ProductDetailView = {
      ...baseProduct,
      variants: [baseProduct.variants[0]!],
    };
    const offers = obj(buildProductJsonLd(single, 'https://shop.example/en/product/tee').offers);
    expect(offers['@type']).toBe('Offer');
    expect(offers.price).toBe('19.99');
    expect(offers.priceCurrency).toBe('EUR');
    expect(offers.availability).toBe('https://schema.org/InStock');
  });

  it('uses the variant currency (JPY) — not a default — with the right exponent', () => {
    const jpy: ProductDetailView = {
      ...baseProduct,
      variants: [
        {
          id: 'v1',
          title: null,
          options: {},
          priceAmount: 1000,
          currency: 'JPY',
          availability: true,
        },
      ],
    };
    const offers = obj(buildProductJsonLd(jpy, 'https://shop.example/en/product/tee').offers);
    expect(offers.priceCurrency).toBe('JPY');
    expect(offers.price).toBe('1000');
  });

  it('omits offers entirely when the product has no variants', () => {
    const noVariants: ProductDetailView = { ...baseProduct, variants: [] };
    const ld = obj(buildProductJsonLd(noVariants, 'https://shop.example/en/product/tee'));
    expect(ld.offers).toBeUndefined();
  });

  it('marks the aggregate OutOfStock only when ALL variants are unavailable', () => {
    const allOut: ProductDetailView = {
      ...baseProduct,
      variants: baseProduct.variants.map((v) => ({ ...v, availability: false })),
    };
    const offers = obj(buildProductJsonLd(allOut, 'https://x/p').offers);
    expect(offers.availability).toBe('https://schema.org/OutOfStock');
  });
});

describe('buildOrganizationJsonLd / buildWebSiteJsonLd', () => {
  it('Organization carries the brand name, site url and absolute logo', () => {
    const ld = obj(
      buildOrganizationJsonLd('https://shop.example', 'My Store', 'https://cdn/logo.png'),
    );
    expect(ld['@type']).toBe('Organization');
    expect(ld.name).toBe('My Store');
    expect(ld.url).toBe('https://shop.example');
    expect(ld.logo).toBe('https://cdn/logo.png');
  });

  it('Organization resolves a root-relative logo against the origin and omits a missing logo', () => {
    expect(obj(buildOrganizationJsonLd('https://shop.example', 'My Store', '/logo.png')).logo).toBe(
      'https://shop.example/logo.png',
    );
    expect(
      obj(buildOrganizationJsonLd('https://shop.example', 'My Store', undefined)).logo,
    ).toBeUndefined();
  });

  it('WebSite carries the brand name + site url', () => {
    const ld = obj(buildWebSiteJsonLd('https://shop.example', 'My Store'));
    expect(ld['@type']).toBe('WebSite');
    expect(ld.name).toBe('My Store');
    expect(ld.url).toBe('https://shop.example');
  });
});
