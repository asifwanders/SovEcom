'use client';

/**
 * customer change-email form. AUTH/CREDENTIAL-CRITICAL.
 *
 * Drives the C3 verify-before-switch INITIATE endpoint `POST /store/v1/customers/me/email/change`
 * (authed). We call `createBrowserClient` DIRECTLY (mirroring RgpdExport) rather than through an
 * auth-context method, because initiate performs NO token/session swap — it only emails a verification
 * link to the proposed address; the actual swap happens later at the PUBLIC confirm step.
 *
 * NO-ORACLE at initiate: the endpoint returns a UNIFORM 202 whether the target was free OR already
 * taken — so this UI treats 202 identically ("check your new inbox"), and NEVER tries to detect "taken".
 *
 * STEP-UP 401 SEMANTICS (mirrors ChangePasswordForm/RgpdExport exactly): the endpoint runs the auth
 * guard THEN verifies the current password, timing-safe with an EMPTY 401 body (no oracle). A 401 almost
 * always means WRONG CURRENT PASSWORD or rate-limited, not token expiry — so we do NOT loop: refresh()
 * ONCE, retry ONCE, and on a second 401 (or refresh throwing) show the single "password incorrect or too
 * many attempts" message, never distinguishing wrong-password from rate-limit. A 400 means the proposed
 * address equals the current email (the only client-detectable initiate 400).
 *
 * SECURITY: the current password lives ONLY in React state, is never logged or persisted, and is cleared
 * after every NETWORK submit (success or error). It is INTENTIONALLY preserved across a client-side
 * validation failure (the early-returns below, before the network try/finally) so the user doesn't have
 * to re-type a valid password after merely fixing an email typo — matching ChangePasswordForm. The new
 * email is cleared only on SUCCESS (kept on error so the user can fix/retry). Client-side validation
 * (current-required + email shape) runs BEFORE the call.
 */
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { createBrowserClient } from '@/lib/browser-client';
import { AuthFormField } from '@/components/auth/AuthFormField';
import { Button } from '@/components/ui/Button';

