/**
 * SetupOnboardingService.
 *
 * The NON-secret setup writes: tax/compliance/brand persistence + the REAL themes + modules
 * steps. Kept separate from SetupConfigService (which owns the credential probes /
 * AEAD-at-rest seam) so the onboarding-profile / settings logic is unit-testable on its
 * own and neither file grows past the 500-line rule.
 *
 * Security/correctness posture:
 *   - Tax writes go THROUGH `TenantSettingsService` (the typed read-merge-write seam) —
 *     never a hand-rolled JSONB merge that bypasses its defaults/validation. The EU
 *     guardrail is the SHARED `enforceEuGuardrail` the admin controller uses (one rule).
 *   - VIES validation FAILS OPEN (a VIES outage never blocks setup); the status is
 *     recorded so it is actionable, exactly like the customer flow.
 *   - compliance: cookie-consent is hard-pinned on regardless of input.
 *   - brand: the logo is uploaded via StorageService (path-traversal-safe keys); only
 *     the storage KEY + non-secret colours land in settings.
 *   - themes are REAL: list/activate go through the shared {@link ThemesService} over the
 *     tenant-scoped `installed_themes` table (the same read/activation path the admin
 *     theme-switcher uses), so the wizard lists the seeded `default`/`boutique` themes and
 *     activating one flips `is_active` (single-active-per-tenant invariant). No duplication.
 *   - modules are REAL but ALLOWLISTED: only the platform's BUILT-IN modules
 *     ({@link BUNDLED_MODULES}) are installable at setup — validated BEFORE any FS/ingest, so an
 *     arbitrary or path-traversing name is rejected with no filesystem access. Install reuses the
 *     hardened {@link ModulesService} (GuardedTarExtractor re-extract + re-verify, NO code run) and
 *     enable forks the existing sandboxed worker via {@link ModuleRuntimeService}. Idempotent +
 *     per-module fault isolation. No arbitrary tarball upload at setup (that is admin-only).
 */
import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import * as fsp from 'fs/promises';
import { eq } from 'drizzle-orm';
import type { Express } from 'express';
import sharp from 'sharp';
import { uuidv7 } from 'uuidv7';
import { DatabaseService } from '../database/database.service';
import { tenants } from '../database/schema/_tenants';
import { StorageService } from '../storage/storage.service';
import {
  TenantSettingsService,
  type AnalyticsSettingsPatch,
} from '../taxes/tenant-settings.service';
import { enforceEuGuardrail } from '../taxes/eu-guardrail';
import { isEuCountry } from '../taxes/engine/eu-vat-rules';
import { ViesService } from '../customers/vies/vies.service';
import type { ViesStatus } from '../customers/vies/vies.client';
import { ThemesService } from '../modules/themes.service';
import { ModulesService } from '../modules/modules.service';
import { ModuleRuntimeService } from '../modules/runtime/module-runtime.service';
import {
  BUNDLED_MODULES,
  bundledModule,
  bundledTgzPath,
  isBundledModuleId,
  readBundledManifest,
} from '../modules/bundled-modules';
import type { TaxConfigureDto } from './dto/tax.dto';
import type { ComplianceConfigureDto } from './dto/compliance.dto';
import type { BrandConfigureDto } from './dto/brand.dto';

/** A theme card surfaced to the wizard's ThemeStep (the minimal fields it renders). */
export interface SetupThemeView {
  /** The theme NAME — the activation key passed back to `themes/activate`. */
  id: string;
  /** Human-facing name shown on the card (the bundled themes use a capitalised name). */
  name: string;
  /** A preview marker — `'placeholder'` until real screenshots exist. */
  preview: string;
}

/**
 * A bundled-module catalog card surfaced to the wizard's ModulesStep. `id` is the install key
 * (the manifest name); `displayName`/`permissions`/`slots` come from the module's own manifest;
 * `description` is the registry's operator-facing one-liner; `installed` reflects whether the
 * default tenant already has it (so a re-run shows state).
 */
export interface SetupModuleView {
  id: string;
  /** Alias of `id` for the wizard card key (kept for parity with the theme card `name`). */
  name: string;
  displayName: string;
  description: string;
  permissions: string[];
  slots: { slot: string; component: string }[];
  installed: boolean;
}

