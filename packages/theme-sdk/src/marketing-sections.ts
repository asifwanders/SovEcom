/**
 * Marketing section settings schemas — the shared, validated contract for the API, admin editor,
 * and storefront renderers.
 *
 * Every consumer (API validation, admin-side form generation, storefront render) imports from this
 * single file so the contract can never diverge across tiers. Section-type strings match
 * {@link SECTION_TYPE_RE} (`/^[a-z][a-z0-9-]*$/`). All strings are bounded, all arrays capped, all
 * fixed-choice fields are enums — no open strings where a finite set suffices.
 *
 * URL/link safety: `ctaHref` and tile `href` fields use {@link marketingHrefSchema}, a schema that
 * accepts only root-relative paths (`/…`) or `http(s)://` absolute URLs. It rejects `javascript:`,
 * `data:`, protocol-relative (`//host`), and any other scheme — mirroring the `safeImageUrl` guard
 * in `apps/storefront-next/src/lib/widgets/safeUrl.ts`.
 *
 * HTML safety: `rich-text` stores its content as MARKDOWN, not raw HTML, so there is no raw-HTML
 * injection surface at the schema layer. The storefront MUST render it with `react-markdown` +
 * `rehype-sanitize` (exactly as `apps/storefront-next/src/components/Markdown.tsx` does for CMS
 * pages) — never with `dangerouslySetInnerHTML` of the raw string.
 *
 * Image URL safety: `imageUrl` fields accept root-relative paths or `http(s)://` absolute URLs only
 * — same shape gate as `safeImageUrl`. The storefront enforces the PII-egress origin allowlist at
 * render time (the schema cannot know the runtime API base URL).
 */
import { z } from 'zod';

// ── shared field bounds ────────────────────────────────────────────────────────────
const MAX_HEADLINE_LEN = 160;
const MAX_SUBHEADLINE_LEN = 300;
const MAX_BODY_LEN = 600;
const MAX_CTA_LABEL_LEN = 80;
const MAX_IMAGE_URL_LEN = 2048;
const MAX_TILE_LABEL_LEN = 120;
const MAX_TILE_CAPTION_LEN = 300;
const MAX_TILES = 12;
const MAX_MARKDOWN_LEN = 50_000; // ~50 KB of source markdown is a generous upper bound

/**
 * A safe `href` for CTA links and tile links. Accepts:
 *   - Root-relative paths: `/…` (NOT protocol-relative `//host`).
 *   - Absolute `http(s)://` URLs.
 * Rejects `javascript:`, `data:`, `//host`, bare strings with no slash, and anything else.
 * Mirrors the scheme-gate posture of `safeImageUrl` in `safeUrl.ts`.
 */
export const marketingHrefSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (v) => {
      // Root-relative: starts with `/` but NOT `//` (not protocol-relative).
      if (v.startsWith('/') && !v.startsWith('//')) return true;
      // Absolute http(s) URL — require a real URL parse so the scheme is canonical.
      if (/^https?:\/\//i.test(v)) {
        try {
          const u = new URL(v);
          return u.protocol === 'http:' || u.protocol === 'https:';
        } catch {
          return false;
        }
      }
      return false;
    },
    { message: 'href must be a root-relative path (/…) or an http(s):// absolute URL' },
  );

/**
 * An image URL: root-relative path or `http(s)://` absolute URL, bounded length.
 * Same gate as `marketingHrefSchema` — the storefront enforces the PII-egress origin allowlist
 * at render time (mirrors `safeImageUrl` in `safeUrl.ts`).
 */
export const marketingImageUrlSchema = z
  .string()
  .min(1)
  .max(MAX_IMAGE_URL_LEN)
  .refine(
    (v) => {
      if (v.startsWith('/') && !v.startsWith('//')) return true;
      if (/^https?:\/\//i.test(v)) {
        try {
          const u = new URL(v);
          return u.protocol === 'http:' || u.protocol === 'https:';
        } catch {
          return false;
        }
      }
      return false;
    },
    { message: 'imageUrl must be a root-relative path (/…) or an http(s):// absolute URL' },
  );

// ── per-section settings schemas ──────────────────────────────────────────────────

/**
 * `hero-banner` settings — a full-width banner with an optional image, headline, sub-headline,
 * and a single call-to-action.
 */
export const heroBannerSettingsSchema = z
  .object({
    imageUrl: marketingImageUrlSchema.optional(),
    headline: z.string().min(1).max(MAX_HEADLINE_LEN),
    subheadline: z.string().max(MAX_SUBHEADLINE_LEN).optional(),
    ctaLabel: z.string().max(MAX_CTA_LABEL_LEN).optional(),
    ctaHref: marketingHrefSchema.optional(),
    /** Horizontal alignment of the banner text. Defaults to `center` when absent. */
    align: z.enum(['left', 'center', 'right']).optional(),
    /** Whether to render a dark overlay on the image for contrast. Defaults to `false`. */
    overlay: z.boolean().optional(),
  })
  .strict();

/** Validated `hero-banner` settings. */
export type HeroBannerSettings = z.infer<typeof heroBannerSettingsSchema>;

/**
 * `cta-banner` settings — a compact call-to-action strip with a headline, optional body copy,
 * and a required CTA button.
 */
export const ctaBannerSettingsSchema = z
  .object({
    headline: z.string().min(1).max(MAX_HEADLINE_LEN),
    body: z.string().max(MAX_BODY_LEN).optional(),
    ctaLabel: z.string().min(1).max(MAX_CTA_LABEL_LEN),
    ctaHref: marketingHrefSchema,
    /** Visual variant of the CTA button. Defaults to `primary` when absent. */
    variant: z.enum(['primary', 'secondary']).optional(),
  })
  .strict();

