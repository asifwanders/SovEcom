'use client';

/**
 * Order confirmation display. MONEY-CRITICAL: every figure is the SERVER's order total via `formatPrice`
 * (integer minor units, never /100 by hand). No client arithmetic.
 *
 * Two read paths:
 *   - LOGGED-IN (a Bearer token is present): `GET /store/v1/orders/{id}` — the customer's own order
 *     (404 on anyone else's, no IDOR). The order id comes from the `id` query param the payment step set.
 *   - GUEST: `GET /store/v1/orders/by-number/{orderNumber}` with the one-time guest token (stashed at
 *     checkout) in the `X-Order-Token` HEADER (never a URL/query secret). The order number comes from
 *     the `order` query param.
 *
 * Post-redirect return: a redirect-based payment method returns to `return_url` with
 * `payment_intent_client_secret` in the query. We `stripe.retrievePaymentIntent(secret)` to learn the
 * outcome and show success / failure accordingly. (For inline card payments there is no such param and
 * we simply show the order.) The webhook remains the server's source of truth for "paid"; this is
 * display only.
 *
 * Browser-back safety: this page is a pure READ — re-loading it never creates an order or charges.
 */
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth-context';
import { createBrowserClient } from '@/lib/browser-client';
import { getStripe } from '@/lib/stripe';
import { formatPrice } from '@/lib/api';
import { fetchOrderForConfirmation, readGuestOrderToken } from '@/lib/order-lookup';
import type { OrderView } from '@/lib/payment-types';

type RedirectOutcome = 'none' | 'succeeded' | 'processing' | 'failed';
type LoadState = 'loading' | 'loaded' | 'fallback' | 'error';

