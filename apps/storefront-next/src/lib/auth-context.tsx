'use client';

/**
 * Customer auth context — the in-memory session for the transactional
 * storefront. SECURITY-CRITICAL (auth/PII surface).
 *
 * The customer access token lives ONLY in a React ref (process memory) — NEVER localStorage or
 * sessionStorage. An XSS that can read web storage cannot lift a refresh-capable token; the
 * long-lived credential is the httpOnly `SameSite=Strict` refresh cookie the browser holds and the
 * JS never sees. On mount the provider silently calls `POST /store/v1/customers/refresh` to mint a
 * fresh short-lived access token from that cookie (a 401 simply means "guest" — no UI error). The
 * token is exposed to the data layer via `getAccessToken()`, a STABLE getter the browser-client reads
 * per request, so a token minted by a later refresh is used immediately.
 *
 * API surface consumed (paths/bodies typed by client-js; responses owned here):
 *   - POST /store/v1/customers/login    {email,password} -> {accessToken}     (+ sets refresh cookie)
 *   - POST /store/v1/customers          SignupDto        -> StoreCustomerView (NO token — then login)
 *   - POST /store/v1/customers/refresh  (cookie)         -> {accessToken}     (rotates refresh cookie)
 *   - POST /store/v1/customers/logout   (cookie)         -> 204               (revokes family)
 *   - GET  /store/v1/customers/me       (Bearer)         -> StoreCustomerView
 *
 * All mutations are client fetches via the credentialed browser-client, which carries the cookies
 * cross-origin and injects this token as Bearer.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { SovEcomApiError, type SovEcomClient } from '@sovecom/client-js';
import { createBrowserClient, apiBaseUrl } from './browser-client';

/** The authenticated customer view the storefront renders. Subset of the API `StoreCustomerView`. */
export interface AuthCustomer {
  id: string;
  email: string;
  name?: string | null;
  phone?: string | null;
  isB2b?: boolean;
  /** The customer's VAT number (B2B), or null — used to prefill the checkout VAT field. */
  vatNumber?: string | null;
  /**
   * True when the VAT number was positively VIES-validated server-side. Reverse-charge (0% VAT) only
   * applies for a VIES-validated B2B customer on a cross-border EU sale — the server computes both the
   * money effect and the reverse-charge decision. This flag is the UI guard that lets the storefront
   * explain the reverse-charge state — never a `taxTotal === 0` inference.
   */
  vatValidated?: boolean;
  acceptsMarketing?: boolean;
  /**
   * The proposed new email while a verify-before-switch change is in flight, or null. Populated
   * automatically from the `/me` body so the account UI can show "a change to X is pending". The
   * ChangeEmailForm reads it to seed its banner; it is NOT a token-bearing or secret value.
   */
  pendingEmail?: string | null;
}

/**
 * A saved customer address (mirrors the API `AddressView` in `customer.serializer.ts`). Read-only here —
 * full address management is 3.8b; checkout only READS these to prefill + posts the chosen one to the cart.
 */
export interface SavedAddress {
  id: string;
  type: 'shipping' | 'billing';
  isDefault: boolean;
  name: string;
  company: string | null;
  line1: string;
  line2: string | null;
  city: string;
  postalCode: string;
  region: string | null;
  country: string;
  phone: string | null;
}

/** Fields the register form may submit (mirrors the API `SignupDto`; client-js types the body). */
export interface RegisterInput {
  email: string;
  password: string;
  name?: string;
  phone?: string;
  isB2b?: boolean;
  vatNumber?: string;
  acceptsMarketing?: boolean;
}

