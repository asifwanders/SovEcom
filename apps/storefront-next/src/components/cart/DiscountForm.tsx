'use client';

/**
 * Discount-code apply/remove.
 * MONEY-CRITICAL: the applied discount's effect is the SERVER's `cart.totals.discountTotal` (rendered by
 * the totals panel) — this form NEVER computes a discount amount client-side.
 *
 * Apply  → `useCart().applyDiscount(code)`. The API returns 422 for an invalid/ineligible code; the cart
 *          is UNCHANGED on failure (the context only adopts the cart on success), so we surface a clear,
 *          non-destructive `role="alert"` error and leave the field for a retry.
 * Remove → `useCart().removeDiscount(code)` for the currently-applied `cart.discountCode`.
 *
 * State is driven off the AUTHORITATIVE cart: when `cart.discountCode` is set we show the applied code +
 * a remove control; otherwise the entry field. `SovEcomApiError.status === 422` is the "ineligible code"
 * branch (any other failure is a generic error). a11y: labelled input, `aria-busy` while pending, the
 * error is `role="alert"` and associated to the input via `aria-describedby`.
 */
import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { SovEcomApiError } from '@sovecom/client-js';
import { useCart } from '@/lib/cart-context';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';

export function DiscountForm(): React.ReactElement {
  const t = useTranslations('cart');
  const { cart, applyDiscount, removeDiscount } = useCart();
  const fieldId = useId();
  const errorId = `${fieldId}-error`;

  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const appliedCode = cart?.discountCode ?? null;

  async function onApply(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending) return;
    const trimmed = code.trim();
    if (trimmed === '') return;
    setError(null);
    setPending(true);
    try {
      await applyDiscount(trimmed);
      setCode(''); // success — the applied code now comes from the authoritative cart
    } catch (err) {
      // 422 = ineligible/invalid code (cart unchanged); anything else = a generic failure to retry.
      setError(
        err instanceof SovEcomApiError && err.status === 422
          ? t('discount.invalid')
          : t('discount.error'),
      );
    } finally {
      setPending(false);
    }
  }

  async function onRemove(): Promise<void> {
    if (pending || !appliedCode) return;
    setError(null);
    setPending(true);
    try {
      await removeDiscount(appliedCode);
    } catch {
      setError(t('discount.error'));
    } finally {
      setPending(false);
    }
  }

  if (appliedCode) {
    return (
      <div className="flex items-center justify-between gap-3" data-testid="discount-applied">
        <p className="text-sm text-foreground">{t('discount.applied', { code: appliedCode })}</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRemove}
          disabled={pending}
          aria-busy={pending}
        >
          {t('discount.remove')}
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form onSubmit={onApply} className="flex flex-col gap-2" aria-busy={pending}>
      <label htmlFor={fieldId} className="text-sm font-medium text-foreground">
        {t('discount.label')}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={fieldId}
          name="discountCode"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={pending}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          placeholder={t('discount.placeholder')}
        />
        <Button type="submit" variant="secondary" size="md" disabled={pending} aria-busy={pending}>
          {t('discount.apply')}
        </Button>
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
