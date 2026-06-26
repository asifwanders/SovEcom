/**
 * Stripe.js loader singleton.
 *
 * Loads `@stripe/stripe-js` with the PUBLISHABLE key ONLY (`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, a
 * public env inlined into the browser bundle). The secret key is NEVER referenced client-side. We use
 * the hosted Payment Element backed by the backend PaymentIntent `clientSecret` — not Checkout Sessions,
 * not the legacy Card Element.
 *
 * `loadStripe` returns a PROMISE for the Stripe object and must be called EXACTLY ONCE per page load
 * (Stripe injects a script tag; repeated calls re-inject + re-init). So we memoize the promise at
 * module scope and hand the same promise to every `<Elements stripe={…}>`.
 *
 * Missing-key posture (ops note): if the publishable key env is absent/blank, we do NOT call
 * `loadStripe` (calling it with an empty key throws). `getStripe()` returns `null`, and the payment
 * step renders a clear configuration error rather than crashing the app. `isStripeConfigured()` lets
 * the UI decide which state to show. OPS: set `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (the `pk_…` key) in
 * the storefront environment, or the checkout payment step is non-functional.
 */
import type { Stripe } from '@stripe/stripe-js';
import { loadStripe } from '@stripe/stripe-js';

/** The publishable key from the public env (inlined into the client bundle), or undefined/blank. */
function publishableKey(): string | undefined {
  const key = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  return key && key.trim() !== '' ? key : undefined;
}

/** True when the publishable key is present — the payment step is usable. */
export function isStripeConfigured(): boolean {
  return publishableKey() !== undefined;
}

// Memoized at module scope: created ONCE on first `getStripe()`, reused for every `<Elements>`.
let stripePromise: Promise<Stripe | null> | null = null;

/**
 * The shared Stripe.js promise, or `null` when the publishable key is not configured (so the caller
 * shows a config error instead of crashing). Memoized — repeated calls return the SAME promise.
 */
export function getStripe(): Promise<Stripe | null> | null {
  const key = publishableKey();
  if (!key) return null;
  if (stripePromise === null) {
    stripePromise = loadStripe(key);
  }
  return stripePromise;
}

/** Test-only: reset the memoized promise so each test observes a fresh load. NOT used in app code. */
export function __resetStripeForTests(): void {
  stripePromise = null;
}
