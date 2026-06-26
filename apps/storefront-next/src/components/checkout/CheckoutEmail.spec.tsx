/**
 * CheckoutEmail contract: guest sets the cart email; logged-in customer associates + advances;
 * validation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

const setEmail = vi.fn<(email: string) => Promise<void>>();
const associateCustomer = vi.fn<() => Promise<void>>();
let cart: { guestEmail: string | null } | null = null;
vi.mock('@/lib/cart-context', () => ({
  useCart: () => ({ cart, setEmail, associateCustomer }),
}));

let auth: { customer: { email: string } | null; isAuthenticated: boolean } = {
  customer: null,
  isAuthenticated: false,
};
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => auth,
}));

import { CheckoutEmail } from './CheckoutEmail';

beforeEach(() => {
  setEmail.mockReset().mockResolvedValue();
  associateCustomer.mockReset().mockResolvedValue();
  cart = { guestEmail: null };
  auth = { customer: null, isAuthenticated: false };
});

describe('CheckoutEmail', () => {
  it('guest: sets the cart email then advances', async () => {
    const onDone = vi.fn();
    renderWithIntl(<CheckoutEmail onDone={onDone} />, 'en');
    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'shopper@example.com' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    });
    await waitFor(() => expect(setEmail).toHaveBeenCalledWith('shopper@example.com'));
    expect(onDone).toHaveBeenCalled();
  });

  it('guest: rejects an invalid email and does NOT call setEmail', async () => {
    const onDone = vi.fn();
    renderWithIntl(<CheckoutEmail onDone={onDone} />, 'en');
    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'not-an-email' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(setEmail).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('logged-in: shows the account email, associates the customer, and advances (no email field)', async () => {
    auth = { customer: { email: 'me@account.com' }, isAuthenticated: true };
    const onDone = vi.fn();
    renderWithIntl(<CheckoutEmail onDone={onDone} />, 'en');
    expect(screen.getByText(/me@account\.com/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/email address/i)).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    });
    await waitFor(() => expect(associateCustomer).toHaveBeenCalled());
    expect(onDone).toHaveBeenCalled();
  });

  it('localizes the continue label in French', () => {
    renderWithIntl(<CheckoutEmail onDone={vi.fn()} />, 'fr');
    expect(screen.getByRole('button', { name: /continuer/i })).toBeInTheDocument();
  });
});
