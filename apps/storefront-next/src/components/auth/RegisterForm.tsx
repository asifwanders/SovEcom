'use client';

/**
 * Customer registration form. MONEY/AUTH-CRITICAL.
 *
 * `'use client'` controlled form (NO Server Actions; NO new form dep) calling `useAuth().register`,
 * which is signup-then-auto-login. On full success the visitor is authenticated and redirected.
 *
 * PARTIAL-STATE: `register` throws a
 * single error whether the SIGNUP or the AUTO-LOGIN leg failed. `classifyRegisterError` disambiguates by
 * the API's distinct status codes:
 *   - signup 409 → duplicate email → a clear, non-leaky "already exists, sign in" message (no enumeration
 *     drama — it's the registration surface, where a dup-email signal is unavoidable and expected);
 *   - signup 400 → weak/common password → tell them to choose a stronger one;
 *   - login 401 (signup SUCCEEDED, auto-login failed) → "account created — please sign in", and route to
 *     login (so a transient login hiccup never strands the user on a misleading "registration failed").
 *
 * SECURITY: password is `type="password"` + `autocomplete="new-password"`; nothing is persisted
 * or logged. The min-12 length is mirrored client-side for a fast error (server is authoritative).
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter, Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/Button';
import { useTranslations } from 'next-intl';
import { AuthFormField } from './AuthFormField';
import { isValidEmail, MIN_PASSWORD_LENGTH, classifyRegisterError } from '@/lib/auth-form';

export function RegisterForm(): React.ReactElement {
  const t = useTranslations('auth');
  const router = useRouter();
  const { register } = useAuth();

  const formId = useId();
  const emailId = `${formId}-email`;
  const passwordId = `${formId}-password`;
  const nameId = `${formId}-name`;

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // WCAG 3.3.1 focus management: move focus to the first invalid field (validation) or to the
  // form-level error banner (server failure that stays on the page) so the problem is reachable.
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const formErrorRef = useRef<HTMLDivElement>(null);
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
    if (password.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(t('errorShortPassword'));
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
      await register({
        email: email.trim(),
        password,
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      // Full success → authenticated. Land on the home root (account area is 3.8b — see page note).
      router.replace('/');
    } catch (err) {
      const failure = classifyRegisterError(err);
      if (failure === 'account-created-sign-in') {
        // Signup succeeded, auto-login failed: route to login with the explanatory hint, NOT a generic
        // "registration failed".
        router.replace('/login?notice=account-created');
        return; // keep `pending` so the form stays disabled through the navigation
      }
      if (failure === 'duplicate') setFormError(t('register.duplicateEmail'));
      // weak-password (server 400): client already enforces min-12, so a 400 here is almost always the
      // breached-password check — surface the "choose a stronger one" message either way.
      else if (failure === 'weak-password') setFormError(t('register.weakPassword'));
      else setFormError(t('errorUnexpected'));
      setPending(false);
    }
  }

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4" aria-busy={pending}>
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
        id={nameId}
        label={t('nameLabel')}
        type="text"
        name="name"
        autoComplete="name"
        value={name}
        disabled={pending}
        onChange={(e) => setName(e.target.value)}
      />

      <AuthFormField
        id={passwordId}
        ref={passwordRef}
        label={t('passwordLabel')}
        type="password"
        name="password"
        autoComplete="new-password"
        minLength={MIN_PASSWORD_LENGTH}
        required
        value={password}
        error={passwordError}
        disabled={pending}
        onChange={(e) => setPassword(e.target.value)}
      />

      <Button type="submit" variant="primary" size="md" disabled={pending} aria-disabled={pending}>
        {pending ? t('register.submitting') : t('register.submit')}
      </Button>

      <p className="text-sm text-muted-foreground">
        {t('register.hasAccount')}{' '}
        <Link href="/login" className="font-medium text-foreground underline">
          {t('register.loginLink')}
        </Link>
      </p>
    </form>
  );
}
