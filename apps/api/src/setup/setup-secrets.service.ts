/**
 * SetupSecretsService (SECURITY-CRITICAL).
 *
 * The single seam for persisting setup-wizard credentials AT REST. Every secret is
 * AEAD-encrypted (AES-256-GCM via {@link AeadService}) with **AAD = tenantId** before
 * it touches the `tenant_secrets` table, and decrypted only at point of use. The AAD
 * binding means a ciphertext row stored for one tenant cannot be decrypted under
 * another tenant's id — a copied/replayed row fails closed (the GCM tag check throws).
 *
 * There is NO plaintext column and NO plaintext is ever logged. Secrets are stored as
 * JSON blobs (one `kind` per provider) so multi-field credentials live under one row.
 * `putSecret` upserts on the `(tenant_id, kind)` unique slot, so re-configuring a
 * provider overwrites in place rather than accumulating rows.
 */
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { AeadService } from '../auth/crypto/aead.service';
import { DatabaseService } from '../database/database.service';
import { tenantSecrets } from '../database/schema/tenant_secrets';

@Injectable()
export class SetupSecretsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly aead: AeadService,
  ) {}

  /**
   * Encrypt `plaintext` (AAD = tenantId) and upsert it into the `(tenant_id, kind)`
   * slot. On conflict the ciphertext is replaced and `updated_at` bumped. The
   * plaintext is never logged. `plaintext` is the caller's already-serialised blob
   * (e.g. JSON for multi-field creds) — see {@link putJson}.
   */
  async putSecret(tenantId: string, kind: string, plaintext: string): Promise<void> {
    const ciphertext = this.aead.encrypt(plaintext, tenantId);
    await this.database.db
      .insert(tenantSecrets)
      .values({ tenantId, kind, ciphertext })
      .onConflictDoUpdate({
        target: [tenantSecrets.tenantId, tenantSecrets.kind],
        set: { ciphertext, updatedAt: sql`now()` },
      });
  }

  /** Convenience: JSON-serialise a credential object and persist it via {@link putSecret}. */
  async putJson(tenantId: string, kind: string, value: unknown): Promise<void> {
    await this.putSecret(tenantId, kind, JSON.stringify(value));
  }

  /**
   * Load + decrypt the secret for `(tenant_id, kind)`, or `null` when absent.
   * Decryption verifies the GCM tag AND the AAD (tenantId) — a row that does not
   * authenticate under this tenant throws rather than returning garbage.
   */
  async getSecret(tenantId: string, kind: string): Promise<string | null> {
    const [row] = await this.database.db
      .select({ ciphertext: tenantSecrets.ciphertext })
      .from(tenantSecrets)
      .where(and(eq(tenantSecrets.tenantId, tenantId), eq(tenantSecrets.kind, kind)))
      .limit(1);
    if (!row) {
      return null;
    }
    return this.aead.decrypt(row.ciphertext, tenantId);
  }

  /** Decrypt + JSON-parse a blob stored via {@link putJson}, or `null` when absent. */
  async getJson<T = unknown>(tenantId: string, kind: string): Promise<T | null> {
    const plaintext = await this.getSecret(tenantId, kind);
    return plaintext === null ? null : (JSON.parse(plaintext) as T);
  }

  /** True when a secret row exists for `(tenant_id, kind)`. Does not decrypt. */
  async hasSecret(tenantId: string, kind: string): Promise<boolean> {
    const [row] = await this.database.db
      .select({ id: tenantSecrets.id })
      .from(tenantSecrets)
      .where(and(eq(tenantSecrets.tenantId, tenantId), eq(tenantSecrets.kind, kind)))
      .limit(1);
    return row !== undefined;
  }
}
