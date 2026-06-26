'use client';

/**
 * customer account ERASE. MOST SECURITY-CRITICAL (irreversible PII erase).
 *
 * Two gates before the irreversible `POST /store/v1/customers/me/rgpd/erase`:
 *   Gate 1 — type-to-confirm: the customer must type their own email (shown) exactly; the Delete button
 *            stays disabled until it matches.
 *   Gate 2 — password step-up: the current password (same handling as the export step-up).
 *
 * On 204 the server has anonymised the customer, revoked all sessions and cleared the refresh cookie. We
 * then: markSigningOut() (so AccountGate does NOT bounce to /login when the session flips to guest) →
 * await logout() (drop the in-memory token + customer) → router.replace('/') (locale-aware) home.
 *
 * STEP-UP 401 SEMANTICS: a 401 here almost always means WRONG PASSWORD or rate-limited (5/60s), NOT token
 * expiry; the server is timing-safe with an empty body. So refresh() ONCE, retry ONCE; a second 401 (or
 * refresh failing) → the single "password incorrect or too many attempts" message (no loop, no oracle,
 * NO logout/redirect — the account still exists).
 *
 * A 404 means the account is already anonymised → treat as effectively done (logout + redirect home).
 *
 * The password lives ONLY in React state, is cleared after the request, and is never logged/persisted.
 */
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { createBrowserClient } from '@/lib/browser-client';
import { useRouter } from '@/i18n/navigation';
import { markSigningOut } from '@/lib/account-session';
import { eraseAccount } from '@/lib/rgpd';

type EraseState = 'idle' | 'deleting' | 'success' | 'stepUpError' | 'error';

export function RgpdErase(): React.ReactElement {
  const t = useTranslations('account.rgpd');
  const { customer, getAccessToken, refresh, logout } = useAuth();
  const router = useRouter();
  const clientRef = useRef(createBrowserClient({ getAccessToken }));

  const accountEmail = customer?.email ?? '';
  const [confirmEmail, setConfirmEmail] = useState('');
  const [password, setPassword] = useState('');
  const [state, setState] = useState<EraseState>('idle');

  // Move focus to the error/step-up banner once it mounts, so keyboard/SR users land on the problem
  // (WCAG 3.3.1 — mirrors the LoginForm error-focus pattern).
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state === 'stepUpError' || state === 'error') errorRef.current?.focus();
  }, [state]);

  // Gate 1: the account email is shown to the user, so a confirm-by-retyping is the bar. Compare
  // case-insensitively + trimmed on both sides (the server stores emails lowercased, but the user may
  // type different casing / stray whitespace).
  const normalize = (s: string): string => s.trim().toLowerCase();
  const emailMatches =
    confirmEmail.trim().length > 0 && normalize(confirmEmail) === normalize(accountEmail);
  const emailMismatch = confirmEmail.trim().length > 0 && !emailMatches;
  const deleting = state === 'deleting';
  // Both gates gate the button's enabled state: it stays disabled until the typed email matches (Gate 1)
  // AND a non-empty password is entered (Gate 2), and while a request is in flight. The in-onSubmit
  // re-check below is kept as defense-in-depth.
  const canDelete = emailMatches && password.trim().length > 0 && !deleting;

  /** Finalize a successful (or already-anonymised) erase: suppress the gate, drop session, go home. */
  async function finishErased(): Promise<void> {
    setState('success');
    markSigningOut();
    await logout();
    router.replace('/');
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    // Defense-in-depth: re-check both gates here even though the button is already gated on `canDelete`.
    if (!emailMatches || password.trim().length === 0 || deleting) return;

    const pw = password;
    setState('deleting');

    const attempt = (): Promise<void> => eraseAccount(clientRef.current, pw);

    try {
      try {
        await attempt();
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status;
        // 404 → already anonymised → effectively done.
        if (status === 404) {
          setPassword('');
          await finishErased();
          return;
        }
        // STEP-UP 401: refresh ONCE, retry ONCE. Never loop. NO logout/redirect — the account still exists.
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
            if (retryStatus === 404) {
              setPassword('');
              await finishErased();
              return;
            }
            setState(retryStatus === 401 ? 'stepUpError' : 'error');
            return;
          }
        } else {
          setState('error');
          return;
        }
      }
      // Success (204).
      setPassword('');
      await finishErased();
    } finally {
      // Belt-and-suspenders: never leave the secret in state on any path.
      setPassword('');
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="rgpd-erase">
      <h3 className="text-base font-semibold text-destructive">{t('erase.heading')}</h3>

      {/* Prominent irreversible warning + the French 10-year retention note. role="alert" (not "note",
          which has uneven SR support) so this safety-critical message is reliably announced. */}
      <div
        role="alert"
        data-testid="rgpd-erase-warning"
        className="flex flex-col gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        <p className="font-medium">{t('erase.description')}</p>
        <p className="text-foreground">{t('erase.legalRetentionNote')}</p>
      </div>

      <form
        noValidate
        onSubmit={(e) => void onSubmit(e)}
        className="flex flex-col gap-3"
        aria-busy={deleting}
      >
        {/* Gate 1 — type-to-confirm the account email */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="rgpd-erase-email" className="text-sm font-medium text-foreground">
            {t('erase.confirmEmailLabel')}
          </label>
          <p className="text-xs text-muted-foreground" data-testid="rgpd-erase-account-email">
            {accountEmail}
          </p>
          <input
            id="rgpd-erase-email"
            type="email"
            name="confirmEmail"
            autoComplete="off"
            value={confirmEmail}
            disabled={deleting}
            aria-invalid={emailMismatch || undefined}
            onChange={(e) => setConfirmEmail(e.target.value)}
            className="w-full max-w-sm rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          />
          {emailMismatch ? (
            <p className="text-xs text-destructive" data-testid="rgpd-erase-email-mismatch">
              {t('erase.confirmEmailMismatch')}
            </p>
          ) : null}
        </div>

        {/* Gate 2 — password step-up */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="rgpd-erase-password" className="text-sm font-medium text-foreground">
            {t('erase.passwordLabel')}
          </label>
          <input
            id="rgpd-erase-password"
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            disabled={deleting}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full max-w-sm rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          />
        </div>

        <button
          type="submit"
          disabled={!canDelete}
          aria-busy={deleting}
          className="inline-flex w-fit items-center rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {deleting ? t('erase.deleting') : t('erase.deleteButton')}
        </button>

        {state === 'success' ? (
          <p role="status" className="text-sm text-foreground" data-testid="rgpd-erase-success">
            {t('erase.success')}
          </p>
        ) : null}

        {state === 'stepUpError' ? (
          <p
            ref={errorRef}
            tabIndex={-1}
            role="alert"
            className="text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="rgpd-erase-stepup-error"
          >
            {t('stepUpFailed')}
          </p>
        ) : null}

        {state === 'error' ? (
          <p
            ref={errorRef}
            tabIndex={-1}
            role="alert"
            className="text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="rgpd-erase-error"
          >
            {t('erase.error')}
          </p>
        ) : null}
      </form>
    </div>
  );
}
