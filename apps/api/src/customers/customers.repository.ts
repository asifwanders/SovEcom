/**
 * CustomersRepository (SECURITY-CRITICAL: tenant scoping + erase tx).
 *
 * EVERY query is tenant-scoped on `(id, tenant_id)` — a customer can
 * never be read/written/erased across tenants. The RGPD erase is one transaction
 * that satisfies the `customers_anonymized_chk` CHECK and revokes every session.
 *
 * Soft-delete semantics: `findActive*` exclude rows with `deleted_at` /
 * `anonymized_at` set (they are erased and must be invisible to normal reads and
 * to login — only the partial unique index lets a fresh signup reuse the email).
 */
import { Injectable } from '@nestjs/common';
import { and, eq, isNull, sql, desc, ilike, count, inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DatabaseService } from '../database/database.service';
import { customers, type Customer, type NewCustomer } from '../database/schema/customers';
import { customerAddresses } from '../database/schema/customer_addresses';
import { refreshTokens } from '../database/schema/sessions';
import { auditLog } from '../database/schema/audit_log';
import { orders, type Order } from '../database/schema/orders';
import { orderItems, type OrderItem } from '../database/schema/order_items';
import { invoices, type Invoice } from '../database/schema/invoices';
import { emailLogs, type EmailLog } from '../database/schema/email_logs';
import { emailChangeTokens } from '../database/schema/email_change_tokens';
import { customerPasswordResetTokens } from '../database/schema/customer_password_reset_tokens';

export interface CustomerListFilters {
  page: number;
  pageSize: number;
  email?: string;
  isB2b?: boolean;
}

/**
 * The audit entry written INSIDE the erase transaction: an irreversible
 * erase must never commit unaudited, so the audit row is part of the same tx and
 * rolls back with it. (The append-only `audit_log` columns are populated directly
 * — `resource_id` is the customer UUID; secrets never enter `changes`.)
 */
export interface EraseAudit {
  actorType: 'customer' | 'user';
  actorId: string;
  ip?: string;
  userAgent?: string;
  via: 'self' | 'admin';
}

const USER_AGENT_MAX = 512;

