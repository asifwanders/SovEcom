import { pgTable, uuid, text, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';
import { tenants } from './_tenants';

/**
 * Module slot resolutions — the admin's chosen WINNER for a contested slot
 * (slot conflicts are resolved by the admin, NEVER by silent override).
 *
 * The slot registry is DERIVED from enabled modules' manifests. When exactly one enabled
 * module targets a slot it wins automatically; when MORE than one do, the slot is a CONFLICT
 * and renders NOTHING until an admin picks a winner here. A row records that pick: for a
 * `(tenant_id, slot)`, `module_name` is the chosen module. A resolution naming a module that
 * no longer targets the slot (disabled/uninstalled/manifest changed) is IGNORED by the
 * registry (re-conflict) — it is never auto-deleted, just not honoured.
 *
 * Composite PK `(tenant_id, slot)` — at most one resolution per slot per tenant. Tenant-scoped
 * `tenant_id` is a NOT NULL FK→tenants (cascade) and every query filters on it.
 * This is a LEAF table (no child tables reference it) so a composite-FK anchor is not required;
 * the tenant FK + per-query scoping are. `module_name` is the module slug (not an FK — modules
 * are tenant-scoped rows the registry validates against at write time, and a stale name simply
 * re-conflicts rather than failing).
 */
export const moduleSlotResolutions = pgTable(
  'module_slot_resolutions',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    slot: text('slot').notNull(),
    moduleName: text('module_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.slot] }),
    tenantIdx: index('module_slot_resolutions_tenant_idx').on(t.tenantId),
  }),
);

export type ModuleSlotResolution = typeof moduleSlotResolutions.$inferSelect;
export type NewModuleSlotResolution = typeof moduleSlotResolutions.$inferInsert;
