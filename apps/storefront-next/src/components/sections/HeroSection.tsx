/**
 * Hero section — extracted VERBATIM from the pre-refactor Home hero. RSC, no
 * "use client". Markup/classes are identical to the inline hero so the section runtime is a no-DOM-
 * change refactor. No data loader: it renders pure localized chrome (the `home` namespace) + a
 * locale-aware CTA to `/products`.
 *
 * ii: an OPT-IN `fullBleed` boolean setting (boutique). When `true`, the hero breaks out of
 * the page container to span the full viewport width (an editorial full-bleed band) + gets a taller
 * pad. DEFAULTS TO OFF (absent/non-true → the rounded-card hero), so the default home is unchanged.
 */
import { getTranslations } from 'next-intl/server';
import { buttonClasses } from '@/components/ui/Button';
import { Link } from '@/i18n/navigation';

/** The default (rounded-card) hero shell — the verbatim pre-refactor classes. */
const CARD_CLASS = 'rounded-2xl bg-primary/10 p-8 md:p-12 text-center';
/**
 * Full-bleed editorial band: break out of the centered page container to span the viewport width
 * (`w-screen` + the `50%/-50vw` margin trick), no rounding, taller pad. Opt-in only (boutique).
 */
const FULL_BLEED_CLASS =
  'relative left-1/2 -mx-[50vw] w-screen bg-primary/10 px-4 py-16 md:py-24 text-center';

/** Props the renderer passes every section: validated `settings`, loader `data`, active `locale`. */
export async function HeroSection(props: {
  settings: Record<string, unknown>;
  data: unknown;
  locale: string;
}) {
  const t = await getTranslations('home');
  // Opt-in full-bleed: strictly `=== true` so any absent/garbage value keeps the default card.
  const fullBleed = props.settings.fullBleed === true;
  return (
    <section className={fullBleed ? FULL_BLEED_CLASS : CARD_CLASS}>
      <h1 className="text-3xl md:text-5xl font-bold text-primary mb-4">{t('heroTitle')}</h1>
      <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-6">{t('heroSubtitle')}</p>
      <Link href="/products" className={buttonClasses('primary', 'lg')}>
        {t('browseProducts')}
      </Link>
    </section>
  );
}
