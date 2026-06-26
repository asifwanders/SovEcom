/**
 * ProfileEditForm component tests.
 *
 * Mirrors the AddressBook/OrderDetail pattern:
 *   - vi.mock('@/lib/auth-context') with { useAuth }
 *   - renderWithIntl from @/test-intl
 *   - fireEvent (no user-event)
 *
 * Covers:
 *   - prefill from customer (name / phone / vatNumber / acceptsMarketing)
 *   - email shown read-only (not an input)
 *   - VAT field hidden when !isB2b, shown when isB2b
 *   - submit calls updateProfile with the edited fields
 *   - success role=status shown after save
 *   - save error → role=alert banner
 *   - 401 → refresh() → retry succeeds
 *   - 401 → refresh() rejects → error banner
 *   - FR locale render
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

// --- Auth mock ---
let mockCustomer: {
  id: string;
  email: string;
  name?: string | null;
  phone?: string | null;
  isB2b?: boolean;
  vatNumber?: string | null;
  vatValidated?: boolean;
  acceptsMarketing?: boolean;
} = {
  id: 'c1',
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  phone: '+33612345678',
  isB2b: false,
  vatNumber: null,
  vatValidated: false,
  acceptsMarketing: true,
};

let updateProfile: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
let refresh: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue('new-token');

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({
    customer: mockCustomer,
    updateProfile,
    refresh,
  }),
}));

import { ProfileEditForm } from './ProfileEditForm';

beforeEach(() => {
  mockCustomer = {
    id: 'c1',
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    phone: '+33612345678',
    isB2b: false,
    vatNumber: null,
    vatValidated: false,
    acceptsMarketing: true,
  };
  updateProfile = vi.fn().mockResolvedValue(undefined);
  refresh = vi.fn().mockResolvedValue('new-token');
});

describe('ProfileEditForm — prefill', () => {
  it('prefills the name field from customer.name', () => {
    renderWithIntl(<ProfileEditForm />, 'en');
    expect(screen.getByLabelText(/^name$/i)).toHaveValue('Ada Lovelace');
  });

  it('prefills the phone field from customer.phone', () => {
    renderWithIntl(<ProfileEditForm />, 'en');
    expect(screen.getByLabelText(/phone/i)).toHaveValue('+33612345678');
  });

  it('prefills the marketing checkbox from customer.acceptsMarketing', () => {
    renderWithIntl(<ProfileEditForm />, 'en');
    const checkbox = screen.getByRole('checkbox', { name: /marketing/i });
    expect(checkbox).toBeChecked();
  });

  it('shows the email as read-only text, not an input', () => {
    renderWithIntl(<ProfileEditForm />, 'en');
    // Email must be visible in the DOM
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    // But there must be no input with that value
    const inputs = screen.queryAllByRole('textbox');
    const emailInput = inputs.find((el) => (el as HTMLInputElement).value === 'ada@example.com');
    expect(emailInput).toBeUndefined();
  });
});

describe('ProfileEditForm — VAT field visibility', () => {
  it('hides the VAT field when isB2b is false', () => {
    mockCustomer = { ...mockCustomer, isB2b: false };
    renderWithIntl(<ProfileEditForm />, 'en');
    expect(screen.queryByLabelText(/vat number/i)).not.toBeInTheDocument();
  });

  it('shows the VAT field when isB2b is true', () => {
    mockCustomer = { ...mockCustomer, isB2b: true, vatNumber: 'FR12345678901', vatValidated: true };
    renderWithIntl(<ProfileEditForm />, 'en');
    expect(screen.getByLabelText(/vat number/i)).toBeInTheDocument();
  });

  it('shows vat-validated status when isB2b and vatValidated', () => {
    mockCustomer = { ...mockCustomer, isB2b: true, vatNumber: 'FR12345678901', vatValidated: true };
    renderWithIntl(<ProfileEditForm />, 'en');
    expect(screen.getByTestId('vat-validated-status')).toHaveTextContent(/validated/i);
  });

  it('shows vat-not-validated status when isB2b and !vatValidated with a vatNumber', () => {
    mockCustomer = {
      ...mockCustomer,
      isB2b: true,
      vatNumber: 'FR00000000001',
      vatValidated: false,
    };
    renderWithIntl(<ProfileEditForm />, 'en');
    expect(screen.getByTestId('vat-validated-status')).toHaveTextContent(/not yet validated/i);
  });
});

describe('ProfileEditForm — submit', () => {
  it('calls updateProfile with the edited fields on submit', async () => {
    renderWithIntl(<ProfileEditForm />, 'en');

    // Change name
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'Charles Babbage' } });
    // Uncheck marketing
    fireEvent.click(screen.getByRole('checkbox', { name: /marketing/i }));

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /save profile/i }).closest('form')!);
    });

    await waitFor(() => expect(updateProfile).toHaveBeenCalledOnce());
    const args = (updateProfile.mock.calls[0] as [Record<string, unknown>])[0];
    expect(args.name).toBe('Charles Babbage');
    expect(args.acceptsMarketing).toBe(false);
    // SECURITY: the form must NEVER send non-editable / identity fields — those are not
    // mutable via PATCH /me and must never leave the client in this payload.
    expect(args).not.toHaveProperty('email');
    expect(args).not.toHaveProperty('isB2b');
  });

  it('shows success role=status after a successful save', async () => {
    renderWithIntl(<ProfileEditForm />, 'en');

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /save profile/i }).closest('form')!);
    });

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent(/profile saved/i);
  });

  it('sends null when an optional field is cleared', async () => {
    renderWithIntl(<ProfileEditForm />, 'en');

    // Clear the phone field
    fireEvent.change(screen.getByLabelText(/phone/i), { target: { value: '' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /save profile/i }).closest('form')!);
    });

    await waitFor(() => expect(updateProfile).toHaveBeenCalledOnce());
    const args = (updateProfile.mock.calls[0] as [Record<string, unknown>])[0];
    expect(args.phone).toBeNull();
  });

  it('B2B: sends vatNumber === null when the VAT field is cleared', async () => {
    mockCustomer = {
      ...mockCustomer,
      isB2b: true,
      vatNumber: 'FR12345678901',
      vatValidated: true,
    };
    renderWithIntl(<ProfileEditForm />, 'en');

    // Clear the (prefilled) VAT field
    fireEvent.change(screen.getByLabelText(/vat number/i), { target: { value: '' } });

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /save profile/i }).closest('form')!);
    });

    await waitFor(() => expect(updateProfile).toHaveBeenCalledOnce());
    const args = (updateProfile.mock.calls[0] as [Record<string, unknown>])[0];
    expect(args.vatNumber).toBeNull();
  });

  it('NON-B2B: omits vatNumber from the payload entirely (not null, not "")', async () => {
    mockCustomer = { ...mockCustomer, isB2b: false };
    renderWithIntl(<ProfileEditForm />, 'en');

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /save profile/i }).closest('form')!);
    });

    await waitFor(() => expect(updateProfile).toHaveBeenCalledOnce());
    const args = (updateProfile.mock.calls[0] as [Record<string, unknown>])[0];
    // A non-B2B customer has no VAT surface — the key must be absent, not a null/empty value.
    expect('vatNumber' in args).toBe(false);
  });

  it('shows a form-level error banner on save failure', async () => {
    updateProfile = vi.fn().mockRejectedValue(new Error('500'));
    renderWithIntl(<ProfileEditForm />, 'en');

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /save profile/i }).closest('form')!);
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/could not save/i);
  });

  it('shows inline error and does not submit when name is cleared (required)', async () => {
    renderWithIntl(<ProfileEditForm />, 'en');

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: '' } });

    act(() => {
      fireEvent.submit(screen.getByRole('button', { name: /save profile/i }).closest('form')!);
    });

    // Should NOT call updateProfile on a validation error
    await new Promise((r) => setTimeout(r, 50));
    expect(updateProfile).not.toHaveBeenCalled();
    // Should show inline error
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('ProfileEditForm — 401 refresh retry', () => {
  it('retries updateProfile with refresh() on a 401 and shows success', async () => {
    let calls = 0;
    updateProfile = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        const err = Object.assign(new Error('Unauthorized'), { status: 401 });
        throw err;
      }
    });

    renderWithIntl(<ProfileEditForm />, 'en');

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /save profile/i }).closest('form')!);
    });

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(refresh).toHaveBeenCalledOnce();
    expect(updateProfile).toHaveBeenCalledTimes(2);
  });

  it('shows error banner when refresh() throws during a 401 retry', async () => {
    updateProfile = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }));
    refresh = vi.fn().mockRejectedValue(new Error('network down'));

    renderWithIntl(<ProfileEditForm />, 'en');

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /save profile/i }).closest('form')!);
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/could not save/i);
  });
});

describe('ProfileEditForm — FR locale', () => {
  it('renders the form in French', () => {
    renderWithIntl(<ProfileEditForm />, 'fr');
    expect(screen.getByLabelText(/^nom$/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /enregistrer le profil/i })).toBeInTheDocument();
  });
});
