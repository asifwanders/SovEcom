/**
 * EmailLogRepository. Tenant-scoped access to `email_logs`.
 */
import { Injectable } from '@nestjs/common';
import { and, count, desc, eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { emailLogs, type EmailLog, type NewEmailLog } from '../database/schema/email_logs';
import type { EmailStatus, EmailType } from './email.types';

export interface EmailLogListResult {
  data: EmailLog[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class EmailLogRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async insert(values: NewEmailLog): Promise<EmailLog> {
    const [row] = await this.db.insert(emailLogs).values(values).returning();
    return row!;
  }

  /** Load one log row, tenant-scoped (for resend — no IDOR across tenants). */
  async findById(tenantId: string, id: string): Promise<EmailLog | null> {
    const [row] = await this.db
      .select()
      .from(emailLogs)
      .where(and(eq(emailLogs.tenantId, tenantId), eq(emailLogs.id, id)))
      .limit(1);
    return row ?? null;
  }

  /** Admin log list: tenant-scoped, optional status/type/order filters, offset-paginated (newest first). */
  async list(
    tenantId: string,
    opts: {
      status?: EmailStatus;
      type?: EmailType;
      orderId?: string;
      page: number;
      pageSize: number;
    },
  ): Promise<EmailLogListResult> {
    const filters = [eq(emailLogs.tenantId, tenantId)];
    if (opts.status) filters.push(eq(emailLogs.status, opts.status));
    if (opts.type) filters.push(eq(emailLogs.type, opts.type));
    if (opts.orderId) filters.push(eq(emailLogs.orderId, opts.orderId));
    const where = and(...filters);

    const [data, totalRows] = await Promise.all([
      this.db
        .select()
        .from(emailLogs)
        .where(where)
        .orderBy(desc(emailLogs.createdAt))
        .limit(opts.pageSize)
        .offset((opts.page - 1) * opts.pageSize),
      this.db.select({ value: count() }).from(emailLogs).where(where),
    ]);
    return {
      data,
      total: Number(totalRows[0]?.value ?? 0),
      page: opts.page,
      pageSize: opts.pageSize,
    };
  }
}
