/**
 * the module-starter scaffolder.
 *
 * Pure file emission: validate the requested module name against the module-name slug rule
 * (`MODULE_NAME_RE`), then copy the in-package `templates/` tree into the target, substituting
 * the module name. No interactive prompts, no network, no code execution. ZERO runtime
 * dependencies — only `./module-name.js` (a drift-guarded local copy of the SDK's rule, so the
 * built bin runs under plain `node` without loading the SDK's source-first entry; see
 * `module-name.ts`) and Node built-ins.
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODULE_NAME_RE } from './module-name.js';

/** Placeholder token substituted with the module slug throughout the template tree. */
const NAME_PLACEHOLDER = '__MODULE_NAME__';

/** Templates are stored with a `.tmpl` suffix so they are not compiled/linted as package source. */
const TEMPLATE_SUFFIX = '.tmpl';

const templatesDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'templates');

/** Thrown when the requested module name is not a valid lowercase slug. */
export class InvalidModuleNameError extends Error {
  constructor(name: string) {
    super(
      `invalid module name "${name}": must be a lowercase slug matching ${MODULE_NAME_RE.source} ` +
        `(e.g. "wishlist", "loyalty-points")`,
    );
    this.name = 'InvalidModuleNameError';
  }
}

export interface ScaffoldOptions {
  /** The module slug — also the package name, manifest `name`, and `mod_<name>_` table prefix. */
  readonly moduleName: string;
  /** Directory the new `<moduleName>/` folder is created INSIDE. */
  readonly targetDir: string;
}

/** Validate the module name with the slug regex (a drift-guarded local copy of the SDK's rule). */
export function assertValidModuleName(name: string): void {
  if (typeof name !== 'string' || !MODULE_NAME_RE.test(name)) {
    throw new InvalidModuleNameError(String(name));
  }
}

/**
 * Scaffold a module starter into `<targetDir>/<moduleName>/`. Returns the absolute path of the
 * created module directory. Throws {@link InvalidModuleNameError} on a bad name and a plain
 * `Error` if the destination already exists and is non-empty (never clobber an author's work).
 */
export function scaffoldModule(opts: ScaffoldOptions): string {
  assertValidModuleName(opts.moduleName);

  const outDir = resolve(opts.targetDir, opts.moduleName);
  if (existsSync(outDir) && statSync(outDir).isDirectory() && readdirSync(outDir).length > 0) {
    throw new Error(`destination "${outDir}" already exists and is not empty; aborting`);
  }

  mkdirSync(outDir, { recursive: true });
  copyTemplateTree(templatesDir, outDir, opts.moduleName);
  return outDir;
}

/** Recursively copy `from` → `to`, dropping the `.tmpl` suffix and substituting the module name. */
function copyTemplateTree(from: string, to: string, moduleName: string): void {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    if (entry.isDirectory()) {
      const destSub = join(to, entry.name);
      mkdirSync(destSub, { recursive: true });
      copyTemplateTree(src, destSub, moduleName);
      continue;
    }
    if (!entry.isFile()) continue;
    const destName = entry.name.endsWith(TEMPLATE_SUFFIX)
      ? entry.name.slice(0, -TEMPLATE_SUFFIX.length)
      : entry.name;
    const dest = join(to, destName);
    const content = readFileSync(src, 'utf8').split(NAME_PLACEHOLDER).join(moduleName);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content, 'utf8');
  }
}
