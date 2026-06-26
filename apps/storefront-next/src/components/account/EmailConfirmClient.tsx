'use client';

/**
 * customer email-change CONFIRM island. AUTH/CREDENTIAL-CRITICAL.
 *
 * Lives on an UNGATED route (not under `(account)`), because the verification link is clicked from an
 * email and the visitor may be logged out. On mount it reads the one-time `token` from the query and
 * POSTs it to the PUBLIC `POST /store/v1/customers/me/email/confirm` (NO Bearer — `createBrowserClient`
 * with no token getter). The token is single-use and short-lived; the server is the authoritative
 * validator.
 *
 * States: `verifying` (initial) | `success` (200) | `expiredError` (400 invalid/expired/used) |
 * `takenError` (409 — the address was claimed by someone else between request and confirm) |
 * `error` (anything else, incl. 429 rate-limit and a missing token).
 *
 * SECURITY: the raw token is NEVER rendered to the DOM and never logged. A missing/empty token goes
 * straight to `expiredError` WITHOUT calling the API (no wasted round-trip, no oracle). We do not attempt
 * a cross-session header refresh if the user happens to be logged in (out of scope — the stale header
 * email self-corrects on the next profile load).
 */
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { createBrowserClient } from '@/lib/browser-client';

type ConfirmState = 'verifying' | 'success' | 'expiredError' | 'takenError' | 'error';

export function EmailConfirmClient(): React.ReactElement {
  const t = useTranslations('account.email.confirm');
  const params = useSearchParams();
  const token = params.get('token');

  const [state, setState] = useState<ConfirmState>('verifying');

  // PUBLIC confirm — no token getter, so no Authorization header is attached.
  const clientRef = useRef(createBrowserClient());
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    // Missing/empty token → expired without calling the API (no round-trip, no oracle).
    if (token === null || token.trim() === '') {
      setState('expiredError');
      return;
    }

    void (async () => {
      try {
        await clientRef.current.request<'/store/v1/customers/me/email/confirm', 'post', void>(
          'post',
          '/store/v1/customers/me/email/confirm',
          { body: { token } },
        );
        setState('success');
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status;
        if (status === 400) setState('expiredError');
        else if (status === 409) setState('takenError');
        else setState('error');
      }
    })();
  }, [token]);

  if (state === 'verifying') {
    return (
      <p role="status" className="text-sm text-muted-foreground" data-testid="email-confirm">
        {t('verifying')}
      </p>
    );
  }

  if (state === 'success') {
    return (
      <div className="flex flex-col gap-3" data-testid="email-confirm">
        <p role="status" className="text-sm text-foreground">
          {t('success')}
        </p>
        <Link href="/account" className="self-start text-sm font-medium text-primary underline">
          {t('backToAccount')}
        </Link>
      </div>
    );
  }

  const message =
    state === 'expiredError'
      ? t('expiredError')
      : state === 'takenError'
        ? t('takenError')
        : t('error');

  return (
    <div className="flex flex-col gap-3" data-testid="email-confirm">
      <p role="alert" className="text-sm text-destructive">
        {message}
      </p>
      <Link href="/account" className="self-start text-sm font-medium text-primary underline">
        {t('backToAccount')}
      </Link>
    </div>
  );
}
