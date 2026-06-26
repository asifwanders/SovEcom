/**
 * CMS-lite page data-layer. Wires the storefront against the public `GET /store/v1/pages/:slug` endpoint.
 * client-js is the sole transport and types params but NOT response bodies, so this module OWNS the
 * response view-type it renders, mirroring the API's `StorePageDto` allowlist exactly.
 *
 * `fetchLegalPage` and `fetchContentPage` are thin wrappers over a single internal `fetchPage` —
 * legal vs content are slug/route-group conventions hitting the SAME endpoint; both
 * named exports exist because the `(legal)` and `(content)` routes import them respectively.
 *
 * Resilience posture: a 404 (unknown / draft / wrong-locale row) returns `null`, and ANY other
 * transport error also returns `null` so a cold/unreachable API renders `notFound()` rather than a 500.
 * The body is authored Markdown rendered server-side through a sanitizer in `components/Markdown.tsx`
 * (react-markdown + rehype-sanitize) — never `dangerouslySetInnerHTML` of unsanitized input.
 */
import { createStoreClient } from './store-client';
import { SovEcomApiError } from '@sovecom/client-js';

/**
 * A legal/content page as rendered by the `(legal)/[slug]` and `(content)/[slug]` route shells.
 * Mirrors the API's `StorePageDto` allowlist. `body` is Markdown (rendered + sanitized at render).
 */
export interface LegalPageView {
  slug: string;
  title: string;
  /**
   * Page body authored as Markdown. Rendered server-side via react-markdown + rehype-sanitize
   * (`components/Markdown.tsx`) — sanitized, no raw-HTML passthrough.
   */
  body: string;
  /** Content locale of this row (e.g. 'en', 'fr') — the per-locale `(tenant_id, slug, locale)` row. */
  locale: string;
  /** Optional SEO <title>, or null when unset — used by `generateMetadata`. */
  seoTitle: string | null;
  /** Optional SEO <meta description>, or null when unset — used by `generateMetadata`. */
  seoDescription: string | null;
}

/** Raw published store-page DTO (allowlisted store shape) — the routes render against this. */
interface RawStorePage {
  slug: string;
  title: string;
  body: string;
  locale: string;
  seoTitle: string | null;
  seoDescription: string | null;
}

function toLegalPageView(p: RawStorePage): LegalPageView {
  return {
    slug: p.slug,
    title: p.title,
    body: p.body,
    locale: p.locale,
    seoTitle: p.seoTitle ?? null,
    seoDescription: p.seoDescription ?? null,
  };
}

/**
 * Internal shared fetch for a published CMS page by slug. `locale` is optional: when omitted the
 * query param is left off and the API defaults to 'en'. 404 (unknown/draft/wrong-locale) → null;
 * any transport error → null.
 */
async function fetchPage(slug: string, locale?: string): Promise<LegalPageView | null> {
  try {
    const client = createStoreClient();
    // `query.locale` is required in the generated op type, but `buildQuery` skips undefined values,
    // so an empty query object lets the API apply its default locale.
    const query = (locale ? { locale } : {}) as { locale: string };
    const res = await client.request<'/store/v1/pages/{slug}', 'get', RawStorePage>(
      'get',
      '/store/v1/pages/{slug}',
      { path: { slug }, query },
    );
    return toLegalPageView(res);
  } catch (err) {
    if (err instanceof SovEcomApiError && err.status === 404) return null;
    return null;
  }
}

/**
 * Fetch a published LEGAL page by slug (terms, privacy, cookie policy, withdrawal info). `locale`
 * is optional. Returns `null` → `notFound` on 404/transport.
 */
export async function fetchLegalPage(slug: string, locale?: string): Promise<LegalPageView | null> {
  return fetchPage(slug, locale);
}

/**
 * Fetch a published CONTENT/marketing page by slug. Same endpoint + posture as `fetchLegalPage`;
 * the route group (`(content)` vs `(legal)`) is the only distinction.
 */
export async function fetchContentPage(
  slug: string,
  locale?: string,
): Promise<LegalPageView | null> {
  return fetchPage(slug, locale);
}
