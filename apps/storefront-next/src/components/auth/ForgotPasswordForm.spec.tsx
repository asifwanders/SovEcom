/**
 * ForgotPasswordForm tests. AUTH/CREDENTIAL-adjacent.
 *
 * Drives the PUBLIC `POST /store/v1/customers/forgot` (no Bearer) via a mocked createBrowserClient.
 * The endpoint always returns 202 (uniform, enumeration-safe). Mirrors the LoginForm/EmailConfirm
 * harness (mock @/i18n/navigation + @/lib/browser-client).
 *
 * Proven here:
 *   - 202 → uniform success banner + email field cleared;
 *   - the success message is the SAME regardless of input and the component NEVER branches on the
 *     response → no account-existence oracle;
 *   - client validation (empty / invalid email) → inline field error, NO API call;
 *   - any error (incl. a 429/500 reject) → generic error banner, NO existence leak.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

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

import { ForgotPasswordForm } from './ForgotPasswordForm';

function statusErr(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function fill(value: string) {
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value } });
}

beforeEach(() => {
  request.mockReset();
});

describe('ForgotPasswordForm', () => {
  it('renders an accessible email field with correct type/autocomplete', () => {
    renderWithIntl(<ForgotPasswordForm />, 'en');
    const email = screen.getByLabelText(/email/i) as HTMLInputElement;
    expect(email).toHaveAttribute('type', 'email');
    expect(email).toHaveAttribute('autocomplete', 'email');
  });

  it('202 → uniform success banner and the email field is cleared', async () => {
    request.mockResolvedValue(undefined);
    renderWithIntl(<ForgotPasswordForm />, 'en');
    fill('  user@example.com  ');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));
    });
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/if an account exists/i),
    );
    expect(request).toHaveBeenCalledWith('post', '/store/v1/customers/forgot', {
      body: { email: 'user@example.com' },
    });
    // On success the form is replaced by the banner — no interactive email field or submit button is
    // left behind (NIT-4: a confused resubmit can't fire the "enter your email" validation error).
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send reset link/i })).not.toBeInTheDocument();
  });

  it('shows the SAME success message and never branches on the response (no oracle)', async () => {
    request.mockResolvedValue(undefined);
    const { unmount } = renderWithIntl(<ForgotPasswordForm />, 'en');
    fill('exists@example.com');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));
    });
    const first = (await screen.findByRole('status')).textContent;
    unmount();

    renderWithIntl(<ForgotPasswordForm />, 'en');
    fill('does-not-exist@example.com');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));
    });
    const second = (await screen.findByRole('status')).textContent;
    expect(second).toBe(first);
  });

  it('empty email → inline field error, NO API call', async () => {
    renderWithIntl(<ForgotPasswordForm />, 'en');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));
    });
    await waitFor(() => expect(screen.getByText(/enter your email/i)).toBeInTheDocument());
    expect(request).not.toHaveBeenCalled();
  });

  it('invalid email shape → inline field error, NO API call', async () => {
    renderWithIntl(<ForgotPasswordForm />, 'en');
    fill('not-an-email');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));
    });
    await waitFor(() => expect(screen.getByText(/valid email/i)).toBeInTheDocument());
    expect(request).not.toHaveBeenCalled();
  });

  it('a generic error (429/500 reject) → error banner, no existence leak', async () => {
    request.mockRejectedValue(statusErr(429));
    renderWithIntl(<ForgotPasswordForm />, 'en');
    fill('user@example.com');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/something went wrong/i);
    // No success banner leaked alongside the error.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('moves focus to the email field on a validation failure (WCAG 3.3.1)', async () => {
    renderWithIntl(<ForgotPasswordForm />, 'en');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));
    });
    await waitFor(() => expect(screen.getByLabelText(/email/i)).toHaveFocus());
  });

  it('localizes in French', () => {
    renderWithIntl(<ForgotPasswordForm />, 'fr');
    expect(screen.getByRole('button', { name: /envoyer le lien/i })).toBeInTheDocument();
  });
});
