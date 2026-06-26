/**
 * TenantSettingsService.
 *
 * Tenant-scoped read/write of the `tenants.settings` JSONB, with a small in-process
 * cache (mirrors StoreTenantService's caching). Exposes TYPED accessors for the tax
 * regime so callers never touch raw JSON. Defaults for a fresh store (empty JSONB):
 * `tax_mode='none'`, `prices_include_tax=true`, `oss_posture='below_threshold'`,
 * no EU-VAT registration. Writes are a read-merge-write (partial update) so unrelated
 * keys are preserved.
 *
 * Validation of the regime values lives here (defence at the boundary): an unknown
 * `tax_mode` or `oss_posture` in the DB collapses to the safe default rather than
 * throwing — the engine must never be handed a garbage mode.
 */
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { tenants } from '../database/schema/_tenants';

export type TaxMode = 'none' | 'eu_vat';
export type OssPosture = 'below_threshold' | 'above_or_opted_in';

/** EU-VAT registration details (only meaningful when `tax_mode='eu_vat'`). */
export interface EuVatRegistration {
  /** Merchant's country of establishment (ISO 3166-1 alpha-2, upper), or null. */
  originCountry: string | null;
  /** Merchant's own VAT number, or null. */
  vatNumber: string | null;
}

/** The fully-resolved, typed tax settings for a tenant. */
export interface TaxSettings {
  taxMode: TaxMode;
  pricesIncludeTax: boolean;
  ossPosture: OssPosture;
  euVatRegistration: EuVatRegistration;
}

/**
 * Onboarding profile — the business country + default currency captured in the
 * setup wizard's tax step. Stored alongside the tax regime in `tenants.settings` under
 * `business_country` / `default_currency`. `null` when not yet configured.
 */
export interface OnboardingProfile {
  /** Business country of establishment (ISO 3166-1 alpha-2, upper), or null. */
  businessCountry: string | null;
  /** Store default currency (ISO 4217, upper), or null. */
  defaultCurrency: string | null;
}

/**
 * Analytics config — stored in `tenants.settings.analytics`. All optional: `null` when
 * unset. Plausible is the cookieless default; GA4/Meta are consent-gated storefront-side.
 * Values reach storefront `<script>` attributes, so they are allowlist-validated on parse.
 */
export interface AnalyticsSettings {
  /** Plausible `data-domain` (one host or a comma-separated list), or null. */
  plausibleDomain: string | null;
  /** GA4 measurement id (e.g. `G-XXXXXXXX`), or null. */
  ga4Id: string | null;
  /** Meta Pixel id (numeric), or null. */
  metaPixelId: string | null;
}

/** A partial update to the analytics settings (PUT merges over current; `null` clears a field). */
export type AnalyticsSettingsPatch = Partial<AnalyticsSettings>;

/**
 * Business identity — the seller (merchant) details printed on INVOICES (legal mentions,
 * SIREN). Stored in `tenants.settings.business_identity`. Mirrors the shape read by
 * InvoiceService.loadSellerIdentity. Money/legal-sensitive: validated at the controller
 * boundary (Zod) before it reaches here.
 */
export interface BusinessIdentityAddress {
  name: string | null;
  company: string | null;
  line1: string;
  line2: string | null;
  city: string;
  postalCode: string | null;
  country: string;
}

export interface BusinessIdentity {
  /** Trading/legal name printed on the invoice; null falls back to the tenant name. */
  name: string | null;
  /** SIREN/SIRET registration number (FR), or null. */
  siren: string | null;
  /** Seller postal address, or null when not yet configured. */
  address: BusinessIdentityAddress | null;
}

/** A partial update to the business identity (PUT merges over current; `null` clears a field). */
export interface BusinessIdentityPatch {
  name?: string | null;
  siren?: string | null;
  /** `null` clears the whole address; a record replaces it. */
  address?: BusinessIdentityAddress | null;
}

/** A partial update to the tax settings (PUT semantics merge over current). */
export interface TaxSettingsPatch {
  taxMode?: TaxMode;
  pricesIncludeTax?: boolean;
  ossPosture?: OssPosture;
  euVatRegistration?: Partial<EuVatRegistration>;
}

