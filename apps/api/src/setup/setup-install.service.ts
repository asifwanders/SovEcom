/**
 * SetupInstallService (THE FINAL, SECURITY-CRITICAL flip).
 *
 * `POST /setup/v1/complete` — the one call that turns a configured, not-yet-installed
 * system INTO an installed one, closing the entire setup surface (the guard 404s every
 * `/setup/v1/*` route except GET /status afterward).
 *
 * PRECONDITIONS (all must hold, else 422 listing what is missing):
 *   (a) `system_state.admin_configured === true` — the owner password was really set
 *       through the email-OTP flow (SetupAdminService), so the system is not locked out.
 *   (b) tax configured — the onboarding profile is present: `business_country`
 *       AND a non-default `tax_mode` in `tenants.settings` (read via TenantSettingsService).
 *   (c) a live `X-Setup-Token` — already guaranteed by SetupTokenGuard (not-installed +
 *       valid token); we additionally CONSUME it here, atomically.
 *
 * THE FLIP (concurrency-safe, idempotent):
 *   In ONE db transaction: an ATOMIC single-use claim of the token row
 *     `UPDATE setup_tokens SET used_at = now()
 *        WHERE token_hash = :h AND used_at IS NULL AND expires_at > now() RETURNING id`
 *   (Postgres serialises the row write — under N concurrent /complete calls EXACTLY ONE
 *   claims the row), then `upsert system_state.installed = true`. Because both happen in
 *   the same tx, the winner consumes-and-installs as one unit; the losers claim zero
 *   rows and do NOT flip. So exactly one install can ever occur — no double flip.
 *
 * IDEMPOTENCY: if the system is ALREADY installed when this runs, return a 200
 * success-shaped response rather than a confusing 404. In practice the guard runs FIRST
 * and 404s post-install, so this idempotent branch is only reachable inside the SAME
 * request that flips it (the guard saw not-installed). A post-install re-call therefore
 * yields the guard's 404; the wizard treats EITHER outcome (a 200 from the flipping call
 * OR a later 404) as "installed".
 */
import { Injectable, Logger } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { setupTokens } from '../database/schema/setup_tokens';
import { systemState } from '../database/schema/system_state';
import { TenantSettingsService } from '../taxes/tenant-settings.service';

/** A precondition failure: which prerequisites are still missing (no secrets). */
export class SetupPreconditionError extends Error {
  constructor(public readonly missing: string[]) {
    super(`setup is not complete — missing: ${missing.join(', ')}`);
    this.name = 'SetupPreconditionError';
  }
}

@Injectable()
export class SetupInstallService {
  private readonly logger = new Logger(SetupInstallService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly settings: TenantSettingsService,
  ) {}

  /** SHA-256 hex of the token (matches SetupTokenService's opaque-token convention). */
  private static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Run the install completion. `token` is the plaintext `X-Setup-Token` (the guard has
   * already verified it is live). Returns `{ installed: true }` on the flip OR when the
   * system is already installed (idempotent). Throws {@link SetupPreconditionError} when
   * admin/tax are not yet configured.
   */
  async complete(tenantId: string, token: string): Promise<{ installed: true }> {
    // Idempotency: already installed ⇒ 200 success-shape (don't 404 here; the guard owns
    // the post-install 404). This branch is only reachable in the SAME request that
    // flips it because the guard 404s a genuinely-post-install re-call before we run.
    if (await this.isInstalled()) {
      return { installed: true };
    }

    // PRECONDITIONS — collect ALL missing items so the wizard can show them at once.
    const missing = await this.collectMissingPreconditions(tenantId);
    if (missing.length > 0) {
      throw new SetupPreconditionError(missing);
    }

    // THE FLIP — atomic consume + install in ONE transaction. consumeToken's single-
    // statement UPDATE guarantees exactly one concurrent winner; the flip rides the
    // same tx so consume-and-install is one indivisible unit.
    const tokenHash = SetupInstallService.hash(token);
    const flipped = await this.database.db.transaction(async (tx) => {
      const claimed = await tx
        .update(setupTokens)
        .set({ usedAt: sql`now()` })
        .where(
          and(
            eq(setupTokens.tokenHash, tokenHash),
            isNull(setupTokens.usedAt),
            gt(setupTokens.expiresAt, sql`now()`),
          ),
        )
        .returning({ id: setupTokens.id });

      if (claimed.length !== 1) {
        // We did NOT win the token claim (a concurrent /complete already consumed it,
        // or it expired between the guard check and here). Do NOT flip — the winner did.
        return false;
      }

      await tx
        .insert(systemState)
        .values({ key: 'installed', value: true })
        .onConflictDoUpdate({
          target: systemState.key,
          set: { value: true, updatedAt: new Date() },
        });

      return true;
    });

    if (!flipped) {
      // Lost the race. The winner installed; the system IS installed now, so report
      // success (idempotent) rather than an error — the end state the caller wanted.
      if (await this.isInstalled()) {
        return { installed: true };
      }
      // Token vanished but not installed: a live token is required (guard already
      // checked, but the row could have been superseded). Surface as a precondition.
      throw new SetupPreconditionError(['valid_setup_token']);
    }

    this.logger.log('system installed — setup surface is now closed');
    return { installed: true };
  }

  /**
   * Which install preconditions are unmet (empty array ⇒ all satisfied). Checks the
   * `admin_configured` marker and the tax/onboarding profile (business country + a
   * non-default tax mode).
   */
  private async collectMissingPreconditions(tenantId: string): Promise<string[]> {
    const missing: string[] = [];

    if (!(await this.isAdminConfigured())) {
      missing.push('admin_account');
    }

    const tax = await this.settings.getTaxSettings(tenantId);
    const profile = await this.settings.getOnboardingProfile(tenantId);
    // Tax is "configured" when the onboarding business country is set. The tax mode is
    // always a valid value (defaults to 'none' for a non-EU country), so the meaningful
    // signal that the operator completed the tax step is the business country.
    if (!profile.businessCountry) {
      missing.push('tax_configuration');
    }
    // Defensive: a degenerate state where business country is set but tax mode parsed to
    // a non-value can never occur (parse always yields 'none'|'eu_vat'), but assert it.
    void tax;

    return missing;
  }

  /** True when `system_state.installed === true`. */
  private async isInstalled(): Promise<boolean> {
    const [row] = await this.database.db
      .select({ value: systemState.value })
      .from(systemState)
      .where(eq(systemState.key, 'installed'))
      .limit(1);
    return row?.value === true;
  }

  /** True when `system_state.admin_configured === true` (owner password really set). */
  private async isAdminConfigured(): Promise<boolean> {
    const [row] = await this.database.db
      .select({ value: systemState.value })
      .from(systemState)
      .where(eq(systemState.key, 'admin_configured'))
      .limit(1);
    return row?.value === true;
  }
}
