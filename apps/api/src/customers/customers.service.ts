/**
 * CustomersService (SECURITY-CRITICAL: PII, second auth, VAT/tax).
 *
 * Owns the customer row: signup (hash password, breached-check, optional VIES),
 * profile read/update (self + admin, VIES on vat change), admin list/get, and the
 * VAT-validation orchestration (durable metadata proof). Tenant scoping + the
 * allowlist serializers are enforced here and in the repository. Erase lives in
 * RgpdService (it spans addresses + sessions); this service exposes the read/CRUD.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PasswordService } from '../auth/services/password.service';
import { isBreachedPassword } from '../auth/services/breached-passwords';
import { AuditService } from '../audit/audit.service';
import { CustomersRepository } from './customers.repository';
import { ViesService } from './vies/vies.service';
import type { ViesCheckResult } from './vies/vies.client';
import { TenantSettingsService } from '../taxes/tenant-settings.service';
import {
  toAdminCustomerView,
  toStoreCustomerView,
  type AdminCustomerView,
  type StoreCustomerView,
} from './customer.serializer';
import type { Customer } from '../database/schema/customers';
import type { SignupDto } from './dto/signup.dto';
import type { UpdateCustomerDto } from './dto/update-customer.dto';
import type { AdminCreateCustomerDto } from './dto/admin-create-customer.dto';
import type { AdminUpdateCustomerDto } from './dto/admin-update-customer.dto';
import type { CustomerQueryDto } from './dto/customer-query.dto';

interface RequestContext {
  ip?: string;
  userAgent?: string;
}

/**
 * The durable VIES proof object persisted into `customers.metadata`.
 * A `consultationRef` is present ONLY for a LIVE 'valid' VIES response — a
 * cache hit persists `cached:true` and NO consultationRef (a cached result is not
 * per-consultation evidence and must never borrow another customer's reference).
 */
interface VatMetadata {
  status: 'valid' | 'invalid' | 'unreachable';
  consultationRef?: string;
  cached?: boolean;
  checkedAt: string;
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly repo: CustomersRepository,
    private readonly passwords: PasswordService,
    private readonly vies: ViesService,
    private readonly audit: AuditService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  // ── Store self-service ──────────────────────────────────────────────────────

  /**
   * Register a new customer. Hashes the password (argon2id), rejects breached
   * passwords, and — when a VAT number is supplied — runs VIES NON-BLOCKINGLY:
   * the outcome only sets `vat_validated` + the durable metadata proof; it never
   * fails signup. A duplicate active email is a 409 (partial unique index).
   */
  async signup(tenantId: string, dto: SignupDto, ctx: RequestContext): Promise<StoreCustomerView> {
    if (isBreachedPassword(dto.password)) {
      throw new BadRequestException('password is too common');
    }
    const existing = await this.repo.findActiveByEmail(tenantId, dto.email);
    if (existing) {
      throw new ConflictException('email already registered');
    }

    const passwordHash = await this.passwords.hash(dto.password);
    const vat = dto.vatNumber
      ? await this.evaluateVat(tenantId, dto.vatNumber)
      : { validated: false, metadata: undefined as VatMetadata | undefined };

    let row: Customer;
    try {
      row = await this.repo.insert({
        tenantId,
        email: dto.email,
        passwordHash,
        name: dto.name ?? null,
        phone: dto.phone ?? null,
        isB2b: dto.isB2b,
        vatNumber: dto.vatNumber ?? null,
        vatValidated: vat.validated,
        vatValidatedAt: vat.validated ? new Date() : null,
        acceptsMarketing: dto.acceptsMarketing,
        metadata: vat.metadata ? { vat: vat.metadata } : {},
      });
    } catch (err) {
      // Unique-violation race (two concurrent signups for the same email).
      if (CustomersService.isUniqueViolation(err)) {
        throw new ConflictException('email already registered');
      }
      throw err;
    }

    await this.audit.record({
      tenantId,
      actorType: 'customer',
      actorId: row.id,
      action: 'customer.created',
      resourceType: 'customer',
      resourceId: row.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      changes: { via: 'signup', vatStatus: vat.metadata?.status },
    });
    return toStoreCustomerView(row);
  }

  /** Read the authenticated customer's own profile (store /me). */
  async getOwnProfile(tenantId: string, customerId: string): Promise<StoreCustomerView> {
    const row = await this.repo.findActiveById(tenantId, customerId);
    if (!row) {
      throw new NotFoundException();
    }
    return toStoreCustomerView(row);
  }