/** Validated `cta-banner` settings. */
export type CtaBannerSettings = z.infer<typeof ctaBannerSettingsSchema>;

/** A single promo tile — an image + label + link + optional caption. */
const promoTileSchema = z
  .object({
    imageUrl: marketingImageUrlSchema.optional(),
    label: z.string().min(1).max(MAX_TILE_LABEL_LEN),
    href: marketingHrefSchema,
    caption: z.string().max(MAX_TILE_CAPTION_LEN).optional(),
  })
  .strict();

/**
 * `promo-tiles` settings — a responsive grid of linked image tiles, capped at
 * {@link MAX_TILES} items (12).
 */
export const promoTilesSettingsSchema = z
  .object({
    /** Number of columns in the tile grid. Defaults to `3` when absent. */
    columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
    tiles: z.array(promoTileSchema).min(1).max(MAX_TILES),
  })
  .strict();

/** Validated `promo-tiles` settings. */
export type PromoTilesSettings = z.infer<typeof promoTilesSettingsSchema>;

/**
 * `rich-text` settings — author-supplied Markdown content.
 *
 * Content is stored as MARKDOWN (not raw HTML) to eliminate raw-HTML injection at the schema layer.
 * The storefront MUST render it through `react-markdown` + `rehype-sanitize` — as
 * `apps/storefront-next/src/components/Markdown.tsx` does for CMS pages — and must NEVER pass
 * `markdown` to `dangerouslySetInnerHTML` directly.
 */
export const richTextSettingsSchema = z
  .object({
    /** Markdown source. The storefront must sanitize on render (react-markdown + rehype-sanitize). */
    markdown: z.string().max(MAX_MARKDOWN_LEN),
  })
  .strict();

/** Validated `rich-text` settings. */
export type RichTextSettings = z.infer<typeof richTextSettingsSchema>;

// ── registry + discriminated union ────────────────────────────────────────────────

/**
 * All marketing section types as a const tuple — matches {@link SECTION_TYPE_RE}
 * (`/^[a-z][a-z0-9-]*$/`).
 */
export const MARKETING_SECTION_TYPES = [
  'hero-banner',
  'cta-banner',
  'promo-tiles',
  'rich-text',
] as const;

/** One of the known marketing section type strings. */
export type MarketingSectionType = (typeof MARKETING_SECTION_TYPES)[number];

/**
 * Registry mapping each marketing section type to its Zod settings schema. Import this in the API
 * validator, admin editor, and storefront renderer to share a single source of truth — never
 * duplicate the schema in multiple places.
 *
 * @example
 * ```ts
 * import { MARKETING_SECTION_REGISTRY } from '@sovecom/theme-sdk';
 * const result = MARKETING_SECTION_REGISTRY['hero-banner'].safeParse(settings);
 * ```
 */
export const MARKETING_SECTION_REGISTRY = {
  'hero-banner': heroBannerSettingsSchema,
  'cta-banner': ctaBannerSettingsSchema,
  'promo-tiles': promoTilesSettingsSchema,
  'rich-text': richTextSettingsSchema,
} as const satisfies Record<MarketingSectionType, z.ZodTypeAny>;

/**
 * A discriminated union of all marketing section descriptors `{ type, settings }`. Useful for
 * typed switch/dispatch in renderers that handle multiple section types.
 */
export type MarketingSectionDescriptor =
  | { type: 'hero-banner'; settings: HeroBannerSettings }
  | { type: 'cta-banner'; settings: CtaBannerSettings }
  | { type: 'promo-tiles'; settings: PromoTilesSettings }
  | { type: 'rich-text'; settings: RichTextSettings };

// ── parse helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse and validate marketing section settings for a given `type`. Returns the typed, validated
 * settings object, or `null` on any failure (unknown type, schema violation, etc.). Fail-closed —
 * never throws. Mirrors `parseWidget`'s defensive contract.
 *
 * @example
 * ```ts
 * const settings = parseMarketingSectionSettings('hero-banner', rawSettings);
 * if (!settings) return null; // skip the section — never render unvalidated data
 * ```
 */
export function parseMarketingSectionSettings(
  type: string,
  raw: unknown,
): HeroBannerSettings | CtaBannerSettings | PromoTilesSettings | RichTextSettings | null {
  if (!MARKETING_SECTION_TYPES.includes(type as MarketingSectionType)) return null;
  const schema = MARKETING_SECTION_REGISTRY[type as MarketingSectionType];
  const result = schema.safeParse(raw);
  return result.success ? (result.data as ReturnType<typeof schema.parse>) : null;
}

/**
 * Parse and validate a full marketing section descriptor `{ type, settings }`. Returns the typed
 * {@link MarketingSectionDescriptor}, or `null` on any failure. Fail-closed — never throws.
 *
 * @example
 * ```ts
 * const section = parseMarketingSection({ type: 'cta-banner', settings: rawSettings });
 * if (!section) return; // skip unknown / invalid sections
 * ```
 */
export function parseMarketingSection(raw: unknown): MarketingSectionDescriptor | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { type, settings } = raw as Record<string, unknown>;
  if (typeof type !== 'string') return null;
  const parsed = parseMarketingSectionSettings(type, settings);
  if (parsed === null) return null;
  // `type` is a known MarketingSectionType at this point (parseMarketingSectionSettings validated it).
  return { type: type as MarketingSectionType, settings: parsed } as MarketingSectionDescriptor;
}
