/**
 * Role → permission map.
 *
 * The role set is the REAL `user_role` pg enum (`owner | admin | staff`).
 * `Role` is derived from the schema enum so the two never drift.
 *
 *   owner — ALL permissions (reserved super-account; identical to admin for now).
 *   admin — ALL permissions.
 *   staff — operational subset: read/write products, categories; READ orders
 *           (list/detail) but NOT write them — transitions / mark-paid are admin+;
 *           read customers; read audit log. NO deletes, refunds, order-writes,
 *           settings, users, modules (read or write).
 *
 * `modules:read` / `modules:write` and `themes:read` / `themes:write` flow to
 * owner+admin automatically via `ALL_PERMISSIONS`; staff's explicit subset below
 * omits them, so staff is fail-closed on both surfaces.
 *
 * Stored as `ReadonlySet`s so `userHasPermission` is an O(1), allocation-free,
 * query-free lookup on the hot path.
 */
import { userRoleEnum } from '../database/schema/_enums';
import { PERMISSIONS, ALL_PERMISSIONS, type Permission } from './permissions.constants';

/** `'owner' | 'admin' | 'staff'`, kept in lockstep with the DB enum. */
export type Role = (typeof userRoleEnum.enumValues)[number];

/** The lower-privilege operational role (doc-11 §1.3 staff set). */
const STAFF_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.PRODUCTS_READ,
  PERMISSIONS.PRODUCTS_WRITE,
  PERMISSIONS.CATEGORIES_READ,
  PERMISSIONS.CATEGORIES_WRITE,
  // pages read/write mirror categories read/write — staff
  // edits content copy. PAGES_DELETE is owner/admin-only (mirrors CATEGORIES_DELETE,
  // which staff also lacks), so it is intentionally omitted here (fail-closed).
  PERMISSIONS.PAGES_READ,
  PERMISSIONS.PAGES_WRITE,
  PERMISSIONS.CUSTOMERS_READ,
  PERMISSIONS.ORDERS_READ,
  PERMISSIONS.AUDIT_LOG_READ,
  PERMISSIONS.DASHBOARD_READ,
];

export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  owner: new Set(ALL_PERMISSIONS),
  admin: new Set(ALL_PERMISSIONS),
  staff: new Set(STAFF_PERMISSIONS),
};