/** Result of the tax/configure step surfaced to the wizard (no secrets). */
export interface TaxConfigureResult {
  taxMode: 'none' | 'eu_vat';
  businessCountry: string;
  defaultCurrency: string;
  /** Present only when a VAT number was VIES-checked; reflects the tri-state. */
  vatStatus?: ViesStatus;
  /**
   * Human-facing explanation of the VIES validation result.
   * Present when vatStatus is set, to clarify what each status means for operations.
   */
  vatStatusMessage?: string;
}

/**
 * Accepted logo MIME types — RASTER ONLY. SVG is intentionally excluded: an SVG
 * is an executable document (it can carry inline <script>) and the brand logo is served
 * inline/publicly, so accepting one is a stored-XSS vector. The declared mimetype is only
 * a first-pass gate; the bytes are additionally sniffed via sharp (see configureBrand).
 */
const LOGO_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
/** sharp's probed `format` values that count as a genuine raster image (byte-sniff). */
const RASTER_FORMATS: ReadonlySet<string> = new Set(['png', 'jpeg', 'webp']);
const LOGO_MAX_BYTES = 5 * 1024 * 1024; // 5 MB — a logo, not a hero image.
/** Decode-bomb guard for the byte-sniff probe (mirrors the images pipeline). */
const LOGO_MAX_PIXELS = 40_000_000;

@Injectable()
export class SetupOnboardingService {
  private readonly logger = new Logger(SetupOnboardingService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly settings: TenantSettingsService,
    private readonly vies: ViesService,
    private readonly storage: StorageService,
    private readonly themes: ThemesService,
    private readonly modules: ModulesService,
    private readonly runtime: ModuleRuntimeService,
  ) {}

  // ─── tax/configure ────────────────────────────────────────────────────────────

  /**
   * Persist the tax regime + onboarding profile. Defaults `taxMode` from the
   * business country (EU→eu_vat, else none), enforces the SHARED EU guardrail, VIES-
   * validates the VAT number for eu_vat (fail-open), then writes the tax settings AND
   * `business_country` + `default_currency` through `TenantSettingsService`.
   */
  async configureTax(tenantId: string, dto: TaxConfigureDto): Promise<TaxConfigureResult> {
    const businessCountry = dto.businessCountry; // already upper-cased by the DTO.
    const defaultCurrency = dto.defaultCurrency;

    // 1. Default taxMode from the business country when omitted.
    const taxMode = dto.taxMode ?? (isEuCountry(businessCountry) ? 'eu_vat' : 'none');

    // 2. EU guardrail (SHARED with the admin controller). The origin IS the business
    //    country here (single-establishment setup), so effective === current origin.
    enforceEuGuardrail(taxMode, businessCountry);

    // 3. eu_vat additionally requires a VAT number.
    if (taxMode === 'eu_vat' && !dto.vatNumber) {
      throw new BadRequestException(
        "tax_mode='eu_vat' requires a VAT number (vatNumber) — the merchant's EU VAT registration.",
      );
    }

    // 4. VIES-validate the VAT number (fail-open — a VIES outage never blocks setup).
    let vatStatus: ViesStatus | undefined;
    let vatStatusMessage: string | undefined;
    if (taxMode === 'eu_vat' && dto.vatNumber) {
      const result = await this.vies.validateVatNumber(dto.vatNumber);
      vatStatus = result.status;
      // Provide a human-facing message explaining the VIES result to the operator.
      if (vatStatus === 'valid') {
        vatStatusMessage = 'VAT number validated successfully. B2B reverse-charge will apply.';
      } else if (vatStatus === 'invalid') {
        vatStatusMessage = 'VAT number validation failed. VAT will be charged on all sales.';
      } else if (vatStatus === 'unreachable') {
        vatStatusMessage =
          'VAT validation service (VIES) is currently unreachable. VAT will be charged on all sales as a precaution. The validation will be retried automatically later, and if the number is valid, reverse-charge can be applied retrospectively.';
      }
    }

    // 5. Persist tax regime via the typed seam (read-merge-write, defaults respected).
    await this.settings.updateTaxSettings(tenantId, {
      taxMode,
      pricesIncludeTax: dto.pricesIncludeTax,
      ossPosture: dto.ossPosture,
      euVatRegistration:
        taxMode === 'eu_vat'
          ? { originCountry: businessCountry, vatNumber: dto.vatNumber ?? null }
          : { originCountry: businessCountry, vatNumber: null },
    });

    // 6. Persist the onboarding profile (business country + default currency).
    await this.settings.updateOnboardingProfile(tenantId, { businessCountry, defaultCurrency });

    return { taxMode, businessCountry, defaultCurrency, vatStatus, vatStatusMessage };
  }

