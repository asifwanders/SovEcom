/**
 * the author-facing `defineTheme` helper.
 *
 * `defineTheme(config)` is the theme twin of `@sovecom/module-sdk`'s `defineModule`, with one
 * LOAD-BEARING difference: a theme is a declarative ASSET — there is NO
 * `activate`, NO worker, NO runtime entrypoint. So `defineTheme` does not wrap an executable
 * body; it VALIDATES the author's config against the canonical manifest schema and returns the
 * typed, validated `ThemeManifest` OBJECT. It is a build-/author-time helper, never a runtime
 * entry. A misconfigured theme therefore fails fast with a clear message at author build time,
 * not as an opaque install rejection.
 */
import { parseAndVerifyThemeManifest, type ThemeManifest } from './manifest.js';

/**
 * Author-supplied config for {@link defineTheme}. Structurally the manifest shape itself — the
 * author writes their `sovecom.theme.json` content as a typed object and `defineTheme` validates
 * it. Kept as a distinct alias so the authoring intent (input) reads differently from the
 * validated output ({@link ThemeManifest}).
 *
 * The `slots` INPUT is widened to `readonly string[]` so the documented compose pattern
 * `defineTheme({ slots: defineThemeSlots([...]) })` typechecks — `defineThemeSlots` returns a
 * FROZEN (`readonly`) array and that must be assignable here. The runtime validation is unchanged:
 * `defineTheme` round-trips the config through `parseAndVerifyThemeManifest`, so the returned
 * {@link ThemeManifest} still carries the schema-validated mutable `string[]`.
 */
export type DefineThemeConfig = Omit<ThemeManifest, 'slots'> & {
  readonly slots?: readonly string[];
};

/**
 * Validate an author's theme config and return the validated, typed {@link ThemeManifest}.
 * Runs the SAME `parseAndVerifyThemeManifest` the core runs at install time (single source of
 * truth), so what passes here is exactly what the core will accept. Throws a clear `Error` on
 * invalid input (bad slug, invalid semver, unknown key, oversized, …). NO code execution.
 */
export function defineTheme(config: DefineThemeConfig): ThemeManifest {
  if (config === null || typeof config !== 'object') {
    throw new TypeError('defineTheme(config): config must be an object');
  }
  // Round-trip through the canonical validator: serialise, then parse+verify. This reuses the
  // one byte-cap + `.strict()` + slug + semver pipeline the core enforces, so `defineTheme`
  // cannot drift from install-time validation.
  return parseAndVerifyThemeManifest(JSON.stringify(config));
}
