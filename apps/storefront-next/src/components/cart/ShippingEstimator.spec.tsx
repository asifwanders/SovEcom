import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import type { CartView, ShippingRateView } from '@/lib/cart-types';

// Drive useCart(): shippingRates (display), estimateShipping/selectShippingRate (mutations), cart.
let shippingRates: ShippingRateView[] | null = null;
let cart: CartView | null = null;
const estimateShipping =
  vi.fn<(d: { country: string; postalCode: string }) => Promise<ShippingRateView[]>>();
const selectShippingRate = vi.fn<(id: string) => Promise<void>>();
vi.mock('@/lib/cart-context', () => ({
  useCart: () => ({ shippingRates, estimateShipping, selectShippingRate, cart }),
}));

import { ShippingEstimator } from './ShippingEstimator';

const RATES: ShippingRateView[] = [
  { id: 'r-std', name: 'Standard', type: 'flat', amount: 499, currency: 'EUR' },
  { id: 'r-exp', name: 'Express', type: 'flat', amount: 999, currency: 'EUR' },
];

beforeEach(() => {
  shippingRates = null;
  cart = null;
  estimateShipping.mockReset();
  estimateShipping.mockResolvedValue(RATES);
  selectShippingRate.mockReset();
  selectShippingRate.mockResolvedValue();
});

describe('ShippingEstimator', () => {
  it('estimates rates for an entered destination (country + postal) via estimateShipping', async () => {
    renderWithIntl(<ShippingEstimator locale="en" />, 'en');
    fireEvent.change(screen.getByLabelText(/country/i), { target: { value: 'DE' } });
    fireEvent.change(screen.getByLabelText(/postal code/i), { target: { value: '10115' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^estimate$/i }));
    });
    await waitFor(() =>
      expect(estimateShipping).toHaveBeenCalledWith({ country: 'DE', postalCode: '10115' }),
    );
  });

  it('renders the returned rates with server amounts via formatPrice (no client money math)', async () => {
    shippingRates = RATES;
    renderWithIntl(<ShippingEstimator locale="en" />, 'en');
    fireEvent.change(screen.getByLabelText(/postal code/i), { target: { value: '75001' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^estimate$/i }));
    });
    expect(await screen.findByText(/Standard — €4\.99/)).toBeInTheDocument();
    expect(screen.getByText(/Express — €9\.99/)).toBeInTheDocument();
  });

  it('shows a clear empty state when no rates serve the destination', async () => {
    shippingRates = [];
    estimateShipping.mockResolvedValueOnce([]);
    renderWithIntl(<ShippingEstimator locale="en" />, 'en');
    fireEvent.change(screen.getByLabelText(/postal code/i), { target: { value: '00000' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^estimate$/i }));
    });
    expect(await screen.findByTestId('no-rates')).toHaveTextContent(/no shipping rates/i);
  });

  it('choosing a rate calls selectShippingRate (server folds it into authoritative totals)', async () => {
    shippingRates = RATES;
    renderWithIntl(<ShippingEstimator locale="en" />, 'en');
    fireEvent.change(screen.getByLabelText(/postal code/i), { target: { value: '75001' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^estimate$/i }));
    });
    const chooseButtons = await screen.findAllByRole('button', { name: /^choose$/i });
    await act(async () => {
      fireEvent.click(chooseButtons[0]!);
    });
    await waitFor(() => expect(selectShippingRate).toHaveBeenCalledWith('r-std'));
  });

  it('surfaces an error when the estimate fails', async () => {
    estimateShipping.mockRejectedValueOnce(new Error('boom'));
    renderWithIntl(<ShippingEstimator locale="en" />, 'en');
    fireEvent.change(screen.getByLabelText(/postal code/i), { target: { value: '75001' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^estimate$/i }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not estimate/i);
  });

  it('does not estimate with a blank postal code', async () => {
    renderWithIntl(<ShippingEstimator locale="en" />, 'en');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^estimate$/i }));
    });
    expect(estimateShipping).not.toHaveBeenCalled();
  });
});
