/**
 * RgpdService (SECURITY-CRITICAL).
 *
 * RGPD self-service + admin: EXPORT (Art. 15/20) and ERASE (Art. 17). These are
 * SEPARATE operations — erase must NEVER auto-dump PII as a side effect (no stray
 * PII artifact). It is PSEUDONYMIZATION, not deletion: a scrubbed stub row is
 * retained for the future-orders legal-retention exception.
 *
 *   - export (POST): step-up password re-entry, then returns the customer's own
 *     profile + addresses + orders (with line items + address snapshots) + invoice
 *     metadata + email-log metadata as JSON (caller-scoped). Art. 15/20 — discloses
 *     ALL personal data held, by allowlist serializers.
 *   - erase (POST self / DELETE admin): step-up (self) or confirm-email echo (admin);
 *     one tx — anonymize the row (satisfying `customers_anonymized_chk`), scrub VAT,
 *     delete addresses, revoke every session, AND write the audit row in the SAME tx.
 *     Irreversible. After erase the customer can no longer log in.
 *
 * Step-up: BOTH self-service export and erase require the customer's CURRENT password
 * in the body, verified with argon2id (PasswordService). Wrong password → 401, nothing
 * happens. Timing-safe (dummyVerify on the no-match path) and rate-limited (fail-closed)
 * so neither endpoint becomes a password oracle.
 *
 * Admin erase requires `{ confirmEmail }` exactly matching the target's CURRENT email;
 * a mismatch/missing value → 400, no erase.
 */
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { CustomersRepository } from '../customers.repository';
import { AddressesRepository } from '../addresses/addresses.repository';
import { AuditService } from '../../audit/audit.service';
import { PasswordService } from '../../auth/services/password.service';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { toAddressView, type AddressView } from '../customer.serializer';

interface RequestContext {
  ip?: string;
  userAgent?: string;
}

/** Step-up rate-limit budget (per ip+customer) for the two sensitive endpoints. */
const STEPUP_LIMIT = 5;
const STEPUP_WINDOW_SECONDS = 60;

/**
 * One order line in the export — the customer-facing snapshot fields only (no
 * internal ids beyond the line id, no system columns). Money is integer minor units.
 */
export interface RgpdOrderItemView {
  productTitle: string;
  variantTitle: string | null;
  sku: string;
  quantity: number;
  unitPriceAmount: number;
  taxRate: string;
  taxAmount: number;
  lineTotalAmount: number;
}

/**
 * One order in the export. Discloses the personal data the erase path scrubs: the
 * order `email` + the shipping/billing address SNAPSHOTS (Art. 15). Money is integer
 * minor units + a 3-letter `currency`. Internal columns (guest token hash, raw
 * metadata, cart id, VIES ref) are NOT included.
 */
export interface RgpdOrderView {
  orderNumber: string;
  status: string;
  currency: string;
  email: string;
  subtotalAmount: number;
  discountAmount: number;
  shippingAmount: number;
  taxAmount: number;
  totalAmount: number;
  refundedAmount: number;
  shippingAddress: unknown;
  billingAddress: unknown;
  placedAt: string | null;
  createdAt: string;
  items: RgpdOrderItemView[];
}

/** Invoice METADATA in the export — fiscal-document facts, no seller/buyer snapshot blobs. */
export interface RgpdInvoiceView {
  type: string;
  series: string;
  invoiceNumber: string;
  currency: string;
  totalAmount: number;
  taxAmount: number;
  reverseCharge: boolean;
  issuedAt: string;
}

/** Email-log METADATA in the export — recipient + type + outcome + timestamps, no body. */
export interface RgpdEmailLogView {
  recipient: string;
  type: string;
  subject: string;
  status: string;
  sentAt: string | null;
  createdAt: string;
}

/** The RGPD data export envelope (Art. 15/20) — the caller's own data only. */
export interface RgpdExport {
  exportedAt: string;
  profile: {
    id: string;
    email: string;
    name: string | null;
    phone: string | null;
    isB2b: boolean;
    vatNumber: string | null;
    vatValidated: boolean;
    acceptsMarketing: boolean;
    createdAt: string;
  };
  addresses: AddressView[];
  // R1 (Art. 15/20): the export discloses ALL personal data held — the same data the
  // erase path scrubs (order email + address snapshots, invoices, email-log recipients),
  // built by ALLOWLIST serializers (no internal/system columns, no other customer's data).
  orders: RgpdOrderView[];
  invoices: RgpdInvoiceView[];
  emailLogs: RgpdEmailLogView[];
}

