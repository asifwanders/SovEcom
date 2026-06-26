/**
 * safe SQL identifiers for a module's schema + role.
 *
 * A module name is the install-time slug `^[a-z][a-z0-9-]*$`. It maps to a Postgres
 * SCHEMA `mod_<name>` and a NOLOGIN ROLE `modrole_<name>`. Names may contain hyphens, which are
 * not legal in UNQUOTED identifiers — so every identifier is DOUBLE-QUOTED. The slug regex
 * guarantees no `"`/backslash/whitespace, so quoting is injection-proof; we still re-validate
 * here (defence in depth) because these strings are interpolated into DDL/`SET ROLE`.
 */

const MODULE_NAME_RE = /^[a-z][a-z0-9-]*$/;
/** Bound the length so the derived identifiers stay within Postgres's 63-byte NAMEDATALEN. */
const MAX_MODULE_NAME_LEN = 48;

export class InvalidModuleNameError extends Error {
  constructor(name: string) {
    super(`invalid module name for runtime identifiers: ${JSON.stringify(name)}`);
    this.name = 'InvalidModuleNameError';
  }
}

/** Throw unless `name` is a valid module slug of bounded length. */
export function assertModuleName(name: string): void {
  if (typeof name !== 'string' || name.length > MAX_MODULE_NAME_LEN || !MODULE_NAME_RE.test(name)) {
    throw new InvalidModuleNameError(name);
  }
}

/** The unquoted schema name (`mod_<name>`). */
export function schemaName(name: string): string {
  assertModuleName(name);
  return `mod_${name}`;
}

/** The unquoted role name (`modrole_<name>`). */
export function roleName(name: string): string {
  assertModuleName(name);
  return `modrole_${name}`;
}

/**
 * Double-quote an identifier for safe interpolation into SQL. The input MUST already be a
 * derived `mod_*`/`modrole_*` name (slug-validated), so this only escapes any `"` defensively
 * and wraps — there is no path for a slug to contain one.
 */
export function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

/** Quoted schema identifier, ready to drop into DDL / `SET search_path`. */
export function quotedSchema(name: string): string {
  return quoteIdent(schemaName(name));
}

/** Quoted role identifier, ready to drop into `SET ROLE` / `GRANT`. */
export function quotedRole(name: string): string {
  return quoteIdent(roleName(name));
}
