/**
 * ShippingRepository. Tenant-scoped access to `shipping_zones`
 * and `shipping_rates`, plus the two reads the engine needs: rates for a destination
 * country and variant weights for the cart.
 *
 * Zone membership (`countries` JSONB array) is matched case-insensitively in JS — a
 * tenant has a handful of zones, so fetching them and filtering avoids JSONB-case
 * pitfalls. Every query is tenant-scoped; rate writes anchor on the composite
 * `(zone_id, tenant_id)` FK so a rate can never attach to another tenant's zone.
 */
import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DatabaseService } from '../database/database.service';
import {
  shippingZones,
  type ShippingZone,
  type NewShippingZone,
} from '../database/schema/shipping_zones';
import {
  shippingRates,
  type ShippingRate,
  type NewShippingRate,
} from '../database/schema/shipping_rates';
import { productVariants } from '../database/schema/product_variants';

export interface ZoneInput {
  name: string;
  countries: string[];
}

export interface RateInput {
  zoneId: string;
  name: string;
  type: 'flat' | 'free_over' | 'weight_based';
  amount: number;
  currency: string;
  freeOverAmount?: number | null;
  weightMinGrams?: number | null;
  weightMaxGrams?: number | null;
}

@Injectable()
export class ShippingRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  // ── Reads used by the engine ──────────────────────────────────────────────────

  /** All rates whose zone (in this tenant) includes `country` (case-insensitive ISO). */
  async ratesForCountry(tenantId: string, country: string): Promise<ShippingRate[]> {
    const zones = await this.listZones(tenantId);
    const target = country.toUpperCase();
    const zoneIds = zones
      .filter(
        (z) =>
          Array.isArray(z.countries) &&
          (z.countries as unknown[]).some((c) => String(c).toUpperCase() === target),
      )
      .map((z) => z.id);
    if (zoneIds.length === 0) return [];
    return this.db
      .select()
      .from(shippingRates)
      .where(and(eq(shippingRates.tenantId, tenantId), inArray(shippingRates.zoneId, zoneIds)));
  }

  /** Map variantId → weight in grams (a null/absent weight counts as 0). Tenant-scoped. */
  async variantWeights(tenantId: string, variantIds: string[]): Promise<Map<string, number>> {
    if (variantIds.length === 0) return new Map();
    const rows = await this.db
      .select({ id: productVariants.id, weight: productVariants.weightGrams })
      .from(productVariants)
      .where(and(eq(productVariants.tenantId, tenantId), inArray(productVariants.id, variantIds)));
    return new Map(rows.map((r) => [r.id, r.weight ?? 0]));
  }

  // ── Zones CRUD ────────────────────────────────────────────────────────────────

  listZones(tenantId: string): Promise<ShippingZone[]> {
    return this.db
      .select()
      .from(shippingZones)
      .where(eq(shippingZones.tenantId, tenantId))
      .orderBy(shippingZones.name);
  }

  async findZone(tenantId: string, id: string): Promise<ShippingZone | null> {
    const [row] = await this.db
      .select()
      .from(shippingZones)
      .where(and(eq(shippingZones.tenantId, tenantId), eq(shippingZones.id, id)))
      .limit(1);
    return row ?? null;
  }

  async createZone(tenantId: string, input: ZoneInput): Promise<ShippingZone> {
    const values: NewShippingZone = {
      id: uuidv7(),
      tenantId,
      name: input.name,
      countries: input.countries.map((c) => c.toUpperCase()),
    };
    const [row] = await this.db.insert(shippingZones).values(values).returning();
    return row!;
  }

  async updateZone(
    tenantId: string,
    id: string,
    patch: Partial<ZoneInput>,
  ): Promise<ShippingZone | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.countries !== undefined) set.countries = patch.countries.map((c) => c.toUpperCase());
    const [row] = await this.db
      .update(shippingZones)
      .set(set)
      .where(and(eq(shippingZones.tenantId, tenantId), eq(shippingZones.id, id)))
      .returning();
    return row ?? null;
  }

  async deleteZone(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(shippingZones)
      .where(and(eq(shippingZones.tenantId, tenantId), eq(shippingZones.id, id)))
      .returning({ id: shippingZones.id });
    return rows.length > 0;
  }

  // ── Rates CRUD ────────────────────────────────────────────────────────────────

  listRates(tenantId: string): Promise<ShippingRate[]> {
    return this.db
      .select()
      .from(shippingRates)
      .where(eq(shippingRates.tenantId, tenantId))
      .orderBy(shippingRates.zoneId, shippingRates.amount);
  }

  async findRate(tenantId: string, id: string): Promise<ShippingRate | null> {
    const [row] = await this.db
      .select()
      .from(shippingRates)
      .where(and(eq(shippingRates.tenantId, tenantId), eq(shippingRates.id, id)))
      .limit(1);
    return row ?? null;
  }

  async createRate(tenantId: string, input: RateInput): Promise<ShippingRate> {
    const values: NewShippingRate = {
      id: uuidv7(),
      tenantId,
      zoneId: input.zoneId,
      name: input.name,
      type: input.type,
      amount: input.amount,
      currency: input.currency.toUpperCase(),
      freeOverAmount: input.freeOverAmount ?? null,
      weightMinGrams: input.weightMinGrams ?? null,
      weightMaxGrams: input.weightMaxGrams ?? null,
    };
    const [row] = await this.db.insert(shippingRates).values(values).returning();
    return row!;
  }

  async updateRate(
    tenantId: string,
    id: string,
    patch: Partial<RateInput>,
  ): Promise<ShippingRate | null> {
    const set: Record<string, unknown> = {};
    if (patch.zoneId !== undefined) set.zoneId = patch.zoneId;
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.type !== undefined) set.type = patch.type;
    if (patch.amount !== undefined) set.amount = patch.amount;
    if (patch.currency !== undefined) set.currency = patch.currency.toUpperCase();
    if (patch.freeOverAmount !== undefined) set.freeOverAmount = patch.freeOverAmount;
    if (patch.weightMinGrams !== undefined) set.weightMinGrams = patch.weightMinGrams;
    if (patch.weightMaxGrams !== undefined) set.weightMaxGrams = patch.weightMaxGrams;
    if (Object.keys(set).length === 0) return this.findRate(tenantId, id);
    const [row] = await this.db
      .update(shippingRates)
      .set(set)
      .where(and(eq(shippingRates.tenantId, tenantId), eq(shippingRates.id, id)))
      .returning();
    return row ?? null;
  }

  async deleteRate(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(shippingRates)
      .where(and(eq(shippingRates.tenantId, tenantId), eq(shippingRates.id, id)))
      .returning({ id: shippingRates.id });
    return rows.length > 0;
  }
}
