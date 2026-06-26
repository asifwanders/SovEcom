/**
 * AddressForm component tests.
 * Uses only @testing-library/react (fireEvent) — no user-event package installed in this repo.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import type { SavedAddress } from '@/lib/auth-context';
import { AddressForm } from './AddressForm';
import type { AddressFormSubmitPayload } from './AddressForm';

const SAVED: SavedAddress = {
  id: 'addr-1',
  type: 'shipping',
  isDefault: true,
  name: 'Ada Lovelace',
  company: 'Analytical Engines Ltd',
  line1: '123 Rue de la Paix',
  line2: null,
  city: 'Paris',
  postalCode: '75001',
  region: null,
  country: 'FR',
  phone: null,
};

function makeProps(overrides: Partial<React.ComponentProps<typeof AddressForm>> = {}) {
  return {
    pending: false,
    error: null,
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

function getForm(): HTMLFormElement {
  return screen.getByRole('button', { name: /save address/i }).closest('form')!;
}

function fillRequired(): void {
  fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Test User' } });
  fireEvent.change(screen.getByLabelText(/address line 1/i), { target: { value: '1 Main St' } });
  fireEvent.change(screen.getByLabelText(/city/i), { target: { value: 'Paris' } });
  fireEvent.change(screen.getByLabelText(/postal code/i), { target: { value: '75001' } });
  fireEvent.change(screen.getByRole('combobox', { name: /country/i }), {
    target: { value: 'FR' },
  });
}

describe('AddressForm — create mode', () => {
  it('renders in EN with type select and isDefault checkbox', () => {
    renderWithIntl(<AddressForm {...makeProps()} />, 'en');
    expect(screen.getByLabelText(/full name/i)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /address type/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /set as default/i })).toBeInTheDocument();
  });

  it('renders Save button text in EN', () => {
    renderWithIntl(<AddressForm {...makeProps()} />, 'en');
    expect(screen.getByRole('button', { name: /save address/i })).toBeInTheDocument();
  });

  it('renders save button text in FR', () => {
    renderWithIntl(<AddressForm {...makeProps()} />, 'fr');
    expect(screen.getByRole('button', { name: /enregistrer l'adresse/i })).toBeInTheDocument();
  });

  it('shows required-field errors on empty submit (does NOT call onSubmit)', async () => {
    const onSubmit = vi.fn();
    renderWithIntl(<AddressForm {...makeProps({ onSubmit })} />, 'en');
    act(() => fireEvent.submit(getForm()));
    await waitFor(() => {
      expect(screen.getByText(/enter a full name/i)).toBeInTheDocument();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows country error when country is left empty', async () => {
    const onSubmit = vi.fn();
    renderWithIntl(<AddressForm {...makeProps({ onSubmit })} />, 'en');
    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText(/address line 1/i), { target: { value: '1 St' } });
    fireEvent.change(screen.getByLabelText(/city/i), { target: { value: 'Paris' } });
    fireEvent.change(screen.getByLabelText(/postal code/i), { target: { value: '75001' } });
    // Leave country empty
    act(() => fireEvent.submit(getForm()));
    await waitFor(() => {
      expect(screen.getByText(/select a valid country/i)).toBeInTheDocument();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onSubmit with type and isDefault when the form is valid', async () => {
    const onSubmit = vi.fn<(payload: AddressFormSubmitPayload) => void>();
    renderWithIntl(<AddressForm {...makeProps({ onSubmit })} />, 'en');

    fillRequired();
    fireEvent.change(screen.getByRole('combobox', { name: /address type/i }), {
      target: { value: 'billing' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /set as default/i }));

    act(() => fireEvent.submit(getForm()));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());

    const payload = (onSubmit.mock.calls[0] as [AddressFormSubmitPayload])[0];
    expect(payload.type).toBe('billing');
    expect(payload.isDefault).toBe(true);
    expect(payload.fields.name).toBe('Test User');
    expect(payload.fields.country).toBe('FR');
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const onCancel = vi.fn();
    renderWithIntl(<AddressForm {...makeProps({ onCancel })} />, 'en');
    act(() => fireEvent.click(screen.getByRole('button', { name: /cancel/i })));
    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
  });

  it('disables both buttons while pending and shows saving text', () => {
    renderWithIntl(<AddressForm {...makeProps({ pending: true })} />, 'en');
    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
  });

  it('shows the error banner with role="alert" when error is set', () => {
    renderWithIntl(
      <AddressForm {...makeProps({ error: 'Could not save the address. Please try again.' })} />,
      'en',
    );
    const alert = screen.getByTestId('address-form-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent(/could not save/i);
  });
});

describe('AddressForm — edit mode (prefill)', () => {
  it('prefills text fields from the initial address', () => {
    renderWithIntl(<AddressForm {...makeProps({ initial: SAVED })} />, 'en');
    expect(screen.getByLabelText(/full name/i)).toHaveValue('Ada Lovelace');
    expect(screen.getByLabelText(/company/i)).toHaveValue('Analytical Engines Ltd');
    expect(screen.getByLabelText(/address line 1/i)).toHaveValue('123 Rue de la Paix');
    expect(screen.getByLabelText(/city/i)).toHaveValue('Paris');
    expect(screen.getByLabelText(/postal code/i)).toHaveValue('75001');
  });

  it('prefills type select and isDefault checkbox from initial address', () => {
    renderWithIntl(<AddressForm {...makeProps({ initial: SAVED })} />, 'en');
    const typeSelect = screen.getByRole('combobox', { name: /address type/i }) as HTMLSelectElement;
    expect(typeSelect.value).toBe('shipping');
    const checkbox = screen.getByRole('checkbox', { name: /set as default/i }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it('submits updated fields via onSubmit', async () => {
    const onSubmit = vi.fn<(payload: AddressFormSubmitPayload) => void>();
    renderWithIntl(<AddressForm {...makeProps({ initial: SAVED, onSubmit })} />, 'en');

    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Charles Babbage' } });

    act(() => fireEvent.submit(getForm()));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const payload = (onSubmit.mock.calls[0] as [AddressFormSubmitPayload])[0];
    expect(payload.fields.name).toBe('Charles Babbage');
    expect(payload.type).toBe('shipping');
    expect(payload.isDefault).toBe(true);
  });
});
