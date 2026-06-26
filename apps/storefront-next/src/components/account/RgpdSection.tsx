'use client';

/**
 * RGPD self-service section. Composes the data EXPORT + account ERASE client
 * islands under one "Your data & privacy" heading. Now rendered on the dedicated /account/privacy page.
 * Split into two sub-components (RgpdExport / RgpdErase) to keep each file small and to isolate the two
 * distinct, security-critical flows. Auth is enforced by the group AccountGate, so `customer` is
 * non-null when this renders.
 */
import { useTranslations } from 'next-intl';
import { RgpdExport } from './RgpdExport';
import { RgpdErase } from './RgpdErase';

export function RgpdSection(): React.ReactElement {
  const t = useTranslations('account.rgpd');
  return (
    <section className="flex flex-col gap-6" data-testid="rgpd-section">
      <h2 className="text-lg font-bold text-foreground">{t('heading')}</h2>
      <RgpdExport />
      <RgpdErase />
    </section>
  );
}
