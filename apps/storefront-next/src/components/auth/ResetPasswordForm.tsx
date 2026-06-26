'use client';

/**
 * customer reset-password form. AUTH/CREDENTIAL-CRITICAL.
 *
 * UNAUTH page (logged-out users). Reads the one-time `token` from the query (`useSearchParams`) and
 * drives the PUBLIC `POST /store/v1/customers/reset` (NO Bearer — `createBrowserClient` with no token
 * getter, like EmailConfirmClient). A 204 logs out ALL sessions server-side, so there is no token to
 * swap here — we just show success and point to sign-in.
 *
 * COMBINED 400 MESSAGE: the API does NOT distinguish an invalid/expired/used token from a weak/breached
 * new password — both return 400 (and client-side validation already caught length/match below). So a
 * 400 maps to ONE honest combined message: "the link may have expired, or your new password is too
 * common. Request a new link or try a different password." Anything else (incl. 429) → generic error.
 *
 * SECURITY: the token is read for the request only and is NEVER rendered to the DOM or stored in state
 * beyond `useSearchParams`. A missing/empty token short-circuits to an `invalidLink` state WITHOUT the
 * form or any API call (no wasted round-trip). Both password fields live ONLY in React state, are
 * cleared in `finally` after EVERY submit (success or error), and are never logged/persisted.
 */
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { AuthFormField } from './AuthFormField';
import { Button } from '@/components/ui/Button';
import { createBrowserClient } from '@/lib/browser-client';

/** Mirrors the DTO bounds (min 12 / max 1024). The server enforces the authoritative breached-password
 * denylist; these client checks just cut avoidable round-trips and give inline field-level feedback. */
const MIN_NEW_PASSWORD_LENGTH = 12;
const MAX_NEW_PASSWORD_LENGTH = 1024;

type ResetState = 'idle' | 'submitting' | 'success' | 'resetError' | 'error';

export function ResetPasswordForm(): React.ReactElement {
  const t = useTranslations('auth');
  const params = useSearchParams();
  const token = params.get('token');
  const hasToken = token !== null && token.trim() !== '';

  const [newPw, setNewPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [newError, setNewError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [state, setState] = useState<ResetState>('idle');

  const newRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  // Move focus to whichever terminal banner mounts — error OR success (WCAG 3.3.1). On success the form
  // unmounts and is replaced by the success <p>, so without this focus would fall to <body>; we focus
  // the success message too. Exactly one of the three banners renders at a time, so one ref suffices.
  const focusRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state === 'resetError' || state === 'error' || state === 'success') {
      focusRef.current?.focus();
    }
  }, [state]);

  // PUBLIC reset — no token getter, so no Authorization header is attached.
  const clientRef = useRef(createBrowserClient());

  // Missing/empty token → invalid-link state immediately, NO form and NO API call.
  if (!hasToken) {
    return (
      <div className="flex flex-col gap-3" data-testid="reset-password">
        <p role="alert" className="text-sm text-destructive">
          {t('reset.invalidLink')}
        </p>
        <Link href="/forgot" className="self-start text-sm font-medium text-foreground underline">
          {t('reset.requestNewLink')}
        </Link>
      </div>
    );
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (state === 'submitting') return; // never double-submit

    // Client-side validation BEFORE any network call, focusing the FIRST invalid field. Order mirrors
    // the DTO: new-min-12 → new-max-1024 → confirm-match.
    if (newPw.length < MIN_NEW_PASSWORD_LENGTH) {
      setNewError(t('reset.errorTooShort'));
      setConfirmError(null);
      newRef.current?.focus();
      return;
    }
    if (newPw.length > MAX_NEW_PASSWORD_LENGTH) {
      setNewError(t('reset.errorTooLong'));
      setConfirmError(null);
      newRef.current?.focus();
      return;
    }
    if (confirm !== newPw) {
      setNewError(null);
      setConfirmError(t('reset.errorMismatch'));
      confirmRef.current?.focus();
      return;
    }
    setNewError(null);
    setConfirmError(null);

    // Snapshot the secret for the request; we always clear the fields in `finally`.
    const next = newPw;
    setState('submitting');

    try {
      await clientRef.current.request<'/store/v1/customers/reset', 'post', void>(
        'post',
        '/store/v1/customers/reset',
        { body: { token: token as string, newPassword: next } },
      );
      // 204 → success. All sessions were logged out server-side; nothing to swap here.
      setState('success');
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      // 400 cannot distinguish expired-token from breached-password (client validation caught length/
      // match) → ONE honest combined message. Anything else (incl. 429) → generic.
      setState(status === 400 ? 'resetError' : 'error');
    } finally {
      // Clear BOTH secrets regardless of outcome — never keep a password around.
      setNewPw('');
      setConfirm('');
    }
  }

  const submitting = state === 'submitting';

  if (state === 'success') {
    return (
      <div className="flex flex-col gap-3" data-testid="reset-password">
        <p
          ref={focusRef}
          tabIndex={-1}
          role="status"
          className="text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="reset-password-success"
        >
          {t('reset.success')}
        </p>
        <Link href="/login" className="self-start text-sm font-medium text-foreground underline">
          {t('reset.backToLogin')}
        </Link>
      </div>
    );
  }

  return (
    <form
      noValidate
      onSubmit={(e) => void onSubmit(e)}
      className="flex flex-col gap-4"
      aria-busy={submitting}
      data-testid="reset-password"
    >
      <AuthFormField
        id="reset-new-password"
        ref={newRef}
        label={t('reset.newPasswordLabel')}
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
        id="reset-confirm-password"
        ref={confirmRef}
        label={t('reset.confirmPasswordLabel')}
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

      {state === 'resetError' ? (
        <p
          ref={focusRef}
          tabIndex={-1}
          role="alert"
          className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="reset-password-error"
        >
          {t('reset.resetError')}
        </p>
      ) : null}

      {state === 'error' ? (
        <p
          ref={focusRef}
          tabIndex={-1}
          role="alert"
          className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="reset-password-generic-error"
        >
          {t('reset.error')}
        </p>
      ) : null}

      <Button
        type="submit"
        variant="primary"
        size="md"
        disabled={submitting}
        aria-busy={submitting}
      >
        {submitting ? t('reset.submitting') : t('reset.submit')}
      </Button>
    </form>
  );
}
