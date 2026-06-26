/**
 * the section/JSON-template contract for theme COMPOSITION.
 *
 * A page template is a declarative JSON document: a `page` type plus an ordered list of `sections`,
 * each a `{ type, settings? }` pair. The storefront runtime resolves each `type` against a section
 * registry and renders the sections in order. Like the manifest (see `manifest.ts`), this is a
 * declarative ASSET — there is NO code execution here: these are PURE validators + author-time typing
 * helpers, exactly mirroring `parseAndVerifyThemeManifest` / `defineTheme` / `defineThemeSettings`.
 *
 * The manifest is NOT touched: the `templates[]` declaration on the manifest itself is deferred to a
 * later stage. This file only ADDS the template contract; `apps/api` is unaffected.
 *
 * The byte cap is REUSED from `@sovecom/module-sdk` (via `manifest.ts`) so a template is gated by the
 * same finite size bound as a manifest — one home for the cap, no duplication.
 */
import { z } from 'zod';
import { MANIFEST_MAX_BYTES } from './manifest.js';

/** Generous-but-finite bound — reject pathological templates up front. */
const MAX_SECTIONS = 64;
/** A section type is a non-empty lowercase slug — same length bound the manifest uses for slots. */
const MAX_SECTION_TYPE_LEN = 128;
/** A layout section nests sub-sections in named `regions` — bound the region-name count. */
const MAX_REGIONS = 8;
/**
 * Max nesting depth of `regions`. Depth 0 = a top-level section; a layout section with
 * `regions` is depth 1; a section INSIDE a region is depth 2. Two levels of layout nesting is the
 * cap — enough for the `columns` sidebar/results split without unbounded recursion. Enforced in
 * {@link parseTemplate} (the schema validates shape/bounds; this walk rejects over-depth).
 */
export const MAX_REGION_DEPTH = 2;
/** A region name is a non-empty lowercase slug (e.g. `left`/`right`) — same shape as a section type. */
export const REGION_NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * The page types a theme can supply a template for. Only `home` is consumed at this stage; the rest
 * are DECLARED so later stages slot in (product/category/products/search/cart) without a contract
 * change. The literal-tuple `as const` lets {@link pageTypeSchema} mirror it exactly.
 */
export const PAGE_TYPES = ['home', 'product', 'category', 'products', 'search', 'cart'] as const;

/** A section `type`: the same lowercase-slug shape as a theme name / slot slug (`manifest.ts`). */
export const SECTION_TYPE_RE = /^[a-z][a-z0-9-]*$/;

/** Zod enum over {@link PAGE_TYPES}. Rejects any page type outside the declared set. */
export const pageTypeSchema = z.enum(PAGE_TYPES);

/**
 * A region-name key schema: a non-empty, bounded lowercase slug (e.g. `left`/`right`). Used as the
 * KEY schema of the `regions` record so a bad region name is rejected at parse time.
 */
export const regionNameSchema = z
  .string()
  .min(1)
  .max(MAX_SECTION_TYPE_LEN)
  .regex(REGION_NAME_RE, 'region name must be a lowercase slug like "left"');

/**
 * A single template section: a slug `type`, an optional opaque `settings` bag, and an
 * OPTIONAL `regions` map for LAYOUT nesting — named region → an ordered list of nested sections,
 * recursively the same shape. `.strict()` rejects unknown keys (supply-chain hygiene, mirrors the
 * manifest). `settings` is `Record<string, unknown>` — opaque on the wire, validated against the
 * section's own shape at render time (not here).
 *
 * The schema is SELF-REFERENTIAL: `regions` values are arrays of `templateSectionSchema`. The
 * recursion uses the canonical Zod 4 pattern — a FIELD-LEVEL `z.lazy()` that defers the self-reference
 * to validation time, so `templateSectionSchema` is fully initialised before the thunk dereferences
 * it (no eager-`.strict()` ordering hazard). Structural bounds (region count, per-region section cap,
 * region-name shape) are enforced HERE; the max NESTING DEPTH is enforced separately in
 * {@link parseTemplate} (a post-parse walk), so an over-deep template is rejected with a clear error.
 */
export const templateSectionSchema: z.ZodType<TemplateSection> = z
  .object({
    type: z
      .string()
      .min(1)
      .max(MAX_SECTION_TYPE_LEN)
      .regex(SECTION_TYPE_RE, 'section type must be a lowercase slug like "featured-products"'),
    settings: z.record(z.string(), z.unknown()).optional(),
    // Canonical Zod 4 recursion: a field-level `z.lazy()` thunk yields a `regions` record of
    // region-name → bounded array of nested sections; the region-COUNT cap is a `.refine` on the
    // record. Nesting DEPTH (≤ MAX_REGION_DEPTH) is enforced separately in `parseTemplate`.
    regions: z
      .lazy(() =>
        z
          .record(regionNameSchema, z.array(templateSectionSchema).max(MAX_SECTIONS))
          .refine((r) => Object.keys(r).length <= MAX_REGIONS, {
            message: `a section may declare at most ${MAX_REGIONS} regions`,
          }),
      )
      .optional(),
  })
  .strict() as z.ZodType<TemplateSection>;

