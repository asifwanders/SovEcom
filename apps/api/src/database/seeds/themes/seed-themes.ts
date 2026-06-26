/**
 * Follow-up A (post-3.11) — seeds the BUNDLED themes (`default`, `boutique`) into
 * `installed_themes` so the admin theme-switcher (3.9g) lists + activates them and activating
 * `boutique` makes the storefront render Boutique by active-NAME — no `STOREFRONT_THEME` env.
 *
 * WHY name-only rows suffice: the storefront layout resolves the active theme NAME from the API
 * (`GET /store/v1/theme` → `name`) and layers the bundled per-theme DEFAULT settings UNDER the live
 * API settings (`{ ...bundledDefaultSettings(name), ...apiSettings }`), and the pages call
 * `resolveTemplateSet(name)`. So a row carrying only `name` + a valid manifest + `settings: {}`
 * makes the storefront apply Boutique's palette/chrome/serif + render the bundled `boutique`
 * templates by name (Step 0 finding). These are DECLARATIVE token/chrome themes whose templates +
 * default settings ship in the storefront bundle; the DB row is the activation pointer, not the
 * asset store, so `templates` is `{}` (the storefront uses its bundled set for these names).
 *
 * IDEMPOTENT + NON-CLOBBERING (the hard requirements):
 *   - `ON CONFLICT (tenant_id, name) DO NOTHING` — an admin's edited settings/manifest are NEVER
 *     overwritten; a re-run inserts nothing.
 *   - `default` is set active ONLY IF the tenant has NO active theme yet (a guarded `UPDATE … WHERE
 *     NOT EXISTS(active row)`), so the seed never fights an admin's existing active choice and never
 *     transiently violates the partial `UNIQUE(tenant_id) WHERE is_active` index. Re-running is a
 *     no-op (once any theme is active, the guard is false).
 *
 * SELF-HEALING for EXISTING installs: `seed.ts` calls this whenever the seed SCRIPT is RUN
 * (`pnpm seed`) — NOT on every Nest boot. Because both the insert (ON CONFLICT DO NOTHING) and the
 * activate (guarded) are no-ops once present, an already-provisioned tenant that predates this
 * follow-up GAINS the two rows the next time an operator re-runs the seed, with zero risk to
 * existing state — so the backfill is a one-line `pnpm seed`, not a bespoke migration.
 *
 * NON-BLOCKING contract mirrors `seedDefaultPages` / `seedE2eFixture`: this function does NOT
 * swallow its own errors (so a test can assert on them); the install seed wraps the call in
 * try/catch (log + continue) so a theme-seed failure can never abort the baseline install seed.
 *
 * Tenant-scoped, SINGLE-tenant v1: `seed.ts` calls this ONCE for the single default tenant (not a
 * per-tenant loop); every row carries the passed `tenantId`. Uses the Drizzle insert API so the
 * `id` uuidv7 `$defaultFn` applies. The manifests below are constructed to PASS
 * `parseAndVerifyThemeManifest` AND `assertCoreCompatible` (the core-version MAJOR gate) — the
 * latter is self-checked when `BUNDLED_THEME_SEEDS` is built (below), so a future `CORE_API_VERSION`
 * bump fails LOUDLY at seed/test time instead of silently emitting manifests core would reject on a
 * later (re-)install.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { installedThemes } from '../../schema/installed_themes';
import { assertCoreCompatible, type ThemeManifest } from '../../../modules/theme-manifest';

/** Minimal db surface this seeder needs — satisfied by the app + harness Drizzle db. */
type SeedDb = Pick<PostgresJsDatabase<Record<string, unknown>>, 'insert' | 'execute'>;

/**
 * A bundled-theme seed row. The `manifest` is a minimal VALID `sovecom.theme.json` (passes
 * `parseAndVerifyThemeManifest`); `settings` + `templates` are EMPTY because the storefront ships
 * these themes' default settings + templates in its bundle and resolves them by `name`.
 */
