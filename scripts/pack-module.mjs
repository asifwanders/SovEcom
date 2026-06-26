#!/usr/bin/env node
/**
 * pack-module.mjs — bundle a SovEcom reference module into an npm-style install tarball.
 *
 * Given a module dir (with src/index.ts, sovecom.module.json, optional settings.schema.json),
 * this esbuild-bundles src/index.ts into a single self-contained CommonJS index.js (the
 * @sovecom/module-sdk workspace dep — and its own deps zod/semver — are INLINED, so the only
 * require() left in the output is Node built-ins; the sandboxed worker can load it with no
 * node_modules resolution beyond what the Node permission model already allows).
 *
 * Then it emits a gzip'd USTAR tarball with everything under `package/`:
 *   package/sovecom.module.json   (the manifest)
 *   package/index.js              (the bundle, = SOVECOM_MODULE_MAIN entry after extract)
 *   package/settings.schema.json  (if the manifest references settings)
 *
 * This is the EXACT shape ModuleIngestService extracts into <MODULES_DATA_PATH>/<name>/, and
 * the worker-entry does require(<root>/<name>/index.js) → resolves { default: { activate } }.
 *
 * Usage:  node scripts/pack-module.mjs <module-dir> [--out <file.tgz>]
 * Example: node scripts/pack-module.mjs modules/reviews --out /tmp/reviews.tgz
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// esbuild is in the pnpm store but not hoisted to the repo root node_modules/.bin. Resolve it
// from the pnpm virtual store directly so this script works from anywhere in the monorepo.
function loadEsbuild() {
  try {
    return require('esbuild');
  } catch {
    const candidates = fs
      .readdirSync(path.resolve('node_modules/.pnpm'))
      .filter((d) => d.startsWith('esbuild@'))
      .sort()
      .reverse();
    for (const c of candidates) {
      const p = path.resolve('node_modules/.pnpm', c, 'node_modules/esbuild');
      if (fs.existsSync(path.join(p, 'lib/main.js'))) return require(p);
    }
    throw new Error('esbuild not found in node_modules or the pnpm store');
  }
}

// ── minimal USTAR tar writer (mirrors apps/api/test/.../modules.int-spec.ts) ──────────────
const BLOCK = 512;
function octal(value, len) {
  return value.toString(8).padStart(len - 1, '0') + '\0';
}
function tarHeader(entry) {
  const buf = Buffer.alloc(BLOCK, 0);
  buf.write(entry.name.slice(0, 100), 0, 'utf8');
  // Directories need the execute bit to be traversable after extraction; files are 0644.
  buf.write((entry.type === '5' ? '0000755\0' : '0000644\0'), 100, 'ascii');
  buf.write('0000000\0', 108, 'ascii');
  buf.write('0000000\0', 116, 'ascii');
  const size = entry.data?.length ?? 0;
  buf.write(octal(size, 12), 124, 'ascii');
  buf.write(octal(0, 12), 136, 'ascii');
  buf.write('        ', 148, 'ascii');
  buf.write(entry.type ?? '0', 156, 'ascii');
  buf.write('ustar\0', 257, 'ascii');
  buf.write('00', 263, 'ascii');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i] ?? 0;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return buf;
}
function buildTar(entries) {
  const parts = [];
  for (const e of entries) {
    parts.push(tarHeader(e));
    if (e.type === '5') continue;
    const data = e.data ?? Buffer.alloc(0);
    parts.push(data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

async function main() {
  const args = process.argv.slice(2);
  const moduleDir = path.resolve(args[0] ?? '');
  const outIdx = args.indexOf('--out');
  if (!args[0] || !fs.existsSync(moduleDir)) {
    console.error('usage: node scripts/pack-module.mjs <module-dir> [--out <file.tgz>]');
    process.exit(2);
  }

  const manifestPath = path.join(moduleDir, 'sovecom.module.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`no sovecom.module.json in ${moduleDir}`);
    process.exit(2);
  }
  const manifestRaw = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestRaw.toString('utf8'));

  const entryTs = path.join(moduleDir, 'src/index.ts');
  if (!fs.existsSync(entryTs)) {
    console.error(`no src/index.ts in ${moduleDir}`);
    process.exit(2);
  }

  // ── esbuild bundle: CJS, node platform, inline EVERYTHING (no externals). ──
  const esbuild = loadEsbuild();
  const result = await esbuild.build({
    entryPoints: [entryTs],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    // Inline @sovecom/module-sdk and its deps (zod/semver) into one file. Nothing external.
    external: [],
    write: false,
    logLevel: 'warning',
    // The worker loads via require(); a default export must survive as module.exports.default.
    // esbuild's cjs format already emits `exports.default = ...` for `export default`.
  });
  const bundle = Buffer.from(result.outputFiles[0].contents);

  // Sanity: the bundle must not leave a bare require('@sovecom/...') the sandbox can't resolve.
  const text = bundle.toString('utf8');
  const leaked = [...text.matchAll(/require\(["']([^"')]+)["']\)/g)]
    .map((m) => m[1])
    .filter((id) => !id.startsWith('node:') && !isBuiltin(id));
  if (leaked.length) {
    // Fail fast: a leaked non-builtin require() produces a tarball that loads fine here but dies in
    // the sandboxed worker (which can't resolve it) — a build error beats a broken module (review).
    console.error(`FATAL: bundle leaves non-builtin require()s: ${[...new Set(leaked)].join(', ')}`);
    process.exit(2);
  }

  // ── assemble the npm-style tarball entries. ──
  const entries = [
    { name: 'package/', type: '5' },
    { name: 'package/sovecom.module.json', data: manifestRaw },
    { name: 'package/index.js', data: bundle },
  ];
  // settings.schema.json (the manifest references it).
  const settingsRef = manifest?.settings?.schema;
  if (settingsRef) {
    const schemaPath = path.resolve(moduleDir, settingsRef.replace(/^\.\//, ''));
    // Containment: a crafted manifest `settings.schema: "../../etc/passwd"` must not embed an
    // out-of-module file into the tarball (build-time, but cheap to bar — review S-2).
    if (!schemaPath.startsWith(path.resolve(moduleDir) + path.sep)) {
      console.error(`FATAL: settings schema path escapes the module dir: ${settingsRef}`);
      process.exit(2);
    }
    if (fs.existsSync(schemaPath)) {
      entries.push({
        name: 'package/settings.schema.json',
        data: fs.readFileSync(schemaPath),
      });
    } else {
      console.warn(`WARN: manifest references ${settingsRef} but it was not found`);
    }
  }

  const tgz = zlib.gzipSync(buildTar(entries));
  const out =
    outIdx >= 0 && args[outIdx + 1]
      ? path.resolve(args[outIdx + 1])
      : path.resolve(`${manifest.name}.tgz`);
  fs.writeFileSync(out, tgz);

  console.log(
    JSON.stringify(
      {
        module: manifest.name,
        version: manifest.version,
        bundleBytes: bundle.length,
        tgz: out,
        tgzBytes: tgz.length,
        slots: manifest.slots,
        permissions: manifest.permissions,
        leakedRequires: [...new Set(leaked)],
      },
      null,
      2,
    ),
  );
}

function isBuiltin(id) {
  // crude builtin check sufficient for the leak guard.
  const builtins = new Set([
    'fs','path','crypto','url','util','events','stream','buffer','os','zlib','http','https',
    'net','tls','dns','assert','querystring','string_decoder','timers','tty','child_process',
    'worker_threads','perf_hooks','async_hooks','v8','vm','module','process','console',
  ]);
  return builtins.has(id.replace(/^node:/, '').split('/')[0]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
