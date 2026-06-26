/**
 * SetupConfigService (SECURITY-CRITICAL).
 *
 * The connection/transport PROBES and persistence writes behind the database / smtp /
 * payments setup steps. Kept out of the controller so the credential-handling logic is
 * unit-testable and the controller stays a thin HTTP shell.
 *
 * Security posture:
 *   - DB and SMTP tests open THROWAWAY clients from the SUBMITTED creds and always
 *     close them (try/finally); they never touch the live pool / MailService singleton.
 *   - Every error returned to the caller is SANITIZED — no submitted password, URL
 *     userinfo, or SMTP server response (which can embed a recipient) ever leaks.
 *   - Secret blobs (SMTP creds, Stripe keys) are AEAD-encrypted via SetupSecretsService;
 *     only the non-secret `methods`/markers land in plaintext settings.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import postgres from 'postgres';
import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { systemState } from '../database/schema/system_state';
import { tenants } from '../database/schema/_tenants';
import { STRIPE_API_VERSION } from '../payments/stripe/stripe.client';
import { SetupSecretsService } from './setup-secrets.service';
import { TenantSettingsService } from '../taxes/tenant-settings.service';
import type { DatabaseConfigureDto } from './dto/database.dto';
import type { SmtpTestDto, SmtpConfigureDto } from './dto/smtp.dto';
import type { PaymentsConfigureDto } from './dto/payments.dto';

/** Uniform probe result. `error` is ALWAYS sanitized (no creds). */
export interface ProbeResult {
  ok: boolean;
  error?: string;
}

/** The persisted SMTP credential blob shape (what `configureSmtp` writes, kind `smtp`). */
export interface PersistedSmtpCreds {
  host: string;
  port: number;
  secure: boolean;
  user?: string | null;
  pass?: string | null;
  from: string;
}

/** A probe timeout — short, so a wrong host doesn't hang the wizard request. */
const PROBE_TIMEOUT_SECONDS = 5;

@Injectable()
export class SetupConfigService {
  private readonly logger = new Logger(SetupConfigService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly secrets: SetupSecretsService,
    private readonly settings: TenantSettingsService,
  ) {}

  // ─── database ──────────────────────────────────────────────────────────────

