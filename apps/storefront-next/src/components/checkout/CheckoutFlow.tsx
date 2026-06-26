'use client';

/**
 * checkout step controller. Client multi-step orchestration (email → address → shipping → review)
 * up to (NOT including) payment; the cart is server-authoritative, the step is client state.
 *
 * State + guards:
 *   - The active step is client state, kept consistent with the cart: on mount we refresh the cart, then
 *     CLAMP the step to the furthest one the cart prerequisites allow (`furthestReachableStep`) — so a
 *     reload/deep-link can't land on a step whose prerequisites aren't met (e.g. review without a chosen
 *     rate). Back-nav is always allowed to any already-satisfied earlier step.
 *   - `hasEmail` = a guest email on the cart OR an authenticated customer (their account email) — the
 *     guard for leaving the email step.
 *   - Forward motion happens only via a step's own `onDone` (which mutated the cart first), so a step can
 *     never be skipped without its server-side prerequisite being set.
 *
 * Empty cart → a friendly state with a link back to the cart (you can't check out nothing).
 * Payment step: the review's "Proceed to payment" calls `onProceed`, which advances to the `payment`
 * step rendering the Stripe Payment Element (`CheckoutPayment`, wired below). The order is
 * created AT the payment step (`/checkout` → `/payment-intent`), not before.
 *
 * a11y: an ordered, `aria-current`-marked progress list; each step is a labelled region; on a step change
 * focus moves to the step heading so keyboard/SR users are taken to the new content (WCAG 2.4.3 / 3.2.x).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth-context';
import { useCart } from '@/lib/cart-context';
import {
  CHECKOUT_STEPS,
  canReachStep,
  furthestReachableStep,
  stepIndex,
  type CheckoutStep,
} from '@/lib/checkout-form';
import { CheckoutEmail } from './CheckoutEmail';
import { CheckoutAddress } from './CheckoutAddress';
import { CheckoutShipping } from './CheckoutShipping';
import { CheckoutReview } from './CheckoutReview';
import { CheckoutPayment } from './CheckoutPayment';

export function CheckoutFlow(): React.ReactElement {
  const t = useTranslations('checkout');
  const locale = useLocale();
  const { isAuthenticated } = useAuth();
  const { cart, refresh } = useCart();

  const [step, setStep] = useState<CheckoutStep>('email');
  const [ready, setReady] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // `hasEmail`: the email-step guard — a guest email on the cart OR a logged-in customer.
  const hasEmail = isAuthenticated || (cart?.guestEmail ?? null) !== null;

  // Mount: re-read the authoritative cart (deep-link/reload starts with empty context), then clamp the
  // step to the furthest reachable one. We DON'T jump the user forward past where they were if they were
  // already on an earlier step — but we never leave them on an unreachable later step.
  const initedRef = useRef(false);
  useEffect(() => {
    if (initedRef.current) return;
    initedRef.current = true;
    void refresh()
      .catch(() => {})
      .finally(() => setReady(true));
  }, [refresh]);

  // Clamp: if the current step became unreachable (cart changed), fall back to the furthest reachable.
  useEffect(() => {
    if (!ready) return;
    if (!canReachStep(step, cart, hasEmail)) {
      setStep(furthestReachableStep(cart, hasEmail));
    }
  }, [ready, step, cart, hasEmail]);

  // Move focus to the step heading on every step change (WCAG 2.4.3).
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const advance = useCallback((to: CheckoutStep) => {
    setStep(to);
  }, []);

  const goBack = useCallback(
    (to: CheckoutStep) => {
      // Back-nav only to an earlier, already-reachable step.
      if (stepIndex(to) < stepIndex(step) && canReachStep(to, cart, hasEmail)) setStep(to);
    },
    [step, cart, hasEmail],
  );

  const onProceedToPayment = useCallback(() => {
    // Chunk-F boundary: advance to the Stripe Payment Element step. The order is created AT the payment
    // step (POST /checkout + /payment-intent), not here — review just gates the transition. The `payment`
    // step is only reachable with email + a REAL (non-placeholder) address + a chosen rate (canReachStep),
    // so a placeholder address can never reach a created order.
    setStep('payment');
  }, []);

  const items = cart?.items ?? [];
  if (ready && items.length === 0) {
    return (
      <div
        className="flex flex-col items-center gap-4 py-16 text-center"
        data-testid="checkout-empty"
      >
        <p className="text-base text-muted-foreground">{t('empty')}</p>
        <Link href="/cart" className="text-sm font-medium text-primary underline">
          {t('backToCart')}
        </Link>
      </div>
    );
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
      <div className="flex flex-col gap-6">
        {/* Progress — an ordered list; the active step carries aria-current. */}
        <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label={t('progressLabel')}>
          {CHECKOUT_STEPS.map((s, i) => {
            const isActive = s === step;
            const reachable = canReachStep(s, cart, hasEmail);
            const done = stepIndex(s) < stepIndex(step);
            return (
              <li key={s}>
                <button
                  type="button"
                  onClick={() => goBack(s)}
                  disabled={!done || !reachable}
                  aria-current={isActive ? 'step' : undefined}
                  className={`${isActive ? 'font-semibold text-foreground' : 'text-muted-foreground'} underline-offset-2 enabled:hover:underline disabled:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
                >
                  {i + 1}. {t(`steps.${s}`)}
                </button>
              </li>
            );
          })}
        </ol>

        <section aria-labelledby="checkout-step-heading" className="flex flex-col gap-4">
          <h2
            id="checkout-step-heading"
            ref={headingRef}
            tabIndex={-1}
            className="text-lg font-semibold text-foreground focus-visible:outline-none"
          >
            {t(`steps.${step}`)}
          </h2>

          {step === 'email' ? <CheckoutEmail onDone={() => advance('address')} /> : null}
          {step === 'address' ? <CheckoutAddress onDone={() => advance('shipping')} /> : null}
          {step === 'shipping' ? (
            <CheckoutShipping onDone={() => advance('review')} locale={locale} />
          ) : null}
          {step === 'review' ? (
            <CheckoutReview onProceed={onProceedToPayment} locale={locale} />
          ) : null}
          {step === 'payment' ? <CheckoutPayment /> : null}

          {step !== 'email' ? (
            <button
              type="button"
              onClick={() => {
                const prev = CHECKOUT_STEPS[stepIndex(step) - 1];
                if (prev) goBack(prev);
              }}
              className="self-start text-sm text-muted-foreground underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('back')}
            </button>
          ) : null}
        </section>
      </div>
    </div>
  );
}
