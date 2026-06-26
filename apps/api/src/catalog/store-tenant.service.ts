/**
 * StoreTenantService.
 *
 * Resolves and caches the default tenant ID for anonymous store requests.
 * Mirrors how AuthService.getDefaultTenantId works.
 * Single-tenant v1: there is ONE default tenant; store endpoints use it.
 */
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { systemState } from '../database/schema/system_state';

@Injectable()
export class StoreTenantService {
  private defaultTenantId: string | null = null;

  constructor(private readonly db: DatabaseService) {}

  async getDefaultTenantId(): Promise<string> {
    if (this.defaultTenantId) return this.defaultTenantId;

    const [row] = await this.db.db
      .select({ value: systemState.value })
      .from(systemState)
      .where(eq(systemState.key, 'default_tenant_id'))
      .limit(1);

    if (!row || typeof row.value !== 'string') {
      throw new Error('default_tenant_id is not set in system_state');
    }

    this.defaultTenantId = row.value;
    return this.defaultTenantId;
  }
}
