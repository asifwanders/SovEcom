/**
 * Client-side permission helper.
 * UX-only gate — the server enforces real authorization.
 *
 * Role → permission mapping mirrors the API's RbacGuard role map (role-permissions.map.ts):
 *   owner / admin  → all permissions
 *   staff          → products r/w, categories r/w, orders READ, customers read, audit_log read
 *                    (NOT orders:write — order lifecycle / refunds / returns / dispute actions are
 *                     admin+; the server enforces this, so the client must not surface them to staff)
 */

export type Permission =
  | 'products:read'
  | 'products:write'
  | 'categories:read'
  | 'categories:write'
  | 'pages:read'
  | 'pages:write'
  | 'pages:delete'
  | 'orders:read'
  | 'orders:write'
  | 'customers:read'
  | 'customers:write'
  | 'settings:read'
  | 'settings:write'
  | 'themes:read'
  | 'themes:write'
  | 'modules:read'
  | 'modules:write'
  | 'audit_log:read'
  | 'audit_log:export'
  | 'users:read'
  | 'users:write';

const STAFF_PERMISSIONS: Permission[] = [
  'products:read',
  'products:write',
  'categories:read',
  'categories:write',
  'pages:read',
  'pages:write',
  'orders:read',
  'customers:read',
  'audit_log:read',
];

const ALL_PERMISSIONS: Permission[] = [
  ...STAFF_PERMISSIONS,
  'pages:delete',
  'orders:write',
  'customers:write',
  'settings:read',
  'settings:write',
  // themes + modules are admin-only (staff is fail-closed)
  'themes:read',
  'themes:write',
  'modules:read',
  'modules:write',
  'audit_log:export',
  // users management is owner/admin only — staff does NOT get these
  'users:read',
  'users:write',
];

const ROLE_MAP: Record<string, Permission[]> = {
  owner: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS,
  staff: STAFF_PERMISSIONS,
};

/** Returns true if the given role has the specified permission. UX-only. */
export function can(role: string | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  const perms = ROLE_MAP[role] ?? [];
  return perms.includes(permission);
}