export interface CustomerListResult {
  data: Customer[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class CustomersRepository {
  constructor(private readonly db: DatabaseService) {}

  /** Insert a new customer row (caller supplies the tenant-scoped values). */
  async insert(values: NewCustomer): Promise<Customer> {
    const rows = await this.db.db.insert(customers).values(values).returning();
    return rows[0]!;
  }

  /** Find an ACTIVE customer by id within a tenant (excludes erased rows). */
  async findActiveById(tenantId: string, id: string): Promise<Customer | null> {
    const [row] = await this.db.db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.id, id),
          eq(customers.tenantId, tenantId),
          isNull(customers.deletedAt),
          isNull(customers.anonymizedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Find an ACTIVE customer by email within a tenant (login lookup). Excludes
   * erased/anonymized rows so an erased customer can never log in (0025.2) and so
   * the lookup matches the partial active-email unique index.
   */
  async findActiveByEmail(tenantId: string, email: string): Promise<Customer | null> {
    const [row] = await this.db.db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.tenantId, tenantId),
          eq(customers.email, email),
          isNull(customers.deletedAt),
          isNull(customers.anonymizedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Admin: any customer by id within a tenant (admin may see erased? — no: still scoped). */
  async findByIdForAdmin(tenantId: string, id: string): Promise<Customer | null> {
    // Admin reads exclude erased rows too — an erased customer is gone for all reads.
    return this.findActiveById(tenantId, id);
  }

  /** Patch a customer's mutable fields, tenant-scoped. Returns the updated row. */
  async update(
    tenantId: string,
    id: string,
    patch: Partial<NewCustomer>,
  ): Promise<Customer | null> {
    const [row] = await this.db.db
      .update(customers)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(
        and(
          eq(customers.id, id),
          eq(customers.tenantId, tenantId),
          isNull(customers.deletedAt),
          isNull(customers.anonymizedAt),
        ),
      )
      .returning();
    return row ?? null;
  }

  /** Admin offset-paginated, tenant-scoped list with optional filters. */
  async list(tenantId: string, filters: CustomerListFilters): Promise<CustomerListResult> {
    const conds = [
      eq(customers.tenantId, tenantId),
      isNull(customers.deletedAt),
      isNull(customers.anonymizedAt),
    ];
    if (filters.email) {
      // F7: escape LIKE metacharacters so a filter like "a_b" / "50%" is matched
      // literally and cannot widen the search (a `_`/`%`/`\` in user input must
      // not act as a wildcard). `\` is the default LIKE escape character.
      const escaped = filters.email.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      conds.push(ilike(customers.email, `%${escaped}%`));
    }
    if (filters.isB2b !== undefined) {
      conds.push(eq(customers.isB2b, filters.isB2b));
    }
    const where = and(...conds);

    const [totalRow] = await this.db.db.select({ value: count() }).from(customers).where(where);
    const total = Number(totalRow?.value ?? 0);

    const data = await this.db.db
      .select()
      .from(customers)
      .where(where)
      .orderBy(desc(customers.createdAt))
      .limit(filters.pageSize)
      .offset((filters.page - 1) * filters.pageSize);

    return { data, total, page: filters.page, pageSize: filters.pageSize };
  }

  /**
   * RGPD ERASE (pseudonymization) — ONE transaction:
   *   - anonymized_at = now, deleted_at = now
   *   - email = 'anonymized-{uuidv7}@deleted.local', name = NULL, phone = NULL
   *     (this EXACT shape satisfies `customers_anonymized_chk`)
   *   - password_hash = NULL, totp_secret = NULL, totp_enabled = false
   *   - vat_number = NULL, vat_validated = false, vat_validated_at = NULL, and the
   *     `vat` proof/status key stripped from metadata: the pseudonymized stub must
   *     carry NO re-identifiable VAT. (Per-transaction VIES proof for 0%-VAT sales
   *     lives on the ORDER record, not here.)
   *   - DELETE every customer_addresses row
   *   - revoke (revoked_at = now) EVERY non-revoked refresh token for the customer
   *   - WRITE the `customer.erased` audit row IN THE SAME TX so an irreversible erase
   *     can never commit unaudited.
   *
   * Idempotency: the active-only SELECT … FOR UPDATE means a second erase finds no
   * active row → returns false → caller maps to 404/409 (already anonymized).
   *
   * The erase also scrubs the `orders` address SNAPSHOTS (name + address PII, keeping
   * country) + the order `email`, and the `email_logs.recipient` for this person, all
   * in THIS transaction. The immutable INVOICE snapshot is deliberately RETAINED under
   * the fiscal legal-obligation basis (GDPR Art. 17(3)(b)). NOTE: guest orders (no
   * `customer_id`) are scrubbed only via the `email_logs` recipient match, not the
   * order snapshot — a guest checkout is not linked to the erasable account.
   *
   * Returns true when a row was erased; false when none was active (idempotent).
   */
  async erase(tenantId: string, id: string, auditEntry: EraseAudit): Promise<boolean> {
    return this.db.db.transaction(async (tx) => {
      // Lock the ACTIVE customer + capture the pre-erase email (needed to scrub email_logs by
      // recipient). A concurrent/second erase blocks here, then sees no active row → false.
      const [existing] = await tx
        .select({ email: customers.email })
        .from(customers)
        .where(
          and(
            eq(customers.id, id),
            eq(customers.tenantId, tenantId),
            isNull(customers.anonymizedAt),
          ),
        )
        .for('update')
        .limit(1);
      if (!existing) {
        // Already anonymized (or wrong tenant) — nothing to do (idempotent).
        return false;
      }
      const oldEmail = existing.email;
      const anonymizedEmail = `anonymized-${uuidv7()}@deleted.local`;

      await tx
        .update(customers)
        .set({
          anonymizedAt: sql`now()`,
          deletedAt: sql`now()`,
          email: anonymizedEmail,
          name: null,
          phone: null,
          passwordHash: null,
          totpSecret: null,
          totpEnabled: false,
          // Scrub all VAT identity from the pseudonymized stub.
          vatNumber: null,
          vatValidated: false,
          vatValidatedAt: null,
          // Strip the `vat` proof/status key, preserving any other metadata keys.
          metadata: sql`coalesce(${customers.metadata}, '{}'::jsonb) - 'vat'`,
          // Clear any in-flight email-change mirror so the scrubbed stub never leaks
          // the pending target (the tokens are consumed just below).
          pendingEmail: null,
          updatedAt: sql`now()`,
        })
        .where(and(eq(customers.id, id), eq(customers.tenantId, tenantId)));

      // Delete all addresses (PII). CASCADE would also fire on a hard delete, but
      // this is a soft-delete row that survives, so we remove children explicitly.
      await tx
        .delete(customerAddresses)
        .where(and(eq(customerAddresses.customerId, id), eq(customerAddresses.tenantId, tenantId)));

      // Scrub the order address SNAPSHOTS (name + full address PII) for this customer's
      // orders, keeping ONLY the country (not personally identifying; useful for
      // fiscal/analytics). The order row itself survives (commercial/legal record) and its
      // `email` is anonymized. The IMMUTABLE invoice snapshot is intentionally retained
      // under the fiscal legal-obligation basis (GDPR Art. 17(3)(b)).
      await tx
        .update(orders)
        .set({
          email: anonymizedEmail,
          shippingAddress: sql`jsonb_build_object('country', coalesce(${orders.shippingAddress} -> 'country', 'null'::jsonb), 'erased', to_jsonb(true))`,
          billingAddress: sql`jsonb_build_object('country', coalesce(${orders.billingAddress} -> 'country', 'null'::jsonb), 'erased', to_jsonb(true))`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(orders.customerId, id), eq(orders.tenantId, tenantId)));

      // Scrub the recipient on every transactional email logged to this person's
      // address (order confirmations, etc.). Keyed on the captured pre-erase email.
      await tx
        .update(emailLogs)
        .set({ recipient: anonymizedEmail, updatedAt: sql`now()` })
        // Case-INSENSITIVE match: never silently miss a row whose recipient was stored
        // with different casing — this is irreversible erasure.
        .where(
          and(
            eq(emailLogs.tenantId, tenantId),
            sql`lower(${emailLogs.recipient}) = lower(${oldEmail})`,
          ),
        );

      // Revoke every still-active session so the customer cannot keep using a
      // pre-erase access/refresh token.
      await tx
        .update(refreshTokens)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(refreshTokens.customerId, id),
            eq(refreshTokens.tenantId, tenantId),
            isNull(refreshTokens.revokedAt),
          ),
        );

      // HARD-DELETE every email-change token row for the customer — consumed rows
      // included. Each row's `pending_email` carries a THIRD-PARTY address (the target
      // the customer was switching to), which is PII the erase must PURGE, not merely
      // flag as consumed. Deleting all rows also kills any in-flight verify link (no
      // swap can confirm on the erased stub).
      await tx
        .delete(emailChangeTokens)
        .where(and(eq(emailChangeTokens.customerId, id), eq(emailChangeTokens.tenantId, tenantId)));

      // HARD-DELETE the customer's password-reset tokens too. These carry no
      // third-party PII (only the customer's own single-use hash), so this is NOT
      // strictly required for RGPD — but it kills any in-flight reset link on the
      // erased stub (no reset can land on a deleted account) and keeps the steady-state
      // sweeper's job smaller. Trivial + same-tx, so we do it here alongside the token purge.
      await tx
        .delete(customerPasswordResetTokens)
        .where(
          and(
            eq(customerPasswordResetTokens.customerId, id),
            eq(customerPasswordResetTokens.tenantId, tenantId),
          ),
        );

      // Audit the erasure inside the SAME transaction — if this insert fails,
      // the whole erase rolls back. An irreversible erase cannot commit unaudited.
      await tx.insert(auditLog).values({
        tenantId,
        actorType: auditEntry.actorType,
        actorId: auditEntry.actorId,
        action: 'customer.erased',
        resourceType: 'customer',
        resourceId: id,
        changes: { via: auditEntry.via },
        ipAddress: auditEntry.ip ?? null,
        userAgent: auditEntry.userAgent ? auditEntry.userAgent.slice(0, USER_AGENT_MAX) : null,
      });

      return true;
    });
  }

  // ── RGPD EXPORT reads (Art. 15/20 — R1) ───────────────────────────────────────
  // These enumerate the SAME personal data the erase tx scrubs, so the disclosure
  // (export) and the erasure stay in lock-step. Every query is tenant + customer
  // scoped; the serializers (rgpd.service) allowlist the fields that leave.

  /**
   * The customer's own orders (newest first) WITH their line items, tenant-scoped.
   * Excludes soft-deleted orders. Returns the raw rows — the RGPD serializer picks
   * the customer-facing, non-internal columns. Guest orders (null customer_id) are
   * not the erasable account's data and are excluded by the `customer_id` filter.
   */
  async listOrdersForExport(
    tenantId: string,
    customerId: string,
  ): Promise<{ order: Order; items: OrderItem[] }[]> {
    const orderRows = await this.db.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.customerId, customerId),
          isNull(orders.deletedAt),
        ),
      )
      .orderBy(desc(orders.createdAt), desc(orders.id));
    if (orderRows.length === 0) return [];

