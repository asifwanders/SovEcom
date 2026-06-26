import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

// Locale-aware router + Link mocks (mirror SearchBar.spec convention).
const replace = vi.fn();
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ replace }),
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

// The auth context — drive `login` per test.
const login = vi.fn<(email: string, password: string) => Promise<void>>();
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ login }),
}));

import { LoginForm } from './LoginForm';

function fill(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  replace.mockReset();
  login.mockReset();
  login.mockResolvedValue();
});

describe('LoginForm', () => {
  it('renders accessible email + password fields with correct autocomplete', () => {
    renderWithIntl(<LoginForm />, 'en');
    const email = screen.getByLabelText(/email/i) as HTMLInputElement;
    const password = screen.getByLabelText(/^password$/i) as HTMLInputElement;
    expect(email).toHaveAttribute('type', 'email');
    expect(email).toHaveAttribute('autocomplete', 'username');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'current-password');
  });

  it('validates required + email format before calling login', async () => {
    renderWithIntl(<LoginForm />, 'en');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(screen.getByText(/enter your email/i)).toBeInTheDocument());
    expect(login).not.toHaveBeenCalled();

    fill(/email/i, 'not-an-email');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(screen.getByText(/valid email/i)).toBeInTheDocument());
    expect(login).not.toHaveBeenCalled();
  });

  it('calls login with the entered credentials and redirects on success', async () => {
    renderWithIntl(<LoginForm />, 'en');
    fill(/email/i, '  user@example.com  ');
    fill(/^password$/i, 'a-good-password');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });
    await waitFor(() => expect(login).toHaveBeenCalledWith('user@example.com', 'a-good-password'));
    expect(replace).toHaveBeenCalledWith('/');
  });

  it('redirects to a SAFE returnTo path on success', async () => {
    renderWithIntl(<LoginForm returnTo="/checkout" />, 'en');
    fill(/email/i, 'user@example.com');
    fill(/^password$/i, 'a-good-password');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/checkout'));
  });

  it('ignores an unsafe (external) returnTo and falls back to home', async () => {
    renderWithIntl(<LoginForm returnTo="https://evil.com" />, 'en');
    fill(/email/i, 'user@example.com');
    fill(/^password$/i, 'a-good-password');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
  });

  it('shows a GENERIC enumeration-safe error on any login failure (no field-specific leak)', async () => {
    login.mockRejectedValue(new Error('wrong password'));
    renderWithIntl(<LoginForm />, 'en');
    fill(/email/i, 'user@example.com');
    fill(/^password$/i, 'wrong-password-x');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/invalid email or password/i);
    expect(replace).not.toHaveBeenCalled();
    // Re-enabled after failure so the user can retry.
    expect(screen.getByRole('button', { name: /sign in/i })).not.toBeDisabled();
  });

  it('disables the submit button while pending and does not double-submit', async () => {
    let resolveLogin: () => void = () => {};
    login.mockImplementation(() => new Promise<void>((r) => (resolveLogin = r)));
    renderWithIntl(<LoginForm />, 'en');
    fill(/email/i, 'user@example.com');
    fill(/^password$/i, 'a-good-password');
    const button = screen.getByRole('button', { name: /sign in/i });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled();
    // A second click while pending must not fire another login.
    fireEvent.click(button);
    expect(login).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveLogin();
    });
  });

  it('moves focus to the first invalid field on a validation failure (WCAG 3.3.1)', async () => {
    renderWithIntl(<LoginForm />, 'en');
    // Email empty → email is the first invalid field and must receive focus.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });
    await waitFor(() => expect(screen.getByLabelText(/email/i)).toHaveFocus());
  });

  it('moves focus to the form-error banner on a credentials failure', async () => {
    login.mockRejectedValue(new Error('bad'));
    renderWithIntl(<LoginForm />, 'en');
    fill(/email/i, 'user@example.com');
    fill(/^password$/i, 'wrong-password-x');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus());
  });

  it('surfaces the "account created — please sign in" notice when redirected from register', () => {
    renderWithIntl(<LoginForm notice="account-created" />, 'en');
    expect(screen.getByRole('status')).toHaveTextContent(/account was created/i);
  });

  it('localizes in French', () => {
    renderWithIntl(<LoginForm />, 'fr');
    expect(screen.getByRole('button', { name: /se connecter/i })).toBeInTheDocument();
  });
});
