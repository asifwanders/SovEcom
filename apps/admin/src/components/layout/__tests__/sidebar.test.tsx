/**
 * Sidebar — grouped collapsible navigation tests.
 *
 * Covers:
 *   1. Locale reactivity (EN→FR label flip)
 *   2. Groups render and are collapsible
 *   3. Permission-based hiding of items and empty groups
 *   4. Active-route auto-expand on mount
 *   5. Group aria-expanded / aria-current semantics
 *   6. Expand-all / Collapse-all affordance
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { LocaleProvider, useLocale } from '@/lib/i18n-context';
import { useAuthStore } from '@/lib/auth';
import { Sidebar } from '../sidebar';

// ── helpers ────────────────────────────────────────────────────────────────

function Switcher() {
  const { setLocale } = useLocale();
  return <button onClick={() => setLocale('fr')}>to-fr</button>;
}

function renderSidebar(opts?: {
  route?: string;
  collapsed?: boolean;
  role?: 'owner' | 'admin' | 'staff';
}) {
  const { route = '/dashboard', collapsed = false, role = 'owner' } = opts ?? {};
  useAuthStore.getState().setUser({
    id: 'u1',
    email: 'u@x.io',
    name: 'U',
    role,
    totpEnabled: false,
  });
  return render(
    <LocaleProvider>
      <MemoryRouter initialEntries={[route]}>
        <Switcher />
        <Sidebar collapsed={collapsed} onToggle={() => {}} mobileOpen onMobileClose={() => {}} />
      </MemoryRouter>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

// ── 1. Locale reactivity ────────────────────────────────────────────────────

describe('Sidebar locale reactivity', () => {
  it('flips nav labels EN→FR on a locale switch (no reload)', async () => {
    renderSidebar();

    // EN group labels visible
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Catalog')).toBeInTheDocument();

    // EN item labels inside open groups
    expect(screen.getByText('Dashboard')).toBeInTheDocument();

    await userEvent.click(screen.getByText('to-fr'));

    // FR group labels
    expect(screen.getByText("Vue d'ensemble")).toBeInTheDocument();
    expect(screen.getByText('Catalogue')).toBeInTheDocument();

    // FR item label
    expect(screen.getByText('Tableau de bord')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });
});

// ── 2. Groups render + collapse toggle ─────────────────────────────────────

describe('Sidebar group collapsing', () => {
  it('renders all expected group headers', () => {
    renderSidebar();
    const expectedGroups = [
      'Overview',
      'Catalog',
      'Orders',
      'Customers',
      'Marketing',
      'Storefront',
      'Settings',
    ];
    for (const label of expectedGroups) {
      // Some labels (e.g. 'Customers', 'Settings') appear both as a group header
      // and as a nav item — assert at least one instance exists.
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it('group header button has aria-expanded', () => {
    renderSidebar({ route: '/products' }); // catalog group will be open
    const catalogBtn = screen.getByRole('button', { name: /Catalog/i });
    expect(catalogBtn).toHaveAttribute('aria-expanded');
  });

  it('clicking a closed group header opens it (aria-expanded becomes true)', async () => {
    renderSidebar({ route: '/dashboard' });

    // Find the Marketing group header — it starts closed (active route is /dashboard → Overview)
    // We need to first collapse Overview, then check Marketing
    const marketingBtn = screen.getByRole('button', { name: /Marketing/i });
    const initialExpanded = marketingBtn.getAttribute('aria-expanded');

    await userEvent.click(marketingBtn);

    const newExpanded = marketingBtn.getAttribute('aria-expanded');
    expect(newExpanded).not.toBe(initialExpanded);
  });

  it('clicking an open group header collapses it', async () => {
    renderSidebar({ route: '/dashboard' });

    // Overview is auto-opened because /dashboard is active
    const overviewBtn = screen.getByRole('button', { name: /Overview/i });
    expect(overviewBtn).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(overviewBtn);

    expect(overviewBtn).toHaveAttribute('aria-expanded', 'false');
  });
});

// ── 3. Permission-based hiding ──────────────────────────────────────────────

describe('Sidebar permission gating', () => {
  it('hides Themes, Slots, Modules groups for staff role (no themes:read)', () => {
    renderSidebar({ role: 'staff' });

    // Staff cannot see themes:read items, so Storefront group should not appear
    expect(screen.queryByText('Storefront')).not.toBeInTheDocument();
    expect(screen.queryByText('Themes')).not.toBeInTheDocument();
    expect(screen.queryByText('Slots')).not.toBeInTheDocument();
    expect(screen.queryByText('Modules')).not.toBeInTheDocument();
  });

  it('shows all groups for owner role', () => {
    renderSidebar({ role: 'owner' });
    expect(screen.getByText('Storefront')).toBeInTheDocument();
    // 'Settings' appears as both a group header and a nav item — assert at least one exists
    expect(screen.getAllByText('Settings').length).toBeGreaterThan(0);
  });

  it('hides Audit log item for staff (audit_log:export required)', async () => {
    renderSidebar({ role: 'staff', route: '/settings' });

    // Open the Settings group
    const settingsBtn = screen.getByRole('button', { name: /Settings/i });
    if (settingsBtn.getAttribute('aria-expanded') === 'false') {
      await userEvent.click(settingsBtn);
    }

    expect(screen.queryByText('Audit log')).not.toBeInTheDocument();
  });
});

// ── 4. Active-route auto-expand ─────────────────────────────────────────────

describe('Sidebar active-route auto-expand', () => {
  it('auto-expands the group that contains the active route', () => {
    renderSidebar({ route: '/orders' });

    const ordersBtn = screen.getByRole('button', { name: /^Orders$/i });
    expect(ordersBtn).toHaveAttribute('aria-expanded', 'true');
  });

  it('marks the active nav item with aria-current="page"', async () => {
    renderSidebar({ route: '/orders' });

    // Open the Orders group (it should already be open)
    const ordersBtn = screen.getByRole('button', { name: /^Orders$/i });
    if (ordersBtn.getAttribute('aria-expanded') === 'false') {
      await userEvent.click(ordersBtn);
    }

    const ordersLink = screen
      .getAllByRole('link')
      .find((el) => el.getAttribute('href') === '/orders');
    expect(ordersLink).toBeDefined();
    expect(ordersLink).toHaveAttribute('aria-current', 'page');
  });

  it('does not mark non-active items with aria-current', async () => {
    renderSidebar({ route: '/orders' });

    const returnsLink = screen
      .getAllByRole('link')
      .find((el) => el.getAttribute('href') === '/returns');
    // Returns is in the same group but not active
    expect(returnsLink?.getAttribute('aria-current')).toBeFalsy();
  });
});

// ── 5. Expand-all / Collapse-all ────────────────────────────────────────────

describe('Sidebar expand-all / collapse-all', () => {
  it('renders the expand/collapse-all button when sidebar is not collapsed', () => {
    renderSidebar();
    // The button text changes between Expand all / Collapse all
    const btn = screen.getByRole('button', { name: /expand all|collapse all/i });
    expect(btn).toBeInTheDocument();
  });

  it('collapseAll closes all group panels', async () => {
    renderSidebar();

    // Click "Collapse all"
    const btn = screen.getByRole('button', { name: /collapse all/i });
    await userEvent.click(btn);

    // All group headers should now be collapsed
    const groupBtns = screen.getAllByRole('button', {
      name: /Overview|Catalog|Orders|Customers|Marketing|Storefront|Settings/i,
    });
    for (const groupBtn of groupBtns) {
      expect(groupBtn).toHaveAttribute('aria-expanded', 'false');
    }
  });

  it('expandAll opens all group panels', async () => {
    renderSidebar();

    // First collapse all
    const collapseBtn = screen.getByRole('button', { name: /collapse all/i });
    await userEvent.click(collapseBtn);

    // Then expand all
    const expandBtn = screen.getByRole('button', { name: /expand all/i });
    await userEvent.click(expandBtn);

    const groupBtns = screen.getAllByRole('button', {
      name: /Overview|Catalog|Orders|Customers|Marketing|Storefront|Settings/i,
    });
    for (const groupBtn of groupBtns) {
      expect(groupBtn).toHaveAttribute('aria-expanded', 'true');
    }
  });
});

// ── 6. Collapsed (icon-rail) mode ───────────────────────────────────────────

describe('Sidebar icon-rail (collapsed) mode', () => {
  it('does not render group headers in icon-rail mode', () => {
    renderSidebar({ collapsed: true });

    expect(screen.queryByRole('button', { name: /Overview/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });

  it('does not render the expand/collapse-all button in icon-rail mode', () => {
    renderSidebar({ collapsed: true });

    expect(
      screen.queryByRole('button', { name: /expand all|collapse all/i }),
    ).not.toBeInTheDocument();
  });
});
