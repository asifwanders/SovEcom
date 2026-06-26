/**
 * Category index. Lists the category tree as links into each PLP. RSC, ISR 5min
 * (matches the category PLP cadence). Reads from the data layer; empty/unreachable → empty
 * state. This is a convenience index for the header nav; the canonical PLP is `category/[slug]`.
 *
 * chrome localized via the `categoryIndex` namespace; category data (name) stays
 * single-language (`fetchCategoryTree` is NOT locale-aware). Links are locale-prefixed.
 */
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { fetchCategoryTree, type CategoryView } from '@/lib/catalog';
import { siteOrigin } from '@/lib/seo';
import { buildRouteMetadata } from '@/lib/metadata';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';

// ISR: categories revalidate every 5 minutes.
export const revalidate = 300;

/** Category index metadata: localized title/description + canonical + hreflang. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const [tIndex, tSeo] = await Promise.all([
    getTranslations({ locale, namespace: 'categoryIndex' }),
    getTranslations({ locale, namespace: 'seo' }),
  ]);
  return buildRouteMetadata({
    origin: siteOrigin(),
    locale,
    path: '/category',
    title: tIndex('title'),
    description: tSeo('categoriesDescription'),
  });
}

export default async function CategoryIndexPage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('categoryIndex');
  const categories = await fetchCategoryTree();

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold mb-6">{t('title')}</h1>
      {categories.length === 0 ? (
        <p className="text-muted-foreground">{t('empty')}</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {categories.map((cat) => (
            <CategoryCard key={cat.id} category={cat} />
          ))}
        </div>
      )}
    </div>
  );
}

function CategoryCard({ category }: { category: CategoryView }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <Link
        href={`/category/${category.slug}`}
        className="text-lg font-medium text-foreground hover:text-primary transition-colors"
      >
        {category.name}
      </Link>
      {category.children.length > 0 && (
        <ul className="mt-2 space-y-1">
          {category.children.map((child) => (
            <li key={child.id}>
              <Link
                href={`/category/${child.slug}`}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {child.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
