/**
 * Follow-up B3 — the DB-backed {@link CustomerEmailLookup} for `sdk.email.sendToCustomer`.
 *
 * THE single place a customer's email is read for module→customer mail. It resolves the recipient by
 * the COMPOSITE `(tenantId, customerId)` — the tenant is supplied by the broker context (never the
 * module), so a `customerId` from another tenant resolves to nothing (→ `missing` → suppressed), and
 * there is no cross-tenant read. It returns a discriminated {@link CustomerEmailResolution}: the
 * email is present ONLY on the sendable `ok` branch; every suppressed branch carries a PII-free
 * reason and NO address, so a suppressed send cannot leak an email into an audit row or back to the
 * worker.
 *
 * SUPPRESSION (RGPD-aware): the price-drop digest this powers is PROMOTIONAL, so a send requires
 * marketing CONSENT and respects erasure. We suppress when the row is missing, soft-deleted
 * (`deleted_at`), anonymized (`anonymized_at`), or `accepts_marketing = false`. A single
 * parameterized SELECT of only the columns the decision needs (no PII beyond the email it may
 * return) — never `select *`.
 */
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { DatabaseService } from '../../database/database.service';
import { customers } from '../../database/schema/customers';
import type {
  CustomerEmailLookup,
  CustomerEmailResolution,
} from './module-mail.port';

@Injectable()
export class CustomerEmailLookupAdapter implements CustomerEmailLookup {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async resolveForModuleEmail(
    tenantId: string,
    customerId: string,
  ): Promise<CustomerEmailResolution> {
    // Composite (tenant, id) lookup. Tenant is from the broker context — a foreign-tenant id matches
    // no row here, so it returns `missing` (no cross-tenant disclosure, not even existence).
    const [row] = await this.db
      .select({
        email: customers.email,
        locale: customers.locale,
        acceptsMarketing: customers.acceptsMarketing,
        deletedAt: customers.deletedAt,
        anonymizedAt: customers.anonymizedAt,
      })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)))
      .limit(1);

    if (!row) return { status: 'suppressed', reason: 'missing' };
    // Erasure first (a deleted/anonymized row must never be emailed regardless of the consent flag).
    if (row.deletedAt !== null) return { status: 'suppressed', reason: 'deleted' };
    if (row.anonymizedAt !== null) return { status: 'suppressed', reason: 'anonymized' };
    // Promotional consent gate (RGPD): no marketing consent → suppress.
    if (row.acceptsMarketing !== true) return { status: 'suppressed', reason: 'not_consented' };

    return { status: 'ok', email: row.email, locale: row.locale };
  }
}
