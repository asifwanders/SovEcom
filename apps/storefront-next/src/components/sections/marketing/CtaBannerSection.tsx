/**
 * WS-3d — `cta-banner` marketing section renderer.
 *
 * RSC (no "use client"). A compact call-to-action strip. Security:
 *   - No image: no SSRF/PII surface here.
 *   - ctaHref is SDK-validated at API time (marketingHrefSchema) — rendered as a plain <a>.
 *   - No dangerouslySetInnerHTML; all text is rendered as React children (auto-escaped).
 *
 * variant defaults to 'primary' when absent.
 */
import type { SectionProps } from '@/lib/sections/registry';
import type { CtaBannerSettings } from '@sovecom/theme-sdk';

const VARIANT_CLASS: Record<string, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/90',
};

export async function CtaBannerSection({ settings }: SectionProps) {
  const s = settings as unknown as CtaBannerSettings;
  const variant = s.variant ?? 'primary';
  const btnClass = VARIANT_CLASS[variant] ?? VARIANT_CLASS.primary;

  return (
    <section className="rounded-2xl bg-card border border-border p-8 flex flex-col md:flex-row items-center justify-between gap-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl font-bold">{s.headline}</h2>
        {s.body && <p className="text-muted-foreground">{s.body}</p>}
      </div>
      <a
        href={s.ctaHref}
        className={`shrink-0 inline-block rounded-md px-6 py-3 text-sm font-semibold transition-colors ${btnClass}`}
      >
        {s.ctaLabel}
      </a>
    </section>
  );
}