const TAX_MODES: ReadonlySet<string> = new Set<TaxMode>(['none', 'eu_vat']);
const OSS_POSTURES: ReadonlySet<string> = new Set<OssPosture>([
  'below_threshold',
  'above_or_opted_in',
]);

@Injectable()
export class TenantSettingsService {
  /** Per-tenant cache of the raw settings JSONB. Invalidated on write. */
  private readonly cache = new Map<string, Record<string, unknown>>();

  constructor(private readonly db: DatabaseService) {}

  /** Read + parse the typed tax settings for a tenant. */
  async getTaxSettings(tenantId: string): Promise<TaxSettings> {
    const raw = await this.loadRaw(tenantId);
    return parseTaxSettings(raw);
  }

  /** Read + parse the onboarding profile (business country + default currency). */
  async getOnboardingProfile(tenantId: string): Promise<OnboardingProfile> {
    const raw = await this.loadRaw(tenantId);
    return parseOnboardingProfile(raw);
  }

  /**
   * Merge the onboarding profile (business country + default currency) into the
   * tenant's settings JSONB (read-merge-write), preserving unrelated keys. Codes are
   * normalised to upper-case. Goes through the same cache as the tax seam so a subsequent
   * typed read sees the new values.
   */
  async updateOnboardingProfile(
    tenantId: string,
    patch: Partial<OnboardingProfile>,
  ): Promise<OnboardingProfile> {
    const raw = await this.loadRaw(tenantId);
    const merged: Record<string, unknown> = { ...raw };

    if (patch.businessCountry !== undefined) {
      merged.business_country =
        patch.businessCountry == null ? null : patch.businessCountry.toUpperCase();
    }
    if (patch.defaultCurrency !== undefined) {
      merged.default_currency =
        patch.defaultCurrency == null ? null : patch.defaultCurrency.toUpperCase();
    }

    await this.db.db
      .update(tenants)
      .set({ settings: merged, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));

    this.cache.set(tenantId, merged);
    return parseOnboardingProfile(merged);
  }

  /**
   * Merge a partial patch into the tenant's settings JSONB (read-merge-write),
   * preserving unrelated keys, and return the new typed tax settings. The caller
   * (admin controller) enforces the EU guardrail BEFORE calling this.
   */
  async updateTaxSettings(tenantId: string, patch: TaxSettingsPatch): Promise<TaxSettings> {
    const raw = await this.loadRaw(tenantId);
    const merged: Record<string, unknown> = { ...raw };

    if (patch.taxMode !== undefined) merged.tax_mode = patch.taxMode;
    if (patch.pricesIncludeTax !== undefined) merged.prices_include_tax = patch.pricesIncludeTax;
    if (patch.ossPosture !== undefined) merged.oss_posture = patch.ossPosture;
    if (patch.euVatRegistration !== undefined) {
      const current = isRecord(raw.eu_vat_registration) ? raw.eu_vat_registration : {};
      const next: Record<string, unknown> = { ...current };
      if (patch.euVatRegistration.originCountry !== undefined) {
        next.origin_country =
          patch.euVatRegistration.originCountry == null
            ? null
            : patch.euVatRegistration.originCountry.toUpperCase();
      }
      if (patch.euVatRegistration.vatNumber !== undefined) {
        next.vat_number = patch.euVatRegistration.vatNumber;
      }
      merged.eu_vat_registration = next;
    }

    await this.db.db
      .update(tenants)
      .set({ settings: merged, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));

    this.cache.set(tenantId, merged);
    return parseTaxSettings(merged);
  }

  /** Read + parse the typed analytics settings for a tenant. */
  async getAnalyticsSettings(tenantId: string): Promise<AnalyticsSettings> {
    const raw = await this.loadRaw(tenantId);
    return parseAnalyticsSettings(raw);
  }