  /** PATCH the authenticated customer's own profile (store /me). VIES on vat change. */
  async updateOwnProfile(
    tenantId: string,
    customerId: string,
    dto: UpdateCustomerDto,
    ctx: RequestContext,
  ): Promise<StoreCustomerView> {
    const current = await this.repo.findActiveById(tenantId, customerId);
    if (!current) {
      throw new NotFoundException();
    }
    const patch = await this.buildVatAwarePatch(current, {
      name: dto.name,
      phone: dto.phone,
      vatNumber: dto.vatNumber,
      acceptsMarketing: dto.acceptsMarketing,
    });
    const row = await this.repo.update(tenantId, customerId, patch);
    if (!row) {
      throw new NotFoundException();
    }
    await this.audit.record({
      tenantId,
      actorType: 'customer',
      actorId: customerId,
      action: 'customer.updated',
      resourceType: 'customer',
      resourceId: customerId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      changes: { via: 'self', fields: Object.keys(dto) },
    });
    return toStoreCustomerView(row);
  }

  // ── Admin CRUD ──────────────────────────────────────────────────────────────

  async adminList(
    tenantId: string,
    query: CustomerQueryDto,
  ): Promise<{ data: AdminCustomerView[]; total: number; page: number; pageSize: number }> {
    const result = await this.repo.list(tenantId, {
      page: query.page,
      pageSize: query.pageSize,
      email: query.email,
      isB2b: query.isB2b as boolean | undefined,
    });
    return {
      data: result.data.map(toAdminCustomerView),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  }

  async adminGet(tenantId: string, id: string): Promise<AdminCustomerView> {
    const row = await this.repo.findByIdForAdmin(tenantId, id);
    if (!row) {
      throw new NotFoundException();
    }
    return toAdminCustomerView(row);
  }

  async adminCreate(
    tenantId: string,
    actorId: string,
    dto: AdminCreateCustomerDto,
    ctx: RequestContext,
  ): Promise<AdminCustomerView> {
    if (dto.password && isBreachedPassword(dto.password)) {
      throw new BadRequestException('password is too common');
    }
    const existing = await this.repo.findActiveByEmail(tenantId, dto.email);
    if (existing) {
      throw new ConflictException('email already registered');
    }
    const passwordHash = dto.password ? await this.passwords.hash(dto.password) : null;
    const vat = dto.vatNumber
      ? await this.evaluateVat(tenantId, dto.vatNumber)
      : { validated: false, metadata: undefined as VatMetadata | undefined };

    let row: Customer;
    try {
      row = await this.repo.insert({
        tenantId,
        email: dto.email,
        passwordHash,
        name: dto.name ?? null,
        phone: dto.phone ?? null,
        isB2b: dto.isB2b,
        vatNumber: dto.vatNumber ?? null,
        vatValidated: vat.validated,
        vatValidatedAt: vat.validated ? new Date() : null,
        taxExempt: dto.taxExempt,
        acceptsMarketing: dto.acceptsMarketing,
        metadata: vat.metadata ? { vat: vat.metadata } : {},
      });
    } catch (err) {
      if (CustomersService.isUniqueViolation(err)) {
        throw new ConflictException('email already registered');
      }
      throw err;
    }

    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId,
      action: 'customer.created',
      resourceType: 'customer',
      resourceId: row.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      changes: { via: 'admin', vatStatus: vat.metadata?.status },
    });
    return toAdminCustomerView(row);
  }

  async adminUpdate(
    tenantId: string,
    actorId: string,
    id: string,
    dto: AdminUpdateCustomerDto,
    ctx: RequestContext,
  ): Promise<AdminCustomerView> {
    const current = await this.repo.findByIdForAdmin(tenantId, id);
    if (!current) {
      throw new NotFoundException();
    }
    const patch = await this.buildVatAwarePatch(current, {
      name: dto.name,
      phone: dto.phone,
      vatNumber: dto.vatNumber,
      isB2b: dto.isB2b,
      taxExempt: dto.taxExempt,
      acceptsMarketing: dto.acceptsMarketing,
    });
    const row = await this.repo.update(tenantId, id, patch);
    if (!row) {
      throw new NotFoundException();
    }
    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId,
      action: 'customer.updated',
      resourceType: 'customer',
      resourceId: id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      changes: { via: 'admin', fields: Object.keys(dto) },
    });
    return toAdminCustomerView(row);
  }

  // ── VAT / VIES ──────────────────────────────────────────────────────────────

  /**
   * Build an update patch that, when the VAT number CHANGES (incl. clearing it),
   * re-runs VIES and updates `vat_validated` + `vat_validated_at` + the durable
   * metadata proof. Tax fails SAFE: anything but a positive 'valid' leaves
   * `vat_validated=false`. A VIES outage NEVER throws (evaluateVat swallows it).
   */
  private async buildVatAwarePatch(
    current: Customer,
    fields: {
      name?: string | null;
      phone?: string | null;
      vatNumber?: string | null;
      isB2b?: boolean;
      taxExempt?: boolean;
      acceptsMarketing?: boolean;
    },
  ): Promise<Record<string, unknown>> {
    const patch: Record<string, unknown> = {};
    if (fields.name !== undefined) patch.name = fields.name;
    if (fields.phone !== undefined) patch.phone = fields.phone;
    if (fields.isB2b !== undefined) patch.isB2b = fields.isB2b;
    if (fields.taxExempt !== undefined) patch.taxExempt = fields.taxExempt;
    if (fields.acceptsMarketing !== undefined) patch.acceptsMarketing = fields.acceptsMarketing;

    if (fields.vatNumber !== undefined && fields.vatNumber !== current.vatNumber) {
      patch.vatNumber = fields.vatNumber;
      if (fields.vatNumber === null) {
        // VAT cleared — drop validation + proof.
        patch.vatValidated = false;
        patch.vatValidatedAt = null;
        patch.metadata = CustomersService.metadataWithVat(current.metadata, undefined);
      } else {
        const vat = await this.evaluateVat(current.tenantId, fields.vatNumber);
        patch.vatValidated = vat.validated;
        patch.vatValidatedAt = vat.validated ? new Date() : null;
        patch.metadata = CustomersService.metadataWithVat(current.metadata, vat.metadata);
      }
    }
    return patch;
  }

  /**
   * Run VIES for a VAT number. The VIES call itself never throws (the result is
   * swallowed to a tax-safe `unreachable`); the only throw source is the tenant
   * settings load, which hits the same DB the surrounding signup/update needs anyway.
   * Returns whether to flip `vat_validated` (only on a positive 'valid') and the
   * durable metadata proof to persist. unreachable/invalid → validated=false (tax-safe).
   *
   * Gated on the tenant's tax regime: VIES is an EU-VAT concept, so
   * it runs ONLY when `tax_mode='eu_vat'`. For any other regime (e.g. a Pakistan/US
   * store on `none`) we skip the EU SOAP call entirely and store the number as-is with
   * `vat_validated=false` and no proof — never mislabelling a non-EU tax ID as "invalid".
   */
  private async evaluateVat(
    tenantId: string,
    vatNumber: string,
  ): Promise<{ validated: boolean; metadata: VatMetadata | undefined }> {
    const settings = await this.tenantSettings.getTaxSettings(tenantId);
    if (settings.taxMode !== 'eu_vat') {
      return { validated: false, metadata: undefined };
    }

    let result: ViesCheckResult;
    try {
      result = await this.vies.validateVatNumber(vatNumber);
    } catch {
      // Defensive: ViesService already fails open, but never let signup throw.
      result = { status: 'unreachable' };
    }
    // F4: only a LIVE 'valid' carries a real consultationRef. A cached 'valid' is
    // flagged `cached:true` with NO consultationRef so the persisted proof never
    // borrows another customer's per-consultation evidence.
    const metadata: VatMetadata = {
      status: result.status,
      checkedAt: new Date().toISOString(),
    };
    if (result.status === 'valid') {
      if (result.cached) {
        metadata.cached = true;
      } else if (result.consultationRef) {
        metadata.consultationRef = result.consultationRef;
      }
    }
    return { validated: result.status === 'valid', metadata };
  }

  /** Merge a VAT proof under `metadata.vat`, preserving any other metadata keys. */
  private static metadataWithVat(
    existing: unknown,
    vat: VatMetadata | undefined,
  ): Record<string, unknown> {
    const base =
      existing && typeof existing === 'object' ? { ...(existing as Record<string, unknown>) } : {};
    if (vat === undefined) {
      delete base.vat;
    } else {
      base.vat = vat;
    }
    return base;
  }

  /** Detect a Postgres unique_violation (SQLSTATE 23505) on the email index. */
  private static isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === '23505'
    );
  }
}
