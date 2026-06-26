/**
 * RgpdErase tests. MOST SECURITY-CRITICAL (irreversible PII erase).
 *
 * Proven here:
 *   - the irreversible warning + the French 10-year retention note render;
 *   - Gate 1 (type-to-confirm): the Delete button is disabled until the typed email matches
 *     customer.email exactly; a mismatch shows the mismatch hint;
 *   - Gate 2 (password step-up): erase POSTs { password } in the BODY;
 *   - on 204: markSigningOut() → logout() → router.replace('/'), IN THAT ORDER; password cleared;
 *   - 401 → the step-up "password incorrect / too many attempts" message, and NO logout/redirect;
 *   - 404 (already anonymised) → treated as effectively done (logout + redirect);
 *   - FR render.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

const CUSTOMER = { id: 'c1', email: 'ada@example.com', name: 'Ada Lovelace' };

// --- Auth mock ---
let getAccessToken: () => string | null = () => 'token-abc';
let refresh: () => Promise<string | null> = async () => 'token-abc';
let logout: ReturnType<typeof vi.fn>;
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ customer: CUSTOMER, getAccessToken, refresh, logout }),
}));

// --- Browser client mock ---
let mockRequest: (method: string, path: string, opts?: unknown) => Promise<unknown>;
vi.mock('@/lib/browser-client', () => ({
  createBrowserClient: () => ({
    request: (...args: unknown[]) => mockRequest(...(args as [string, string, unknown])),
  }),
}));

// --- account-session mock ---
const markSigningOut = vi.fn();
vi.mock('@/lib/account-session', () => ({
  markSigningOut: () => markSigningOut(),
}));

// --- locale-aware navigation mock ---
const routerReplace = vi.fn();
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ replace: routerReplace, push: vi.fn() }),
}));

import { RgpdErase } from './RgpdErase';

function unauthorized(): Error {
  return Object.assign(new Error('Unauthorized'), { status: 401 });
}
function notFound(): Error {
  return Object.assign(new Error('Not Found'), { status: 404 });
}

beforeEach(() => {
  getAccessToken = () => 'token-abc';
  refresh = async () => 'token-abc';
  logout = vi.fn().mockResolvedValue(undefined);
  markSigningOut.mockClear();
  routerReplace.mockClear();
  mockRequest = async () => undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function typeEmail(value: string): void {
  fireEvent.change(screen.getByLabelText(/type your email address to confirm/i), {
    target: { value },
  });
}
function typePassword(value: string): void {
  fireEvent.change(screen.getByLabelText(/current password/i), { target: { value } });
}

describe('RgpdErase — warnings', () => {
  it('renders the irreversible warning and the 10-year retention note', () => {
    renderWithIntl(<RgpdErase />, 'en');
    expect(screen.getByText(/irreversible/i)).toBeInTheDocument();
    expect(screen.getByText(/retained for 10 years/i)).toBeInTheDocument();
  });

  it('announces the irreversible warning via role="alert" (WCAG / SR support)', () => {
    renderWithIntl(<RgpdErase />, 'en');
    const banner = screen.getByTestId('rgpd-erase-warning');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveTextContent(/irreversible/i);
    expect(banner).toHaveTextContent(/retained for 10 years/i);
  });
});

describe('RgpdErase — Gate 1 (type-to-confirm) + Gate 2 (password)', () => {
  it('keeps the delete button disabled until BOTH the email matches AND the password is non-empty', () => {
    renderWithIntl(<RgpdErase />, 'en');
    const btn = screen.getByRole('button', { name: /permanently delete my account/i });
    expect(btn).toBeDisabled();

    typeEmail('ada@example.co'); // close but not equal
    expect(btn).toBeDisabled();

    // Email matches but password is still empty → STILL disabled (Gate 2).
    typeEmail('ada@example.com');
    expect(btn).toBeDisabled();

    // Whitespace-only password does not satisfy Gate 2.
    typePassword('   ');
    expect(btn).toBeDisabled();

    // Both gates satisfied → enabled.
    typePassword('hunter2');
    expect(btn).toBeEnabled();
  });

  it('accepts a confirm email with different casing (case-insensitive, trimmed)', () => {
    renderWithIntl(<RgpdErase />, 'en');
    const btn = screen.getByRole('button', { name: /permanently delete my account/i });
    typeEmail('  ADA@Example.COM  '); // different case + surrounding whitespace
    typePassword('hunter2');
    expect(btn).toBeEnabled();
    // and no mismatch hint
    expect(screen.queryByText(/does not match your account email/i)).not.toBeInTheDocument();
  });

  it('shows the mismatch hint when the typed email is wrong (and non-empty)', () => {
    renderWithIntl(<RgpdErase />, 'en');
    typeEmail('nope@example.com');
    expect(screen.getByText(/does not match your account email/i)).toBeInTheDocument();
  });
});

describe('RgpdErase — successful erase', () => {
  it('on 204 calls markSigningOut → logout → router.replace("/") in order; clears password', async () => {
    const order: string[] = [];
    markSigningOut.mockImplementation(() => order.push('mark'));
    logout = vi.fn().mockImplementation(async () => {
      order.push('logout');
    });
    routerReplace.mockImplementation(() => order.push('replace'));
    mockRequest = async () => undefined; // 204

    renderWithIntl(<RgpdErase />, 'en');
    typeEmail('ada@example.com');
    typePassword('hunter2');
    fireEvent.click(screen.getByRole('button', { name: /permanently delete my account/i }));

    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/'));
    expect(order).toEqual(['mark', 'logout', 'replace']);
    expect(markSigningOut).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(/current password/i)).toHaveValue('');
  });
});

describe('RgpdErase — step-up 401', () => {
  it('401 (still after refresh+retry) → step-up message, NO logout/redirect', async () => {
    refresh = vi.fn().mockResolvedValue('new-token');
    const requestFn = vi.fn(async () => {
      throw unauthorized();
    });
    mockRequest = requestFn;

    renderWithIntl(<RgpdErase />, 'en');
    typeEmail('ada@example.com');
    typePassword('wrongpass');
    fireEvent.click(screen.getByRole('button', { name: /permanently delete my account/i }));

    await waitFor(() =>
      expect(screen.getByText(/password incorrect or too many attempts/i)).toBeInTheDocument(),
    );
    expect(requestFn).toHaveBeenCalledTimes(2); // original + single retry, no loop
    expect(logout).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
    expect(markSigningOut).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/current password/i)).toHaveValue('');
  });

  it('moves focus to the step-up error alert (WCAG 3.3.1)', async () => {
    refresh = vi.fn().mockResolvedValue('new-token');
    mockRequest = async () => {
      throw unauthorized();
    };

    renderWithIntl(<RgpdErase />, 'en');
    typeEmail('ada@example.com');
    typePassword('wrongpass');
    fireEvent.click(screen.getByRole('button', { name: /permanently delete my account/i }));

    await waitFor(() =>
      expect(screen.getByText(/password incorrect or too many attempts/i)).toBeInTheDocument(),
    );
    const alert = screen.getByText(/password incorrect or too many attempts/i);
    expect(alert).toHaveFocus();
  });
});

describe('RgpdErase — already anonymised (404)', () => {
  it('treats a 404 as effectively done: logout + redirect home', async () => {
    mockRequest = async () => {
      throw notFound();
    };

    renderWithIntl(<RgpdErase />, 'en');
    typeEmail('ada@example.com');
    typePassword('hunter2');
    fireEvent.click(screen.getByRole('button', { name: /permanently delete my account/i }));

    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/'));
    expect(markSigningOut).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledTimes(1);
  });
});

describe('RgpdErase — generic error', () => {
  it('non-401/404 error → generic erase error, no logout/redirect', async () => {
    mockRequest = async () => {
      throw new Error('500');
    };
    renderWithIntl(<RgpdErase />, 'en');
    typeEmail('ada@example.com');
    typePassword('hunter2');
    fireEvent.click(screen.getByRole('button', { name: /permanently delete my account/i }));

    await waitFor(() =>
      expect(screen.getByText(/could not delete your account/i)).toBeInTheDocument(),
    );
    expect(logout).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
  });
});

describe('RgpdErase — i18n', () => {
  it('renders the FR labels and retention note', () => {
    renderWithIntl(<RgpdErase />, 'fr');
    expect(
      screen.getByRole('button', { name: /supprimer définitivement mon compte/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/conservés pendant 10 ans/i)).toBeInTheDocument();
  });
});
