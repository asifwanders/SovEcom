'use client';

/**
 * Consent state for GA4 and Meta Pixel opt-in. Strictly-necessary needs no consent. State lives in
 * the `cookie_consent` cookie so it survives reloads and the server can't read it at static-render time.
 * The provider hydrates from the cookie on mount; consumers react to a GRANT in-place, mounting trackers
 * without a page reload. Withdrawing consent for an already-loaded GA4/Meta SDK only fully takes effect
 * on the next navigation; the UI exposes no in-session withdrawal today.
 *
 * Plausible is cookieless and NOT gated here; only GA4/Meta read this state.
 */
import { createContext, useCallback, useContext, useEffect, useState } from 'react';

export interface ConsentState {
  analytics: boolean;
  marketing: boolean;
}

/** Cookie name for consent state. */
export const CONSENT_COOKIE = 'cookie_consent';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // one year

/** Parse the cookie value → state, or `null` when no (valid) decision has been recorded yet. */
export function parseConsent(raw: string | undefined): ConsentState | null {
  if (!raw) return null;
  // Back-compat: the old informational banner wrote `dismissed` — treat as decided, both off.
  if (raw === 'dismissed') return { analytics: false, marketing: false };
  const m = /^a([01])m([01])$/.exec(raw);
  if (!m) return null; // garbage → undecided (re-prompt; never assume consent)
  return { analytics: m[1] === '1', marketing: m[2] === '1' };
}

/** Serialize state → the compact cookie value. */
export function serializeConsent(state: ConsentState): string {
  return `a${state.analytics ? 1 : 0}m${state.marketing ? 1 : 0}`;
}

function readCookie(): string | undefined {
  // Matches on `${name}=` so a longer-named cookie (e.g. cookie_consent_v2) can't prefix-match. If a
  // future migration ever renames this cookie, it MUST clear the old one first — two same-named
  // cookies at different paths would make this depend on unspecified document.cookie ordering.
  const hit = document.cookie
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${CONSENT_COOKIE}=`));
  return hit ? decodeURIComponent(hit.slice(CONSENT_COOKIE.length + 1)) : undefined;
}

interface ConsentContextValue {
  /** Current consent, or `null` until the visitor has decided (banner-visible state). */
  consent: ConsentState | null;
  /** Whether the provider has read the cookie yet (avoids a banner flash before hydration). */
  ready: boolean;
  /** Record a decision: writes the cookie and updates all consumers in-place (no reload). */
  setConsent: (state: ConsentState) => void;
  /** Whether the visitor has re-opened the banner to change a recorded decision. */
  manageOpen: boolean;
  /** Re-open the banner so a returning visitor can change consent ("Manage cookies"). */
  openManage: () => void;
  /** Close the re-opened banner (after a change is recorded). */
  closeManage: () => void;
}

const ConsentContext = createContext<ConsentContextValue | null>(null);

export function ConsentProvider({ children }: { children: React.ReactNode }) {
  const [consent, setConsentState] = useState<ConsentState | null>(null);
  const [ready, setReady] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

  useEffect(() => {
    setConsentState(parseConsent(readCookie()));
    setReady(true);
  }, []);

  const setConsent = useCallback((state: ConsentState) => {
    // `Secure` on HTTPS (the Caddy-served norm) so a plaintext-HTTP attacker can't forge/strip the
    // consent record; omitted on http://localhost so dev still works.
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${CONSENT_COOKIE}=${serializeConsent(state)}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
    setConsentState(state);
  }, []);

  const openManage = useCallback(() => setManageOpen(true), []);
  const closeManage = useCallback(() => setManageOpen(false), []);

  return (
    <ConsentContext.Provider
      value={{ consent, ready, setConsent, manageOpen, openManage, closeManage }}
    >
      {children}
    </ConsentContext.Provider>
  );
}

/**
 * True when moving from `prev` consent to `next` REVOKES a previously-granted category. Such a
 * downgrade needs a page reload because `next/script` can't unload an already-running GA4/Meta SDK
 *; a pure grant (or first decision) does not. `prev === null` → never a downgrade.
 */
export function isConsentDowngrade(prev: ConsentState | null, next: ConsentState): boolean {
  if (!prev) return false;
  return (prev.analytics && !next.analytics) || (prev.marketing && !next.marketing);
}

export function useConsent(): ConsentContextValue {
  const ctx = useContext(ConsentContext);
  if (!ctx) throw new Error('useConsent must be used within a ConsentProvider');
  return ctx;
}