  // ─── compliance/configure ──────────────────────────────────────────────────────

  /**
   * Write the compliance/analytics posture into `settings.compliance` (read-merge-write
   * so unrelated settings survive). Cookie consent is HARD-PINNED on (RGPD), regardless
   * of the (already `true`-only) input. Analytics ids are non-secret public markers.
   */
  async configureCompliance(tenantId: string, dto: ComplianceConfigureDto): Promise<void> {
    const analytics = dto.analytics ?? {};
    const compliance = {
      cookie_consent: true, // locked on — RGPD non-negotiable.
      analytics: {
        plausible: analytics.plausible ?? false,
        ga: analytics.ga ? { id: analytics.ga.id } : null,
        meta: analytics.meta ? { pixel_id: analytics.meta.pixelId } : null,
      },
    };
    await this.mergeSettings(tenantId, { compliance });

    // Mirror the analytics ids the wizard collects into `settings.analytics` (what the storefront
    // actually reads) — the `settings.compliance` markers above are legacy/informational. Only fields
    // the operator supplied are written (partial merge); GA/Meta are also editable later in admin.
    const analyticsPatch: AnalyticsSettingsPatch = {};
    if (analytics.plausibleDomain !== undefined) {
      analyticsPatch.plausibleDomain = analytics.plausibleDomain;
    }
    if (analytics.ga !== undefined) analyticsPatch.ga4Id = analytics.ga.id;
    if (analytics.meta !== undefined) analyticsPatch.metaPixelId = analytics.meta.pixelId;
    if (Object.keys(analyticsPatch).length > 0) {
      await this.settings.updateAnalyticsSettings(tenantId, analyticsPatch);
    }
  }

  // ─── brand ────────────────────────────────────────────────────────────────────

  /**
   * Upload the logo (when present) via StorageService and persist the storage KEY +
   * colours/gradient into `settings.brand`. Validates the logo content-type + size; only
   * the key (never bytes) lands in settings. A brand with no logo just records colours.
   */
  async configureBrand(
    tenantId: string,
    dto: BrandConfigureDto,
    logo: Express.Multer.File | undefined,
  ): Promise<{ logoKey: string | null }> {
    let logoKey: string | null = null;

    if (logo) {
      if (!LOGO_MIME.has(logo.mimetype)) {
        throw new BadRequestException(
          `Unsupported logo type '${logo.mimetype}' — use PNG, JPEG, or WebP (SVG is not allowed).`,
        );
      }
      if (logo.size > LOGO_MAX_BYTES) {
        throw new BadRequestException('Logo exceeds the 5 MB size limit.');
      }
      // never trust the client-supplied mimetype. Byte-sniff with sharp (header
      // read, no full decode) and require a genuine RASTER format. This rejects an SVG
      // (probed format 'svg') even when its mimetype lies that it is a raster image,
      // closing the stored-XSS path that the brand logo previously left open.
      let probedFormat: string | undefined;
      try {
        const meta = await sharp(logo.buffer, {
          limitInputPixels: LOGO_MAX_PIXELS,
          failOn: 'warning',
        }).metadata();
        probedFormat = meta.format;
      } catch {
        throw new BadRequestException('Logo is not a valid raster image (PNG, JPEG, or WebP).');
      }
      if (!probedFormat || !RASTER_FORMATS.has(probedFormat)) {
        throw new BadRequestException('Logo is not a valid raster image (PNG, JPEG, or WebP).');
      }
      const ext = EXT_BY_MIME[logo.mimetype] ?? 'bin';
      const uploaded = await this.storage.upload(
        { tenantId, resourceType: 'brand', resourceId: uuidv7(), filename: `logo.${ext}` },
        logo.buffer,
        logo.mimetype,
      );
      logoKey = uploaded.key;
    }

    const brand: Record<string, unknown> = {
      logo_key: logoKey,
      colors: { primary: dto.primary ?? null, secondary: dto.secondary ?? null },
      gradient: dto.gradient ?? false,
    };
    await this.mergeSettings(tenantId, { brand });
    return { logoKey };
  }

