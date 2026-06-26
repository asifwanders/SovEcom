/**
 * the contract checks. Each function builds ONE {@link CheckResult}.
 * Hard checks reuse the SDK validators verbatim (single source of truth — no rule is re-declared);
 * the two advisory checks are clearly labelled heuristics that NEVER claim to have verified anything.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseAndVerifyManifest,
  assertCoreCompatible,
  MODULE_PERMISSION_ALLOWLIST,
  CORE_API_VERSION,
  type ModuleManifest,
  type ModulePermission,
} from './sdk.js';
import { scanModuleUsage, type UsageScan } from './detect-usage.js';
import type { CheckResult } from './types.js';

/**
 * Static capability→permission map. A capability key (from the AST scan) maps
 * to the manifest permission core would require. `serve` maps to NO permission (endpoint mounting
 * needs none). Keys not present here (unknown sdk.* shapes) require nothing — we never invent a
 * permission the allowlist does not contain.
 */
const CAPABILITY_PERMISSION: Record<string, ModulePermission | null> = {
  'store.products': 'read:products',
  'store.categories': 'read:categories',
  store: 'read:products', // bare `sdk.store.…` with an unrecognized sub-key: assume catalog read
  'admin.orders': 'read:orders',
  'admin.customers': 'read:customers',
  commerce: 'read:orders', // sdk.commerce.hasPurchased (B1) — the boolean purchase probe

  tables: 'write:own_tables',
  'events.on': 'subscribe:events',
  'events.emit': 'emit:events',
  events: 'subscribe:events',
  http: 'http:outbound',
  email: 'email:send',
  serve: null,
};

const ADVISORY_LIMIT_NOTE =
  'Static scan is best-effort: capabilities reached via aliasing, destructuring, or dynamic ' +
  'property access may be missed. The core broker enforces permissions at runtime regardless.';

/** Read the module's manifest file and either return the parsed manifest or a fail result. */
export interface ManifestLoad {
  readonly raw?: string;
  readonly manifest?: ModuleManifest;
  readonly error?: string;
}

export function loadManifest(moduleDir: string): ManifestLoad {
  // Bounded, synchronous read; parseAndVerifyManifest enforces the byte cap too.
  let raw: string;
  try {
    raw = readFileSync(join(moduleDir, 'sovecom.module.json'), 'utf8');
  } catch {
    return { error: 'sovecom.module.json not found or unreadable in the module directory' };
  }
  try {
    const manifest = parseAndVerifyManifest(raw);
    return { raw, manifest };
  } catch (e) {
    return { raw, error: (e as Error).message };
  }
}

// ── Check 1: manifest valid ─────────────────────────────────────────────────────────
export function checkManifestValid(load: ManifestLoad): CheckResult {
  if (load.manifest) {
    return hard('manifest-valid', 'Manifest valid', 'pass', [
      `sovecom.module.json parsed and validated for module "${load.manifest.name}".`,
    ]);
  }
  return hard('manifest-valid', 'Manifest valid', 'fail', [load.error ?? 'manifest invalid']);
}

// ── Check 2: tables namespaced ──────────────────────────────────────────────────────
export function checkTablesNamespaced(
  moduleDir: string,
  load: ManifestLoad,
  usage: UsageScan,
): CheckResult {
  // Derive the expected prefix from the manifest name when available; if the manifest failed to
  // parse we still surface any obviously-unnamespaced declared/DDL tables we can read.
  const name = load.manifest?.name ?? readRawName(load.raw);
  const offenders: string[] = [];

  if (!name) {
    // Without a name we cannot compute the prefix; report unknown rather than a false pass.
    const declared = readRawTables(load.raw);
    const ddl = [...usage.ddlTables];
    const suspicious = [...declared, ...ddl].filter((t) => !t.startsWith('mod_'));
    if (suspicious.length > 0) {
      return hard('tables-namespaced', 'Tables namespaced', 'fail', [
        `Could not determine module name, but these table names are not even mod_-prefixed: ${suspicious.join(', ')}`,
      ]);
    }
    return hard('tables-namespaced', 'Tables namespaced', 'fail', [
      'Manifest did not parse, so table namespacing could not be confirmed against a module name.',
    ]);
  }

  const prefix = `mod_${name}_`;
  const declared = load.manifest?.tables ?? readRawTables(load.raw);
  for (const t of declared) {
    if (!t.startsWith(prefix)) offenders.push(`declared table "${t}" must start with "${prefix}"`);
  }
  for (const t of usage.ddlTables) {
    if (!t.startsWith(prefix)) {
      offenders.push(`CREATE TABLE "${t}" in source must start with "${prefix}"`);
    }
  }

  if (offenders.length > 0) {
    return hard('tables-namespaced', 'Tables namespaced', 'fail', offenders);
  }
  return hard('tables-namespaced', 'Tables namespaced', 'pass', [
    `All declared tables and detected CREATE TABLE statements are namespaced "${prefix}*".`,
  ]);
}