function toRgpdOrderView(row: {
  order: ExportableOrder;
  items: ExportableOrderItem[];
}): RgpdOrderView {
  const o = row.order;
  return {
    orderNumber: o.orderNumber,
    status: o.status,
    currency: o.currency,
    email: o.email,
    subtotalAmount: o.subtotalAmount,
    discountAmount: o.discountAmount,
    shippingAmount: o.shippingAmount,
    taxAmount: o.taxAmount,
    totalAmount: o.totalAmount,
    refundedAmount: o.refundedAmount,
    shippingAddress: o.shippingAddress,
    billingAddress: o.billingAddress,
    placedAt: o.placedAt ? o.placedAt.toISOString() : null,
    createdAt: o.createdAt.toISOString(),
    items: row.items.map((i) => ({
      productTitle: i.productTitle,
      variantTitle: i.variantTitle,
      sku: i.sku,
      quantity: i.quantity,
      unitPriceAmount: i.unitPriceAmount,
      taxRate: i.taxRate,
      taxAmount: i.taxAmount,
      lineTotalAmount: i.lineTotalAmount,
    })),
  };
}

function toRgpdInvoiceView(i: ExportableInvoice): RgpdInvoiceView {
  return {
    type: i.type,
    series: i.series,
    invoiceNumber: i.invoiceNumber,
    currency: i.currency,
    totalAmount: i.totalAmount,
    taxAmount: i.taxAmount,
    reverseCharge: i.reverseCharge,
    issuedAt: i.issuedAt.toISOString(),
  };
}

function toRgpdEmailLogView(e: ExportableEmailLog): RgpdEmailLogView {
  return {
    recipient: e.recipient,
    type: e.type,
    subject: e.subject,
    status: e.status,
    sentAt: e.sentAt ? e.sentAt.toISOString() : null,
    createdAt: e.createdAt.toISOString(),
  };
}

