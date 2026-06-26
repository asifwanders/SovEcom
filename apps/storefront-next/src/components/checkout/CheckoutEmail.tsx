'use client';

/**
 * checkout step 1: email (guest checkout email entry or login). AUTH/PII surface.
 *
 * Two paths:
 *   - LOGGED-IN: the customer's account email is shown read-only; "Continue" associates the customer with
 *     the cart (so the server's tax/B2B context applies) and advances. No email typing needed.
 *   - GUEST: an email field → `useCart().setEmail(email)` sets the guest email on the cart, then advances.
 *     A link offers logging in instead (bounces to `/login?returnTo=/checkout` with open-redirect-safe
 *     handling).
 *
 * The email is set on the SERVER cart (never localStorage). a11y: labelled field, `role="alert"` errors
 * associated via `aria-describedby`, focus moved to the first error.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth-context';
import { useCart } from '@/lib/cart-context';
import { isValidEmail } from '@/lib/auth-form';
import { AuthFormField } from '@/components/auth/AuthFormField';
import { Button } from '@/components/ui/Button';

export function CheckoutEmail({ onDone }: { onDone: () => void }): React.ReactElement {
  const t = useTranslations('checkout');
  const { customer, isAuthenticated } = useAuth();
  const { cart, setEmail, associateCustomer } = useCart();

  const fieldId = useId();
  const [email, setEmailValue] = useState(cart?.guestEmail ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  // When the (already-known) customer continues we associate + advance. For a guest we capture the email.
  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending) return;
    setError(null);

    if (isAuthenticated) {
      setPending(true);
      try {
        // Link the customer to the cart so server-side B2B/tax context (and the guest→customer merge)
        // applies. Idempotent — safe if already associated.
        await associateCustomer();
        onDone();
      } catch {
        setError(t('email.error'));
        setPending(false);
      }
      return;
    }

    const trimmed = email.trim();
    if (trimmed === '' || !isValidEmail(trimmed)) {
      setError(t('email.invalid'));
      emailRef.current?.focus();
      return;
    }
    setPending(true);
    try {
      await setEmail(trimmed);
      onDone();
    } catch {
      setError(t('email.error'));
      setPending(false);
    }
  }

  // Move focus to the error region when it appears (WCAG 3.3.1).
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error && isAuthenticated) errorRef.current?.focus();
  }, [error, isAuthenticated]);

  if (isAuthenticated && customer) {
    return (
      <form onSubmit={onSubmit} className="flex flex-col gap-4" aria-busy={pending}>
        <p className="text-sm text-foreground">
          {t('email.loggedInAs')} <strong>{customer.email}</strong>
        </p>
        {error ? (
          <p ref={errorRef} tabIndex={-1} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          size="md"
          disabled={pending}
          aria-disabled={pending}
        >
          {pending ? t('continuing') : t('continue')}
        </Button>
      </form>
    );
  }

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4" aria-busy={pending}>
      <AuthFormField
        id={`${fieldId}-email`}
        ref={emailRef}
        label={t('email.label')}
        type="email"
        name="email"
        autoComplete="email"
        inputMode="email"
        required
        value={email}
        error={error}
        disabled={pending}
        onChange={(e) => setEmailValue(e.target.value)}
      />
      <Button type="submit" variant="primary" size="md" disabled={pending} aria-disabled={pending}>
        {pending ? t('continuing') : t('continue')}
      </Button>
      <p className="text-sm text-muted-foreground">
        {t('email.haveAccount')}{' '}
        <Link
          href={{ pathname: '/login', query: { returnTo: '/checkout' } }}
          className="font-medium text-foreground underline"
        >
          {t('email.loginLink')}
        </Link>
      </p>
    </form>
  );
}
