'use client';

/**
 * customer invoice PDF download. AUTH/IDOR-CRITICAL.
 *
 * The invoice endpoint (`GET /store/v1/orders/{orderId}/invoice`, CustomerAuthGuard, IDOR-scoped)
 * returns RAW `application/pdf` bytes — NOT JSON. The storefront's client-js transport JSON-parses
 * every response, so it cannot be used here; we issue a raw credentialed `fetch` instead.
 *
 * Security contract:
 *   - The access token is sent in the Authorization HEADER, NEVER in the URL/query (a query token
 *     would leak into logs/Referer/history). The httpOnly cookies still ride via credentials:'include'.
 *   - On 401: exactly ONE silent `refresh()` + ONE retry. `refresh()` re-throws network/5xx errors
 *     (auth-context), so the retry is wrapped in its own try/catch — a refresh rejection falls to the
 *     ERROR state, never an infinite loop.
 *   - On 404 the server returns a UNIFORM response for BOTH "not the owner" AND "no invoice yet"
 *     (e.g. unpaid order). We show a single calm "not available yet" message and NEVER oracle which.
 *
 * No API changes: this component only consumes the existing endpoint.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { apiBaseUrl } from '@/lib/browser-client';
import { orderHasInvoice } from '@/lib/order-status';

type DownloadState = 'idle' | 'downloading' | 'unavailable' | 'error';

export interface InvoiceDownloadButtonProps {
  /** The order id — used only to build the endpoint path. */
  orderId: string;
  /** The human order number — used for the filename fallback. */
  orderNumber: string;
  /**
   * The order status — the button is hidden unless an invoice plausibly exists (i.e. the order is
   * `paid` or beyond, per `orderHasInvoice`). Hidden for `pending_payment` and `cancelled`.
   */
  status: string;
}

/**
 * Parse the filename out of a Content-Disposition header. Returns `null` when the header is absent
 * or has no parseable filename, so the caller can fall back. Prefers the RFC 5987 extended form
 * (`filename*=UTF-8''<pct-encoded>`, which carries non-ASCII names) and percent-decodes it, then
 * falls back to the plain `filename="..."` form.
 */
function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  // RFC 5987 extended form first — percent-decode; if the encoding is malformed, fall through.
  const rfc5987 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (rfc5987?.[1]) {
    try {
      return decodeURIComponent(rfc5987[1].trim());
    } catch {
      /* malformed encoding — fall through to the plain filename form */
    }
  }
  // Match filename="x" (quoted) or filename=x (unquoted, no separators). Keep it conservative.
  const match = /filename="?([^";]+)"?/i.exec(header);
  return match?.[1]?.trim() || null;
}

/** Trigger a browser "save" for a Blob under `filename` via a transient anchor, then clean up. */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function InvoiceDownloadButton({
  orderId,
  orderNumber,
  status,
}: InvoiceDownloadButtonProps): React.ReactElement | null {
  const t = useTranslations('account.orders');
  const { getAccessToken, refresh } = useAuth();
  const [state, setState] = useState<DownloadState>('idle');

  // An invoice only exists once the order is paid (or beyond). Hide the affordance otherwise —
  // notably for `pending_payment` AND `cancelled`, where a click could only ever 404. The 404
  // handling below remains as a safety net if an edge status slips through.
  if (!orderHasInvoice(status)) return null;

  const url = `${apiBaseUrl()}/store/v1/orders/${orderId}/invoice`;

  /** One fetch attempt with the current token. Token goes in the HEADER only — never the URL. */
  const doFetch = async (): Promise<Response> => {
    const token = getAccessToken();
    return fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  };

  const handleClick = async (): Promise<void> => {
    setState('downloading');
    try {
      let response = await doFetch();

      // One silent refresh + retry on 401. A refresh rejection must NOT loop — catch it and fall to
      // the error state.
      if (response.status === 401) {
        try {
          await refresh();
        } catch {
          setState('error');
          return;
        }
        response = await doFetch();
      }

      if (response.status === 404) {
        // UNIFORM 404: not-owner OR no-invoice-yet — same calm message, never oracle which.
        setState('unavailable');
        return;
      }

      if (!response.ok) {
        setState('error');
        return;
      }

      const blob = await response.blob();
      const filename =
        filenameFromContentDisposition(response.headers.get('content-disposition')) ??
        `invoice-${orderNumber}.pdf`;
      saveBlob(blob, filename);
      setState('idle');
    } catch {
      // Network failure / blob read error — generic, non-oracling message.
      setState('error');
    }
  };

  const downloading = state === 'downloading';

  return (
    <div className="flex flex-col gap-2" data-testid="invoice-download">
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={downloading}
        aria-busy={downloading}
        className="inline-flex w-fit items-center rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
      >
        {downloading ? t('downloadingInvoice') : t('downloadInvoice')}
      </button>

      {state === 'unavailable' ? (
        <p
          role="status"
          className="text-sm text-muted-foreground"
          data-testid="invoice-unavailable"
        >
          {t('invoiceUnavailable')}
        </p>
      ) : null}

      {state === 'error' ? (
        <p role="alert" className="text-sm text-destructive" data-testid="invoice-error">
          {t('invoiceDownloadError')}
        </p>
      ) : null}
    </div>
  );
}
