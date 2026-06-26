import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

// Mock the i18n navigation primitives so the switcher's router call is observable without a real
// Next router. `usePathname` returns the locale-stripped current path; `replace` records the target.
const replace = vi.fn();
const usePathname = vi.fn(() => '/products');
vi.mock('@/i18n/navigation', () => ({
  usePathname: () => usePathname(),
  useRouter: () => ({ replace }),
}));

// `useParams`/`useSearchParams` come from next/navigation; stub to empty for the unit test.
vi.mock('next/navigation', () => ({
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(''),
}));

import { LanguageSwitcher } from './LanguageSwitcher';

beforeEach(() => {
  replace.mockReset();
  usePathname.mockReturnValue('/products');
});

describe('LanguageSwitcher', () => {
  it('renders both locale options and marks the active locale selected', () => {
    renderWithIntl(<LanguageSwitcher />, 'en');
    const select = screen.getByRole('combobox', { name: 'Language' }) as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toEqual(['en', 'fr']);
    expect(select.value).toBe('en');
    // Both human-readable labels are present.
    expect(screen.getByRole('option', { name: 'English' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Français' })).toBeInTheDocument();
  });

  it('switches to the chosen locale on the SAME path (preserves the current route)', () => {
    renderWithIntl(<LanguageSwitcher />, 'en');
    const select = screen.getByRole('combobox', { name: 'Language' });
    fireEvent.change(select, { target: { value: 'fr' } });
    expect(replace).toHaveBeenCalledTimes(1);
    const [pathArg, optionsArg] = replace.mock.calls[0]!;
    // Targets the current (locale-stripped) path under the new locale.
    expect(pathArg).toMatchObject({ pathname: '/products' });
    expect(optionsArg).toEqual({ locale: 'fr' });
  });

  it('preserves search params when switching locale', () => {
    usePathname.mockReturnValue('/search');
    // Re-stub useSearchParams for this case.
    renderWithIntl(<LanguageSwitcher />, 'en');
    const select = screen.getByRole('combobox', { name: 'Language' });
    fireEvent.change(select, { target: { value: 'fr' } });
    const [pathArg] = replace.mock.calls[0]!;
    expect((pathArg as { pathname: string }).pathname).toContain('/search');
  });

  it('does not navigate when re-selecting the already-active locale', () => {
    renderWithIntl(<LanguageSwitcher />, 'en');
    const select = screen.getByRole('combobox', { name: 'Language' });
    fireEvent.change(select, { target: { value: 'en' } });
    expect(replace).not.toHaveBeenCalled();
  });

  it('the active locale label is French when rendered under the fr provider', () => {
    renderWithIntl(<LanguageSwitcher />, 'fr');
    const select = screen.getByRole('combobox', { name: 'Langue' }) as HTMLSelectElement;
    expect(select.value).toBe('fr');
  });
});
