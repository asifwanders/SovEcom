'use client';

/**
 * C2 widget — `submit-form`. INTERACTIVE client island.
 *
 * Renders a bounded form (review submission, …) from validated C1 props. Field labels + the submit
 * label are React-escaped text; field `kind` is the C1 ENUM only (text/textarea/rating/email/select);
 * `select` options are escaped text. On submit it POSTs the collected field values to the module's OWN
 * mount — but only after {@link isOwnMountPath} confirms the descriptor's `action.path` targets the
 * BINDING module (`module` prop). If it does not, the form refuses to render (returns null) — fail
 * closed. The POST is a raw credentialed fetch (httpOnly customer cookie via `credentials:'include'`,
 * JWT verified by the core proxy). Any failure shows a generic state — a module never breaks the page.
 */
import { useState, type FormEvent } from 'react';
import type { SubmitFormProps } from '@sovecom/theme-sdk';
import { apiBaseUrl } from '@/lib/browser-client';
import { isOwnMountPath } from './ownMount';
import { bearerAuthHeaders, type AccessTokenGetter } from './authHeaders';

type FormState = 'idle' | 'submitting' | 'done' | 'error';

export function SubmitForm({
  action,
  submitLabel,
  fields,
  successMessage,
  module,
  getAccessToken,
}: SubmitFormProps & {
  /** The BINDING module — the own-mount source of truth (never the descriptor). */
  module: string;
  /** Live access-token getter — the submit carries the same Bearer the island's GET used (none for a guest). */
  getAccessToken: AccessTokenGetter;
}) {
  const [state, setState] = useState<FormState>('idle');

  // OWN-MOUNT: the action path must target the binding module's own mount, or refuse entirely.
  if (!isOwnMountPath(action.path, module)) return null;

  const handleSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (state === 'submitting') return;
    setState('submitting');
    try {
      if (!isOwnMountPath(action.path, module)) {
        setState('error');
        return;
      }
      const form = new FormData(e.currentTarget);
      const payload: Record<string, string> = {};
      for (const f of fields) {
        const v = form.get(f.name);
        if (typeof v === 'string') payload[f.name] = v;
      }
      // CSRF posture (Sonnet-confirmed): the mutating POST is protected by BEARER auth (the proxy reads
      // the customer only from the Authorization header, never the cookie) + the `application/json`
      // content-type forcing a CORS preflight against the explicit-origin allowlist — NOT a body token.
      // A guest submit (notify) carries no Bearer; the module is email-keyed, so that is correct.
      const res = await fetch(`${apiBaseUrl()}${action.path}`, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', ...bearerAuthHeaders(getAccessToken) },
        body: JSON.stringify(payload),
      });
      setState(res.ok ? 'done' : 'error');
    } catch {
      setState('error');
    }
  };

  if (state === 'done') {
    return (
      <p role="status" className="text-sm text-foreground" data-widget="submit-form">
        {successMessage ?? 'Submitted.'}
      </p>
    );
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="flex flex-col gap-3"
      data-widget="submit-form"
    >
      {fields.map((field) => (
        <label key={field.name} className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-foreground">{field.label}</span>
          {field.kind === 'textarea' ? (
            <textarea
              name={field.name}
              required={field.required}
              className="rounded-md border border-border bg-background px-3 py-2"
              rows={4}
            />
          ) : field.kind === 'select' ? (
            <select
              name={field.name}
              required={field.required}
              className="rounded-md border border-border bg-background px-3 py-2"
            >
              {(field.options ?? []).map((opt, i) => (
                <option key={`${field.name}-${i}`} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          ) : (
            <input
              name={field.name}
              required={field.required}
              type={field.kind === 'email' ? 'email' : field.kind === 'rating' ? 'number' : 'text'}
              {...(field.kind === 'rating' ? { min: 1, max: 5 } : {})}
              className="rounded-md border border-border bg-background px-3 py-2"
            />
          )}
        </label>
      ))}
      <button
        type="submit"
        disabled={state === 'submitting'}
        className="inline-flex w-fit items-center rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
      >
        {submitLabel}
      </button>
      {state === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          Something went wrong. Please try again.
        </p>
      ) : null}
    </form>
  );
}
