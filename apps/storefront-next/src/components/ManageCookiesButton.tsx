'use client';

/**
 * Footer "Manage cookies" control. Re-opens the consent banner so a
 * returning visitor can change a recorded decision — RGPD requires withdrawal to be as easy as
 * granting. Client component: reads the consent context. Styled to match the footer's text links.
 */
import { useTranslations } from 'next-intl';
import { useConsent } from '@/lib/consent';

export function ManageCookiesButton() {
  const t = useTranslations('footer');
  const { openManage } = useConsent();
  return (
    <button
      type="button"
      onClick={openManage}
      className="hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
    >
      {t('manageCookies')}
    </button>
  );
}
