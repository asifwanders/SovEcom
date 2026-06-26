import { pgTable, uuid, text, timestamp, jsonb, inet, index } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { actorTypeEnum } from './_enums';

/**
 * Append-only admin / system audit log. No `updated_at`.
 *
 * `tenant_id` is RESTRICT: a tenant with audit rows cannot be hard-deleted,
 * protecting the >=2yr retention (NFR-SEC-003). `actor_id` / `resource_id` are polymorphic
 * (no FK — they point across many tables). `ip_address` is INET.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: uuid('resource_id'),
    changes: jsonb('changes'),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantCreatedIdx: index('audit_log_tenant_created_idx').on(t.tenantId, t.createdAt),
    tenantResourceIdx: index('audit_log_tenant_resource_idx').on(
      t.tenantId,
      t.resourceType,
      t.resourceId,
    ),
    tenantActorIdx: index('audit_log_tenant_actor_idx').on(t.tenantId, t.actorId),
  }),
);

export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
