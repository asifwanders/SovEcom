import * as semver from 'semver';
import { z } from 'zod';
import { CORE_API_VERSION } from './core-version.js';

/**
 * Module manifest verification — the single source of truth for manifest validation. Exported from
 * `@sovecom/module-sdk`, so the published author SDK, the core runtime, and the contract-test suite
 * all share ONE validator — it is structurally impossible for them to drift.
 *
 * PURE functions — no Nest, no DB, no filesystem, NO code execution. These parse and validate a
 * `sovecom.module.json` already read off disk. The headline security properties are enforced here
 * as data validation:
 * - a closed, default-deny permission allowlist;
 * - every declared table must be namespaced `mod_<name>_*`;
 * - `.strict()` so unknown top-level keys are rejected (supply-chain hygiene);
 * - a byte cap on the raw manifest;
 * - a semver MAJOR gate against `CORE_API_VERSION`.
 */

/**
 * The closed module-capability permission vocabulary. DISTINCT from the
 * RBAC `PERMISSIONS` that gate admin users — this is what a module may REQUEST. A manifest
 * declaring anything outside this set is rejected at verification (default-deny). v1 set:
 */
export const MODULE_PERMISSION_ALLOWLIST = [
  'read:products',
  'read:categories',
  'read:orders',
  'read:customers',
  'write:own_tables',
  'emit:events',
  'subscribe:events',
  'http:outbound',
  'email:send',
] as const;
// NOTE: `register:slot` was REMOVED. Slots are now fully DECLARATIVE metadata
// (`slots: { slot, component }[]` below) derived across enabled modules — there is no runtime
// slot-registration call, so no permission gates one.

export type ModulePermission = (typeof MODULE_PERMISSION_ALLOWLIST)[number];

/** Hard cap on the raw `sovecom.module.json` byte length (64 KiB). */
export const MANIFEST_MAX_BYTES = 64 * 1024;

/** Bounds — generous but finite, to reject pathological manifests up front. */
const MAX_NAME_LEN = 64;
const MAX_DISPLAY_NAME_LEN = 128;
const MAX_PERMISSIONS = MODULE_PERMISSION_ALLOWLIST.length;
const MAX_SLOTS = 64;
const MAX_SLOT_LEN = 128;
const MAX_TABLES = 64;
const MAX_TABLE_LEN = 128;
const MAX_SETTINGS_SCHEMA_LEN = 256;

/** Module name: a slug that forms the `mod_<name>_*` prefix and a URL segment. */
export const MODULE_NAME_RE = /^[a-z][a-z0-9-]*$/;
/** A slot slug AND a component-id slug (same lowercase-slug shape). */
export const SLOT_SLUG_RE = /^[a-z][a-z0-9-]*$/;
/** The suffix after the `mod_<name>_` table prefix: lowercase, [a-z0-9_]. */
export const TABLE_SUFFIX_RE = /^[a-z0-9_]+$/;

/**
 * A single slot DECLARATION: the slot this module FILLS + the component id the
 * storefront maps to the module's UI. Fully declarative metadata; the slot registry is DERIVED from
 * these across all ENABLED modules. `.strict()` so unknown keys are rejected; both fields are
 * bounded lowercase slugs.
 */
const slotEntrySchema = z
  .object({
    slot: z.string().min(1).max(MAX_SLOT_LEN).regex(SLOT_SLUG_RE, 'slot must be a lowercase slug'),
    component: z
      .string()
      .min(1)
      .max(MAX_SLOT_LEN)
      .regex(SLOT_SLUG_RE, 'component must be a lowercase slug'),
  })
  .strict();

const permissionEnum = z.enum(MODULE_PERMISSION_ALLOWLIST);

/**
 * The manifest Zod schema. `.strict()` rejects unknown top-level keys. `tables` are
 * validated for shape here and re-checked against the parsed `name` in a `superRefine`
 * below (the namespace prefix depends on the name).
 */
const baseManifestSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MAX_NAME_LEN)
      .regex(MODULE_NAME_RE, 'name must be a lowercase slug like "wishlist"'),
    displayName: z.string().min(1).max(MAX_DISPLAY_NAME_LEN),
    version: z
      .string()
      .max(64)
      .refine((v) => semver.valid(v) !== null, 'version must be a valid semver'),
    compatibleCore: z
      .string()
      .max(256)
      .refine((v) => semver.validRange(v) !== null, 'compatibleCore must be a valid semver range'),
    permissions: z.array(permissionEnum).max(MAX_PERMISSIONS),
    slots: z.array(slotEntrySchema).max(MAX_SLOTS).optional(),
    settings: z
      .object({ schema: z.string().min(1).max(MAX_SETTINGS_SCHEMA_LEN) })
      .strict()
      .optional(),
    tables: z.array(z.string().min(1).max(MAX_TABLE_LEN)).max(MAX_TABLES).optional(),
  })
  .strict();

