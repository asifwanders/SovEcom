/**
 * customer auth-context contract.
 *
 * The context holds the customer access token IN MEMORY ONLY (XSS posture):
 *   - login()/register() flows obtain a session; logout() clears it;
 *   - the token is NEVER written to localStorage/sessionStorage;
 *   - on mount it silently calls POST /store/v1/customers/refresh to re-hydrate from the httpOnly
 *     SameSite=Strict refresh cookie; a 401 there just means "guest" (no throw to the UI).
 *
 * We mock the browser-client so we can drive endpoint responses and assert the calls made. The real
 * client-js error type (SovEcomApiError) is used so the 401 branch is exercised authentically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import React from 'react';

// ── Mock the browser-client: capture the request fn so tests script endpoint responses ──────────
const request = vi.fn();
vi.mock('./browser-client', () => ({
  createBrowserClient: () => ({ request }),
}));

import { SovEcomApiError } from '@sovecom/client-js';
import { AuthProvider, useAuth } from './auth-context';

function Probe() {
  const { customer, isAuthenticated, getAccessToken, login, register, logout } = useAuth();
  return (
    <div>
      <span data-testid="status">{isAuthenticated ? 'in' : 'out'}</span>
      <span data-testid="email">{customer?.email ?? ''}</span>
      <span data-testid="pending-email">{customer?.pendingEmail ?? ''}</span>
      <span data-testid="token">{getAccessToken() ?? ''}</span>
      <button onClick={() => void login('a@b.com', 'pw')}>login</button>
      <button onClick={() => void register({ email: 'a@b.com', password: 'pw-12chars-min' })}>
        register
      </button>
      <button onClick={() => void logout()}>logout</button>
    </div>
  );
}

function unauthorized() {
  return new SovEcomApiError(401, 'Unauthorized', undefined);
}

beforeEach(() => {
  request.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

function VatProbe() {
  const { customer, updateVatNumber } = useAuth();
  return (
    <div>
      <span data-testid="vat">{customer?.vatNumber ?? ''}</span>
      <span data-testid="vat-validated">{customer?.vatValidated ? 'yes' : 'no'}</span>
      <button onClick={() => void updateVatNumber('FR12345678901').catch(() => {})}>set-vat</button>
    </div>
  );
}

// Probe that surfaces the access token AND drives changePassword, capturing any thrown error so the
// "propagates the error" assertions can read it (the context must NOT swallow a 401/400).
function ChangePwProbe() {
  const { getAccessToken, changePassword } = useAuth();
  const [err, setErr] = React.useState<string>('');
  // `getAccessToken()` is a STABLE getter that reads the token ref live; on a successful change the ref
  // is swapped but token PRESENCE is unchanged, so the provider intentionally does NOT re-render. We
  // therefore SNAPSHOT the getter's value into local state on click to surface the post-swap token.
  const [seenToken, setSeenToken] = React.useState<string>('');
  return (
    <div>
      <span data-testid="token">{seenToken}</span>
      <span data-testid="cp-error">{err}</span>
      <button
        onClick={() => {
          setErr('');
          setSeenToken(getAccessToken() ?? '');
          void changePassword('old-pw-12chars', 'new-pw-12chars')
            .then(() => setSeenToken(getAccessToken() ?? ''))
            .catch((e: unknown) => {
              setErr(`status:${(e as { status?: number })?.status ?? 'none'}`);
              setSeenToken(getAccessToken() ?? '');
            });
        }}
      >
        change-pw
      </button>
    </div>
  );
}

describe('AuthProvider', () => {
  it('updateVatNumber PATCHes /me then reloads the profile (server re-runs VIES → fresh vatValidated)', async () => {
    let patched: { vatNumber?: string } | undefined;
    let meCalls = 0;
    request.mockImplementation(
      (method: string, path: string, opts?: { body?: { vatNumber?: string } }) => {
        if (path === '/store/v1/customers/refresh') return Promise.resolve({ accessToken: 'tok' });
        if (path === '/store/v1/customers/me' && method === 'patch') {
          patched = opts?.body;
          return Promise.resolve({ id: 'c1', email: 'a@b.com' });
        }
        if (path === '/store/v1/customers/me') {
          meCalls += 1;
          // First load: no VAT. After the PATCH the reload reflects the VIES-validated number.
          return Promise.resolve(
            meCalls === 1
              ? { id: 'c1', email: 'a@b.com', isB2b: true, vatNumber: null, vatValidated: false }
              : {
                  id: 'c1',
                  email: 'a@b.com',
                  isB2b: true,
                  vatNumber: 'FR12345678901',
                  vatValidated: true,
                },
          );
        }
        return Promise.reject(new Error(`unexpected ${path}`));
      },
    );
    render(
      <AuthProvider>
        <VatProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('vat-validated')).toHaveTextContent('no'));

    await act(async () => {
      screen.getByText('set-vat').click();
    });
    await waitFor(() => expect(screen.getByTestId('vat')).toHaveTextContent('FR12345678901'));
    expect(screen.getByTestId('vat-validated')).toHaveTextContent('yes');
    expect(patched).toEqual({ vatNumber: 'FR12345678901' });
  });

  it('on mount, silently refreshes and re-hydrates the access token from the cookie', async () => {
    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/customers/refresh')
        return Promise.resolve({ accessToken: 'fresh-tok' });
      if (path === '/store/v1/customers/me') {
        // a /me body carrying `pendingEmail` must surface on `customer` unchanged so the
        // change-email UI can seed its "pending" banner.
        return Promise.resolve({
          id: 'c1',
          email: 'a@b.com',
          name: null,
          pendingEmail: 'new@b.com',
        });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('token')).toHaveTextContent('fresh-tok'));
    expect(screen.getByTestId('status')).toHaveTextContent('in');
    expect(screen.getByTestId('email')).toHaveTextContent('a@b.com');
    expect(screen.getByTestId('pending-email')).toHaveTextContent('new@b.com');
  });

  it('treats a 401 on the mount refresh as "guest" (no token, no throw)', async () => {
    request.mockRejectedValue(unauthorized());
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('out'));
    expect(screen.getByTestId('token')).toHaveTextContent('');
  });

  it('NEVER writes the access token to localStorage or sessionStorage', async () => {
    const localSpy = vi.spyOn(Storage.prototype, 'setItem');
    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/customers/refresh')
        return Promise.resolve({ accessToken: 'secret-tok' });
      if (path === '/store/v1/customers/me') return Promise.resolve({ id: 'c1', email: 'a@b.com' });
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('token')).toHaveTextContent('secret-tok'));
    // No storage write carried the token (or anything keyed to it).
    for (const call of localSpy.mock.calls) {
      expect(String(call[1])).not.toContain('secret-tok');
    }
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('login() stores the returned access token in memory and loads the profile', async () => {
    request.mockRejectedValueOnce(unauthorized()); // mount refresh → guest
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('out'));

    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/customers/login')
        return Promise.resolve({ accessToken: 'login-tok' });
      if (path === '/store/v1/customers/me') return Promise.resolve({ id: 'c1', email: 'a@b.com' });
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    await act(async () => {
      screen.getByText('login').click();
    });
    await waitFor(() => expect(screen.getByTestId('token')).toHaveTextContent('login-tok'));
    expect(screen.getByTestId('status')).toHaveTextContent('in');
  });

  it('register() then logs in (signup returns no token), leaving an authenticated session', async () => {
    request.mockRejectedValueOnce(unauthorized()); // mount refresh → guest
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('out'));

    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/customers') return Promise.resolve({ id: 'c1', email: 'a@b.com' });
      if (path === '/store/v1/customers/login') return Promise.resolve({ accessToken: 'reg-tok' });
      if (path === '/store/v1/customers/me') return Promise.resolve({ id: 'c1', email: 'a@b.com' });
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    await act(async () => {
      screen.getByText('register').click();
    });
    await waitFor(() => expect(screen.getByTestId('token')).toHaveTextContent('reg-tok'));
    const paths = request.mock.calls.map((c) => c[1]);
    expect(paths).toContain('/store/v1/customers'); // signup
    expect(paths).toContain('/store/v1/customers/login'); // then login
  });

  it('logout() calls the logout endpoint and clears the in-memory token', async () => {
    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/customers/refresh') return Promise.resolve({ accessToken: 'tok' });
      if (path === '/store/v1/customers/me') return Promise.resolve({ id: 'c1', email: 'a@b.com' });
      if (path === '/store/v1/customers/logout') return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('in'));

    await act(async () => {
      screen.getByText('logout').click();
    });
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('out'));
    expect(screen.getByTestId('token')).toHaveTextContent('');
    expect(request.mock.calls.some((c) => c[1] === '/store/v1/customers/logout')).toBe(true);
  });
});

describe('AuthProvider — changePassword', () => {
  it('POSTs {currentPassword,newPassword} to /me/password and swaps in the returned token (session survives)', async () => {
    let body: { currentPassword?: string; newPassword?: string } | undefined;
    request.mockImplementation(
      (
        method: string,
        path: string,
        opts?: { body?: { currentPassword?: string; newPassword?: string } },
      ) => {
        if (path === '/store/v1/customers/refresh')
          return Promise.resolve({ accessToken: 'old-tok' });
        if (path === '/store/v1/customers/me')
          return Promise.resolve({ id: 'c1', email: 'a@b.com' });
        if (path === '/store/v1/customers/me/password' && method === 'post') {
          body = opts?.body;
          // The C1 endpoint rotates the session and returns a FRESH access token; swapping it is the
          // ONLY reason this session survives the "log out everywhere" the endpoint performs.
          return Promise.resolve({ accessToken: 'rotated-tok' });
        }
        return Promise.reject(new Error(`unexpected ${path}`));
      },
    );
    render(
      <AuthProvider>
        <ChangePwProbe />
      </AuthProvider>,
    );
    // Let the mount refresh settle (the probe snapshots `old-tok` only once clicked).
    await waitFor(() =>
      expect(request.mock.calls.some((c) => c[1] === '/store/v1/customers/me')).toBe(true),
    );

    await act(async () => {
      screen.getByText('change-pw').click();
    });

    // The in-memory token is now the rotated one — the next request would still authenticate.
    await waitFor(() => expect(screen.getByTestId('token')).toHaveTextContent('rotated-tok'));
    expect(body).toEqual({ currentPassword: 'old-pw-12chars', newPassword: 'new-pw-12chars' });
    expect(screen.getByTestId('cp-error')).toHaveTextContent('');
  });

  it('propagates a thrown 401 (no oracle) — does NOT swallow it', async () => {
    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/customers/refresh')
        return Promise.resolve({ accessToken: 'old-tok' });
      if (path === '/store/v1/customers/me') return Promise.resolve({ id: 'c1', email: 'a@b.com' });
      if (path === '/store/v1/customers/me/password') return Promise.reject(unauthorized());
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    render(
      <AuthProvider>
        <ChangePwProbe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(request.mock.calls.some((c) => c[1] === '/store/v1/customers/me')).toBe(true),
    );

    await act(async () => {
      screen.getByText('change-pw').click();
    });
    // The rejection bubbled to the caller; the token was NOT swapped.
    await waitFor(() => expect(screen.getByTestId('cp-error')).toHaveTextContent('status:401'));
    expect(screen.getByTestId('token')).toHaveTextContent('old-tok');
  });

  it('propagates a thrown 400 (weak/breached password) — does NOT swallow it', async () => {
    request.mockImplementation((_m: string, path: string) => {
      if (path === '/store/v1/customers/refresh')
        return Promise.resolve({ accessToken: 'old-tok' });
      if (path === '/store/v1/customers/me') return Promise.resolve({ id: 'c1', email: 'a@b.com' });
      if (path === '/store/v1/customers/me/password')
        return Promise.reject(new SovEcomApiError(400, 'Bad Request', undefined));
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    render(
      <AuthProvider>
        <ChangePwProbe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(request.mock.calls.some((c) => c[1] === '/store/v1/customers/me')).toBe(true),
    );

    await act(async () => {
      screen.getByText('change-pw').click();
    });
    await waitFor(() => expect(screen.getByTestId('cp-error')).toHaveTextContent('status:400'));
    expect(screen.getByTestId('token')).toHaveTextContent('old-tok');
  });
});
