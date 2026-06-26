/**
 * the theme contract checks. Each function builds ONE
 * {@link CheckResult}. ALL theme checks are HARD (a theme has no code, so there is nothing to
 * heuristically guess at — unlike the module sibling's advisory migration/webhook reminders).
 *
 * The three contract checks REUSE the theme SDK's validators verbatim (single source of truth,
 * no rule re-declared): `parseAndVerifyThemeManifest`, `assertCoreCompatible`, and
 * `SLOT_SLUG_RE`. The fourth — LICENSE is MIT — is the theme-specific, load-bearing boundary:
 * a theme is derivative of the MIT reference storefront, so its generated LICENSE MUST be
 * MIT and MUST NOT be the AGPL the module side carries.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseAndVerifyThemeManifest,
  assertCoreCompatible,
  SLOT_SLUG_RE,
  CORE_API_VERSION,
  type ThemeManifest,
} from './sdk.js';
import type { CheckResult } from './types.js';

/** Bound the LICENSE read so a pathological file cannot exhaust memory. */
const LICENSE_MAX_BYTES = 64 * 1024;

/** Read the theme's manifest file and either return the parsed manifest or a fail result. */
export interface ManifestLoad {
  readonly raw?: string;
  readonly manifest?: ThemeManifest;
  readonly error?: string;
}

export function loadManifest(themeDir: string): ManifestLoad {
  // Bounded, synchronous read; parseAndVerifyThemeManifest enforces the byte cap too.
  let raw: string;
  try {
    raw = readFileSync(join(themeDir, 'sovecom.theme.json'), 'utf8');
  } catch {
    return { error: 'sovecom.theme.json not found or unreadable in the theme directory' };
  }
  try {
    const manifest = parseAndVerifyThemeManifest(raw);
    return { raw, manifest };
  } catch (e) {
    return { raw, error: (e as Error).message };
  }
}

// ── Check 1: manifest valid ─────────────────────────────────────────────────────────
export function checkManifestValid(load: ManifestLoad): CheckResult {
  if (load.manifest) {
    return hard('manifest-valid', 'Manifest valid', 'pass', [
      `sovecom.theme.json parsed and validated for theme "${load.manifest.name}".`,
    ]);
  }
  return hard('manifest-valid', 'Manifest valid', 'fail', [load.error ?? 'manifest invalid']);
}

// ── Check 2: core-version compatible ────────────────────────────────────────────────
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

// ── Check 3: slots are valid slugs ──────────────────────────────────────────────────
export function checkSlotsValid(load: ManifestLoad): CheckResult {
  if (!load.manifest) {
    // The slots check is a refinement of manifest validity; without a parsed manifest we cannot
    // confirm the slot slugs against the SDK rule, so we report (honestly) a failure.
    return hard('slots-valid', 'Slots are valid slugs', 'fail', [
      'Cannot check slot slugs: the manifest did not parse.',
    ]);
  }
  const slots = load.manifest.slots ?? [];
  const offenders = slots.filter((s) => !SLOT_SLUG_RE.test(s));
  if (offenders.length > 0) {
    return hard(
      'slots-valid',
      'Slots are valid slugs',
      'fail',
      offenders.map((s) => `slot "${s}" must match the lowercase-slug rule ${SLOT_SLUG_RE.source}`),
    );
  }
  return hard('slots-valid', 'Slots are valid slugs', 'pass', [
    slots.length > 0
      ? `All ${slots.length} declared slot(s) match the slug rule ${SLOT_SLUG_RE.source}.`
      : 'No slots declared (a theme may declare zero slots).',
  ]);
}

// ── Check 4: LICENSE is MIT (the load-bearing boundary) ─────────────────
export function checkLicenseMit(themeDir: string): CheckResult {
  let raw: string;
  try {
    raw = readFileSync(join(themeDir, 'LICENSE'), 'utf8');
  } catch {
    return hard('license-mit', 'LICENSE is MIT', 'fail', [
      'LICENSE not found in the theme directory. A theme is MIT-licensed; ship an ' +
        'MIT LICENSE so commercial theme authors can use it.',
    ]);
  }
  if (Buffer.byteLength(raw, 'utf8') > LICENSE_MAX_BYTES) {
    return hard('license-mit', 'LICENSE is MIT', 'fail', [
      `LICENSE is larger than ${LICENSE_MAX_BYTES} bytes; expected the short MIT text.`,
    ]);
  }

  const norm = normalizeLicense(raw);

  // Reject the AGPL the module side carries — getting this wrong locks out commercial authors.
  if (isAgpl(norm)) {
    return hard('license-mit', 'LICENSE is MIT', 'fail', [
      'LICENSE appears to be the GNU AFFERO GENERAL PUBLIC LICENSE (AGPL). A theme must be MIT ' +
        '— AGPL is for the core and for modules, not for themes.',
    ]);
  }

  if (isMit(norm)) {
    return hard('license-mit', 'LICENSE is MIT', 'pass', ['LICENSE is the MIT License.']);
  }

  return hard('license-mit', 'LICENSE is MIT', 'fail', [
    'LICENSE does not match the MIT License text. A theme must ship the MIT License.',
  ]);
}

// ── LICENSE detection helpers ─────────────────────────────────────────────────────────
/** Lowercase + collapse all runs of whitespace to single spaces, so layout/wrapping never matters. */
function normalizeLicense(raw: string): string {
  // Fold typographic (curly) quotes to ASCII first — editors often auto-convert the `"AS IS"`
  // in MIT, and a valid MIT license must not fail closed over a smart-quote substitution.
  return raw.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Detect the canonical MIT License by its load-bearing phrases. We require BOTH the permission grant
 * and the "as is" warranty disclaimer that are unique to the MIT text, so a file that merely
 * mentions "mit" in passing does not pass.
 */
function isMit(norm: string): boolean {
  const grant =
    'permission is hereby granted, free of charge, to any person obtaining a copy ' +
    'of this software and associated documentation files';
  const asIs = 'the software is provided "as is", without warranty of any kind';
  return norm.includes('mit license') && norm.includes(grant) && norm.includes(asIs);
}

/** Detect the AGPL by its title (the module CLI emits "GNU AFFERO GENERAL PUBLIC LICENSE"). */
function isAgpl(norm: string): boolean {
  return (
    norm.includes('gnu affero general public license') ||
    norm.includes('affero general public license') ||
    /\bagpl\b/.test(norm)
  );
}

// ── helper ─────────────────────────────────────────────────────────────────────────
function hard(id: string, title: string, status: 'pass' | 'fail', messages: string[]): CheckResult {
  return { id, title, status, kind: 'hard', messages, advisories: [] };
}

export { SLOT_SLUG_RE };
