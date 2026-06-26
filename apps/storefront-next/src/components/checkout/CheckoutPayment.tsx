'use client';

/**
 * the payment step. THE most money-critical storefront component. It orchestrates the multi-step
 * checkout process up to and including payment.
 *
 * REAL backend order-creation sequence (verified against the API):
 *   - `POST /store/v1/carts/{id}/checkout` CREATES the order via `createFromCart` and returns it PLUS the
 *     one-time `guestAccessToken`. It is the ONLY surface that ever returns that token.
 *   - `POST /store/v1/carts/{id}/payment-intent` LOAD-OR-CREATES the order (`createOrLoadFromCart`,
 *     idempotent) and returns the Stripe `clientSecret` for the AUTHORITATIVE server total. It does NOT
 *     return the guest token.
 * So we call `/checkout` FIRST (to mint + stash the guest token), then `/payment-intent` (which reuses
 * the very same order). A retry/re-entry where the cart is already converted makes `/checkout` 409 — we
 * swallow that and fall through to `/payment-intent`, which resolves to the existing order. Money is
 * server-authoritative throughout; this component does NO arithmetic.
 *
 * Idempotency / browser-back safety: the init runs ONCE per mount (ref-guarded). If `/payment-intent`
 * reports the order is already `paid` (or `processing`), there is nothing to confirm — we route STRAIGHT
 * to the confirmation page (no second order, no re-charge). The PaymentIntent itself is idempotency-keyed
 * on the order id server-side, so even a duplicate intent request can't double-charge.
 *
 * Paranoid guards BEFORE any network call:
 *   - missing publishable key → a clear config error (no Stripe load, no order created, no crash).
 *   - a placeholder ("—") shipping address still on the cart → refuse to create an order; a placeholder
 *     must never reach a created order; the checkout flow guard normally prevents reaching here, this is
 *     the defense-in-depth at the payment boundary.
 *
 * The actual `<PaymentElement>` confirm lives in `StripePaymentForm` (it must be inside `<Elements>`).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Elements } from '@stripe/react-stripe-js';
import type { StripeElementLocale } from '@stripe/stripe-js';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth-context';
import { useCart } from '@/lib/cart-context';
import { createBrowserClient } from '@/lib/browser-client';
import { getStripe, isStripeConfigured } from '@/lib/stripe';
import { isPlaceholderAddress } from '@/lib/checkout-form';
import { recoverGuestCheckout, storeGuestCheckout, storeGuestOrderToken } from '@/lib/order-lookup';
import type { CheckoutOrderResponse, PaymentIntentResponse } from '@/lib/payment-types';
import { StripePaymentForm } from './StripePaymentForm';

type Phase = 'init' | 'ready' | 'config-error' | 'placeholder-error' | 'error';

/** Identifiers + the inline PaymentIntent status hint the success page needs. */
interface SuccessTarget {
  /** The human order NUMBER — drives the guest by-number lookup. NEVER a UUID. */
  orderNumber: string;
  /** The order UUID — drives the authenticated by-id lookup (omitted for guests). */
  orderId?: string | null;
  /**
   * The inline PaymentIntent status from a non-redirect confirm, passed as a hint. The success page
   * combines it with the AUTHORITATIVE order status; the affirmative "paid" copy is only shown once the
   * order itself is `paid` (the webhook is the source of truth).
   */
  piStatus?: string | null;
}

/** Build the `?order=…(&id=…)(&pi_status=…)` query the success page reads. */
function successQuery(target: SuccessTarget): string {
  const params = new URLSearchParams({ order: target.orderNumber });
  if (target.orderId) params.set('id', target.orderId);
  if (target.piStatus) params.set('pi_status', target.piStatus);
  return params.toString();
}

/** The absolute return URL Stripe sends redirect-based methods back to (the success page). */
function successUrl(locale: string, target: SuccessTarget): string {
  const path = `/${locale}/checkout/success?${successQuery(target)}`;
  if (typeof window !== 'undefined') return new URL(path, window.location.origin).toString();
  return path;
}

