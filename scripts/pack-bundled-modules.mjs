#!/usr/bin/env node
/**
 * pack-bundled-modules.mjs — pack every BUILT-IN ("bundled") module into the dir the API reads
 * at runtime, so the setup wizard can install + enable them during first-run onboarding.
 *
 * Reads the SINGLE SOURCE OF TRUTH — `apps/api/src/modules/bundled-modules.catalog.json` (the
 * same list the runtime registry `bundled-modules.ts` validates installs against) — and, for each
 * entry, invokes `scripts/pack-module.mjs <dir> --out apps/api/bundled-modules/<id>.tgz` (the
 * esbuild-bundled npm-style tarball). It ALSO copies the module's `sovecom.module.json` verbatim to
 * `apps/api/bundled-modules/<id>.module.json`, which the registry reads at request time for the
 * setup catalog's displayName/permissions/slots (no cross-root TS import, no runtime tarball
 * inspection on GET).
 *
 * The output `.tgz`/`.module.json` are BUILD ARTIFACTS (gitignored) — this script regenerates them.
 * Add an id to the catalog JSON and re-run `pnpm pack:bundled-modules`; nothing else to touch.
 *
 * Usage:  node scripts/pack-bundled-modules.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const CATALOG = path.join(repoRoot, 'apps/api/src/modules/bundled-modules.catalog.json');
const OUT_DIR = path.join(repoRoot, 'apps/api/bundled-modules');
const PACK_ONE = path.join(__dirname, 'pack-module.mjs');
/** The module-name slug rule (mirrors the manifest's MODULE_NAME_RE): lowercase, no separators. */
const SLUG_RE = /^[a-z][a-z0-9-]*$/;

function main() {
  if (!fs.existsSync(CATALOG)) {
    console.error(`bundled-modules catalog not found: ${CATALOG}`);
    process.exit(2);
  }
  const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  const modules = Array.isArray(catalog.modules) ? catalog.modules : [];
  if (modules.length === 0) {
    console.error('catalog lists no modules — nothing to pack');
    process.exit(2);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const results = [];
  let failures = 0;
  for (const entry of modules) {
    const { id, dir } = entry;
    if (typeof id !== 'string' || typeof dir !== 'string') {
      console.error(`skipping malformed catalog entry: ${JSON.stringify(entry)}`);
      failures += 1;
      continue;
    }
    // N2: defence in depth. The catalog is dev-controlled, but assert the id is a clean slug (no
    // separator/traversal) and that the resolved input/output paths stay under their expected roots
    // before any read/write — a crafted `dir`/`id` can never escape the module tree or OUT_DIR.
    if (!SLUG_RE.test(id)) {
      console.error(`FATAL: catalog id '${id}' is not a valid module slug (^[a-z][a-z0-9-]*$)`);
      failures += 1;
      continue;
    }
    const moduleDir = path.resolve(repoRoot, dir);
    if (moduleDir !== repoRoot && !moduleDir.startsWith(repoRoot + path.sep)) {
      console.error(`FATAL: module dir for '${id}' escapes the repo root: ${dir}`);
      failures += 1;
      continue;
    }
    const manifestPath = path.join(moduleDir, 'sovecom.module.json');
    if (!fs.existsSync(manifestPath)) {
      console.error(`FATAL: no sovecom.module.json for '${id}' at ${manifestPath}`);
      failures += 1;
      continue;
    }
    // Cross-check the catalog id against the module's manifest name — they MUST match (the id is
    // the install/enable key + the .tgz basename the registry resolves).
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.name !== id) {
      console.error(`FATAL: catalog id '${id}' != manifest name '${manifest.name}' (${dir})`);
      failures += 1;
      continue;
    }

    const outTgz = path.join(OUT_DIR, `${id}.tgz`);
    const outManifest = path.join(OUT_DIR, `${id}.module.json`);
    // N2: both outputs must stay strictly inside OUT_DIR (the slug check above already guarantees
    // this, but assert it so the write boundary never relies on the slug rule alone). NOTE: OUT_DIR
    // is fixed repo-relative here; the API resolves the SAME files via BUNDLED_MODULES_PATH at
    // runtime, which is trusted server config (N3) — not attacker input.
    if (!outTgz.startsWith(OUT_DIR + path.sep) || !outManifest.startsWith(OUT_DIR + path.sep)) {
      console.error(`FATAL: output path for '${id}' escapes the bundled dir`);
      failures += 1;
      continue;
    }
    const res = spawnSync(process.execPath, [PACK_ONE, moduleDir, '--out', outTgz], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      console.error(`FATAL: pack-module failed for '${id}' (exit ${res.status})`);
      failures += 1;
      continue;
    }
    // Copy the manifest next to the tarball — the registry reads it for the setup catalog metadata.
    fs.copyFileSync(manifestPath, outManifest);

    results.push({ id, tgz: outTgz, manifest: outManifest, tgzBytes: fs.statSync(outTgz).size });
  }

  console.log(
    JSON.stringify({ outDir: OUT_DIR, packed: results.length, failures, modules: results }, null, 2),
  );
  if (failures > 0) process.exit(1);
}

main();
