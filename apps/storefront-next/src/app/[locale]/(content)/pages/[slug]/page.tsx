/**
 * Content/marketing-page route. RSC, static / ISR. The
 * `(content)/[slug]` route group for merchant-authored marketing copy (about, shipping, FAQ, …) —
 * a sibling of `(legal)/[slug]`. Both hit the SAME `pages` source; the route group is the only
 * distinction: legal vs content are slug conventions.
 *
 * Content comes from the `pages` CMS-lite table via `fetchContentPage` → `GET /store/v1/pages/:slug`
 *. An unknown/draft/wrong-locale slug → `null` → `notFound`.
 *
 * SECURITY: body is authored Markdown rendered server-side through react-markdown + rehype-sanitize
 * (`components/Markdown.tsx`) — sanitized, no raw-HTML passthrough.
 *
 * This route passes the route locale into `fetchContentPage` — `pages` content is locale-aware;
 * the per-locale row is keyed `(tenant,slug,locale)`. A missing-locale row → 404 → `null` → `notFound`.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { fetchContentPage, type LegalPageView } from '@/lib/pages';
import { Markdown } from '@/components/Markdown';
import { siteOrigin } from '@/lib/seo';
import { buildRouteMetadata } from '@/lib/metadata';
import type { Locale } from '@/i18n/routing';

// Time-based ISR — content pages are static-ish; revalidate every 5 minutes.
export const revalidate = 300;

/**
 * Content-page metadata with canonical/hreflang/OG tags.
 * The route is `/pages/[slug]`; SEO fields come from the per-locale `pages` row.
 * Unknown/draft slug → {}.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const page = await fetchContentPage(slug, locale);
  if (!page) return {};
  return buildRouteMetadata({
    origin: siteOrigin(),
    locale,
    path: `/pages/${slug}`,
    title: page.seoTitle ?? page.title,
    ...(page.seoDescription ? { description: page.seoDescription } : {}),
    ogType: 'article',
  });
}

export default async function ContentPage({
  params,
}: {
  params: Promise<{ locale: Locale; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const page: LegalPageView | null = await fetchContentPage(slug, locale);
  if (!page) notFound();

  return (
    <article className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-3xl font-bold text-foreground mb-6">{page.title}</h1>
      {/* Markdown body — server-rendered + sanitized (rehype-sanitize), no raw-HTML passthrough. */}
      <div className="prose prose-sm max-w-none text-foreground">
        {/* shiftHeadings: the page title above is the sole <h1>; the body's headings start at <h2>. */}
        <Markdown shiftHeadings={1}>{page.body}</Markdown>
      </div>
    </article>
  );
}