  // ─── themes (REAL — reuses ThemesService over installed_themes) ────────────────

  /**
   * List the tenant's installed themes (the seeded `default`/`boutique` and any uploaded
   * ones) via the SHARED {@link ThemesService} — the same tenant-scoped `installed_themes`
   * read the admin theme-switcher uses. Projected to the minimal card shape the wizard's
   * ThemeStep renders; the card `id` is the theme NAME (the activation key).
   */
  async listThemes(tenantId: string): Promise<{ themes: SetupThemeView[] }> {
    const installed = await this.themes.list(tenantId);
    const themes = installed.map((th) => ({ id: th.name, name: th.name, preview: 'placeholder' }));
    return { themes };
  }

  /**
   * Activate an installed theme via the SHARED {@link ThemesService} — flips `is_active` in
   * `installed_themes` (the single-active-per-tenant invariant, in one transaction). Accepts
   * any installed theme (`themeId` is the theme NAME); an unknown/uninstalled one surfaces as
   * the service's NotFoundException (404), so the choice can never point at a theme that does
   * not exist. No duplication of the admin activation logic.
   */
  async activateTheme(tenantId: string, themeId: string): Promise<void> {
    await this.themes.activate(tenantId, themeId);
  }

  // ─── modules (REAL — installs + enables the platform's BUILT-IN modules) ────────

  /**
   * List the platform's BUILT-IN ("bundled") modules ({@link BUNDLED_MODULES}) as catalog cards
   * for the setup wizard. Each card carries the module's OWN manifest metadata
   * (`displayName`/`permissions`/`slots`, read from the bundled `<id>.module.json`) + the
   * registry's operator-facing `description`, plus an `installed` flag computed from the default
   * tenant's `installed_modules` (so a setup re-run shows which built-ins are already in). No FS
   * write, no code execution — read-only.
   */
  async listModules(tenantId: string): Promise<{ modules: SetupModuleView[] }> {
    const installedNames = new Set((await this.modules.list(tenantId)).map((m) => m.name));
    const modules = BUNDLED_MODULES.map((entry) => {
      const manifest = readBundledManifest(entry.id);
      return {
        id: entry.id,
        name: entry.id,
        displayName: manifest?.displayName ?? entry.id,
        description: entry.description,
        permissions: manifest?.permissions ?? [],
        slots: manifest?.slots ?? [],
        installed: installedNames.has(entry.id),
      };
    });
    return { modules };
  }

