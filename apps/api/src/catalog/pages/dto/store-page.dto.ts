/**
 * StorePageDto (public allowlist).
 *
 * The ONLY fields the public `GET /store/v1/pages/:slug` endpoint may serialize.
 * NEVER expose: id, tenant_id, status, createdAt/updatedAt — the raw row must
 * never reach the store (mirrors StoreCategoryDto discipline).
 *
 * Shape = the storefront's existing `LegalPageView` contract (`{ slug, title,
 * body }`, see apps/storefront-next/src/lib/pages.ts) PLUS `locale` and the SEO
 * metadata the storefront's `(legal)/[slug]` + `(content)/[slug]` routes use for
 * <title>/<meta description> in.
 */
export interface StorePageDto {
  slug: string;
  title: string;
  body: string;
  locale: string;
  seoTitle: string | null;
  seoDescription: string | null;
}
