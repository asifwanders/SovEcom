/**
 * WS-3d — `hero-banner` marketing section renderer.
 *
 * RSC (no "use client"). Presentational: merchant-authored headline/image/CTA rendered
 * on the public storefront. Security:
 *   - imageUrl MUST pass through `safeImageUrl()` (origin allowlist + scheme guard). If it
 *     returns null/undefined, no <img> is rendered — defence against SSRF/PII-egress.
 *   - CTA href is SDK-validated at API time (marketingHrefSchema) — rendered as a plain <a>.
 *   - No dangerouslySetInnerHTML; no raw HTML injection surface.
 *
 * align defaults to 'center' when absent; overlay defaults to false.
 */
import type { SectionProps } from '@/lib/sections/registry';
import type { HeroBannerSettings } from '@sovecom/theme-sdk';
import { safeImageUrl } from '@/lib/widgets/safeUrl';

const ALIGN_CLASS: Record<string, string> = {
  left: 'text-left items-start',
  center: 'text-center items-center',
  right: 'text-right items-end',
};

export async function HeroBannerSection({ settings }: SectionProps) {
  const s = settings as unknown as HeroBannerSettings;
  const align = s.align ?? 'center';
  const overlay = s.overlay === true;
  const alignClass = ALIGN_CLASS[align] ?? ALIGN_CLASS.center;

  // Security: every imageUrl must pass the origin-allowlist guard before reaching the DOM.
  const imgSrc = s.imageUrl ? safeImageUrl(s.imageUrl) : undefined;

  return (
    <section className="relative overflow-hidden rounded-2xl bg-primary/10">
      {imgSrc && (
        <img
          src={imgSrc}
          alt={s.headline}
          className="absolute inset-0 h-full w-full object-cover"
          aria-hidden={false}
        />
      )}
      {imgSrc && overlay && <div className="absolute inset-0 bg-black/40" aria-hidden="true" />}
      <div className={`relative flex flex-col gap-4 p-8 md:p-12 ${alignClass}`}>
        <h2 className="text-3xl md:text-5xl font-bold text-primary">{s.headline}</h2>
        {s.subheadline && (
          <p className="text-lg text-muted-foreground max-w-2xl">{s.subheadline}</p>
        )}
        {s.ctaLabel && s.ctaHref && (
          <a
            href={s.ctaHref}
            className="inline-block rounded-md bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors self-auto"
          >
            {s.ctaLabel}
          </a>
        )}
      </div>
    </section>
  );
}
