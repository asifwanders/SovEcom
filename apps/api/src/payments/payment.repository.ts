/**
 * PaymentRepository.
 *
 * Tenant-scoped access to `payments` (+ the `customers.stripe_customer_id` read/write the
 * payment flow needs — core-to-core access, allowed; modules are the restricted callers).
 * Mutations take an optional `tx` so the webhook handler can flip payment + order state in one
 * transaction. Idempotency rides the `UNIQUE(provider, provider_payment_id)` index.
 */
import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { payments, type Payment, type NewPayment } from '../database/schema/payments';
import { customers } from '../database/schema/customers';

type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];
type Db = DatabaseService['db'] | Tx;

@Injectable()
export class PaymentRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Upsert a payment row keyed by `(provider, provider_payment_id)` (the idempotency index).
   * A repeated PI request (same provider intent id) updates status/updatedAt instead of
   * inserting a duplicate. Returns the persisted row.
   */
  async upsertByProviderPaymentId(values: NewPayment, db: Db = this.db): Promise<Payment> {
    const [row] = await db
      .insert(payments)
      .values(values)
      .onConflictDoUpdate({
        target: [payments.provider, payments.providerPaymentId],
        // The unique index is PARTIAL (where provider_payment_id is not null) — the predicate
        // MUST be repeated here or Postgres finds no matching arbiter index for ON CONFLICT.
        targetWhere: sql`provider_payment_id is not null`,
        set: { status: values.status, amount: values.amount, updatedAt: new Date() },
      })
      .returning();
    return row!;
  }

  /**
   * Plain insert (no upsert) — used for MANUAL/offline payments, which have a NULL
   * `provider_payment_id` and so are not covered by the partial-unique idempotency index. Each
   * manual record is its own row. Returns the persisted row.
   */
  async insert(values: NewPayment, db: Db = this.db): Promise<Payment> {
    const [row] = await db.insert(payments).values(values).returning();
    return row!;
  }

  /**
   * Look up a payment by its provider intent id (globally unique per provider). The webhook
   * uses this to resolve our row from the inbound event. Returns the row incl. `tenant_id`.
   */
  async findByProviderPaymentId(
    provider: string,
    providerPaymentId: string,
    db: Db = this.db,
  ): Promise<Payment | null> {
    const [row] = await db
      .select()
      .from(payments)
      .where(
        and(eq(payments.provider, provider), eq(payments.providerPaymentId, providerPaymentId)),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Is there a `succeeded` payment for this order from a DIFFERENT provider intent than
   * `exceptProviderPaymentId`? A true means a SECOND collection landed on an order already paid by
   * another intent — a double charge needing manual refund. Tenant-scoped.
   */
  async hasSucceededPaymentExcept(
    tenantId: string,
    orderId: string,
    exceptProviderPaymentId: string,
    db: Db = this.db,
  ): Promise<boolean> {
    const [row] = await db
      .select({ one: sql<number>`1` })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.orderId, orderId),
          eq(payments.status, 'succeeded'),
          sql`${payments.providerPaymentId} is distinct from ${exceptProviderPaymentId}`,
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /**
   * The order's succeeded payment to refund against. Newest-first; in the normal
   * case there is exactly one (the capture, or a manual record). Tenant-scoped.
   */
  async findSucceededPaymentForOrder(
    tenantId: string,
    orderId: string,
    db: Db = this.db,
  ): Promise<Payment | null> {
    const [row] = await db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.orderId, orderId),
          eq(payments.status, 'succeeded'),
        ),
      )
      .orderBy(desc(payments.createdAt))
      .limit(1);
    return row ?? null;
  }

  /** Flip a payment's status, tenant-scoped. Used by the webhook handler. */
  async updateStatus(
    tenantId: string,
    id: string,
    status: Payment['status'],
    db: Db = this.db,
  ): Promise<void> {
    await db
      .update(payments)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(payments.id, id), eq(payments.tenantId, tenantId)));
  }

  // ── Stripe Customer reuse ─────────────────────────────────────────

  /** Read the fields needed to create/reuse a Stripe Customer for a logged-in customer. */
  async getCustomerForStripe(
    tenantId: string,
    customerId: string,
  ): Promise<{ email: string; name: string | null; stripeCustomerId: string | null } | null> {
    const [row] = await this.db
      .select({
        email: customers.email,
        name: customers.name,
        stripeCustomerId: customers.stripeCustomerId,
      })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.tenantId, tenantId)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Persist the Stripe Customer id, but ONLY where it is still NULL (first-writer-wins) so a
   * concurrent request can't clobber an already-stored id. The partial unique
   * `(tenant_id, stripe_customer_id)` index is the DB backstop against divergence.
   */
  async setStripeCustomerId(
    tenantId: string,
    customerId: string,
    stripeCustomerId: string,
  ): Promise<void> {
    await this.db
      .update(customers)
      .set({ stripeCustomerId, updatedAt: new Date() })
      .where(
        and(
          eq(customers.id, customerId),
          eq(customers.tenantId, tenantId),
          isNull(customers.stripeCustomerId),
        ),
      );
  }
}