/** Pragmatic email shape — the server stays the authoritative validator; this just cuts avoidable 400s. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ChangeState = 'idle' | 'submitting' | 'success' | 'stepUpError' | 'sameEmailError' | 'error';

export function ChangeEmailForm(): React.ReactElement {
  const t = useTranslations('account.email');
  const { getAccessToken, refresh, customer } = useAuth();
  const clientRef = useRef(createBrowserClient({ getAccessToken }));

  const [newEmail, setNewEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');

  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [state, setState] = useState<ChangeState>('idle');

  // The address the most-recent successful 202 was sent to — used for the success banner copy.
  const [sentTo, setSentTo] = useState('');
  // The in-flight pending change shown in the banner. Seeded from the profile on mount, then updated to
  // the new email immediately after a successful 202 (so it reflects without a profile reload).
  const [pending, setPending] = useState<string | null>(customer?.pendingEmail ?? null);

  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Move focus to the error/step-up banner once it mounts (WCAG 3.3.1 — mirrors ChangePasswordForm).
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state === 'stepUpError' || state === 'sameEmailError' || state === 'error') {
      errorRef.current?.focus();
    }
  }, [state]);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (state === 'submitting') return;

    // Client-side validation BEFORE any network call, focusing the FIRST invalid field. Order: the
    // current-password (step-up credential) is required first, then a valid email shape.
    if (currentPassword.trim() === '') {
      setPasswordError(t('errorRequiredCurrent'));
      setEmailError(null);
      passwordRef.current?.focus();
      return;
    }
    if (newEmail.trim() === '' || !EMAIL_RE.test(newEmail.trim())) {
      setPasswordError(null);
      setEmailError(t('errorInvalidEmail'));
      emailRef.current?.focus();
      return;
    }
    setEmailError(null);
    setPasswordError(null);

    // Snapshot for the request; the password is always cleared in `finally`.
    const email = newEmail.trim();
    const pw = currentPassword;
    setState('submitting');

    const attempt = (): Promise<void> =>
      clientRef.current.request<'/store/v1/customers/me/email/change', 'post', void>(
        'post',
        '/store/v1/customers/me/email/change',
        { body: { newEmail: email, currentPassword: pw } },
      );

    let succeeded = false;
    try {
      try {
        await attempt();
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status;
        // STEP-UP 401: refresh ONCE, retry ONCE. A second 401 (or refresh failing) → step-up message.
        // Never loop. Never oracle wrong-password vs rate-limit.
        if (status === 401) {
          try {
            await refresh();
          } catch {
            setState('stepUpError');
            return;
          }
          try {
            await attempt();
          } catch (retryErr: unknown) {
            const retryStatus = (retryErr as { status?: number })?.status;
            // A second 401 → step-up; a 400 on retry → same-email; anything else → generic.
            setState(
              retryStatus === 401
                ? 'stepUpError'
                : retryStatus === 400
                  ? 'sameEmailError'
                  : 'error',
            );
            return;
          }
        } else if (status === 400) {
          // The only client-detectable initiate 400: the proposed address equals the current email.
          setState('sameEmailError');
          return;
        } else {
          setState('error');
          return;
        }
      }
      // 202 — UNIFORM success (free OR already-taken; no oracle). Update the local pending banner so it
      // reflects immediately without a profile reload.
      succeeded = true;
      setSentTo(email);
      setPending(email);
      setState('success');
    } finally {
      // Always clear the password. Clear the new email only on SUCCESS (kept on error to fix/retry).
      setCurrentPassword('');
      if (succeeded) setNewEmail('');
    }
  }

  const submitting = state === 'submitting';

  return (
    <section className="flex flex-col gap-4" data-testid="change-email">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-xl font-bold text-foreground">{t('heading')}</h2>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>

      {/* Suppress the pending banner while the success banner is showing: both are role="status" and
          would otherwise double-announce the address, and "request a new link" is misleading right after
          a successful send. The pending state self-reasserts once `state` leaves 'success'. */}
      {pending && state !== 'success' ? (
        <p
          role="status"
          className="rounded-md border border-input bg-muted px-3 py-2 text-sm text-foreground"
          data-testid="change-email-pending"
        >
          {t('pendingNote', { pendingEmail: pending })}
        </p>
      ) : null}

      <form
        noValidate
        onSubmit={(e) => void onSubmit(e)}
        className="flex flex-col gap-4"
        aria-busy={submitting}
      >
        <AuthFormField
          id="change-email-new"
          ref={emailRef}
          label={t('newEmailLabel')}
          name="newEmail"
          type="email"
          autoComplete="email"
          maxLength={320}
          value={newEmail}
          error={emailError}
          disabled={submitting}
          onChange={(e) => {
            setNewEmail(e.target.value);
            if (emailError) setEmailError(null);
          }}
        />

        <AuthFormField
          id="change-email-password"
          ref={passwordRef}
          label={t('currentPasswordLabel')}
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          maxLength={1024}
          value={currentPassword}
          error={passwordError}
          disabled={submitting}
          onChange={(e) => {
            setCurrentPassword(e.target.value);
            if (passwordError) setPasswordError(null);
          }}
        />

        {state === 'success' ? (
          <p
            role="status"
            className="rounded-md border border-input bg-muted px-3 py-2 text-sm text-foreground"
            data-testid="change-email-success"
          >
            {t('success', { newEmail: sentTo })}
          </p>
        ) : null}

        {state === 'stepUpError' ? (
          <p
            ref={errorRef}
            tabIndex={-1}
            role="alert"
            className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="change-email-stepup-error"
          >
            {t('stepUpFailed')}
          </p>
        ) : null}

        {state === 'sameEmailError' ? (
          <p
            ref={errorRef}
            tabIndex={-1}
            role="alert"
            className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="change-email-same-error"
          >
            {t('sameEmailError')}
          </p>
        ) : null}

        {state === 'error' ? (
          <p
            ref={errorRef}
            tabIndex={-1}
            role="alert"
            className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="change-email-error"
          >
            {t('error')}
          </p>
        ) : null}

        <Button
          type="submit"
          variant="primary"
          size="md"
          disabled={submitting}
          aria-busy={submitting}
        >
          {submitting ? t('submitting') : t('button')}
        </Button>
      </form>
    </section>
  );
}
