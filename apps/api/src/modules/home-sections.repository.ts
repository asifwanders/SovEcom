/**
 * HomeSectionsRepository.
 *
 * Tenant-scoped access to `storefront_home_sections`. Every query filters on `tenant_id`, so a
 * tenant can never read or write another tenant's home sections. The table is a singleton per
 * tenant (`UNIQUE(tenant_id)`) — `set` uses an upsert (INSERT … ON CONFLICT … DO UPDATE) so the
 * caller never needs to manage row existence explicitly.
 *
 * Mirrors `themes.repository.ts` structure and tenant-isolation pattern.
 */
import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DatabaseService } from '../database/database.service';
import {
  storefrontHomeSections,
  type StorefrontHomeSection,
} from '../database/schema/storefront_home_sections';
import type { MarketingSectionDescriptor } from '@sovecom/theme-sdk';

@Injectable()
export class HomeSectionsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Retrieve the home sections row for this tenant, or null if never set. Tenant-scoped.
   */
  async get(tenantId: string): Promise<StorefrontHomeSection | null> {
    const [row] = await this.db
      .select()
      .from(storefrontHomeSections)
      .where(eq(storefrontHomeSections.tenantId, tenantId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Upsert the home sections for this tenant. On first write a new row is inserted; on subsequent
   * writes the `sections` and `updated_at` columns are replaced. Tenant-scoped — the upsert key is
   * `(tenant_id)` via the `storefront_home_sections_tenant_uq` constraint.
   */
  async set(
    tenantId: string,
    sections: MarketingSectionDescriptor[],
  ): Promise<StorefrontHomeSection> {
    const [row] = await this.db
      .insert(storefrontHomeSections)
      .values({
        id: uuidv7(),
        tenantId,
        sections: sections as unknown as Record<string, unknown>[],
      })
      .onConflictDoUpdate({
        target: storefrontHomeSections.tenantId,
        set: {
          sections: sections as unknown as Record<string, unknown>[],
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return row!;
  }
}
