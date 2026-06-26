import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { auditLog } from '../database/schema/audit_log';
import { redact } from '../common/redaction.util';

/**
 * The shape of a single audit entry.
 *
 * `actorType` is one of the `actor_type` pg-enum values (`user` | `customer` |
 * `system` | `api` | `anonymous`). `changes` is arbitrary non-secret context —
 * it is passed through {@link redact} before storage so a caller can never
 * accidentally persist a password/token/secret into the audit trail. `ip` maps
 * to the INET `ip_address` column; `userAgent` is truncated to a sane bound.
 */
export interface AuditEntry {
  tenantId: string;
  actorType: 'user' | 'customer' | 'system' | 'api' | 'anonymous';
  actorId?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  changes?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

const USER_AGENT_MAX = 512;

/**
 * Writes auth/admin events to the append-only `audit_log` table.
 *
 * Failure policy: an audit-write failure must NEVER throw out of the
 * request path — a logging outage cannot become a login outage. Failures are
 * logged at `error` (so they are visible / alertable) and swallowed; we do not
 * silently drop at a lower level. Callers `await record(...)` but can treat it
 * as best-effort.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly database: DatabaseService) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.insert(entry);
    } catch (err) {
      // Never propagate into the request path. Log loudly so the failure is
      // observable — auth events must not be silently droppable.
      this.logger.error(
        `audit_log write failed for action="${entry.action}" tenant="${entry.tenantId}"`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  /**
   * Like {@link record}, but FAILS CLOSED: a write failure PROPAGATES. Use this
   * for events where serving the request without its audit row would be an
   * unlogged-exfil path — e.g. a bulk CSV export (`audit_log.exported`, #7). The
   * 022.8 "logging outage ≠ login outage" rule deliberately does NOT apply here:
   * no CSV may leave without its corresponding audit entry.
   */
  async recordOrThrow(entry: AuditEntry): Promise<void> {
    await this.insert(entry);
  }

  private async insert(entry: AuditEntry): Promise<void> {
    const changes =
      entry.changes === undefined ? null : (redact(entry.changes) as Record<string, unknown>);

    const userAgent =
      entry.userAgent === undefined ? null : entry.userAgent.slice(0, USER_AGENT_MAX);

    await this.database.db.insert(auditLog).values({
      tenantId: entry.tenantId,
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      action: entry.action,
      resourceType: entry.resourceType ?? 'unknown',
      resourceId: entry.resourceId ?? null,
      changes,
      ipAddress: entry.ip ?? null,
      userAgent,
    });
  }
}
