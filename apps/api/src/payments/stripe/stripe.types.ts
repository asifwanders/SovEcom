import type Stripe from 'stripe';

/**
 * Stripe type aliases that resolve under this project's `nodenext`/CommonJS
 * module resolution.
 *
 * The Stripe SDK's CJS typings expose `export = StripeConstructor`, whose namespace only
 * aliases the instance type — so `Stripe.Event` / `Stripe.RefundCreateParams` do NOT resolve
 * here (they only exist on the ESM namespace). We derive the few types we need from the
 * client's own method signatures, which is resolution-agnostic and survives SDK upgrades.
 */

/** The Stripe client instance type. */
export type StripeClient = Stripe.Stripe;

/** A verified webhook event (the return of `webhooks.constructEvent`). */
export type StripeEvent = ReturnType<StripeClient['webhooks']['constructEvent']>;

/** The accepted `reason` values for a refund create call. */
export type StripeRefundReason = NonNullable<
  Parameters<StripeClient['refunds']['create']>[0]
>['reason'];
