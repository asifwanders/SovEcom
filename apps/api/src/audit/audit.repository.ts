/**
 * AuditRepository.
 *
 * Data-access layer for the audit query API. All queries are
 * strictly scoped to the caller's `tenantId` — cross-tenant row access is
 * architecturally impossible from this layer (no override param).
 *
 * Returns rows ordered `created_at DESC` (exploits the existing
 * `audit_log_tenant_created_idx` on `(tenant_id, created_at)`). The `changes`
 * column is passed through verbatim as stored (already redacted at write time by
 * AuditService) — this layer never re-redacts or expands it.
 *
 * Immutability today is enforced at the APPLICATION layer only: there are no
 * UPDATE/DELETE endpoints on `audit_log` (read-only API).
 * TODO(#11, Phase-4 hardening): enforce true append-only at the DATABASE level —
 * either a `BEFORE UPDATE OR DELETE` trigger that RAISES on `audit_log`, or a
 * dedicated restricted DB role that holds only INSERT/SELECT on the table — so a
 * compromised app or a stray migration cannot tamper with the trail.
 */
import { Injectable } from '@nestjs/common';
import { and, eq, gte, lte, desc, count } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { auditLog, type AuditLog } from '../database/schema/audit_log';

export interface AuditQueryFilters {
  tenantId: string;
  actorId?: string;
  resourceType?: string;
  resourceId?: string;
  action?: string;
  dateFrom?: Date;
  dateTo?: Date;
  page: number;
  pageSize: number;
}

export interface AuditQueryResult {
  data: AuditLog[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * Hard ceiling on the number of rows a single CSV export may materialise. After
 * the export window is bounded to ≤31 days (DTO), a result that STILL hits this
 * cap means the window is too dense — the caller (service) FAILS the request
 * rather than serving a truncated audit artifact that looks complete (#3).
 */
export const EXPORT_ROW_CAP = 50_000;

/** Returned by `queryAll`: the rows plus whether the row cap was reached. */
export interface AuditExportRows {
  rows: AuditLog[];
  capped: boolean;
}

@Injectable()
export class AuditRepository {
  constructor(private readonly database: DatabaseService) {}

  async query(filters: AuditQueryFilters): Promise<AuditQueryResult> {
    const conditions = this.buildConditions(filters);

    const [rows, countRows] = await Promise.all([
      this.database.db
        .select()
        .from(auditLog)
        .where(conditions)
        .orderBy(desc(auditLog.createdAt))
        .limit(filters.pageSize)
        .offset((filters.page - 1) * filters.pageSize),
      this.database.db.select({ value: count() }).from(auditLog).where(conditions),
    ]);

    const total = Number(countRows[0]?.value ?? 0);

    return {
      data: rows,
      total,
      page: filters.page,
      pageSize: filters.pageSize,
      totalPages: Math.ceil(total / filters.pageSize),
    };
  }

  /**
   * Fetch all rows matching the filters for a CSV export. Fetches up to
   * EXPORT_ROW_CAP + 1 so the caller can DISTINGUISH "exactly at the cap" from
   * "over the cap" and fail loudly rather than truncate silently (#3). The
   * caller (AuditQueryService) decides what to do when `capped` is true.
   */
  async queryAll(filters: Omit<AuditQueryFilters, 'page' | 'pageSize'>): Promise<AuditExportRows> {
    const conditions = this.buildConditions({ ...filters, page: 1, pageSize: 1 });

    const rows = await this.database.db
      .select()
      .from(auditLog)
      .where(conditions)
      .orderBy(desc(auditLog.createdAt))
      .limit(EXPORT_ROW_CAP + 1); // +1 sentinel: lets us detect "over the cap"

    if (rows.length > EXPORT_ROW_CAP) {
      return { rows: rows.slice(0, EXPORT_ROW_CAP), capped: true };
    }
    return { rows, capped: false };
  }

  private buildConditions(filters: AuditQueryFilters): SQL | undefined {
    const clauses: SQL[] = [eq(auditLog.tenantId, filters.tenantId)];

    if (filters.actorId) {
      clauses.push(eq(auditLog.actorId, filters.actorId));
    }
    if (filters.resourceType) {
      clauses.push(eq(auditLog.resourceType, filters.resourceType));
    }
    if (filters.resourceId) {
      clauses.push(eq(auditLog.resourceId, filters.resourceId));
    }
    if (filters.action) {
      clauses.push(eq(auditLog.action, filters.action));
    }
    if (filters.dateFrom) {
      clauses.push(gte(auditLog.createdAt, filters.dateFrom));
    }
    if (filters.dateTo) {
      clauses.push(lte(auditLog.createdAt, filters.dateTo));
    }

    return clauses.length === 1 ? clauses[0] : and(...clauses);
  }
}
