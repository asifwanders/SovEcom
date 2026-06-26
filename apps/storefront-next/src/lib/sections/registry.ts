/**
 * Section registry — the storefront's map of section `type` → its optional
 * data LOADER + its RSC `Component`. A page template (`@sovecom/theme-sdk` `ThemeTemplate`) lists
 * sections by `type`; the renderer (`renderSections.tsx`) looks each up here, runs the loaders in
 * parallel, then renders the components in template order.
 *
 * A section's `loader` does its data fetching (catalog reads) given the section's validated `settings`
 * + a small render `ctx` (`{ locale }`); its `Component` is pure presentation over `{ settings, data,
 * locale }`. Sections with no data needs (e.g. `hero`) omit the loader. Unknown types simply aren't
 * here — the renderer skips them (never throws), so a forward-declared section in a template degrades
 * gracefully on an older storefront.
 */
import type { ReactNode } from 'react';
import { fetchProducts, fetchCategoryTree } from '@/lib/catalog';
import { HeroSection } from '@/components/sections/HeroSection';
import { FeaturedProductsSection } from '@/components/sections/FeaturedProductsSection';
import { CategoryListSection } from '@/components/sections/CategoryListSection';
import { BreadcrumbsSection } from '@/components/sections/BreadcrumbsSection';
import {
  ProductGallerySection,
  ProductInfoSection,
  VariantSelectorSection,
} from '@/components/sections/ProductSections';
import { ColumnsSection } from '@/components/sections/ColumnsSection';
import {
  CategoryHeaderRowSection,
  CategoryFilterSidebarSection,
  CategoryResultsSection,
} from '@/components/sections/CategorySections';
import {
  SearchResultsHeaderSection,
  SearchFilterSidebarSection,
  SearchProductGridSection,
  SearchPaginationSection,
} from '@/components/sections/SearchSections';
import {
  ProductsHeaderSection,
  ProductsGridSection,
  ProductsLoadMoreSection,
} from '@/components/sections/ProductsSections';

/** The validated section settings bag (opaque `Record<string, unknown>` from the template). */
export type SectionSettings = Record<string, unknown>;

/**
 * The render context every loader/component receives: the active `locale`, the OPTIONAL route
 * `params` (e.g. `{ slug }` on the PDP) the renderer threads through so a section loader can fetch the
 * route's entity, and the OPTIONAL `searchParams` — the request's query string parsed to
 * a plain `Record<string,string>` — so a results-consuming loader (sort/filter/page on the PLP +
 * search surfaces) can fetch the right slice. Home/PDP/Cart pass no `searchParams`.
 */
export interface SectionContext {
  locale: string;
  params?: Record<string, string>;
  searchParams?: Record<string, string>;
}

/** The props every section Component receives from the renderer. */
export interface SectionProps {
  settings: SectionSettings;
  data: unknown;
  locale: string;
  /**
   * Pre-rendered child nodes per named region — populated ONLY for LAYOUT sections whose
   * template entry has `regions` (e.g. `columns`). Each region's sub-sections are resolved, loaded, and
   * rendered by the renderer, then handed here for the layout component to place. A non-layout section
   * ignores this (it stays `undefined`).
   */
  regions?: Record<string, ReactNode[]>;
}

/** A section's optional data loader: fetches over `settings` + the render `ctx`. */
type SectionLoader = (settings: SectionSettings, ctx: SectionContext) => Promise<unknown>;

/**
 * A SYNCHRONOUS React node — `ReactNode` minus the `Promise<AwaitedReactNode>` arm that React 19's
 * `@types/react` folds in (that arm is what makes an async RSC's return assignable to `ReactNode`).
 * Excluding it lets the compiler REJECT an accidental async CLIENT section Component (which the renderer
 * would `createElement` un-awaited → render `[object Promise]`).
 */
type SyncReactNode = Exclude<ReactNode, Promise<unknown>>;

/**
 * A registered section: optional data loader + the component that renders it. A DISCRIMINATED UNION on
 * the `client` flag:
 *   - an RSC section (`client` unset/false) is AWAITED by the renderer, so its Component may be an async
 *     RSC (`Promise<ReactNode>`) — e.g. the bundled sections that call `getTranslations`;
 *   - a CLIENT section (`client: true`) is a client island the renderer renders as a JSX ELEMENT (via
 *     `createElement`, NOT awaited), so its Component MUST be SYNCHRONOUS (`SyncReactNode`). The compiler
 *     enforces this — an accidental async client Component (which would render `[object Promise]`) is a
 *     type error. A client section may still carry a (server) `loader` that hands the island
 *     SERIALIZABLE props. See `renderSections.tsx`.
 */
export type Section =
  | {
      type: string;
      client?: false;
      loader?: SectionLoader;
      Component: (props: SectionProps) => ReactNode | Promise<ReactNode>;
    }
  | {
      type: string;
      /** Render `<Component .../>` as an element (client island), not awaited — Component is SYNC. */
      client: true;
      loader?: SectionLoader;
      Component: (props: SectionProps) => SyncReactNode;
    };

/**
 * The bundled section registry. Home sections: `hero` (no loader), `featured-products` (loads a product
 * page sized by `settings.limit`), `category-list` (loads the category tree). PDP sections (3.9e-i):
 * `breadcrumbs` + the granular `product-gallery` / `product-info` / `variant-selector` (the gallery +
 * selector are CLIENT islands), each a self-contained `Section` whose loader fetches the cached product
 * via `ctx.params.slug`. Keyed by `type` for O(1) lookup in the renderer.
 */
export const sectionRegistry: Readonly<Record<string, Section>> = {
  hero: {
    type: 'hero',
    Component: HeroSection,
  },
  'featured-products': {
    type: 'featured-products',
    loader: async (settings) => {
      const limit = Number(settings.limit) || 8;
      return fetchProducts({ pageSize: limit });
    },
    Component: FeaturedProductsSection,
  },
  'category-list': {
    type: 'category-list',
    loader: async () => fetchCategoryTree(),
    Component: CategoryListSection,
  },
  [BreadcrumbsSection.type]: BreadcrumbsSection,
  // i — the PDP `product-main` composite decomposed into granular sections (gallery + info +
  // variant selector); the gallery + selector are CLIENT islands rendered as elements by the renderer.
  [ProductGallerySection.type]: ProductGallerySection,
  [ProductInfoSection.type]: ProductInfoSection,
  [VariantSelectorSection.type]: VariantSelectorSection,
  // the generic `columns` layout primitive + the category/search/products PLP sections.
  [ColumnsSection.type]: ColumnsSection,
  [CategoryHeaderRowSection.type]: CategoryHeaderRowSection,
  [CategoryFilterSidebarSection.type]: CategoryFilterSidebarSection,
  [CategoryResultsSection.type]: CategoryResultsSection,
  [SearchResultsHeaderSection.type]: SearchResultsHeaderSection,
  [SearchFilterSidebarSection.type]: SearchFilterSidebarSection,
  [SearchProductGridSection.type]: SearchProductGridSection,
  [SearchPaginationSection.type]: SearchPaginationSection,
  [ProductsHeaderSection.type]: ProductsHeaderSection,
  [ProductsGridSection.type]: ProductsGridSection,
  [ProductsLoadMoreSection.type]: ProductsLoadMoreSection,
};

/** Look up a registered section by `type`, or `undefined` when no section is registered for it. */
export function getSection(type: string): Section | undefined {
  return sectionRegistry[type];
}