// ── Check 3: permissions sufficient (declared ⊇ used) ───────────────────────────────
export function checkPermissionsSufficient(load: ManifestLoad, usage: UsageScan): CheckResult {
  if (!load.manifest) {
    return hard('permissions-sufficient', 'Permissions sufficient', 'fail', [
      'Cannot check permissions: the manifest did not parse.',
    ]);
  }
  const declared = new Set<string>(load.manifest.permissions);
  const requiredByCap = new Map<ModulePermission, string[]>(); // permission → capabilities needing it

  for (const cap of usage.capabilities) {
    const perm = CAPABILITY_PERMISSION[cap];
    if (perm === undefined || perm === null) continue; // unknown shape or serve → no permission
    const list = requiredByCap.get(perm) ?? [];
    list.push(cap);
    requiredByCap.set(perm, list);
  }

  const missing: string[] = [];
  for (const [perm, caps] of requiredByCap) {
    if (!declared.has(perm)) {
      missing.push(`missing permission "${perm}" (used via ${[...new Set(caps)].join(', ')})`);
    }
  }

  // Reverse advisory (least privilege): a declared permission nothing in the code uses.
  const used = new Set<ModulePermission>(requiredByCap.keys());
  const unused = (load.manifest.permissions as ModulePermission[]).filter((p) => !used.has(p));
  const advisories = unused.map(
    (p) =>
      `declared permission "${p}" is never used in source (least-privilege: consider removing). ${ADVISORY_LIMIT_NOTE}`,
  );

  if (missing.length > 0) {
    return {
      id: 'permissions-sufficient',
      title: 'Permissions sufficient',
      status: 'fail',
      kind: 'hard',
      messages: [...missing, ADVISORY_LIMIT_NOTE],
      advisories,
    };
  }
  return {
    id: 'permissions-sufficient',
    title: 'Permissions sufficient',
    status: 'pass',
    kind: 'hard',
    // Even a green verdict must carry the caveat: the static scan misses aliased/destructured/
    // dynamic capability use, so "sufficient" is best-effort and the broker is the real enforcer.
    messages: [
      'Every detected sdk.* capability maps to a declared permission.',
      ADVISORY_LIMIT_NOTE,
    ],
    advisories,
  };
}

// ── Check 4: core-version compatible ────────────────────────────────────────────────
export function checkCoreVersionCompatible(load: ManifestLoad): CheckResult {
  if (!load.manifest) {
    return hard('core-version-compatible', 'Core-version compatible', 'fail', [
      'Cannot check core compatibility: the manifest did not parse.',
    ]);
  }
  try {
    assertCoreCompatible(load.manifest);
    return hard('core-version-compatible', 'Core-version compatible', 'pass', [
      `compatibleCore "${load.manifest.compatibleCore}" accepts core API ${CORE_API_VERSION}.`,
    ]);
  } catch (e) {
    return hard('core-version-compatible', 'Core-version compatible', 'fail', [
      (e as Error).message,
    ]);
  }
}

// ── Check 5a/5b: ADVISORY (labelled heuristics — never claim verification) ───────────
export function advisoryMigrationReversibility(usage: UsageScan): CheckResult {
  const ddl = [...usage.ddlTables];
  const note =
    ddl.length > 0
      ? `Detected CREATE TABLE for: ${ddl.join(', ')}. ADVISORY only — this suite does NOT and ` +
        'cannot verify your migrations are reversible. Ensure every migration ships a tested down/rollback.'
      : 'ADVISORY only — migration reversibility is NOT verified by this suite. Ensure every ' +
        'migration ships a tested down/rollback path.';
  return advisory('migration-reversibility', 'Migration reversibility (advisory)', [note]);
}

export function advisoryWebhookIdempotency(usage: UsageScan): CheckResult {
  const subscribes = usage.capabilities.has('events.on');
  const note =
    (subscribes ? 'This module subscribes to events (sdk.events.on). ' : '') +
    'ADVISORY only — handler idempotency is NOT verified and cannot be proven statically. ' +
    'Events may be delivered more than once; make handlers idempotent (dedupe on a stable key).';
  return advisory('webhook-idempotency', 'Webhook/event handler idempotency (advisory)', [note]);
}

// ── helpers ─────────────────────────────────────────────────────────────────────────
function hard(id: string, title: string, status: 'pass' | 'fail', messages: string[]): CheckResult {
  return { id, title, status, kind: 'hard', messages, advisories: [] };
}

function advisory(id: string, title: string, messages: string[]): CheckResult {
  return { id, title, status: 'advisory', kind: 'advisory', messages, advisories: [] };
}

/** Best-effort raw-name extraction when the manifest failed full validation. */
function readRawName(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === 'string' ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort raw-tables extraction when the manifest failed full validation. */
function readRawTables(raw?: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { tables?: unknown };
    return Array.isArray(parsed.tables)
      ? parsed.tables.filter((t): t is string => typeof t === 'string')
      : [];
  } catch {
    return [];
  }
}

export { scanModuleUsage, MODULE_PERMISSION_ALLOWLIST };
