'use client';

/**
 * B2B VAT number + reverse-charge display. MONEY/TAX-CRITICAL but does NO client tax math.
 *
 * VAT lives on the CUSTOMER profile (there is no cart VAT endpoint): entering a number calls
 * `useAuth().updateVatNumber` → `PATCH /store/v1/customers/me`, which re-runs VIES server-side. We then
 * call `useCart.recomputeTotals` — NOT a plain `refresh`: `GET /carts` only LOADS the cart and does NOT
 * re-run the server tax engine, so the displayed totals would go STALE after the VAT change.
 * `recomputeTotals` re-POSTs the cart's current real shipping address, forcing a server recompute that
 * reads the LIVE customer VAT and adopts the fresh authoritative totals (the server zeroes the tax +
 * sets `totals.reverseCharge` when cross-border-EU B2B reverse charge applies). The reverse-charge note
 * is shown ONLY when the server actually applied it (reads the customer's VIES-validated B2B flags + the
 * server's authoritative `totals.reverseCharge` flag) — the UI NEVER computes the tax nor infers it
 * from `taxTotal === 0`.
 *
 * Guests / non-B2B customers don't see this (reverse-charge is an authenticated B2B feature). a11y:
 * labelled field, `role="status"` for the reverse-charge confirmation, `role="alert"` for errors.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { useCart } from '@/lib/cart-context';
import { shouldShowReverseCharge } from '@/lib/checkout-form';
import { AuthFormField } from '@/components/auth/AuthFormField';
import { Button } from '@/components/ui/Button';

export function CheckoutVat(): React.ReactElement | null {
  const t = useTranslations('checkout');
  const { customer, isAuthenticated, updateVatNumber } = useAuth();
  const { cart, recomputeTotals } = useCart();
  const fieldId = useId();

  const [vat, setVat] = useState(customer?.vatNumber ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const vatRef = useRef<HTMLInputElement>(null);

  // Keep the field in sync if the profile's VAT changes underneath (e.g. an initial profile load).
  useEffect(() => {
    setVat(customer?.vatNumber ?? '');
  }, [customer?.vatNumber]);

  // Only B2B customers see the VAT entry (reverse-charge is a B2B feature). Non-B2B / guests: render nothing.
  if (!isAuthenticated || !customer?.isB2b) return null;

  const reverseCharge = shouldShowReverseCharge(customer, cart);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending) return;
    const trimmed = vat.trim();
    if (trimmed === '') {
      setError(t('vat.required'));
      vatRef.current?.focus();
      return;
    }
    setError(null);
    setPending(true);
    try {
      // PATCH the profile (server re-runs VIES), then FORCE a server tax recompute so the authoritative
      // totals (reverse-charge → taxTotal 0 + reverseCharge flag) are adopted. A plain refresh() GET would
      // leave them STALE (it doesn't re-run the tax engine). NO client tax math.
      await updateVatNumber(trimmed);
      await recomputeTotals();
    } catch {
      setError(t('vat.error'));
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby={`${fieldId}-heading`} className="flex flex-col gap-3">
      <h3 id={`${fieldId}-heading`} className="text-sm font-semibold text-foreground">
        {t('vat.heading')}
      </h3>
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-2" aria-busy={pending}>
        <AuthFormField
          id={`${fieldId}-vat`}
          ref={vatRef}
          label={t('vat.label')}
          name="vatNumber"
          autoComplete="off"
          value={vat}
          error={error}
          disabled={pending}
          onChange={(e) => setVat(e.target.value)}
        />
        <Button type="submit" variant="secondary" size="md" disabled={pending} aria-busy={pending}>
          {pending ? t('vat.checking') : t('vat.apply')}
        </Button>
      </form>

      {reverseCharge ? (
        <p
          role="status"
          data-testid="reverse-charge"
          className="rounded-md border border-input bg-muted px-3 py-2 text-sm text-foreground"
        >
          {t('vat.reverseCharge')}
        </p>
      ) : customer.vatNumber && !customer.vatValidated ? (
        // The number is on file but VIES did not validate it → VAT is charged (fail-safe). Tell the user.
        <p role="status" className="text-sm text-muted-foreground" data-testid="vat-unvalidated">
          {t('vat.unvalidated')}
        </p>
      ) : null}
    </section>
  );
}
