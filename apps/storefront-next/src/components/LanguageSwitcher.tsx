'use client';

/**
 * Footer language switcher. Client component: it swaps ONLY the
 * locale segment of the current URL while preserving the path + search params, so a visitor on
 * `/en/products?cursor=X` switching to FR lands on `/fr/products?cursor=X`.
 *
 * Mechanism: next-intl's `usePathname` returns the locale-STRIPPED path; `useRouter().replace(path,
 * { locale })` re-renders that same path under the new locale. next-intl persists the choice in its
 * `NEXT_LOCALE` cookie, so the next bare-`/` visit resolves to the chosen locale (persisted last
 * choice). `useTransition` keeps the UI responsive during the locale navigation.
 *
 * Full cookie-persistence across a fresh session is an end-to-end concern; the unit test asserts the
 * switcher calls the router with the correct target locale.
 */
import { useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useParams, useSearchParams } from 'next/navigation';
import { usePathname, useRouter } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';

export function LanguageSwitcher() {
  const t = useTranslations('languageSwitcher');
  const activeLocale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function onChange(nextLocale: string) {
    if (nextLocale === activeLocale) return;
    const query = searchParams.toString();
    startTransition(() => {
      // `pathname` is the locale-stripped path; `router.replace` re-targets it under `nextLocale`.
      // Pass dynamic `params` so next-intl keeps `[slug]`-style segments intact.
      router.replace(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- next-intl typed-route pathname
        { pathname: query ? `${pathname}?${query}` : pathname, params } as any,
        { locale: nextLocale as (typeof routing.locales)[number] },
      );
    });
  }

  return (
    <label className="inline-flex items-center gap-2">
      <span className="sr-only">{t('label')}</span>
      <select
        aria-label={t('label')}
        value={activeLocale}
        disabled={isPending}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {routing.locales.map((locale) => (
          <option key={locale} value={locale}>
            {t(locale)}
          </option>
        ))}
      </select>
    </label>
  );
}
