/**
 * CheckoutAddress contract.
 *
 * BINDING: the step UNCONDITIONALLY posts the REAL full shipping address, OVERWRITING
 * any estimator placeholder. We assert the EXACT body posted to `setShippingAddress` is the real address
 * (no "—" anywhere) — the cart-context test proves the cart then carries the real one, not the placeholder.
 *
 * Also: authenticated → defaults to the saved DEFAULT address; billing "same as shipping" toggle;
 * validation blocks the post.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import type { CartAddressInput } from '@/lib/cart-types';
import type { SavedAddress } from '@/lib/auth-context';

const setShippingAddress = vi.fn<(a: CartAddressInput) => Promise<void>>();
const setBillingAddress = vi.fn<(a: CartAddressInput) => Promise<void>>();
vi.mock('@/lib/cart-context', () => ({
  useCart: () => ({ setShippingAddress, setBillingAddress }),
}));

const fetchAddresses = vi.fn<() => Promise<SavedAddress[]>>();
let isAuthenticated = false;
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ isAuthenticated, fetchAddresses }),
}));

import { CheckoutAddress } from './CheckoutAddress';

function fillReal(): void {
  fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Marie Curie' } });
  fireEvent.change(screen.getByLabelText(/^address line 1$/i), {
    target: { value: '12 Rue de la Paix' },
  });
  fireEvent.change(screen.getByLabelText(/^city$/i), { target: { value: 'Paris' } });
  fireEvent.change(screen.getByLabelText(/postal code/i), { target: { value: '75002' } });
  fireEvent.change(screen.getByLabelText(/^country$/i), { target: { value: 'FR' } });
}

beforeEach(() => {
  setShippingAddress.mockReset().mockResolvedValue();
  setBillingAddress.mockReset().mockResolvedValue();
  fetchAddresses.mockReset().mockResolvedValue([]);
  isAuthenticated = false;
});

describe('CheckoutAddress', () => {
  it('guest: does NOT fetch saved addresses (the !isAuthenticated guard)', async () => {
    isAuthenticated = false;
    renderWithIntl(<CheckoutAddress onDone={vi.fn()} />, 'en');
    // Give any (incorrectly-fired) effect a tick to run before asserting it did not.
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchAddresses).not.toHaveBeenCalled();
  });

  it('BINDING: posts the REAL full shipping address (no "—" placeholder) and advances', async () => {
    const onDone = vi.fn();
    renderWithIntl(<CheckoutAddress onDone={onDone} />, 'en');
    fillReal();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    });
    await waitFor(() => expect(setShippingAddress).toHaveBeenCalledTimes(1));
    const posted = setShippingAddress.mock.calls[0]![0];
    // The posted address is the REAL one — never the estimator placeholder.
    expect(posted).toMatchObject({
      name: 'Marie Curie',
      line1: '12 Rue de la Paix',
      city: 'Paris',
      postalCode: '75002',
      country: 'FR',
    });
    expect(posted.name).not.toBe('—');
    expect(posted.line1).not.toBe('—');
    expect(posted.city).not.toBe('—');
    expect(onDone).toHaveBeenCalled();
  });

  it('blocks the post when required fields are missing (validation), and never advances', async () => {
    const onDone = vi.fn();
    renderWithIntl(<CheckoutAddress onDone={onDone} />, 'en');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    });
    expect(setShippingAddress).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });

  it('authenticated: defaults to the saved DEFAULT shipping address (prefill)', async () => {
    isAuthenticated = true;
    fetchAddresses.mockResolvedValue([
      {
        id: 'a1',
        type: 'shipping',
        isDefault: false,
        name: 'Old Place',
        company: null,
        line1: '1 Old St',
        line2: null,
        city: 'Lyon',
        postalCode: '69001',
        region: null,
        country: 'FR',
        phone: null,
      },
      {
        id: 'a2',
        type: 'shipping',
        isDefault: true,
        name: 'Default Home',
        company: null,
        line1: '99 Default Ave',
        line2: null,
        city: 'Paris',
        postalCode: '75001',
        region: null,
        country: 'FR',
        phone: null,
      },
    ]);
    renderWithIntl(<CheckoutAddress onDone={vi.fn()} />, 'en');
    await waitFor(() =>
      expect((screen.getByLabelText(/full name/i) as HTMLInputElement).value).toBe('Default Home'),
    );
    expect((screen.getByLabelText(/^city$/i) as HTMLInputElement).value).toBe('Paris');
  });

  it('billing "same as shipping" is on by default and hides the billing block; toggling off shows it', async () => {
    renderWithIntl(<CheckoutAddress onDone={vi.fn()} />, 'en');
    expect(screen.getByText('Shipping address')).toBeInTheDocument();
    // Only ONE address block (shipping) while "same as shipping" is checked — the billing LEGEND
    // (exact "Billing address") is absent (the checkbox label is longer text, so won't match exactly).
    expect(screen.queryByText('Billing address')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /same as shipping/i }));
    expect(screen.getByText('Billing address')).toBeInTheDocument();
  });

  it('with a separate billing address, posts BOTH the real shipping and real billing addresses', async () => {
    renderWithIntl(<CheckoutAddress onDone={vi.fn()} />, 'en');
    fillReal();
    fireEvent.click(screen.getByRole('checkbox', { name: /same as shipping/i }));
    // Fill the billing block (the second set of fields).
    const billingField = (matcher: RegExp): HTMLElement => {
      const els = screen.getAllByLabelText(matcher);
      const el = els[1];
      if (!el) throw new Error(`expected a billing field for ${matcher}`);
      return el;
    };
    fireEvent.change(billingField(/full name/i), { target: { value: 'ACME GmbH' } });
    fireEvent.change(billingField(/^address line 1$/i), { target: { value: 'Hauptstr 1' } });
    fireEvent.change(billingField(/^city$/i), { target: { value: 'Berlin' } });
    fireEvent.change(billingField(/postal code/i), { target: { value: '10115' } });
    fireEvent.change(billingField(/^country$/i), { target: { value: 'DE' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    });
    await waitFor(() => expect(setBillingAddress).toHaveBeenCalledTimes(1));
    expect(setShippingAddress.mock.calls[0]![0]).toMatchObject({ name: 'Marie Curie' });
    expect(setBillingAddress.mock.calls[0]![0]).toMatchObject({ name: 'ACME GmbH', country: 'DE' });
  });
});
