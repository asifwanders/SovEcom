/**
 * admin reactive-locale specs.
 *
 * The key reactivity guarantee: switching the locale re-renders subscribers so
 * their `t()` output flips EN↔FR WITHOUT a manual reload. Also: the choice
 * persists to localStorage and is restored on remount; the default is `en`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocaleProvider, useLocale, useT } from '../i18n-context';
import { LOCALE_STORAGE_KEY, getLocale } from '../i18n';

// A tiny consumer that renders a translated string + a switch control.
function Consumer() {
  const { setLocale } = useLocale();
  const { t } = useT();
  return (
    <div>
      <span data-testid="label">{t('layout', 'dashboard')}</span>
      <button onClick={() => setLocale('fr')}>to-fr</button>
      <button onClick={() => setLocale('en')}>to-en</button>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('reactive locale', () => {
  it('defaults to English', () => {
    render(
      <LocaleProvider>
        <Consumer />
      </LocaleProvider>,
    );
    expect(screen.getByTestId('label')).toHaveTextContent('Dashboard');
  });

  it('re-renders a consumer so t() flips EN→FR on switch (no reload)', async () => {
    render(
      <LocaleProvider>
        <Consumer />
      </LocaleProvider>,
    );
    expect(screen.getByTestId('label')).toHaveTextContent('Dashboard');

    await userEvent.click(screen.getByText('to-fr'));

    // The SAME mounted component now shows the French string — pure re-render.
    expect(screen.getByTestId('label')).toHaveTextContent('Tableau de bord');
  });

  it('keeps the module-global getLocale() in sync for static t() callers', async () => {
    render(
      <LocaleProvider>
        <Consumer />
      </LocaleProvider>,
    );
    await userEvent.click(screen.getByText('to-fr'));
    expect(getLocale()).toBe('fr');
  });

  it('persists the choice to localStorage', async () => {
    render(
      <LocaleProvider>
        <Consumer />
      </LocaleProvider>,
    );
    await userEvent.click(screen.getByText('to-fr'));
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('fr');
  });

  it('restores the persisted locale on remount', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'fr');
    render(
      <LocaleProvider>
        <Consumer />
      </LocaleProvider>,
    );
    expect(screen.getByTestId('label')).toHaveTextContent('Tableau de bord');
  });
});
