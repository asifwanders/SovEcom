import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import { SovEcomApiError } from '@sovecom/client-js';

const replace = vi.fn();
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ replace }),
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

const register =
  vi.fn<(input: { email: string; password: string; name?: string }) => Promise<void>>();
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ register }),
}));

import { RegisterForm } from './RegisterForm';

const GOOD_PASSWORD = 'a-strong-passphrase'; // ≥12 chars

function fill(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  replace.mockReset();
  register.mockReset();
  register.mockResolvedValue();
});

describe('RegisterForm', () => {
  it('renders the password field with new-password autocomplete and min length', () => {
    renderWithIntl(<RegisterForm />, 'en');
    const password = screen.getByLabelText(/^password$/i) as HTMLInputElement;
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'new-password');
    expect(password).toHaveAttribute('minlength', '12');
  });

  it('validates email format + min-12 password before calling register', async () => {
    renderWithIntl(<RegisterForm />, 'en');
    fill(/email/i, 'bad');
    fill(/^password$/i, 'short');
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    await waitFor(() => expect(screen.getByText(/valid email/i)).toBeInTheDocument());
    expect(screen.getByText(/at least 12/i)).toBeInTheDocument();
    expect(register).not.toHaveBeenCalled();
  });

  it('moves focus to the first invalid field on a validation failure (WCAG 3.3.1)', async () => {
    renderWithIntl(<RegisterForm />, 'en');
    // Email present+valid but password too short → focus lands on the password field.
    fill(/email/i, 'new@example.com');
    fill(/^password$/i, 'short');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    });
    await waitFor(() => expect(screen.getByLabelText(/^password$/i)).toHaveFocus());
  });

  it('moves focus to the form-error banner on a server failure (e.g. duplicate)', async () => {
    register.mockRejectedValue(new SovEcomApiError(409, 'Conflict', undefined));
    renderWithIntl(<RegisterForm />, 'en');
    fill(/email/i, 'taken@example.com');
    fill(/^password$/i, GOOD_PASSWORD);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus());
  });

  it('calls register with the entered data and redirects home on full success', async () => {
    renderWithIntl(<RegisterForm />, 'en');
    fill(/email/i, '  new@example.com  ');
    fill(/name/i, '  Ada  ');
    fill(/^password$/i, GOOD_PASSWORD);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    });
    await waitFor(() =>
      expect(register).toHaveBeenCalledWith({
        email: 'new@example.com',
        password: GOOD_PASSWORD,
        name: 'Ada',
      }),
    );
    expect(replace).toHaveBeenCalledWith('/');
  });

  it('signup-ok-but-login-fails (401) → routes to login with the account-created notice', async () => {
    register.mockRejectedValue(new SovEcomApiError(401, 'Unauthorized', undefined));
    renderWithIntl(<RegisterForm />, 'en');
    fill(/email/i, 'new@example.com');
    fill(/^password$/i, GOOD_PASSWORD);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    });
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login?notice=account-created'));
  });

  it('duplicate email (409) → clear non-leaky message, stays on the page', async () => {
    register.mockRejectedValue(new SovEcomApiError(409, 'Conflict', undefined));
    renderWithIntl(<RegisterForm />, 'en');
    fill(/email/i, 'taken@example.com');
    fill(/^password$/i, GOOD_PASSWORD);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/already exists/i);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /create account/i })).not.toBeDisabled();
  });

  it('weak/common password (400) → clear password-strength message', async () => {
    register.mockRejectedValue(new SovEcomApiError(400, 'Bad Request', undefined));
    renderWithIntl(<RegisterForm />, 'en');
    fill(/email/i, 'new@example.com');
    fill(/^password$/i, GOOD_PASSWORD);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/stronger|less common/i);
    expect(replace).not.toHaveBeenCalled();
  });

  it('an unexpected error → generic retry message', async () => {
    register.mockRejectedValue(new SovEcomApiError(500, 'Server Error', undefined));
    renderWithIntl(<RegisterForm />, 'en');
    fill(/email/i, 'new@example.com');
    fill(/^password$/i, GOOD_PASSWORD);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/something went wrong/i);
  });

  it('disables submit while pending (no double-submit)', async () => {
    let resolve: () => void = () => {};
    register.mockImplementation(() => new Promise<void>((r) => (resolve = r)));
    renderWithIntl(<RegisterForm />, 'en');
    fill(/email/i, 'new@example.com');
    fill(/^password$/i, GOOD_PASSWORD);
    const button = screen.getByRole('button', { name: /create account/i });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.getByRole('button', { name: /creating account/i })).toBeDisabled();
    fireEvent.click(button);
    expect(register).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve();
    });
  });

  it('localizes in French', () => {
    renderWithIntl(<RegisterForm />, 'fr');
    expect(screen.getByRole('button', { name: /créer le compte/i })).toBeInTheDocument();
  });
});
