import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

// Drive useCart().addItem per test (mirror LoginForm.spec's context-mock convention).
const addItem = vi.fn<(variantId: string, quantity: number) => Promise<void>>();
vi.mock('@/lib/cart-context', () => ({
  useCart: () => ({ addItem }),
}));

import { AddToCartButton } from './AddToCartButton';

beforeEach(() => {
  addItem.mockReset();
  addItem.mockResolvedValue();
});

describe('AddToCartButton', () => {
  it('adds the selected variant (quantity 1 by default) on click', async () => {
    renderWithIntl(<AddToCartButton variantId="v1" available />, 'en');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add to cart/i }));
    });
    await waitFor(() => expect(addItem).toHaveBeenCalledWith('v1', 1));
  });

  it('shows brief success feedback after a successful add', async () => {
    renderWithIntl(<AddToCartButton variantId="v1" available />, 'en');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add to cart/i }));
    });
    expect(await screen.findByRole('status')).toHaveTextContent(/added to cart/i);
  });

  it('disables the button + labels it while the add is pending (no double-submit)', async () => {
    let resolveAdd: () => void = () => {};
    addItem.mockImplementation(() => new Promise<void>((r) => (resolveAdd = r)));
    renderWithIntl(<AddToCartButton variantId="v1" available />, 'en');
    const button = screen.getByRole('button', { name: /add to cart/i });
    await act(async () => {
      fireEvent.click(button);
    });
    const pending = screen.getByRole('button', { name: /adding/i });
    expect(pending).toBeDisabled();
    // A second click while pending must not fire another add.
    fireEvent.click(pending);
    expect(addItem).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveAdd();
    });
  });

  it('surfaces a retry-able error when the add fails and never leaves a stuck spinner', async () => {
    addItem.mockRejectedValueOnce(new Error('stock taken'));
    renderWithIntl(<AddToCartButton variantId="v1" available />, 'en');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add to cart/i }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not add to cart/i);
    // Button is re-enabled so the user can retry.
    const retry = screen.getByRole('button', { name: /add to cart|retry/i });
    expect(retry).not.toBeDisabled();
    addItem.mockResolvedValueOnce();
    await act(async () => {
      fireEvent.click(retry);
    });
    await waitFor(() => expect(addItem).toHaveBeenCalledTimes(2));
  });

  it('is disabled with an out-of-stock label when the variant is unavailable, and never calls addItem', () => {
    renderWithIntl(<AddToCartButton variantId="v1" available={false} />, 'en');
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(/out of stock/i);
    fireEvent.click(button);
    expect(addItem).not.toHaveBeenCalled();
  });

  it('reads "select an option" (NOT "out of stock") when no variant is selected, and never calls addItem', () => {
    renderWithIntl(<AddToCartButton variantId={null} available={false} />, 'en');
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    // The unselected state must NOT claim out-of-stock — nothing is out of stock, the shopper
    // simply has not chosen yet (review NIT #2 — money-path CTA must not mislabel).
    expect(button).toHaveTextContent(/select an option/i);
    expect(button).not.toHaveTextContent(/out of stock/i);
    fireEvent.click(button);
    expect(addItem).not.toHaveBeenCalled();
  });

  it('localizes the button label in French', () => {
    renderWithIntl(<AddToCartButton variantId="v1" available />, 'fr');
    expect(screen.getByRole('button', { name: /ajouter au panier/i })).toBeInTheDocument();
  });
});
