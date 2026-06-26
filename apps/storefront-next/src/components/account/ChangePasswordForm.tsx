'use client';

/**
 * customer change-password form. AUTH/CREDENTIAL-CRITICAL.
 *
 * Drives `POST /store/v1/customers/me/password` (via `useAuth().changePassword`). On success the auth
 * context has ALREADY swapped in the fresh access token the endpoint returned, so THIS session survives
 * the "log out everywhere" the endpoint performs — this component does no extra session work, it just
 * shows success and clears the fields.
 *
 * STEP-UP 401 SEMANTICS (mirrors RgpdExport exactly): the endpoint runs the auth guard THEN verifies the
 * current password, and is timing-safe with an EMPTY 401 body (no oracle). A 401 almost always means
 * WRONG CURRENT PASSWORD or rate-limited (5/60s), not token expiry — so we do NOT loop: refresh() ONCE,
 * retry ONCE, and on a second 401 (or refresh throwing) show the single "password incorrect or too many
 * attempts" message, never distinguishing wrong-password from rate-limit. A 400 means the NEW password
 * was rejected server-side as weak/breached (min-12 is already enforced client-side below).
 *
 * SECURITY: all three passwords live ONLY in React state, are cleared after EVERY submit (success or
 * error), and are never logged or persisted. Client-side validation (current-required + new min-12 /
 * max-1024 + confirm-match) runs BEFORE the API call to cut avoidable 400s and give inline field-level
 * feedback. The order matches the DTO bounds; the server stays the authoritative validator.
 */
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { AuthFormField } from '@/components/auth/AuthFormField';
import { Button } from '@/components/ui/Button';

/** Mirrors the DTO bounds (min 12 / max 1024). The server enforces the authoritative breached-password
 * denylist; these client checks just cut avoidable round-trips and give inline field-level feedback. */
const MIN_NEW_PASSWORD_LENGTH = 12;
const MAX_NEW_PASSWORD_LENGTH = 1024;

type ChangeState = 'idle' | 'submitting' | 'success' | 'stepUpError' | 'weakError' | 'error';

export function ChangePasswordForm(): React.ReactElement {
  const t = useTranslations('account.security');
  const { changePassword, refresh } = useAuth();

  const [current, setCurrent] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirm, setConfirm] = useState('');

  const [currentError, setCurrentError] = useState<string | null>(null);
  const [newError, setNewError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [state, setState] = useState<ChangeState>('idle');

  const currentRef = useRef<HTMLInputElement>(null);
  const newRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  // Move focus to the error/step-up banner once it mounts (WCAG 3.3.1 — mirrors RgpdExport).
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state === 'stepUpError' || state === 'weakError' || state === 'error') {
      errorRef.current?.focus();
    }
  }, [state]);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (state === 'submitting') return;

    // Client-side validation BEFORE any network call, focusing the FIRST invalid field. Order mirrors
    // the DTO: current-required → new-min-12 → new-max-1024 → confirm-match.
    if (current.trim() === '') {
      setCurrentError(t('errorRequiredCurrent'));
      setNewError(null);
      setConfirmError(null);
      currentRef.current?.focus();
      return;
    }
    if (newPw.length < MIN_NEW_PASSWORD_LENGTH) {
      setCurrentError(null);
      setNewError(t('errorTooShort'));
      setConfirmError(null);
      newRef.current?.focus();
      return;
    }
    if (newPw.length > MAX_NEW_PASSWORD_LENGTH) {
      setCurrentError(null);
      setNewError(t('errorTooLong'));
      setConfirmError(null);
      newRef.current?.focus();
      return;
    }
    if (confirm !== newPw) {
      setCurrentError(null);
      setNewError(null);
      setConfirmError(t('errorMismatch'));
      confirmRef.current?.focus();
      return;
    }
    setCurrentError(null);
    setNewError(null);
    setConfirmError(null);

    // Snapshot the secrets for the request, then we always clear state in `finally`.
    const cur = current;
    const next = newPw;
    setState('submitting');

    const attempt = (): Promise<void> => changePassword(cur, next);

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
            // A second 401 → step-up; a 400 on retry → weak password; anything else → generic.
            setState(
              retryStatus === 401 ? 'stepUpError' : retryStatus === 400 ? 'weakError' : 'error',
            );
            return;
          }
        } else if (status === 400) {
          // The NEW password was rejected server-side (breached/too common) — min-12 already passed.
          setState('weakError');
          return;
        } else {
          setState('error');
          return;
        }
      }
      // Success — the token swap already happened inside changePassword; the session survives.
      setState('success');
    } finally {
      // Clear ALL THREE secrets regardless of outcome — never keep a password around.
      setCurrent('');
      setNewPw('');
      setConfirm('');
    }
  }

  const submitting = state === 'submitting';

  return (
    <section className="flex flex-col gap-4" data-testid="change-password">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-xl font-bold text-foreground">{t('changePasswordHeading')}</h2>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>

      <form
        noValidate
        onSubmit={(e) => void onSubmit(e)}
        className="flex flex-col gap-4"
        aria-busy={submitting}
      >
        <AuthFormField
          id="security-current-password"
          ref={currentRef}
          label={t('currentPasswordLabel')}
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          value={current}
          error={currentError}
          disabled={submitting}
          onChange={(e) => {
            setCurrent(e.target.value);
            if (currentError) setCurrentError(null);
          }}
        />

        <AuthFormField
          id="security-new-password"
          ref={newRef}
          label={t('newPasswordLabel')}
          name="newPassword"
          type="password"
          autoComplete="new-password"
          maxLength={MAX_NEW_PASSWORD_LENGTH}
          value={newPw}
          error={newError}
          disabled={submitting}
          onChange={(e) => {
            setNewPw(e.target.value);
            if (newError) setNewError(null);
          }}
        />

        <AuthFormField
          id="security-confirm-password"
          ref={confirmRef}
          label={t('confirmPasswordLabel')}
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          maxLength={MAX_NEW_PASSWORD_LENGTH}
          value={confirm}
          error={confirmError}
          disabled={submitting}
          onChange={(e) => {
            setConfirm(e.target.value);
            if (confirmError) setConfirmError(null);
          }}
        />

        {state === 'success' ? (
          <p
            role="status"
            className="rounded-md border border-input bg-muted px-3 py-2 text-sm text-foreground"
            data-testid="change-password-success"
          >
            {t('success')}
          </p>
        ) : null}

        {state === 'stepUpError' ? (
          <p
            ref={errorRef}
            tabIndex={-1}
            role="alert"
            className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="change-password-stepup-error"
          >
            {t('stepUpFailed')}
          </p>
        ) : null}

        {state === 'weakError' ? (
          <p
            ref={errorRef}
            tabIndex={-1}
            role="alert"
            className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="change-password-weak-error"
          >
            {t('errorWeak')}
          </p>
        ) : null}

        {state === 'error' ? (
          <p
            ref={errorRef}
            tabIndex={-1}
            role="alert"
            className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="change-password-error"
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
