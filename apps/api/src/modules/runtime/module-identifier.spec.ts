/**
 * module identifier helper unit tests. Pins the slug validation + safe
 * quoting that guards every interpolation into DDL / SET ROLE.
 */
import {
  assertModuleName,
  InvalidModuleNameError,
  quoteIdent,
  quotedRole,
  quotedSchema,
  roleName,
  schemaName,
} from './module-identifier';

describe('module-identifier', () => {
  it('derives schema + role names from a valid slug (incl. hyphen)', () => {
    expect(schemaName('wishlist')).toBe('mod_wishlist');
    expect(roleName('wishlist')).toBe('modrole_wishlist');
    expect(schemaName('my-module')).toBe('mod_my-module');
    expect(quotedSchema('my-module')).toBe('"mod_my-module"');
    expect(quotedRole('my-module')).toBe('"modrole_my-module"');
  });

  it('rejects non-slug / injection-shaped / oversized names', () => {
    expect(() => assertModuleName('')).toThrow(InvalidModuleNameError);
    expect(() => assertModuleName('A')).toThrow(InvalidModuleNameError);
    expect(() => assertModuleName('1abc')).toThrow(InvalidModuleNameError);
    expect(() => assertModuleName('has_underscore')).toThrow(InvalidModuleNameError);
    expect(() => assertModuleName('has space')).toThrow(InvalidModuleNameError);
    expect(() => assertModuleName('evil"; drop schema public; --')).toThrow(InvalidModuleNameError);
    expect(() => assertModuleName('a'.repeat(49))).toThrow(InvalidModuleNameError);
    expect(() => assertModuleName('UPPER')).toThrow(InvalidModuleNameError);
  });

  it('quoteIdent wraps and escapes embedded quotes (defensive)', () => {
    expect(quoteIdent('mod_x')).toBe('"mod_x"');
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });
});
