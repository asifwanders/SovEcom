/**
 * admin Content Pages list specs.
 *
 * Mocks `apiFetch` and renders the list inside a fresh QueryClient + router.
 * Asserts: rows render from the mocked endpoint, status/locale filters trigger a
 * refetch with the right query string, and delete → confirm → DELETE + invalidate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const apiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  ApiError: class ApiError extends Error {
    constructor(
      msg: string,
      public status: number,
      public body: unknown,
    ) {
      super(msg);
    }
  },
}));

// Spy on the singleton query client used by the route for invalidation.
import { queryClient as singletonClient } from '@/lib/query-client';
import { LocaleProvider } from '@/lib/i18n-context';
import { useAuthStore } from '@/lib/auth';
import PagesPage from '../pages';

function setRole(role: string | null) {
  useAuthStore
    .getState()
    .setUser(role ? { id: 'u1', email: 'u@x.io', name: 'U', role, totpEnabled: false } : null);
}

const ROWS = [
  {
    id: 'p1',
    slug: 'terms',
    title: 'Terms of Service',
    locale: 'en',
    status: 'published',
    updatedAt: '2026-06-16T00:00:00.000Z',
  },
  {
    id: 'p2',
    slug: 'confidentialite',
    title: 'Politique de confidentialité',
    locale: 'fr',
    status: 'draft',
    updatedAt: '2026-06-16T00:00:00.000Z',
  },
];

function renderList() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <LocaleProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/pages']}>
          <PagesPage />
        </MemoryRouter>
      </QueryClientProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
  localStorage.clear();
  // Default to owner so delete/CRUD affordances are present; gating specs override.
  setRole('owner');
});

describe('PagesPage (list)', () => {
  it('renders rows from the mocked /admin/v1/pages endpoint', async () => {
    apiFetch.mockResolvedValue(ROWS);
    renderList();

    expect(await screen.findByText('Terms of Service')).toBeInTheDocument();
    expect(screen.getByText('Politique de confidentialité')).toBeInTheDocument();
    expect(screen.getByText('/terms')).toBeInTheDocument();
    // First call hits the unfiltered list endpoint.
    expect(apiFetch).toHaveBeenCalledWith('/admin/v1/pages');
  });

  it('refetches with a status filter when the status select changes', async () => {
    apiFetch.mockResolvedValue(ROWS);
    renderList();
    await screen.findByText('Terms of Service');

    const statusSelect = screen.getByLabelText('Status');
    await userEvent.selectOptions(statusSelect, 'published');

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/admin/v1/pages?status=published');
    });
  });

  it('refetches with a locale filter when the locale select changes', async () => {
    apiFetch.mockResolvedValue(ROWS);
    renderList();
    await screen.findByText('Terms of Service');

    const localeSelect = screen.getByLabelText('Locale');
    await userEvent.selectOptions(localeSelect, 'fr');

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/admin/v1/pages?locale=fr');
    });
  });

  it('deletes via confirm → DELETE → invalidate', async () => {
    apiFetch.mockResolvedValue(ROWS);
    const invalidateSpy = vi.spyOn(singletonClient, 'invalidateQueries').mockResolvedValue();
    renderList();
    await screen.findByText('Terms of Service');

    // Open the delete dialog for the first row.
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
    await userEvent.click(deleteButtons[0]!);

    // Confirm inside the dialog (scope to role=dialog to avoid the row buttons).
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete page')).toBeInTheDocument();
    apiFetch.mockResolvedValueOnce(undefined); // the DELETE call
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/admin/v1/pages/p1', { method: 'DELETE' });
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['pages'] });
    });
    invalidateSpy.mockRestore();
  });

  it('hides the delete button for a staff role (no pages:delete)', async () => {
    setRole('staff');
    apiFetch.mockResolvedValue(ROWS);
    renderList();
    await screen.findByText('Terms of Service');

    // Edit affordance still present; delete must be gated out.
    expect(screen.getAllByRole('button', { name: 'Edit' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('shows the delete button for owner/admin (has pages:delete)', async () => {
    setRole('admin');
    apiFetch.mockResolvedValue(ROWS);
    renderList();
    await screen.findByText('Terms of Service');

    expect(screen.getAllByRole('button', { name: 'Delete' }).length).toBeGreaterThan(0);
  });
});
