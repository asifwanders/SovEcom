/**
 * JSON-LD structured-data validation. Parses the
 * rendered `<script type="application/ld+json">` blocks (which `StructuredData.tsx` `<`-escapes) and
 * asserts the schema.org STRUCTURE the storefront promises:
 *   - EVERY page emits site-wide `Organization` + `WebSite` (from the layout), each with
 *     `@context: https://schema.org` and the required `name` + `url`.
 *   - A PDP additionally emits `Product` (+ `Offer`/`AggregateOffer`) and a `BreadcrumbList`.
 *
 * The CI seed creates NO products/categories (legal `pages` + tax/shipping only — see e2e/README),
 * so there is no PDP to load: the Product/Offer/BreadcrumbList assertions are GUARDED — we discover a
 * product slug from `/sitemap.xml` and `test.skip` when the catalog is empty. The always-emitted
 * Organization/WebSite checks run unconditionally on home + a legal page, so the gate has real
 * coverage even with an empty catalog; the Product path validates fully whenever products exist.
 *
 * Validates STRUCTURE (required fields + types), not a live schema.org network call (out of scope).
 */
import { test, expect } from '@playwright/test';
import { LOCALES, localePath, readJsonLd, findByType, isType, type JsonLdNode } from './helpers';

/** Assert the site-wide Organization + WebSite nodes are present and well-formed. */
function assertSiteWideJsonLd(nodes: JsonLdNode[]) {
  const org = findByType(nodes, 'Organization');
  expect(org, 'Organization JSON-LD must be present on every page').toBeTruthy();
  expect(org!['@context']).toBe('https://schema.org');
  expect(typeof org!.name, 'Organization.name').toBe('string');
  expect(typeof org!.url, 'Organization.url').toBe('string');

  const site = findByType(nodes, 'WebSite');
  expect(site, 'WebSite JSON-LD must be present on every page').toBeTruthy();
  expect(site!['@context']).toBe('https://schema.org');
  expect(typeof site!.name, 'WebSite.name').toBe('string');
  expect(typeof site!.url, 'WebSite.url').toBe('string');
}

for (const locale of LOCALES) {
  test.describe(`JSON-LD (${locale})`, () => {
    test('home emits valid Organization + WebSite', async ({ page }) => {
      await page.goto(localePath(locale));
      const nodes = await readJsonLd(page);
      assertSiteWideJsonLd(nodes);
    });

    test('legal page emits valid Organization + WebSite', async ({ page }) => {
      await page.goto(localePath(locale, 'privacy'));
      const nodes = await readJsonLd(page);
      assertSiteWideJsonLd(nodes);
    });

    test('PDP (when a product is seeded) emits Product/Offer + BreadcrumbList', async ({
      page,
    }) => {
      // Discover a product PDP from the sitemap; skip cleanly when the catalog is empty (CI default).
      const sitemap = await page.request.get('/sitemap.xml');
      expect(sitemap.ok()).toBeTruthy();
      const xml = await sitemap.text();
      const match = xml.match(/\/(?:en|fr)\/product\/([^<\s]+)/);
      test.skip(!match, 'No product seeded — Product JSON-LD path not exercised (empty catalog).');

      const slug = match![1];
      await page.goto(localePath(locale, `product/${slug}`));

      const nodes = await readJsonLd(page);
      assertSiteWideJsonLd(nodes);

      const product = findByType(nodes, 'Product');
      expect(product, 'Product JSON-LD must be present on a PDP').toBeTruthy();
      expect(product!['@context']).toBe('https://schema.org');
      expect(typeof product!.name, 'Product.name').toBe('string');

      // A priced product carries an Offer or AggregateOffer with a currency.
      const offers = product!.offers as { '@type'?: string; priceCurrency?: unknown } | undefined;
      if (offers) {
        expect(['Offer', 'AggregateOffer']).toContain(offers['@type']);
        expect(typeof offers.priceCurrency, 'offer.priceCurrency').toBe('string');
      }

      const crumbs = findByType(nodes, 'BreadcrumbList');
      expect(crumbs, 'BreadcrumbList JSON-LD must be present on a PDP').toBeTruthy();
      expect(Array.isArray(crumbs!.itemListElement), 'BreadcrumbList.itemListElement').toBe(true);
      const items = crumbs!.itemListElement as Array<Record<string, unknown>>;
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(isType(item as never, 'ListItem')).toBe(true);
        expect(typeof item.position).toBe('number');
      }
    });
  });
}
