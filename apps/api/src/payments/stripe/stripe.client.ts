import Stripe from 'stripe';
import type { StripeClient } from './stripe.types';

/**
 * the Stripe client seam.
 *
 * `STRIPE_CLIENT` is a DI token providing a configured `Stripe` instance (or `null` when no
 * `STRIPE_SECRET_KEY` is set, so the app boots in dev/test without Stripe — mirrors the
 * MailService no-op-when-unconfigured pattern). Tests override this token with a mock client.
 *
 * The API version is PINNED explicitly (exit criterion) to the version the installed SDK
 * (`stripe@22.2.0`) is typed against, so a server-side Stripe upgrade can't silently change
 * behaviour. Override only via env, deliberately. Telemetry is OFF (EU-privacy ethos).
 *
 * Secrets are read from env (`STRIPE_SECRET_KEY`) per the codebase convention (DB/Redis/SMTP/
 * storage all do); they are NEVER logged. The production secrets-manager seam is a logged
 * cross-cutting follow-up.
 */
export const STRIPE_CLIENT = Symbol('STRIPE_CLIENT');

/**
 * The API version the installed SDK (`stripe@22.2.0`) is typed against. Declared as a literal
 * `const` so its inferred type matches the SDK's `LatestApiVersion` exactly (which is not
 * reachable as a named type under CJS resolution — see stripe.types.ts).
 */
export const STRIPE_API_VERSION = '2026-05-27.dahlia';

/** Build a Stripe client from env, or null when unconfigured (dev/test). */
export function createStripeClient(): StripeClient | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return null;
  }
  // Pin explicitly (exit criterion). An env override is cast back to the literal type so a
  // deliberate bump still type-checks against the SDK's expected version.
  const apiVersion = (process.env.STRIPE_API_VERSION ??
    STRIPE_API_VERSION) as typeof STRIPE_API_VERSION;
  return new Stripe(key, {
    apiVersion,
    typescript: true,
    telemetry: false,
    maxNetworkRetries: 2,
    appInfo: { name: 'SovEcom', url: 'https://sovecom.local' },
  });
}

/** Provider that wires {@link STRIPE_CLIENT} from env. Overridden in tests. */
export const stripeClientProvider = {
  provide: STRIPE_CLIENT,
  useFactory: createStripeClient,
};
