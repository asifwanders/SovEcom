/**
 * STATIC detection of which `sdk.*` capabilities a module's
 * source uses, and of `CREATE TABLE` names in inline DDL, via the TypeScript compiler API.
 *
 * APPROACH + HONEST LIMITS (documented so the report never overclaims):
 *   - We walk every `.ts`/`.tsx` source file's AST looking for the `activate(sdk)` callback inside
 *     `defineModule({ activate(...) })`, learn the FIRST parameter's identifier (`sdk`, `core`, …),
 *     and collect property-access chains rooted at that identifier: `sdk.store.products` →
 *     capability `store.products`. We also defensively pick up chains rooted at any identifier
 *     literally named `sdk` (covers helpers passed `sdk` around).
 *   - This is a syntactic, best-effort scan. It WILL miss capabilities reached through aliasing
 *     (`const s = sdk; s.http.fetch()`), destructuring (`const { http } = sdk`), or fully dynamic
 *     property access (`sdk[name].fetch()`). It is intentionally CONSERVATIVE about NOT
 *     fabricating usage — a false "missing permission" failure would be worse than a missed one,
 *     and the broker enforces permissions at runtime regardless. The check surfaces this limit in
 *     its own advisory text.
 *   - Inline DDL table names are extracted with a simple `CREATE TABLE [IF NOT EXISTS] <name>`
 *     regex over string-literal arguments to `sdk.tables.exec/query` — a cheap, best-effort catch
 *     of obviously non-namespaced tables, not a SQL parser.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import ts from 'typescript';

export interface UsageScan {
  /** Capability keys observed, e.g. `store.products`, `tables`, `events.on`, `http`, `serve`. */
  readonly capabilities: Set<string>;
  /** Table names found in inline `CREATE TABLE` DDL inside sdk.tables.exec/query string literals. */
  readonly ddlTables: Set<string>;
}

const SOURCE_EXTS = new Set(['.ts', '.tsx']);
const CREATE_TABLE_RE =
  /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?["'`]?([a-zA-Z_][a-zA-Z0-9_]*)/gi;

/** Recursively gather source files under `srcDir` (skips node_modules / dist / dot-dirs). */
function gatherSourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...gatherSourceFiles(full));
    } else if (entry.isFile() && SOURCE_EXTS.has(extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/** Walk a module's `src/` and return the static usage scan. */
export function scanModuleUsage(moduleDir: string): UsageScan {
  const capabilities = new Set<string>();
  const ddlTables = new Set<string>();

  const srcDir = join(moduleDir, 'src');
  const root = (() => {
    try {
      return statSync(srcDir).isDirectory() ? srcDir : moduleDir;
    } catch {
      return moduleDir;
    }
  })();

  for (const file of gatherSourceFiles(root)) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const sdkNames = collectActivateParamNames(sf);
    sdkNames.add('sdk'); // defensive default name
    scanNode(sf, sdkNames, capabilities, ddlTables);
  }

  return { capabilities, ddlTables };
}

/** Find every `defineModule({ activate(<param>) {} })` and return the set of `<param>` names. */
function collectActivateParamNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    // An object-literal property `activate` whose value is a function with >=1 param.
    if (
      (ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'activate'
    ) {
      const fn = ts.isMethodDeclaration(node)
        ? node
        : ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer)
          ? node.initializer
          : undefined;
      const first = fn?.parameters?.[0];
      if (first && ts.isIdentifier(first.name)) {
        names.add(first.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

/** Recursively scan a node for sdk.* property chains and CREATE TABLE DDL in sdk.tables calls. */
function scanNode(
  node: ts.Node,
  sdkNames: Set<string>,
  capabilities: Set<string>,
  ddlTables: Set<string>,
): void {
  if (ts.isPropertyAccessExpression(node)) {
    const cap = capabilityFromChain(node, sdkNames);
    if (cap) capabilities.add(cap);
  }

  // DDL extraction: any call whose chain (rooted at sdk) ends in `.tables.exec`/`.tables.query`,
  // with a string-literal first argument, gets its CREATE TABLE names pulled out.
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text;
    if ((method === 'exec' || method === 'query') && endsWithSdkTables(node.expression, sdkNames)) {
      const arg = node.arguments[0];
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
        for (const t of extractDdlTables(arg.text)) ddlTables.add(t);
      }
    }
  }

  ts.forEachChild(node, (child) => scanNode(child, sdkNames, capabilities, ddlTables));
}

/**
 * From a property-access chain rooted at an sdk identifier, return the normalized capability key
 * (one or two segments deep): `sdk.store.products` → `store.products`, `sdk.http.fetch` → `http`,
 * `sdk.tables.exec` → `tables`, `sdk.events.on` → `events.on`, `sdk.serve` → `serve`. Returns null
 * if the chain is not rooted at a known sdk identifier.
 */
function capabilityFromChain(
  node: ts.PropertyAccessExpression,
  sdkNames: Set<string>,
): string | null {
  // Build the segment list from the root identifier outward.
  const segments: string[] = [];
  let current: ts.Expression = node;
  while (ts.isPropertyAccessExpression(current)) {
    segments.unshift(current.name.text);
    current = current.expression;
  }
  if (!ts.isIdentifier(current) || !sdkNames.has(current.text)) return null;
  // segments now = ['store','products','list', ...] (after the sdk root).
  const [first, second] = segments;
  if (!first) return null;
  switch (first) {
    case 'store':
    case 'admin':
      return second ? `${first}.${second}` : first;
    case 'commerce':
      // sdk.commerce.* — the narrow read:orders purchase probe. One capability key.
      return 'commerce';
    case 'events':
      return second === 'on' || second === 'emit' ? `events.${second}` : 'events';
    case 'tables':
    case 'http':
    case 'serve':
      return first;
    default:
      return null;
  }
}

/** True if a `*.tables` property-access chain is rooted at an sdk identifier. */
function endsWithSdkTables(expr: ts.PropertyAccessExpression, sdkNames: Set<string>): boolean {
  // expr is like sdk.tables.exec → expr.expression is sdk.tables.
  const tablesAccess = expr.expression;
  if (!ts.isPropertyAccessExpression(tablesAccess) || tablesAccess.name.text !== 'tables') {
    return false;
  }
  const root = tablesAccess.expression;
  return ts.isIdentifier(root) && sdkNames.has(root.text);
}

/** Pull `CREATE TABLE [IF NOT EXISTS] <name>` table names out of an inline SQL string. */
export function extractDdlTables(sql: string): string[] {
  const found: string[] = [];
  let m: RegExpExecArray | null;
  CREATE_TABLE_RE.lastIndex = 0;
  while ((m = CREATE_TABLE_RE.exec(sql)) !== null) {
    if (m[1]) found.push(m[1]);
  }
  return found;
}
