'use client';

/**
 * placeholder for account sections whose UI lands in a later chunk (orders → B,
 * addresses → D, profile → E). The account nav + dashboard cards link to these routes, so shipping the
 * shell without them would 404. Each renders a localized heading (the nav label) + a "coming soon"
 * note. REPLACED wholesale by the real section pages in their chunks — intentionally minimal.
 */
import { useTranslations } from 'next-intl';

export function AccountPlaceholder({
  section,
}: {
  section: 'orders' | 'addresses' | 'profile';
}): React.ReactElement {
  const t = useTranslations('account');
  return (
    <section className="flex flex-col gap-3">
      <h1 className="text-2xl font-bold text-foreground">{t(`nav.${section}`)}</h1>
      <p className="text-sm text-muted-foreground">{t('comingSoon')}</p>
    </section>
  );
}
