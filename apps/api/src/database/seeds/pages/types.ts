/**
 * Shared types for the default `pages` seed.
 *
 * The seeded set is intentionally a small, fixed list of EU legal/content
 * TEMPLATES (FR + EN). Each entry is the per-locale content for ONE slug; the
 * seeder pairs `en[slug]` + `fr[slug]` so every slug exists in BOTH locales
 * (the store read keys on `(tenant, slug, locale)` with NO fallback).
 */

/** A single locale's content for one seeded page. */
export interface SeedPageContent {
  title: string;
  body: string;
  seoTitle?: string;
  seoDescription?: string;
}

/**
 * The canonical slug set. `privacy` + `terms` MUST match the
 * storefront footer links (`Footer.tsx` → `/privacy`, `/terms`); the rest are
 * editable, harmless extras a merchant will likely want (cookie policy, EU
 * "mentions légales"/imprint, right-of-withdrawal + the model form).
 */
export const SEED_PAGE_SLUGS = [
  'privacy',
  'terms',
  'cookies',
  'legal-notice',
  'withdrawal',
] as const;

export type SeedPageSlug = (typeof SEED_PAGE_SLUGS)[number];

/** A full locale pack: content for every seeded slug. */
export type SeedPagePack = Record<SeedPageSlug, SeedPageContent>;