  /**
   * Merge an analytics patch into the tenant's `settings.analytics` (read-merge-write),
   * preserving unrelated keys. `undefined` field = leave unchanged; `null` or '' = clear.
   * Values are re-validated through {@link parseAnalyticsSettings} on the way out.
   */
  async updateAnalyticsSettings(
    tenantId: string,
    patch: AnalyticsSettingsPatch,
  ): Promise<AnalyticsSettings> {
    const raw = await this.loadRaw(tenantId);
    const current = isRecord(raw.analytics) ? raw.analytics : {};
    const next: Record<string, unknown> = { ...current };
    if (patch.plausibleDomain !== undefined) next.plausible_domain = patch.plausibleDomain;
    if (patch.ga4Id !== undefined) next.ga4_id = patch.ga4Id;
    if (patch.metaPixelId !== undefined) next.meta_pixel_id = patch.metaPixelId;
    const merged: Record<string, unknown> = { ...raw, analytics: next };

    await this.db.db
      .update(tenants)
      .set({ settings: merged, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));

    this.cache.set(tenantId, merged);
    return parseAnalyticsSettings(merged);
  }

  /** Read + parse the typed business identity (invoice seller details) for a tenant. */
  async getBusinessIdentity(tenantId: string): Promise<BusinessIdentity> {
    const raw = await this.loadRaw(tenantId);
    return parseBusinessIdentity(raw);
  }

  /**
   * Merge a business-identity patch into `tenants.settings.business_identity`
   * (read-merge-write), preserving unrelated settings keys. `undefined` field =
   * leave unchanged; `null` = clear that field. The controller has already
   * validated the patch (Zod) — this is the persistence seam, parsed on the way out.
   */
  async updateBusinessIdentity(
    tenantId: string,
    patch: BusinessIdentityPatch,
  ): Promise<BusinessIdentity> {
    const raw = await this.loadRaw(tenantId);
    const current = isRecord(raw.business_identity) ? raw.business_identity : {};
    const next: Record<string, unknown> = { ...current };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.siren !== undefined) next.siren = patch.siren;
    if (patch.address !== undefined) {
      next.address = patch.address == null ? null : { ...patch.address };
    }
    const merged: Record<string, unknown> = { ...raw, business_identity: next };

    await this.db.db
      .update(tenants)
      .set({ settings: merged, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));

    this.cache.set(tenantId, merged);
    return parseBusinessIdentity(merged);
  }

  /** Read + parse the typed EU-VAT registration (origin country + VAT number). */
  async getEuVatRegistration(tenantId: string): Promise<EuVatRegistration> {
    const raw = await this.loadRaw(tenantId);
    return parseTaxSettings(raw).euVatRegistration;
  }

  /**
   * Merge an EU-VAT-registration patch into `tenants.settings.eu_vat_registration`
   * (read-merge-write), preserving unrelated settings keys. Codes are upper-cased.
   * `undefined` = leave unchanged; `null` = clear. Reuses the same JSONB the tax
   * regime reads, so a subsequent invoice render sees the new values.
   */
  async updateEuVatRegistration(
    tenantId: string,
    patch: Partial<EuVatRegistration>,
  ): Promise<EuVatRegistration> {
    const raw = await this.loadRaw(tenantId);
    const current = isRecord(raw.eu_vat_registration) ? raw.eu_vat_registration : {};
    const next: Record<string, unknown> = { ...current };
    if (patch.originCountry !== undefined) {
      next.origin_country = patch.originCountry == null ? null : patch.originCountry.toUpperCase();
    }
    if (patch.vatNumber !== undefined) next.vat_number = patch.vatNumber;
    const merged: Record<string, unknown> = { ...raw, eu_vat_registration: next };

    await this.db.db
      .update(tenants)
      .set({ settings: merged, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));

    this.cache.set(tenantId, merged);
    return parseTaxSettings(merged).euVatRegistration;
  }

  /** Drop the cached settings for a tenant (e.g. after an out-of-band change). */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  private async loadRaw(tenantId: string): Promise<Record<string, unknown>> {
    const cached = this.cache.get(tenantId);
    if (cached) return cached;

    const [row] = await this.db.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const raw = isRecord(row?.settings) ? (row!.settings as Record<string, unknown>) : {};
    this.cache.set(tenantId, raw);
    return raw;
  }
}

