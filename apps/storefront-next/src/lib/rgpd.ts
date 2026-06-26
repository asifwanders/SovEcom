/**
 * customer RGPD/GDPR self-service helpers (data EXPORT + account ERASE).
 *
 * MOST SECURITY-CRITICAL chunk: PII export + irreversible erase, both gated by a server-side password
 * step-up (RgpdStepUpDto). Endpoints already exist (CustomerAuthGuard + IDOR-scoped) — NO API change.
 *
 *   POST /store/v1/customers/me/rgpd/export  { password } → 200 JSON `RgpdExport`  (NO Content-Disposition)
 *   POST /store/v1/customers/me/rgpd/erase   { password } → 204 (anonymises, revokes sessions, clears cookie)
 *
 * STEP-UP 401 SEMANTICS (different from other chunks): both endpoints run the auth guard THEN verify the
 * password. A 401 here almost always means WRONG PASSWORD or rate-limited (5/60s), NOT token expiry — and
 * the server is timing-safe with an EMPTY body (no oracle). Callers must therefore NOT loop on 401: try
 * refresh() once, retry once, and on a second 401 show the single "password incorrect or too many
 * attempts" message (never distinguishing wrong-password from rate-limit). The password is passed straight
 * through to the request body and is NEVER logged or persisted by these helpers.
 *
 * client-js types bodies but NOT responses → the storefront owns the `RgpdExport` shape.
 */
import type { SovEcomClient } from '@sovecom/client-js';

/** A profile snapshot inside the export — mirrors the API customer serializer (PII; never rendered). */
export interface RgpdExportProfile {
  id: string;
  email: string;
  name?: string | null;
  phone?: string | null;
  isB2b?: boolean;
  vatNumber?: string | null;
  vatValidated?: boolean;
  acceptsMarketing?: boolean;
  locale?: string | null;
  createdAt?: string;
}

/**
 * The `POST /store/v1/customers/me/rgpd/export` 200 response body (the customer's portable data set).
 * The nested arrays mirror the corresponding API serializers; the storefront only serialises this back
 * to a downloadable JSON file — it NEVER renders the contents to the DOM (it is PII).
 */
export interface RgpdExport {
  exportedAt: string;
  profile: RgpdExportProfile;
  addresses: unknown[];
  orders: unknown[];
  invoices: unknown[];
  emailLogs: unknown[];
}

/**
 * Request the customer's data export. The password rides in the JSON BODY (never the URL/query — a query
 * credential would leak into logs/Referer/history). Returns the parsed `RgpdExport`. Throws on error
 * (the caller owns the 401-step-up handling — see the step-up semantics above).
 */
export async function exportData(client: SovEcomClient, password: string): Promise<RgpdExport> {
  return client.request<'/store/v1/customers/me/rgpd/export', 'post', RgpdExport>(
    'post',
    '/store/v1/customers/me/rgpd/export',
    { body: { password } },
  );
}

/**
 * Irreversibly erase (anonymise) the customer's account. The password rides in the JSON BODY. Returns
 * void (204). The server revokes all sessions and clears the refresh cookie; the caller then drops the
 * in-memory token and navigates home. Throws on error (caller owns the 401-step-up handling).
 */
export async function eraseAccount(client: SovEcomClient, password: string): Promise<void> {
  return client.request<'/store/v1/customers/me/rgpd/erase', 'post', void>(
    'post',
    '/store/v1/customers/me/rgpd/erase',
    { body: { password } },
  );
}

/**
 * Trigger a browser "save" for an arbitrary JSON-serialisable value under `filename` via a transient
 * anchor + object URL, then revoke the URL in a `finally` (mirrors `saveBlob` in InvoiceDownloadButton).
 * The blob is built with a 2-space pretty-print so the exported file is human-readable.
 */
export function saveJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
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

/** Build the dated export filename, e.g. `sovecom-data-export-2026-06-19.json` (UTC date). */
export function exportFilename(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `sovecom-data-export-${yyyy}-${mm}-${dd}.json`;
}
