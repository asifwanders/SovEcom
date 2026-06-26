/**
 * ChangePasswordForm tests. AUTH/CREDENTIAL-CRITICAL.
 *
 * Mirrors the RgpdExport/ProfileEditForm harness:
 *   - vi.mock('@/lib/auth-context') with { useAuth } exposing changePassword + refresh;
 *   - renderWithIntl from @/test-intl; fireEvent (no user-event).
 *
 * Proven here:
 *   - happy path: all three fields → changePassword(current, new) called once → success → fields cleared;
 *   - client validation: new < 12 chars → inline error, API NOT called; confirm mismatch → same;
 *   - 401 step-up: first call 401 → refresh() ONCE → retry → second 401 → step-up message (no loop);
 *   - 400: weak/common password message;
 *   - all three fields are type="password" and cleared after submit.
 *
 * The new password is a SECRET — it lives only in React state and must be cleared after every submit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

// --- Auth mock ---
let changePassword: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
let refresh: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue('new-token');

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ changePassword, refresh }),
}));

import { ChangePasswordForm } from './ChangePasswordForm';

const VALID_NEW = 'new-password-12+'; // ≥ 12 chars

beforeEach(() => {
  changePassword = vi.fn().mockResolvedValue(undefined);
  refresh = vi.fn().mockResolvedValue('new-token');
});

function unauthorized(): Error {
  return Object.assign(new Error('Unauthorized'), { status: 401 });
}
function badRequest(): Error {
  return Object.assign(new Error('Bad Request'), { status: 400 });
}

function fill(current: string, next: string, confirm: string): void {
  fireEvent.change(screen.getByLabelText(/^current password$/i), { target: { value: current } });
  fireEvent.change(screen.getByLabelText(/^new password$/i), { target: { value: next } });
  fireEvent.change(screen.getByLabelText(/^confirm new password$/i), {
    target: { value: confirm },
  });
}

function submit(): void {
  // Locale-agnostic: submit the form element directly (the only submit button lives inside it), so this
  // helper works under both 'en' and 'fr' without hard-coding the localized button label.
  fireEvent.submit(screen.getByRole('button').closest('form')!);
}

// 1025-char string — one past the 1024 max the DTO enforces server-side.
const TOO_LONG = 'a'.repeat(1025);

describe('ChangePasswordForm — happy path', () => {
  it('calls changePassword(current, new) once, shows success, and clears all fields', async () => {
    renderWithIntl(<ChangePasswordForm />, 'en');
    fill('current-pw-12', VALID_NEW, VALID_NEW);

    await act(async () => {
      submit();
    });

    await waitFor(() => expect(changePassword).toHaveBeenCalledOnce());
    expect(changePassword).toHaveBeenCalledWith('current-pw-12', VALID_NEW);
    expect(screen.getByRole('status')).toHaveTextContent(/password has been changed/i);

    // SECURITY: every field cleared after a successful submit (no secret left in state/DOM).
    expect(screen.getByLabelText(/^current password$/i)).toHaveValue('');
    expect(screen.getByLabelText(/^new password$/i)).toHaveValue('');
    expect(screen.getByLabelText(/^confirm new password$/i)).toHaveValue('');
  });
});

describe('ChangePasswordForm — client-side validation', () => {
  it('new password shorter than 12 chars → inline error, API NOT called', async () => {
    renderWithIntl(<ChangePasswordForm />, 'en');
    fill('current-pw-12', 'short', 'short');

    await act(async () => {
      submit();
    });

    expect(changePassword).not.toHaveBeenCalled();
    expect(screen.getByText(/at least 12 characters/i)).toBeInTheDocument();
  });

  it('confirm not equal to new → inline error, API NOT called', async () => {
    renderWithIntl(<ChangePasswordForm />, 'en');
    fill('current-pw-12', VALID_NEW, 'different-12+chars');

    await act(async () => {
      submit();
    });

    expect(changePassword).not.toHaveBeenCalled();
    expect(screen.getByText(/do not match/i)).toBeInTheDocument();
  });

  it('empty current password → inline error first, API NOT called (NIT 2)', async () => {
    renderWithIntl(<ChangePasswordForm />, 'en');
    // Leave current blank but fill valid new/confirm — the current-required check must fire FIRST.
    fill('   ', VALID_NEW, VALID_NEW);

    await act(async () => {
      submit();
    });

    expect(changePassword).not.toHaveBeenCalled();
    expect(screen.getByText(/enter your current password/i)).toBeInTheDocument();
  });

  it('new password longer than 1024 chars → inline error, API NOT called (NIT 1)', async () => {
    renderWithIntl(<ChangePasswordForm />, 'en');
    fill('current-pw-12', TOO_LONG, TOO_LONG);

    await act(async () => {
      submit();
    });

    expect(changePassword).not.toHaveBeenCalled();
    expect(screen.getByText(/at most 1024 characters/i)).toBeInTheDocument();
  });
});

describe('ChangePasswordForm — step-up 401', () => {
  it('first 401 → refresh() once → retry → second 401 → step-up message (no loop), fields cleared', async () => {
    changePassword = vi.fn().mockRejectedValue(unauthorized());
    const refreshFn = vi.fn().mockResolvedValue('new-token');
    refresh = refreshFn;

    renderWithIntl(<ChangePasswordForm />, 'en');
    fill('wrong-current12', VALID_NEW, VALID_NEW);

    await act(async () => {
      submit();
    });

    await waitFor(() =>
      expect(screen.getByText(/password incorrect or too many attempts/i)).toBeInTheDocument(),
    );
    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(changePassword).toHaveBeenCalledTimes(2); // original + single retry, never a loop
    // password fields cleared even on error
    expect(screen.getByLabelText(/^current password$/i)).toHaveValue('');
    expect(screen.getByLabelText(/^new password$/i)).toHaveValue('');
  });

  it('first 401 → refresh() once → retry RESOLVES → success + fields cleared (NIT 3)', async () => {
    // The recovery path the step-up exists for: a stale token 401s, refresh mints a new one, the
    // retried change succeeds. refresh exactly once, change exactly twice, SUCCESS banner shown.
    const changeFn = vi.fn().mockRejectedValueOnce(unauthorized()).mockResolvedValueOnce(undefined);
    changePassword = changeFn;
    const refreshFn = vi.fn().mockResolvedValue('new-token');
    refresh = refreshFn;

    renderWithIntl(<ChangePasswordForm />, 'en');
    fill('current-pw-12', VALID_NEW, VALID_NEW);

    await act(async () => {
      submit();
    });

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/password has been changed/i),
    );
    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(changeFn).toHaveBeenCalledTimes(2);
    // no step-up banner, fields cleared
    expect(screen.queryByText(/too many attempts/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^new password$/i)).toHaveValue('');
  });

  it('first 401 → refresh() once → retry rejects 400 → WEAK banner, not step-up (NIT 4)', async () => {
    const changeFn = vi
      .fn()
      .mockRejectedValueOnce(unauthorized())
      .mockRejectedValueOnce(badRequest());
    changePassword = changeFn;
    refresh = vi.fn().mockResolvedValue('new-token');

    renderWithIntl(<ChangePasswordForm />, 'en');
    fill('current-pw-12', VALID_NEW, VALID_NEW);

    await act(async () => {
      submit();
    });

    await waitFor(() =>
      expect(screen.getByText(/too common|easy to guess|choose a stronger/i)).toBeInTheDocument(),
    );
    expect(changeFn).toHaveBeenCalledTimes(2);
    // weak path, NOT the step-up message
    expect(screen.queryByText(/too many attempts/i)).not.toBeInTheDocument();
  });

  it('first 401 → refresh() THROWS → step-up message, retry never runs', async () => {
    changePassword = vi.fn().mockRejectedValue(unauthorized());
    refresh = vi.fn().mockRejectedValue(new Error('network down'));

    renderWithIntl(<ChangePasswordForm />, 'en');
    fill('wrong-current12', VALID_NEW, VALID_NEW);

    await act(async () => {
      submit();
    });

    await waitFor(() =>
      expect(screen.getByText(/password incorrect or too many attempts/i)).toBeInTheDocument(),
    );
    expect(changePassword).toHaveBeenCalledTimes(1);
  });
});

describe('ChangePasswordForm — 400 weak password', () => {
  it('400 → weak/common password message', async () => {
    changePassword = vi.fn().mockRejectedValue(badRequest());

    renderWithIntl(<ChangePasswordForm />, 'en');
    fill('current-pw-12', VALID_NEW, VALID_NEW);

    await act(async () => {
      submit();
    });

    await waitFor(() =>
      expect(screen.getByText(/too common|easy to guess|choose a stronger/i)).toBeInTheDocument(),
    );
    // not the 401 step-up message
    expect(screen.queryByText(/too many attempts/i)).not.toBeInTheDocument();
  });
});

describe('ChangePasswordForm — security posture', () => {
  it('all three fields are type="password" and cleared after submit', async () => {
    renderWithIntl(<ChangePasswordForm />, 'en');
    const current = screen.getByLabelText(/^current password$/i);
    const next = screen.getByLabelText(/^new password$/i);
    const confirm = screen.getByLabelText(/^confirm new password$/i);

    expect(current).toHaveAttribute('type', 'password');
    expect(next).toHaveAttribute('type', 'password');
    expect(confirm).toHaveAttribute('type', 'password');

    fill('current-pw-12', VALID_NEW, VALID_NEW);
    await act(async () => {
      submit();
    });

    await waitFor(() => expect(changePassword).toHaveBeenCalledOnce());
    expect(current).toHaveValue('');
    expect(next).toHaveValue('');
    expect(confirm).toHaveValue('');
  });
});

describe('ChangePasswordForm — FR locale', () => {
  it('renders the form in French', () => {
    renderWithIntl(<ChangePasswordForm />, 'fr');
    expect(screen.getByRole('button', { name: /changer le mot de passe/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^mot de passe actuel$/i)).toBeInTheDocument();
  });

  it('resolves an FR ERROR string on the client min-12 path (NIT 5)', async () => {
    renderWithIntl(<ChangePasswordForm />, 'fr');
    // Trigger the min-12 client error in French and assert the FR `errorTooShort` text resolves.
    fireEvent.change(screen.getByLabelText(/^mot de passe actuel$/i), {
      target: { value: 'actuel-12char' },
    });
    fireEvent.change(screen.getByLabelText(/^nouveau mot de passe$/i), {
      target: { value: 'court' },
    });
    fireEvent.change(screen.getByLabelText(/^confirmer le nouveau mot de passe$/i), {
      target: { value: 'court' },
    });

    await act(async () => {
      submit();
    });

    expect(changePassword).not.toHaveBeenCalled();
    expect(screen.getByText(/au moins 12 caractères/i)).toBeInTheDocument();
  });

  it('resolves the FR step-up ERROR string on a 401 (NIT 5)', async () => {
    changePassword = vi.fn().mockRejectedValue(unauthorized());
    refresh = vi.fn().mockRejectedValue(new Error('network down'));

    renderWithIntl(<ChangePasswordForm />, 'fr');
    fireEvent.change(screen.getByLabelText(/^mot de passe actuel$/i), {
      target: { value: 'actuel-12char' },
    });
    fireEvent.change(screen.getByLabelText(/^nouveau mot de passe$/i), {
      target: { value: VALID_NEW },
    });
    fireEvent.change(screen.getByLabelText(/^confirmer le nouveau mot de passe$/i), {
      target: { value: VALID_NEW },
    });

    await act(async () => {
      submit();
    });

    await waitFor(() =>
      expect(screen.getByText(/mot de passe incorrect ou trop de tentatives/i)).toBeInTheDocument(),
    );
  });
});
