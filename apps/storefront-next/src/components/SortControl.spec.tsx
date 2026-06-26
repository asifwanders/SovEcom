import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import { SortControl } from './SortControl';

describe('SortControl', () => {
  it('renders a GET form targeting the locale-prefixed action path', () => {
    const { container } = renderWithIntl(
      <SortControl locale="en" action="/en/category/apparel" sort="relevance" />,
    );
    const form = container.querySelector('form')!;
    expect(form).toHaveAttribute('method', 'get');
    expect(form).toHaveAttribute('action', '/en/category/apparel');
  });

  it('renders all four sort options with the current sort selected', () => {
    renderWithIntl(<SortControl locale="en" action="/en/category/apparel" sort="price_asc" />);
    const select = screen.getByRole('combobox', { name: 'Sort' }) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(['relevance', 'newest', 'price_asc', 'price_desc']);
    expect(select.value).toBe('price_asc');
  });

  it('preserves the current filter params as hidden inputs (so a sort submit keeps them)', () => {
    const { container } = renderWithIntl(
      <SortControl
        locale="en"
        action="/en/search"
        sort="newest"
        preserve={{ q: 'tee', category: 'apparel', minPrice: '1000', maxPrice: '5000' }}
      />,
    );
    const hidden = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="hidden"]'));
    const byName = Object.fromEntries(hidden.map((i) => [i.name, i.value]));
    expect(byName).toMatchObject({
      q: 'tee',
      category: 'apparel',
      minPrice: '1000',
      maxPrice: '5000',
    });
    // A sort change resets pagination → no `page` hidden input is emitted (defaults to page 1).
    expect(byName).not.toHaveProperty('page');
  });

  it('omits empty/undefined preserve params (no blank hidden inputs)', () => {
    const { container } = renderWithIntl(
      <SortControl
        locale="en"
        action="/en/search"
        sort="relevance"
        preserve={{ q: 'tee', category: undefined, minPrice: '' }}
      />,
    );
    const names = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="hidden"]'),
    ).map((i) => i.name);
    expect(names).toEqual(['q']);
  });

  it('localizes the labels in French', () => {
    renderWithIntl(
      <SortControl locale="fr" action="/fr/category/apparel" sort="relevance" />,
      'fr',
    );
    expect(screen.getByRole('combobox', { name: 'Trier' })).toBeInTheDocument();
    expect(screen.getByText('Appliquer')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Pertinence' })).toBeInTheDocument();
  });
});
