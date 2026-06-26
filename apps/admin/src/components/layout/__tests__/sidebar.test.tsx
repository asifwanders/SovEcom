/**
 * Sidebar locale reactivity.
 *
 * The sidebar nav labels must flip EN→FR on a locale switch WITHOUT an unrelated
 * re-render. Mounts the sidebar next to a switch control (both under the same
 * LocaleProvider) and asserts a nav label re-renders on switch.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { LocaleProvider, useLocale } from '@/lib/i18n-context';
import { useAuthStore } from '@/lib/auth';
import { Sidebar } from '../sidebar';

function Switcher() {
  const { setLocale } = useLocale();
  return <button onClick={() => setLocale('fr')}>to-fr</button>;
}

function renderSidebar() {
  return render(
    <LocaleProvider>
      <MemoryRouter initialEntries={['/dashboard']}>
        <Switcher />
        <Sidebar collapsed={false} onToggle={() => {}} mobileOpen onMobileClose={() => {}} />
      </MemoryRouter>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  useAuthStore.getState().setUser({
    id: 'u1',
    email: 'u@x.io',
    name: 'U',
    role: 'owner',
    totpEnabled: false,
  });
});

describe('Sidebar locale reactivity', () => {
  it('flips nav labels EN→FR on a locale switch (no reload)', async () => {
    renderSidebar();

    // EN labels.
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Products')).toBeInTheDocument();
    expect(screen.getByText('Pages')).toBeInTheDocument();

    await userEvent.click(screen.getByText('to-fr'));

    // The same mounted sidebar now renders the French labels.
    expect(screen.getByText('Tableau de bord')).toBeInTheDocument();
    expect(screen.getByText('Produits')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });
});
