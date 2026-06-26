/**
 * PermissionsService.
 *
 * The authorization decision point: does a role hold a permission? A pure,
 * query-free `ReadonlySet` lookup over the static {@link ../role-permissions.map}.
 * An unknown/garbage role resolves to NO permissions (fail-closed) — never throws.
 */
import { Injectable } from '@nestjs/common';
import { ROLE_PERMISSIONS, type Role } from '../role-permissions.map';
import type { Permission } from '../permissions.constants';

@Injectable()
export class PermissionsService {
  /** True iff `role` is a known role that holds `permission`. */
  hasPermission(role: string, permission: Permission): boolean {
    const granted = PermissionsService.grantsFor(role);
    return granted !== undefined && granted.has(permission);
  }

  /** The full permission set for a role (empty for an unknown role). */
  permissionsFor(role: string): ReadonlySet<Permission> {
    return PermissionsService.grantsFor(role) ?? new Set<Permission>();
  }

  /**
   * Own-property-only lookup. Guards against prototype-chain keys (`__proto__`,
   * `constructor`, `hasOwnProperty`) resolving to a non-Set member and throwing —
   * an unknown role must resolve to `undefined` (deny), never a 500.
   */
  private static grantsFor(role: string): ReadonlySet<Permission> | undefined {
    return Object.hasOwn(ROLE_PERMISSIONS, role) ? ROLE_PERMISSIONS[role as Role] : undefined;
  }
}
