/**
 * ResetPasswordForm tests. AUTH/CREDENTIAL-CRITICAL.
 *
 * Drives the PUBLIC `POST /store/v1/customers/reset` (no Bearer) via a mocked createBrowserClient.
 * The token comes from `useSearchParams()`. Mirrors the EmailConfirmClient harness.
 *
 * Proven here:
 *   - missing/empty token → invalidLink state, NO form rendered, NO API call;
 *   - valid token + good password → 204 → success + a sign-in link;
 *   - 400 → the COMBINED honest resetError message (expired-link OR breached-password);
 *   - other (429) → generic error;
 *   - client validation (too short / mismatch) → inline field error, NO API call;
 *   - both fields are type=password and are cleared after every submit; the token is never rendered.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

let searchParams = new URLSearchParams('token=tok-abc');
vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParams,
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

const request = vi.fn();
vi.mock('@/lib/browser-client', () => ({
  createBrowserClient: () => ({ request }),
}));

import { ResetPasswordForm } from './ResetPasswordForm';

function statusErr(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function fill(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  request.mockReset();
  searchParams = new URLSearchParams('token=tok-abc');
});

describe('ResetPasswordForm', () => {
  it('missing token → invalidLink state, NO form and NO API call', () => {
    searchParams = new URLSearchParams('');
    renderWithIntl(<ResetPasswordForm />, 'en');
    expect(screen.getByText(/link is invalid or has expired/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/new password/i)).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });

  it('empty token param → invalidLink state, NO form and NO API call', () => {
    searchParams = new URLSearchParams('token=');
    renderWithIntl(<ResetPasswordForm />, 'en');
    expect(screen.getByText(/link is invalid or has expired/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/new password/i)).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });

  it('renders two password fields with correct type/autocomplete when a token is present', () => {
    renderWithIntl(<ResetPasswordForm />, 'en');
    const next = screen.getByLabelText(/^new password$/i) as HTMLInputElement;
    const confirm = screen.getByLabelText(/confirm new password/i) as HTMLInputElement;
    expect(next).toHaveAttribute('type', 'password');
    expect(next).toHaveAttribute('autocomplete', 'new-password');
    expect(confirm).toHaveAttribute('type', 'password');
    expect(confirm).toHaveAttribute('autocomplete', 'new-password');
  });

  it('valid token + good password → 204 → success state with a sign-in link', async () => {
    request.mockResolvedValue(undefined);
    renderWithIntl(<ResetPasswordForm />, 'en');
    fill(/^new password$/i, 'a-strong-passphrase');
    fill(/confirm new password/i, 'a-strong-passphrase');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /reset password/i }));
    });
    await waitFor(() =>
      expect(screen.getByText(/your password has been updated/i)).toBeInTheDocument(),
    );
    expect(request).toHaveBeenCalledWith('post', '/store/v1/customers/reset', {
      body: { token: 'tok-abc', newPassword: 'a-strong-passphrase' },
    });
    // the raw token must never be rendered
    expect(screen.queryByText(/tok-abc/)).not.toBeInTheDocument();
  });

  it('moves focus to the success message on a successful reset (WCAG 3.3.1)', async () => {
    request.mockResolvedValue(undefined);
    renderWithIntl(<ResetPasswordForm />, 'en');
    fill(/^new password$/i, 'a-strong-passphrase');
    fill(/confirm new password/i, 'a-strong-passphrase');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /reset password/i }));
    });
    await waitFor(() => expect(screen.getByRole('status')).toHaveFocus());
  });

  it('400 → the COMBINED honest resetError message', async () => {
    request.mockRejectedValue(statusErr(400));
    renderWithIntl(<ResetPasswordForm />, 'en');
    fill(/^new password$/i, 'a-strong-passphrase');
    fill(/confirm new password/i, 'a-strong-passphrase');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /reset password/i }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      /the link may have expired, or your new password is too common/i,
    );
  });

  it('other (429) → generic error', async () => {
    request.mockRejectedValue(statusErr(429));
    renderWithIntl(<ResetPasswordForm />, 'en');
    fill(/^new password$/i, 'a-strong-passphrase');
    fill(/confirm new password/i, 'a-strong-passphrase');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /reset password/i }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/something went wrong/i);
  });

  it('too-short password → inline field error, NO API call', async () => {
    renderWithIntl(<ResetPasswordForm />, 'en');
    fill(/^new password$/i, 'short');
    fill(/confirm new password/i, 'short');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /reset password/i }));
    });
    await waitFor(() => expect(screen.getByText(/at least 12 characters/i)).toBeInTheDocument());
    expect(request).not.toHaveBeenCalled();
  });

  it('too-long password (>1024) → inline field error, NO API call', async () => {
    const long = 'a'.repeat(1025);
    renderWithIntl(<ResetPasswordForm />, 'en');
    fill(/^new password$/i, long);
    fill(/confirm new password/i, long);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /reset password/i }));
    });
    await waitFor(() => expect(screen.getByText(/password is too long/i)).toBeInTheDocument());
    expect(request).not.toHaveBeenCalled();
  });

  it('mismatched confirm → inline field error, NO API call', async () => {
    renderWithIntl(<ResetPasswordForm />, 'en');
    fill(/^new password$/i, 'a-strong-passphrase');
    fill(/confirm new password/i, 'a-different-passphrase');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /reset password/i }));
    });
    await waitFor(() => expect(screen.getByText(/do not match/i)).toBeInTheDocument());
    expect(request).not.toHaveBeenCalled();
  });

  it('clears both password fields after a submit (success or error)', async () => {
    request.mockRejectedValue(statusErr(400));
    renderWithIntl(<ResetPasswordForm />, 'en');
    fill(/^new password$/i, 'a-strong-passphrase');
    fill(/confirm new password/i, 'a-strong-passphrase');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /reset password/i }));
    });
    await screen.findByRole('alert');
    expect((screen.getByLabelText(/^new password$/i) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/confirm new password/i) as HTMLInputElement).value).toBe('');
  });

  it('localizes in French', () => {
    renderWithIntl(<ResetPasswordForm />, 'fr');
    expect(
      screen.getByRole('button', { name: /réinitialiser le mot de passe/i }),
    ).toBeInTheDocument();
  });
});
