'use client';

/**
 * customer RGPD data EXPORT. SECURITY-CRITICAL (PII + password step-up).
 *
 * Asks for the current password (step-up) and POSTs it (in the BODY) to
 * `POST /store/v1/customers/me/rgpd/export` (CustomerAuthGuard + server password verify). On success the
 * 200 JSON `RgpdExport` is turned into a downloadable file — it is NEVER rendered to the DOM (it is PII);
 * the UI shows only a "download started" message.
 *
 * STEP-UP 401 SEMANTICS (different from other chunks): both RGPD endpoints run the auth guard THEN verify
 * the password. A 401 here almost always means WRONG PASSWORD or rate-limited (5/60s), NOT token expiry,
 * and the server is timing-safe with an EMPTY body (no oracle). So we do NOT loop on 401: refresh() ONCE,
 * retry ONCE, and on a second 401 (or refresh throwing / yielding nothing) show the single
 * "password incorrect or too many attempts" message — never distinguishing wrong-password from rate-limit.
 *
 * The password lives ONLY in React state, is cleared after every request (success or error), and is
 * never logged or persisted.
 */
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { createBrowserClient } from '@/lib/browser-client';
import { exportData, saveJson, exportFilename } from '@/lib/rgpd';
import type { RgpdExport as RgpdExportData } from '@/lib/rgpd';

type ExportState = 'idle' | 'exporting' | 'success' | 'stepUpError' | 'error';

export function RgpdExport(): React.ReactElement {
  const t = useTranslations('account.rgpd');
  const { getAccessToken, refresh } = useAuth();
  const clientRef = useRef(createBrowserClient({ getAccessToken }));

  const [password, setPassword] = useState('');
  const [state, setState] = useState<ExportState>('idle');

  // Move focus to the error/step-up banner once it mounts (WCAG 3.3.1 — mirrors the LoginForm pattern).
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state === 'stepUpError' || state === 'error') errorRef.current?.focus();
  }, [state]);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (state === 'exporting') return;

    const pw = password;
    setState('exporting');

    // One attempt with the current token. The password rides in the BODY (never the URL).
    const attempt = (): Promise<RgpdExportData> => exportData(clientRef.current, pw);

    try {
      let data: RgpdExportData;
      try {
        data = await attempt();
      } catch (err: unknown) {
        // STEP-UP 401: refresh ONCE, retry ONCE. A second 401 (or refresh failing) → step-up message.
        // Never loop. Never oracle wrong-password vs rate-limit.
        if ((err as { status?: number })?.status === 401) {
          try {
            await refresh();
          } catch {
            setState('stepUpError');
            return;
          }
          try {
            data = await attempt();
          } catch (retryErr: unknown) {
            setState((retryErr as { status?: number })?.status === 401 ? 'stepUpError' : 'error');
            return;
          }
        } else {
          setState('error');
          return;
        }
      }

      // Success — build the download. NEVER render `data` to the DOM (PII).
      saveJson(data, exportFilename());
      setState('success');
    } finally {
      // Clear the password from state regardless of outcome — never keep the secret around.
      setPassword('');
    }
  }

  const exporting = state === 'exporting';

  return (
    <div className="flex flex-col gap-3" data-testid="rgpd-export">
      <h3 className="text-base font-semibold text-foreground">{t('export.heading')}</h3>
      <p className="text-sm text-muted-foreground">{t('export.description')}</p>

      <form
        noValidate
        onSubmit={(e) => void onSubmit(e)}
        className="flex flex-col gap-3"
        aria-busy={exporting}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="rgpd-export-password" className="text-sm font-medium text-foreground">
            {t('export.passwordLabel')}
          </label>
          <input
            id="rgpd-export-password"
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            disabled={exporting}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full max-w-sm rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          />
        </div>

        <button
          type="submit"
          disabled={exporting}
          aria-busy={exporting}
          className="inline-flex w-fit items-center rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          {exporting ? t('export.exporting') : t('export.button')}
        </button>

        {state === 'success' ? (
          <p role="status" className="text-sm text-foreground" data-testid="rgpd-export-success">
            {t('export.success')}
          </p>
        ) : null}

        {state === 'stepUpError' ? (
          <p
            ref={errorRef}
            tabIndex={-1}
            role="alert"
            className="text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="rgpd-export-stepup-error"
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
            data-testid="rgpd-export-error"
          >
            {t('export.error')}
          </p>
        ) : null}
      </form>
    </div>
  );
}
