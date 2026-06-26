'use client';

/**
 * the inner Stripe Payment Element form. MONEY-CRITICAL.
 *
 * This component MUST render INSIDE `<Elements>` (CheckoutPayment provides it) because it calls the
 * `useStripe`/`useElements` hooks, which read the Elements context. It renders the dynamic
 * `<PaymentElement>` (whatever methods the Stripe Dashboard enables — never hardcoded card-only) and a
 * single pay button, and confirms with `stripe.confirmPayment({ elements, confirmParams:{ return_url },
 * redirect: 'if_required' })`:
 *   - `redirect: 'if_required'` keeps card payments inline (resolve with a `paymentIntent`) while
 *     redirect-based methods navigate to `return_url`; the success page handles the post-redirect return.
 *   - DECLINED / validation errors resolve with `{ error }` → a clear, RETRY-able message; NO completion.
 *   - NETWORK failures reject → caught → same retry-able treatment.
 *   - DOUBLE-SUBMIT guarded: the button disables on submit and a `submitting` ref short-circuits a second
 *     entrant, so `confirmPayment` runs at most once per click-through (no double charge).
 *
 * On an inline success it calls `onSucceeded()` (CheckoutPayment routes to the confirmation page). It
 * NEVER computes money and NEVER logs card data / the client secret / tokens.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';

export function StripePaymentForm({
  returnUrl,
  onSucceeded,
}: {
  /** The absolute URL a redirect-based method returns to (the `/checkout/success` page). */
  returnUrl: string;
  /**
   * Called after an INLINE (non-redirect) confirm resolves without an error — the parent routes to the
   * confirmation page. The inline PaymentIntent status (`succeeded` / `processing` / …) is passed as a
   * HINT; the confirmation page drives its copy off the AUTHORITATIVE order status, so we never claim
   * "paid" here — the webhook is the source of truth (F3).
   */
  onSucceeded: (paymentIntentStatus?: string) => void;
}): React.ReactElement {
  const t = useTranslations('payment');
  const stripe = useStripe();
  const elements = useElements();

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Re-entrancy guard read synchronously (state updates are async; a fast double-click could slip past
  // a state-only check). With this, confirmPayment runs at most once per in-flight attempt.
  const inFlightRef = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);

  // Move focus to the error banner when it appears (WCAG 3.3.1) so keyboard/SR users land on it.
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const onSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>): Promise<void> => {
      e.preventDefault();
      if (inFlightRef.current) return; // double-submit guard (synchronous)
      if (!stripe || !elements) return; // Stripe.js not ready yet — button is disabled anyway
      inFlightRef.current = true;
      setSubmitting(true);
      setError(null);
      try {
        const result = await stripe.confirmPayment({
          elements,
          confirmParams: { return_url: returnUrl },
          // Keep card inline; only redirect-based methods leave the page (handled on return).
          redirect: 'if_required',
        });
        if (result.error) {
          // Declined / validation / auth-failed — show the Stripe message (already customer-safe) and
          // stay on the page so the customer can retry. No order is "completed" client-side; the webhook
          // is the source of truth and this PaymentIntent simply isn't paid.
          setError(result.error.message ?? t('genericError'));
          inFlightRef.current = false;
          setSubmitting(false);
          return;
        }
        // Inline confirm resolved (no error): the PaymentIntent may be `succeeded` OR `processing` (async
        // methods). We do NOT assert "paid" here — hand the inline status to the parent as a hint and let
        // the confirmation page reflect the AUTHORITATIVE order status (the webhook is the truth).
        onSucceeded(result.paymentIntent?.status);
      } catch {
        // Network / unexpected — retry-able. Never surface internals.
        setError(t('genericError'));
        inFlightRef.current = false;
        setSubmitting(false);
      }
    },
    [stripe, elements, returnUrl, onSucceeded, t],
  );

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" aria-busy={submitting}>
      {error ? (
        <div
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {error}
        </div>
      ) : null}

      {/* Dynamic payment methods — whatever the Dashboard enables (never hardcoded card-only). */}
      <PaymentElement />

      <button
        type="submit"
        data-testid="pay-button"
        disabled={submitting || !stripe || !elements}
        aria-disabled={submitting || !stripe || !elements}
        className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
      >
        {submitting ? t('paying') : t('pay')}
      </button>
    </form>
  );
}