/** The locale-relative success route (for the in-app router after an inline confirm / re-entry). */
function successRoute(target: SuccessTarget): string {
  return `/checkout/success?${successQuery(target)}`;
}

export function CheckoutPayment(): React.ReactElement {
  const t = useTranslations('payment');
  const locale = useLocale();
  const router = useRouter();
  const { isAuthenticated, getAccessToken } = useAuth();
  const { cart } = useCart();

  const [phase, setPhase] = useState<Phase>('init');
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  // The success target (order number, + UUID for authenticated, + inline PI status hint). Built during
  // init; `null` until we have a real, routable order NUMBER (never a UUID).
  const [target, setTarget] = useState<SuccessTarget | null>(null);

  // The credentialed client (cart cookie + Bearer ride along). Built once.
  const clientRef = useRef(createBrowserClient({ getAccessToken }));
  // The Stripe.js promise (memoized in lib/stripe). Read once — null when unconfigured.
  const stripePromiseRef = useRef(isStripeConfigured() ? getStripe() : null);
  // Run the checkout→payment-intent init EXACTLY once per mount (browser-back/StrictMode safe).
  const initedRef = useRef(false);

  const goToSuccess = useCallback(
    (t: SuccessTarget) => {
      router.replace(successRoute(t));
    },
    [router],
  );

  useEffect(() => {
    if (initedRef.current) return;
    initedRef.current = true;

    // Guard 1: Stripe must be configured (publishable key present) — else a clear ops-facing error.
    if (!isStripeConfigured()) {
      setPhase('config-error');
      return;
    }
    // Guard 2: a placeholder shipping address must NEVER reach a created order (Chunk-E binding). The
    // flow guard normally blocks reaching payment with a placeholder; this is the payment-boundary
    // backstop — refuse to create the order, send the customer back to fix the address.
    if (cart && isPlaceholderAddress(cart.shippingAddress)) {
      setPhase('placeholder-error');
      return;
    }

    const client = clientRef.current;
    void (async () => {
      try {
        const cartId = cart?.id;
        if (!cartId) {
          setPhase('error');
          return;
        }
        // 1. Create the order + capture the one-time guest token. A 409 (already converted by a prior
        //    attempt) is fine — the order exists; we recover its identifiers from the cartId-keyed stash.
        let orderNumber: string | null = null;
        let guestToken: string | null = null;
        try {
          const checkout = await client.request<
            '/store/v1/carts/{cartId}/checkout',
            'post',
            CheckoutOrderResponse
          >('post', '/store/v1/carts/{cartId}/checkout', { path: { cartId } });
          orderNumber = checkout.orderNumber;
          guestToken = checkout.guestAccessToken ?? null;
          // Stash the guest token under the order number (success-page lookup) AND a cartId-keyed
          // reference (order number + token) so a later 409-swallow re-entry can recover the REAL order
          // number — never routing a UUID. Never logged.
          if (!isAuthenticated && guestToken) {
            storeGuestOrderToken(orderNumber, guestToken);
            storeGuestCheckout(cartId, orderNumber, guestToken);
          }
        } catch (err) {
          if (!isConflict(err)) throw err;
          // F1: the cart was already converted by a prior attempt. The payment-intent response carries
          // only the order UUID, NOT the number, and the guest lookup is by-number + X-Order-Token — so
          // recover the real order number + token from the cartId-keyed stash. If it's genuinely gone
          // (cleared storage / different tab), we leave `orderNumber` null and fall back to the honest
          // "check your email" floor on the success page (NEVER route a UUID as an order number).
          if (!isAuthenticated) {
            const recovered = recoverGuestCheckout(cartId);
            if (recovered) {
              orderNumber = recovered.orderNumber;
              guestToken = recovered.token;
              // Re-affirm the number-keyed token in case only the cartId index survived.
              storeGuestOrderToken(recovered.orderNumber, recovered.token);
            }
          }
        }

        // 2. Load-or-create the PaymentIntent for the SAME order (server-authoritative total).
        const pi = await client.request<
          '/store/v1/carts/{cartId}/payment-intent',
          'post',
          PaymentIntentResponse
        >('post', '/store/v1/carts/{cartId}/payment-intent', { path: { cartId } });

        // Build the success target. The order NUMBER drives the guest by-number lookup; the order UUID
        // (from the PI) drives the authenticated by-id lookup. We NEVER put a UUID in the `order` slot.
        const orderId = pi.orderId;
        // For an authenticated customer the success page reads by JWT + id, so a missing number is fine;
        // for a guest the number is required, and if we couldn't recover it we still route (the success
        // page shows the honest fallback rather than a broken UUID lookup).
        const built: SuccessTarget = {
          orderNumber: orderNumber ?? '',
          orderId: isAuthenticated ? orderId : undefined,
        };

        // Idempotent re-entry: already paid / async-clearing → nothing to confirm → straight to
        // confirmation (no second charge). The success page drives its copy off the ORDER status.
        if (pi.status === 'paid' || pi.status === 'processing') {
          goToSuccess({ ...built, piStatus: pi.status === 'paid' ? 'succeeded' : 'processing' });
          return;
        }

        if (!pi.clientSecret) {
          setPhase('error');
          return;
        }
        setTarget(built);
        setClientSecret(pi.clientSecret);
        setPhase('ready');
      } catch {
        // Network / 422 / unexpected — a retry-able generic error (never leak internals).
        setPhase('error');
      }
    })();
  }, [cart, isAuthenticated, goToSuccess]);

  // F3: pass the inline PaymentIntent status as a HINT; the success page combines it with the
  // authoritative order status and only shows the affirmative "paid" copy once the order is `paid`.
  const onSucceeded = useCallback(
    (piStatus?: string) => {
      if (target) goToSuccess({ ...target, piStatus: piStatus ?? null });
    },
    [target, goToSuccess],
  );

  if (phase === 'config-error') {
    return <PaymentNotice role="alert" testId="payment-config-error" message={t('configError')} />;
  }
  if (phase === 'placeholder-error') {
    return (
      <PaymentNotice role="alert" testId="payment-address-error" message={t('addressError')} />
    );
  }
  if (phase === 'error') {
    return <PaymentNotice role="alert" testId="payment-error" message={t('genericError')} />;
  }
  if (phase === 'init' || !clientSecret || !target) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="payment-loading">
        {t('preparing')}
      </p>
    );
  }

  const stripePromise = stripePromiseRef.current;
  if (!stripePromise) {
    return <PaymentNotice role="alert" testId="payment-config-error" message={t('configError')} />;
  }

  return (
    <div className="flex flex-col gap-4" data-testid="checkout-payment">
      {/* M1: thread the active next-intl locale into Elements so the Payment Element UI + Stripe's own
          `result.error.message` render in the SESSION language, not the browser default. Our routing
          locales (`en`/`fr`) are valid Stripe `StripeElementLocale` values. */}
      <Elements
        stripe={stripePromise}
        options={{ clientSecret, locale: locale as StripeElementLocale }}
      >
        <StripePaymentForm returnUrl={successUrl(locale, target)} onSucceeded={onSucceeded} />
      </Elements>
    </div>
  );
}

function PaymentNotice({
  message,
  role,
  testId,
}: {
  message: string;
  role: 'alert' | 'status';
  testId: string;
}): React.ReactElement {
  return (
    <div
      role={role}
      data-testid={testId}
      className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {message}
    </div>
  );
}

/** True when an error looks like an HTTP 409 (cart already converted). client-js errors carry `status`. */
function isConflict(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { status?: number }).status === 409
  );
}
