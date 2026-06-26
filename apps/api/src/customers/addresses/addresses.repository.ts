/**
 * AddressesRepository (tenant- AND customer-scoped).
 *
 * EVERY query filters BOTH `tenant_id` and `customer_id` (.6 — no IDOR
 * an address row is reachable only through its owning customer within its tenant).
 * `is_default` is unique-per-(customer, type) at the application level: setting a
 * new default clears the previous one in the same transaction.
 */
import { Injectable } from '@nestjs/common';
import { and, eq, sql, asc } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import {
  customerAddresses,
  type CustomerAddress,
  type NewCustomerAddress,
} from '../../database/schema/customer_addresses';

@Injectable()
export class AddressesRepository {
  constructor(private readonly db: DatabaseService) {}

  /** List a customer's addresses, scoped to (tenant, customer). */
  async listForCustomer(tenantId: string, customerId: string): Promise<CustomerAddress[]> {
    return this.db.db
      .select()
      .from(customerAddresses)
      .where(
        and(eq(customerAddresses.tenantId, tenantId), eq(customerAddresses.customerId, customerId)),
      )
      .orderBy(asc(customerAddresses.createdAt));
  }

  /** Find one address scoped to (tenant, customer, id) — null if not owned. */
  async findOwned(
    tenantId: string,
    customerId: string,
    id: string,
  ): Promise<CustomerAddress | null> {
    const [row] = await this.db.db
      .select()
      .from(customerAddresses)
      .where(
        and(
          eq(customerAddresses.id, id),
          eq(customerAddresses.tenantId, tenantId),
          eq(customerAddresses.customerId, customerId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Insert an address. When `isDefault`, clear any existing default of the SAME
   * type for this customer first (one default per type), all in one transaction.
   */
  async insert(values: NewCustomerAddress): Promise<CustomerAddress> {
    return this.db.db.transaction(async (tx) => {
      if (values.isDefault) {
        await tx
          .update(customerAddresses)
          .set({ isDefault: false, updatedAt: sql`now()` })
          .where(
            and(
              eq(customerAddresses.tenantId, values.tenantId),
              eq(customerAddresses.customerId, values.customerId),
              eq(customerAddresses.type, values.type),
              eq(customerAddresses.isDefault, true),
            ),
          );
      }
      const rows = await tx.insert(customerAddresses).values(values).returning();
      return rows[0]!;
    });
  }

  /**
   * Patch an owned address. Re-clears the previous default of the resulting type
   * when this update sets `isDefault=true`. Returns null when not owned.
   */
  async update(
    tenantId: string,
    customerId: string,
    id: string,
    patch: Partial<NewCustomerAddress>,
  ): Promise<CustomerAddress | null> {
    return this.db.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(customerAddresses)
        .where(
          and(
            eq(customerAddresses.id, id),
            eq(customerAddresses.tenantId, tenantId),
            eq(customerAddresses.customerId, customerId),
          ),
        )
        .limit(1);
      if (!existing) {
        return null;
      }

      if (patch.isDefault === true) {
        const type = patch.type ?? existing.type;
        await tx
          .update(customerAddresses)
          .set({ isDefault: false, updatedAt: sql`now()` })
          .where(
            and(
              eq(customerAddresses.tenantId, tenantId),
              eq(customerAddresses.customerId, customerId),
              eq(customerAddresses.type, type),
              eq(customerAddresses.isDefault, true),
            ),
          );
      }

      const [row] = await tx
        .update(customerAddresses)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(
          and(
            eq(customerAddresses.id, id),
            eq(customerAddresses.tenantId, tenantId),
            eq(customerAddresses.customerId, customerId),
          ),
        )
        .returning();
      return row ?? null;
    });
  }

  /** Delete an owned address. Returns true when a row was removed. */
  async delete(tenantId: string, customerId: string, id: string): Promise<boolean> {
    const deleted = await this.db.db
      .delete(customerAddresses)
      .where(
        and(
          eq(customerAddresses.id, id),
          eq(customerAddresses.tenantId, tenantId),
          eq(customerAddresses.customerId, customerId),
        ),
      )
      .returning({ id: customerAddresses.id });
    return deleted.length > 0;
  }
}
