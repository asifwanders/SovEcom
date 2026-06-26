/**
 * Storefront 404 page. Rendered by Next whenever a route under `[locale]` calls `notFound()`
 * (e.g. an unknown category/product slug) or no route matches. It renders inside `[locale]/layout.tsx`,
 * so it inherits the full chrome (Header/Footer) + the request locale. Copy is localized via
 * the `notFound` namespace. Token-based styling with a locale-aware link back to the product catalog.
 */
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { buttonClasses } from '@/components/ui/Button';

export default function NotFound() {
  const t = useTranslations('notFound');
  return (
    <div className="mx-auto flex max-w-6xl flex-col items-center px-4 py-20 text-center">
      <p className="text-6xl font-bold text-primary" aria-hidden="true">
        404
      </p>
      <h1 className="mt-4 text-2xl font-semibold text-foreground">{t('title')}</h1>
      <p className="mt-2 max-w-md text-muted-foreground">{t('description')}</p>
      <Link href="/products" className={`mt-8 ${buttonClasses('primary', 'lg')}`}>
        {t('backToCatalog')}
      </Link>
    </div>
  );
}
