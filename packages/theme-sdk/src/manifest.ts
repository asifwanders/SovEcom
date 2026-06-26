import * as semver from 'semver';
import { z } from 'zod';
// Reuse the SHARED core-API primitives from @sovecom/module-sdk so BOTH SDKs gate against ONE
// `CORE_API_VERSION` and ONE byte cap (single source of truth; no duplication).
import { MANIFEST_MAX_BYTES, assertCoreCompatible } from '@sovecom/module-sdk';
// The `templates[]` declaration on the manifest references the page-type enum that the template
// contract owns. Reuse it so the manifest and the template validator agree on
// exactly which page types exist — no second enum to drift.
import { PAGE_TYPES, pageTypeSchema } from './template.js';

/**
 * Theme manifest verification — the single source of truth. Exported from `@sovecom/theme-sdk`, so
 * the published author SDK, the core runtime, and the contract-test suite all share ONE validator —
 * it is structurally impossible for them to drift.
 *
 * PURE functions — no Nest, no DB, no filesystem, NO code execution. These parse and validate a
 * `sovecom.theme.json` already read off disk. Themes are declarative ASSETS: there is no permission
 * allowlist and no namespaced-tables rule (a theme owns NO DB tables). The security properties
 * enforced here are data validation:
 *   - `.strict()` so unknown top-level keys are rejected (supply-chain hygiene);
 *   - the SAME byte cap as the module manifest on the raw bytes (reused from @sovecom/module-sdk);
 *   - a slug `name`, a valid-semver `version`, a valid-range `compatibleCore`;
 *   - a semver MAJOR gate against `CORE_API_VERSION` (reuses {@link assertCoreCompatible}).
 * The `settingsSchema` path is stored OPAQUE — the referenced JSON-schema file is never read here
 * (validation of theme settings against it is deferred).
 */

/** Bounds — generous but finite, to reject pathological manifests up front. */
const MAX_NAME_LEN = 64;
const MAX_DISPLAY_NAME_LEN = 128;
const MAX_SLOTS = 64;
const MAX_SLOT_LEN = 128;
const MAX_SETTINGS_SCHEMA_LEN = 256;

/**
 * Bounds on the OPTIONAL `templates[]` declaration. A theme may ship at most one template per page
 * type, so the array is capped at the number of page types (there is no point declaring more — the
 * per-page-uniqueness refine would reject the duplicate anyway). The path is a bounded relative slug
 * path ending in `.json`.
 */
const MAX_TEMPLATE_DECLS = PAGE_TYPES.length;
const MAX_TEMPLATE_PATH_LEN = 256;

/** Theme name: a slug that forms the install identity and a URL segment. */
export const THEME_NAME_RE = /^[a-z][a-z0-9-]*$/;
/** A slot slug the theme exposes/renders (same lowercase-slug shape as the module side). */
export const SLOT_SLUG_RE = /^[a-z][a-z0-9-]*$/;
/**
 * A template file path: a SAFE RELATIVE slug path ending in `.json`. Each segment is a lowercase
 * slug (a-z0-9, `_`, `-`), segments are `/`-joined, and the whole thing ends in `.json`. By
 * construction this admits NO leading `/` (absolute), NO `..` segment (traversal), NO `\` (Windows
 * separator), and NO `.`-only / hidden segments — the manifest is the ALLOWLIST of files the ingest
 * is permitted to read out of the extracted tree. The ingest re-asserts containment
 * against the extraction root as defence in depth; this regex is the first gate.
 */
export const TEMPLATE_PATH_RE = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*\.json$/;

/**
 * A single template declaration: which `page` the theme ships a template for and the RELATIVE `path`
 * to its JSON file inside the theme package. `.strict()` rejects unknown keys. The `path` is gated
 * by {@link TEMPLATE_PATH_RE} (no `..`, no leading `/`, slug segments, `.json` suffix) so the
 * declaration itself can never name a file outside the theme tree.
 */
export const themeTemplateDeclSchema = z
  .object({
    page: pageTypeSchema,
    path: z
      .string()
      .min(1)
      .max(MAX_TEMPLATE_PATH_LEN)
      .regex(TEMPLATE_PATH_RE, 'path must be a relative .json slug path (no "..", no leading "/")'),
  })
  .strict();

/** A validated single template declaration (`{ page, path }`). */
export type ThemeTemplateDecl = z.infer<typeof themeTemplateDeclSchema>;

/**
 * The manifest Zod schema. `.strict()` rejects unknown top-level keys. Mirrors the shape of
 * the module manifest where it overlaps (name/displayName/version/compatibleCore) so the two
 * verifiers stay recognisably similar.
 */
export const themeManifestSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MAX_NAME_LEN)
      .regex(THEME_NAME_RE, 'name must be a lowercase slug like "aurora"'),
    displayName: z.string().min(1).max(MAX_DISPLAY_NAME_LEN),
    version: z
      .string()
      .max(64)
      .refine((v) => semver.valid(v) !== null, 'version must be a valid semver'),
    compatibleCore: z
      .string()
      .max(256)
      .refine((v) => semver.validRange(v) !== null, 'compatibleCore must be a valid semver range'),
    slots: z
      .array(
        z.string().min(1).max(MAX_SLOT_LEN).regex(SLOT_SLUG_RE, 'slot must be a lowercase slug'),
      )
      .max(MAX_SLOTS)
      // A theme declares any given slot at most once — mirrors the module side's duplicate-slot
      // check so the two SDKs and `defineThemeSlots` agree.
      .refine((arr) => new Set(arr).size === arr.length, 'each slot must be declared at most once')
      .optional(),
    settingsSchema: z.string().min(1).max(MAX_SETTINGS_SCHEMA_LEN).optional(),
    // OPTIONAL wire-delivered page templates. A bounded array of `{ page, path }` declarations:
    // which page types the theme ships a template for, and the relative file to read at install.
    // AT MOST ONE entry per page type (the `.refine`), array capped at the page-type count.
    // Absent ⇒ a tokens/settings-only theme.
    templates: z
      .array(themeTemplateDeclSchema)
      .max(MAX_TEMPLATE_DECLS)
      .refine(
        (arr) => new Set(arr.map((t) => t.page)).size === arr.length,
        'each page type may be declared at most once in templates',
      )
      .optional(),
  })
  .strict();

export type ThemeManifest = z.infer<typeof themeManifestSchema>;

/**
 * Parse + verify a raw `sovecom.theme.json` string. Enforces the byte cap, parses JSON
 * (mapping a parse failure to a clear error), then runs the Zod schema. Returns the typed
 * manifest or throws a descriptive `Error`. PURE — no I/O, no code execution.
 */
export function parseAndVerifyThemeManifest(raw: string): ThemeManifest {
  const byteLen = Buffer.byteLength(raw, 'utf8');
  if (byteLen > MANIFEST_MAX_BYTES) {
    throw new Error(
      `theme manifest too large: ${byteLen} bytes exceeds the ${MANIFEST_MAX_BYTES}-byte cap`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('theme manifest is not valid JSON');
  }

  const result = themeManifestSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid theme manifest: ${detail}`);
  }
  return result.data;
}

// Re-export the shared core-API primitives so theme callers import a single surface
// (the semver gate is contract-level). A theme is gated identically to a module: same major as
// core, range must accept the current core.
export { MANIFEST_MAX_BYTES, assertCoreCompatible };