export interface AuthContextValue {
  /** The signed-in customer, or `null` for a guest. */
  customer: AuthCustomer | null;
  /**
   * Update mutable customer profile fields (name, phone, vatNumber, acceptsMarketing).
   * PATCHes `PATCH /store/v1/customers/me` then reloads the profile so in-memory customer stays fresh.
   * Throws on error.
   */
  updateProfile: (fields: {
    name?: string | null;
    phone?: string | null;
    vatNumber?: string | null;
    acceptsMarketing?: boolean;
  }) => Promise<void>;
  /**
   * Update the signed-in customer's VAT number (checkout B2B step → `PATCH /store/v1/customers/me`).
   * The server re-runs VIES validation, so this reloads the profile after the patch so consumers see the
   * fresh `vatValidated`/`vatNumber`. Throws if no customer is signed in or on a server error. The cart's
   * tax (reverse-charge) is recomputed SERVER-side; the UI never computes tax.
   */
  updateVatNumber: (vatNumber: string) => Promise<void>;
  /**
   * List the signed-in customer's saved addresses (`GET /store/v1/customers/me/addresses`) so the
   * checkout address step can default to the saved/default address. Read-only — address management is
   * deferred. Returns `[]` for a guest.
   */
  fetchAddresses: () => Promise<SavedAddress[]>;
  /** True once a customer is authenticated (token + profile present). */
  isAuthenticated: boolean;
  /** True until the initial silent refresh resolves (so consumers can avoid a guest flash). */
  isLoading: boolean;
  /** Live getter for the in-memory access token — `null` for a guest. Read by the data layer. */
  getAccessToken: () => string | null;
  /** Email+password login. Throws on bad credentials (uniform 401 from the API). */
  login: (email: string, password: string) => Promise<void>;
  /** Self-signup, then auto-login (the signup endpoint returns no session). */
  register: (input: RegisterInput) => Promise<void>;
  /**
   * Change the signed-in customer's password (`POST /store/v1/customers/me/password`).
   * SECURITY: the endpoint bumps token_version and revokes EVERY refresh family (logs out all OTHER
   * sessions) — THIS session survives ONLY because the endpoint returns a fresh access token (+ rotates
   * the refresh cookie), which we swap into memory here. THROWS on error and never inspects/oracles it:
   * a uniform 401 = wrong current password / rate-limited / token expiry, and a 400 = weak/breached
   * new password. We do NOT reload the profile (a password change alters no profile field; the token
   * swap is the only state change).
   */
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  /** Revoke the session family server-side and clear the in-memory token. */
  logout: () => Promise<void>;
  /** Force a silent refresh (e.g. after a 401 on a protected call). Returns the new token or null. */
  refresh: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function isUnauthorized(err: unknown): boolean {
  return err instanceof SovEcomApiError && err.status === 401;
}

export function AuthProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  // The access token lives in a ref (memory only). State mirrors only PRESENCE (`hasToken`), never the
  // secret value itself — but the secret is never persisted, so this is purely an XSS-surface nicety.
  const tokenRef = useRef<string | null>(null);
  const [customer, setCustomer] = useState<AuthCustomer | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Token PRESENCE as state, so it both triggers a re-render and is a sound dependency for the derived
  // `isAuthenticated` (we never derive auth from a ref read inside a memo — review NIT).
  const [hasToken, setHasToken] = useState(false);

  // STABLE getter the browser-client reads per request — never re-created, so the client built from
  // it always sees the current token (including one minted by a later silent refresh).
  const getAccessToken = useCallback((): string | null => tokenRef.current, []);

