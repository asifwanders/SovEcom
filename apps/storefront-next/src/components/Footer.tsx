/**
 * Storefront footer. Server component: localized copy from the `footer` namespace, with legal links
 * pointing to the `(legal)/[slug]` route group (`/privacy`, `/terms`). Hosts the client
 * `LanguageSwitcher` and `ThemeToggle` (dark-mode control). RTL-ready: flex gap and logical spacing,
 * no hard-coded left/right.
 */
import { Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { LanguageSwitcher } from './LanguageSwitcher';
import { ThemeToggle } from './ThemeToggle';
import { ManageCookiesButton } from './ManageCookiesButton';

export function Footer() {
  const t = useTranslations('footer');
  return (
    <footer className="border-t border-border bg-muted mt-12">
      <div className="mx-auto max-w-6xl px-4 py-8 flex flex-col gap-6 text-sm text-muted-foreground md:flex-row md:items-start md:justify-between">
        <p>{t('rights', { year: new Date().getFullYear() })}</p>
        <nav aria-label={t('linksLabel')} className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Link href="/products" className="hover:text-foreground transition-colors">
            {t('products')}
          </Link>
          <Link href="/category" className="hover:text-foreground transition-colors">
            {t('categories')}
          </Link>
          <Link href="/privacy" className="hover:text-foreground transition-colors">
            {t('privacy')}
          </Link>
          <Link href="/terms" className="hover:text-foreground transition-colors">
            {t('terms')}
          </Link>
          <ManageCookiesButton />
        </nav>
        <div className="flex items-center gap-2">
          {/* Suspense boundary: LanguageSwitcher reads useSearchParams, which triggers client hydration
              on statically-prerendered pages. The boundary keeps those pages prerenderable while the
              switcher hydrates on the client. */}
          <Suspense fallback={null}>
            <LanguageSwitcher />
          </Suspense>
          <ThemeToggle />
        </div>
      </div>
    </footer>
  );
}
