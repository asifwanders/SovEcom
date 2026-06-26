'use client';

/**
 * Cookie / consent banner. A consent gate for two opt-in analytics categories. Strictly-
 * necessary cookies need no consent; Plausible is cookieless and ungated. GA4 reads `analytics`,
 * Meta Pixel reads `marketing` (see {@link AnalyticsScripts}).
 *
 * State lives in {@link ConsentProvider} (the `cookie_consent` cookie). The banner shows ONLY while
 * undecided (`consent === null`) and AFTER hydration (`ready`) so a returning visitor never sees a
 * flash. Choosing here updates consumers WITHOUT a reload. Privacy-first:
 * categories default OFF; "Reject" / the close button record both off.
 *
 * a11y (unchanged intent): NON-modal `role="region"` (no focus trap), localized `aria-label`,
 * keyboard-operable native controls, ≥44px close target, visible focus ring.
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { buttonClasses } from '@/components/ui/Button';
import { useConsent, isConsentDowngrade, CONSENT_COOKIE, type ConsentState } from '@/lib/consent';

export { CONSENT_COOKIE };

export function CookieBanner() {
  const t = useTranslations('cookieBanner');
  const { consent, ready, setConsent, manageOpen, closeManage } = useConsent();
  // Per-category checkbox state (privacy-first defaults: both off).
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);

  // When re-opened via "Manage cookies", pre-fill the checkboxes from the recorded decision.
  useEffect(() => {
    if (manageOpen && consent) {
      setAnalytics(consent.analytics);
      setMarketing(consent.marketing);
    }
  }, [manageOpen, consent]);

  // Show after hydration while undecided, OR when the visitor re-opened it to change their choice.
  const visible = ready && (consent === null || manageOpen);

  /**
   * Record a decision. A downgrade (revoking an already-granted category) needs a full reload — an
   * already-loaded GA4/Meta SDK can't be unloaded; a pure grant updates live.
   */
  function commit(next: ConsentState) {
    const downgrade = isConsentDowngrade(consent, next);
    setConsent(next);
    closeManage();
    if (downgrade) window.location.reload();
  }

  if (!visible) return null;

  return (
    <div
      role="region"
      aria-label={t('ariaLabel')}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 backdrop-blur"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="text-sm text-foreground">
            <p className="font-medium">{t('heading')}</p>
            <p className="mt-1 text-muted-foreground">
              {t('body')}{' '}
              <Link href="/privacy" className="text-primary underline hover:no-underline">
                {t('learnMore')}
              </Link>
            </p>
          </div>
          <button
            type="button"
            onClick={() => commit({ analytics: false, marketing: false })}
            aria-label={t('dismiss')}
            title={t('dismiss')}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-6">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={analytics}
              onChange={(e) => setAnalytics(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary focus-visible:ring-2 focus-visible:ring-ring"
            />
            {t('analytics')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={marketing}
              onChange={(e) => setMarketing(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary focus-visible:ring-2 focus-visible:ring-ring"
            />
            {t('marketing')}
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => commit({ analytics: true, marketing: true })}
            className={buttonClasses('primary', 'md')}
          >
            {t('acceptAll')}
          </button>
          <button
            type="button"
            onClick={() => commit({ analytics, marketing })}
            className={buttonClasses('secondary', 'md')}
          >
            {t('save')}
          </button>
          <button
            type="button"
            onClick={() => commit({ analytics: false, marketing: false })}
            className={buttonClasses('ghost', 'md')}
          >
            {t('reject')}
          </button>
        </div>
      </div>
    </div>
  );
}
