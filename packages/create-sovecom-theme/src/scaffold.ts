/**
 * the theme-starter scaffolder.
 *
 * Pure file emission: validate the requested theme name against the theme-name slug rule
 * (`THEME_NAME_RE`), then copy the in-package `templates/` tree into the target, substituting
 * the theme name. No interactive prompts, no network, no code execution. ZERO runtime
 * dependencies — only `./theme-name.js` (a drift-guarded local copy of the SDK's rule, so the
 * built bin runs under plain `node` without loading the SDK's source-first entry; see
 * `theme-name.ts`) and Node built-ins.
 *
 * Emits a minimal MIT skeleton without React/Next/tailwind/app files. The full Next.js theme
 * starter is planned for a future release when the render runtime is ready.
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEME_NAME_RE } from './theme-name.js';

/** Placeholder token substituted with the theme slug throughout the template tree. */
const NAME_PLACEHOLDER = '__THEME_NAME__';

/** Templates are stored with a `.tmpl` suffix so they are not compiled/linted as package source. */
const TEMPLATE_SUFFIX = '.tmpl';

const templatesDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'templates');

/** Thrown when the requested theme name is not a valid lowercase slug. */
export class InvalidThemeNameError extends Error {
  constructor(name: string) {
    super(
      `invalid theme name "${name}": must be a lowercase slug matching ${THEME_NAME_RE.source} ` +
        `(e.g. "aurora", "minimal-shop")`,
    );
    this.name = 'InvalidThemeNameError';
  }
}

export interface ScaffoldOptions {
  /** The theme slug — also the package name and manifest `name`. */
  readonly themeName: string;
  /** Directory the new `<themeName>/` folder is created INSIDE. */
  readonly targetDir: string;
}

/** Validate the theme name with the slug regex (a drift-guarded local copy of the SDK's rule). */
export function assertValidThemeName(name: string): void {
  if (typeof name !== 'string' || !THEME_NAME_RE.test(name)) {
    throw new InvalidThemeNameError(String(name));
  }
}

/**
 * Scaffold a theme starter into `<targetDir>/<themeName>/`. Returns the absolute path of the
 * created theme directory. Throws {@link InvalidThemeNameError} on a bad name and a plain
 * `Error` if the destination already exists and is non-empty (never clobber an author's work).
 */
export function scaffoldTheme(opts: ScaffoldOptions): string {
  assertValidThemeName(opts.themeName);

  const outDir = resolve(opts.targetDir, opts.themeName);
  if (existsSync(outDir) && statSync(outDir).isDirectory() && readdirSync(outDir).length > 0) {
    throw new Error(`destination "${outDir}" already exists and is not empty; aborting`);
  }

  mkdirSync(outDir, { recursive: true });
  copyTemplateTree(templatesDir, outDir, opts.themeName);
  return outDir;
}

/** Recursively copy `from` → `to`, dropping the `.tmpl` suffix and substituting the theme name. */
function copyTemplateTree(from: string, to: string, themeName: string): void {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    if (entry.isDirectory()) {
      const destSub = join(to, entry.name);
      mkdirSync(destSub, { recursive: true });
      copyTemplateTree(src, destSub, themeName);
      continue;
    }
    if (!entry.isFile()) continue;
    const destName = entry.name.endsWith(TEMPLATE_SUFFIX)
      ? entry.name.slice(0, -TEMPLATE_SUFFIX.length)
      : entry.name;
    const dest = join(to, destName);
    const content = readFileSync(src, 'utf8').split(NAME_PLACEHOLDER).join(themeName);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content, 'utf8');
  }
}