/**
 * A page template: a known `page` type plus an ordered, bounded list of sections. `.strict()` rejects
 * unknown top-level keys. The section count is capped at {@link MAX_SECTIONS} to reject runaway docs.
 */
export const templateSchema = z
  .object({
    page: pageTypeSchema,
    sections: z.array(templateSectionSchema).max(MAX_SECTIONS),
  })
  .strict();

/** A validated page type (one of {@link PAGE_TYPES}). */
export type PageType = z.infer<typeof pageTypeSchema>;
/**
 * A validated template section (`{ type, settings?, regions? }`). SELF-REFERENTIAL:
 * `regions` maps a region name → a list of nested `TemplateSection`s. Hand-written rather than
 * `z.infer`'d so the recursion is explicit + stable across the getter-based schema.
 */
export interface TemplateSection {
  type: string;
  settings?: Record<string, unknown>;
  regions?: Record<string, TemplateSection[]>;
}
/** A validated page template (`{ page, sections }`). */
export type ThemeTemplate = z.infer<typeof templateSchema>;

/**
 * Parse + verify a raw template JSON string. Enforces the byte cap (reused from the manifest), parses
 * JSON (mapping a parse failure to a clear error), then runs the Zod schema, aggregating issues into a
 * descriptive message. Returns the typed template or throws a descriptive `Error`. PURE — no I/O, no
 * code execution. Mirrors {@link parseAndVerifyThemeManifest}.
 */
export function parseTemplate(raw: string): ThemeTemplate {
  const byteLen = Buffer.byteLength(raw, 'utf8');
  if (byteLen > MANIFEST_MAX_BYTES) {
    throw new Error(
      `theme template too large: ${byteLen} bytes exceeds the ${MANIFEST_MAX_BYTES}-byte cap`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('theme template is not valid JSON');
  }

  const result = templateSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid theme template: ${detail}`);
  }

  // Enforce the max nesting depth. The Zod schema validates the shape + structural
  // bounds at every level (region count, per-region cap, region-name slug, .strict), but a getter-
  // based recursive schema can't bound DEPTH — so reject an over-deep `regions` tree here. Depth 0 =
  // a top-level section; a section inside a region is depth 1; nested again is depth 2; deeper throws.
  for (const section of result.data.sections) assertRegionDepth(section, 0);
  return result.data;
}

/**
 * Recursively assert no `regions` nesting exceeds {@link MAX_REGION_DEPTH}. `depth` is the current
 * section's depth (0 at the top level). Throws a descriptive `Error` on the first over-deep section.
 */
function assertRegionDepth(section: TemplateSection, depth: number): void {
  if (!section.regions) return;
  if (depth >= MAX_REGION_DEPTH) {
    throw new Error(
      `invalid theme template: region nesting exceeds the max depth of ${MAX_REGION_DEPTH}`,
    );
  }
  for (const nested of Object.values(section.regions)) {
    for (const child of nested) assertRegionDepth(child, depth + 1);
  }
}

/**
 * Validate an author's template config and return the validated, typed {@link ThemeTemplate}. Runs the
 * SAME `parseTemplate` pipeline (round-trips through JSON), so what passes here is exactly what the
 * runtime accepts. Throws a clear `Error` on invalid input. NO code execution. Mirrors {@link defineTheme}.
 */
export function defineTemplate(config: ThemeTemplate): ThemeTemplate {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('defineTemplate(config): config must be an object');
  }
  return parseTemplate(JSON.stringify(config));
}

/**
 * An author-time section DEFINITION: the section `type` plus an OPTIONAL phantom `settings` default
 * carrying the settings type `T`. Purely a typing vehicle — see {@link defineSection}.
 */
export interface SectionDef<T> {
  readonly type: string;
  readonly settings?: T;
}

/**
 * Identity helper that types-and-returns a section definition, pinning the settings type `T` for
 * author editor autocomplete. A pure no-op at runtime (returns its argument unchanged) — it does NOT
 * validate or read anything. Mirrors {@link defineThemeSettings}'s pure-typing style.
 */
export function defineSection<T>(def: SectionDef<T>): SectionDef<T> {
  return def;
}