/** Minimal structural shapes the serializers read — keep them decoupled from the row types. */
interface ExportableOrder {
  orderNumber: string;
  status: string;
  currency: string;
  email: string;
  subtotalAmount: number;
  discountAmount: number;
  shippingAmount: number;
  taxAmount: number;
  totalAmount: number;
  refundedAmount: number;
  shippingAddress: unknown;
  billingAddress: unknown;
  placedAt: Date | null;
  createdAt: Date;
}
interface ExportableOrderItem {
  productTitle: string;
  variantTitle: string | null;
  sku: string;
  quantity: number;
  unitPriceAmount: number;
  taxRate: string;
  taxAmount: number;
  lineTotalAmount: number;
}
interface ExportableInvoice {
  type: string;
  series: string;
  invoiceNumber: string;
  currency: string;
  totalAmount: number;
  taxAmount: number;
  reverseCharge: boolean;
  issuedAt: Date;
}
interface ExportableEmailLog {
  recipient: string;
  type: string;
  subject: string;
  status: string;
  sentAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class RgpdService {
  constructor(
    private readonly customers: CustomersRepository,
    private readonly addresses: AddressesRepository,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /**
   * Export the authenticated customer's own data (profile + addresses + orders +
   * invoices + email logs — Art. 15/20) AFTER a step-up password check (ruling A).
   * Strictly caller-scoped — no other customer's data, NO password_hash /
   * totp_secret / raw metadata / guest token / storage-key internals (allowlisted).
   */
  async exportOwnData(
    tenantId: string,
    customerId: string,
    password: string,
    ctx: RequestContext,
  ): Promise<RgpdExport> {
    const customer = await this.requireStepUp(tenantId, customerId, password, ctx, 'export');

    // R1 (Art. 15/20): disclose ALL personal data held — gathered from the SAME
    // repositories the erase path enumerates. Strictly tenant + customer scoped; the
    // email-log lookup is keyed on the caller's own CURRENT email.
    const [addressRows, orderRows, invoiceRows, emailLogRows] = await Promise.all([
      this.addresses.listForCustomer(tenantId, customerId),
      this.customers.listOrdersForExport(tenantId, customerId),
      this.customers.listInvoicesForExport(tenantId, customerId),
      this.customers.listEmailLogsForExport(tenantId, customer.email),
    ]);
    await this.audit.record({
      tenantId,
      actorType: 'customer',
      actorId: customerId,
      action: 'customer.data_exported',
      resourceType: 'customer',
      resourceId: customerId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return {
      exportedAt: new Date().toISOString(),
      profile: {
        id: customer.id,
        email: customer.email,
        name: customer.name,
        phone: customer.phone,
        isB2b: customer.isB2b,
        vatNumber: customer.vatNumber,
        vatValidated: customer.vatValidated,
        acceptsMarketing: customer.acceptsMarketing,
        createdAt: customer.createdAt.toISOString(),
      },
      addresses: addressRows.map(toAddressView),
      orders: orderRows.map(toRgpdOrderView),
      invoices: invoiceRows.map(toRgpdInvoiceView),
      emailLogs: emailLogRows.map(toRgpdEmailLogView),
    };
  }

  /**
   * Self-service erase (Art. 17) AFTER a step-up password check (ruling A). The
   * audit row is written inside the erase transaction (F8). Idempotent at the data
   * layer; a no-op (already anonymized) is a 404.
   */
  async eraseSelf(
    tenantId: string,
    customerId: string,
    password: string,
    ctx: RequestContext,
  ): Promise<void> {
    await this.requireStepUp(tenantId, customerId, password, ctx, 'erase');

    const erased = await this.customers.erase(tenantId, customerId, {
      actorType: 'customer',
      actorId: customerId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      via: 'self',
    });
    if (!erased) {
      // Already anonymized (cannot normally happen for a live guard'd caller).
      throw new NotFoundException();
    }
  }

  /**
   * Admin erase (DELETE /admin/v1/customers/:id). Requires `confirmEmail` to match
   * the target's CURRENT email (ruling B) — a mismatch/missing value → 400, no
   * erase. Same pseudonymization tx, actor = admin, audit written in-tx (F8). An
   * already-anonymized / unknown id is a 404 (its email won't match → 400/404).
   */
  async eraseAsAdmin(
    tenantId: string,
    actorId: string,
    customerId: string,
    confirmEmail: string,
    ctx: RequestContext,
  ): Promise<void> {
    const target = await this.customers.findByIdForAdmin(tenantId, customerId);
    if (!target) {
      // Unknown / already-anonymized in this tenant.
      throw new NotFoundException();
    }
    // Confirmation echo must match the CURRENT email exactly (server-side).
    if (typeof confirmEmail !== 'string' || confirmEmail !== target.email) {
      throw new BadRequestException('confirmEmail does not match the customer email');
    }

    const erased = await this.customers.erase(tenantId, customerId, {
      actorType: 'user',
      actorId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      via: 'admin',
    });
    if (!erased) {
      // Race: the row was anonymized between the read and the erase.
      throw new NotFoundException();
    }
  }

  /**
   * Step-up gate shared by self export + erase (ruling A): rate-limit (fail-closed)
   * → load the active customer → verify the current password (argon2id). On a
   * missing customer, a customer with no password, or a wrong password, do equal
   * Argon2 work (dummyVerify) and throw a uniform 401 — never a password oracle.
   * Returns the loaded customer row on success.
   */
  private async requireStepUp(
    tenantId: string,
    customerId: string,
    password: string,
    ctx: RequestContext,
    action: 'export' | 'erase',
  ) {
    // (1) Rate-limit per ip+customer — fails CLOSED (RateLimitService blocks on a
    //     Redis error). Bounds brute-forcing the password through these endpoints.
    const throttle = await this.rateLimit.check(
      `rgpd-stepup:${action}:${ctx.ip ?? 'unknown'}:${customerId}`,
      { limit: STEPUP_LIMIT, windowSeconds: STEPUP_WINDOW_SECONDS },
    );
    if (!throttle.allowed) {
      await this.passwords.dummyVerify(password);
      throw new UnauthorizedException();
    }

    // (2) Load the active customer.
    const customer = await this.customers.findActiveById(tenantId, customerId);

    // (3) Missing / passwordless customer: equal Argon2 work, uniform 401.
    if (!customer || !customer.passwordHash) {
      await this.passwords.dummyVerify(password);
      throw new UnauthorizedException();
    }

    // (4) Verify the current password (constant-time).
    const ok = await this.passwords.verify(customer.passwordHash, password);
    if (!ok) {
      throw new UnauthorizedException();
    }
    return customer;
  }
}