export const moduleManifestSchema = baseManifestSchema.superRefine((manifest, ctx) => {
  // Every declared table must be namespaced to THIS module: `mod_<name>_<suffix>` (modules never
  // touch core tables). The prefix is derived from the parsed name, so this cross-field check lives
  // here. We compare the prefix as a LITERAL string and validate the suffix with a STATIC regex —
  // never build a dynamic `RegExp` from `manifest.name`. (The slug `MODULE_NAME_RE` already forbids
  // regex metacharacters, so interpolation would be safe today, but a literal compare is
  // injection-proof regardless of how the slug rule evolves.)
  const prefix = `mod_${manifest.name}_`;
  (manifest.tables ?? []).forEach((table, i) => {
    if (!(table.startsWith(prefix) && TABLE_SUFFIX_RE.test(table.slice(prefix.length)))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tables', i],
        message: `table "${table}" must be namespaced "${prefix}<name>" (lowercase, [a-z0-9_])`,
      });
    }
  });

  // A module fills any given slot at most once. Declaring the same slot twice (with different
  // components) is meaningless and would otherwise be read as a one-module self-"conflict" the
  // registry can only resolve by silently keeping the first component (the registry derives one
  // component per (module, slot)). Reject the duplicate at the boundary.
  const seenSlots = new Set<string>();
  (manifest.slots ?? []).forEach((entry, i) => {
    if (seenSlots.has(entry.slot)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['slots', i, 'slot'],
        message: `slot "${entry.slot}" is declared more than once; a module may target a slot at most once`,
      });
    }
    seenSlots.add(entry.slot);
  });
});

export type ModuleManifest = z.infer<typeof moduleManifestSchema>;

/** A single declared slot target — `{ slot, component }`. */
export type ModuleSlotEntry = z.infer<typeof slotEntrySchema>;

/**
 * Parse + verify a raw `sovecom.module.json` string. Enforces the byte cap, parses JSON
 * (mapping a parse failure to a clear error), then runs the Zod schema. Returns the typed
 * manifest or throws a descriptive `Error`. PURE — no I/O, no code execution.
 */
export function parseAndVerifyManifest(raw: string): ModuleManifest {
  const byteLen = Buffer.byteLength(raw, 'utf8');
  if (byteLen > MANIFEST_MAX_BYTES) {
    throw new Error(
      `module manifest too large: ${byteLen} bytes exceeds the ${MANIFEST_MAX_BYTES}-byte cap`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('module manifest is not valid JSON');
  }

  const result = moduleManifestSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid module manifest: ${detail}`);
  }
  return result.data;
}

/**
 * Semver gate. The module's `compatibleCore` range must accept the current `CORE_API_VERSION`, AND
 * must do so on the SAME MAJOR — a major bump in core means modules pinned to an old major refuse
 * to load. Throws a clear `Error` on mismatch; the caller maps it to HTTP 422.
 */
export function assertCoreCompatible(manifest: Pick<ModuleManifest, 'compatibleCore'>): void {
  const range = manifest.compatibleCore;
  const satisfies = semver.satisfies(CORE_API_VERSION, range);
  const coreMajor = semver.major(CORE_API_VERSION);

  // Confirm the range's LOWER BOUND shares the core MAJOR. Combined with the `satisfies`
  // check above this means: the current core must fall inside the range AND the range may not
  // begin below/above the core major. So `^1.0.0`/`>=1.0.0`/`1.x` pass on a 1.x core, while a
  // module pinned to an old major (`^0.x`, `<=0.9`) or a future-only major (`>=2`, `^2.0.0`)
  // is refused. A range whose lower bound is the core major but whose UPPER bound spills into
  // a later major (e.g. `>=1.0.0 <3.0.0`) is still accepted — the module legitimately supports
  // this core; it will be re-gated (and refused) once core itself bumps to that later major,
  // because the lower-bound-major check then no longer matches.
  const min = semver.minVersion(range);
  const sameMajor = min !== null && semver.major(min) === coreMajor;

  if (!satisfies || !sameMajor) {
    throw new Error(
      `module is not compatible with this core: requires "${range}" but core API is ` +
        `${CORE_API_VERSION} (major ${coreMajor})`,
    );
  }
}
