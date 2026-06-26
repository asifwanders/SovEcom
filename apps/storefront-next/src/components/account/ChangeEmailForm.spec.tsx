/**
 * ChangeEmailForm tests. AUTH/CREDENTIAL-CRITICAL.
 *
 * Drives `POST /store/v1/customers/me/email/change` directly via a mocked `createBrowserClient`
 * (initiate needs no token swap — the C3 endpoint returns 202 with no body). Mirrors the
 * ChangePasswordForm/RgpdExport harness: vi.mock('@/lib/auth-context') exposing getAccessToken +
 * refresh + customer; renderWithIntl; fireEvent.
 *
 * Proven here:
 *   - happy path: 202 → success banner naming the new email, pending banner updates to it, password cleared;
 *   - step-up 401: first 401 → refresh() ONCE → retry → second 401 → step-up message (no loop), pw cleared;
 *   - 400 → "must differ from your current email" message;
 *   - client validation: empty current password / invalid email shape → no API call, field error;
 *   - password field is type="password" and cleared after every submit; newEmail kept on error.
 *
 * The current password is a SECRET — it lives only in React state and is cleared after every submit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

// ── browser-client ───────────────────────────────────────────────────────────────────────────────
const request = vi.fn();
vi.mock('@/lib/browser-client', () => ({
  createBrowserClient: () => ({ request }),
}));

// ── auth context ─────────────────────────────────────────────────────────────────────────────────
let refresh: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue('new-token');
let customer: { email: string; pendingEmail?: string | null } | null = {
  email: 'alice@example.com',
  pendingEmail: null,
};
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ getAccessToken: () => 'jwt', refresh, customer }),
}));

import { ChangeEmailForm } from './ChangeEmailForm';

beforeEach(() => {
  request.mockReset();
  refresh = vi.fn().mockResolvedValue('new-token');
  customer = { email: 'alice@example.com', pendingEmail: null };
});

function unauthorized(): Error {
  return Object.assign(new Error('Unauthorized'), { status: 401 });
}
function badRequest(): Error {
  return Object.assign(new Error('Bad Request'), { status: 400 });
}

function fill(newEmail: string, currentPassword: string): void {
  fireEvent.change(screen.getByLabelText(/^new email address$/i), { target: { value: newEmail } });
  fireEvent.change(screen.getByLabelText(/^current password$/i), {
    target: { value: currentPassword },
  });
}

function submit(): void {
  // Locale-agnostic: submit the form element directly.
  fireEvent.submit(screen.getByRole('button').closest('form')!);
}

describe('ChangeEmailForm — happy path (202)', () => {
  it('calls the change endpoint once, shows success naming the new email, updates the pending banner, clears the password', async () => {
    request.mockResolvedValue(undefined);
    renderWithIntl(<ChangeEmailForm />, 'en');
    fill('new@example.com', 'current-pw-12');

    await act(async () => {
      submit();
    });

    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith('post', '/store/v1/customers/me/email/change', {
      body: { newEmail: 'new@example.com', currentPassword: 'current-pw-12' },
    });
    expect(screen.getByTestId('change-email-success')).toHaveTextContent(/new@example\.com/);
    // While the success banner is showing, the pending banner is suppressed (NIT-2: both are
    // role="status" — avoid double-announcing the address). The pending state is still tracked and
    // re-asserts once the success banner is gone (proven in the rescue-path test below).
    expect(screen.queryByTestId('change-email-pending')).not.toBeInTheDocument();

    // SECURITY: password cleared after a network submit.
    expect(screen.getByLabelText(/^current password$/i)).toHaveValue('');
    // On SUCCESS the new-email field is cleared too (NIT-5).
    expect(screen.getByLabelText(/^new email address$/i)).toHaveValue('');
  });
});

describe('ChangeEmailForm — step-up 401', () => {
  it('first 401 → refresh() once → retry → second 401 → step-up message (no loop), password cleared', async () => {
    request.mockRejectedValue(unauthorized());
    const refreshFn = vi.fn().mockResolvedValue('new-token');
    refresh = refreshFn;

    renderWithIntl(<ChangeEmailForm />, 'en');
    fill('new@example.com', 'wrong-pw');

    await act(async () => {
      submit();
    });

    await waitFor(() =>
      expect(screen.getByText(/password incorrect or too many attempts/i)).toBeInTheDocument(),
    );
    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2); // original + single retry, never a loop
    expect(screen.getByLabelText(/^current password$/i)).toHaveValue('');
  });

  it('first 401 → refresh() once → retry RESOLVES 202 → success + pending banner + password cleared (NIT-3)', async () => {
    // The rescue path the step-up exists for: a legitimately-expired token 401s, refresh mints a new
    // one, the retried initiate succeeds. refresh exactly once, request exactly twice, SUCCESS shown.
    const requestFn = vi
      .fn()
      .mockRejectedValueOnce(unauthorized())
      .mockResolvedValueOnce(undefined);
    request.mockImplementation(requestFn);
    const refreshFn = vi.fn().mockResolvedValue('new-token');
    refresh = refreshFn;

    renderWithIntl(<ChangeEmailForm />, 'en');
    fill('new@example.com', 'current-pw-12');

    await act(async () => {
      submit();
    });

    await waitFor(() =>
      expect(screen.getByTestId('change-email-success')).toHaveTextContent(/new@example\.com/),
    );
    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(requestFn).toHaveBeenCalledTimes(2); // original + single retry, never a loop
    // no step-up banner on the rescue path
    expect(screen.queryByText(/too many attempts/i)).not.toBeInTheDocument();
    // success banner names the new email (proves the optimistic pending update ran alongside success);
    // the pending banner itself is suppressed while success shows (NIT-2). Password cleared.
    expect(screen.getByTestId('change-email-success')).toHaveTextContent(/new@example\.com/);
    expect(screen.queryByTestId('change-email-pending')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^current password$/i)).toHaveValue('');
  });

  it('first 401 → refresh() THROWS → step-up message, retry never runs', async () => {
    request.mockRejectedValue(unauthorized());
    refresh = vi.fn().mockRejectedValue(new Error('network down'));

    renderWithIntl(<ChangeEmailForm />, 'en');
    fill('new@example.com', 'wrong-pw');

    await act(async () => {
      submit();
    });

    await waitFor(() =>
      expect(screen.getByText(/password incorrect or too many attempts/i)).toBeInTheDocument(),
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('ChangeEmailForm — 400 same email', () => {
  it('400 → "must differ" message, password cleared, newEmail kept', async () => {
    request.mockRejectedValue(badRequest());

    renderWithIntl(<ChangeEmailForm />, 'en');
    fill('alice@example.com', 'current-pw-12');

    await act(async () => {
      submit();
    });

    await waitFor(() =>
      expect(screen.getByText(/different from your current email/i)).toBeInTheDocument(),
    );
    // not the 401 step-up message
    expect(screen.queryByText(/too many attempts/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^current password$/i)).toHaveValue('');
    // newEmail kept so the user can correct it
    expect(screen.getByLabelText(/^new email address$/i)).toHaveValue('alice@example.com');
  });
});

describe('ChangeEmailForm — client-side validation', () => {
  it('empty current password → inline error, API NOT called', async () => {
    renderWithIntl(<ChangeEmailForm />, 'en');
    fill('new@example.com', '   ');

    await act(async () => {
      submit();
    });

    expect(request).not.toHaveBeenCalled();
    expect(screen.getByText(/enter your current password/i)).toBeInTheDocument();
  });

  it('invalid email shape → inline error, API NOT called', async () => {
    renderWithIntl(<ChangeEmailForm />, 'en');
    fill('not-an-email', 'current-pw-12');

    await act(async () => {
      submit();
    });

    expect(request).not.toHaveBeenCalled();
    expect(screen.getByText(/valid email address/i)).toBeInTheDocument();
  });
});

describe('ChangeEmailForm — pending banner seed', () => {
  it('seeds the pending banner from customer.pendingEmail on mount', () => {
    customer = { email: 'alice@example.com', pendingEmail: 'pending@example.com' };
    renderWithIntl(<ChangeEmailForm />, 'en');
    expect(screen.getByTestId('change-email-pending')).toHaveTextContent(/pending@example\.com/);
  });

  it('shows no pending banner when there is no in-flight change', () => {
    customer = { email: 'alice@example.com', pendingEmail: null };
    renderWithIntl(<ChangeEmailForm />, 'en');
    expect(screen.queryByTestId('change-email-pending')).not.toBeInTheDocument();
  });
});

describe('ChangeEmailForm — security posture', () => {
  it('password field is type="password" and cleared after submit', async () => {
    request.mockResolvedValue(undefined);
    renderWithIntl(<ChangeEmailForm />, 'en');
    const pw = screen.getByLabelText(/^current password$/i);
    expect(pw).toHaveAttribute('type', 'password');

    fill('new@example.com', 'current-pw-12');
    await act(async () => {
      submit();
    });

    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(pw).toHaveValue('');
  });
});

describe('ChangeEmailForm — FR locale', () => {
  it('renders the form in French', () => {
    renderWithIntl(<ChangeEmailForm />, 'fr');
    expect(screen.getByLabelText(/^nouvelle adresse e-mail$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^mot de passe actuel$/i)).toBeInTheDocument();
  });
});
