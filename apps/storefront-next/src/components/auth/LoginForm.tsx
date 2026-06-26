'use client';

/**
 * Customer login form. MONEY/AUTH-CRITICAL.
 *
 * A `'use client'` controlled form (NO Server Actions; NO new form dep — the storefront
 * has none, so a minimal controlled form + inline validation is the convention here) calling
 * `useAuth().login`. On success it redirects to the post-login destination.
 *
 * SECURITY:
 *   - Enumeration-safe: ANY login failure (bad email, wrong password, throttle, transient) collapses to
 *     ONE generic "invalid email or password" — the page NEVER distinguishes "no such user" from
 *     "wrong password" (the API already returns a uniform 401; we keep the UI uniform too).
 *   - The password input is `type="password"` with `autocomplete="current-password"`; neither field is
 *     persisted to storage or logged — values live only in React state for this render.
 *   - The post-login redirect target is validated to a same-origin, locale-relative path (`returnTo`
 *     must be an internal `/…` path; external/`//`/`javascript:` are ignored) to prevent open-redirect.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter, Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/Button';
import { useTranslations } from 'next-intl';
import { AuthFormField } from './AuthFormField';
import { isValidEmail, safeReturnTo } from '@/lib/auth-form';

export function LoginForm({
  returnTo,
  notice,
}: {
  returnTo?: string;
  /** A non-error notice to surface (e.g. `account-created` after a register partial-state redirect). */
  notice?: 'account-created';
}): React.ReactElement {
  const t = useTranslations('auth');
  const router = useRouter();
  const { login } = useAuth();

  const formId = useId();
  const emailId = `${formId}-email`;
  const passwordId = `${formId}-password`;

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  // A single, GENERIC form-level error (enumeration-safe — never field-specific on a failed login).
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Refs for WCAG 3.3.1 focus management: move focus to the first invalid field (validation) or to the
  // form-level error banner (credentials/unexpected failure) so keyboard/SR users land on the problem.
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const formErrorRef = useRef<HTMLDivElement>(null);
  // The banner mounts only after `formError` is set, so focus it in an effect once it exists.
  useEffect(() => {
    if (formError) formErrorRef.current?.focus();
  }, [formError]);

  function validate(): boolean {
    let ok = true;
    if (email.trim() === '') {
      setEmailError(t('errorRequiredEmail'));
      ok = false;
    } else if (!isValidEmail(email)) {
      setEmailError(t('errorInvalidEmail'));
      ok = false;
    } else {
      setEmailError(null);
    }
    if (password === '') {
      setPasswordError(t('errorRequiredPassword'));
      ok = false;
    } else {
      setPasswordError(null);
    }
    return ok;
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending) return; // never double-submit
    setFormError(null);
    if (!validate()) {
      // Focus the FIRST invalid field (email before password) — the inputs are already mounted.
      if (email.trim() === '' || !isValidEmail(email)) emailRef.current?.focus();
      else passwordRef.current?.focus();
      return;
    }
    setPending(true);
    try {
      await login(email.trim(), password);
      // Success → leave the auth page. Internal, validated path only (open-redirect-safe).
      router.replace(safeReturnTo(returnTo) ?? '/');
    } catch {
      // Enumeration-safe: collapse EVERY failure to the generic message; never reveal which field.
      // The effect above moves focus to the banner once it renders.
      setFormError(t('login.invalidCredentials'));
      setPending(false);
    }
  }

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4" aria-busy={pending}>
      {notice === 'account-created' ? (
        <div
          role="status"
          className="rounded-md border border-input bg-muted px-3 py-2 text-sm text-foreground"
        >
          {t('register.accountCreatedSignIn')}
        </div>
      ) : null}
      {formError ? (
        <div
          ref={formErrorRef}
          tabIndex={-1}
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {formError}
        </div>
      ) : null}

      <AuthFormField
        id={emailId}
        ref={emailRef}
        label={t('emailLabel')}
        type="email"
        name="email"
        autoComplete="username"
        inputMode="email"
        required
        value={email}
        error={emailError}
        disabled={pending}
        onChange={(e) => setEmail(e.target.value)}
      />

      <AuthFormField
        id={passwordId}
        ref={passwordRef}
        label={t('passwordLabel')}
        type="password"
        name="password"
        autoComplete="current-password"
        required
        value={password}
        error={passwordError}
        disabled={pending}
        onChange={(e) => setPassword(e.target.value)}
      />

      <Button type="submit" variant="primary" size="md" disabled={pending} aria-disabled={pending}>
        {pending ? t('login.submitting') : t('login.submit')}
      </Button>

      <p className="text-sm text-muted-foreground">
        {t('login.noAccount')}{' '}
        <Link href="/register" className="font-medium text-foreground underline">
          {t('login.registerLink')}
        </Link>
      </p>

      <p className="text-sm text-muted-foreground">
        <Link href="/forgot" className="font-medium text-foreground underline">
          {t('login.forgotLink')}
        </Link>
      </p>
    </form>
  );
}