  // A single browser-client instance wired to the live token getter. Stable across renders.
  const clientRef = useRef<SovEcomClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current = createBrowserClient({ getAccessToken });
  }
  const client = clientRef.current;

  const setToken = useCallback((token: string | null) => {
    tokenRef.current = token;
    setHasToken(token !== null);
  }, []);

  /** Load the signed-in customer's profile with the current Bearer token. */
  const loadProfile = useCallback(async (): Promise<void> => {
    const me = await client.request<'/store/v1/customers/me', 'get', AuthCustomer>(
      'get',
      '/store/v1/customers/me',
    );
    setCustomer(me);
  }, [client]);

  /** Silent refresh from the httpOnly cookie. Returns the new token, or null if the visitor is a guest. */
  const refresh = useCallback(async (): Promise<string | null> => {
    try {
      const res = await client.request<
        '/store/v1/customers/refresh',
        'post',
        { accessToken: string }
      >('post', '/store/v1/customers/refresh');
      setToken(res.accessToken);
      return res.accessToken;
    } catch (err) {
      if (isUnauthorized(err)) {
        // No valid refresh cookie → guest. Clear any stale session; do NOT surface an error.
        setToken(null);
        setCustomer(null);
        return null;
      }
      throw err;
    }
  }, [client, setToken]);

  // Mount: attempt a silent refresh, then hydrate the profile if it succeeded.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const token = await refresh();
        if (!cancelled && token) await loadProfile();
      } catch {
        // Network/5xx during boot — treat as guest; the UI can retry on a protected action.
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh, loadProfile]);

  /**
   * Fire-and-forget guest wishlist merge: after login, migrate the sov_guest cookie's wishlist
   * items into the customer's wishlist. The sov_guest cookie rides automatically via
   * credentials:'include' (httpOnly, same-site). The Bearer token must be in-memory already.
   * Failures are silently swallowed -- a failed merge does not abort the login flow; the guest
   * items remain in the guest table and can be retried, or lost on cookie expiry.
   */
  const mergeGuestWishlist = useCallback((accessToken: string): void => {
    void fetch(`${apiBaseUrl}/store/v1/modules/wishlist/merge-guest`, {
      method: 'POST',
      credentials: 'include',
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    }).catch(() => {
      // Silently swallow -- merge failure must never break the login flow.
    });
  }, []);

  /**
   * Fire-and-forget guest recently-viewed merge: after login, migrate the sov_guest cookie's
   * recently-viewed history into the customer's history. The sov_guest cookie rides automatically
   * via credentials:'include' (httpOnly, same-site). The Bearer token must be in-memory already.
   * Failures are silently swallowed -- a failed merge does not abort the login flow; the guest
   * history remains in the guest key space and can be retried, or expires with the cookie.
   */
  const mergeGuestRecentlyViewed = useCallback((accessToken: string): void => {
    void fetch(`${apiBaseUrl}/store/v1/modules/recently-viewed/merge-guest`, {
      method: 'POST',
      credentials: 'include',
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    }).catch(() => {
      // Silently swallow -- merge failure must never break the login flow.
    });
  }, []);

  const login = useCallback(
    async (email: string, password: string): Promise<void> => {
      const res = await client.request<
        '/store/v1/customers/login',
        'post',
        { accessToken: string }
      >('post', '/store/v1/customers/login', { body: { email, password } });
      setToken(res.accessToken);
      // Merge guest module data into the customer's records before loading the profile
      // so the UI sees merged data on the first render after login.
      mergeGuestWishlist(res.accessToken);
      mergeGuestRecentlyViewed(res.accessToken);
      await loadProfile();
    },
    [client, setToken, loadProfile, mergeGuestWishlist, mergeGuestRecentlyViewed],
  );

  const register = useCallback(
    async (input: RegisterInput): Promise<void> => {
      // Signup returns the customer view but NO session — log in immediately to obtain the token.
      // The API body requires `isB2b`/`acceptsMarketing` (they carry `.default(false)` server-side,
      // which makes them required in the generated body type), so default them explicitly here.
      await client.request<'/store/v1/customers', 'post', AuthCustomer>(
        'post',
        '/store/v1/customers',
        {
          body: {
            email: input.email,
            password: input.password,
            name: input.name,
            phone: input.phone,
            vatNumber: input.vatNumber,
            isB2b: input.isB2b ?? false,
            acceptsMarketing: input.acceptsMarketing ?? false,
          },
        },
      );
      await login(input.email, input.password);
    },
    [client, login],
  );

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string): Promise<void> => {
      const res = await client.request<
        '/store/v1/customers/me/password',
        'post',
        { accessToken: string }
      >('post', '/store/v1/customers/me/password', { body: { currentPassword, newPassword } });
      // Replace the in-memory token so THIS session survives the "log out everywhere" the endpoint
      // performs (it revoked all refresh families + bumped token_version). Without this swap the next
      // request from this tab would 401. Throws (401/400) bubble to the component — we never catch here.
      setToken(res.accessToken);
    },
    [client, setToken],
  );

  const updateProfile = useCallback(
    async (fields: {
      name?: string | null;
      phone?: string | null;
      vatNumber?: string | null;
      acceptsMarketing?: boolean;
    }): Promise<void> => {
      await client.request<'/store/v1/customers/me', 'patch', AuthCustomer>(
        'patch',
        '/store/v1/customers/me',
        { body: fields },
      );
      await loadProfile();
    },
    [client, loadProfile],
  );

  const updateVatNumber = useCallback(
    async (vatNumber: string): Promise<void> => {
      // Delegate to updateProfile so the profile reload is shared.
      await updateProfile({ vatNumber });
    },
    [updateProfile],
  );

  const fetchAddresses = useCallback(async (): Promise<SavedAddress[]> => {
    if (tokenRef.current === null) return [];
    return client.request<'/store/v1/customers/me/addresses', 'get', SavedAddress[]>(
      'get',
      '/store/v1/customers/me/addresses',
    );
  }, [client]);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await client.request('post', '/store/v1/customers/logout');
    } catch {
      // Even if the server-side revoke fails, locally drop the token — the access token is short-lived
      // and the refresh cookie is the durable credential the endpoint targets. Never leave a token live
      // in memory because the network hiccupped.
    } finally {
      setToken(null);
      setCustomer(null);
    }
  }, [client, setToken]);

  const value = useMemo<AuthContextValue>(
    () => ({
      customer,
      // Derived purely from STATE (`hasToken` + `customer`), never a ref read — so it re-derives
      // whenever token presence changes, independent of `customer` moving in lockstep.
      isAuthenticated: hasToken && customer !== null,
      isLoading,
      getAccessToken,
      login,
      register,
      changePassword,
      logout,
      refresh,
      updateProfile,
      updateVatNumber,
      fetchAddresses,
    }),
    [
      hasToken,
      customer,
      isLoading,
      getAccessToken,
      login,
      register,
      changePassword,
      logout,
      refresh,
      updateProfile,
      updateVatNumber,
      fetchAddresses,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Consume the auth context. Throws if used outside `<AuthProvider>` (a wiring bug, not a runtime one). */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error('useAuth must be used within an <AuthProvider>');
  }
  return ctx;
}
