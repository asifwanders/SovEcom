/**
 * InvoiceRepository.
 *
 * Tenant-scoped access to `invoices` + `invoice_counters`, mirroring OrderRepository
 * conventions (DatabaseService injection, every query filters `tenant_id`, mutating
 * methods take an explicit `tx`). The gapless-numbering primitives run inside the
 * issuing transaction so an allocated number that doesn't commit is never consumed.
 *
 * Reads the order + items directly (tenant-scoped) so InvoicesModule needs only the
 * EVENT from OrdersModule, never a back-import.
 */
import { Injectable } from '@nestjs/common';
import { and, eq, asc, isNull } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { invoices, type Invoice, type NewInvoice } from '../database/schema/invoices';
import { invoiceCounters } from '../database/schema/invoice_counters';
import { orders, type Order } from '../database/schema/orders';
import { orderItems, type OrderItem } from '../database/schema/order_items';
import { customers } from '../database/schema/customers';

/** The transaction handle drizzle passes to a `.transaction(async (tx) => …)` callback. */
type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

/** Either the base db handle or an open transaction. */
type Db = DatabaseService['db'] | Tx;

@Injectable()
export class InvoiceRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * The existing NON-credit-note invoice for an order, or null. The idempotency
   * pre-check (cheap, before we lock the counter); the partial unique index is the
   * race-proof backstop. Tenant-scoped.
   */
  async findInvoiceForOrder(db: Db, tenantId: string, orderId: string): Promise<Invoice | null> {
    const [row] = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenantId),
          eq(invoices.orderId, orderId),
          eq(invoices.type, 'invoice'),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Load one invoice by id, tenant-scoped. */
  async findById(tenantId: string, id: string): Promise<Invoice | null> {
    const [row] = await this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, id)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Allocate the next GAPLESS number for (tenant, series) under a row lock.
   *
   * `SELECT … FOR UPDATE` the counter row → serialises issuance per tenant+series. Create
   * it at 1 on first use. Read `next_value` as the number to hand out, then increment. ALL
   * inside the caller's `tx`: if the surrounding tx rolls back, the increment rolls back too,
   * so the number is NOT consumed → the next successful issuance reuses it (gapless). This is
   * NOT a bare Postgres sequence (which gaps on rollback).
   */
  async allocateGaplessNumber(tx: Tx, tenantId: string, series: string): Promise<bigint> {
    // Lock (or, on first use, create-then-lock) the counter row.
    const locked = await tx
      .select({ nextValue: invoiceCounters.nextValue })
      .from(invoiceCounters)
      .where(and(eq(invoiceCounters.tenantId, tenantId), eq(invoiceCounters.series, series)))
      .for('update')
      .limit(1);

    if (locked.length === 0) {
      // First invoice in this series. INSERT … ON CONFLICT DO NOTHING handles a concurrent
      // first-issuer that inserted between our SELECT and here; we then re-lock the row.
      await tx
        .insert(invoiceCounters)
        .values({ tenantId, series, nextValue: 1n })
        .onConflictDoNothing();
      const [created] = await tx
        .select({ nextValue: invoiceCounters.nextValue })
        .from(invoiceCounters)
        .where(and(eq(invoiceCounters.tenantId, tenantId), eq(invoiceCounters.series, series)))
        .for('update')
        .limit(1);
      const value = created!.nextValue;
      await tx
        .update(invoiceCounters)
        .set({ nextValue: value + 1n, updatedAt: new Date() })
        .where(and(eq(invoiceCounters.tenantId, tenantId), eq(invoiceCounters.series, series)));
      return value;
    }

    const value = locked[0]!.nextValue;
    await tx
      .update(invoiceCounters)
      .set({ nextValue: value + 1n, updatedAt: new Date() })
      .where(and(eq(invoiceCounters.tenantId, tenantId), eq(invoiceCounters.series, series)));
    return value;
  }

  /** Insert the invoice row (storage_key null) inside the caller's tx. Tenant-scoped. */
  async insertInvoice(tx: Tx, values: NewInvoice): Promise<Invoice> {
    const [row] = await tx.insert(invoices).values(values).returning();
    return row!;
  }

  /**
   * Attach the rendered-PDF storage pointer (the ONE mutation the immutability trigger
   * permits: storage_key NULL → value), post-commit. Tenant-scoped + guarded to only set
   * when currently null so a retry can't violate the trigger. Returns true if it set the key.
   */
  async attachStorageKey(tenantId: string, id: string, storageKey: string): Promise<boolean> {
    const updated = await this.db
      .update(invoices)
      .set({ storageKey })
      .where(
        and(
          eq(invoices.tenantId, tenantId),
          eq(invoices.id, id),
          // Only the storage_key NULL → value transition (what the trigger permits).
          isNull(invoices.storageKey),
        ),
      )
      .returning({ id: invoices.id });
    return updated.length > 0;
  }

  /**
   * Does this order belong to this customer in this tenant? The store-download IDOR guard:
   * another customer's order (or a guest order — null customer_id never matches) resolves
   * to false → the controller 404s, so an order id is not an existence oracle. Tenant-scoped.
   */
  async orderBelongsToCustomer(
    tenantId: string,
    orderId: string,
    customerId: string,
  ): Promise<boolean> {
    const [row] = await this.db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.id, orderId),
          eq(orders.customerId, customerId),
          isNull(orders.deletedAt),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  /**
   * Load the order header for an invoice, tenant-scoped. Excludes soft-deleted rows
   * (a soft-deleted order is never returned, mirroring `orderBelongsToCustomer`).
   */
  async loadOrder(db: Db, tenantId: string, orderId: string): Promise<Order | null> {
    const [row] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId), isNull(orders.deletedAt)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Read a customer's stored VIES consultation reference from their durable VAT proof
   * (`customers.metadata.vat.consultationRef`, written by CustomersService.evaluateVat).
   * Tenant-scoped; null when the customer doesn't exist, has no VAT proof, or the proof was
   * a cache hit (no per-consultation ref). Read directly here (not via CustomersModule) for
   * the same reason orders/items are.
   *
   * The ref is returned ONLY when the stored proof is currently `status === 'valid'` AND
   * the customer's CURRENT `vat_number` equals the number the ORDER snapshotted
   * (`orderVatNumber`). This prevents printing a consultation ref that belongs to a
   * DIFFERENT, since-re-validated VAT number on this order's invoice. A mismatch (the
   * customer changed/re-validated their VAT number after the order) → null (no ref printed,
   * never a wrong one). Case-insensitive, whitespace-trimmed comparison of the VAT numbers.
   */
  async loadCustomerViesRef(
    db: Db,
    tenantId: string,
    customerId: string,
    orderVatNumber: string | null,
  ): Promise<string | null> {
    const [row] = await db
      .select({ metadata: customers.metadata, vatNumber: customers.vatNumber })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)))
      .limit(1);
    if (!row) return null;

    const meta = row.metadata;
    if (typeof meta !== 'object' || meta === null) return null;
    const vat = (meta as Record<string, unknown>).vat;
    if (typeof vat !== 'object' || vat === null) return null;
    const vatRec = vat as Record<string, unknown>;

    // Only a currently-VALID proof may print a ref.
    if (vatRec.status !== 'valid') return null;

    // The proof must belong to the SAME VAT number the order snapshotted (not a later one).
    const norm = (v: string | null): string | null =>
      typeof v === 'string' ? v.replace(/\s+/g, '').toUpperCase() : null;
    const current = norm(row.vatNumber);
    const ordered = norm(orderVatNumber);
    if (current === null || ordered === null || current !== ordered) return null;

    const ref = vatRec.consultationRef;
    return typeof ref === 'string' ? ref : null;
  }

  /** Load the order's line items, tenant-scoped, in insertion order. */
  async loadOrderItems(db: Db, tenantId: string, orderId: string): Promise<OrderItem[]> {
    return db
      .select()
      .from(orderItems)
      .where(and(eq(orderItems.tenantId, tenantId), eq(orderItems.orderId, orderId)))
      .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
  }
}