  /**
   * Install + enable the selected BUILT-IN modules for the default tenant during setup.
   *
   * SECURITY: every requested id is validated against the {@link BUNDLED_MODULES} ALLOWLIST FIRST
   * — BEFORE any filesystem/ingest work — so an arbitrary or path-traversing name (`../evil`,
   * `/etc/passwd`) is rejected with a 400 and NO FS access (no arbitrary name → no arbitrary
   * package). Only the platform's own bundled `.tgz` are installable at setup; arbitrary tarball
   * upload is admin-only.
   *
   * For each allowlisted id, the install reuses the EXISTING hardened path: read the bundled
   * `.tgz`, hand it to {@link ModulesService.install} (which re-extracts via the GuardedTarExtractor
   * and re-verifies the manifest — install runs NO module code), granting the module's OWN declared
   * permissions (a trusted built-in; the service's default-deny intersection still applies), then
   * {@link ModuleRuntimeService.enable} forks the sandboxed worker.
   *
   * IDEMPOTENT: an already-installed module surfaces as a 409 from the service, which is treated as
   * a no-op SUCCESS (the install is still reported, and enable still runs unless already running).
   * Per-module FAULT ISOLATION: each module is wrapped so one failure (e.g. a corrupt artifact)
   * does not abort the rest. The result reports BOTH the ids that installed+enabled AND the ids that
   * FAILED (S1) — failures are NEVER silently reported as success, so the wizard can surface the
   * partial/total failure to the operator. `failed` carries only ids (no message/PII).
   */
  async installModules(
    tenantId: string,
    moduleIds: string[],
  ): Promise<{ installed: string[]; failed: string[] }> {
    // De-dupe while preserving order, then ALLOWLIST-validate the WHOLE batch up front — reject the
    // request (400) before any FS/ingest if ANY id is not a known built-in (covers `../evil`, an
    // unknown name, a separator-bearing name). No partial FS access on a rejected batch.
    const ids = [...new Set(moduleIds)];
    const unknown = ids.filter((id) => !isBundledModuleId(id));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `not a built-in module: ${unknown.join(', ')} — only the platform's bundled modules are ` +
          'installable during setup.',
      );
    }

    const installed: string[] = [];
    const failed: string[] = [];
    for (const id of ids) {
      try {
        await this.installAndEnableBundled(tenantId, id);
        installed.push(id);
      } catch (err) {
        // Per-module fault isolation: log + record the id as FAILED (S1) so the caller surfaces it —
        // never swallowed into a silent "success". Only the id is reported (no message → no PII).
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`setup: failed to install bundled module '${id}': ${message}`);
        failed.push(id);
      }
    }
    return { installed, failed };
  }

  /**
   * Install (if not already) + enable (if not already running) a single bundled module. The id is
   * assumed ALLOWLIST-validated by the caller; `bundledTgzPath` re-asserts it as defence in depth.
   * A 409 from install (already installed) is swallowed (idempotent) — enable still runs.
   */
  private async installAndEnableBundled(tenantId: string, id: string): Promise<void> {
    const entry = bundledModule(id);
    if (!entry) {
      // Unreachable after the caller's allowlist check, but fail closed rather than touch the FS.
      throw new BadRequestException(`not a built-in module: ${id}`);
    }
    // Grant the module's OWN declared permissions (read from its packed sidecar manifest). S2: for a
    // PLATFORM-shipped built-in, a MISSING/CORRUPT sidecar is a broken package — FAIL loudly rather
    // than install with an empty `[]` grant (which would silently produce a dead, permission-less
    // module). The service still intersects these with the re-verified manifest from the tarball
    // (default-deny), so an undeclared perm can never persist either way.
    const manifest = readBundledManifest(id);
    if (!manifest) {
      throw new Error(
        `bundled module '${id}' has no readable manifest sidecar — the package is missing or ` +
          'corrupt (run `pnpm pack:bundled-modules`).',
      );
    }
    const granted = manifest.permissions;

    // Read the bundled `.tgz` (path re-validated against the allowlist + bundled dir).
    const tarball = await fsp.readFile(bundledTgzPath(id));

    try {
      await this.modules.install(tenantId, tarball, granted);
    } catch (err) {
      // a re-install is a 409. At setup that is a no-op SUCCESS (idempotent) — swallow
      // and proceed to enable. Any OTHER error is a real failure and propagates to the per-module
      // isolation wrapper.
      if (!(err instanceof ConflictException)) throw err;
    }

    // Enable forks the sandboxed worker. Skip if it is already running (idempotent re-run).
    if (!this.runtime.isRunning(tenantId, id)) {
      await this.runtime.enable(tenantId, id);
    }
  }

  // ─── internal: non-tax settings read-merge-write ───────────────────────────────

  /**
   * Read-merge-write the tenant's `settings` JSONB for NON-tax keys (compliance / brand /
   * markers). Tax keys go through `TenantSettingsService` instead so its typed defaults
   * are never bypassed; these top-level keys are plain non-secret markers, so a shallow
   * merge is correct and keeps unrelated keys intact.
   */
  private async mergeSettings(tenantId: string, patch: Record<string, unknown>): Promise<void> {
    const [row] = await this.database.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const current = isRecord(row?.settings) ? (row!.settings as Record<string, unknown>) : {};
    const merged = { ...current, ...patch };
    await this.database.db
      .update(tenants)
      .set({ settings: merged, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));
    // Keep the TenantSettingsService cache honest if it has a stale copy of this tenant.
    this.settings.invalidate(tenantId);
  }
}

/** File extension per accepted logo MIME type. */
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