export function CheckoutSuccess(): React.ReactElement {
  const t = useTranslations('payment');
  const locale = useLocale();
  const params = useSearchParams();
  const { isAuthenticated, isLoading: authLoading, getAccessToken } = useAuth();

  const orderNumber = params.get('order');
  const orderId = params.get('id');
  const redirectSecret = params.get('payment_intent_client_secret');
  // The inline PaymentIntent status hint from the payment step (non-redirect confirm). It is only a
  // hint: the AUTHORITATIVE signal for the affirmative "paid" copy is the ORDER status below.
  const inlinePiStatus = params.get('pi_status');

  const [order, setOrder] = useState<OrderView | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [redirect, setRedirect] = useState<RedirectOutcome>(redirectSecret ? 'processing' : 'none');

  const clientRef = useRef(createBrowserClient({ getAccessToken }));
  const ranRef = useRef(false);

  useEffect(() => {
    // Wait for the silent auth refresh to settle so we know which read path to take.
    if (authLoading) return;
    if (ranRef.current) return;
    ranRef.current = true;

    void (async () => {
      // 1. Post-redirect: resolve the PaymentIntent status for the customer-visible outcome.
      if (redirectSecret) {
        try {
          const stripe = await getStripe();
          const res = await stripe?.retrievePaymentIntent(redirectSecret);
          const status = res?.paymentIntent?.status;
          if (status === 'succeeded') setRedirect('succeeded');
          else if (status === 'processing') setRedirect('processing');
          else setRedirect('failed');
        } catch {
          setRedirect('failed');
        }
      }

      // 2. Read the order for display.
      const guestToken = !isAuthenticated && orderNumber ? readGuestOrderToken(orderNumber) : null;
      const canRead = (isAuthenticated && orderId) || (orderNumber && guestToken);
      if (!canRead) {
        // A guest who lost the token (or a direct visit) — show a friendly "check your email" fallback.
        setState('fallback');
        return;
      }
      try {
        const result = await fetchOrderForConfirmation(
          clientRef.current,
          { orderId, orderNumber, guestToken },
          isAuthenticated,
        );
        setOrder(result);
        setState('loaded');
        // F2: do NOT clear the guest token here — keeping it lets a reload of this confirmation page
        // re-read the order (rather than dropping to the fallback). It is tab-scoped sessionStorage and
        // dies with the tab; there is no self-referential receipt link that would dead-end on it.
      } catch {
        setState('error');
      }
    })();
  }, [authLoading, isAuthenticated, orderId, orderNumber, redirectSecret]);

  // A failed redirect payment: show retry guidance, not a success.
  if (redirect === 'failed') {
    return (
      <div className="flex flex-col gap-4" data-testid="payment-failed">
        <h2 className="text-lg font-semibold text-foreground">{t('failedHeading')}</h2>
        <p className="text-sm text-muted-foreground">{t('failedBody')}</p>
        <Link href="/checkout" className="text-sm font-medium text-primary underline">
          {t('backToCheckout')}
        </Link>
      </div>
    );
  }

  if (state === 'loading') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="success-loading">
        {t('loadingOrder')}
      </p>
    );
  }

  if (state === 'fallback') {
    return (
      <div className="flex flex-col gap-3" data-testid="order-lookup-fallback">
        <h2 className="text-lg font-semibold text-foreground">{t('successHeading')}</h2>
        <p className="text-sm text-muted-foreground">{t('lookupFallback')}</p>
      </div>
    );
  }

  if (state === 'error' || !order) {
    return (
      <div className="flex flex-col gap-3" data-testid="order-load-error">
        <p className="text-sm text-muted-foreground">{t('orderLoadError')}</p>
        <Link href="/" className="text-sm font-medium text-primary underline">
          {t('backHome')}
        </Link>
      </div>
    );
  }

  const price = (minor: number): string => formatPrice(minor, order.currency, locale);

  // The affirmative "Payment succeeded / payment confirmed" copy is shown ONLY when the ORDER is
  // actually `paid` (the webhook is the source of truth; the order is `pending_payment` until then).
  // Neither an inline `pi_status=succeeded` hint NOR a redirect `succeeded` is sufficient on its own —
  // they let us avoid the alarming "failed" copy, but the headline still waits for the order status.
  const orderPaid = order.status === 'paid';
  // "processing-ish": an async method is clearing, or the order simply hasn't flipped to paid yet. (The
  // `failed` redirect outcome already returned above, so reaching here means not-failed.)
  const isProcessing = redirect === 'processing' || inlinePiStatus === 'processing' || !orderPaid;

  return (
    <div className="flex flex-col gap-6" data-testid="checkout-success">
      <div className="flex flex-col gap-1">
        {orderPaid ? (
          <span data-testid="payment-succeeded" className="sr-only">
            {t('paymentSucceeded')}
          </span>
        ) : null}
        <h2 className="text-xl font-bold text-foreground">
          {orderPaid ? t('successHeading') : t('receivedHeading')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {/* The colon (with the FR non-breaking space) lives in the i18n message, not hardcoded here. */}
          {t('orderNumberLabel')}{' '}
          <span className="font-medium text-foreground">{order.orderNumber}</span>
        </p>
        {!orderPaid && isProcessing ? (
          <p className="text-sm text-muted-foreground" data-testid="payment-processing">
            {redirect === 'processing' ? t('processingBody') : t('confirmingBody')}
          </p>
        ) : null}
      </div>

      <section aria-label={t('itemsLabel')} className="flex flex-col gap-2">
        <ul className="divide-y divide-border">
          {(order.items ?? []).map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-4 py-2 text-sm">
              <span className="text-foreground">
                {item.productTitle}
                {item.variantTitle ? ` — ${item.variantTitle}` : ''} × {item.quantity}
              </span>
              <span className="tabular-nums text-foreground">{price(item.lineTotalAmount)}</span>
            </li>
          ))}
        </ul>
      </section>

      <div className="flex items-center justify-between border-t border-border pt-3 text-base font-semibold text-foreground">
        <span>{t('totalLabel')}</span>
        <span className="tabular-nums" data-testid="order-total">
          {price(order.totalAmount)}
        </span>
      </div>

      {/* Receipt / order detail.
          - Authenticated: we can link to the order-detail page.
          - Guest: the token is tab-scoped sessionStorage; we show the "emailed receipt" note instead. */}
      {isAuthenticated && orderId ? (
        <Link
          href={`/account/orders/${orderId}`}
          className="self-start text-sm font-medium text-primary underline"
          data-testid="order-detail-link"
        >
          {t('viewReceipt')}
        </Link>
      ) : (
        <p className="self-start text-sm text-muted-foreground" data-testid="order-receipt-note">
          {t('guestReceiptNote')}
        </p>
      )}
    </div>
  );
}
