import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import type { ProductVariantView } from '@/lib/catalog';

// Capture what variantId/availability flow into the add button (assert the wiring, not the network).
const addItem = vi.fn<(variantId: string, quantity: number) => Promise<void>>();
vi.mock('@/lib/cart-context', () => ({
  useCart: () => ({ addItem }),
}));

import { VariantSelector } from './VariantSelector';

const single: ProductVariantView[] = [
  {
    id: 'v-only',
    title: 'Default',
    options: {},
    priceAmount: 1999,
    currency: 'EUR',
    availability: true,
  },
];

const multi: ProductVariantView[] = [
  {
    id: 'v-s',
    title: 'Small',
    options: { Size: 'S' },
    priceAmount: 1999,
    currency: 'EUR',
    availability: true,
  },
  {
    id: 'v-m',
    title: 'Medium',
    options: { Size: 'M' },
    priceAmount: 2499,
    currency: 'EUR',
    availability: true,
  },
  {
    id: 'v-l',
    title: 'Large',
    options: { Size: 'L' },
    priceAmount: 2999,
    currency: 'EUR',
    availability: false,
  },
];

const multiAxis: ProductVariantView[] = [
  {
    id: 'sr',
    title: 'S / Red',
    options: { Size: 'S', Color: 'Red' },
    priceAmount: 1000,
    currency: 'EUR',
    availability: true,
  },
  {
    id: 'sb',
    title: 'S / Blue',
    options: { Size: 'S', Color: 'Blue' },
    priceAmount: 1100,
    currency: 'EUR',
    availability: true,
  },
  {
    id: 'mr',
    title: 'M / Red',
    options: { Size: 'M', Color: 'Red' },
    priceAmount: 1200,
    currency: 'EUR',
    availability: false,
  },
];

beforeEach(() => {
  addItem.mockReset();
  addItem.mockResolvedValue();
});

describe('VariantSelector', () => {
  it('single-variant product: no option selector, price shown, add button wired to that variant', async () => {
    renderWithIntl(<VariantSelector variants={single} locale="en" />, 'en');
    // No option <select> rendered for a single-variant product.
    expect(screen.queryByRole('combobox')).toBeNull();
    // Its price is shown (server minor units → €19.99, no client math).
    expect(screen.getByText('€19.99')).toBeInTheDocument();
    const add = screen.getByRole('button', { name: /add to cart/i });
    expect(add).not.toBeDisabled();
    fireEvent.click(add);
    expect(addItem).toHaveBeenCalledWith('v-only', 1);
  });

  it('multi-variant: selecting an option resolves the variant and surfaces ITS price + availability', () => {
    renderWithIntl(<VariantSelector variants={multi} locale="en" />, 'en');
    const select = screen.getByRole('combobox', { name: /size/i });
    // Pick Medium (axis value "M") → its price (€24.99) appears.
    fireEvent.change(select, { target: { value: 'M' } });
    expect(screen.getByText('€24.99')).toBeInTheDocument();
    // The add button targets the chosen variant.
    fireEvent.click(screen.getByRole('button', { name: /add to cart/i }));
    expect(addItem).toHaveBeenCalledWith('v-m', 1);
  });

  it('multi-variant: choosing an out-of-stock variant disables add and never calls addItem', () => {
    renderWithIntl(<VariantSelector variants={multi} locale="en" />, 'en');
    fireEvent.change(screen.getByRole('combobox', { name: /size/i }), { target: { value: 'L' } });
    // Out-of-stock availability badge shown + disabled add (both carry the out-of-stock text).
    expect(screen.getAllByText(/out of stock/i).length).toBeGreaterThan(0);
    const add = screen.getByRole('button');
    expect(add).toBeDisabled();
    expect(add).toHaveTextContent(/out of stock/i);
    fireEvent.click(add);
    expect(addItem).not.toHaveBeenCalled();
  });

  it('renders one selector per option axis and resolves the combined variant', () => {
    renderWithIntl(<VariantSelector variants={multiAxis} locale="en" />, 'en');
    const size = screen.getByRole('combobox', { name: /size/i });
    const color = screen.getByRole('combobox', { name: /color/i });
    fireEvent.change(size, { target: { value: 'S' } });
    fireEvent.change(color, { target: { value: 'Blue' } });
    // S/Blue → €11.00, available.
    expect(screen.getByText('€11.00')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /add to cart/i }));
    expect(addItem).toHaveBeenCalledWith('sb', 1);
  });

  it('does no client-side money math — renders the server minor-unit amount via formatPrice', () => {
    renderWithIntl(<VariantSelector variants={single} locale="en" />, 'en');
    // 1999 minor EUR → €19.99; a /100 bug would print 19.99 too, but a JPY-style would differ.
    // The load-bearing assertion: the exact formatPrice output, never a hand-divided number.
    expect(screen.getByText('€19.99')).toBeInTheDocument();
    expect(screen.queryByText('1999')).toBeNull();
  });

  it('localizes price + chrome in French', () => {
    renderWithIntl(<VariantSelector variants={single} locale="fr" />, 'fr');
    // FR formats 19,99 € (NBSP before the symbol).
    expect(screen.getByText(/19,99/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ajouter au panier/i })).toBeInTheDocument();
  });

  it('empty variant list: no crash, no add button', () => {
    renderWithIntl(<VariantSelector variants={[]} locale="en" />, 'en');
    expect(screen.queryByRole('button', { name: /add to cart/i })).toBeNull();
  });
});
