/**
 * BUNDLED_MODULES — the platform's BUILT-IN ("bundled") module registry (mirrors the
 * BUNDLED_THEMES shape in `database/seeds/themes/seed-themes.ts`). These are the modules the
 * platform SHIPS and offers the operator at first-run setup; an operator can install + enable
 * any of them during onboarding.
 *
 * SINGLE SOURCE OF TRUTH: the id + module-dir + description list lives in the co-located
 * `bundled-modules.catalog.json`, which is read by BOTH this runtime registry AND
 * `scripts/pack-bundled-modules.mjs` (the build step). Add an entry there → it is packed by
 * `pnpm pack:bundled-modules` AND offered at setup, with NO change here. `id` MUST equal the
 * module's manifest `name`.
 *
 * SECURITY (this feeds a privileged, token-gated provisioning path):
 *   - {@link isBundledModuleId} is the ALLOWLIST gate. The setup install path validates every
 *     requested id against it BEFORE touching the filesystem/ingest, so an arbitrary or
 *     path-traversing name (`../evil`, `/etc/passwd`, `reviews/../x`) is rejected with NO FS
 *     access — there is no arbitrary name → no arbitrary-package install at setup.
 *   - {@link bundledTgzPath} resolves the `.tgz` for a built-in by joining the FIXED bundled-
 *     modules dir with `<id>.tgz`. It is only ever called for an id that already passed the
 *     allowlist, AND it asserts the resolved path stays inside the bundled dir (defence in
 *     depth) — a traversal can never escape the dir even if a future caller skips the gate.
 *
 * The display metadata (`displayName`, `permissions`, `slots`) is the module's OWN manifest,
 * which the pack step copies verbatim to `<id>.module.json` next to the `.tgz`; the registry
 * reads it from there at request time (see {@link readBundledManifest}). `description` is the
 * operator-facing one-liner from `bundled-modules.catalog.json` (the manifest schema is `.strict()` and
 * carries no description field — so it lives in the registry, not the manifest).
 */
import * as fs from 'fs';
import * as path from 'path';
import bundledModulesJson from './bundled-modules.catalog.json';

/** A registry entry as declared in `bundled-modules.catalog.json` (the curated, packable list). */
export interface BundledModuleEntry {
  /** The module id — MUST equal the manifest `name` (the install/enable key + `.tgz` basename). */
  readonly id: string;
  /** Module source dir, relative to the repo root (used by the pack step, not at runtime). */
  readonly dir: string;
  /** Operator-facing one-liner shown on the setup card (manifests carry no description). */
  readonly description: string;
}

/** A bundled module's manifest fields surfaced to the setup catalog (from `<id>.module.json`). */
export interface BundledManifestFields {
  readonly displayName: string;
  readonly permissions: string[];
  readonly slots: { slot: string; component: string }[];
}

/**
 * The canonical bundled-module list. Frozen so a consumer cannot mutate the allowlist at
 * runtime. Sourced from `bundled-modules.catalog.json` (the single list both this registry and the
 * pack step read).
 */
export const BUNDLED_MODULES: readonly BundledModuleEntry[] = Object.freeze(
  (bundledModulesJson.modules ?? []).map((m) =>
    Object.freeze({ id: m.id, dir: m.dir, description: m.description }),
  ),
);

/** The set of valid bundled ids — the install ALLOWLIST. */
const BUNDLED_IDS: ReadonlySet<string> = new Set(BUNDLED_MODULES.map((m) => m.id));

/**
 * Where the packed bundled `.tgz` (+ copied `<id>.module.json`) live at runtime. Defaults to
 * `apps/api/bundled-modules` (relative to the compiled `dist/` two levels up: dist/modules →
 * apps/api), overridable via `BUNDLED_MODULES_PATH` for non-standard deploy layouts.
 */
export function bundledModulesDir(): string {
  const fromEnv = process.env['BUNDLED_MODULES_PATH'];
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv);
  // __dirname at runtime = <apiRoot>/dist/modules → the bundled dir is <apiRoot>/bundled-modules.
  return path.resolve(__dirname, '..', '..', 'bundled-modules');
}

/**
 * Is `id` a known bundled module? This is the ALLOWLIST gate the setup install path MUST call
 * before any filesystem/ingest work. A non-string, an unknown name, or anything carrying a path
 * separator / traversal returns false (the id is compared as a literal against the frozen set —
 * never interpolated into a path before this check passes).
 */
export function isBundledModuleId(id: unknown): id is string {
  return typeof id === 'string' && BUNDLED_IDS.has(id);
}

/** The registry entry for a bundled id, or undefined. */
export function bundledModule(id: string): BundledModuleEntry | undefined {
  return BUNDLED_MODULES.find((m) => m.id === id);
}

/**
 * Resolve the `.tgz` path for a bundled id. ONLY call after {@link isBundledModuleId} has passed.
 * Defence in depth: re-rejects an id that is not on the allowlist, and asserts the resolved path
 * stays strictly inside the bundled dir (so a traversal can never escape even if the gate were
 * skipped). Returns the absolute `.tgz` path — existence is the caller's concern.
 */
export function bundledTgzPath(id: string): string {
  if (!isBundledModuleId(id)) {
    throw new Error(`refusing to resolve a non-bundled module id: ${id}`);
  }
  const dir = bundledModulesDir();
  const file = path.resolve(dir, `${id}.tgz`);
  // `startsWith(dir + path.sep)` is the AUTHORITATIVE containment guard (N1): the resolved path must
  // live strictly inside the bundled dir. (`id` is already set-validated, so it carries no separator
  // or traversal — but we re-assert containment here so the boundary never relies on the gate alone.)
  if (!file.startsWith(dir + path.sep)) {
    throw new Error(`refusing bundled tgz path outside the bundled dir: ${id}`);
  }
  return file;
}

/**
 * Read the bundled module's manifest fields from `<id>.module.json` next to its `.tgz` (copied
 * there verbatim by the pack step). Returns null if the file is absent, unreadable, or malformed.
 * ONLY called for an allowlisted id.
 *
 * The two consumers treat a null differently (S2):
 *   - the setup CATALOG (`listModules`) falls back to the id as the display name with empty
 *     permissions/slots, so a not-yet-packed built-in still LISTS honestly rather than 500-ing;
 *   - the setup INSTALL path treats null as a HARD FAILURE — a platform built-in with a missing
 *     sidecar is a broken package, never installed with an empty `[]` grant (it lands in `failed[]`).
 */
export function readBundledManifest(id: string): BundledManifestFields | null {
  if (!isBundledModuleId(id)) return null;
  const dir = bundledModulesDir();
  const file = path.resolve(dir, `${id}.module.json`);
  // `startsWith(dir + path.sep)` is the AUTHORITATIVE containment guard (N1) — the resolved sidecar
  // path must live strictly inside the bundled dir before we read it.
  if (!file.startsWith(dir + path.sep)) {
    return null;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const m = parsed as Record<string, unknown>;
  const displayName = typeof m['displayName'] === 'string' ? (m['displayName'] as string) : id;
  const permissions = Array.isArray(m['permissions'])
    ? (m['permissions'] as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
  const slots = Array.isArray(m['slots'])
    ? (m['slots'] as unknown[])
        .filter((s): s is { slot: string; component: string } => {
          if (typeof s !== 'object' || s === null) return false;
          const e = s as Record<string, unknown>;
          return typeof e['slot'] === 'string' && typeof e['component'] === 'string';
        })
        .map((s) => ({ slot: s.slot, component: s.component }))
    : [];
  return { displayName, permissions, slots };
}