export interface BundledThemeSeed {
  readonly name: string;
  readonly displayName: string;
  readonly version: string;
}

/** The name set active by default when a tenant has no active theme. */
export const DEFAULT_SEED_THEME_NAME = 'default';

/** Build the minimal VALID manifest for a bundled-theme seed (passes `parseAndVerifyThemeManifest`). */
export function bundledThemeManifest(seed: BundledThemeSeed): ThemeManifest {
  return {
    name: seed.name,
    displayName: seed.displayName,
    version: seed.version,
    compatibleCore: '^1.0.0',
  };
}

/**
 * The canonical bundled-theme list for the API seed. KEEP IN SYNC with the storefront's
 * `BUNDLED_THEMES` (`apps/storefront-next/src/themes/index.ts`) — these names are the coupling: a
 * seeded `name` only renders if the storefront has a bundled theme of that name. The two live in
 * separate apps (no shared import without a new package), so this is a deliberate, documented
 * mirror; adding a bundled theme means adding it in BOTH places.
 *
 * SELF-GATE against core: `compatibleCore: '^1.0.0'` must accept the CURRENT `CORE_API_VERSION` on
 * the SAME MAJOR. `parseAndVerifyThemeManifest` (the data validator) does NOT check this — only
 * `assertCoreCompatible` does, and the seed bypasses the install path that normally calls it. So we
 * call it HERE at module load on every constructed manifest: a `CORE_API_VERSION` MAJOR bump (e.g.
 * → 2.x) throws at seed/test time, forcing a deliberate `compatibleCore` bump rather than silently
 * emitting manifests core would reject on a later (re-)install.
 */
export const BUNDLED_THEME_SEEDS: readonly BundledThemeSeed[] = (
  [
    { name: 'default', displayName: 'Default', version: '1.0.0' },
    { name: 'boutique', displayName: 'Boutique', version: '1.0.0' },
  ] as const
).map((seed) => {
  // Fail LOUDLY at load if a future core version outdates these bundled manifests.
  assertCoreCompatible(bundledThemeManifest(seed));
  return seed;
});

/**
 * Idempotently seed the bundled themes for `tenantId` and ensure the tenant has an active theme.
 * Returns the count of theme rows inserted on this run (0 on a repeat run).
 *
 * Two steps, both no-ops on a re-run:
 *   1. INSERT `default` + `boutique` (is_active=false) with ON CONFLICT (tenant_id, name) DO NOTHING.
 *   2. If the tenant has NO active theme, set `default` active (guarded UPDATE). Never overrides an
 *      already-active theme (default OR an admin's non-default choice).
 */
export async function seedBundledThemes(db: SeedDb, tenantId: string): Promise<number> {
  const values = BUNDLED_THEME_SEEDS.map((seed) => ({
    tenantId,
    name: seed.name,
    version: seed.version,
    source: 'bundled',
    manifest: bundledThemeManifest(seed),
    settings: {},
    templates: {},
    isActive: false,
  }));

  const inserted = await db
    .insert(installedThemes)
    .values(values)
    // Re-run / pre-existing admin edits: skip, never error, NEVER overwrite.
    .onConflictDoNothing({ target: [installedThemes.tenantId, installedThemes.name] })
    .returning({ id: installedThemes.id });

  // Set `default` active ONLY IF this tenant has no active theme. The `WHERE NOT EXISTS(active row)`
  // guard makes it idempotent (no-op once anything is active) and non-clobbering (never unsets an
  // admin's active choice), and it can never transiently violate the partial one-active unique index
  // because it only ever ADDS the single active row when there are zero. Parameterized + scoped to
  // (tenant, name='default').
  await db.execute(sql`
    update installed_themes
       set is_active = true, updated_at = now()
     where tenant_id = ${tenantId}
       and name = ${DEFAULT_SEED_THEME_NAME}
       and not exists (
         select 1 from installed_themes a
          where a.tenant_id = ${tenantId} and a.is_active = true
       )
  `);

  return inserted.length;
}
