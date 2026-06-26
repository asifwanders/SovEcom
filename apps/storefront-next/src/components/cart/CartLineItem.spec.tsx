import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import type { CartLineView } from '@/lib/cart-types';

// Locale-aware Link → plain anchor so the PDP href is assertable.
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

// Drive useCart().updateItem / removeItem per test (mirror AddToCartButton.spec's context-mock).
const updateItem = vi.fn<(itemId: string, qty: number) => Promise<void>>();
const removeItem = vi.fn<(itemId: string) => Promise<void>>();
vi.mock('@/lib/cart-context', () => ({
  useCart: () => ({ updateItem, removeItem }),
}));

import { CartLineItem } from './CartLineItem';

const line: CartLineView = {
  id: 'li-1',
  variantId: 'v-abc',
  quantity: 2,
  unitPriceAmount: 1999, // €19.99
  currency: 'EUR',
  productTitle: 'Blue Tee',
  variantTitle: 'Medium',
  options: { Size: 'M', Color: 'Blue' },
  sku: 'TEE-M-BLUE',
  productSlug: 'blue-tee',
};

beforeEach(() => {
  updateItem.mockReset();
  updateItem.mockResolvedValue();
  removeItem.mockReset();
  removeItem.mockResolvedValue();
});

describe('CartLineItem', () => {
  it('renders the snapshotted product title linked to its PDP — NOT the raw variant UUID', () => {
    renderWithIntl(<CartLineItem line={line} locale="en" />, 'en');
    const title = screen.getByTestId('line-title');
    expect(title).toHaveTextContent('Blue Tee');
    // The title links to the PDP via the snapshotted slug.
    expect(title).toHaveAttribute('href', '/product/blue-tee');
    // The opaque variant UUID must NOT be shown anywhere (the display-identity snapshot fix).
    expect(screen.queryByText('v-abc')).toBeNull();
  });

  it('shows the variant title when present', () => {
    renderWithIntl(<CartLineItem line={line} locale="en" />, 'en');
    expect(screen.getByTestId('line-variant')).toHaveTextContent('Medium');
  });

  it('falls back to an options summary when there is no variant title', () => {
    renderWithIntl(<CartLineItem line={{ ...line, variantTitle: null }} locale="en" />, 'en');
    // e.g. "Size: M / Color: Blue" — derived from the snapshotted options map.
    expect(screen.getByTestId('line-variant')).toHaveTextContent('Size: M / Color: Blue');
  });

  it('renders NO variant sub-line when there is no variant title and no presentable options', () => {
    renderWithIntl(
      <CartLineItem line={{ ...line, variantTitle: null, options: {} }} locale="en" />,
      'en',
    );
    // Nothing to summarise → the sub-line is omitted entirely (not an empty element).
    expect(screen.queryByTestId('line-variant')).toBeNull();
  });

  it('renders the title as a plain <span> (NOT a broken <a>) when the product slug is empty', () => {
    renderWithIntl(<CartLineItem line={{ ...line, productSlug: '' }} locale="en" />, 'en');
    const title = screen.getByTestId('line-title');
    expect(title.tagName).toBe('SPAN');
    expect(title).not.toHaveAttribute('href');
    expect(title).toHaveTextContent('Blue Tee');
  });

  it('skips object/array option values in the summary (never renders "[object Object]")', () => {
    renderWithIntl(
      <CartLineItem
        line={{
          ...line,
          variantTitle: null,
          // Mixed bag: a primitive (kept) alongside an object + array (both skipped).
          options: { Size: 'L', meta: { nested: true }, tags: ['a', 'b'] },
        }}
        locale="en"
      />,
      'en',
    );
    const variant = screen.getByTestId('line-variant');
    expect(variant).toHaveTextContent('Size: L');
    expect(variant.textContent).not.toMatch(/\[object Object\]/);
    // The object/array keys are dropped entirely (only primitive option values are presentable).
    expect(variant.textContent).not.toMatch(/meta|tags/);
  });

  it('renders the unit price via formatPrice (no client money math) and the quantity separately', () => {
    renderWithIntl(<CartLineItem line={line} locale="en" />, 'en');
    // €19.99 unit price rendered; the qty (2) shown separately — NOT a multiplied €39.98.
    expect(screen.getByText(/€19\.99 × 2/)).toBeInTheDocument();
    expect(screen.queryByText(/39\.98/)).toBeNull();
    expect(screen.getByTestId('line-qty')).toHaveTextContent('2');
  });

  it('increment calls updateItem with quantity + 1', async () => {
    renderWithIntl(<CartLineItem line={line} locale="en" />, 'en');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /increase quantity/i }));
    });
    await waitFor(() => expect(updateItem).toHaveBeenCalledWith('li-1', 3));
  });

  it('decrement calls updateItem with quantity - 1', async () => {
    renderWithIntl(<CartLineItem line={line} locale="en" />, 'en');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /decrease quantity/i }));
    });
    await waitFor(() => expect(updateItem).toHaveBeenCalledWith('li-1', 1));
  });

  it('decrement is disabled at quantity 1 (remove is the explicit affordance, never qty 0)', () => {
    renderWithIntl(<CartLineItem line={{ ...line, quantity: 1 }} locale="en" />, 'en');
    expect(screen.getByRole('button', { name: /decrease quantity/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /decrease quantity/i }));
    expect(updateItem).not.toHaveBeenCalled();
  });

  it('remove calls removeItem with the line id', async () => {
    renderWithIntl(<CartLineItem line={line} locale="en" />, 'en');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /remove item/i }));
    });
    await waitFor(() => expect(removeItem).toHaveBeenCalledWith('li-1'));
  });

  it('disables controls while a mutation is pending (no double-submit)', async () => {
    let resolve: () => void = () => {};
    updateItem.mockImplementation(() => new Promise<void>((r) => (resolve = r)));
    renderWithIntl(<CartLineItem line={line} locale="en" />, 'en');
    const inc = screen.getByRole('button', { name: /increase quantity/i });
    await act(async () => {
      fireEvent.click(inc);
    });
    expect(inc).toBeDisabled();
    expect(screen.getByRole('button', { name: /remove item/i })).toBeDisabled();
    // A second click while pending must not fire another update.
    fireEvent.click(inc);
    expect(updateItem).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve();
    });
  });

  it('renders JPY (zero-exponent) without assuming /100', () => {
    renderWithIntl(
      <CartLineItem
        line={{ ...line, unitPriceAmount: 500, currency: 'JPY', quantity: 1 }}
        locale="en"
      />,
      'en',
    );
    // ¥500 — not ¥5.00; the currency exponent (0 for JPY) is respected by formatPrice.
    expect(screen.getByText(/¥500 × 1/)).toBeInTheDocument();
  });

  it('localizes the remove label in French', () => {
    renderWithIntl(<CartLineItem line={line} locale="fr" />, 'fr');
    expect(screen.getByRole('button', { name: /retirer l'article/i })).toBeInTheDocument();
  });
});