  /**
   * Open a THROWAWAY `postgres(url, {max:1})`, `SELECT 1`, then close (try/finally).
   * Returns `{ok:true}` on success or `{ok:false, error}` with a SANITIZED message —
   * never the password from the URL. Short connect timeout so a dead host fails fast.
   */
  async testDatabase(url: string): Promise<ProbeResult> {
    let client: ReturnType<typeof postgres> | undefined;
    try {
      client = postgres(url, {
        max: 1,
        connect_timeout: PROBE_TIMEOUT_SECONDS,
        idle_timeout: PROBE_TIMEOUT_SECONDS,
        max_lifetime: PROBE_TIMEOUT_SECONDS,
        onnotice: () => {},
      });
      await client`select 1`;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: sanitizeDbError(err) };
    } finally {
      if (client) {
        await client.end({ timeout: 1 }).catch(() => {});
      }
    }
  }

  /**
   * RECORD-ONLY: the running app is already bound to its own env
   * `DATABASE_URL` and CANNOT re-point its live pool at runtime — an external switch
   * requires a restart with new env. So we only persist the operator's CHOICE marker
   * into `system_state.db_config`. We deliberately do NOT store the external URL's
   * credentials here (that would put a plaintext password in `system_state`); the
   * marker records the mode only.
   */
  async configureDatabase(dto: DatabaseConfigureDto): Promise<void> {
    const marker = { mode: dto.mode, configuredAt: new Date().toISOString() };
    await this.database.db
      .insert(systemState)
      .values({ key: 'db_config', value: marker })
      .onConflictDoUpdate({
        target: systemState.key,
        set: { value: marker, updatedAt: new Date() },
      });
  }

  // ─── smtp ──────────────────────────────────────────────────────────────────

  /**
   * Build a THROWAWAY nodemailer transport from the SUBMITTED creds and send one test
   * message to `dto.to` (works against Mailhog in dev). The live MailService singleton
   * is never touched. The transport is closed in `finally`. nodemailer's own logging is
   * OFF and any error is sanitized (its message can embed the recipient / server reply).
   */
  async testSmtp(dto: SmtpTestDto): Promise<ProbeResult> {
    const transport = createTransport({
      host: dto.host,
      port: dto.port,
      secure: dto.secure,
      auth: dto.user && dto.pass ? { user: dto.user, pass: dto.pass } : undefined,
      connectionTimeout: PROBE_TIMEOUT_SECONDS * 1000,
      greetingTimeout: PROBE_TIMEOUT_SECONDS * 1000,
      socketTimeout: PROBE_TIMEOUT_SECONDS * 1000,
      logger: false,
      debug: false,
    });
    try {
      await transport.sendMail({
        from: dto.from,
        to: dto.to,
        subject: 'SovEcom setup — SMTP test',
        text: 'This is a test email confirming your SMTP configuration works.',
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: sanitizeSmtpError(err) };
    } finally {
      transport.close();
    }
  }

  /**
   * Send ONE message through a THROWAWAY transport built from a PERSISTED SMTP creds
   * blob (the shape `configureSmtp` writes into `tenant_secrets`). The same throwaway-
   * transport mechanism as {@link testSmtp}, factored so the admin-account OTP send
   * (SetupAdminService) reuses it rather than re-implementing nodemailer wiring. The
   * live MailService singleton is never touched; the transport is closed in `finally`.
   *
   * The OTP/recipient pass through as the message body/`to` but are NEVER logged here
   * (nodemailer's own logging is OFF). On failure the error is sanitized (it can embed
   * the recipient / server reply) — the caller decides how to surface it (the OTP send
   * never echoes the code, only success/failure).
   */
  async sendViaSmtpSecret(
    creds: PersistedSmtpCreds,
    message: { to: string; subject: string; text: string; html?: string },
  ): Promise<ProbeResult> {
    const transport = createTransport({
      host: creds.host,
      port: creds.port,
      secure: creds.secure,
      auth: creds.user && creds.pass ? { user: creds.user, pass: creds.pass } : undefined,
      connectionTimeout: PROBE_TIMEOUT_SECONDS * 1000,
      greetingTimeout: PROBE_TIMEOUT_SECONDS * 1000,
      socketTimeout: PROBE_TIMEOUT_SECONDS * 1000,
      logger: false,
      debug: false,
    });
    try {
      await transport.sendMail({
        from: creds.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: sanitizeSmtpError(err) };
    } finally {
      transport.close();
    }
  }

  /** AEAD-encrypt the SMTP credential blob into `tenant_secrets` (kind `smtp`). */
  async configureSmtp(tenantId: string, dto: SmtpConfigureDto): Promise<void> {
    await this.secrets.putJson(tenantId, 'smtp', {
      host: dto.host,
      port: dto.port,
      secure: dto.secure,
      user: dto.user ?? null,
      pass: dto.pass ?? null,
      from: dto.from,
    });
  }

  // ─── payments ────────────────────────────────────────────────────────────────

  /**
   * Persist the enabled `methods` into `tenants.settings.payments` (read-merge-write so
   * unrelated settings keys survive), AEAD-encrypt the Stripe key blob into
   * `tenant_secrets` (kind `stripe`), and OPTIONALLY best-effort live-validate the
   * Stripe secret key. Validation is soft: a network/transient failure returns
   * `stripe:'unvalidated'` rather than hard-failing the step. Keys are never persisted
   * in settings, never logged, never echoed.
   *
   * @returns the per-provider validation verdicts surfaced to the wizard.
   */
  async configurePayments(
    tenantId: string,
    dto: PaymentsConfigureDto,
  ): Promise<{ stripe?: 'valid' | 'invalid' | 'unvalidated' }> {
    // 1. Persist enabled methods into settings.payments (merge, preserve other keys).
    const [row] = await this.database.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const current = isRecord(row?.settings) ? (row!.settings as Record<string, unknown>) : {};
    const merged: Record<string, unknown> = {
      ...current,
      payments: { methods: dto.methods },
    };
    await this.database.db
      .update(tenants)
      .set({ settings: merged, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));
    // Keep TenantSettingsService's in-process cache honest: this is a direct full-column
    // settings write, so a later tax/onboarding read-merge-write off a STALE cache would
    // otherwise silently drop settings.payments.methods (mirrors mergeSettings()).
    this.settings.invalidate(tenantId);

    // 2. Encrypt the Stripe key blob at rest (only when supplied).
    const result: { stripe?: 'valid' | 'invalid' | 'unvalidated' } = {};
    if (dto.stripe) {
      await this.secrets.putJson(tenantId, 'stripe', {
        secretKey: dto.stripe.secretKey,
        publishableKey: dto.stripe.publishableKey,
        webhookSecret: dto.stripe.webhookSecret ?? null,
      });
      // 3. Best-effort live validation (soft).
      result.stripe = await this.validateStripeKey(dto.stripe.secretKey);
    }
    return result;
  }

  /**
   * Construct a throwaway Stripe client from the secret key and make one cheap read
   * (`balance.retrieve`). A clean auth rejection ⇒ `invalid`; success ⇒ `valid`; any
   * network/transient error ⇒ `unvalidated` (don't hard-fail offline setups). The key
   * is never logged — only the boolean verdict is surfaced.
   */
  private async validateStripeKey(secretKey: string): Promise<'valid' | 'invalid' | 'unvalidated'> {
    try {
      const stripe = new Stripe(secretKey, {
        apiVersion: STRIPE_API_VERSION,
        typescript: true,
        telemetry: false,
        maxNetworkRetries: 0,
        timeout: PROBE_TIMEOUT_SECONDS * 1000,
      });
      await stripe.balance.retrieve();
      return 'valid';
    } catch (err) {
      // A Stripe auth error means the key is wrong; anything else is "couldn't check".
      const type = (err as { type?: unknown })?.type;
      if (type === 'StripeAuthenticationError' || type === 'StripePermissionError') {
        return 'invalid';
      }
      this.logger.warn('Stripe key validation could not complete (treated as unvalidated)');
      return 'unvalidated';
    }
  }
}

/**
 * Sanitize a postgres connection error to a PII-FREE string. The `postgres` driver may
 * embed the connection URL (incl. the password in userinfo) in messages, so we surface
 * ONLY the structured code/severity, never the raw message.
 */
function sanitizeDbError(err: unknown): string {
  const e = (err ?? {}) as { code?: unknown; errno?: unknown };
  if (typeof e.code === 'string') {
    return `database connection failed (${e.code})`;
  }
  if (typeof e.errno === 'string') {
    return `database connection failed (${e.errno})`;
  }
  return 'database connection failed';
}

/**
 * Sanitize a nodemailer/SMTP error to a PII-FREE string (mirrors smtp.transport.ts):
 * the server response embedded in `message` can contain the recipient address, so we
 * surface only the structured codes.
 */
function sanitizeSmtpError(err: unknown): string {
  const e = (err ?? {}) as { responseCode?: unknown; code?: unknown; command?: unknown };
  const parts: string[] = [];
  if (typeof e.responseCode === 'number') parts.push(String(e.responseCode));
  if (typeof e.code === 'string') parts.push(`(${e.code})`);
  if (typeof e.command === 'string') parts.push(`cmd ${e.command}`);
  return `SMTP error${parts.length ? ` ${parts.join(' ')}` : ''}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
