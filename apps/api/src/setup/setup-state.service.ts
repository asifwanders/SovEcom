/**
 * SetupStateService.
 *
 * Minimal accessor for the GLOBAL `system_state` singleton (no tenant scope).
 * Reads the `installed` flag and provides default-tenant access.
 *
 * `installed` is `true` ONLY when the `system_state.installed` jsonb value is the
 * boolean `true`. An ABSENT row (production, no seed) or any non-`true` value
 * (e.g. the seed's `false`) is treated as NOT installed (fail-safe toward
 * "show the setup flow" rather than "lock everything out").
 */
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { systemState } from '../database/schema/system_state';

@Injectable()
export class SetupStateService {
  /** Cached `default_tenant_id` (fixed for the deployment's lifetime). */
  private defaultTenantId: string | null = null;

  constructor(private readonly database: DatabaseService) {}

  /**
   * True only when `system_state.installed === true`. Absent key / any other
   * value ⇒ false (not yet installed). No caching: `installed` flips at most once
   * per deployment and the read is a single indexed PK lookup.
   */
  async isInstalled(): Promise<boolean> {
    const [row] = await this.database.db
      .select({ value: systemState.value })
      .from(systemState)
      .where(eq(systemState.key, 'installed'))
      .limit(1);

    return row?.value === true;
  }

  /**
   * Resolve the default tenant the setup wizard writes against.
   *
   * v1 is single-tenant: the seed creates exactly one tenant and stores its id under
   * `system_state.default_tenant_id`. Every setup-step write (secrets, settings)
   * scopes to it, and it is the AEAD AAD that binds secret ciphertext to the tenant.
   *
   * Cached after the first read (the value is fixed for the deployment's lifetime —
   * it is set once at seed time and never changes). Mirrors the lazy-cache pattern in
   * `reset.service.ts` / `auth.service.ts`. Throws if absent (an unseeded DB is a
   * deployment error, never a silent fallback).
   */
  async getDefaultTenantId(): Promise<string> {
    if (this.defaultTenantId) {
      return this.defaultTenantId;
    }
    const [row] = await this.database.db
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
