/**
 * Server-only active-theme-name resolver.
 *
 * `resolveActiveThemeName` reads the SERVER-runtime `STOREFRONT_THEME` env, so it must never be pulled
 * into the client bundle (that would force a server env into the browser). It lived in `themes/index.ts`
 * — which the CLIENT `CartPageView` imports for `resolveTemplateSet` — so it was one careless client
 * import away from leaking. Splitting it into THIS module makes the boundary PHYSICAL: the client chrome
 * imports `@/themes` (the template helpers) and never this file.
 *
 * The `server-only` import is the build-time guard: if this module is ever pulled into a CLIENT bundle
 * (a `'use client'` graph), the bundler resolves `server-only` to a module that throws, failing the
 * build — turning a silent env leak into a loud, immediate error. It is a no-op on the server. Under
 * Vitest (no client-bundle resolution condition) it is also a no-op, so the unit tests import freely.
 */
import 'server-only';
import { DEFAULT_THEME_NAME } from './index';

/**
 * Resolve the active theme name — the single source of truth shared by the layout (chrome + tokens)
 * and every page (template resolution), preventing split-brain scenarios. Precedence:
 *   1. `STOREFRONT_THEME` — the server-runtime override: read server-side only, allowing self-host
 *      deploys to switch themes by restarting with a different env value (no rebuild needed). Never
 *      exposed to the browser.
 *   2. The live API theme's `name`.
 *   3. `default`.
 * `||` (not `??`) is intentional: an empty-string env or API name falls through to the next option, so a
 * blank name never selects a nameless theme.
 *
 * SERVER-ONLY: every caller is an RSC (layout + page routes + the cart RSC shell, which passes the
 * resolved name to the `CartPageView` client island as a prop).
 */
export function resolveActiveThemeName(theme?: { name?: string } | null): string {
  return process.env.STOREFRONT_THEME?.trim() || theme?.name?.trim() || DEFAULT_THEME_NAME;
}