    const itemRows = await this.db.db
      .select()
      .from(orderItems)
      .where(
        and(
          eq(orderItems.tenantId, tenantId),
          inArray(
            orderItems.orderId,
            orderRows.map((o) => o.id),
          ),
        ),
      )
      .orderBy(orderItems.createdAt, orderItems.id);

    const byOrder = new Map<string, OrderItem[]>();
    for (const it of itemRows) {
      const list = byOrder.get(it.orderId) ?? [];
      list.push(it);
      byOrder.set(it.orderId, list);
    }
    return orderRows.map((order) => ({ order, items: byOrder.get(order.id) ?? [] }));
  }

  /**
   * Invoices for the customer's orders (newest first), tenant-scoped. Joined via the
   * customer's own non-deleted orders so no other customer's invoice can appear.
   */
  async listInvoicesForExport(tenantId: string, customerId: string): Promise<Invoice[]> {
    return this.db.db
      .select({
        id: invoices.id,
        tenantId: invoices.tenantId,
        orderId: invoices.orderId,
        type: invoices.type,
        series: invoices.series,
        invoiceNumber: invoices.invoiceNumber,
        issuedAt: invoices.issuedAt,
        sellerSnapshot: invoices.sellerSnapshot,
        buyerSnapshot: invoices.buyerSnapshot,
        currency: invoices.currency,
        subtotalAmount: invoices.subtotalAmount,
        taxBreakdown: invoices.taxBreakdown,
        taxAmount: invoices.taxAmount,
        totalAmount: invoices.totalAmount,
        reverseCharge: invoices.reverseCharge,
        viesConsultationRef: invoices.viesConsultationRef,
        correctsInvoiceId: invoices.correctsInvoiceId,
        storageKey: invoices.storageKey,
        createdAt: invoices.createdAt,
      })
      .from(invoices)
      .innerJoin(
        orders,
        and(eq(invoices.orderId, orders.id), eq(invoices.tenantId, orders.tenantId)),
      )
      .where(
        and(
          eq(invoices.tenantId, tenantId),
          eq(orders.customerId, customerId),
          isNull(orders.deletedAt),
        ),
      )
      .orderBy(desc(invoices.issuedAt), desc(invoices.id));
  }

  /**
   * Transactional email logs sent to this person, keyed (case-insensitively) on the
   * caller's CURRENT email — the same match the erase tx uses to scrub recipients.
   * Tenant-scoped. Returns raw rows; the serializer exposes metadata only.
   */
  async listEmailLogsForExport(tenantId: string, email: string): Promise<EmailLog[]> {
    return this.db.db
      .select()
      .from(emailLogs)
      .where(
        and(eq(emailLogs.tenantId, tenantId), sql`lower(${emailLogs.recipient}) = lower(${email})`),
      )
      .orderBy(desc(emailLogs.createdAt), desc(emailLogs.id));
  }
}
