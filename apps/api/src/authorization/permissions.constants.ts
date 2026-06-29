/**
 * Permission catalogue.
 *
 * Permissions are `resource:action` string constants. They are the single source
 * of truth for what a route can require; roles map to SETS of these in
 * {@link ./role-permissions.map}. Keep names consistent (`resource:action`) and
 * resist proliferation (doc-11 risk: permission sprawl).
 */
export const PERMISSIONS = {
  PRODUCTS_READ: 'products:read',
  PRODUCTS_WRITE: 'products:write',
  PRODUCTS_DELETE: 'products:delete',
  CATEGORIES_READ: 'categories:read',
  CATEGORIES_WRITE: 'categories:write',
  CATEGORIES_DELETE: 'categories:delete',
  CUSTOMERS_READ: 'customers:read',
  CUSTOMERS_WRITE: 'customers:write',
  CUSTOMERS_DELETE: 'customers:delete', // RGPD erasure
  ORDERS_READ: 'orders:read',
  ORDERS_WRITE: 'orders:write',
  ORDERS_REFUND: 'orders:refund',
  AUDIT_LOG_READ: 'audit_log:read',
  AUDIT_LOG_EXPORT: 'audit_log:export',
  SETTINGS_READ: 'settings:read',
  SETTINGS_WRITE: 'settings:write',
  USERS_READ: 'users:read',
  USERS_WRITE: 'users:write',
  USERS_DELETE: 'users:delete',
  // the module install/registry surface. Installing a
  // permission-GRANTING module is a distinct sensitive supply-chain surface, so it
  // gets its own gate rather than reusing `settings:write`. owner+admin only.
  MODULES_READ: 'modules:read',
  MODULES_WRITE: 'modules:write',
  // invoke an installed module's mounted ADMIN endpoints
  // (`/admin/v1/modules/:name/*`). Distinct from `modules:write` (install/manage) — USING a
  // module's admin surface is a lighter grant. owner+admin (via ALL_PERMISSIONS). The store
  // surface (`/store/v1/modules/:name/*`) is public and needs no permission.
  MODULES_USE: 'modules:use',
  // the theme install/registry surface. A distinct admin surface
  // from modules — installing/activating a theme is a separate sensitive supply-chain action,
  // so it gets its own gate. owner+admin only (via ALL_PERMISSIONS); staff is fail-closed. The
  // store surface (`/store/v1/theme`) is public and needs no permission.
  THEMES_READ: 'themes:read',
  THEMES_WRITE: 'themes:write',
  // the CMS-lite `pages` admin CRUD surface
  // (`/admin/v1/pages`). Editing legal + marketing copy is an operational content
  // task analogous to managing categories, so the read/write grants flow to the
  // same roles that hold `CATEGORIES_*` (owner/admin via ALL_PERMISSIONS + staff
  // explicitly). DELETE stays owner/admin-only, mirroring CATEGORIES_DELETE. The
  // store surface (`GET /store/v1/pages/:slug`) is public and needs no permission.
  PAGES_READ: 'pages:read',
  PAGES_WRITE: 'pages:write',
  PAGES_DELETE: 'pages:delete',
  // admin dashboard stats surface. Read-only KPI endpoint; no write gate needed.
  // owner+admin via ALL_PERMISSIONS; staff gets it explicitly (operational view).
  DASHBOARD_READ: 'dashboard:read',
} as const;

/** A valid permission string (union of every value in {@link PERMISSIONS}). */
export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** Every permission — the `owner`/`admin` grant. */
export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);
