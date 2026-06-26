/**
 * Category-list section — extracted VERBATIM from the pre-refactor Home
 * "Categories" block. RSC, no "use client". The category tree is fetched by the section's LOADER (see
 * registry) and arrives here as `data`; the section renders NOTHING when there are no categories,
 * exactly as the inline block did (`categories.length > 0 && ...`). Pill markup/classes are identical.
 */
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import type { CategoryView } from '@/lib/catalog';

export async function CategoryListSection({
  data,
}: {
  settings: Record<string, unknown>;
  /** Loader output (`CategoryView[]`); typed `unknown` to match the registry `Section` contract. */
  data: unknown;
  locale: string;
}) {
  const t = await getTranslations('home');
  const categories = (data as CategoryView[] | undefined) ?? [];
  if (categories.length === 0) return null;
  return (
    <section>
      <h2 className="text-2xl font-semibold mb-6">{t('shopByCategory')}</h2>
      <div className="flex flex-wrap gap-3">
        {categories.map((cat) => (
          <Link
            key={cat.id}
            href={`/category/${cat.slug}`}
            className="inline-flex items-center rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:text-primary hover:border-primary transition-colors"
          >
            {cat.name}
          </Link>
        ))}
      </div>
    </section>
  );
}
