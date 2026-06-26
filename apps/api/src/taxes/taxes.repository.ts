/**
 * TaxesRepository. Tenant-scoped access to `tax_rates`.
 *
 * Rate lookup is keyed by `(country, region)` with `region NULL` = the country-wide
 * default — there is no `tax_zones` table. `rate` is NUMERIC(5,4), which postgres-js
 * returns as a STRING — the resolver wants a fraction, so the lookups parse to Number
 * here at the boundary. Every query is tenant-scoped.
 */
import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DatabaseService } from '../database/database.service';
import { taxRates, type TaxRate, type NewTaxRate } from '../database/schema/tax_rates';

export interface TaxRateInput {
  country: string;
  region?: string | null;
  /** Stored as NUMERIC(5,4) string (e.g. "0.2000"). */
  rate: string;
  name: string;
}

@Injectable()
export class TaxesRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Resolve the STANDARD VAT rate (as a fraction, e.g. 0.2) for a country's
   * country-wide default row (`region IS NULL`). Returns null when no row exists.
   * Tenant-scoped. (Region-specific rates are seedable but v1 uses the country default.)
   */
  async countryRate(tenantId: string, country: string): Promise<number | null> {
    const [row] = await this.db
      .select({ rate: taxRates.rate })
      .from(taxRates)
      .where(
        and(
          eq(taxRates.tenantId, tenantId),
          eq(taxRates.country, country.toUpperCase()),
          isNull(taxRates.region),
        ),
      )
      .limit(1);
    if (!row) return null;
    const n = Number(row.rate);
    return Number.isFinite(n) ? n : null;
  }

  // ── Admin CRUD ────────────────────────────────────────────────────────────────

  async list(tenantId: string): Promise<TaxRate[]> {
    return this.db
      .select()
      .from(taxRates)
      .where(eq(taxRates.tenantId, tenantId))
      .orderBy(taxRates.country);
  }

  async findById(tenantId: string, id: string): Promise<TaxRate | null> {
    const [row] = await this.db
      .select()
      .from(taxRates)
      .where(and(eq(taxRates.tenantId, tenantId), eq(taxRates.id, id)))
      .limit(1);
    return row ?? null;
  }

  async create(tenantId: string, input: TaxRateInput): Promise<TaxRate> {
    const values: NewTaxRate = {
      id: uuidv7(),
      tenantId,
      country: input.country.toUpperCase(),
      region: input.region ?? null,
      rate: input.rate,
      name: input.name,
    };
    const [row] = await this.db.insert(taxRates).values(values).returning();
    return row!;
  }

  async update(
    tenantId: string,
    id: string,
    patch: Partial<TaxRateInput>,
  ): Promise<TaxRate | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.country !== undefined) set.country = patch.country.toUpperCase();
    if (patch.region !== undefined) set.region = patch.region ?? null;
    if (patch.rate !== undefined) set.rate = patch.rate;
    if (patch.name !== undefined) set.name = patch.name;
    const [row] = await this.db
      .update(taxRates)
      .set(set)
      .where(and(eq(taxRates.tenantId, tenantId), eq(taxRates.id, id)))
      .returning();
    return row ?? null;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(taxRates)
      .where(and(eq(taxRates.tenantId, tenantId), eq(taxRates.id, id)))
      .returning({ id: taxRates.id });
    return rows.length > 0;
  }
}
