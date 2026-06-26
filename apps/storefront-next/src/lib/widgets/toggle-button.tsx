'use client';

/**
 * C2 widget — `toggle-button`. INTERACTIVE client island.
 *
 * Renders an on/off toggle (wishlist, notify-back-in-stock, …) from validated C1 props. The labels are
 * React-escaped text; the icon is the C1 ENUM only (no module glyph/SVG). On click it POSTs back to the
 * module's OWN mount — but only after {@link isOwnMountPath} confirms the descriptor's `onAction`/
 * `offAction` paths target the BINDING module (`module` prop), never another module or origin. If
 * EITHER action fails own-mount, the widget refuses to render at all (returns null) — fail closed.
 *
 * The POST is a raw credentialed fetch (the httpOnly customer cookie rides via `credentials:'include'`;
 * the core proxy verifies the JWT). Any failure leaves the UI state unchanged — a module never breaks
 * the page.
 */
import { useState } from 'react';
import type { ToggleButtonProps } from '@sovecom/theme-sdk';
import { apiBaseUrl } from '@/lib/browser-client';
import { isOwnMountPath } from './ownMount';
import { bearerAuthHeaders, type AccessTokenGetter } from './authHeaders';

/** The C1 icon enum → a static glyph (no module-supplied glyph/SVG ever reaches the DOM). */
const ICON_GLYPH: Record<ToggleButtonProps['icon'], string> = {
  heart: '♥',
  bell: '🔔',
  star: '★',
};

export function ToggleButton({
  initialOn,
  onAction,
  offAction,
  labels,
  icon,
  module,
  getAccessToken,
}: ToggleButtonProps & {
  /** The BINDING module — the own-mount source of truth (never the descriptor). */
  module: string;
  /** Live access-token getter — the POST-back carries the same Bearer the island's GET used. */
  getAccessToken: AccessTokenGetter;
}) {
  const [on, setOn] = useState(initialOn);
  const [busy, setBusy] = useState(false);

  // OWN-MOUNT: BOTH action paths must target the binding module's own mount, or refuse entirely.
  if (!isOwnMountPath(onAction.path, module) || !isOwnMountPath(offAction.path, module)) {
    return null;
  }

  const handleClick = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const target = on ? offAction.path : onAction.path;
    try {
      // Re-check at call time (defense in depth) and build the URL from the binding-derived origin +
      // the validated relative path — never a raw descriptor host.
      if (!isOwnMountPath(target, module)) return;
      // CSRF posture (Sonnet-confirmed): this mutating POST is protected by BEARER auth (the proxy reads
      // the customer only from the Authorization header, never the cookie) + the `application/json`-free
      // simple request still triggering a CORS check against the explicit-origin allowlist — NOT a body
      // token. So a bodyless toggle POST is safe: a cross-site page cannot read the in-memory Bearer.
      const res = await fetch(`${apiBaseUrl()}${target}`, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: bearerAuthHeaders(getAccessToken),
      });
      if (res.ok) setOn((v) => !v);
    } catch {
      // A module never breaks the page — swallow and leave the toggle state unchanged.
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={busy}
      aria-pressed={on}
      data-widget="toggle-button"
      className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
    >
      <span aria-hidden="true">{ICON_GLYPH[icon]}</span>
      <span>{on ? labels.on : labels.off}</span>
    </button>
  );
}
