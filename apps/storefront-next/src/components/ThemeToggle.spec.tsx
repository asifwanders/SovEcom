import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import { ThemeToggle } from './ThemeToggle';

function clearThemeCookie() {
  document.cookie = 'theme=; path=/; max-age=0';
}

beforeEach(() => {
  document.documentElement.classList.remove('dark');
  clearThemeCookie();
});

afterEach(() => {
  document.documentElement.classList.remove('dark');
  clearThemeCookie();
});

describe('ThemeToggle', () => {
  it('renders a button reflecting the current (light) state after mount', () => {
    renderWithIntl(<ThemeToggle />, 'en');
    const btn = screen.getByRole('button', { name: 'Switch to dark mode' });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  it('reads the initial state from the <html> class set by the no-FOUC script', () => {
    document.documentElement.classList.add('dark');
    renderWithIntl(<ThemeToggle />, 'en');
    const btn = screen.getByRole('button', { name: 'Switch to light mode' });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  it('toggles the .dark class on documentElement and flips aria-pressed', () => {
    renderWithIntl(<ThemeToggle />, 'en');
    const btn = screen.getByRole('button', { name: 'Switch to dark mode' });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    fireEvent.click(btn);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(screen.getByRole('button', { name: 'Switch to light mode' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('persists the chosen mode to the theme cookie', () => {
    renderWithIntl(<ThemeToggle />, 'en');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
    expect(document.cookie).toContain('theme=dark');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
    expect(document.cookie).toContain('theme=light');
  });

  it('has a ≥44px touch target (h-11 w-11)', () => {
    renderWithIntl(<ThemeToggle />, 'en');
    const btn = screen.getByRole('button', { name: /mode/i });
    expect(btn.className).toContain('h-11');
    expect(btn.className).toContain('w-11');
  });

  it('renders the localized French label', () => {
    renderWithIntl(<ThemeToggle />, 'fr');
    expect(screen.getByRole('button', { name: 'Passer en mode sombre' })).toBeInTheDocument();
  });
});
