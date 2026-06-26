'use client';

/**
 * Storefront analytics integration. Emits third-party tracking scripts based on configuration and user
 * consent. Config arrives from `GET /store/v1/theme` via the layout; consent state comes from
 * {@link useConsent}. Gating rules:
 *   - Plausible  — cookieless, loaded whenever a domain is set (no consent required).
 *   - GA4        — loaded only with `analytics` consent.
 *   - Meta Pixel — loaded only with `marketing` consent.
 * When users grant consent, relevant trackers mount live without requiring a page reload. Note:
 * `next/script` does not tear down third-party SDKs when its `<Script>` component unmounts, so
 * trackers that have already loaded continue running until the next navigation or reload. The current
 * UX does not support in-session tracking withdrawal. Tracker IDs are validated server-side and
 * re-validated at the storefront boundary (theme.ts) before use in attributes and inline scripts.
 */
import Script from 'next/script';
import { useConsent, type ConsentState } from '@/lib/consent';

export interface AnalyticsConfig {
  plausibleDomain?: string | null;
  ga4Id?: string | null;
  metaPixelId?: string | null;
}

export interface ActiveTrackers {
  plausible: string | null;
  ga4: string | null;
  meta: string | null;
}

/**
 * Pure gating decision: which trackers are active given config + consent. Plausible needs only a
 * domain; GA4 needs `analytics` consent; Meta needs `marketing` consent. `null` consent (undecided)
 * gates everything except Plausible off.
 */
export function activeTrackers(
  config: AnalyticsConfig | null | undefined,
  consent: ConsentState | null,
): ActiveTrackers {
  const c = config ?? {};
  return {
    plausible: c.plausibleDomain || null,
    ga4: consent?.analytics && c.ga4Id ? c.ga4Id : null,
    meta: consent?.marketing && c.metaPixelId ? c.metaPixelId : null,
  };
}

export function AnalyticsScripts({ config }: { config: AnalyticsConfig | null | undefined }) {
  const { consent } = useConsent();
  const { plausible, ga4, meta } = activeTrackers(config, consent);

  return (
    <>
      {plausible && (
        <Script
          defer
          data-domain={plausible}
          src="https://plausible.io/js/script.js"
          strategy="afterInteractive"
        />
      )}

      {ga4 && (
        <>
          <Script
            src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(ga4)}`}
            strategy="afterInteractive"
          />
          <Script id="ga4-init" strategy="afterInteractive">
            {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${ga4}');`}
          </Script>
        </>
      )}

      {meta && (
        <Script id="meta-pixel-init" strategy="afterInteractive">
          {`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${meta}');fbq('track','PageView');`}
        </Script>
      )}
    </>
  );
}