/** Parse the raw JSONB into typed settings, falling back to safe defaults. */
export function parseTaxSettings(raw: Record<string, unknown>): TaxSettings {
  const taxMode: TaxMode =
    typeof raw.tax_mode === 'string' && TAX_MODES.has(raw.tax_mode)
      ? (raw.tax_mode as TaxMode)
      : 'none';

  const pricesIncludeTax =
    typeof raw.prices_include_tax === 'boolean' ? raw.prices_include_tax : true;

  const ossPosture: OssPosture =
    typeof raw.oss_posture === 'string' && OSS_POSTURES.has(raw.oss_posture)
      ? (raw.oss_posture as OssPosture)
      : 'below_threshold';

  const reg = isRecord(raw.eu_vat_registration) ? raw.eu_vat_registration : {};
  const originCountry =
    typeof reg.origin_country === 'string' && reg.origin_country.length === 2
      ? reg.origin_country.toUpperCase()
      : null;
  const vatNumber = typeof reg.vat_number === 'string' ? reg.vat_number : null;

  return {
    taxMode,
    pricesIncludeTax,
    ossPosture,
    euVatRegistration: { originCountry, vatNumber },
  };
}

/** Parse the raw JSONB into the typed onboarding profile (null when unset). */
export function parseOnboardingProfile(raw: Record<string, unknown>): OnboardingProfile {
  const businessCountry =
    typeof raw.business_country === 'string' && raw.business_country.length === 2
      ? raw.business_country.toUpperCase()
      : null;
  const defaultCurrency =
    typeof raw.default_currency === 'string' && raw.default_currency.length === 3
      ? raw.default_currency.toUpperCase()
      : null;
  return { businessCountry, defaultCurrency };
}

/**
 * Parse the raw JSONB into typed analytics settings, `null` per unset/invalid field.
 * Defensive boundary: these values reach storefront `<script>` attributes, so each is trimmed,
 * length-bounded, and allowlist-checked — anything with markup-breaking or out-of-set chars is
 * dropped to `null` (graceful: the storefront simply omits that script).
 */
export function parseAnalyticsSettings(raw: Record<string, unknown>): AnalyticsSettings {
  const a = isRecord(raw.analytics) ? raw.analytics : {};
  return {
    // Plausible domains: one or more comma-separated hosts (letters/digits/dot/hyphen). The grouped
    // pattern rejects empty / leading / trailing / doubled commas (e.g. "a.com," is invalid).
    plausibleDomain: cleanField(a.plausible_domain, /^[A-Za-z0-9.-]+(,[A-Za-z0-9.-]+)*$/, 253),
    // GA4 measurement id, e.g. G-XXXXXXXX.
    ga4Id: cleanField(a.ga4_id, /^[A-Za-z0-9-]+$/, 32),
    // Meta Pixel id is numeric.
    metaPixelId: cleanField(a.meta_pixel_id, /^[0-9]+$/, 32),
  };
}

/**
 * Parse the raw JSONB into the typed business identity (invoice seller details).
 * Mirrors InvoiceService.loadSellerIdentity / coerceAddress: an address is only
 * returned when line1/city/country are all present (the minimum a printable address
 * needs); otherwise `address` is null. Non-string fields collapse to null.
 */
export function parseBusinessIdentity(raw: Record<string, unknown>): BusinessIdentity {
  const id = isRecord(raw.business_identity) ? raw.business_identity : {};
  return {
    name: typeof id.name === 'string' ? id.name : null,
    siren: typeof id.siren === 'string' ? id.siren : null,
    address: parseBusinessAddress(id.address),
  };
}

function parseBusinessAddress(raw: unknown): BusinessIdentityAddress | null {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.line1 !== 'string' ||
    typeof raw.city !== 'string' ||
    typeof raw.country !== 'string'
  ) {
    return null;
  }
  return {
    name: typeof raw.name === 'string' ? raw.name : null,
    company: typeof raw.company === 'string' ? raw.company : null,
    line1: raw.line1,
    line2: typeof raw.line2 === 'string' ? raw.line2 : null,
    city: raw.city,
    postalCode: typeof raw.postalCode === 'string' ? raw.postalCode : null,
    country: raw.country,
  };
}

/** Trim, length-bound, and allowlist-check a string field; anything failing → null. */
function cleanField(value: unknown, allow: RegExp, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLen) return null;
  return allow.test(trimmed) ? trimmed : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
