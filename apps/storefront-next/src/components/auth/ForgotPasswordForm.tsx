'use client';

/**
 * customer forgot-password form. AUTH/CREDENTIAL-adjacent.
 *
 * UNAUTH page (logged-out users). Drives the PUBLIC `POST /store/v1/customers/forgot` (NO Bearer —
 * `createBrowserClient` with no token getter, exactly like EmailConfirmClient). The endpoint ALWAYS
 * returns 202 (uniform, enumeration-safe; also 429 on cap, treated as a generic error).
 *
 * NO-ORACLE: on success we show ONE fixed "if an account exists, check your inbox" banner —
 * shown REGARDLESS of whether the account exists. The component NEVER branches on the response, so the
 * page can never reveal account existence. Any error (incl. 429) collapses to a single generic message
 * that ALSO cannot leak existence.
 *
 * SECURITY: the email lives ONLY in React state (never logged/persisted) and is cleared on success.
 * Client-side validation (non-empty + email shape) runs BEFORE the round-trip to give inline feedback
 * and cut avoidable calls; the server is the authoritative validator.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { AuthFormField } from './AuthFormField';
import { Button } from '@/components/ui/Button';
import { createBrowserClient } from '@/lib/browser-client';
import { isValidEmail } from '@/lib/auth-form';

type ForgotState = 'idle' | 'submitting' | 'success' | 'error';

export function ForgotPasswordForm(): React.ReactElement {
  const t = useTranslations('auth');

  const fieldId = useId();
  const emailId = `${fieldId}-email`;

  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [state, setState] = useState<ForgotState>('idle');

  const emailRef = useRef<HTMLInputElement>(null);
  // Move focus to the error banner once it mounts (WCAG 3.3.1 — mirrors ChangePasswordForm).
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state === 'error') errorRef.current?.focus();
  }, [state]);

  // PUBLIC forgot — no token getter, so no Authorization header is attached.
  const clientRef = useRef(createBrowserClient());

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (state === 'submitting') return; // never double-submit

    const value = email.trim();
    // Client-side validation BEFORE any network call, focusing the field on failure.
    if (value === '') {
      setEmailError(t('errorRequiredEmail'));
      emailRef.current?.focus();
      return;
    }
    if (!isValidEmail(value)) {
      setEmailError(t('errorInvalidEmail'));
      emailRef.current?.focus();
      return;
    }
    setEmailError(null);
    setState('submitting');

    try {
      await clientRef.current.request<'/store/v1/customers/forgot', 'post', void>(
        'post',
        '/store/v1/customers/forgot',
        { body: { email: value } },
      );
      // 202 → uniform success. We NEVER branch on the response: the same banner shows whether or not
      // the account exists (no enumeration oracle). Clear the email field.
      setEmail('');
      setState('success');
    } catch {
      // Any error (incl. 429 cap) → a generic message that also cannot leak account existence.
      setState('error');
    }
  }

  const submitting = state === 'submitting';

  // On success, replace the whole form with ONLY the uniform banner + a back-to-sign-in link. Leaving
  // the (now-empty) form mounted would let a confused resubmit trip the "enter your email" validation
  // error (NIT-4). The banner text is FIXED and never varies by input — the no-oracle invariant holds.
  if (state === 'success') {
    return (
      <div className="flex flex-col gap-4" data-testid="forgot-password">
        <div
          role="status"
          className="rounded-md border border-input bg-muted px-3 py-2 text-sm text-foreground"
          data-testid="forgot-password-success"
        >
          {t('forgot.success')}
        </div>
        <p className="text-sm text-muted-foreground">
          <Link href="/login" className="font-medium text-foreground underline">
            {t('forgot.backToLogin')}
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form
      noValidate
      onSubmit={(e) => void onSubmit(e)}
      className="flex flex-col gap-4"
      aria-busy={submitting}
      data-testid="forgot-password"
    >
      {state === 'error' ? (
        <div
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="forgot-password-error"
        >
          {t('forgot.error')}
        </div>
      ) : null}

      <AuthFormField
        id={emailId}
        ref={emailRef}
        label={t('emailLabel')}
        type="email"
        name="email"
        autoComplete="email"
        inputMode="email"
        required
        value={email}
        error={emailError}
        disabled={submitting}
        onChange={(e) => {
          setEmail(e.target.value);
          if (emailError) setEmailError(null);
        }}
      />

      <Button
        type="submit"
        variant="primary"
        size="md"
        disabled={submitting}
        aria-busy={submitting}
      >
        {submitting ? t('forgot.submitting') : t('forgot.submit')}
      </Button>

      <p className="text-sm text-muted-foreground">
        <Link href="/login" className="font-medium text-foreground underline">
          {t('forgot.backToLogin')}
        </Link>
      </p>
    </form>
  );
}
